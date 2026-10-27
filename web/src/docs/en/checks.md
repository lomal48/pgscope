# Checks reference

This reference lists every automatic check in pgscope: the report checks whose results appear on the **Health issues** tab of the **Diagnostics** page, and the configuration check rules that appear on the **Configuration check** tab of the **Diagnostics** and **Configuration** pages. For each check it gives the exact trigger condition, the severity, the text pgscope shows and what to do.

## How the checks work {#how-it-works}

- The checks run on the pgscope server every time you open the **Diagnostics** page or the **Configuration check** tab, against the report selected in the server bar (the latest by default). The results are not stored anywhere and are produced in the user's interface language.
- The thresholds are built into pgscope and cannot be configured. The checks do not send notifications: to get alerts with your own thresholds, create [alert rules](alerts.md).
- The check results are also passed to the [AI chat](monitoring.md#ai-chat) context, if the chat is enabled.
- Severity: **Critical** needs urgent action, **Warning** is a problem worth fixing, **Info** is a suggestion. The top of the **Diagnostics** page shows the **Critical**, **Warnings** and **Suggestions** counters; issues are sorted from critical to suggestions.
- Each issue has a title, a category, an explanation, a list of affected objects (expanded with **Show details**; already expanded for critical issues) and a **View** button that opens the related server page. The list holds at most 50 objects; the rest are summarized as "… and N more".
- Many checks use cumulative PostgreSQL counters (cache hits, rollbacks, temp files, deadlocks, scans, checkpoints). They cover the whole time since the last statistics reset, not the last few minutes: a problem fixed a week ago may keep firing until the counters are reset (`pg_stat_reset()`).

The page itself is described in [Diagnostics](monitoring.md#diagnostics).

## Report checks {#issues}

The checks below are grouped by category — the label pgscope shows next to the issue title. The "Where to look" column is the server page that shows the details.

### Vacuum {#diag-vacuum}

XID age is computed as the database's `age(datfrozenxid)` as a percentage of 2,147,483,647. Each database falls only into the most severe of the three checks. Object list entries: "database: XID age N (P% of the wraparound limit)".

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Transaction ID wraparound risk** | Critical | the database's XID age is above 75% | "These databases are close to transaction ID wraparound. Run VACUUM FREEZE urgently: once the limit is reached, PostgreSQL stops accepting writes." | **Vacuum** |
| **High XID age** | Warning | above 40% and not above 75% | "The frozen XID age is growing. Check whether autovacuum is keeping up." | **Vacuum** |
| **Anti-wraparound autovacuum is due** | Info | not above 40%, but the age exceeds `autovacuum_freeze_max_age` | "XID age exceeds autovacuum_freeze_max_age, so an aggressive autovacuum will run in these databases." | **Vacuum** |

What to do: find what holds back freezing (long transactions, prepared transactions, replication slots with `xmin`) and run `VACUUM (FREEZE)` on the oldest tables. The procedure is in [XID age and wraparound](server.md#xid-age). The info check is not alarming by itself: aggressive autovacuum is a normal mechanism, but on large tables it creates noticeable I/O load.

### Replication {#diag-replication}

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Inactive replication slots** | Warning | a slot has `active = false`. List entries: "slot (type), retaining N of WAL"; just "slot (type)" if the slot has no `restart_lsn` | "Inactive slots prevent removal of WAL files and old row versions, which can fill up the disk. Drop the slots you no longer need." | **Replication** |
| **Standbys are lagging** | Warning | on the primary: the standby's known `replay_lsn` is more than 1 GiB behind the current position, or `replay_lag` is above 60 s. List entries: "standby: N behind, replay lag M s"; "— behind" if the position is unknown | "These standbys are more than 1 GiB or 60 seconds behind." | **Replication** |
| **Standby is not keeping up with WAL replay** | Warning | on a standby: the last transaction was replayed more than 300 s ago (relative to the report time), and the receive LSN is known and ahead of the replay LSN | "The last transaction was replayed … ago, and the received WAL has not been fully replayed yet." | **Replication** |
| **WAL replay is paused** | Warning | on a standby `pg_is_wal_replay_paused()` returns true | "Run pg_wal_replay_resume() to resume WAL replay." | **Replication** |
| **Logical replication subscription errors** | Warning | a subscription has `apply_error_count` or `sync_error_count` above 0; one issue per subscription | "Subscription “…” in database “…” has N apply and M sync errors." | **Replication** |

> [!NOTE]
> The "retaining N of WAL" amount and the byte lag are computed from the slot's `restart_lsn` and the standby's `replay_lsn`. If the position is missing (a slot for which WAL has not been reserved yet or has been lost; walsender connections that do not report a replay position, such as `pg_basebackup` and `pg_receivewal`), no amount is shown, and such a connection appears in **Standbys are lagging** only by `replay_lag`. The [**Replication**](server.md#replication) page shows an unknown position as "—".

What to do: drop slots you do not need (`SELECT pg_drop_replication_slot('name');`) and set `max_slot_wal_keep_size`; for a lagging standby check the network, the disk and replay conflicts; look for subscription errors in the subscriber's log. Details are in [Replication](server.md#replication).

### WAL {#diag-wal}

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **WAL archiving failure** | Critical | `pg_stat_archiver.failed_count` is above 0, and the last failure is later than the last successful archiving | "The last archive attempt (file) failed. Check archive_command and the archive destination." | **WAL & checkpoints** |
| **WAL files waiting to be archived** | Warning | more than 10 files are ready for archiving (`.ready`) | "N WAL files are ready for archiving but not yet archived. Archiving is falling behind." | **WAL & checkpoints** |
| **Too many WAL files** | Warning | the number of files in `pg_wal` multiplied by 16 MiB exceeds twice `max_wal_size` | "pg_wal holds N files (≈size), more than twice max_wal_size. Check for inactive slots, archiving failures and wal_keep_size." | **WAL & checkpoints** |
| **Checkpoints are too frequent** | Warning | more than 10 requested checkpoints, and more requested than timed ones (counters from `pg_stat_checkpointer` on PostgreSQL 17+, otherwise `pg_stat_bgwriter`) | "Requested checkpoints: N, timed: M. Increase max_wal_size to smooth out I/O spikes." | **WAL & checkpoints** |

What to do: if archiving fails, run `archive_command` by hand and check space and permissions at the archive — while archiving is broken, WAL piles up in `pg_wal`. Details are in [WAL and checkpoints](server.md#wal).

### Backends {#diag-backends}

These checks count client backends (`backend_type = 'client backend'`) from `pg_stat_activity` at report time, including pgmetrics' own connection. Object list entries: "PID N (role@database): query" — the query text is cut to 80 characters and ends with "…".

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Connections are close to max_connections** | Warning above 80% in use; Critical above 95% | the number of client backends exceeds 80% of `max_connections` | "N of M connections in use (P%). Consider using a connection pooler." | **Backends** |
| **Long-running transactions** | Warning | a backend's transaction has been open for more than 5 minutes | "Transactions open for more than 5 minutes hold back vacuum and can cause bloat." | **Backends** |
| **Idle in transaction** | Warning | `idle in transaction` state (including `idle in transaction (aborted)`) for more than 60 s | "These backends opened a transaction and have been idle for over a minute. Set idle_in_transaction_session_timeout." | **Backends** |
| **Notification queue is filling up** | Warning | `pg_notification_queue_usage()` is above 0.5 | "The LISTEN/NOTIFY queue is N% full: a listener is not consuming notifications." | **Overview** |

What to do: when connections run short, put a connection pooler (PgBouncer) in front instead of raising `max_connections`; find long and abandoned transactions on the [**Backends**](activity.md#backends) page and terminate them (`SELECT pg_terminate_backend(PID);`), then fix transaction handling in the application. The notification queue is filled by a listener that ran `LISTEN` and does not read notifications, or by a long transaction; when the queue is full, `NOTIFY` starts failing.

### Locks {#diag-locks}

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Backends waiting for locks** | Warning | a backend has `wait_event_type = 'Lock'` | "These backends are blocked by other transactions." | **Locks** |
| **Deadlocks detected** | Info | the database's `deadlocks` counter is above 0. List entries: "database — deadlocks: N" | "Deadlocks have occurred since the last statistics reset." | **Locks** |
| **Deadlocks in logs** | Warning | pgmetrics found deadlock messages in the log during the collection window. List entries: time (in UTC) and the first line of the details | "Deadlocks were found in the PostgreSQL log." | **Logs** |

What to do: find the lock chain and the session at its head on the [**Locks**](activity.md#locks) page. Deadlocks are fixed in the application: transactions should lock rows and tables in the same order. The log-based check works only if pgmetrics reads the log (see [Logs](server.md#logs)).

### Databases {#diag-databases}

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Data checksum failures** | Critical | the database's `checksum_failures` is above 0 | "Checksum failures indicate on-disk data corruption." | **Databases** |
| **Low cache hit ratio** | Warning | `blks_hit + blks_read` is above 10,000 and the `blks_hit` share is below 90% | "The shared buffer cache hit ratio is below 90%. Consider increasing shared_buffers or RAM." | **Databases** |
| **High rollback rate** | Info | more than 1000 commits and rollbacks together, and a commit ratio below 90% | "Many transactions are rolled back. Check the application for errors." | **Databases** |
| **Heavy temp file usage** | Info | the database's `temp_bytes` is above 1 GiB | "Queries are spilling to disk. Consider increasing work_mem." | **Databases** |

What to do: on checksum failures, check the disks and the PostgreSQL log immediately and make sure you have working backups. With a low cache hit ratio, first find the queries that read many blocks from disk (the [**Queries**](activity.md#queries) page): an index often helps more than memory. Temp files come from sorts and hash operations that did not fit in `work_mem`; raise it selectively (for a role or a session) rather than globally — `work_mem` is allocated per operation of every query.

### Tables {#diag-tables}

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Bloated tables** | Warning | there is a bloat estimate, the table is larger than 10 MiB, and bloat exceeds 30% of its size | "Bloat in these tables exceeds 30%. Consider VACUUM FULL, pg_repack or tuning autovacuum." | **Tables** |
| **Many dead rows** | Warning | `n_dead_tup` is above 10,000 and above 20% of live plus dead rows | "autovacuum is not keeping up with these tables." | **Vacuum** |
| **Tables never vacuumed or analyzed** | Info | more than 1000 live rows and not a single manual or automatic vacuum or analyze | "These tables may be missing planner statistics." | **Vacuum** |
| **Large tables read by sequential scans** | Info | larger than 100 MiB, `seq_scan` above 1000 and above `idx_scan` | "These tables may be missing an index." | **Tables** |
| **Tables without a primary key or unique index** | Info | a regular table (`relkind = 'r'`) with more than 1000 live rows and no index with `UNIQUE` in its definition | "Rows cannot be uniquely identified, so logical replication of UPDATE/DELETE does not work." | **Tables** |

What to do: `VACUUM FULL` locks the table for its whole run, `pg_repack` rebuilds it without a long lock; either way, tune autovacuum so the bloat does not come back (see [Dead rows](server.md#dead-rows)). Run `ANALYZE` on tables without statistics. For tables with sequential scans, find the queries that hit them and add an index. If you do not need logical replication, a table without a key is not an error, but a key still makes maintenance and data fixes easier.

### Indexes {#diag-indexes}

| Check | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Unused indexes** | Warning | `idx_scan = 0`, no `UNIQUE` in the definition, larger than 1 MiB. List entries: "database.schema.index (size)" | "These non-unique indexes have not been scanned since the last statistics reset. They slow down writes; consider dropping them." | **Index management** |
| **Duplicate indexes** | Warning | indexes in the same database have the same definition after removing `CREATE [UNIQUE] INDEX [CONCURRENTLY] name ON`, and one of them can be dropped without losing a constraint (the rules are in [Duplicates](objects.md#duplicate-indexes)). List entries: "database.schema.index duplicates database.schema.index" — first the index you can drop, then the one to keep | "Each of these indexes duplicates another one and can be dropped. Unique indexes, including those of primary keys and constraints, are not proposed for dropping while a non-unique duplicate exists." | **Index management** |
| **Bloated indexes** | Warning | there is a bloat estimate, larger than 10 MiB, bloat above 30% | "Rebuild them with REINDEX CONCURRENTLY." | **Index management** |

> [!WARNING]
> The **Unused indexes** advice is based only on `idx_scan = 0` on the current server. It does not account for index use on standbys (each standby has its own statistics), for counters zeroed by `pg_stat_reset()` or a crash restart, or for rare queries. Exclusion-constraint indexes (`*_excl`) are non-unique and are not filtered out of **Unused indexes**, but PostgreSQL will not let you drop them. **Duplicate indexes** recognizes constraint indexes only by their default names (`*_pkey`, `*_key`, `*_excl`), because pgmetrics reports no constraints. Read [Index management](objects.md#index-management) before dropping anything.

### Other checks {#diag-other}

| Check (category) | Severity | When it fires | pgscope text | Where to look |
|---|---|---|---|---|
| **Extension updates available** (**Extensions**) | Info | the installed extension version differs from the available one (`default_version`). List entries: "database.extension: installed → available" | "Run ALTER EXTENSION … UPDATE in each database." | **Extensions & more** |
| **Disabled triggers** (**Objects**) | Info | the report contains disabled triggers | "These triggers are disabled." | **Extensions & more** |
| **Disk almost full** (**Disk**) | Warning above 80% used; Critical above 90% | a tablespace's file system is more than 80% full; one issue per tablespace, so `pg_default` and `pg_global` on the same disk produce two identical issues. Works only if pgmetrics collected disk usage (Linux, a local connection on the database host) | "The disk holding tablespace “…” is N% full (… free)." | **Tablespaces** |
| **Unsupported PostgreSQL version** (**Server**) | Warning | `server_version_num` below 140000, that is, PostgreSQL 13 and earlier | "PostgreSQL X no longer receives security fixes. Plan an upgrade." | **Overview** |
| **Additional superuser roles** (**Security**) | Info | there are roles with `SUPERUSER` and `LOGIN`, other than `postgres` and roles whose names start with `rds` | "Superuser roles that can log in. Reduce their privileges where possible." | **Roles** |
| **No query statistics** (**Queries**) | Info | the report has no `pg_stat_statements` rows at all | "pg_stat_statements is not installed or not readable. Add it to shared_preload_libraries and run CREATE EXTENSION pg_stat_statements." | **Queries** |

> [!NOTE]
> The PostgreSQL community supports version 14 until November 2026. The threshold of the **Unsupported PostgreSQL version** check in the current pgscope version is 14, so once PostgreSQL 14 reaches end of life this check will not flag it. Plan your upgrade ahead of time.

What to do: when the disk fills up, first look for what is growing — WAL (slots, archiving), temp files, bloated tables — and use the [Object growth](objects.md#growth) ranking. **No query statistics** fires if the `pg_stat_statements` extension is not created in any of the databases pgmetrics visits, if the library is not loaded through `shared_preload_libraries` (the query against the view fails), if the view is empty (for example, right after `pg_stat_statements_reset()`), and if pgmetrics runs with `--omit=statements` or `--omit=extensions` (pgmetrics looks for the extension in the extension list and does not read the statistics without it); the setup is described in [Preparing PostgreSQL](postgres.md).

## Configuration check {#config-check}

The configuration check rules compare values from `pg_settings` in the report with recommended ones. A recommendation is shown only if the setting is present in the report. In the **Current** column, memory settings (`shared_buffers`, `effective_cache_size`, `wal_buffers`, `work_mem`, `maintenance_work_mem`, `max_wal_size`, `min_wal_size`) are shown in byte units, the rest as in `pg_settings`.

On the **Diagnostics** page the recommendations are grouped into four categories — **Security**, **Data Safety**, **Performance**, **Reliability**; on the **Configuration** page they are shown as a single table sorted by severity.

### Security {#cfg-security}

| Setting | Severity | When it fires | pgscope recommendation |
|---|---|---|---|
| `ssl` | Warning | `off` | "SSL is off: connections and passwords are sent in plain text. Enable ssl." |
| `password_encryption` | Warning | `md5` | "Use scram-sha-256: md5 password hashing is weak and deprecated." |
| `listen_addresses` | Info | `*` | "The server accepts connections on all interfaces; restrict them if clients only connect from specific networks." |
| `log_connections` | Info | `off` | "Enable to log connection attempts for auditing." |
| `log_disconnections` | Info | `off` | "Enable to log session durations." |
| `row_security` | Info | `off` | "Row-level security is disabled server-wide." |

After switching `password_encryption` to `scram-sha-256`, existing passwords stay in md5 format until they are set again; switch the methods in `pg_hba.conf` to `scram-sha-256` after the passwords are changed. `ssl = on` needs a server certificate and key.

### Data safety {#cfg-data-safety}

| Setting | Severity | When it fires | pgscope recommendation |
|---|---|---|---|
| `fsync` | Critical | `off` | "fsync is off: a crash or power loss can corrupt the database. Turn it on." |
| `full_page_writes` | Critical | `off` | "Partially written pages after a crash can corrupt data. Turn this setting on." |
| `synchronous_commit` | Warning | `off` | "Recently committed transactions can be lost in a crash." |
| `data_checksums` | Info | `off` | "Checksums detect data corruption in storage; enable them at initdb or with pg_checksums." |
| `wal_level` | Warning | `minimal` | "Point-in-time recovery and replication need wal_level replica or higher." |
| `archive_mode` | Info | `off`, and the server is not a standby | "WAL archiving is off, so point-in-time recovery is not possible." |

`pg_checksums --enable` works only on a stopped cluster. `synchronous_commit = off` does not corrupt data, but the last transactions acknowledged to the client can be lost in a crash — acceptable only for data you can restore.

### Performance {#cfg-performance}

| Setting | Severity | When it fires | pgscope recommendation |
|---|---|---|---|
| `shared_buffers` | Info | if the report has system metrics, below 1/8 of host memory (the sum of used and free memory, buffers and cache); otherwise not above 128 MiB | "Typically 25% of RAM (X here)." or, without system metrics, "Still the 128 MiB default; typically set to 25% of RAM." |
| `effective_cache_size` | Info | exactly 4 GiB (the default) | "Still the default; set it to about 50–75% of RAM so the planner favors index scans." |
| `work_mem` | Warning | not above 4 MiB, and all databases together wrote more than 1 GiB to temp files | "Queries wrote X to temp files; increase work_mem for sorts and hash operations." |
| `maintenance_work_mem` | Info | not above 64 MiB | "Still the 64 MiB default; a larger value speeds up VACUUM and CREATE INDEX." |
| `random_page_cost` | Info | `4` | "The default is tuned for HDDs; use 1.1 for SSDs." |
| `checkpoint_completion_target` | Info | below 0.9 | "Use 0.9 to spread checkpoint I/O more evenly." |
| `track_io_timing` | Info | `off` | "Enable to see I/O time per query (the overhead is low on modern systems)." |
| `effective_io_concurrency` | Info | `0` or `1` | "Use around 200 for SSDs to prefetch more blocks." |
| `max_connections` | Warning | above 300 | "Many connections consume memory and CPU; use a connection pooler such as PgBouncer." |
| `shared_preload_libraries` | Info | does not contain `pg_stat_statements` | "Add pg_stat_statements to track query performance." |

Changing `shared_buffers`, `max_connections` and `shared_preload_libraries` requires a PostgreSQL restart. The `track_io_timing` overhead on a given machine can be measured with the `pg_test_timing` utility. `work_mem` is allocated per sort or hash operation, so a global increase is multiplied by the number of concurrent queries.

### Reliability {#cfg-reliability}

| Setting | Severity | When it fires | pgscope recommendation |
|---|---|---|---|
| `autovacuum` | Critical | `off` | "autovacuum is off: tables bloat and the risk of transaction ID wraparound grows." |
| `track_counts` | Critical | `off` | "autovacuum needs track_counts to decide which tables to vacuum." |
| `log_min_duration_statement` | Info | `-1` | "Log slow queries (for example, over 1000 ms) to find problematic ones." |
| `idle_in_transaction_session_timeout` | Info | `0` | "Set a timeout so abandoned transactions do not hold locks or block vacuum." |
| `log_checkpoints` | Info | `off` | "Log checkpoints to diagnose I/O spikes." |
| `log_lock_waits` | Info | `off` | "Log lock waits longer than deadlock_timeout." |
| `log_autovacuum_min_duration` | Info | `-1` | "Log autovacuum runs (for example, over 1 s) to see the vacuum history." |
| `hot_standby_feedback` | Info | `off`, and the server is a standby | "Queries on this standby can be canceled due to replication conflicts." |
| `max_slot_wal_keep_size` | Warning | the server has replication slots, and the value is `-1` | "Slots can retain unlimited WAL and fill up the disk; set a limit." |

`hot_standby_feedback = on` protects queries on the standby from cancellation but lets them hold back vacuum on the primary — long queries on the standby then cause table bloat on the primary.

An example `postgresql.conf` fragment that addresses the typical recommendations (the values are a starting point; tune them for your workload and hardware):

```ini
password_encryption = 'scram-sha-256'
ssl = on
random_page_cost = 1.1
effective_io_concurrency = 200
track_io_timing = on
shared_preload_libraries = 'pg_stat_statements'
log_min_duration_statement = 1000
log_checkpoints = on
log_lock_waits = on
log_autovacuum_min_duration = 1000
idle_in_transaction_session_timeout = '10min'
max_slot_wal_keep_size = '50GB'
```

## Limitations {#limitations}

- The checks look at a single report — a snapshot at collection time. They do not see short spikes between reports (brief locks, connection peaks); use charts and [alert rules](alerts.md) for those.
- The bloat estimate is approximate (pgmetrics uses the check_postgres formula) and is missing with `--omit=bloat`; the bloat checks then do not fire.
- The **Too many WAL files** check counts every WAL file as 16 MiB. If the cluster was created with a different `--wal-segsize`, the estimate is off.
- pgmetrics flags change the set of checks:
  - `--omit=indexes` — the report has no indexes: the index checks do not fire, and **Tables without a primary key or unique index** fires for every regular table with more than 1000 live rows;
  - `--omit=indexdefs` — indexes are present but without definitions: **Tables without a primary key or unique index** fires the same way, **Unused indexes** cannot exclude unique indexes, and **Duplicate indexes** does not fire;
  - `--omit=tables` — there are no tables, indexes or disabled triggers, and the checks based on them do not fire;
  - `-S` / `--no-sizes` — there are no sizes, so the checks with a size threshold do not fire: bloated tables and indexes, large tables read by sequential scans, unused indexes;
  - `--omit=statements` and `--omit=extensions` trigger **No query statistics**, `--omit=log` turns off **Deadlocks in logs**, `--omit=triggers` turns off **Disabled triggers**.
- The **Disk almost full** check works only when disk usage data is available: pgmetrics collects it on Linux over a local connection on the database host. It is missing for managed cloud databases and in reports from the pgscope agent for Docker.
- The **Additional superuser roles** check excludes only the `postgres` role and roles with the `rds` prefix; it will list service superusers of other platforms.
