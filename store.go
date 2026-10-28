package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log"
	"time"

	"github.com/rapidloop/pgmetrics"
)

const schema = `
create table if not exists users (
  id bigserial primary key,
  email text not null unique,
  pwhash text not null,
  apikey text unique,                       -- null for team-member accounts
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token text primary key,
  user_id bigint not null references users on delete cascade,
  expires timestamptz not null
);
create table if not exists servers (
  id bigserial primary key,
  owner_id bigint not null references users on delete cascade,
  kind text not null default 'postgres',    -- postgres | pgpool
  name text not null,
  last_report timestamptz,
  summary jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, kind, name)
);
create table if not exists shares (
  server_id bigint not null references servers on delete cascade,
  user_id bigint not null references users on delete cascade,
  primary key (server_id, user_id)
);
create table if not exists invites (
  token text primary key,
  server_id bigint not null references servers on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);
create table if not exists reports (
  id bigserial primary key,
  server_id bigint not null references servers on delete cascade,
  source text not null default '',          -- '' = the server itself, else a pgbouncer name
  at timestamptz not null,
  data bytea not null                       -- gzip-compressed pgmetrics JSON, as received
);
create index if not exists reports_idx on reports (server_id, source, at);
create table if not exists metrics (
  server_id bigint not null references servers on delete cascade,
  at timestamptz not null,
  obj text not null,                        -- '' = server, 'db:x', 'tbl:db.schema.t', ...
  vals jsonb not null
);
create index if not exists metrics_idx on metrics (server_id, obj, at);
create index if not exists metrics_at on metrics using brin (at);
create table if not exists alert_rules (
  id bigserial primary key,
  server_id bigint not null references servers on delete cascade,
  metric text not null,
  op text not null,                         -- gt | lt
  threshold double precision not null,
  param double precision not null default 0,
  severity text not null,                   -- warn | crit
  match text not null default 'all',        -- all|contains|notcontains|startswith|endswith|exact
  match_text text not null default '',
  db_name text not null default ''
);
create table if not exists change_rules (
  server_id bigint primary key references servers on delete cascade,
  kinds text[] not null default '{}',
  size_pct double precision not null default 20
);
create table if not exists notifiers (
  id bigserial primary key,
  server_id bigint not null references servers on delete cascade,
  scope text not null,                      -- alerts | changes
  kind text not null,                       -- email|slack|pagerduty|victorops|xmatters|webhook
  target text not null
);
create table if not exists alert_state (
  server_id bigint primary key references servers on delete cascade,
  at timestamptz not null,
  alerts jsonb not null
);
create table if not exists events (
  id bigserial primary key,
  server_id bigint not null references servers on delete cascade,
  at timestamptz not null,
  kind text not null,                       -- alerts | changes
  body jsonb not null
);
create index if not exists events_idx on events (server_id, at);
alter table users add column if not exists lang text;            -- ru | en, null = not chosen
alter table users add column if not exists tz text;              -- IANA time zone of the web UI, null = the browser's
alter table notifiers add column if not exists lang text not null default 'ru';
create table if not exists agents (           -- Docker agents, upserted by their heartbeat
  owner_id bigint not null references users on delete cascade,
  agent_id text not null,                   -- <cluster>/<host or node id>
  info jsonb not null,
  targets jsonb not null,
  last_seen timestamptz not null,
  primary key (owner_id, agent_id)
);
-- one pending invite per email and server: drop older duplicates, then enforce it
delete from invites a using invites b where a.server_id = b.server_id and a.email = b.email
  and (a.created_at, a.token) < (b.created_at, b.token);
create unique index if not exists invites_email on invites (server_id, email);
`

type deletion struct {
	sql  string
	days int
}

// retentionPass lists the deletions of one retention pass. A retention of 0 days keeps that
// kind of data forever (main rejects negative ones).
func retentionPass() []deletion {
	out := []deletion{{`delete from sessions where expires < now() - make_interval(days => $1)`, 0}}
	for _, d := range []deletion{
		{`delete from metrics where at < now() - make_interval(days => $1)`, cfg.MetricsDays},
		{`delete from events where at < now() - make_interval(days => $1)`, cfg.MetricsDays},
		// always keep the latest report of every source, even if it is old
		{`delete from reports r where at < now() - make_interval(days => $1)
		    and at < (select max(at) from reports x where x.server_id = r.server_id and x.source = r.source)`, cfg.ReportDays},
	} {
		if d.days > 0 {
			out = append(out, d)
		}
	}
	return out
}

func retentionLoop() {
	for {
		ctx := context.Background()
		for _, q := range retentionPass() {
			if _, err := db.Exec(ctx, q.sql, q.days); err != nil {
				log.Print("retention: ", err)
			}
		}
		time.Sleep(time.Hour)
	}
}

func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.Write(b)
	gz.Close()
	return buf.Bytes()
}

func gunzip(b []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(gz)
}

// loadModel returns the latest report of a server at or before `at` (0 = latest).
func loadModel(ctx context.Context, sid int64, source string, at int64) (*pgmetrics.Model, error) {
	if at <= 0 {
		at = time.Now().Unix() + 86400
	}
	var data []byte
	err := db.QueryRow(ctx, `select data from reports where server_id=$1 and source=$2 and at <= to_timestamp($3)
		order by at desc limit 1`, sid, source, at).Scan(&data)
	if err != nil {
		return nil, err
	}
	raw, err := gunzip(data)
	if err != nil {
		return nil, err
	}
	var m pgmetrics.Model
	return &m, json.Unmarshal(raw, &m)
}
