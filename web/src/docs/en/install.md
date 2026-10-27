# Installation and upgrades

This page covers everything a production pgscope installation needs: requirements, building, Docker images and Docker Compose, the storage database, running under systemd, HTTPS through a reverse proxy, installing in an isolated network, upgrades, backups and uninstalling. If you just want to try pgscope, start with the [quick start](quickstart.md). All environment variables are described in [Configuring pgscope](config.md).

## Requirements {#requirements}

| What | Requirement |
|---|---|
| Building the server | Go 1.26 or newer (`go 1.26.0` in `go.mod`; the image is built on `golang:1.27-alpine`) |
| Building the web UI | Node.js 20.19+ or 22.12+ and npm (required by Vite 8; the image is built on `node:22-alpine`) |
| Running | Linux; pgscope is a single executable with no external dependencies, the web UI is embedded in it |
| Storage database | PostgreSQL. pgscope does not check the version and declares no minimum; the schema only uses long-available features (`jsonb`, a BRIN index, `ON CONFLICT`, `ADD COLUMN IF NOT EXISTS`). Individual versions have not been tested for compatibility: use a community-supported version; the ready compose file uses `postgres:17-alpine` |
| Docker (optional) | Docker Engine with the Docker Compose v2 plugin (`docker compose`) |
| Network | inbound HTTP(S) to pgscope from browsers, hosts with the pgdash CLI and agents; outbound to the storage database; optionally to the SMTP server and webhook URLs |

The load on pgscope and the size of the storage database depend on the number of servers, the number of objects in them (tables, indexes, queries) and the report interval. While ingesting, pgscope holds the whole report in memory, so reports from servers with tens of thousands of tables need noticeably more memory. How to estimate and reduce the data volume is described in [Data storage](data.md).

## Building from source {#build}

```bash
cd web
npm ci
npm run build        # builds the web UI into web/dist
cd ..
go build -o pgscope .
```

The web UI is built first: the `web/dist` directory is embedded into the executable at compile time (`//go:embed`), and without it `go build` fails.

To get a statically linked binary for another Linux host (this is how the Docker image is built):

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o pgscope .
```

For ARM servers use `GOARCH=arm64`. You can check the build with the tests: `go test ./...`.

The Docker agent is built from the same repository: `go build -o pgscope-agent ./cmd/pgscope-agent` (it is usually used as an image, see below).

## Docker images {#docker-images}

The images are built from the repository root on a machine with internet access:

```bash
docker build -t pgscope:2026.10.26 -t pgscope:latest .
docker build -f Dockerfile.agent --build-arg VERSION=2026.10.26 -t pgscope-agent:2026.10.26 -t pgscope-agent:latest .
```

| Image | Contents |
|---|---|
| `pgscope` (`Dockerfile`) | a statically linked `pgscope` on `alpine:3.22` with root certificates. Runs as the unprivileged `pgscope` user (uid 10001), listens on port 8080. Configured with environment variables only |
| `pgscope-agent` (`Dockerfile.agent`) | `pgscope-agent` and pgmetrics built from source at exactly the version pgscope uses (taken from `go.mod`). Runs as root because it talks to `/var/run/docker.sock`. The `VERSION` build argument is the agent version shown on the **Agents** page |

Tag images with a version, not only `latest`: then upgrading and rolling back is just a tag change. In `deploy/docker-compose.yml` the tag is set with `PGSCOPE_IMAGE`, in the agent compose files with `PGSCOPE_AGENT_IMAGE`.

Deploying the agent is described in [Docker and Docker Swarm](docker.md).

## Running with Docker Compose {#compose}

The `deploy/docker-compose.yml` file runs two services:

- `db` — `postgres:17-alpine`, database and user `pgscope`, data in the `pgscope-data` volume, readiness checked with `pg_isready`;
- `pgscope` — the `${PGSCOPE_IMAGE:-pgscope:latest}` image, starts once the database is ready, publishes port `${PGSCOPE_PORT:-8080}`. It connects with `postgres://pgscope@db:5432/pgscope?sslmode=disable`; the password reaches the driver through `PGPASSWORD`, so special characters in it need no escaping.

Settings go into `deploy/.env`:

```bash
PGSCOPE_DB_PASSWORD=strong-password
PGSCOPE_BASE_URL=https://pgscope.example.com
PGSCOPE_PORT=127.0.0.1:8080
PGSCOPE_SMTP_ADDR=mail.example.local:25
PGSCOPE_SMTP_FROM=pgscope@example.com
```

`PGSCOPE_PORT=127.0.0.1:8080` publishes the port on the loopback interface only — use it when the reverse proxy runs on the same host. The other variables (`PGSCOPE_MIN_REPORT_INTERVAL`, retention, SMTP, AI) are passed from `.env` into the container with the same defaults as pgscope itself (see [Docker Compose variables](config.md#compose-vars)).

```bash
cd deploy
docker compose up -d
docker compose ps
docker compose logs -f pgscope
```

> [!WARNING]
> `PGSCOPE_DB_PASSWORD` is applied to the database only on the first start, while the `pgscope-data` volume is still empty: this is how the official PostgreSQL image works. If you later change the password only in `.env`, pgscope can no longer connect. First change the password in the database itself (`docker compose exec db psql -U pgscope -d pgscope -c "ALTER ROLE pgscope PASSWORD '…'"`), then in `.env`, and run `docker compose up -d`.

`docker compose down` stops the services and keeps the data; `docker compose down -v` also deletes the data volume.

## Storage database {#storage-db}

pgscope keeps everything — users, sessions, reports, time series, rules and channels — in one PostgreSQL database set by `PGSCOPE_DB`. It can live on one of the monitored servers, but a separate server is better: otherwise the report write load shows up in its own charts, and a failure of that server also takes monitoring down.

### Creating the database and role {#storage-create}

```bash
sudo -u postgres psql -c "CREATE ROLE pgscope LOGIN PASSWORD 'strong-password'"
sudo -u postgres createdb -O pgscope pgscope
```

Required privileges:

- On every start pgscope runs `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in the default schema (usually `public`). The role needs the `CREATE` privilege in that schema, and the pgscope tables must belong to it: `ALTER TABLE` is allowed only for the table owner. The simplest way is to make the role the database owner, as above (in PostgreSQL 15 and newer only the database owner can create objects in `public` by default).
- Superuser privileges and extensions are not needed.
- Always run pgscope as the same role. If the tables were created by another role, startup fails with `schema setup: …`.

The connection string is a URL or a libpq-style `key=value` string. The password can go into the URL, `PGPASSWORD` or `~/.pgpass`; the connection pool size is set with the `pool_max_conns` parameter (see [PGSCOPE_DB](config.md#pgscope-db)).

### Schema and migrations {#schema}

There is no separate migration tool and no version table. The schema is one script of idempotent statements (`IF NOT EXISTS`) that runs on every start:

- on an empty database it creates all tables and indexes;
- after a pgscope upgrade it adds new tables, columns and indexes; existing data is not touched;
- on an error pgscope logs `schema setup: …` and exits.

| Table | Contents |
|---|---|
| `users`, `sessions` | accounts (bcrypt password hashes, API keys, language) and browser sessions |
| `servers`, `shares`, `invites` | servers, team sharing, unused invitations |
| `reports` | full pgmetrics reports, compressed |
| `metrics` | time series: one row per object (server, database, table, index, query, etc.) per report |
| `alert_rules`, `change_rules`, `notifiers` | alert rules, change alert settings, notification channels |
| `alert_state`, `events` | currently triggered alerts and the history of alerts and changes |
| `agents` | the latest pgscope-agent heartbeats and the state of their targets |

The largest tables are `metrics` and `reports`. Old data is deleted automatically every hour (see [Data storage](data.md#retention)). Do not change the schema by hand.

## Running as a systemd service {#systemd}

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pgscope
sudo install -m 755 pgscope /usr/local/bin/pgscope
sudo install -d -m 750 -o root -g pgscope /etc/pgscope
sudo install -m 640 -o root -g pgscope /dev/null /etc/pgscope/pgscope.env
sudoedit /etc/pgscope/pgscope.env
```

The `/etc/pgscope/pgscope.env` file (passwords stay out of the unit file and the `systemctl show` output):

```bash
PGSCOPE_DB=postgres://pgscope@dbhost:5432/pgscope?sslmode=verify-full&sslrootcert=/etc/pgscope/db-ca.crt
PGPASSWORD=strong-password
PGSCOPE_BASE_URL=https://pgscope.example.com
PGSCOPE_LISTEN=127.0.0.1:8080
PGSCOPE_SMTP_ADDR=mail.example.local:25
PGSCOPE_SMTP_FROM=pgscope@example.com
```

The `/etc/systemd/system/pgscope.service` file:

```ini
[Unit]
Description=pgscope PostgreSQL monitoring
Wants=network-online.target
After=network-online.target

[Service]
User=pgscope
Group=pgscope
EnvironmentFile=/etc/pgscope/pgscope.env
ExecStart=/usr/local/bin/pgscope
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pgscope
journalctl -u pgscope -f
```

- `sslrootcert` is the root certificate of the authority that signed the storage database certificate. If it is in the system trust store, use `sslrootcert=system`; if the database accepts connections without TLS, use `sslmode=disable` (see [PGSCOPE_DB](config.md#pgscope-db)).
- pgscope writes no files to disk, so `ProtectSystem=strict` does not get in its way. Logs go to stderr and end up in the systemd journal.
- With `ProtectHome=true` the `/home` directories are inaccessible, so a `~/.pgpass` file cannot be read. Pass the password in `PGPASSWORD`, as in the example, or put a password file into `/etc/pgscope` and point `PGPASSFILE` at it.
- If the storage database runs on the same host, add `After=postgresql.service` to `[Unit]`. If the database is unreachable at startup, pgscope exits and `Restart=always` restarts it after 5 seconds.
- pgscope does not handle stop signals specially: the process exits immediately. A report that was being stored at that moment is not saved (the transaction is rolled back). pgscope-agent retries a failed upload once after 5 seconds.

## Reverse proxy and HTTPS {#reverse-proxy}

pgscope serves plain HTTP only and has no built-in TLS. Passwords, session cookies and API keys (they are in the body of every report) travel over the network, so a production installation puts a reverse proxy with HTTPS in front of pgscope: nginx, Caddy, HAProxy or a load balancer. Proxy requirements:

1. **A dedicated host name at the root path.** The web UI loads `/assets/…` and calls `/api/…` with absolute paths, so serving pgscope under a subdirectory (`https://example.com/pgscope/`) is not supported.
2. **Request body size.** pgscope accepts reports of up to 256 MiB (up to 2 GiB after gzip decompression); it rejects a larger report with status 400. nginx limits bodies to 1 MiB by default, and large reports get a 413 error from the proxy. Set `client_max_body_size 256m`.
3. **Timeouts.** Storing a large report and an AI chat answer can take more than a minute. Increase the response read timeout (`proxy_read_timeout` in nginx).
4. **The `X-Forwarded-Proto: https` header**, so the session cookie gets the Secure flag (see [below](#secure-cookie)).
5. **`PGSCOPE_BASE_URL` with `https://`** — the public address users see. Links in alerts and invitations and the ready-made commands in the UI are built from it.
6. **pgscope listens on the loopback interface only**: `PGSCOPE_LISTEN=127.0.0.1:8080` for the binary or `PGSCOPE_PORT=127.0.0.1:8080` for Docker Compose.

### nginx example {#nginx}

```nginx
server {
    listen 443 ssl;
    server_name pgscope.example.com;

    ssl_certificate     /etc/nginx/tls/pgscope.example.com.crt;
    ssl_certificate_key /etc/nginx/tls/pgscope.example.com.key;

    # pgmetrics reports can be large; pgscope accepts up to 256 MiB
    client_max_body_size 256m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

server {
    listen 80;
    server_name pgscope.example.com;
    return 301 https://$host$request_uri;
}
```

Once the proxy is configured:

- set `PGSCOPE_BASE_URL` to `https://pgscope.example.com` and restart pgscope;
- use `--base-url=https://pgscope.example.com/api/v1` in pgdash CLI jobs and `PGSCOPE_URL=https://pgscope.example.com` for agents. Use `https://` directly: an HTTP-to-HTTPS redirect does not work for the POST requests that carry reports;
- if the certificate is issued by an internal certificate authority, clients must trust it: add the root certificate to the system trust store on hosts with the pgdash CLI, and pass it to the agent through `SSL_CERT_FILE` (see [Docker and Docker Swarm](docker.md)).

> [!TIP]
> Sign-up in pgscope is open to anyone who can open the web UI, and no setting turns it off. Once the owner accounts exist, you can close sign-up at the proxy, for example `location = /api/signup { return 403; }`. Team invitations keep working: they create accounts through a different endpoint (`/api/invite/…`).

### Session cookie and the Secure flag {#secure-cookie}

After sign-in, sign-up or accepting an invitation pgscope sets the `pgscope_session` cookie with `HttpOnly`, `SameSite=Lax`, `Path=/` and a 30-day lifetime. The `Secure` flag (send over HTTPS only) is set when at least one condition holds:

- the request came with the `X-Forwarded-Proto: https` header;
- `PGSCOPE_BASE_URL` starts with `https://`.

What follows from this:

| Situation | Result |
|---|---|
| HTTPS proxy, `PGSCOPE_BASE_URL=https://…` | the cookie always has `Secure`, even if the proxy does not send `X-Forwarded-Proto` |
| HTTPS proxy sends `X-Forwarded-Proto: https`, but `PGSCOPE_BASE_URL` starts with `http://` | the cookie has `Secure` and sign-in works, but links in alerts, invitations and UI commands point to `http://`. Fix `PGSCOPE_BASE_URL` |
| HTTPS proxy without `X-Forwarded-Proto`, `PGSCOPE_BASE_URL=http://…` | the cookie has no `Secure`: sign-in works, but the browser may also send the cookie over plain HTTP |
| `PGSCOPE_BASE_URL=https://…`, but pgscope is opened directly at `http://host:8080` | the browser does not store a `Secure` cookie received over HTTP: after signing in, the sign-in page is shown again. Open pgscope through its HTTPS address. Some browsers make an exception for `http://localhost` and do store the cookie |
| No proxy, `PGSCOPE_BASE_URL=http://…` (trial installation) | the cookie has no `Secure`, everything works over HTTP |

pgscope accepts the `X-Forwarded-Proto` header from any client. This is safe: the header only affects the `Secure` flag of the cookie in the response to that same client.

## Installing in an isolated network {#air-gapped}

pgscope runs without internet access. Internet is needed only to build it: for npm packages, Go modules (including the pgmetrics sources for the agent image) and the Docker base images (`node:22-alpine`, `golang:1.27-alpine`, `alpine:3.22`, plus `postgres:17-alpine` for the compose file). Build on a machine with internet access and move the result as files.

**Docker images:**

```bash
# on the machine with internet access, in the repository root
docker build -t pgscope:2026.10.26 .
docker build -f Dockerfile.agent --build-arg VERSION=2026.10.26 -t pgscope-agent:2026.10.26 .
docker pull postgres:17-alpine
docker save pgscope:2026.10.26 postgres:17-alpine | gzip > pgscope-images.tar.gz
docker save pgscope-agent:2026.10.26 | gzip > pgscope-agent.tar.gz

# inside the isolated network
docker load -i pgscope-images.tar.gz          # on the pgscope host
docker load -i pgscope-agent.tar.gz           # on every Docker host and Swarm node
```

Instead of moving files, you can push the images to an internal registry. Set the tag in `deploy/.env`: `PGSCOPE_IMAGE=pgscope:2026.10.26`.

**Binaries.** Build a static `pgscope` (see [Building from source](#build)) or extract the ready files from the images. The agent image contains pgmetrics, which can also be used in cron jobs together with the pgdash CLI:

```bash
docker create --name pgscope-tmp pgscope:2026.10.26
docker cp pgscope-tmp:/usr/local/bin/pgscope ./pgscope
docker rm pgscope-tmp

docker create --name agent-tmp pgscope-agent:2026.10.26
docker cp agent-tmp:/usr/local/bin/pgmetrics ./pgmetrics
docker rm agent-tmp
```

Both files are statically linked (`CGO_ENABLED=0`) and run on any Linux with the same architecture as the build machine. For another architecture build the images with `docker buildx build --platform …` or the binary with the matching `GOARCH`.

**The pgdash CLI** is not part of the images: download a prebuilt release from the project page on the machine with internet access and move it along with the other files.

**Features that need the internet** should not be used in an isolated network: the Slack, PagerDuty, VictorOps and xMatters channels and AI chat. Use email through an internal SMTP server ([Email (SMTP)](config.md#smtp)) and webhooks to internal addresses ([Webhook format](notifications.md#webhook)) instead. AI chat stays disabled as long as `PGSCOPE_AI_KEY` is not set.

## Upgrades {#upgrade}

Upgrade procedure:

1. Back up the storage database (see [below](#backup)).
2. Build or load the new pgscope version.
3. Restart the pgscope server:
   - Docker Compose: put the new tag into `PGSCOPE_IMAGE` (or rebuild `pgscope:latest`) and run `docker compose up -d`;
   - systemd: replace `/usr/local/bin/pgscope` and run `sudo systemctl restart pgscope`.
4. Check the log. On startup pgscope adds new tables, columns and indexes to the schema by itself.
5. After the server, upgrade the agents: rebuild the `pgscope-agent` image from the same source code (it contains pgmetrics at the same version pgscope uses) and restart them (`docker compose up -d` or `docker service update --image …`).

The server is upgraded first because new agents may rely on features of the new server version (this is a recommendation, not a tested compatibility guarantee). pgscope accepts reports from any pgmetrics version as long as they carry the collection time (`metadata.at`): it skips unknown fields and treats missing ones as empty. So pgdash CLI cron jobs and older agents keep sending reports to the upgraded server. Data that only newer pgmetrics versions collect appears once pgmetrics is upgraded on the hosts.

What happens during an upgrade:

- while pgscope restarts, reports are not accepted. pgscope-agent retries an upload once after 5 seconds; if the server is still down, the report is skipped and the charts get a gap;
- the report rate limits are kept in memory and reset on restart;
- user sessions are stored in the database, so nobody has to sign in again.

**Rolling back.** Schema changes only add objects, so an older version usually starts on an upgraded database. However, rollback has not been tested, and the reliable path is to restore the previous image or binary together with the backup taken before the upgrade.

**Upgrading PostgreSQL inside Docker Compose.** A data directory cannot be opened by a different PostgreSQL major version: if you simply change the `postgres:17-alpine` tag to the next version, the database will not start. Move the data with `pg_dump` and a restore into a new volume, or with `pg_upgrade`.

## Backup and restore {#backup}

All pgscope state lives in the storage database; the executable and the images hold no state. Back it up like any PostgreSQL database: with `pg_dump` logical dumps or physical tools (`pg_basebackup`, pgBackRest and so on).

> [!WARNING]
> A backup contains API keys (in plain text), session and invitation tokens, password hashes, webhook URLs and integration keys of notification channels, and query texts from the reports. Protect backups as carefully as the database itself.

Logical dump, binary and systemd:

```bash
pg_dump -Fc -h dbhost -U pgscope -d pgscope -f pgscope-$(date +%F).dump
```

Docker Compose (in the `deploy` directory):

```bash
docker compose exec -T db pg_dump -U pgscope -Fc pgscope > pgscope-$(date +%F).dump
```

A settings-only dump — accounts, servers, sharing, rules and channels — without the bulky history:

```bash
pg_dump -Fc -h dbhost -U pgscope -d pgscope \
  --exclude-table-data=reports --exclude-table-data=metrics --exclude-table-data=events \
  -f pgscope-settings-$(date +%F).dump
```

After restoring such a dump, the server list is kept together with the summary of the latest report, but server pages stay empty until new reports arrive, and the charts start at the moment of the restore.

Restore, binary and systemd (`dropdb` and `createdb` run as a superuser or a role with `CREATEDB`):

```bash
sudo systemctl stop pgscope
dropdb -h dbhost -U postgres pgscope
createdb -h dbhost -U postgres -O pgscope pgscope
pg_restore -h dbhost -U pgscope -d pgscope --no-owner pgscope-2026-10-26.dump
sudo systemctl start pgscope
```

Restore, Docker Compose:

```bash
docker compose stop pgscope
docker compose exec -T db dropdb -U pgscope pgscope
docker compose exec -T db createdb -U pgscope pgscope
docker compose exec -T db pg_restore -U pgscope -d pgscope --no-owner < pgscope-2026-10-26.dump
docker compose start pgscope
```

## Uninstalling {#uninstall}

1. **Stop collection.** Remove the pgdash CLI cron jobs. Stop the agents: `docker compose down` in the directory with their compose file on every host; in Swarm — `docker stack rm pgscope-agent` and `docker secret rm pgscope_api_key pgscope_monitor_password`.
2. **Stop pgscope.**
   - Docker Compose: `docker compose down` keeps the data volume, `docker compose down -v` deletes it with all data.
   - systemd: `sudo systemctl disable --now pgscope`, then delete `/etc/systemd/system/pgscope.service`, `/usr/local/bin/pgscope`, `/etc/pgscope` and the `pgscope` user.
3. **Drop the storage database** if it is on a separate PostgreSQL server: `dropdb pgscope` and `DROP ROLE pgscope;`.
4. **Remove the monitoring role** on the monitored servers: `DROP ROLE pgmon;` (or `pgscope_monitor` for the agent). If `pg_stat_statements` and `auto_explain` were enabled only for pgscope, remove them from `shared_preload_libraries` (a PostgreSQL restart is needed) and run `DROP EXTENSION pg_stat_statements;` in the databases.
5. **Remove the images**: `docker image rm pgscope:2026.10.26 pgscope-agent:2026.10.26`.

To remove a single server from pgscope rather than the whole installation, use that server's **Team & settings** section (see [Team, profile and account](teams.md#server-settings)).
