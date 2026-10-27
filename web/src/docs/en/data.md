# Data storage

This page describes what pgscope stores and where: the tables of the storage database, retention periods and the background cleanup, estimating and checking the storage size, backup and restore, deleting data and moving pgscope to another host.

## Where the data lives {#overview}

pgscope keeps all of its data in a single PostgreSQL database — the one set in `PGSCOPE_DB` (default `postgres://localhost/pgscope`). The pgscope process itself writes no files: the web interface is embedded in the binary, and the log goes to standard error (stderr). For backups and moves you therefore only need the storage database and your startup settings (environment variables, the systemd unit file or the `.env` file for Docker Compose).

The tables are created on every start with `CREATE TABLE IF NOT EXISTS`, and new columns are added with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. There is no separate migration step, but the role in `PGSCOPE_DB` needs permission to create tables in the database.

A few things are not kept in the database:

- The time of the last accepted report of each source, which the `PGSCOPE_MIN_REPORT_INTERVAL` limit relies on, is kept in process memory and resets when pgscope restarts.
- The AI chat conversation lives in the browser (`sessionStorage`) until the tab is closed. The browser sends the whole conversation to pgscope with every question, but pgscope does not store it.
- The color theme, the interface language and the selected chart range are remembered in the browser (`localStorage`). The language of a signed-in user is also saved in their profile (the `users.lang` column).

### Storage database tables {#tables}

| Table | Contents |
|---|---|
| `users` | accounts: email, password hash (bcrypt), API key (empty for team members), chosen language |
| `sessions` | sign-in sessions: token, user, expiry |
| `servers` | servers: owner, type (`postgres` or `pgpool`), name, time of the latest report, a short summary for the server list and the Inspector |
| `shares` | who a server is shared with |
| `invites` | pending invitations |
| `reports` | full pgmetrics reports exactly as received, gzip-compressed. The `source` column is empty for the server's own reports and holds the PgBouncer name for pooler reports |
| `metrics` | time series: one row per object per report, values in `jsonb` |
| `alert_rules` | alert rules |
| `change_rules` | change alert settings |
| `notifiers` | notification channels: type, destination, language |
| `alert_state` | the current set of triggered alerts of each server |
| `events` | history: changes in the set of triggered alerts and detected changes |
| `agents` | Docker agents: agent details and its targets from the latest heartbeat |

Most of the space is taken by `metrics` and `reports`. The object key in `metrics.obj` tells what a row belongs to:

| `obj` key | Object |
|---|---|
| empty string | the whole server (for Pgpool, Pgpool itself) |
| `db:<database>` | database |
| `tbl:<database>.<schema>.<table>`, `idx:<database>.<schema>.<index>` | table, index |
| `q:<database>:<queryid>` | query from `pg_stat_statements` |
| `fn:<database>.<schema>.<function>` | user function |
| `ts:<name>` | tablespace |
| `repl:<standby>`, `slot:<slot>` | standby (in the primary's report), replication slot |
| `pgb:<name>`, `pgb:<name>:db:…`, `pgb:<name>:pool:…` | PgBouncer, its databases and pools |
| `be:<node number>` | Pgpool backend |

### What depends on what {#dependencies}

| Feature | Source | Retention |
|---|---|---|
| Charts on server pages, the **Size growth** and **Row count growth** criteria in **Top-k**, the period on the **Unused** tab of **Index management** | `metrics` | `PGSCOPE_METRICS_RETENTION_DAYS` |
| The **History** tab in **Alerts** and the **Detected changes** list | `events` | `PGSCOPE_METRICS_RETENTION_DAYS`; the interface shows the latest 200 events |
| Picking a past report in the top bar: queries, backends, locks, plans, logs and diagnostics at that moment | `reports` | `PGSCOPE_REPORT_RETENTION_DAYS` |
| Current page data, diagnostics, AI chat, comparison with the previous report for change alerts | latest rows of `reports` | the latest report of each source is always kept |
| Server list and Inspector | `servers` | as long as the server exists |

> [!NOTE]
> The report list in the server top bar shows at most the 500 most recent reports from the last 30 days. With a report every 5 minutes that is about 41 hours. Older reports are kept until they expire, but you cannot pick them in the interface.

## Retention {#retention}

| Variable | Default | What it limits |
|---|---|---|
| `PGSCOPE_METRICS_RETENTION_DAYS` | `90` | time series (`metrics`) and event history (`events`), in days |
| `PGSCOPE_REPORT_RETENTION_DAYS` | `14` | full reports (`reports`), in days |

How the cleanup works:

- The background cleanup runs right after pgscope starts and then again one hour after the previous pass finishes.
- It deletes `metrics` and `events` rows older than `PGSCOPE_METRICS_RETENTION_DAYS` days and reports older than `PGSCOPE_REPORT_RETENTION_DAYS` days. Age is measured from the report time, that is, the collection time on the host where pgmetrics ran.
- **The latest report of each source is never deleted**, even if it is older than the limit. A source is the server itself and each of its PgBouncers. A server whose collection has stopped therefore keeps showing its last state.
- The same pass deletes expired sign-in sessions.
- Cleanup errors go to the pgscope log with the `retention:` prefix.
- The variables are read at startup: restart pgscope after changing them.

Not deleted automatically: the servers themselves (even if reports stopped long ago), agent records, pending invitations (they never expire) and the current alert state. How to remove them by hand is described in [Deleting data](#deleting).

> [!WARNING]
> Set retention to positive integers. `0` or a negative number does not disable the cleanup — it does the opposite: with `PGSCOPE_METRICS_RETENTION_DAYS=0` every pass deletes all time series and all history, and with `PGSCOPE_REPORT_RETENTION_DAYS=0` only the latest report of each source survives. A non-numeric value (for example `30d`) is ignored and the default applies.

Choosing the periods:

- `PGSCOPE_METRICS_RETENTION_DAYS` should be no shorter than the longest period you use: the **30d** chart range needs at least 30 days, and the **in the last 90 days** option in **Index management** needs at least 90.
- `PGSCOPE_REPORT_RETENTION_DAYS` sets how many days back you can open a full report (subject to the report list limit described above). Reports are compressed, but on servers with thousands of tables each one takes noticeable space.

After lowering a retention period, the next pass deletes a lot of rows. PostgreSQL reuses the freed space, but the table files do not shrink by themselves; see [Reclaiming disk space](#reclaim-space).

## Storage size {#sizing}

### What drives the size {#size-drivers}

- **`metrics`**: rows per day = objects per report × reports per day. The objects of a PostgreSQL report are the server itself and every database, table, index, query from `pg_stat_statements` (pgmetrics takes 100 queries by default), user function (if `track_functions` is on), tablespace, standby and replication slot. In a PgBouncer report the objects are the pooler itself, its databases and pools; in a Pgpool report, Pgpool itself and its backends.
- **`reports`**: average compressed report size × reports per day × `PGSCOPE_REPORT_RETENTION_DAYS`, plus the latest report of each source.
- **`events`** is usually small: a row is added only when the set of triggered alerts changes or a change is detected.

Example. A server with 2,000 tables, 3,000 indexes and 100 queries gives about 5,100 objects. With a report every 5 minutes (288 reports per day) that is about 1.47 million `metrics` rows per day and about 132 million rows over 90 days. If a row takes 400 bytes including indexes (an assumption for this example; get your own figure with the second query below), the `metrics` table will take about 49 GiB.

### Checking the actual size {#size-check}

Run these queries in the pgscope storage database, for example `psql "postgres://pgscope@dbhost/pgscope"`.

Size of the pgscope tables:

```sql
SELECT c.relname AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       c.reltuples::bigint AS approx_rows
FROM pg_class c
WHERE c.relkind = 'r'
  AND pg_table_is_visible(c.oid)
  AND c.relname IN ('metrics', 'reports', 'events', 'servers', 'users', 'sessions', 'shares',
                    'invites', 'alert_rules', 'change_rules', 'notifiers', 'alert_state', 'agents')
ORDER BY pg_total_relation_size(c.oid) DESC;
```

Bytes per `metrics` row including indexes (an estimate based on planner statistics; empty until the table has been analyzed at least once):

```sql
SELECT pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       c.reltuples::bigint AS approx_rows,
       round(pg_total_relation_size(c.oid) / nullif(greatest(c.reltuples, 0), 0)) AS bytes_per_row
FROM pg_class c
WHERE c.oid = 'metrics'::regclass;
```

Objects in the latest report and rows over the last day, per server:

```sql
SELECT s.name,
       (SELECT count(*) FROM metrics m
         WHERE m.server_id = s.id AND m.at = s.last_report) AS objects_per_report,
       (SELECT count(*) FROM metrics m
         WHERE m.server_id = s.id AND m.at > now() - interval '1 day') AS rows_last_day
FROM servers s
ORDER BY rows_last_day DESC;
```

Full reports per server and source (an empty `source` means the server's own reports, otherwise it is the PgBouncer name):

```sql
SELECT s.name, r.source, count(*) AS reports,
       pg_size_pretty(sum(octet_length(r.data))) AS total_compressed,
       pg_size_pretty(avg(octet_length(r.data))::bigint) AS avg_report
FROM reports r
JOIN servers s ON s.id = r.server_id
GROUP BY s.name, r.source
ORDER BY sum(octet_length(r.data)) DESC;
```

To project future size, multiply `rows_last_day` by the time-series retention and by `bytes_per_row`, and multiply `avg_report` by the number of reports within the report retention.

### Reducing the size {#size-reduce}

- **Send reports less often.** Increase the cron interval or the agent's `PGSCOPE_AGENT_INTERVAL`. Doubling the interval halves both `metrics` and `reports`.
- **Collect fewer objects.** pgmetrics has `-c`/`-C` (include or exclude schemas) and `-a`/`-A` (tables) by regular expression, `--omit=…` (for example `--omit=indexes`) and `--statements-limit=N`. See [Sending reports](collect.md). Keep in mind that whatever is not in the report will not appear in charts, diagnostics or alert rules.
- **Shorten retention** (see [Retention](#retention)).
- **Delete servers you no longer need** (see [Deleting data](#deleting)).

## Backup {#backup}

Back up the storage database and your startup settings. The binary and the images can be rebuilt from source.

`pg_dump` takes a consistent snapshot; there is no need to stop pgscope.

Regular installation:

```bash
pg_dump -Fc -d "postgres://pgscope@dbhost/pgscope" -f pgscope-$(date +%F).dump
```

Docker Compose from `deploy/docker-compose.yml` (the database runs in the `db` service):

```bash
cd deploy
docker compose exec -T db pg_dump -U pgscope -Fc pgscope > pgscope-$(date +%F).dump
```

If history can be lost and only accounts, servers, rules, channels and sharing matter, exclude the data of the large tables:

```bash
pg_dump -Fc -d "postgres://pgscope@dbhost/pgscope" \
  --exclude-table-data=metrics --exclude-table-data=reports --exclude-table-data=events \
  -f pgscope-config-$(date +%F).dump
```

After restoring such a backup, charts and history are empty, and server pages show **No report received yet** until the next report arrives.

For large databases the usual PostgreSQL physical backup tools (`pg_basebackup`, WAL archiving) work as well: pgscope keeps everything in one database and has no other backup requirements.

> [!WARNING]
> A backup of the storage database contains password hashes, API keys, session and invitation tokens, and notification channel destinations (Slack webhook URLs, PagerDuty keys). Protect backups as carefully as the database itself: restrict access to them and encrypt them.

## Restore {#restore}

1. Stop pgscope. Otherwise it creates empty tables at startup and the restore trips over them.
2. Create an empty database owned by the pgscope role.
3. Restore the backup.
4. Start pgscope.

Regular installation (`createdb` runs as a superuser, `pg_restore` as the pgscope role):

```bash
sudo systemctl stop pgscope
createdb -U postgres -O pgscope pgscope
pg_restore --no-owner -d "postgres://pgscope@dbhost/pgscope" pgscope-2026-10-26.dump
sudo systemctl start pgscope
```

Docker Compose (`dropdb` deletes the current database with all its data):

```bash
cd deploy
docker compose stop pgscope
docker compose exec -T db dropdb -U pgscope pgscope
docker compose exec -T db createdb -U pgscope pgscope
docker compose exec -T db pg_restore -U pgscope --no-owner -d pgscope < pgscope-2026-10-26.dump
docker compose start pgscope
```

After a restore:

- Accounts, API keys and sessions come back with the database. Collectors keep working unchanged, and users stay signed in if their session has not expired.
- The alert state is restored as of the backup. The first new report is compared with it, so you may receive notifications about triggered or cleared alerts.
- Reports that collectors failed to send while pgscope was stopped are not sent later: charts will have a gap.

## Deleting data {#deleting}

### A server {#delete-server}

The server owner deletes a server on the **Team & settings** page: in the **Delete server data** card, type the server name and click **Delete server**. This deletes reports, time series, alert rules, change alert settings, notification channels, alert state and history, sharing and invitations. Team members cannot delete a server. See [The Team & settings page](teams.md#server-settings).

> [!WARNING]
> Stop collection first: remove the cron job or the `pgscope.enable` label from the container (labels change only when the container is recreated). Otherwise the next report under the same name creates the server again — empty, without rules or notification channels.

If the owner is unavailable, an administrator can delete the server in the storage database. All related data is deleted by cascade. Here `42` is the server id, visible in the page address `#/s/42`:

```sql
DELETE FROM servers WHERE id = 42;
```

### A single PgBouncer {#delete-pgbouncer}

You cannot delete a single PgBouncer in the interface. The latest report of every source is always kept, so a decommissioned pooler stays in the server menu until its data is deleted by hand. Delete it in the storage database (here `42` is the server id and `pgb-1` is the PgBouncer name):

```sql
BEGIN;
DELETE FROM reports WHERE server_id = 42 AND source = 'pgb-1';
DELETE FROM metrics WHERE server_id = 42 AND (obj = 'pgb:pgb-1' OR starts_with(obj, 'pgb:pgb-1:'));
COMMIT;
```

### An account {#delete-account}

**Profile** → **Danger zone** → **Delete account**. For an owner, all their servers with all data and their agents are deleted together with the account. For a team member, only the account is deleted; the owners' servers are not affected. See [Profile](teams.md#profile).

### Agents and invitations {#delete-other}

- The record of an agent that has not reported for more than 3 minutes is removed with the **Remove** button on the **Agents** page (see [The Agents page](docker.md#agents-page)). A running agent reappears with its next heartbeat.
- A pending invitation is cancelled by the server owner with the trash icon (**Cancel invitation**) next to the invitation in the **Team sharing** card on the **Team & settings** page. Invitations do not expire on their own.

### Reclaiming disk space {#reclaim-space}

After deleting a large amount of data (a shorter retention, a deleted server) autovacuum marks the space as free and PostgreSQL fills it with new rows. The table files do not shrink. To return space to the operating system:

- `VACUUM FULL metrics;` rewrites the whole table. The table is locked for the entire time, report ingestion waits, and collectors may get timeout errors. You need free disk space roughly the size of the new copy of the table.
- The `pg_repack` extension, if installed in the storage database, does the same without a long lock.

## Moving to another host {#migration}

All pgscope state lives in the storage database, so a move comes down to moving the database and the startup settings.

If the database stays where it is, start pgscope on the new host with the same environment variables and switch the address to it (DNS or reverse proxy).

If the database moves too:

1. Move the binary or the images. In an air-gapped network images are moved as files: `docker save` on the old host and `docker load` on the new one.
2. Prepare the same configuration on the new host: the systemd unit file or the `deploy` directory with its `.env` file.
3. Stop pgscope on the old host. From this moment reports are not accepted.
4. Back up the database and restore it on the new host (see [Backup](#backup) and [Restore](#restore)).
5. Start pgscope on the new host and check sign-in and incoming reports.
6. If the address changed, switch the collectors (see below).

Example for Docker Compose:

```bash
# old host
cd deploy
docker compose stop pgscope
docker compose exec -T db pg_dump -U pgscope -Fc pgscope > pgscope.dump

# new host: the same deploy directory with the .env file and a copy of pgscope.dump
cd deploy
docker compose up -d --wait db
docker compose exec -T db pg_restore -U pgscope --no-owner -d pgscope < pgscope.dump
docker compose up -d
```

If the pgscope address changes:

- Set the new `PGSCOPE_BASE_URL`: links in notifications and invitations are built from it.
- Update `--base-url` in every cron job and `PGSCOPE_URL` on the agents. API keys stay the same.
- The session cookie is tied to the host name, so users have to sign in again.
- Invitation emails already sent contain the old address. Invitation tokens remain valid on the new host: replace the address in the link or copy the link again on the **Team & settings** page.

Reports sent during the downtime are lost, leaving a gap in the charts. Keep the move window short.
