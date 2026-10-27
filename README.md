# pgscope

Self-hosted PostgreSQL monitoring with the feature set of pgDash: one Go binary with
an embedded React UI, storing everything in a PostgreSQL database.

Data collection uses the open-source [pgmetrics](https://pgmetrics.io) and the
open-source [pgdash CLI](https://github.com/rapidloop/pgdash): pgscope implements the
same `/api/v1/report`, `/reportpgbouncer` and `/reportpgpool` endpoints, so existing
cron jobs only need `--base-url`.

Documentation (Russian and English) is built into the app: **Documentation** in the sidebar, or
`<PGSCOPE_BASE_URL>/#/docs` — readable without signing in. Sources: [web/src/docs/](web/src/docs/)
(`ru/` and `en/`, one markdown file per page; `node web/scripts/i18n-check.mjs` checks pages, anchors and links).

## Build

Requires Go 1.26+ and Node 20+.

```bash
cd web && npm ci && npm run build && cd .. && go build -o pgscope .
```

## Run

```bash
createdb pgscope
PGSCOPE_DB=postgres://user@dbhost/pgscope PGSCOPE_BASE_URL=http://monitor:8080 ./pgscope
```

Open the UI, sign up, copy the API key from the profile page, then report every ~5 minutes:

```bash
pgmetrics --no-password -f json -h DBHOST db1 db2 | pgdash -a APIKEY --base-url=http://monitor:8080/api/v1 report prod-db-1
```

| Variable | Default | Meaning |
|---|---|---|
| `PGSCOPE_DB` | `postgres://localhost/pgscope` | where pgscope stores its data (tables are created on start) |
| `PGSCOPE_LISTEN` | `:8080` | HTTP listen address |
| `PGSCOPE_BASE_URL` | `http://localhost:8080` | public URL, used in alert links and invitations |
| `PGSCOPE_MIN_REPORT_INTERVAL` | `60` | seconds between reports of one server (HTTP 429 otherwise) |
| `PGSCOPE_METRICS_RETENTION_DAYS` | `90` | time-series and event history retention |
| `PGSCOPE_REPORT_RETENTION_DAYS` | `14` | raw report retention (the latest report is always kept) |
| `PGSCOPE_SMTP_ADDR` / `_USER` / `_PASS` / `_FROM` | — | SMTP for email alerts and team invitations |
| `PGSCOPE_AI_KEY` | — | Anthropic API key, enables AI chat |
| `PGSCOPE_AI_MODEL` | `claude-opus-5-5` | model for AI chat |
| `PGSCOPE_AI_BASE_URL` | — | optional Anthropic API base URL (proxy / gateway) |

## Docker and Docker Swarm

`deploy/docker-compose.yml` runs pgscope with its storage database. For databases in containers, run
**pgscope-agent** on every Docker host (`deploy/agent/docker-compose.yml`) or as a global Swarm service
(`deploy/agent/docker-stack.yml`). The agent finds containers labelled `pgscope.enable=true`, reaches them over
the internal Docker networks, runs pgmetrics and sends the reports. `deploy/agent/bootstrap-monitor-role.sh`
creates the monitoring role.

```bash
docker build -t pgscope:latest .
docker build -f Dockerfile.agent -t pgscope-agent:latest .
```

Images build on a machine with internet access and move to air-gapped hosts with `docker save` / `docker load`.
Setup, labels, networks, secrets and troubleshooting are covered on the
[Docker and Docker Swarm](web/src/docs/en/docker.md) docs page (`#/docs/docker` in the UI).

## Features

- **Fleet**: server list, Inspector with fleet-wide tables for servers, databases, replication, transaction IDs, disk & WAL.
- **Per server**: overview, diagnostics (health issues + configuration check), queries (pg_stat_statements with
  time series, auto_explain plan visualization, suggestions), backends, locks with blocking chains, databases,
  tables, indexes, index management (unused / bloated / duplicate with SQL), top-k (incl. growth), tablespaces
  (with move/drop SQL), extensions/functions/sequences/triggers, roles, replication & slots, WAL & checkpoints,
  vacuum (progress, dead rows, XID age, autovacuum history), configuration, system, logs, AWS/Azure cloud metrics,
  PgBouncer and Pgpool dashboards, past reports via the report picker.
- **Alerts**: server, database, table, tablespace and query rules (warning/critical, object filters), edge-triggered
  notifications by email, Slack, PagerDuty, VictorOps, xMatters and webhooks (pgDash-compatible JSON payloads).
- **Change alerts**: users, databases, tables, indexes, settings, extensions, slots, triggers, restarts, version and
  abrupt size/row-count changes between consecutive reports.
- **Teams**: share a server by email (invite links work without SMTP); members cannot delete data or re-share.
- **AI chat** about a server, grounded in its latest report.

## Development

```bash
./pgscope &                 # API on :8080 (set PGSCOPE_LISTEN=127.0.0.1:8091 to match the Vite proxy)
cd web && npm run dev       # UI with hot reload, proxies /api to 127.0.0.1:8091
go test ./...
```
