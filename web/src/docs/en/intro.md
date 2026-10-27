# What is pgscope

pgscope is a PostgreSQL monitoring system that you deploy in your own infrastructure. It receives state snapshots of PostgreSQL, PgBouncer and Pgpool-II servers, keeps them in its own PostgreSQL database, draws charts, finds problems, sends alerts and shows all of it in a web UI. This page explains how pgscope works, what it collects, which components it consists of and how to find your way around the documentation.

## Who it is for {#audience}

- **Database administrators (DBAs)** — to investigate slow queries, locks, table and index bloat, replication lag, transaction ID wraparound risk and configuration mistakes.
- **DevOps and SRE engineers** — to watch a fleet of servers, get alerts by email or into internal systems through webhooks, and see schema and setting changes between reports.
- **Teams in isolated networks** — pgscope needs no cloud services and does not contact external addresses on its own (details in [Self-hosted only](#self-hosted)).

## How it works {#architecture}

pgscope uses a push model: it never connects to the monitored databases. The data is sent to it.

```text
PostgreSQL / PgBouncer / Pgpool-II
        │  queries against the statistics views (read-only)
        ▼
pgmetrics ── a snapshot of the server state as JSON
        │
        ▼
pgdash CLI (cron, systemd timer) or pgscope-agent (Docker, Docker Swarm)
        │  HTTP POST /api/v1/report, /api/v1/reportpgbouncer, /api/v1/reportpgpool
        ▼
pgscope ── stores the report and time series in its own PostgreSQL database
        ├──► web UI: charts, tables, diagnostics, Inspector, AI chat
        └──► alert rules and change detection ──► email, webhook and other channels
```

1. **pgmetrics** is an open-source tool: in a single run it queries PostgreSQL statistics and outputs a state snapshot (a report) as JSON.
2. **pgdash CLI** is an open-source tool that sends this JSON to the monitoring server. The `pgmetrics | pgdash` pipeline usually runs on a schedule on the database host or next to it.
3. **pgscope-agent** is the pgscope agent for databases in containers: it finds PostgreSQL and PgBouncer containers labelled `pgscope.enable=true`, runs pgmetrics and sends the reports (see [Docker and Docker Swarm](docker.md)).
4. **pgscope** accepts a report, checks the API key, stores the whole report compressed and extracts time series from it. Then, for PostgreSQL reports, it evaluates the alert rules and compares the report with the previous one to detect changes.

A report is a snapshot at the moment of collection. Charts and trends appear once reports arrive regularly.

## What is collected and how often {#data-collected}

The contents of a report are defined by pgmetrics. Among other things it includes:

- server information: version, start time, recovery mode (standby), configuration settings;
- backends (sessions), locks and blocking chains;
- replication: standbys, lag, replication slots;
- WAL, archiving, checkpoints, background writer;
- databases, tablespaces, tables, indexes, sequences, functions, extensions, roles, triggers;
- query statistics from `pg_stat_statements` (if the extension is installed);
- vacuum processes in progress;
- host system metrics (Linux only) and data from the PostgreSQL log (`auto_explain` plans, autovacuum history) — only when pgmetrics runs on the database host: it reads the log from the local disk, and its path can be given with the `--log-file` or `--log-dir` flags (for AWS RDS and Aurora the log comes from CloudWatch);
- AWS CloudWatch and Azure Monitor metrics — when pgmetrics runs with the corresponding flags;
- PgBouncer and Pgpool-II statistics — in separate reports.

From every report pgscope keeps:

| What | Used by | Default retention |
|---|---|---|
| The full report (JSON, gzip-compressed) | all server pages, picking a past report, diagnostics, AI chat | 14 days; the latest report of every server is always kept |
| Time series for the server, databases, tables, indexes, queries, functions, tablespaces, standbys, slots, PgBouncer and Pgpool | charts, size and row-count growth in **Top-k**, indexes unused over a chosen period in **Index management** | 90 days |
| History of triggered alerts and detected changes | the history tabs on the alerting pages | 90 days |

The retention periods are configurable (see [Configuring pgscope](config.md#retention-vars) and [Data storage](data.md#retention)).

How often reports arrive is up to the sender. The recommended interval is 5 minutes: this is what the UI suggests, and it is the default interval of pgscope-agent (300 seconds). pgscope accepts reports of one server at most once every 60 seconds (configurable with `PGSCOPE_MIN_REPORT_INTERVAL`); more frequent ones are rejected with status 429.

## Compatibility with the pgdash CLI {#pgdash-compatibility}

pgscope implements the same report ingestion API that the open-source pgdash CLI uses:

| pgdash CLI command | pgscope endpoint | What it accepts |
|---|---|---|
| `report SERVER-NAME` | `POST /api/v1/report` | a PostgreSQL report |
| `report-pgbouncer SERVER-NAME PGBOUNCER-NAME` | `POST /api/v1/reportpgbouncer` | a PgBouncer report attached to a PostgreSQL server |
| `report-pgpool PGPOOL-NAME` | `POST /api/v1/reportpgpool` | a Pgpool-II report |

To point existing cron jobs at pgscope, set `--base-url=https://YOUR-PGSCOPE/api/v1` and use the API key from your pgscope profile. The validation matches the pgdash CLI: the API key is exactly 22 Latin letters and digits, the server name is 1 to 64 characters of Latin letters, digits and `_ . -`.

> [!WARNING]
> Always pass `--base-url`. Without it the pgdash CLI sends the report to its default address — the pgDash cloud service, not your pgscope.

pgscope is a standalone product with the same feature set as pgDash, but it is not pgDash and is not connected to its cloud service.

## Self-hosted only {#self-hosted}

- pgscope is a single executable with the web UI built in. All data is stored in the PostgreSQL database you point it at.
- There is no telemetry, no license or update checks, no phoning home. The web UI loads nothing from the internet: scripts and styles are embedded in the executable, and system fonts are used.
- Apart from its storage database connection, pgscope opens outbound connections in two cases only:
  - **notifications**: the configured SMTP server, webhook URLs, and the external Slack, PagerDuty (`events.pagerduty.com`), VictorOps and xMatters services if you created such channels;
  - **AI chat**: requests to the Anthropic cloud API if `PGSCOPE_AI_KEY` is set.
- In an isolated network use email through an internal SMTP server and webhooks to internal addresses, and leave AI chat disabled (it is disabled by default). More: [Email (SMTP)](config.md#smtp), [AI chat](config.md#ai), [Webhook format](notifications.md#webhook).
- Docker images and the binary are built on a machine with internet access and moved into the network as files (see [Installing in an isolated network](install.md#air-gapped)).

## Components {#components}

| Component | What it is | Where it runs |
|---|---|---|
| pgscope server | the `pgscope` executable (or the `pgscope:latest` image): report ingestion API, web UI, alerts, diagnostics | any Linux host or container, port 8080 by default |
| Storage database | a regular PostgreSQL database; pgscope creates its tables itself on start | a separate PostgreSQL server or the `postgres:17-alpine` container from `deploy/docker-compose.yml` |
| pgmetrics | the statistics collector | on the database host or next to it; included in the agent image |
| pgdash CLI | sends reports to pgscope | wherever pgmetrics runs |
| pgscope-agent | the agent for databases in Docker and Docker Swarm (the `pgscope-agent:latest` image with pgmetrics inside) | on every Docker host or as a global Swarm service |
| Reverse proxy | nginx, Caddy, etc. — HTTPS in front of pgscope (pgscope has no TLS of its own) | in front of the pgscope server |

## Features {#features}

- **Server fleet**: a server list with a short summary and the [Inspector](fleet.md#inspector) — fleet-wide tables of servers, databases, replication, transaction ages, disks and WAL.
- **Server pages**: [overview](monitoring.md#overview), [diagnostics](monitoring.md#diagnostics) (issues and a configuration check), [queries](activity.md#queries) with `auto_explain` plans, [backends](activity.md#backends), [locks](activity.md#locks), [databases](objects.md#databases), [tables](objects.md#tables), [indexes](objects.md#indexes) and [index management](objects.md#index-management), [replication](server.md#replication), [WAL](server.md#wal), [vacuum](server.md#vacuum), [configuration](server.md#config), [system](server.md#system), [logs](server.md#logs), [PgBouncer](integrations.md#pgbouncer) and [Pgpool](integrations.md#pgpool).
- **Looking into the past**: any stored report can be opened instead of the latest one to see the queries, locks and backends at the time of an incident.
- **Alerts**: [rules](alerts.md) on server, database, table, tablespace and query metrics with **Warning** and **Critical** severities; [change alerts](change-alerts.md) between consecutive reports; [notification channels](notifications.md) — email, Slack, PagerDuty, VictorOps, xMatters, webhook.
- **Team**: access to a server by email invitation (see [Team, profile and account](teams.md)).
- **AI chat** about the latest report of a server (disabled by default, uses a cloud API, see [AI chat](monitoring.md#ai-chat)).
- **Russian and English UI**: the language is chosen in the profile, and the notification language separately for each channel.

## Limitations {#limitations}

- Data granularity equals the report interval (usually 5 minutes). This is not real-time monitoring: events between reports are not visible.
- Alert rules are evaluated only when a new report arrives. If collection stops, you get no alert about it. Watch the report freshness indicator in the UI: it turns yellow when the latest report is older than 15 minutes.
- pgscope does not do TLS itself: HTTPS is provided by a reverse proxy (see [Reverse proxy and HTTPS](install.md#reverse-proxy)).
- It is designed as one instance per storage database: the report rate limit is kept in process memory.
- Sign-up is open to anyone who can open the web UI. Every new user gets their own API key and sees only their own servers and the servers shared with them. Sign-up cannot be turned off by a setting, so restrict network access to pgscope.
- There is no LDAP or SSO sign-in. The only roles are server owner and team member.
- The Slack, PagerDuty, VictorOps and xMatters channels and AI chat need internet access.

## Glossary {#glossary}

| Term | Meaning |
|---|---|
| Report | a JSON snapshot of a server's state, collected by pgmetrics in one run and sent to pgscope |
| Server | the object in pgscope that reports belong to: a PostgreSQL or Pgpool-II instance. Created automatically by the first report under a new name; the name is unique within an account and type (PostgreSQL or Pgpool) |
| PgBouncer instance | a source of PgBouncer reports attached to a PostgreSQL server under its own name |
| API key | the 22-character key from the profile that the pgdash CLI and the agent sign reports with. All servers sent with a key belong to its owner |
| Owner | the user whose API key the server's reports are sent with. Can share the server and delete it |
| Team member | a user the owner shared a server with. Can see all data of the server and change alert rules and channels, but cannot delete the server or share it further. An account created from an invitation has no API key |
| Agent | pgscope-agent: a process on a Docker host that finds database containers and sends their reports |
| Agent target | a PostgreSQL or PgBouncer container the agent found by its label |
| Alert rule | a "metric above or below a threshold" condition with a **Warning** or **Critical** severity and an object filter |
| Alert | a triggered rule for a specific object (database, table, query, etc.) |
| Change alert | a difference between two consecutive reports: a new table, a changed setting, a server restart and so on |
| Notification channel | where alerts or changes are sent: email, Slack, PagerDuty, VictorOps, xMatters, webhook. Each channel has its own language |
| Diagnostics | automatic checks of the latest report: server issues and a configuration check |
| Inspector | fleet-wide tables across all servers of the account |
| Storage database | the PostgreSQL database where pgscope keeps users, reports, time series and settings (`PGSCOPE_DB`) |
| Base URL | the public address of pgscope (`PGSCOPE_BASE_URL`) used to build links in alerts and invitations |

## Documentation map {#docs-map}

The documentation opens from the **Documentation** link at the bottom of the sidebar or at `#/docs` on your pgscope, also without signing in.

| Section | Pages |
|---|---|
| Getting started | [Quick start](quickstart.md) · [Installation and upgrades](install.md) · [Configuring pgscope](config.md) |
| Collecting data | [Preparing PostgreSQL](postgres.md) · [Sending reports](collect.md) · [Docker and Docker Swarm](docker.md) |
| Using the interface | [The interface](ui.md) · [Servers and Inspector](fleet.md) · [Overview, diagnostics and AI chat](monitoring.md) · [Queries, backends and locks](activity.md) · [Database objects](objects.md) · [Replication, WAL, vacuum and system](server.md) · [Cloud metrics, PgBouncer and Pgpool](integrations.md) |
| Alerts | [Alert rules](alerts.md) · [Notification channels](notifications.md) · [Change alerts](change-alerts.md) |
| Administration | [Team, profile and account](teams.md) · [Data storage](data.md) · [Security](security.md) |
| Reference | [Checks reference](checks.md) · [API](api.md) · [Common scenarios](scenarios.md) · [Troubleshooting and FAQ](troubleshooting.md) |

If you are new to pgscope, start with the [quick start](quickstart.md).
