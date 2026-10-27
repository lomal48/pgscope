# Sending reports

Data reaches pgscope as reports: pgmetrics collects a snapshot of the server's state as JSON, and the pgdash CLI sends it to pgscope. This page covers installing both tools, their flags, regular sending with cron and systemd, collecting from many servers, the log and cloud metrics, PgBouncer and Pgpool-II reports, rate and size limits, and every server response. What to enable in PostgreSQL itself is described in [Preparing PostgreSQL](postgres.md). Databases in containers are easier to collect with the agent, see [Docker and Docker Swarm](docker.md).

## How collection works {#how-it-works}

```text
PostgreSQL ──► pgmetrics ──(JSON)──► pgdash CLI ──(HTTP POST, gzip)──► pgscope
PgBouncer ───┘                                    /api/v1/report
Pgpool-II ───┘                                    /api/v1/reportpgbouncer
                                                  /api/v1/reportpgpool
```

- **pgmetrics** collects hundreds of server metrics in a single run and prints them as JSON. Each report is a snapshot taken at collection time.
- **The pgdash CLI** sends this JSON to pgscope. pgscope implements the same `/api/v1/report`, `/api/v1/reportpgbouncer` and `/api/v1/reportpgpool` endpoints as pgDash, so existing cron jobs only need the pgscope API key in place of the old one and `--base-url`.
- **pgscope** stores the report compressed and extracts time series and a summary for the server list from it. After a PostgreSQL report it checks the [alert rules](alerts.md) and compares the report with the previous one for [change alerts](change-alerts.md). PgBouncer and Pgpool-II reports do not trigger rules.

Worth knowing up front:

- A server is created automatically on its first report and belongs to the account whose API key was used.
- Charts are built from a sequence of reports, so reports must be sent regularly, typically every 5 minutes, and no more often than every `PGSCOPE_MIN_REPORT_INTERVAL` seconds (60 by default).
- The report time is the collection time by the clock of the host running pgmetrics. Keep the collector's clock in sync (NTP). The pgdash CLI refuses to send a report whose time is more than 180 days away from now.
- pgscope never connects to the databases itself. It only needs incoming HTTP(S) requests from the collectors, so the whole setup works inside a closed perimeter.

## Installing pgmetrics and the pgdash CLI {#install-tools}

Both tools are open-source (Apache 2.0) programs by RapidLoop: [pgmetrics](https://pgmetrics.io) and [pgdash CLI](https://github.com/rapidloop/pgdash). They are static binaries without dependencies. Install them on the host the collection runs from: the database server or a separate collector host.

For a closed network, download the release archives on a machine with internet access and transfer the files. You can also build them from Go sources, also on a machine with internet access (`go install` downloads modules) and on Linux of the same architecture as the collection hosts. pgmetrics is best taken at the same version pgscope is built with, so that the report model matches exactly. In the pgscope source directory:

```bash
export CGO_ENABLED=0   # a static binary that does not depend on libc
v=$(go list -m -f '{{.Version}}' github.com/rapidloop/pgmetrics)
GOBIN=$PWD/bin go install "github.com/rapidloop/pgmetrics/cmd/pgmetrics@$v"
GOBIN=$PWD/bin go install github.com/rapidloop/pgdash@latest
```

Another way is to take pgmetrics from the agent image if it is already inside the perimeter. The binary is static and runs on any Linux of the same architecture:

```bash
docker create --name pgm pgscope-agent:latest
docker cp pgm:/usr/local/bin/pgmetrics ./pgmetrics
docker rm pgm
```

> [!NOTE]
> The pgdash CLI decodes the report with the pgmetrics model of its own version and encodes it again. Fields that this model version does not know are lost on the way. Use recent and matching versions of pgmetrics and the pgdash CLI. pgscope-agent and sending with curl ([Sending without the pgdash CLI](#curl)) pass the JSON on without re-encoding.

## First report {#first-report}

1. Copy the API key: **Profile** → the **API key** card. The key consists of 22 Latin letters and digits. Team member accounts have no key: reports are sent by the owner of the servers, see [Profile](teams.md#profile).
2. The **Sending reports** card on the same page has ready-made commands with your key and address filled in.
3. Run the collection by hand:

```bash
pgmetrics --no-password -f json -h DBHOST -U pgmon db1 db2 \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report prod-db-1
```

- `prod-db-1` is the server name in pgscope, see [Server name](#server-name).
- `--base-url` is the public pgscope address with the `/api/v1` suffix.
- On success the pgdash CLI prints nothing and exits with code 0. The server appears in the **Servers** list, see [Servers](fleet.md#servers).

> [!WARNING]
> Without `--base-url` the pgdash CLI sends the report to the pgDash cloud (`https://app.pgdash.io/api/v1`). In a closed network that is just a network error; in an open one it leaks data about the server outside the perimeter. Always set `--base-url`.

A key in the command arguments is visible in the process list and in the crontab. The pgdash CLI also reads the key from the `PDAPIKEY` variable when `-a` is not given:

```bash
export PDAPIKEY=$(cat /etc/pgscope/apikey)
pgmetrics --no-password -f json -h DBHOST -U pgmon --all-dbs \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report prod-db-1
```

After the key is regenerated (**Regenerate** on **Profile**), the old key stops working immediately: update it in every job.

## pgmetrics flags {#pgmetrics-flags}

| Flag | Default | Purpose |
|---|---|---|
| `-h`, `--host=HOST` | `PGHOST` or `/var/run/postgresql` | host or Unix socket directory |
| `-p`, `--port=PORT` | `PGPORT` or `5432` | port |
| `-U`, `--username=USER` | `PGUSER` or the OS user name | role to connect as |
| `-w`, `--no-password` | — | never prompt for a password. Without this flag and without `PGPASSWORD`, pgmetrics asks for a password even when `~/.pgpass` exists, and without a terminal (cron, systemd) it exits with an error right away |
| `--role=ROLE` | — | run `SET ROLE` before collecting |
| databases as arguments | `PGDATABASE` or the role name | which databases to collect: `db1 db2` |
| `--all-dbs` | — | all databases except templates and `postgres`. pgmetrics gets the list by connecting to the `postgres` database. If any of the databases refuses the connection, the whole collection fails |
| `--only-listed` | — | include information only about the listed databases |
| `-c`, `--schema=REGEXP` / `-C`, `--exclude-schema=REGEXP` | — | collect only the schemas matching a POSIX expression, or exclude them |
| `-a`, `--table=REGEXP` / `-A`, `--exclude-table=REGEXP` | — | the same for tables |
| `--omit=WHAT` | — | skip report parts, comma-separated: `tables`, `indexes`, `sequences`, `functions`, `extensions`, `triggers`, `statements`, `log`, `citus`, `indexdefs`, `bloat`. `tables` also turns off indexes and triggers, `extensions` also turns off query statistics (pgmetrics learns the `pg_stat_statements` version from the extension list) |
| `-S`, `--no-sizes` | — | do not collect database, tablespace, table and index sizes (speeds up collection on huge databases; size charts get gaps) |
| `--sql-length=N` | `500` | how many characters of statement text to keep |
| `--statements-limit=N` | `100` | how many statements to take from `pg_stat_statements` (by total time, descending) |
| `-t`, `--timeout=SECS` | `5` | `statement_timeout` of each pgmetrics query. A query that does not finish in time usually aborts the whole collection |
| `--lock-timeout=MS` | `50` | `lock_timeout` of the queries. A size that could not be read because of a lock is left out of the report, and the chart shows a gap |
| `--log-file=PATH` / `--log-dir=DIR` | automatic search | where to look for the PostgreSQL log (local connections only) |
| `--log-span=MIN` | `5` | how many recent minutes of the log to read |
| `--aws-rds-dbid=ID` | — | CloudWatch metrics and the log of AWS RDS / Aurora, see [AWS RDS and Aurora](#aws) |
| `--az-resource=ID` | — | Azure Monitor metrics, see [Azure](#azure) |
| `--pgpool` | — | collect Pgpool-II data only |
| `-f`, `--format=FORMAT` | `human` | `json` is required for sending |
| `-o`, `--output=FILE` | stdout | write the report to a file |
| `--query-proto=PROTO` | `simple` | query protocol: `simple` or `extended` |

Short flags can be combined: `-wfjson` is the same as `-w -f json`.

pgmetrics understands the standard libpq variables: `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGPASSFILE`, `PGSSLMODE`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLROOTCERT`, `PGCONNECT_TIMEOUT`. `pgmetrics --help=variables` prints the full list. `PGAPPNAME` is in that list too, but has no effect: pgmetrics always connects with `application_name=pgmetrics`.

> [!WARNING]
> If `PGSSLMODE` is not set, pgmetrics connects with `sslmode=disable`, that is, without TLS. For an encrypted connection set, for example, `PGSSLMODE=verify-full` and `PGSSLROOTCERT=/path/to/ca.crt`.

On large databases with thousands of tables the collection may not fit into `-t 5`. Raise `-t` (the Docker agent uses 30 seconds by default) or reduce the volume with `--omit=bloat`, `-S`, `-c`, `-A`.

## pgdash CLI flags {#pgdash-flags}

| Command | Purpose |
|---|---|
| `report SERVERNAME` | a PostgreSQL report for server `SERVERNAME` |
| `report-pgbouncer SERVERNAME PGBOUNCERNAME` | a report of PgBouncer instance `PGBOUNCERNAME` serving server `SERVERNAME` |
| `report-pgpool PGPOOLNAME` | a report of Pgpool-II `PGPOOLNAME` |

| Flag | Default | Purpose |
|---|---|---|
| `-a`, `--api-key=APIKEY` | the `PDAPIKEY` variable | the API key from the pgscope profile |
| `--base-url=URL` | `https://app.pgdash.io/api/v1` | the pgscope address with the `/api/v1` suffix; required |
| `-i`, `--input=FILE` | stdin | take the report from a file saved with `pgmetrics -f json -o FILE` |
| `--timeout=SECS` | `60` | timeout of one request and the pause before a retry |
| `--retries=COUNT` | `5` | how many attempts to make on network errors and 5xx responses (must be greater than 1) |
| `--debug` | — | debug output: compressed report size, request and retry progress |
| `-V`, `--version` | — | version |
| `-h`, `--help` | — | help. Note: in the pgdash CLI `-h` is help, not the host as in pgmetrics |

Before sending, the pgdash CLI checks the key and name format, that the JSON is a pgmetrics report with schema `1.x`, and that the collection time is within 180 days of now. The `report` command refuses a report with PgBouncer data: that is what `report-pgbouncer` is for.

Retries: on a network error or a 5xx response the pgdash CLI repeats the request, up to `--retries` attempts in total, pausing `--timeout` seconds in between (no pause after a timeout error). 4xx responses, including 409 and 429, are not retried. What exactly the pgdash CLI prints for each code is shown in [Server responses](#responses).

## Server name {#server-name}

The name of a server, a PgBouncer or a Pgpool-II is 1 to 64 characters from `A-Z a-z 0-9 _ . -`. Both the pgdash CLI and pgscope enforce this rule.

- A server is identified by the pair "owner account + name". A report with a new name creates a new server.
- Renaming a source means a new server in pgscope: its history starts over, and the old server stops updating and stays until deleted. Deleting is done in **Team & settings** → **Delete server data**, see [Server settings](teams.md#server-settings).
- Pgpool-II names live apart from PostgreSQL names: server `db1` and Pgpool `db1` are two different objects.
- A convenient scheme is the host name or `<environment>.<cluster>-<role>`, for example `prod.billing-1`. The Docker agent derives names by similar rules, see [Server name](docker.md#server-names).

## Regular sending: cron {#cron}

It is convenient to wrap sending in a small script. `pipefail` makes sure a pgmetrics failure is not lost in the pipeline:

```bash
#!/bin/bash
# /usr/local/bin/pgscope-report — sends one report
# usage: pgscope-report SERVER_NAME [pgmetrics flags...]
set -euo pipefail
name=$1
shift
PDAPIKEY=$(cat /etc/pgscope/apikey)
export PDAPIKEY
pgmetrics --no-password -f json "$@" \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report "$name"
```

```bash
install -m 755 pgscope-report /usr/local/bin/pgscope-report
install -d -m 750 -o postgres /etc/pgscope
install -m 600 -o postgres /dev/null /etc/pgscope/apikey   # then write the key into the file
```

A cron job every 5 minutes as `postgres`. This way pgmetrics connects over the Unix socket and can read the log. It connects as the `pgmon` role with the password from `~postgres/.pgpass`:

```text
# /etc/cron.d/pgscope
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * postgres flock -n /tmp/pgscope-prod-db-1.lock /usr/local/bin/pgscope-report prod-db-1 -U pgmon --all-dbs --log-span=5
```

The `PATH` line is needed because cron does not look in `/usr/local/bin`, where pgmetrics and pgdash usually live, by default. `flock -n` skips a run while the previous collection is still going. Do not schedule the job every minute: collection takes seconds, and the next report may arrive sooner than `PGSCOPE_MIN_REPORT_INTERVAL` after the previous stored one, and pgscope answers 429.

## Regular sending: systemd {#systemd}

A systemd timer is more convenient than cron: run logs go to journald, start times are spread, and runs cannot overlap (systemd does not start the service while the previous run is still active). A template for any number of servers uses the same `pgscope-report` script:

```ini
# /etc/systemd/system/pgscope-report@.service
[Unit]
Description=pgscope: report for %i
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=postgres
EnvironmentFile=/etc/pgscope/%i.env
ExecStart=/usr/local/bin/pgscope-report %i $PGMETRICS_ARGS
```

```ini
# /etc/systemd/system/pgscope-report@.timer
[Unit]
Description=pgscope: report timer for %i

[Timer]
OnCalendar=*:0/5
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
```

Each server's connection settings live in a file of their own. pgmetrics takes the host, port and role from the `PGHOST`, `PGPORT`, `PGUSER` variables:

```ini
# /etc/pgscope/prod-db-1.env
PGHOST=/var/run/postgresql
PGUSER=pgmon
PGMETRICS_ARGS=--all-dbs --log-span=5
```

```bash
systemctl daemon-reload
systemctl enable --now pgscope-report@prod-db-1.timer
systemctl list-timers 'pgscope-report@*'
journalctl -u pgscope-report@prod-db-1.service
```

The instance name (`prod-db-1`) is the server name in pgscope. systemd splits an unbraced `$PGMETRICS_ARGS` at whitespace into separate arguments. `RandomizedDelaySec=60` spreads the runs of different servers over time, while two reports of one server stay at least 4 minutes apart.

## Many servers {#many-servers}

| Scheme | What you get | Limitations |
|---|---|---|
| pgmetrics on every database host, connecting over the socket | all data: log, plans, autovacuum history, **System** | tools installed and configured on every host |
| one collector host polls many servers over the network | one place to configure, one key | no log, plans, autovacuum history or system metrics |
| pgscope-agent for databases in Docker and Swarm | automatic database discovery | the same limitations as network collection, see [Docker and Docker Swarm](docker.md) |

For a collector serving many servers, give each server its own timer instance and its own variables file:

```ini
# /etc/pgscope/billing-1.env
PGHOST=billing-1.db.example.com
PGUSER=pgmon
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/pgscope/ca.crt
PGMETRICS_ARGS=--all-dbs
```

```bash
for s in billing-1 billing-2 crm-1; do systemctl enable --now "pgscope-report@$s.timer"; done
```

All servers can be sent with one key. The rate limit is counted separately for every name, so reports of different servers do not interfere.

## Logs, plans and autovacuum history {#logs}

pgmetrics reads the PostgreSQL log (the **Logs** page, `auto_explain` plans, **Autovacuum history (from logs)**, deadlocks) only over a **local** connection: through the Unix socket, with the same client and server address, or over loopback addresses. The `--log-file` and `--log-dir` flags only tell it where the log is; they do not help in a remote run. For AWS RDS and Aurora the log is read through the API with `--aws-rds-dbid`.

System metrics (the **System** page, load and memory on **Overview**, disk usage of tablespaces) are also collected only over a local connection and only on Linux.

Set `--log-span` equal to the sending interval (5 minutes when running every 5 minutes). All requirements for log settings and file permissions are in [PostgreSQL log](postgres.md#logs).

## AWS RDS and Aurora {#aws}

```bash
export AWS_REGION=eu-central-1
pgmetrics --no-password -f json -h mydb.xxxx.eu-central-1.rds.amazonaws.com -U pgmon \
  --aws-rds-dbid=mydb --log-span=5 app \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report mydb
```

With `--aws-rds-dbid` pgmetrics additionally:

- reads all metrics of the `AWS/RDS` namespace for this instance from CloudWatch (the latest of the one-minute averages over the last 5 minutes);
- if the instance has Enhanced Monitoring enabled, takes its latest record from the CloudWatch Logs group `RDSOSMetrics`;
- reads the PostgreSQL log through the RDS API for the last `--log-span` minutes.

`--aws-rds-dbid` is the **instance** identifier (`DBInstanceIdentifier`). For Aurora it is a cluster instance, not the cluster identifier: send a report from each instance under its own name.

Credentials come from the standard AWS SDK chain: the `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` variables, the `~/.aws/credentials` and `~/.aws/config` files (profile `AWS_PROFILE`), the EC2 instance role. The permissions pgmetrics uses:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances",
        "rds:DescribeDBLogFiles",
        "rds:DownloadDBLogFilePortion",
        "cloudwatch:ListMetrics",
        "cloudwatch:GetMetricData",
        "logs:GetLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

An AWS error does not abort the collection: pgmetrics prints `warning: failed to collect from AWS RDS: …`, and the report goes out without cloud data. Note: if the instance has Enhanced Monitoring enabled but the `logs:GetLogEvents` permission is missing, pgmetrics drops all cloud metrics of the report, not only the Enhanced Monitoring data. An error reading the log through the RDS API does not cancel the cloud metrics. The metrics appear under **Cloud metrics** in the **Integrations** section, see [Cloud metrics](integrations.md#cloud).

> [!NOTE]
> This mode needs the collector host to reach the AWS API over the internet or through VPC endpoints. AWS bills CloudWatch requests separately. pgscope itself never talks to AWS.

## Azure Database for PostgreSQL {#azure}

```bash
export AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=...
pgmetrics --no-password -f json -h myserver.postgres.database.azure.com -U pgmon \
  --az-resource=/subscriptions/SUBSCRIPTION-ID/resourceGroups/RG/providers/Microsoft.DBforPostgreSQL/flexibleServers/myserver \
  app | pgdash --base-url=https://pgscope.example.com/api/v1 report myserver
```

`--az-resource` is the full resource ID of the form `/subscriptions/…/resourceGroups/…/providers/Microsoft.DBforPostgreSQL/TYPE/NAME`, where the type is `flexibleServers`, `servers` or `serverGroupsv2`. pgmetrics reads Azure Monitor metrics for the last 5 minutes (at a 1-minute step, 15 minutes for `servers`).

pgmetrics gets credentials through `DefaultAzureCredential`: the `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` variables (or `AZURE_CLIENT_CERTIFICATE_PATH`, `AZURE_USERNAME` and `AZURE_PASSWORD`) or other sources of that mechanism, such as a managed identity. The account must be allowed to read the resource's metrics. An error does not abort the collection: pgmetrics prints `warning: failed to collect from Azure: …`. All Azure calls must fit into the pgmetrics query timeout `-t` (5 seconds by default); if collection from Azure is cut off by the timeout, raise `-t`. As with AWS, the collector needs access to the Azure API.

## PgBouncer {#pgbouncer}

```bash
pgmetrics -h PGB_HOST -p 6432 -U pgmon -wfjson pgbouncer \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report-pgbouncer prod-db-1 pgb-1
```

- pgmetrics switches to PgBouncer mode when the only database in the arguments is named exactly `pgbouncer`. Preparing the user is described in [PgBouncer](postgres.md#pgbouncer).
- The first argument of `report-pgbouncer` is the name of the PostgreSQL server in pgscope that the pooler belongs to, the second is the PgBouncer instance name.
- The report is stored with that server. If no server with that name exists yet, pgscope creates its entry, and the PostgreSQL data appears with the first `report`.
- The rate limit is counted separately for each PgBouncer instance, so send the pooler report right after the PostgreSQL report in the same script.
- Several poolers mean several reports under different names; the PgBouncer page has a switch to pick the instance.
- After the first report the server gets a **PgBouncer** item in the **Integrations** section (a page reload may be needed), see [PgBouncer](integrations.md#pgbouncer).

## Pgpool-II {#pgpool}

```bash
pgmetrics -h PGPOOL_HOST -p 9999 -U pgmon -wfjson --pgpool postgres \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report-pgpool pool-1
```

Pgpool-II appears in the **Servers** list as a separate object with its own dashboard; it has only **Overview** and **Team & settings**. Preparation is described in [Pgpool-II](postgres.md#pgpool), the dashboard in [Pgpool](integrations.md#pgpool).

## Rate and size limits {#limits}

**Rate.** A report is accepted if at least `PGSCOPE_MIN_REPORT_INTERVAL` seconds (60 by default) have passed since the last *successfully stored* report of the same source. A source is the account, the type (PostgreSQL or Pgpool-II), the server name and the PgBouncer name. Otherwise pgscope answers 429. The timestamps are kept in process memory and reset when pgscope restarts. A value of `0` turns the check off. While the previous report of the same source is still being stored, the next one gets 409. The variable is described in [Configuring pgscope](config.md).

**Size.** The request body is limited to 256 MiB as sent and 2 GiB after gzip decompression (4 MiB for agent heartbeats). pgscope rejects a larger body with 400 **Invalid request body**. Reports are usually far smaller. If a report is huge (tens of thousands of tables), shrink it with `-c`, `-C`, `-a`, `-A`, `--omit`, `-S`, `--statements-limit`.

> [!WARNING]
> A reverse proxy in front of pgscope may limit the body size more strictly. nginx defaults to `client_max_body_size 1m`, and large reports get 413 from the proxy, not from pgscope. Raise the limit for `/api/v1/`, see [Reverse proxy](install.md#reverse-proxy).

Large reports over a slow link may not fit into the pgdash CLI `--timeout` (60 seconds): raise it.

## Server responses {#responses}

The report endpoints accept only `POST`. The body is JSON, optionally gzip-compressed (`Content-Encoding: gzip`). A successful response is `200` with the body `{}`. An error is JSON of the form `{"error": "…"}`. The error text is in Russian by default and in English with the `Accept-Language: en` header. The pgdash CLI does not show this text, only the code. To see the message, send the report with curl, see [Sending without the pgdash CLI](#curl).

| Code | pgscope message (English) | Cause | What to do |
|---|---|---|---|
| 200 | — | the report was accepted and stored | — |
| 400 | **Invalid request body** | the body is not JSON, is truncated or exceeds the limit | make sure the output of `pgmetrics -f json` is sent; shrink the report, see [Limits](#limits) |
| 400 | **Could not decompress the request body (gzip)** | `Content-Encoding: gzip` is set, but the body is not gzip | drop the header or compress the body |
| 400 | **Invalid server name** | the server (or PgBouncer, Pgpool) name breaks the rule | see [Server name](#server-name) |
| 400 | **The data is not a pgmetrics JSON report** | the `data` field is not a pgmetrics report or lacks the collection time | run pgmetrics with `-f json` |
| 400 | **The report has no PgBouncer data** / **The report has no Pgpool data** | a PostgreSQL report was sent with `report-pgbouncer` or `report-pgpool` | for PgBouncer collect the `pgbouncer` database, for Pgpool-II add `--pgpool` |
| 401 | **Invalid API key** | the key is not 22 Latin letters and digits | copy the key from **Profile** again |
| 403 | **Unknown API key** | no such key: it was regenerated, belongs to another pgscope instance or was copied wrongly | copy the current key from **Profile** |
| 404 | — | wrong path or method, for example `--base-url` without `/api/v1` | check `--base-url` |
| 409 | **The previous report for this server is still being saved** | two reports of the same source arrived at the same time | the next scheduled report goes through; check for two jobs with the same name |
| 413 | — | a reverse proxy response: the body exceeds its limit | raise `client_max_body_size` or its equivalent |
| 429 | **Reports are being sent too often** | less than `PGSCOPE_MIN_REPORT_INTERVAL` has passed since the last stored report of this source | send less often; check for two jobs with the same name |
| 500 | **Could not save the report** | a write error in the pgscope database | see the pgscope log (the `store report …` line) |
| 502, 504 | — | a reverse proxy response: pgscope is down or did not answer in time | check that pgscope is running, and the proxy timeouts |
| 503 | **Storage is temporarily unavailable** | the pgscope database was unavailable during the key check | restore access to `PGSCOPE_DB`; the pgdash CLI retries on its own |

How the clients react:

| Code | pgdash CLI | pgscope-agent |
|---|---|---|
| 200 | exits silently with code 0 | target status **Working** |
| 400 | `pgdash: invalid API key or account limit reached` for `report`, or `invalid API key or server "…" not found` for the other commands (pgDash wording; in pgscope 400 means a data error), no retry | status **Error** with the response text |
| 401, 403, 404, 413 | `pgdash: API request failed: server returned HTTP error code N`, no retry | status **Error**; on 403 the agent log shows `ERROR: pgscope rejected the API key` |
| 409 | `pgdash: API request failed: previous store for this server is still in progress`, no retry | status **Error**, the next report after the interval |
| 429 | `pgdash: API request failed: rate limited, retry after 60 seconds`, no retry | status **Error**, the next report after the interval |
| 5xx and network errors | up to `--retries` attempts, pausing `--timeout`; finally `internal server error` (500) or `server returned HTTP error code N` | one retry after 5 seconds, then status **Error** |

For detailed diagnostics run the pgdash CLI with `--debug`. The `/api/v1/agent` endpoint for agent heartbeats is described in [API](api.md).

## Sending without the pgdash CLI {#curl}

The request format is simple, so a report can be sent with curl and jq if the pgdash CLI cannot be installed. It is also a handy way to see pgscope's error text:

```bash
pgmetrics --no-password -f json -h DBHOST -U pgmon --all-dbs \
  | jq -c --rawfile k /etc/pgscope/apikey --arg s prod-db-1 \
      '{apikey: ($k | rtrimstr("\n")), server: $s, data: .}' \
  | gzip \
  | curl -sS --fail-with-body \
      -H 'Content-Type: application/json' -H 'Content-Encoding: gzip' -H 'Accept-Language: en' \
      --data-binary @- https://pgscope.example.com/api/v1/report
```

This needs jq 1.7+ and curl 7.76+ (`--fail-with-body`). jq 1.6 also knows `--rawfile`, but it rounds 64-bit numbers, including the `queryid` statement identifiers. The key is read from a file and does not show up in the process list. For other report types the endpoint and the JSON fields change:

| Endpoint | Fields |
|---|---|
| `/api/v1/report` | `apikey`, `server`, `data` |
| `/api/v1/reportpgbouncer` | `apikey`, `server` (the PostgreSQL server), `pgbouncer` (the pooler name), `data` |
| `/api/v1/reportpgpool` | `apikey`, `pgpool`, `data` |

Unlike the pgdash CLI, this variant does not retry on 5xx errors and does not validate the report before sending.
