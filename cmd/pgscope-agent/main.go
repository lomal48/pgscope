// pgscope-agent runs next to PostgreSQL containers on a Docker host (or as a
// global service on every Swarm node), finds labelled database containers via
// the local Docker Engine API, collects pgmetrics reports from them and sends
// the reports and a heartbeat to pgscope.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var version = "dev" // set with -ldflags "-X main.version=..."

type config struct {
	url, apiKey, cluster, user, password, sslmode string
	selector, container, dockerHost, pgmetrics    string
	pgmetricsArgs                                 []string
	interval, discovery, timeout                  time.Duration
	concurrency, queryTimeout                     int
	autoconnect                                   bool
}

var rxAPIKey = regexp.MustCompile(`^[A-Za-z0-9]{22}$`)

func loadConfig() (*config, error) {
	var bad []string
	env := func(k, def string) string {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
		return def
	}
	num := func(k string, def int) int {
		v := env(k, strconv.Itoa(def))
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			bad = append(bad, fmt.Sprintf("%s=%q: expected a positive integer", k, v))
		}
		return n
	}
	dur := func(k string, def time.Duration) time.Duration {
		v := env(k, def.String())
		if _, err := strconv.Atoi(v); err == nil {
			v += "s" // plain numbers are seconds
		}
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Second {
			bad = append(bad, fmt.Sprintf("%s=%q: expected a duration such as 300s", k, v))
		}
		return d
	}
	secret := func(k, fileKey, def string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		b, err := os.ReadFile(env(fileKey, def))
		if err != nil {
			bad = append(bad, fmt.Sprintf("set %s or %s (%v)", k, fileKey, err))
		}
		return strings.TrimRight(string(b), "\r\n")
	}
	c := &config{
		url:           strings.TrimRight(env("PGSCOPE_URL", ""), "/"),
		apiKey:        strings.TrimSpace(secret("PGSCOPE_API_KEY", "PGSCOPE_API_KEY_FILE", "/run/secrets/pgscope_api_key")),
		cluster:       env("PGSCOPE_AGENT_CLUSTER", ""),
		user:          env("PGSCOPE_AGENT_PGUSER", "pgscope_monitor"),
		password:      secret("PGSCOPE_AGENT_PGPASSWORD", "PGSCOPE_AGENT_PGPASSWORD_FILE", "/run/secrets/pgscope_monitor_password"),
		sslmode:       env("PGSCOPE_AGENT_SSLMODE", "prefer"),
		selector:      env("PGSCOPE_AGENT_LABEL_SELECTOR", "pgscope.enable=true"),
		container:     env("PGSCOPE_AGENT_CONTAINER", ""),
		dockerHost:    env("DOCKER_HOST", "unix:///var/run/docker.sock"),
		pgmetrics:     env("PGMETRICS", "pgmetrics"),
		pgmetricsArgs: strings.Fields(os.Getenv("PGSCOPE_AGENT_PGMETRICS_ARGS")),
		interval:      dur("PGSCOPE_AGENT_INTERVAL", 300*time.Second),
		discovery:     dur("PGSCOPE_AGENT_DISCOVERY_INTERVAL", 30*time.Second),
		timeout:       dur("PGSCOPE_AGENT_TIMEOUT", 120*time.Second),
		concurrency:   num("PGSCOPE_AGENT_CONCURRENCY", 4),
		queryTimeout:  num("PGSCOPE_AGENT_QUERY_TIMEOUT", 30),
	}
	switch v := strings.ToLower(env("PGSCOPE_AGENT_AUTOCONNECT", "true")); v {
	case "true", "1", "yes":
		c.autoconnect = true
	case "false", "0", "no":
	default:
		bad = append(bad, fmt.Sprintf("PGSCOPE_AGENT_AUTOCONNECT=%q: expected true or false", v))
	}
	if !strings.HasPrefix(c.url, "http://") && !strings.HasPrefix(c.url, "https://") {
		bad = append(bad, "PGSCOPE_URL must be the pgscope base URL, e.g. https://pgscope.example.com")
	}
	if !rxAPIKey.MatchString(c.apiKey) {
		bad = append(bad, "the API key must be 22 letters and digits (see the pgscope profile page)")
	}
	if !connSafe(c.user) {
		bad = append(bad, fmt.Sprintf("PGSCOPE_AGENT_PGUSER=%q: not a usable role name", c.user))
	}
	if _, err := exec.LookPath(c.pgmetrics); err != nil {
		bad = append(bad, fmt.Sprintf("pgmetrics binary: %v (set PGMETRICS)", err))
	}
	if len(bad) > 0 {
		return nil, fmt.Errorf("configuration: %s", strings.Join(bad, "; "))
	}
	return c, nil
}

//------------------------------------------------------------------------------
// state

type agentInfo struct {
	ID            string `json:"id"`
	Cluster       string `json:"cluster"`
	Host          string `json:"host"`
	Mode          string `json:"mode"`
	Version       string `json:"version"`
	DockerVersion string `json:"docker_version"`
	Autoconnect   bool   `json:"autoconnect"`
	Interval      int    `json:"interval"`
}

// target is one monitored container; the exported fields are its heartbeat entry.
type target struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Container   string `json:"container"`
	ContainerID string `json:"container_id"`
	Image       string `json:"image"`
	Network     string `json:"network"`
	Address     string `json:"address"`
	Status      string `json:"status"`
	Error       string `json:"error"`
	LastOK      int64  `json:"last_ok"`
	LastAttempt int64  `json:"last_attempt"`

	spec       spec
	ip         string
	holdStatus string // set by discovery (bad labels, no route): replaces Status, no collection
	hold       string
	next       time.Time
	running    bool
}

type agent struct {
	cfg    *config
	d      *docker
	info   agentInfo
	prefix string // "<cluster>" for derived server names when the cluster is explicit
	selfID string // own container id, "" outside a container

	mu      sync.Mutex
	targets map[string]*target // by kind/name

	// used by the discovery loop only
	joined map[string]string  // network id -> name of networks the agent joined itself
	nets   map[string]network // inspected networks by id
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	a, err := newAgent(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}

	sem := make(chan struct{}, cfg.concurrency)
	var wg sync.WaitGroup
	a.discover(ctx)
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			a.heartbeat(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	disc, tick := time.NewTicker(cfg.discovery), time.NewTicker(time.Second)
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-disc.C:
			a.discover(ctx)
		case <-tick.C:
			a.schedule(ctx, sem, &wg)
		}
	}
	log.Print("shutting down")
	wg.Wait()
	bg, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for id, name := range a.joined {
		if err := a.d.connect(bg, id, a.selfID, false); err != nil {
			log.Printf("leave network %s: %v", name, err)
		} else {
			delete(a.joined, id)
		}
	}
	a.saveJoined()
}

// joinedFile lists the networks the agent joined itself. It lives in the container's
// writable layer: it survives a crash and restart (when the SIGTERM cleanup did not
// run but the endpoints are still there) and goes away with the container and its endpoints.
const joinedFile = "/var/tmp/pgscope-agent-joined.json"

func (a *agent) saveJoined() {
	b, _ := json.Marshal(a.joined)
	if err := os.WriteFile(joinedFile, b, 0o600); err != nil {
		log.Printf("cannot remember the joined networks (%v); after a crash leave them with docker network disconnect", err)
	}
}

func newAgent(ctx context.Context, cfg *config) (*agent, error) {
	d, err := newDocker(cfg.dockerHost)
	if err != nil {
		return nil, err
	}
	if err := d.ping(ctx); err != nil {
		return nil, fmt.Errorf("cannot reach the Docker Engine API at %s: %v (mount /var/run/docker.sock or set DOCKER_HOST)", cfg.dockerHost, err)
	}
	info, err := d.info(ctx)
	if err != nil {
		return nil, err
	}
	a := &agent{cfg: cfg, d: d, targets: map[string]*target{}, joined: map[string]string{}, nets: map[string]network{}}
	mode, idHost, cluster := "standalone", info.Name, cfg.cluster
	if info.Swarm.LocalNodeState == "active" {
		if cluster == "" {
			return nil, fmt.Errorf("PGSCOPE_AGENT_CLUSTER is required on Swarm nodes: worker nodes cannot read the cluster id, so give all agents of one cluster the same name")
		}
		mode, idHost = "swarm", info.Swarm.NodeID
	}
	if cluster != "" {
		a.prefix = sanitize(cluster, 64)
	} else {
		cluster = info.Name
	}

	mountinfo, _ := os.ReadFile("/proc/self/mountinfo")
	hostname := os.Getenv("HOSTNAME")
	var self *container
	for _, id := range selfCandidates(cfg.container, string(mountinfo), hostname) {
		c, err := d.inspect(ctx, id)
		// outside a container $HOSTNAME is the host name: only trust it if it is the container's hostname
		if err == nil && (id != hostname || id == cfg.container || c.Config.Hostname == hostname) {
			self = c
			break
		}
	}
	autoconnect := cfg.autoconnect
	switch {
	case self == nil:
		log.Print("not running in a container (or own container not found): reaching targets by container IP")
		autoconnect = false
	case self.HostConfig.NetworkMode == "host":
		log.Printf("own container %s uses the host network: reaching targets by container IP", strings.TrimPrefix(self.Name, "/"))
		a.selfID, autoconnect = self.ID, false
	default:
		a.selfID = self.ID
		if _, task := self.Config.Labels["com.docker.swarm.task.id"]; task {
			autoconnect = false // running Swarm tasks cannot join networks
		}
	}
	a.info = agentInfo{
		ID:      sanitize(cluster, 64) + "/" + sanitize(idHost, 63),
		Cluster: cluster, Host: info.Name, Mode: mode, Version: version,
		DockerVersion: info.ServerVersion, Autoconnect: autoconnect, Interval: int(cfg.interval / time.Second),
	}
	log.Printf("pgscope-agent %s: agent %s (%s), Docker %s (API %s), autoconnect %v, reporting to %s",
		version, a.info.ID, mode, info.ServerVersion, strings.TrimPrefix(d.ver, "/v"), autoconnect, cfg.url)
	if autoconnect {
		if b, err := os.ReadFile(joinedFile); err == nil && json.Unmarshal(b, &a.joined) == nil && len(a.joined) > 0 {
			log.Printf("restarted without cleanup: will leave the %d network(s) joined before once no target needs them", len(a.joined))
		}
	}
	return a, nil
}

//------------------------------------------------------------------------------
// discovery

func (a *agent) discover(ctx context.Context) {
	ids, err := a.d.running(ctx, a.cfg.selector)
	if err != nil {
		log.Printf("discovery: %v", err)
		return
	}
	var self *container
	if a.selfID != "" {
		if self, err = a.d.inspect(ctx, a.selfID); err != nil {
			log.Printf("discovery: own container: %v", err)
			return
		}
	}
	found := map[string]*target{}
	need := map[string]bool{} // networks some target is reached through
	for _, id := range ids {
		if id == a.selfID {
			continue
		}
		c, err := a.d.inspect(ctx, id)
		if err != nil {
			log.Printf("discovery: %v", err)
			continue
		}
		s, cname := parseSpec(c, a.prefix), strings.TrimPrefix(c.Name, "/")
		key := s.Kind + "/" + s.Name
		if other := found[key]; other != nil {
			log.Printf("discovery: containers %s and %s both map to %s %s; ignoring %s (set the label pgscope.name)",
				other.Container, cname, s.Kind, s.Name, cname)
			continue
		}
		t := &target{Name: s.Name, Kind: s.Kind, Container: cname,
			ContainerID: c.ID[:min(12, len(c.ID))], Image: c.Config.Image, spec: s}
		found[key] = t
		if s.Err != "" {
			t.holdStatus, t.hold = "error", s.Err
			continue
		}
		for name, ep := range c.NetworkSettings.Networks {
			if _, ok := a.nets[ep.NetworkID]; !ok && !skipNets[name] {
				if n, err := a.d.network(ctx, ep.NetworkID); err == nil {
					a.nets[ep.NetworkID] = n
				}
			}
		}
		r := chooseRoute(c, self, a.nets, s.Network, a.info.Autoconnect)
		if r.Join {
			if err := a.d.connect(ctx, r.NetID, a.selfID, true); err != nil {
				r.Reason = fmt.Sprintf("could not join network %s: %v", r.Network, err)
			} else {
				log.Printf("joined network %s to reach %s", r.Network, t.Name)
				a.joined[r.NetID] = r.Network
				a.saveJoined()
				self.NetworkSettings.Networks[r.Network] = endpoint{NetworkID: r.NetID}
			}
		}
		if r.Reason != "" {
			t.holdStatus, t.hold = "unreachable", r.Reason
			continue
		}
		need[r.NetID] = true
		t.Network, t.ip, t.Address = r.Network, r.IP, net.JoinHostPort(r.IP, strconv.Itoa(s.Port))
	}

	a.mu.Lock()
	for key, t := range found {
		old := a.targets[key]
		a.targets[key] = t
		if old == nil {
			t.Status = "pending"
			t.next = time.Now().Add(rand.N(a.cfg.interval)) // spread first runs over the interval
			log.Printf("target %s %s added: container %s, %s", t.Kind, t.Name, t.Container, t.where())
			continue
		}
		t.Status, t.Error, t.LastOK, t.LastAttempt, t.next, t.running = old.Status, old.Error, old.LastOK, old.LastAttempt, old.next, old.running
		if old.where() != t.where() || old.ContainerID != t.ContainerID {
			log.Printf("target %s %s changed: container %s, %s", t.Kind, t.Name, t.Container, t.where())
		}
	}
	for key, t := range a.targets {
		if found[key] == nil {
			delete(a.targets, key)
			log.Printf("target %s %s removed (container %s is no longer running)", t.Kind, t.Name, t.Container)
		}
	}
	a.mu.Unlock()

	for id, name := range a.joined {
		if !need[id] {
			if err := a.d.connect(ctx, id, a.selfID, false); err != nil {
				log.Printf("leave network %s: %v", name, err)
			} else {
				log.Printf("left network %s: no target needs it any more", name)
			}
			delete(a.joined, id)
			a.saveJoined()
		}
	}
}

func (t *target) where() string {
	if t.hold != "" {
		return t.holdStatus + ": " + t.hold
	}
	return "network " + t.Network + ", address " + t.Address
}

//------------------------------------------------------------------------------
// scheduling and heartbeat

func (a *agent) schedule(ctx context.Context, sem chan struct{}, wg *sync.WaitGroup) {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, t := range a.targets {
		if t.running || t.hold != "" || now.Before(t.next) {
			continue
		}
		t.running, t.next = true, now.Add(a.cfg.interval)
		job := *t
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			start := time.Now()
			status, msg := a.collect(ctx, &job)
			<-sem
			if ctx.Err() != nil {
				return
			}
			a.mu.Lock()
			defer a.mu.Unlock()
			t := a.targets[key]
			if t == nil {
				return
			}
			if status != "ok" {
				log.Printf("collect %s %s (%s): %s: %s", t.Kind, t.Name, t.Address, status, msg)
			} else if t.Status != "ok" {
				log.Printf("collect %s %s (%s): ok in %s", t.Kind, t.Name, t.Address, time.Since(start).Round(time.Second))
			}
			if status == "ok" {
				t.LastOK = start.Unix()
			}
			t.running, t.Status, t.Error, t.LastAttempt = false, status, msg, start.Unix()
		}()
	}
}

func (a *agent) heartbeat(ctx context.Context) {
	a.mu.Lock()
	ts := make([]target, 0, len(a.targets))
	for _, t := range a.targets {
		c := *t
		if c.hold != "" {
			c.Status, c.Error = c.holdStatus, c.hold
		}
		ts = append(ts, c)
	}
	a.mu.Unlock()
	sort.Slice(ts, func(i, j int) bool { return ts[i].Kind+"/"+ts[i].Name < ts[j].Kind+"/"+ts[j].Name })
	body, err := gz(map[string]any{"apikey": a.cfg.apiKey, "agent": a.info, "targets": ts})
	if err != nil {
		log.Printf("heartbeat: %v", err)
		return
	}
	code, msg, err := a.post(ctx, "/api/v1/agent", body)
	switch {
	case err != nil:
		if ctx.Err() == nil {
			log.Printf("heartbeat: %v", err)
		}
	case code == 403:
		log.Printf("ERROR: pgscope rejected the API key (HTTP 403: %s); check PGSCOPE_API_KEY", msg)
	case code != 200:
		log.Printf("heartbeat: pgscope answered HTTP %d: %s", code, msg)
	}
}
