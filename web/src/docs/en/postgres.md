# Preparing PostgreSQL

pgscope gets its data only from pgmetrics reports, so the interface shows exactly what pgmetrics was able to read on the server. Basic metrics are collected with no setup at all. The full picture needs a monitoring role, the `pg_stat_statements` extension, `auto_explain`, access to the PostgreSQL log and a few statistics settings. This page describes what to enable in PostgreSQL, PgBouncer and Pgpool-II and which pgscope pages depend on it. How to run the collection is covered in [Sending reports](collect.md); databases in containers are covered in [Docker and Docker Swarm](docker.md).

## What each page needs {#requirements}

| In pgscope | What the server needs | Details |
|---|---|---|
| All pages: backends, locks, databases, tables, indexes, replication, WAL, settings | a role with `pg_monitor` and `CONNECT` on the databases | [Monitoring role](#monitoring-role) |
| **Queries**, the query page, query **Suggestions** | the `pg_stat_statements` extension | [pg_stat_statements](#pg-stat-statements) |
| **Block read time**, **Block write time**, the suggestion about the share of disk I/O | `track_io_timing = on` | [Statistics settings](#track-settings) |
| **Plans**, **Total plan time**, the suggestion about long planning | `pg_stat_statements.track_planning = on` | [Statistics settings](#track-settings) |
| **Execution plans** on the query page | `auto_explain` with `log_format = json` and log access for pgmetrics | [auto_explain](#auto-explain) |
| **Logs**, **Deadlocks in logs** on the **Locks** page | log access for pgmetrics, for `stderr` a timestamp in `log_line_prefix` | [PostgreSQL log](#logs) |
| **Autovacuum history (from logs)** on the **Vacuum** page | `log_autovacuum_min_duration` other than `-1` and log access | [PostgreSQL log](#logs) |
| **Functions** under **Extensions & more** | `track_functions = pl` or `all` | [Statistics settings](#track-settings) |
| **System**, the **Load average** and **Memory** charts on **Overview**, disk usage on **Tablespaces** | pgmetrics running on the database host under Linux | [Logs, plans and autovacuum history](collect.md#logs) |
| **Cloud metrics** | the pgmetrics flag `--aws-rds-dbid` or `--az-resource` | [AWS RDS and Aurora](collect.md#aws) |
| **PgBouncer** | a user listed in PgBouncer's `stats_users` | [PgBouncer](#pgbouncer) |
| The Pgpool dashboard | a user that Pgpool-II lets in | [Pgpool-II](#pgpool) |

> [!TIP]
> After the first report, open **Diagnostics** → **Configuration check**. pgscope flags a disabled `track_io_timing`, `log_checkpoints`, `log_lock_waits`, `log_min_duration_statement`, `log_autovacuum_min_duration` and a missing `pg_stat_statements` in `shared_preload_libraries` on its own. See [Diagnostics](monitoring.md#diagnostics).

## Supported versions {#versions}

| Component | Versions | Notes |
|---|---|---|
| PostgreSQL | 9.3 to 19 | the pgmetrics that pgscope is built with picks its queries by `server_version_num` and has code paths for these versions. It detects the `pg_stat_statements` version (up to 1.13) separately, so an extension that was not updated after a server upgrade is still read |
| PostgreSQL below 14 | collected, but flagged | **Diagnostics** shows the **Unsupported PostgreSQL version** warning: these versions no longer receive security fixes |
| PgBouncer | 1.15–1.25 | pgmetrics parses the output of `SHOW POOLS`, `SHOW SERVERS`, `SHOW CLIENTS`, `SHOW STATS`, `SHOW DATABASES` by column count. An unknown layout makes the collection fail with `unsupported number of columns` |
| Pgpool-II | 4.0–4.7 | health check statistics (`SHOW POOL_HEALTH_CHECK_STATS`) and per-backend query counters (`SHOW POOL_BACKEND_STATS`) are collected from 4.2 on |
| pgmetrics | 1.19.x | pgscope decodes reports with the pgmetrics 1.19.x model. The pgscope-agent image contains exactly the pgmetrics version pgscope is built with |

On PostgreSQL 11 the number of WAL files ready for archiving, and on PostgreSQL 10 and older also the total number of WAL files, are read by pgmetrics through `pg_ls_dir`, which by default only a superuser may call. With the `pg_monitor` role these values are not collected; everything else is.

## Monitoring role {#monitoring-role}

Collection needs a dedicated role with login and membership in `pg_monitor`. Superuser privileges are neither needed nor recommended: pgscope lists extra superuser roles as a finding on **Diagnostics**.

```sql
CREATE ROLE pgmon LOGIN;
GRANT pg_monitor TO pgmon;
\password pgmon
```

`\password` in psql hashes the password on the client, so the plain password ends up neither in the PostgreSQL log nor in `pg_stat_statements`, from where it would travel into pgscope reports. `CREATE ROLE ... PASSWORD '...'` with the password in the statement text gives no such guarantee.

What `pg_monitor` grants (through the roles `pg_read_all_settings`, `pg_read_all_stats`, `pg_stat_scan_tables`):

- the query texts of other sessions in `pg_stat_activity` and of all statements in `pg_stat_statements`. Without it the text reads `<insufficient privilege>`;
- all settings, including `data_directory`, which pgmetrics uses to find the log file;
- the functions `pg_ls_waldir()` and `pg_ls_archive_statusdir()`: the WAL file count and the archive queue.

`CONNECT` on databases is granted to `PUBLIC` by default. If it was revoked in your installation, grant it explicitly for every database you want to see:

```sql
GRANT CONNECT ON DATABASE app TO pgmon;
```

pgmetrics opens one connection per database and sets `statement_timeout` (flag `-t`, 5 seconds by default) and `lock_timeout` (flag `--lock-timeout`, 50 ms by default) in it, so collection does not hold up the workload. In `pg_stat_activity` these sessions show up with `application_name = pgmetrics`.

> [!NOTE]
> The bloat estimate is based on the `pg_stats` view, and PostgreSQL shows only the columns the role may read (`SELECT`) in it. For tables the monitoring role has no `SELECT` on, the bloat estimate may come out too low or zero. If it matters, grant the role `SELECT` on those tables or the `pg_read_all_data` role (PostgreSQL 14+), bearing in mind that it is the right to read all data.

### Network access and pg_hba.conf {#pg-hba}

If pgmetrics does not run on the database host, the server must listen on a network interface (`listen_addresses`), and `pg_hba.conf` must let the monitoring role in from the collector's address:

```text
# TYPE  DATABASE  USER   ADDRESS        METHOD
host    all       pgmon  10.0.0.5/32    scram-sha-256
```

If pgmetrics runs on the database host over the Unix socket (this is how the log and system metrics get collected), add a line for local connections:

```text
local   all       pgmon                 scram-sha-256
```

`pg_hba.conf` lines are checked top to bottom until the first match, so put these lines above generic rules such as `local all all peer`.

pgmetrics takes the password from `~/.pgpass` of the OS user that runs the collection (or from the file named in `PGPASSFILE`), or from the `PGPASSWORD` variable. With `~/.pgpass`, run pgmetrics with the `-w` (`--no-password`) flag: without it and without `PGPASSWORD`, pgmetrics asks for a password itself, and without a terminal (in cron, in systemd) it exits with an error right away. `~/.pgpass` must have mode `0600`:

```text
*:5432:*:pgmon:password
```

After changing `pg_hba.conf`, reload the configuration: `SELECT pg_reload_conf();`.

## pg_stat_statements {#pg-stat-statements}

Without `pg_stat_statements` the **Queries** page shows **No query statistics**, and **Diagnostics** shows a finding with the same name.

1. Add the library to `postgresql.conf` (comma-separated if something is already there):

   ```ini
   shared_preload_libraries = 'pg_stat_statements'
   ```

2. Restart PostgreSQL. A reload is not enough: `shared_preload_libraries` is applied only at startup.
3. Create the extension in every database pgmetrics collects:

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

4. Check as the monitoring role. The `query` column must not contain `<insufficient privilege>`:

   ```sql
   SELECT query, calls FROM pg_stat_statements LIMIT 5;
   ```

How pgmetrics reads the statistics:

- The `pg_stat_statements` view returns the statements of all databases on the server, so pgmetrics reads it once per report, in the first collected database where the extension is installed. Strictly speaking, one such database is enough. Note that `--all-dbs` mode does not collect the `postgres` database, so having the extension only in `postgres` is not enough in that mode. Creating it in every monitored database is the safer choice.
- The report includes the 100 `pg_stat_statements` rows with the largest total execution time (pgmetrics flag `--statements-limit`), and each query text is cut to 500 characters (`--sql-length`).
- `pg_stat_statements` keeps a separate row for each user who ran a query. pgscope merges the rows with the same database and `queryid`: the **Queries** page, the query page, the charts and query-level alerts show the sum over all users, means are the total time divided by the total number of calls, and the maximum is taken over all users. Note that each such row takes a place in the `--statements-limit` budget.
- Rows of databases dropped since the statistics were last reset arrive with an empty database name, and pgscope merges them by `queryid` into one query.

Useful extension settings:

| Setting | Default | Why change it |
|---|---|---|
| `pg_stat_statements.max` | `5000` | with many distinct statements, rare ones get evicted; raise it if the statistics keep shifting (restart required) |
| `pg_stat_statements.track` | `top` | `all` also counts statements inside functions |
| `pg_stat_statements.track_planning` | `off` | `on` adds planning time to the query page (PostgreSQL 13+) at a small overhead |

For containers, the library is set in the start command, and the `bootstrap-monitor-role.sh` script with `--with-pg-stat-statements` creates the extension in all databases; see [The bootstrap-monitor-role.sh script](docker.md#bootstrap).

## auto_explain {#auto-explain}

The `auto_explain` module writes the plans of slow statements to the PostgreSQL log. pgmetrics finds them in the log, and pgscope shows them in the **Execution plans** block of the query page: the latest three right away, the rest behind the **Show all {n} plans** button.

```ini
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = 2000   # ms: plans of statements longer than 2 seconds
auto_explain.log_analyze = on          # actual rows and loops in the nodes
auto_explain.log_timing = off          # no per-node timing: less overhead
auto_explain.log_format = json         # pgscope draws a tree only for JSON
```

Changing `shared_preload_libraries` requires a restart.

How the format affects what you see:

| `auto_explain.log_format` | What pgscope shows |
|---|---|
| `json` | a plan tree: node type, table or index, actual and estimated rows, cost, time, conditions; warnings under the nodes and **Plan: …** suggestions on the query page |
| `text` | the plan as plain text, without analysis or warnings |
| `xml`, `yaml` | pgmetrics does not parse these plans and prints `warning: xml format auto_explain output not supported yet` (or the same for `yaml`) to stderr; no plan is shown |

Notes:

- `log_analyze = on` provides the actual row counts that pgscope uses to spot planner misestimates. According to the PostgreSQL documentation, instrumentation then applies to all statements, not only those that get logged, so the overhead is always there. `log_timing = off` reduces it considerably. The bars under the nodes then show the share of cost, and the tree is headed by **bars show share of cost (no timing data)**. To reduce the load further, use `auto_explain.sample_rate`.
- Plans are linked to a `pg_stat_statements` statement by query identifier or by text with literals, numbers and `$n` parameters replaced by `?`. The text in `pg_stat_statements` is cut to `--sql-length` (500 characters), so long statements do not match by text. For them, add `%Q` to `log_line_prefix` (PostgreSQL 14+, with `compute_query_id = auto` and `pg_stat_statements` loaded) so pgmetrics gets the query identifier, or raise `--sql-length`. In PostgreSQL 14+ `csvlog` the identifier is written to a separate column, and pgmetrics [built by pgscope](collect.md#pgmetrics-build) takes it from there without `%Q`.
- Plans are read only from the log entries of the last `--log-span` minutes of each report. All conditions for reading the log are in [PostgreSQL log](#logs).

## PostgreSQL log {#logs}

From the log pgmetrics takes:

- all entries for the report period — the **Logs** page;
- `auto_explain` plans — the query page;
- `automatic vacuum of table "…"` lines with their duration — **Autovacuum history (from logs)** on the **Vacuum** page;
- `deadlock detected` entries with details — **Deadlocks in logs** on the **Locks** page.

pgmetrics reads the log only when all of these hold:

1. **The connection is local.** pgmetrics connected through the Unix socket, with the same client and server address, or over loopback addresses `127.0.0.0/8`. In a remote run the log is not read, even with `--log-file` or `--log-dir`. The exception is AWS RDS and Aurora: there the log is read through the AWS API with the `--aws-rds-dbid` flag, see [AWS RDS and Aurora](collect.md#aws). The **Collected by** row of the **Cluster** card on **Overview** shows the pgmetrics version, for example **pgmetrics 1.19.1 (local)**, and the **(local)** mark shows that the report was collected locally.
2. **The file is found.** pgmetrics looks in this order: the `--log-file` flag; all files in the `--log-dir` directory except `.gz` and `.bz2`; the result of `pg_current_logfile()` (PostgreSQL 10+, only with `logging_collector = on`; an absolute path or one relative to `data_directory`), if the role may call this function; the most recent file in `/var/log/postgresql`. If the `--log-file` file cannot be read, pgmetrics prints `warning: failed to locate/read specified log file …` and tries no other place. If nothing is found, pgmetrics prints the warning `failed to guess log file location/access denied, specify explicitly with --log-file or --log-dir` to stderr, and the report goes out without log data.
3. **The format is supported.** pgmetrics reads a plain text log (`stderr`) and `csvlog`. It picks the format from the server settings, not from the file name: when `log_destination` contains `csvlog` and `logging_collector = on`, every file found is read as CSV (plain `.log` files from `--log-dir` are then skipped, sometimes with the warning `warning: while reading log file …`), otherwise as text. PostgreSQL 13+ `csvlog` is read only by the pgmetrics that pgscope builds (its version ends with `+pgscope`, see [pgmetrics built by pgscope](collect.md#pgmetrics-build)). Official pgmetrics releases parse only the 23-column `csvlog` of PostgreSQL 12; from PostgreSQL 13 on `csvlog` has more columns, and they silently skip such a file: the report has no log data and no warning. With official pgmetrics keep `log_destination = 'stderr'`, without `csvlog`. pgmetrics does not read the `jsonlog` format.
4. **For `stderr`, `log_line_prefix` contains a timestamp**: `%t`, `%m` or `%n`. The default `'%m [%p] '` works. Without a timestamp the log is not read, and pgmetrics prints `no timestamp escape sequence was found in log_line_prefix`. In `csvlog` every record carries its time, and pgmetrics built by pgscope does not check `log_line_prefix` there; official releases require the timestamp for `csvlog` too.
5. **The file is readable** by the OS user that runs pgmetrics. By default `log_file_mode = 0600`, and only the owner (usually `postgres`) can read the log. Either run the collection as `postgres`, or set `log_file_mode = 0640` and add the collector's user to the owner's group. In the second case the user also needs access to the log directory. By default `log_directory = 'log'` is inside the data directory, which has mode `0700`, so `log_file_mode = 0640` alone does not help. Move `log_directory` out of the data directory (for example, to `/var/log/postgresql`) or run the collection as `postgres`.

Only the entries of the last `--log-span` minutes (5 by default) are read. Make this value equal to the report interval, or some entries end up in no report at all.

> [!WARNING]
> Official pgmetrics releases read entry times correctly only when `log_timezone` matches the time zone of the host where pgmetrics runs (`/etc/localtime` or the process's `TZ` variable), or is `'UTC'`. They read the time of an entry by its zone abbreviation (`MSK`, `CET`, `+05`) and understand only `UTC`, `GMT` and the abbreviations of their own local zone; they take all others as UTC. With a zone east of UTC (for example `MSK`) entry times move forward by the zone offset: the report gets the entries of `--log-span` minutes plus that offset, the times on the **Logs** page are shifted, and the same entries repeat in several reports in a row. With a zone west of UTC the times move back, the entries fall outside the `--log-span` window, and the report has no log data. This applies to the `%m` and `%t` timestamps of `stderr` and to `csvlog`; the `%n` timestamp (Unix time) does not depend on the zone.
>
> [pgmetrics built by pgscope](collect.md#pgmetrics-build) reads entry times in the zone named by the server's `log_timezone`, so they are right with any combination of the server's and the pgmetrics host's zones. If it does not know the zone name, it writes `warning: unknown log_timezone …` to stderr and reads times in the zone of its host.

Recommended log settings:

| Setting | Recommendation | What it gives in pgscope |
|---|---|---|
| `logging_collector` | `on` | log files that pgmetrics finds through `pg_current_logfile()` (restart required) |
| `log_destination` | `'stderr'` | the format every pgmetrics reads; PostgreSQL 13+ `'csvlog'` is read only by [pgscope's build](collect.md#pgmetrics-build) |
| `log_line_prefix` | `'%m [%p] %q%u@%d '` | the timestamp (mandatory for `stderr`), plus user and database on the entries; add `%Q` to link plans to statements |
| `log_timezone` | any with [pgscope's build](collect.md#pgmetrics-build); with official pgmetrics, the time zone of its host, or `'UTC'` | correct entry times, and entries inside the `--log-span` window |
| `log_file_mode` | `0640` | reading the log as a user other than the owner |
| `log_autovacuum_min_duration` | `1000` (ms) or `0` | **Autovacuum history (from logs)**. `-1` turns the logging off (the default up to PostgreSQL 14; from 15 on the default is `10min`) |
| `log_lock_waits` | `on` | lock waits longer than `deadlock_timeout` appear in **Logs** |
| `log_checkpoints` | `on` | checkpoints in the log, context for the **WAL & checkpoints** page (on by default since PostgreSQL 15) |
| `log_min_duration_statement` | for example `1000` (ms) | slow statements in **Logs** |

All of these except `logging_collector` apply without a restart: `SELECT pg_reload_conf();`.

## Statistics settings {#track-settings}

| Setting | Default | What it gives in pgscope | Notes |
|---|---|---|---|
| `track_counts` | `on` | table and index statistics; autovacuum does not work without it | with `off`, **Configuration check** shows a critical finding |
| `track_activities` | `on` | current statements on the **Backends** page | |
| `track_activity_query_size` | `1024` | length of the statement text in `pg_stat_activity` | restart required; pgmetrics also cuts the text to `--sql-length` |
| `track_io_timing` | `off` | **Block read time** and **Block write time** for databases and statements, the suggestion "… of the time is spent on disk I/O" | the overhead is small on modern systems; check it with the `pg_test_timing` utility |
| `track_functions` | `none` | the **Functions** tab under **Extensions & more** | `pl` counts procedural-language functions only, `all` adds SQL and C functions |
| `pg_stat_statements.track_planning` | `off` | planning time for statements | PostgreSQL 13+ |
| `compute_query_id` | `auto` | the query identifier for `%Q` in the log and in `pg_stat_activity` | PostgreSQL 14+; with `auto` it is computed when `pg_stat_statements` is loaded |

```sql
ALTER SYSTEM SET track_io_timing = on;
ALTER SYSTEM SET track_functions = 'pl';
SELECT pg_reload_conf();
```

## PgBouncer {#pgbouncer}

pgmetrics collects PgBouncer data through its admin console: it connects to the PgBouncer port (usually `6432`) to the database named exactly `pgbouncer` and runs `SHOW POOLS`, `SHOW SERVERS`, `SHOW CLIENTS`, `SHOW STATS` and `SHOW DATABASES`. A user from `stats_users` (read-only console access) is enough; `admin_users` rights are not needed.

```ini
; pgbouncer.ini
[pgbouncer]
stats_users = pgmon
auth_file = /etc/pgbouncer/userlist.txt
```

The user must pass PgBouncer authentication; the most reliable way is a line in `auth_file`. After the change, run `RELOAD;` in the PgBouncer console. Check:

```bash
psql -h PGB_HOST -p 6432 -U pgmon pgbouncer -c 'SHOW POOLS;'
```

If PgBouncer requires TLS from clients, set `PGSSLMODE` before running pgmetrics: without this variable pgmetrics connects with `sslmode=disable`. The sending command is in [PgBouncer](collect.md#pgbouncer); PgBouncer in a container is covered in [PgBouncer in a container](docker.md#pgbouncer).

## Pgpool-II {#pgpool}

With the `--pgpool` flag, pgmetrics connects to the Pgpool-II port (usually `9999`) as an ordinary client to any database (for example, `postgres`) and runs `SHOW POOL_VERSION`, `SHOW POOL_NODES`, `SHOW POOL_HEALTH_CHECK_STATS`, `SHOW POOL_BACKEND_STATS` and `SHOW POOL_CACHE`. No special role is needed in Pgpool-II: it is enough that Pgpool-II lets the user in by its authentication rules (`pool_hba.conf`, `pool_passwd`) and the user can connect to the backends.

```bash
psql -h PGPOOL_HOST -p 9999 -U pgmon postgres -c 'SHOW POOL_NODES;'
```

If any of the `SHOW POOL_*` commands fails, pgmetrics aborts the collection with a message such as `pgpool: show pool_nodes query failed`, and no report is sent. The sending command is in [Pgpool-II](collect.md#pgpool).

## Readiness check {#checklist}

As the monitoring role on the PostgreSQL server:

```sql
SHOW shared_preload_libraries;                 -- pg_stat_statements, auto_explain
SELECT extname, extversion FROM pg_extension;  -- pg_stat_statements in the database
SELECT count(*) FROM pg_stat_statements;       -- no error
SHOW track_io_timing;                          -- on
SHOW log_line_prefix;                          -- for stderr: contains %m, %t or %n
SHOW log_timezone;                             -- official pgmetrics: its host's zone, or UTC
SELECT pg_current_logfile();                   -- log file path, if the role may call it
```

Then run pgmetrics by hand in its normal text format and look at the warnings on stderr: an unreadable log, `pg_stat_statements` errors, missing privileges.

```bash
pgmetrics -h localhost -U pgmon app
```

If everything looks right, set up regular sending as described in [Sending reports](collect.md).
