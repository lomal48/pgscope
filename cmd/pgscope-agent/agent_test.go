package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Fixtures: trimmed GET /containers/{id}/json responses (real field names and nesting).

const composeDB = `{
 "Id": "4f0e7c2a9b1d3e5f60718293a4b5c6d7e8f90123456789abcdef0123456789ab",
 "Name": "/shop-db-1",
 "Config": {"Hostname": "4f0e7c2a9b1d", "Image": "postgres:16",
  "Labels": {"com.docker.compose.project": "shop", "com.docker.compose.service": "db",
   "com.docker.compose.container-number": "1", "com.docker.compose.network": "backend", "pgscope.enable": "true"}},
 "HostConfig": {"NetworkMode": "shop_backend"},
 "NetworkSettings": {"Networks": {"shop_backend": {"IPAMConfig": null, "Aliases": ["shop-db-1", "db"],
  "NetworkID": "n-shop-backend", "EndpointID": "e1", "Gateway": "", "IPAddress": "172.20.0.2", "IPPrefixLen": 16}}}}`

const swarmReplicated = `{
 "Id": "9a8b7c6d5e4f30211203948576a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8",
 "Name": "/billing_db.2.k3j4h5g6f7d8s9a0q1w2e3r4t",
 "Config": {"Hostname": "9a8b7c6d5e4f", "Image": "postgres:16@sha256:abc",
  "Labels": {"com.docker.stack.namespace": "billing", "com.docker.swarm.node.id": "x7y8z9w0v1u2t3s4r5q6p7o8n",
   "com.docker.swarm.service.id": "s1", "com.docker.swarm.service.name": "billing_db", "com.docker.swarm.task": "",
   "com.docker.swarm.task.id": "k3j4h5g6f7d8s9a0q1w2e3r4t", "com.docker.swarm.task.name": "billing_db.2.k3j4h5g6f7d8s9a0q1w2e3r4t",
   "pgscope.enable": "true"}},
 "HostConfig": {"NetworkMode": "default"},
 "NetworkSettings": {"Networks": {
  "billing_internal": {"NetworkID": "n-billing-internal", "IPAddress": "10.0.5.7", "IPPrefixLen": 24},
  "ingress": {"NetworkID": "n-ingress", "IPAddress": "10.0.0.9", "IPPrefixLen": 24}}}}`

const swarmGlobal = `{
 "Id": "1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01",
 "Name": "/edge_cache.x7y8z9w0v1u2t3s4r5q6p7o8n.m1n2b3v4c5x6z7l8k9j0h1g2f",
 "Config": {"Hostname": "1b2c3d4e5f60", "Image": "postgres:17",
  "Labels": {"com.docker.stack.namespace": "edge", "com.docker.swarm.node.id": "x7y8z9w0v1u2t3s4r5q6p7o8n",
   "com.docker.swarm.service.name": "edge_cache", "com.docker.swarm.task": "", "com.docker.swarm.task.id": "m1n2b3v4c5x6z7l8k9j0h1g2f",
   "com.docker.swarm.task.name": "edge_cache.x7y8z9w0v1u2t3s4r5q6p7o8n.m1n2b3v4c5x6z7l8k9j0h1g2f", "pgscope.enable": "true"}},
 "HostConfig": {"NetworkMode": "default"},
 "NetworkSettings": {"Networks": {"edge_net": {"NetworkID": "n-edge", "IPAddress": "10.0.7.3", "IPPrefixLen": 24}}}}`

// a task on an overlay created without --attachable (only services may join it)
const swarmNotAttachable = `{
 "Id": "77aa88bb99cc00dd11ee22ff33aa44bb55cc66dd77ee88ff99aa00bb11cc22dd",
 "Name": "/crm_pg.1.q9w8e7r6t5y4u3i2o1p0a9s8d",
 "Config": {"Hostname": "77aa88bb99cc", "Image": "postgres:15",
  "Labels": {"com.docker.swarm.node.id": "abcdef123456", "com.docker.swarm.service.name": "crm_pg",
   "com.docker.swarm.task.id": "q9w8e7r6t5y4u3i2o1p0a9s8d", "com.docker.swarm.task.name": "crm_pg.1.q9w8e7r6t5y4u3i2o1p0a9s8d",
   "pgscope.enable": "true"}},
 "HostConfig": {"NetworkMode": "default"},
 "NetworkSettings": {"Networks": {"crm_private": {"NetworkID": "n-crm", "IPAddress": "10.0.9.4", "IPPrefixLen": 24}}}}`

const explicitPgbouncer = `{
 "Id": "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
 "Name": "/legacy-bouncer",
 "Config": {"Hostname": "c0ffee00c0ff", "Image": "edoburu/pgbouncer:1.23",
  "Labels": {"pgscope.enable": "true", "pgscope.name": "orders bouncer", "pgscope.kind": "pgbouncer",
   "pgscope.server": "orders-main", "pgscope.port": "6432", "pgscope.dbs": " a, b ,,c ", "pgscope.network": "front",
   "pgscope.sslmode": "require", "pgscope.user": "stats", "pgscope.password-file": "/run/secrets/bouncer_pw"}},
 "HostConfig": {"NetworkMode": "bridge"},
 "NetworkSettings": {"Networks": {
  "bridge": {"NetworkID": "n-bridge", "IPAddress": "172.17.0.5"},
  "front": {"NetworkID": "n-front", "IPAddress": "172.30.0.5"},
  "back": {"NetworkID": "n-back", "IPAddress": "172.31.0.5"}}}}`

// the agent itself: a compose container on its own project network
const composeAgent = `{
 "Id": "aa00bb11cc22dd33ee44ff55aa66bb77cc88dd99ee00ff11aa22bb33cc44dd55",
 "Name": "/pgscope-agent-agent-1",
 "Config": {"Hostname": "aa00bb11cc22", "Image": "pgscope-agent:latest",
  "Labels": {"com.docker.compose.project": "pgscope-agent", "com.docker.compose.service": "agent"}},
 "HostConfig": {"NetworkMode": "pgscope-agent_default"},
 "NetworkSettings": {"Networks": {"pgscope-agent_default": {"NetworkID": "n-agent", "IPAddress": "172.25.0.2"}}}}`

// the agent as a global Swarm service task
const swarmAgent = `{
 "Id": "bb00bb11cc22dd33ee44ff55aa66bb77cc88dd99ee00ff11aa22bb33cc44dd55",
 "Name": "/pgscope_agent.x7y8z9w0v1u2t3s4r5q6p7o8n.t1t2t3",
 "Config": {"Labels": {"com.docker.swarm.service.name": "pgscope_agent", "com.docker.swarm.task.id": "t1t2t3",
  "com.docker.swarm.task.name": "pgscope_agent.x7y8z9w0v1u2t3s4r5q6p7o8n.t1t2t3", "com.docker.swarm.node.id": "x7y8z9w0v1u2t3s4r5q6p7o8n"}},
 "HostConfig": {"NetworkMode": "default"},
 "NetworkSettings": {"Networks": {"edge_net": {"NetworkID": "n-edge", "IPAddress": "10.0.7.9"},
  "pgscope_default": {"NetworkID": "n-pgscope", "IPAddress": "10.0.8.2"}}}}`

const hostAgent = `{"Id": "cc00", "Name": "/agent", "HostConfig": {"NetworkMode": "host"},
 "NetworkSettings": {"Networks": {"host": {"NetworkID": "n-host", "IPAddress": ""}}}}`

var nets = map[string]network{
	"n-shop-backend":     {Name: "shop_backend", Driver: "bridge", Options: map[string]string{"com.docker.network.bridge.enable_icc": "true"}},
	"n-billing-internal": {Name: "billing_internal", Driver: "overlay"},
	"n-edge":             {Name: "edge_net", Driver: "overlay", Attachable: true},
	"n-crm":              {Name: "crm_private", Driver: "overlay", Attachable: false},
	"n-bridge":           {Name: "bridge", Driver: "bridge"},
	"n-front":            {Name: "front", Driver: "bridge", Options: map[string]string{"com.docker.network.bridge.enable_icc": "false"}},
	"n-back":             {Name: "back", Driver: "bridge"},
}

func fixture(t *testing.T, js string) *container {
	t.Helper()
	var c container
	if err := json.Unmarshal([]byte(js), &c); err != nil {
		t.Fatal(err)
	}
	return &c
}

func TestServerName(t *testing.T) {
	for _, tc := range []struct{ js, prefix, want string }{
		{composeDB, "", "shop-db"},
		{composeDB, "prod", "prod.shop-db"},
		{swarmReplicated, "", "billing_db-2"},
		{swarmReplicated, "eu", "eu.billing_db-2"},
		{swarmGlobal, "eu", "eu.edge_cache-x7y8z9"},
		{swarmNotAttachable, "", "crm_pg"},          // slot 1: no suffix
		{explicitPgbouncer, "eu", "orders-bouncer"}, // explicit label: sanitized, no prefix
		{hostAgent, "", "agent"},                    // plain container name
		{`{"Name": "/x", "Config": {"Labels": {"com.docker.compose.project": "p", "com.docker.compose.service": "s", "com.docker.compose.container-number": "3"}}}`, "", "p-s-3"},
		{`{"Name": "/x", "Config": {"Labels": {"pgscope.name": "` + strings.Repeat("я", 80) + `"}}}`, "", strings.Repeat("-", 64)},
	} {
		if got := serverName(fixture(t, tc.js), tc.prefix); got != tc.want {
			t.Errorf("serverName(%.40s…, %q) = %q, want %q", tc.js, tc.prefix, got, tc.want)
		}
	}
}

func TestParseSpec(t *testing.T) {
	s := parseSpec(fixture(t, explicitPgbouncer), "")
	if s.Kind != "pgbouncer" || s.Server != "orders-main" || s.Port != 6432 || strings.Join(s.DBs, "|") != "a|b|c" ||
		s.Network != "front" || s.SSLMode != "require" || s.User != "stats" || s.PasswordFile != "/run/secrets/bouncer_pw" || s.Err != "" {
		t.Errorf("explicit labels: %+v", s)
	}
	s = parseSpec(fixture(t, composeDB), "")
	if s.Kind != "postgres" || s.Port != 5432 || s.DBs != nil || s.SSLMode != "" || s.User != "" || s.Err != "" {
		t.Errorf("defaults: %+v", s)
	}
	for _, labels := range []string{
		`{"pgscope.port": "54x"}`, `{"pgscope.port": "70000"}`, `{"pgscope.kind": "mysql"}`,
		`{"pgscope.kind": "pgbouncer"}`, `{"pgscope.kind": "pgbouncer", "pgscope.server": "bad name"}`,
		// connection-string injection into pgmetrics, and file reads through the password label
		`{"pgscope.dbs": "app,x\thost=evil.example"}`, `{"pgscope.dbs": "host=evil.example"}`, `{"pgscope.dbs": "postgres://evil.example/x"}`,
		`{"pgscope.user": "u\nhost=evil.example"}`, `{"pgscope.password-file": "/etc/shadow"}`, `{"pgscope.password-file": "/run/secrets/../../etc/shadow"}`,
	} {
		if s := parseSpec(fixture(t, `{"Name": "/x", "Config": {"Labels": `+labels+`}}`), ""); s.Err == "" {
			t.Errorf("labels %s: expected an error", labels)
		}
	}
}

func TestChooseRoute(t *testing.T) {
	for _, tc := range []struct {
		name, target, self, pref string
		auto                     bool
		want                     route
		reason                   string // substring of want.Reason when set
	}{
		{name: "compose: join the internal network", target: composeDB, self: composeAgent, auto: true,
			want: route{Network: "shop_backend", NetID: "n-shop-backend", IP: "172.20.0.2", Join: true}},
		{name: "compose: autoconnect off", target: composeDB, self: composeAgent,
			reason: "declare it in the agent's compose file"},
		{name: "compose: host-mode agent uses the IP", target: composeDB, self: hostAgent, auto: true,
			want: route{Network: "shop_backend", NetID: "n-shop-backend", IP: "172.20.0.2"}},
		{name: "compose: agent outside containers", target: composeDB, auto: true,
			want: route{Network: "shop_backend", NetID: "n-shop-backend", IP: "172.20.0.2"}},
		{name: "swarm global: shared network, no join", target: swarmGlobal, self: swarmAgent, auto: true,
			want: route{Network: "edge_net", NetID: "n-edge", IP: "10.0.7.3"}},
		{name: "swarm replicated: task agent never joins", target: swarmReplicated, self: swarmAgent, auto: true,
			reason: "docker service update --network-add billing_internal pgscope_agent"},
		{name: "swarm: overlay unreachable from host mode", target: swarmReplicated, self: hostAgent, auto: true,
			reason: "not reachable from the host network namespace"},
		{name: "standalone agent, overlay not attachable", target: swarmNotAttachable, self: composeAgent, auto: true,
			reason: "overlay network crm_private is not attachable"},
		{name: "standalone agent joins an attachable overlay", target: swarmGlobal, self: composeAgent, auto: true,
			want: route{Network: "edge_net", NetID: "n-edge", IP: "10.0.7.3", Join: true}},
		{name: "explicit network label, icc disabled", target: explicitPgbouncer, self: composeAgent, pref: "front", auto: true,
			reason: "enable_icc=false"},
		{name: "user-defined network beats the default bridge", target: explicitPgbouncer, self: composeAgent, auto: true,
			want: route{Network: "back", NetID: "n-back", IP: "172.31.0.5", Join: true}},
		{name: "short compose network name in the label", target: composeDB, self: composeAgent, pref: "backend", auto: true,
			want: route{Network: "shop_backend", NetID: "n-shop-backend", IP: "172.20.0.2", Join: true}},
		{name: "label names a network the container is not on", target: composeDB, self: composeAgent, pref: "frontend", auto: true,
			reason: `not attached to network "frontend"`},
	} {
		var self *container
		if tc.self != "" {
			self = fixture(t, tc.self)
		}
		got := chooseRoute(fixture(t, tc.target), self, nets, tc.pref, tc.auto)
		if tc.reason != "" {
			if !strings.Contains(got.Reason, tc.reason) || got.IP != "" {
				t.Errorf("%s: got %+v, want reason containing %q", tc.name, got, tc.reason)
			}
		} else if got != tc.want {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestSelfCandidates(t *testing.T) {
	id := strings.Repeat("ab12", 16)
	mi := "612 590 0:31 / / rw,relatime - overlay overlay rw\n" +
		"640 612 254:1 /docker/containers/" + id + "/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw\n"
	got := strings.Join(selfCandidates("pgscope-agent", mi, "custom-host"), ",")
	if got != "pgscope-agent,"+id+",custom-host" {
		t.Errorf("candidates: %s", got)
	}
	if got := selfCandidates("", "", ""); got != nil {
		t.Errorf("no hints: %v", got)
	}
}

func TestClassifyAndDetail(t *testing.T) {
	for msg, want := range map[string]string{
		`failed to connect to ` + "`user=pgscope_monitor database=postgres`" + `: 172.20.0.2:5432 (172.20.0.2): server error: FATAL: password authentication failed for user "pgscope_monitor" (SQLSTATE 28P01)`: "auth_failed",
		`pgmetrics: failed to connect: FATAL: no pg_hba.conf entry for host "172.20.0.9", user "pgscope_monitor", database "app", no encryption (SQLSTATE 28000)`:                                                "auth_failed",
		`failed to connect to ` + "`user=u database=postgres`" + `: 172.20.0.2:5432 (172.20.0.2): dial error: dial tcp 172.20.0.2:5432: connect: connection refused`:                                             "unreachable",
		`failed to connect to ` + "`user=u database=postgres`" + `: 10.0.0.2:5432 (10.0.0.2): dial error: timeout: context deadline exceeded`:                                                                    "unreachable",
		`pgmetrics: pg_stat_statements query failed: ERROR: canceling statement due to statement timeout (SQLSTATE 57014)`:                                                                                       "error",
	} {
		if got := classify(msg); got != want {
			t.Errorf("classify(%.60s…) = %s, want %s", msg, got, want)
		}
	}
	if got := detail("auth  failed\n for  s3cr3t-pw", "s3cr3t-pw"); got != "auth failed for ***" {
		t.Errorf("detail = %q", got)
	}
	if got := detail("failed to connect to `user=u database=postgres`:\n\t1.2.3.4:5432 (1.2.3.4): tls error: server refused TLS connection\n\t1.2.3.4:5432 (1.2.3.4): failed SASL auth: FATAL: password authentication failed", ""); got != "failed to connect to `user=u database=postgres`: 1.2.3.4:5432 (1.2.3.4): failed SASL auth: FATAL: password authentication failed" {
		t.Errorf("multi-attempt detail = %q", got)
	}
	if got := detail(strings.Repeat("ж", 400), ""); len(got) > 500 || !strings.HasSuffix(got, "ж...") {
		t.Errorf("long detail: %d bytes, %q", len(got), got[len(got)-10:])
	}
}

func TestNegotiate(t *testing.T) {
	for server, want := range map[string]string{"1.52": "1.47", "1.47": "1.47", "1.44": "1.44", "1.9": "1.9", "": "1.24"} {
		if got := negotiate(server); got != want {
			t.Errorf("negotiate(%q) = %s, want %s", server, got, want)
		}
	}
}

func TestKV(t *testing.T) {
	if got := kv("password", `it's\x`); got != `password='it\'s\\x' ` {
		t.Errorf("kv = %s", got)
	}
}
