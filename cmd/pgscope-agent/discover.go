package main

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Pure discovery logic: container labels -> target spec and server name,
// network choice, error classification. Everything here is unit-tested.

// spec is what the labels of a database container ask for. Empty User and
// SSLMode mean "agent default".
type spec struct {
	Name         string // server name; for pgbouncer the pgbouncer name
	Kind         string // "postgres" | "pgbouncer"
	Server       string // pgbouncer only: the PostgreSQL server it belongs to
	Port         int
	DBs          []string
	Network      string
	SSLMode      string
	User         string
	PasswordFile string
	Err          string // label problem, shown as status "error"
}

var rxName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

func parseSpec(c *container, prefix string) spec {
	l := c.Config.Labels
	s := spec{
		Name: serverName(c, prefix), Kind: "postgres", Port: 5432,
		Network: l["pgscope.network"], SSLMode: l["pgscope.sslmode"],
		User: l["pgscope.user"], PasswordFile: l["pgscope.password-file"],
	}
	if v := l["pgscope.port"]; v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			s.Err = "invalid pgscope.port label: " + v
		}
		s.Port = p
	}
	for _, db := range strings.Split(l["pgscope.dbs"], ",") {
		if db = strings.TrimSpace(db); db != "" {
			if !connSafe(db) {
				s.Err = "invalid database name in the label pgscope.dbs: " + strconv.Quote(db)
			}
			s.DBs = append(s.DBs, db)
		}
	}
	if s.User != "" && !connSafe(s.User) {
		s.Err = "invalid role name in the label pgscope.user: " + strconv.Quote(s.User)
	}
	// a label must not make the agent read (and send as a password) arbitrary files of its container
	if f := s.PasswordFile; f != "" && (path.Clean(f) != f || !strings.HasPrefix(f, "/run/secrets/")) {
		s.Err = "the label pgscope.password-file must name a secret of the agent under /run/secrets/"
	}
	switch k := l["pgscope.kind"]; k {
	case "", "postgres":
	case "pgbouncer":
		s.Kind, s.Server = k, l["pgscope.server"]
		if !rxName.MatchString(s.Server) {
			s.Err = "a pgbouncer container needs the label pgscope.server with the name of its PostgreSQL server"
		}
	default:
		s.Err = "unknown pgscope.kind label: " + k
	}
	return s
}

// serverName derives a stable server name: explicit label, else Swarm service
// (+slot or node), else Compose project-service(+number), else container name.
// Derived names get "<prefix>." when the cluster name was set explicitly.
func serverName(c *container, prefix string) string {
	l := c.Config.Labels
	if n := l["pgscope.name"]; n != "" {
		return sanitize(n, 64)
	}
	name := strings.TrimPrefix(c.Name, "/")
	if svc := l["com.docker.swarm.service.name"]; svc != "" {
		name = svc
		// task name is "<service>.<slot>.<task id>", or "<service>.<node id>.<task id>" for global services
		if rest, ok := strings.CutPrefix(l["com.docker.swarm.task.name"], svc+"."); ok {
			slot, _, _ := strings.Cut(rest, ".")
			if node := l["com.docker.swarm.node.id"]; node != "" && slot == node {
				name += "-" + node[:min(6, len(node))]
			} else if slot != "" && slot != "1" {
				name += "-" + slot
			}
		}
	} else if p, s := l["com.docker.compose.project"], l["com.docker.compose.service"]; p != "" && s != "" {
		name = p + "-" + s
		if n := l["com.docker.compose.container-number"]; n != "" && n != "1" {
			name += "-" + n
		}
	}
	if prefix != "" {
		name = prefix + "." + name
	}
	return sanitize(name, 64)
}

// connSafe reports whether a role or database name can be handed to pgmetrics.
// pgmetrics writes names into its connection string unquoted unless they contain
// a space, so a tab or newline would start a new keyword (e.g. host=elsewhere,
// which then gets PGPASSWORD), and it takes a lone database argument that parses
// as a connection string ("k=v ...", "postgres://...") for one.
func connSafe(s string) bool {
	return s != "" && !strings.ContainsAny(s, "=\t\n\v\f\r") && !strings.Contains(s, "://")
}

// sanitize maps s onto [A-Za-z0-9_.-] and cuts it to max bytes.
func sanitize(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < utf8.RuneSelf && (r == '_' || r == '.' || r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return r
		}
		return '-'
	}, s)
	return s[:min(len(s), max)]
}

//------------------------------------------------------------------------------
// network choice

// route says how the agent reaches a target: the target's IP on Network,
// joining NetID first when Join is set. A non-empty Reason means unreachable.
type route struct {
	Network, NetID, IP string
	Join               bool
	Reason             string
}

var skipNets = map[string]bool{"ingress": true, "docker_gwbridge": true, "host": true, "none": true}

// chooseRoute picks the network to reach target t from the agent's own
// container self (nil when the agent is not in a container). nets holds the
// inspected networks by id; pref is the pgscope.network label.
func chooseRoute(t, self *container, nets map[string]network, pref string, autoconnect bool) route {
	var names []string
	for n, ep := range t.NetworkSettings.Networks {
		if !skipNets[n] && ep.IPAddress != "" {
			names = append(names, n)
		}
	}
	// user-defined networks first, the default bridge last
	sort.Slice(names, func(i, j int) bool {
		if (names[i] == "bridge") != (names[j] == "bridge") {
			return names[j] == "bridge"
		}
		return names[i] < names[j]
	})
	if pref != "" {
		l, found := t.Config.Labels, ""
		// accept the short Compose/stack network name too
		for _, n := range []string{pref, l["com.docker.compose.project"] + "_" + pref, l["com.docker.stack.namespace"] + "_" + pref} {
			if _, ok := t.NetworkSettings.Networks[n]; ok && !skipNets[n] {
				found = n
				break
			}
		}
		if found == "" {
			return route{Reason: fmt.Sprintf("the container is not attached to network %q from the label pgscope.network", pref)}
		}
		names = []string{found}
	}
	if len(names) == 0 {
		return route{Reason: "the container has no IP address on a usable network"}
	}
	at := func(n string) route {
		ep := t.NetworkSettings.Networks[n]
		return route{Network: n, NetID: ep.NetworkID, IP: ep.IPAddress}
	}

	host := self == nil || self.HostConfig.NetworkMode == "host"
	if !host {
		for _, n := range names {
			for _, own := range self.NetworkSettings.Networks {
				if own.NetworkID != "" && own.NetworkID == t.NetworkSettings.Networks[n].NetworkID {
					return at(n)
				}
			}
		}
		if _, task := self.Config.Labels["com.docker.swarm.task.id"]; task {
			// a running Swarm task cannot join networks: the stack has to declare them
			return route{Reason: fmt.Sprintf("the agent is not on network %s; add it to the agent stack (networks: %s: external: true) or run: docker service update --network-add %s %s",
				names[0], names[0], names[0], self.Config.Labels["com.docker.swarm.service.name"])}
		}
		if !autoconnect {
			return route{Reason: fmt.Sprintf("the agent is not on network %s; declare it in the agent's compose file or set PGSCOPE_AGENT_AUTOCONNECT=true", names[0])}
		}
	}
	var why []string
	for _, n := range names {
		r, nw := at(n), nets[t.NetworkSettings.Networks[n].NetworkID]
		switch {
		case host && nw.Driver == "overlay":
			why = append(why, fmt.Sprintf("overlay network %s is not reachable from the host network namespace; run the agent as a Swarm service on that network", n))
		case host:
			return r // the host reaches bridge networks by container IP
		case nw.Options["com.docker.network.bridge.enable_icc"] == "false":
			why = append(why, fmt.Sprintf("network %s blocks traffic between containers (enable_icc=false)", n))
		case nw.Driver == "overlay" && !nw.Attachable:
			why = append(why, fmt.Sprintf("overlay network %s is not attachable (only Swarm services can join it); deploy the agent as a Swarm service or recreate the network with --attachable", n))
		default:
			r.Join = true
			return r
		}
	}
	return route{Reason: strings.Join(why, "; ")}
}

//------------------------------------------------------------------------------
// own container

var rxMountID = regexp.MustCompile(`/containers/([0-9a-f]{64})/hostname`)

// selfCandidates lists ids/names that may be the agent's own container, best first:
// explicit setting, the /etc/hostname bind mount in mountinfo, then $HOSTNAME.
func selfCandidates(explicit, mountinfo, hostname string) []string {
	var c []string
	if explicit != "" {
		c = append(c, explicit)
	}
	if m := rxMountID.FindStringSubmatch(mountinfo); m != nil {
		c = append(c, m[1])
	}
	if hostname != "" {
		c = append(c, hostname)
	}
	return c
}

//------------------------------------------------------------------------------
// errors

func classify(msg string) string {
	m := strings.ToLower(msg)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(m, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("password authentication failed", "no pg_hba.conf entry", "(sqlstate 28"):
		return "auth_failed"
	case has("connection refused", "no route to host", "i/o timeout", "deadline exceeded", "no such host",
		"network is unreachable", "host is down", "connection reset"):
		return "unreachable"
	}
	return "error"
}

// detail makes an error message safe and short for the heartbeat: the password
// is masked, only the first and last line kept (pgx lists every connection
// attempt, the last one is the telling one), at most 500 bytes.
func detail(msg, password string) string {
	if password != "" {
		msg = strings.ReplaceAll(msg, password, "***")
	}
	if lines := strings.Split(strings.TrimSpace(msg), "\n"); len(lines) > 2 {
		msg = lines[0] + " " + lines[len(lines)-1]
	}
	msg = strings.Join(strings.Fields(msg), " ")
	if len(msg) > 500 {
		i := 497
		for i > 0 && !utf8.RuneStart(msg[i]) {
			i--
		}
		msg = msg[:i] + "..."
	}
	return msg
}
