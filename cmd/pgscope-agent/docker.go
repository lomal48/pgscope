package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// docker talks to the Docker Engine API over the unix socket (or a tcp socket proxy).
type docker struct {
	hc   *http.Client
	base string // "http://docker" for unix sockets, "http://host:port" for tcp
	ver  string // "/v1.47", negotiated in ping
}

// maxAPI is the newest Engine API this client is written against. Calls use
// min(server, maxAPI): unversioned calls are deprecated and a fixed old version
// is refused by Engine 29.0-29.2 (minimum 1.44).
const maxAPI = "1.47"

func newDocker(host string) (*docker, error) {
	if host == "" {
		host = "unix:///var/run/docker.sock"
	}
	d := &docker{hc: &http.Client{Timeout: 30 * time.Second}}
	switch {
	case strings.HasPrefix(host, "unix://"):
		path := strings.TrimPrefix(host, "unix://")
		d.hc.Transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dl net.Dialer
			return dl.DialContext(ctx, "unix", path)
		}}
		d.base = "http://docker"
	case strings.HasPrefix(host, "tcp://"):
		d.base = "http://" + strings.TrimPrefix(host, "tcp://")
	default:
		return nil, fmt.Errorf("DOCKER_HOST %q: only unix:// and tcp:// are supported", host)
	}
	return d, nil
}

// ping negotiates the API version from the Api-Version header of /_ping.
func (d *docker) ping(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", d.base+"/_ping", nil)
	resp, err := d.hc.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("docker /_ping: HTTP %d", resp.StatusCode)
	}
	d.ver = "/v" + negotiate(resp.Header.Get("Api-Version"))
	return nil
}

// negotiate returns min(server, maxAPI); an absent header means a very old daemon.
func negotiate(server string) string {
	if server == "" {
		return "1.24"
	}
	if verLess(server, maxAPI) {
		return server
	}
	return maxAPI
}

func verLess(a, b string) bool {
	amaj, amin, _ := strings.Cut(a, ".")
	bmaj, bmin, _ := strings.Cut(b, ".")
	x, _ := strconv.Atoi(amaj)
	y, _ := strconv.Atoi(bmaj)
	if x != y {
		return x < y
	}
	x, _ = strconv.Atoi(amin)
	y, _ = strconv.Atoi(bmin)
	return x < y
}

func (d *docker) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+d.ver+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		var e struct{ Message string }
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if json.Unmarshal(b, &e) != nil || e.Message == "" {
			e.Message = strings.TrimSpace(string(b))
		}
		if resp.StatusCode == 400 && strings.Contains(e.Message, "too old") {
			log.Printf("ERROR: the Docker daemon refuses API %s (%s); please report this together with `docker version`", d.ver, e.Message)
		}
		return fmt.Errorf("docker %s %s: HTTP %d: %s", method, path, resp.StatusCode, e.Message)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

//------------------------------------------------------------------------------
// the subset of Engine API objects the agent reads

type dockerInfo struct {
	Name          string
	ServerVersion string
	Swarm         struct {
		LocalNodeState string
		NodeID         string
	}
}

type container struct {
	ID     string
	Name   string
	Config struct {
		Image    string
		Hostname string
		Labels   map[string]string
	}
	HostConfig struct {
		NetworkMode string
	}
	NetworkSettings struct {
		Networks map[string]endpoint
	}
}

type endpoint struct {
	NetworkID string
	IPAddress string
}

type network struct {
	ID         string
	Name       string
	Driver     string
	Attachable bool
	Options    map[string]string
}

func (d *docker) info(ctx context.Context) (i dockerInfo, err error) {
	err = d.do(ctx, "GET", "/info", nil, &i)
	return
}

// running lists running containers matching every label filter of the selector.
func (d *docker) running(ctx context.Context, selector string) ([]string, error) {
	var labels []string
	for _, l := range strings.Split(selector, ",") {
		if l = strings.TrimSpace(l); l != "" {
			labels = append(labels, l)
		}
	}
	f, _ := json.Marshal(map[string][]string{"label": labels, "status": {"running"}})
	var list []struct{ ID string }
	if err := d.do(ctx, "GET", "/containers/json?filters="+url.QueryEscape(string(f)), nil, &list); err != nil {
		return nil, err
	}
	ids := make([]string, len(list))
	for i, c := range list {
		ids[i] = c.ID
	}
	return ids, nil
}

func (d *docker) inspect(ctx context.Context, id string) (c *container, err error) {
	c = &container{}
	err = d.do(ctx, "GET", "/containers/"+url.PathEscape(id)+"/json", nil, c)
	return
}

func (d *docker) network(ctx context.Context, id string) (n network, err error) {
	err = d.do(ctx, "GET", "/networks/"+url.PathEscape(id), nil, &n)
	return
}

func (d *docker) connect(ctx context.Context, netID, containerID string, join bool) error {
	op := "/disconnect"
	if join {
		op = "/connect"
	}
	return d.do(ctx, "POST", "/networks/"+url.PathEscape(netID)+op, map[string]string{"Container": containerID}, nil)
}
