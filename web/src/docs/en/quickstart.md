# Quick start

The shortest path from zero to charts: start pgscope, sign up, prepare a monitoring role, send the first report and schedule reporting. It takes about 15 minutes. Details for every step are on the linked pages.

## What you need {#prerequisites}

- A Linux host for pgscope with Docker and Docker Compose — or Go and Node.js to build the binary plus any reachable PostgreSQL server to store the data (version requirements are in [Requirements](install.md#requirements)).
- A monitored PostgreSQL server where you can create a role.
- The [pgmetrics](https://pgmetrics.io) and [pgdash CLI](https://github.com/rapidloop/pgdash) tools on the host the reports will be sent from. The database host itself is best: only there are system metrics and PostgreSQL log data collected.
- Network access from that host to pgscope over HTTP(S), and from pgmetrics to PostgreSQL.

> [!TIP]
> If your databases run in Docker or Docker Swarm containers, use pgscope-agent instead of steps 4–7: it finds the containers and sends the reports by itself. See [Docker and Docker Swarm](docker.md).

## Step 1. Start pgscope {#start}

Pick one of two options.

### Option A: Docker Compose {#start-compose}

The repository ships a ready `deploy/docker-compose.yml`: it runs pgscope and a `postgres:17-alpine` storage database with the data in the `pgscope-data` volume. Run in the pgscope source directory:

```bash
docker build -t pgscope:latest .
cd deploy
printf 'PGSCOPE_DB_PASSWORD=%s\nPGSCOPE_BASE_URL=%s\n' 'strong-password' 'http://monitor.example.com:8080' > .env
docker compose up -d
docker compose logs pgscope
```

- `PGSCOPE_DB_PASSWORD` is the password of the `pgscope` user in the storage database; it is required.
- `PGSCOPE_BASE_URL` is the address browsers and the pgdash CLI will use to reach pgscope. It is filled into the ready-made commands in the UI and into links in alerts.
- The host port is 8080; set a different one with `PGSCOPE_PORT` in `.env`.

The log should contain a line like `pgscope listening on :8080 (public URL http://monitor.example.com:8080)`.

### Option B: the binary and an existing PostgreSQL {#start-binary}

Build pgscope (Go and Node.js are needed, see [Building from source](install.md#build)):

```bash
cd web && npm ci && npm run build && cd .. && go build -o pgscope .
```

Create a role and a storage database on any reachable PostgreSQL server:

```bash
sudo -u postgres createuser --pwprompt pgscope
sudo -u postgres createdb -O pgscope pgscope
```

Start pgscope. It creates its tables on the first start. The password is easier to pass in the `PGPASSWORD` variable: then special characters in it need no URL encoding.

```bash
PGSCOPE_DB='postgres://pgscope@dbhost:5432/pgscope' \
PGPASSWORD='strong-password' \
PGSCOPE_BASE_URL='http://monitor.example.com:8080' \
./pgscope
```

For permanent operation, run pgscope as a systemd service behind an HTTPS proxy: [Installation and upgrades](install.md).

## Step 2. Sign up {#signup}

1. Open the pgscope address in a browser, for example `http://monitor.example.com:8080`.
2. On the sign-in page click **Sign up**.
3. Enter an email and a password and click **Create account**. The password must be at least 8 characters and at most 72 bytes in UTF-8: a Latin letter takes one byte, a Cyrillic one takes two.

You are signed in right away. The session lasts 30 days.

> [!WARNING]
> By default (`PGSCOPE_SIGNUP=first`) only the first user can sign up: they become the owner, and the **Sign up** link disappears afterwards. Sign up right after starting pgscope, before others learn its address. Give colleagues access with invitations (see [Inviting by email](teams.md#invite)); the other modes are described in [PGSCOPE_SIGNUP](config.md#pgscope-signup).

## Step 3. Copy the API key {#api-key}

Open **Profile** — the link with your email at the bottom of the sidebar. In the **API key** card click the copy button next to the key. Reports are signed with this key: all servers sent with it belong to your account.

The **Sending reports** card on the same page has ready-made commands with your key and address filled in. While you have no servers, the same command is also shown on the **Servers** page.

## Step 4. Prepare a monitoring role {#monitoring-role}

On the monitored PostgreSQL server create a role that can only read statistics:

```sql
CREATE ROLE pgmon LOGIN PASSWORD 'strong-password';
GRANT pg_monitor TO pgmon;
```

Allow this role to connect in `pg_hba.conf` from the host where pgmetrics will run, and store the password in the `~/.pgpass` of the user that will run the collection:

```bash
echo 'dbhost:5432:*:pgmon:strong-password' >> ~/.pgpass
chmod 600 ~/.pgpass
```

The **Queries** page needs the `pg_stat_statements` extension; execution plans need `auto_explain`. This can wait: see [Preparing PostgreSQL](postgres.md).

## Step 5. Send the first report {#first-report}

Install pgmetrics and the pgdash CLI (prebuilt releases are on the project pages, pgmetrics with pgscope's fixes is described in [pgmetrics built by pgscope](collect.md#pgmetrics-build); for isolated networks see [Installing in an isolated network](install.md#air-gapped)). Then run, with your own values:

```bash
pgmetrics --no-password -f json -h dbhost -U pgmon db1 db2 \
  | pgdash -a YOUR_API_KEY --base-url=http://monitor.example.com:8080/api/v1 report prod-db-1
```

- `db1 db2` are the databases you want to see in pgscope; to collect all user databases pass `--all-dbs`.
- `prod-db-1` is the server name in pgscope: 1 to 64 characters of Latin letters, digits and `_ . -`. The server is created automatically by the first report under a new name. The host name is a convenient choice.
- `--base-url` is mandatory and must end with `/api/v1`. Without it the pgdash CLI sends the report to the pgDash cloud.
- `--no-password` keeps pgmetrics from hanging on a password prompt: the password comes from `~/.pgpass`.

If pgscope rejected the report, the status codes are explained in [Server responses](collect.md#responses).

## Step 6. Look at the data {#see-data}

Reload the **Servers** page in pgscope: a `prod-db-1` card appears with the PostgreSQL version and a short summary. Open it:

- [**Overview**](monitoring.md#overview) — key indicators and charts;
- [**Diagnostics**](monitoring.md#diagnostics) — detected issues and the configuration check; it works from the first report;
- the other sections are in the server's sidebar.

Charts need several reports: after the first one you see current values, and the lines appear with the next ones.

## Step 7. Schedule reporting {#schedule}

Send a report every 5 minutes, for example with cron for the user whose `~/.pgpass` is set up:

```bash
crontab -e
```

```text
*/5 * * * * pgmetrics -w -f json -h dbhost -U pgmon db1 db2 | pgdash -a YOUR_API_KEY --base-url=http://monitor.example.com:8080/api/v1 report prod-db-1
```

pgscope accepts reports of one server at most once every 60 seconds (`PGSCOPE_MIN_REPORT_INTERVAL`); more frequent ones are rejected with status 429. Do not collect more often than once a minute. Other ways to automate, PgBouncer and Pgpool are covered in [Sending reports](collect.md).

## If something goes wrong {#problems}

| Symptom | What to check |
|---|---|
| The pgscope page does not open | `docker compose ps` and `docker compose logs pgscope` (or the output of `./pgscope`); a `schema setup: …` error means pgscope could not connect to the storage database or create its tables there |
| There is no **Sign up** link on the sign-in page | the database already has an account (by default only the first user can sign up) or `PGSCOPE_SIGNUP=closed` is set. Ask the owner to invite you, or see [PGSCOPE_SIGNUP](config.md#pgscope-signup) |
| After signing in, the sign-in page is shown again | `PGSCOPE_BASE_URL` starts with `https://` but you opened pgscope over `http://`: the browser does not store the secure cookie. Open pgscope over HTTPS or fix the address (see [Session cookie and the Secure flag](install.md#secure-cookie)) |
| The server did not appear after sending | the pgscope status code ([Server responses](collect.md#responses)), the address ending in `/api/v1`, the key from the profile of this same pgscope |
| Status 429 | reports of one server arrive more often than once every 60 seconds |
| Status 413 | the report is larger than the `PGSCOPE_MAX_REPORT_MB` limit (256 MiB by default) or the body size limit of the reverse proxy, see [PGSCOPE_MAX_REPORT_MB](config.md#pgscope-max-report-mb) |
| The **Queries** page is empty | `pg_stat_statements` is not installed or not readable, see [Preparing PostgreSQL](postgres.md) |

Other cases are in [Troubleshooting and FAQ](troubleshooting.md).

## Next steps {#next-steps}

- Put pgscope behind an HTTPS proxy and run it as a service: [Installation and upgrades](install.md), [Reverse proxy and HTTPS](install.md#reverse-proxy).
- Configure email for alerts and invitations: [Email (SMTP)](config.md#smtp).
- Enable query statistics and execution plans: [Preparing PostgreSQL](postgres.md).
- Create alert rules and notification channels: [Alert rules](alerts.md), [Notification channels](notifications.md).
- Share access with colleagues: [Team, profile and account](teams.md).
- Connect databases running in Docker: [Docker and Docker Swarm](docker.md).
