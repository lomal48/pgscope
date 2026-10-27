package main

// Docker agents (cmd/pgscope-agent) find PostgreSQL containers, send their pgmetrics
// reports through the ingestion API and report what they see via a heartbeat.

import (
	"encoding/json"
	"net/http"
	"regexp"
	"time"
)

var rxAgentID = regexp.MustCompile(`^[A-Za-z0-9_.:/-]{1,128}$`)

type agentInfo struct {
	ID            string `json:"id"`
	Cluster       string `json:"cluster"`
	Host          string `json:"host"`
	Mode          string `json:"mode"` // standalone | swarm
	Version       string `json:"version"`
	DockerVersion string `json:"docker_version"`
	Autoconnect   bool   `json:"autoconnect"`
	Interval      int    `json:"interval"`
}

type agentTarget struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"` // postgres | pgbouncer
	Container   string `json:"container"`
	ContainerID string `json:"container_id"`
	Image       string `json:"image"`
	Network     string `json:"network"`
	Address     string `json:"address"`
	Status      string `json:"status"` // ok | pending | unreachable | auth_failed | error
	Error       string `json:"error"`
	LastOK      int64  `json:"last_ok"`
	LastAttempt int64  `json:"last_attempt"`
	ServerID    int64  `json:"server_id,omitempty"` // set when listing
}

type heartbeat struct {
	APIKey  string        `json:"apikey"`
	Agent   agentInfo     `json:"agent"`
	Targets []agentTarget `json:"targets"`
}

// check validates a decoded heartbeat; the returned text is Russian, for httpErr.
func (hb *heartbeat) check() string {
	if !rxAgentID.MatchString(hb.Agent.ID) {
		return "Некорректный идентификатор агента"
	}
	if hb.Targets == nil {
		hb.Targets = []agentTarget{}
	}
	return ""
}

func agentHeartbeat(w http.ResponseWriter, r *http.Request) {
	body, ok := reqBody(w, r, 4<<20, 4<<20)
	if !ok {
		return
	}
	var hb heartbeat
	if err := json.NewDecoder(body).Decode(&hb); err != nil {
		httpErr(w, 400, "Некорректное тело запроса")
		return
	}
	uid, ok := apiKeyOwner(w, r, hb.APIKey)
	if !ok {
		return
	}
	if msg := hb.check(); msg != "" {
		httpErr(w, 400, msg)
		return
	}
	if _, err := db.Exec(r.Context(), `insert into agents(owner_id, agent_id, info, targets, last_seen) values ($1,$2,$3,$4,now())
		on conflict (owner_id, agent_id) do update set info = excluded.info, targets = excluded.targets, last_seen = excluded.last_seen`,
		uid, hb.Agent.ID, hb.Agent, hb.Targets); err != nil {
		internalErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("{}"))
}

// linkTargets sets server_id of targets that already report into pgscope (and clears
// whatever an agent sent): a postgres target by server name, a pgbouncer target by
// the source name its reports are stored under.
func linkTargets(targets []agentTarget, ids map[[2]string]int64) {
	for i, t := range targets {
		targets[i].ServerID = ids[[2]string{t.Kind, t.Name}]
	}
}

func listAgents(w http.ResponseWriter, r *http.Request, u *user) {
	type row struct {
		AgentID  string          `json:"agent_id"`
		Info     json.RawMessage `json:"info"`
		Targets  []agentTarget   `json:"targets"`
		LastSeen time.Time       `json:"last_seen"`
		Stale    bool            `json:"stale"` // no heartbeat (sent every 60s) for 3 minutes; DB clock on both sides
	}
	ctx := r.Context()
	rows, err := db.Query(ctx, `select agent_id, info, targets, last_seen, last_seen < now() - interval '3 minutes'
		from agents where owner_id = $1 order by agent_id`, u.ID)
	if err != nil {
		internalErr(w, err)
		return
	}
	out := []row{}
	bouncers := []string{}
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.AgentID, &x.Info, &x.Targets, &x.LastSeen, &x.Stale); err != nil {
			rows.Close()
			internalErr(w, err)
			return
		}
		for _, t := range x.Targets {
			if t.Kind == "pgbouncer" {
				bouncers = append(bouncers, t.Name)
			}
		}
		out = append(out, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		internalErr(w, err)
		return
	}
	if len(out) == 0 {
		writeJSON(w, out)
		return
	}
	rows, err = db.Query(ctx, `select 'postgres', name, id from servers where owner_id = $1 and kind = 'postgres'
		union all
		select distinct 'pgbouncer', r.source, r.server_id from servers s join reports r on r.server_id = s.id
		where s.owner_id = $1 and r.source = any($2)`, u.ID, bouncers)
	if err != nil {
		internalErr(w, err)
		return
	}
	defer rows.Close()
	ids := map[[2]string]int64{}
	for rows.Next() {
		var kind, name string
		var id int64
		if err := rows.Scan(&kind, &name, &id); err != nil {
			internalErr(w, err)
			return
		}
		ids[[2]string{kind, name}] = id
	}
	for _, x := range out {
		linkTargets(x.Targets, ids)
	}
	writeJSON(w, out)
}

// deleteAgent removes an agent that stopped reporting; an agent still running comes back with its next heartbeat.
func deleteAgent(w http.ResponseWriter, r *http.Request, u *user) {
	if _, err := db.Exec(r.Context(), `delete from agents where owner_id = $1 and agent_id = $2`, u.ID, r.URL.Query().Get("id")); err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}
