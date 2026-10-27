package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentHeartbeat(t *testing.T) {
	const body = `{"apikey": "k", "agent": {"id": "prod/node-1", "cluster": "prod", "host": "node-1", "mode": "swarm",
		"version": "1.0", "docker_version": "27.4.0", "autoconnect": false, "interval": 300},
		"targets": [{"name": "prod.db", "kind": "postgres", "container_id": "0123456789ab", "address": "10.0.0.5:5432",
		             "status": "ok", "last_ok": 100, "last_attempt": 100, "server_id": 999},
		            {"name": "bouncer", "kind": "pgbouncer", "status": "auth_failed", "error": "password authentication failed"}]}`
	r := httptest.NewRequest("POST", "/api/v1/agent", strings.NewReader(string(gzipBytes([]byte(body)))))
	r.Header.Set("Content-Encoding", "gzip")
	in, ok := reqBody(httptest.NewRecorder(), r, 4<<20, 4<<20)
	var hb heartbeat
	if !ok || json.NewDecoder(in).Decode(&hb) != nil || hb.check() != "" {
		t.Fatalf("heartbeat rejected: %+v", hb)
	}
	if hb.Agent.Mode != "swarm" || hb.Agent.Interval != 300 || len(hb.Targets) != 2 || hb.Targets[1].Status != "auth_failed" {
		t.Fatalf("decoded = %+v", hb)
	}

	// server ids come from pgscope only; a pgbouncer links by its source name, not a server name
	linkTargets(hb.Targets, map[[2]string]int64{{"postgres", "prod.db"}: 7, {"postgres", "bouncer"}: 8})
	b, _ := json.Marshal(hb.Targets)
	if !strings.Contains(string(b), `"last_attempt":100,"server_id":7}`) || strings.Count(string(b), "server_id") != 1 {
		t.Fatalf("linked targets = %s", b)
	}

	for id, want := range map[string]string{"prod/node-1": "", "c:1/n_2.x-y": "", "": "Некорректный идентификатор агента",
		"a b": "Некорректный идентификатор агента", strings.Repeat("a", 129): "Некорректный идентификатор агента"} {
		hb := heartbeat{Agent: agentInfo{ID: id}}
		if got := hb.check(); got != want || (want == "" && hb.Targets == nil) {
			t.Fatalf("check(%q) = %q, targets %v", id, got, hb.Targets)
		}
	}
}
