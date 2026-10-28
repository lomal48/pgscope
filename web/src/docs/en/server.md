# Replication, WAL, vacuum and system

This page covers the **Server** section of a PostgreSQL server: **Replication**, **WAL & checkpoints**, **Vacuum**, **Configuration**, **System** and **Logs**. For each page it explains what it shows, where the data comes from, which values should worry you and what to do.

Like the other server pages, these pages are built from the report selected in the server bar (the latest by default), and the **Over time** charts from the stored time series for the selected period (see [The interface](ui.md)). Lags, ages and "ago" times are computed relative to the moment the report was collected, not to the current time.

## Replication {#replication}

The **Replication** page shows physical streaming replication, replication slots and logical replication. The badge next to the title is the server's role at the time of the report: **Primary** or **Standby**. Every standby you send reports from appears in pgscope as a separate server with its own **Replication** page.

### On the primary {#replication-primary}

The **Standbys (N)** card lists the connected standbys from `pg_stat_replication`; with no standbys it shows **No connected standbys**.

| Column | What it shows |
|---|---|
| **Standby** | the standby's `application_name`, or, if empty, the client address or the walsender PID |
| **Client** | the standby's host name (`client_hostname`, filled when `log_hostname = on`), or its address if there is none |
| **State** | `state`: `streaming` is shown in green, the others (`catchup`, `startup`, `backup`…) in yellow |
| **Sync state** | `sync_state`: `async`, `sync`, `potential`, `quorum` |
| **Write lag**, **Flush lag**, **Replay lag** | how many bytes the standby's `write_lsn`, `flush_lsn` and `replay_lsn` are behind the primary's current WAL position at report time; "—" if the standby did not report that position |
| **Replay lag time** | `replay_lag` from `pg_stat_replication` in whole seconds; if PostgreSQL reports no value (for example, the standby has caught up and no WAL is being sent), zero is shown |
| **Last reply** | how long ago the standby last replied to the primary (`reply_time`, PostgreSQL 12+; **never** on older versions) |

The **Standby lag over time** block, with a standby selector on the right, shows the "Standby lag: …" chart (write, flush and replay in bytes) and the "Standby lag time: …" chart (in seconds) for the selected standby. A standby's series is stored under its name from the **Standby** column, so give standbys a stable `application_name` (in `primary_conninfo`), otherwise the history breaks when the address or PID changes.

How to read it: write lag grows with network problems, flush lag with a slow standby disk, replay lag when the standby cannot apply WAL fast enough or replay is held back by conflicts with queries on the standby. The diagnostics report standbys that are more than 1 GiB or 60 seconds behind (see [Checks reference](checks.md#diag-replication)).

> [!NOTE]
> The standby list shows every walsender connection, including `pg_basebackup` and `pg_receivewal`. Such clients, like a standby that is still starting, do not report every position (at least the replay position is missing). The table shows "—" for them, the "Standby lag: …" chart gets no points for them (the "Standby lag time: …" chart still does), the byte-lag alert rules on the primary skip them, and they appear in **Standbys are lagging** only when `replay_lag` is above 60 seconds.

### On a standby {#replication-standby}

When the server is in recovery, the page shows these cards at the top:

| Card | What it shows |
|---|---|
| **Receive LSN** | the last received WAL position (`pg_last_wal_receive_lsn()`) |
| **Replay LSN** | the last replayed position (`pg_last_wal_replay_lsn()`) |
| **Not yet replayed** | the difference between them in bytes: WAL already received but not yet applied; "—" if the receive LSN is unknown (the standby does not stream WAL, for example it only restores WAL from the archive) |
| **Last transaction** | how long ago the last transaction was replayed |
| **Replay** | **Running** or **Paused** (`pg_is_wal_replay_paused()`) |
| **WAL receiver** | the walreceiver status; `streaming` is normal, **not running** means the receiver is down |

The **WAL receiver** card (data from `pg_stat_wal_receiver`): **Primary host**, **Slot**, **Received LSN**, **Flushed LSN**, **Timeline**, **Latency**, **Last message sent**, **Last message received** and **Connection** — the `conninfo` string (PostgreSQL hides the password in it).

**Over time** charts: **Replay lag** (WAL received but not replayed, in bytes) and **Time since last replayed transaction** (in seconds). Without a receive LSN the **Replay lag** chart gets no points.

> [!NOTE]
> **Time since last replayed transaction** also grows when the primary simply has no writes: there is nothing to replay. Rely on the lag in bytes. The diagnostics take this into account: the **Standby is not keeping up with WAL replay** check fires only if the last transaction was replayed more than 5 minutes ago, the receive LSN is known and the received WAL has not been fully replayed.

If replay is paused, resume it on the standby:

```sql
SELECT pg_wal_replay_resume();
```

### Replication slots {#replication-slots}

The **Replication slots (N)** block shows all slots on the server.

| Column | What it shows |
|---|---|
| **Slot** | slot name |
| **Type** | `physical` or `logical` |
| **Plugin** | logical decoding plugin (for logical slots) |
| **Database** | the logical slot's database |
| **Active** | **active** if a consumer is connected to the slot, otherwise **inactive** |
| **WAL status** | `wal_status`: `reserved`, `extended`, `unreserved` or `lost` |
| **Retained WAL** | how much WAL the slot retains: the current position minus `restart_lsn`; "—" if `restart_lsn` is empty (WAL has not been reserved for the slot yet or has been lost) |
| **Safe WAL size** | `safe_wal_size` — how much more WAL can be written before the slot loses data; filled when `max_slot_wal_keep_size` is set |
| **xmin** | the slot's `xmin` or `catalog_xmin` |

Below the table is the "WAL retained by slot …" chart for the slot chosen in the selector. A slot without `restart_lsn` gets no points on it.

An inactive slot is a common cause of a full disk: PostgreSQL does not remove WAL until the slot's consumer has read it. In addition, the slot's `xmin` and `catalog_xmin` stop vacuum from removing old row versions, which leads to bloat and growing XID age. What to do:

- if the slot's consumer is no longer needed, drop the slot:

```sql
SELECT pg_drop_replication_slot('old_replica');
```

- if it is needed, restore the standby's or subscriber's connection;
- set `max_slot_wal_keep_size` to cap the WAL that slots can retain. A slot that exceeds the limit can lose the WAL it needs (status `lost`), and the standby or subscription will have to be rebuilt, but the primary's disk will not fill up.

For alerts, use the **Number of inactive replication slots**, **Replication replay lag on primary** and **Replay lag on standby** metrics (see [Alert rules](alerts.md)).

### Publications and subscriptions {#logical-replication}

If the server has logical replication objects, the page shows these blocks:

- **Publications** — **Publication**, **Database**, **All tables** (a `FOR ALL TABLES` publication), **Tables** (number of tables) and **Operations** (`insert`, `update`, `delete`);
- **Subscriptions** — **Subscription**, **Database**, **Enabled**, **Tables**, **Workers**, **Received LSN**, **Latency** and **Errors (apply / sync)**. Errors are shown in red; PostgreSQL keeps these counters since version 15.

Apply errors usually mean a data conflict on the subscriber (for example, a uniqueness violation) or a missing table. Look for the cause in the subscriber's log. To publish `UPDATE` and `DELETE`, a table needs a replica identity: a primary key (the default), a unique index assigned with `ALTER TABLE … REPLICA IDENTITY USING INDEX`, or `REPLICA IDENTITY FULL`.

## WAL & checkpoints {#wal}

The **WAL & checkpoints** page shows the write-ahead log (WAL), its archiving, checkpoints and the background writer.

Cards at the top:

| Card | What it shows |
|---|---|
| **WAL files** | number of files in `pg_wal`; the caption shows their approximate size at 16 MiB per file and the current `max_wal_size` |
| **Ready to archive** | files with `.ready` status not yet handed to the archiver; more than 10 is highlighted |
| **Archiving** | **Off** with `archive_mode = off`; **Failures** if the last archiving attempt is later than the last success; otherwise **OK**; the caption shows the time of the last successful archiving |
| **Checkpoint** | how long ago the last checkpoint was |
| `wal_level` | current value of the setting |
| **Current LSN** | current WAL position (on a standby, the replay position) |

### Archiving {#wal-archiving}

The **Archiver** card (data from `pg_stat_archiver`): **Archived**, **Last archived WAL**, **Last archived at**, **Failed**, **Last failed WAL**, **Last failure** and the current `archive_command`.

If archiving fails, WAL files pile up in `pg_wal`, and point-in-time recovery backups become incomplete. Run `archive_command` by hand as the OS user PostgreSQL runs as, check the space and permissions at the destination, and check the PostgreSQL log (the [**Logs**](#logs) page). The `pg_stat_archiver` counters are cumulative, so **Failed** does not reset after you fix the cause, but **Archiving** returns to **OK** after the first successful archiving.

### Checkpoints and background writer {#checkpoints}

The card is called **Checkpoints & background writer** on PostgreSQL 17+ (data from `pg_stat_checkpointer` and `pg_stat_bgwriter`) and **Background writer** on older versions (everything from `pg_stat_bgwriter`). It contains:

| Field | What it shows and how to read it |
|---|---|
| **Checkpoints timed / requested** | checkpoints triggered by `checkpoint_timeout` and those triggered by filling `max_wal_size` (or by the `CHECKPOINT` command). If requested ones clearly dominate, increase `max_wal_size` |
| **Checkpoint write / sync time** | total write and `fsync` time during checkpoints |
| **Buffers written by checkpoints** | dirty pages written by checkpoints |
| **Buffers written by background writer** | pages written by the bgwriter process |
| **Background writer stops (maxwritten)** | how many times bgwriter stopped after reaching `bgwriter_lru_maxpages`; frequent stops are a reason to raise that setting |
| **Buffers written by backends** | pages that backends had to write themselves; shown on PostgreSQL 16 and earlier when the value is non-zero (PostgreSQL 17 no longer has this counter). A large share means bgwriter and checkpoints are not keeping up |
| **Buffers allocated** | buffer allocations |
| `checkpoint_timeout` | current value |

The **WAL statistics** card (data from `pg_stat_wal`, PostgreSQL 14+): **Records**, **Full-page images**, **Bytes**, **WAL buffers full**, **Writes**, **Syncs**, **Write time**, **Sync time**, **Stats reset**. On PostgreSQL 18+ these writes and syncs are counted in `pg_stat_io`, so **Writes**, **Syncs**, **Write time** and **Sync time** are zero there. A large share of full-page images is typical right after checkpoints: less frequent checkpoints and `wal_compression` reduce WAL volume. Frequent "WAL buffers full" events are a reason to increase `wal_buffers`.

### Charts and pg_stat_io {#wal-charts}

**Over time** charts:

| Chart | What it shows |
|---|---|
| **WAL generation** | WAL write rate in bytes per second (from the LSN change) |
| **WAL files** | **In pg_wal** and **Ready to archive** |
| **Checkpoints** | **Timed** and **Requested** per hour |
| **Buffers written** | buffers written by checkpoints, the background writer and backends, per second |
| **WAL archiving** | archived files and failures per minute |
| **WAL records** | WAL records and full-page images per second (when `pg_stat_wal` is available) |

On PostgreSQL 16+ the page also shows **I/O statistics (pg_stat_io)** — the `pg_stat_io` rows with non-zero activity: **Backend type**, **Object**, **Context**, **Reads**, **Read time**, **Writes**, **Write time**, **Extends**, **Hits**, **Evictions**, **Fsyncs**. Times are filled with `track_io_timing = on`. The table shows who exactly does the I/O: for example, many writes by `client backend` mean queries flush dirty pages themselves.

If `pg_wal` holds more than twice `max_wal_size`, look for the cause in inactive slots ([Replication slots](#replication-slots)), archiving failures and a large `wal_keep_size`.

## Vacuum {#vacuum}

The **Vacuum** page gathers everything about table maintenance: operations in progress, XID age, dead rows, autovacuum history and settings.

### In progress {#vacuum-progress}

The **In progress** block shows the operations that were running when the report was collected, from the `pg_stat_progress_*` views. For each operation it shows the PID, **Database** and its own columns:

| Operation | Columns | PostgreSQL version |
|---|---|---|
| **VACUUM** | **Table**, **Phase**, **Progress** (share of heap blocks scanned), **Index passes**, **Dead rows** | all supported |
| **ANALYZE** | **Table**, **Phase**, **Sampled** | 13+ |
| **CREATE INDEX** | **Table**, **Command**, **Phase**, **Blocks** | 12+ |
| CLUSTER / VACUUM FULL | **Table**, **Command**, **Phase**, **Scanned** | 12+ |
| **REPACK** | **Table**, **Phase** | 19+ |
| COPY | **Table**, **Command**, **Type**, **Rows** | 14+ |
| **Base backup (pg_basebackup)** | **Phase**, **Streamed** | 13+ |

If nothing is running, the block says **No VACUUM, ANALYZE, CREATE INDEX, CLUSTER, COPY or base backup is running right now.** This is a snapshot at report time: short operations between reports do not show up here. More than one **Index passes** means vacuum ran out of memory for the dead-row list — increase `maintenance_work_mem` or `autovacuum_work_mem`.

### XID age and wraparound {#xid-age}

Transaction IDs (XIDs) in PostgreSQL are 32-bit. Vacuum "freezes" old rows so the counter can safely wrap around. If freezing falls behind and the age of the oldest unfrozen XID approaches the limit of about 2.1 billion, PostgreSQL first emits warnings and then stops assigning new XIDs — writes to the cluster become impossible until VACUUM runs.

The **XID age by database** block shows a bar per database: the age of `datfrozenxid` as a percentage of 2,147,483,647 (green, yellow above 40%, red above 75% — the same thresholds the diagnostics use). On the right are the age and its share of `autovacuum_freeze_max_age` ("… of freeze limit"). Going above 100% of that share means autovacuum should already be running in aggressive anti-wraparound mode.

The **Oldest tables (frozen XID age)** block lists the 50 tables with the largest `age(relfrozenxid)`: **Age**, **% of freeze limit** (highlighted when above `autovacuum_freeze_max_age`) and **Size**.

If the age keeps growing, find what holds back freezing:

- long transactions and sessions in the `idle in transaction` state — the [**Backends**](activity.md#backends) page;
- forgotten prepared transactions — `SELECT * FROM pg_prepared_xacts;`;
- replication slots with `xmin` or `catalog_xmin`, and standbys with `hot_standby_feedback = on` running long queries — [Replication slots](#replication-slots).

Then vacuum the oldest tables manually, starting with the first in the list:

```sql
VACUUM (FREEZE, VERBOSE) public.big_table;
```

To get alerted, use the database-level metric **XID age as a percentage of autovacuum_freeze_max_age** (see [Alert rules](alerts.md)).

### Dead rows {#dead-rows}

The **Tables with the most dead rows** block lists up to 100 tables with `n_dead_tup` above zero: **Dead rows**, **Dead %**, **Modified since ANALYZE**, **Last autovacuum**, **Last autoanalyze**, **Autovacuum runs**.

A table with a large share of dead rows and an old value in the **Last autovacuum** column means autovacuum is not keeping up or something blocks it (long transactions, slots). For large tables, lowering the trigger threshold at the table level usually helps:

```sql
ALTER TABLE public.orders SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
```

To speed up autovacuum globally, increase `autovacuum_vacuum_cost_limit` and `autovacuum_max_workers`.

### Autovacuum history {#autovacuum-history}

The **Autovacuum history (from logs)** block lists the autovacuum runs pgmetrics found in the PostgreSQL log during the report's collection window: **Time**, **Table**, **Duration**. For the history to appear you need to:

- set `log_autovacuum_min_duration` (for example, `1000` to log runs longer than a second);
- give pgmetrics access to the log (see [Logs](#logs)).

Without this the block says **No autovacuum entries — set log_autovacuum_min_duration and give pgmetrics access to the log**. Each report contains only entries from the last `--log-span` minutes, so the history covers the window of the selected report.

The **Settings** block at the end of the page lists every `autovacuum*` and `vacuum_*` setting, plus `maintenance_work_mem` and `track_counts`.

## Configuration {#config}

The **Configuration** page shows the server's settings from `pg_settings`. If some changes are waiting for a restart, the subtitle says how many settings are pending restart.

The **Settings** tab:

| Column | What it shows |
|---|---|
| **Setting** | setting name |
| **Value** | current value; memory settings are converted to byte units, time settings to ms and seconds; for millisecond time settings, 0 is shown as **0 (off)**. The **restart required** badge means the change is in the configuration but takes effect only after a restart (`pending_restart`) |
| **Default** | the default value (`boot_val`); shown dimmer when it equals the current value |
| **Source** | where the value comes from: `default`, `configuration file`, `command line`, `environment variable` and so on |

The **Non-default only** checkbox keeps the settings whose source is neither `default` nor `override`, that is, the ones set explicitly. The **Filter…** box searches names and values.

The **Configuration check** tab shows recommendations for the settings as a table: **Severity**, **Category** (Security, Data Safety, Performance, Reliability), **Setting**, **Current**, **Recommendation**. These are the same recommendations as on the **Configuration check** tab of the [**Diagnostics**](monitoring.md#diagnostics) page; the full list of rules with their conditions is in the [Checks reference](checks.md#config-check).

To be notified about every settings change, turn on [change alerts](change-alerts.md) for configuration settings.

## System {#system}

The **System** page shows the resources of the host PostgreSQL runs on. pgmetrics collects this data only on Linux and only when it connects to PostgreSQL locally — over a Unix socket, a loopback address, or when the client and server addresses match. So it is missing from reports collected from another machine, including those from the pgscope agent in Docker, and for managed cloud databases (for AWS RDS and Aurora see [Cloud metrics](integrations.md#cloud)). In that case the page says **This report has no system metrics**.

The subtitle shows the host name and the CPU model. Cards:

| Card | What it shows |
|---|---|
| **CPU cores** | the number of logical processors — `model name` lines in `/proc/cpuinfo` (on platforms without such lines, such as some ARM systems, it is 0) |
| **Load average** | the 1-minute load average (from `/proc/loadavg`) and the same per core; highlighted when it exceeds the number of cores |
| **Memory used** | memory minus free, buffers, cache and slab (from `/proc/meminfo`); the caption shows the sum of used and free memory, buffers and cache |
| **Cache + buffers** | the OS page cache and buffers — memory the OS gives back on demand |
| **Swap used** | swap in use; highlighted when more than half is used |
| **Slab** | kernel memory (slab) |

The **Memory** bar shows the breakdown into **Used**, **Buffers**, **Cache** and **Free**. **Over time** charts: **Load average** (with the core count), **Memory**, **Swap**. The **Disk usage by tablespace** block shows how full the file systems are for the tablespaces whose file system size pgmetrics obtained (yellow bar above 80%, red above 90%). `pg_default` and `pg_global` live in the data directory, so they usually show the same file system.

How to read it: a load steadily above the number of cores means the CPU or disk is overloaded (waiting for I/O also counts toward load average); growing swap on a database server means memory is short — check `shared_buffers`, `work_mem` and the number of connections; a large **Cache + buffers** is normal, PostgreSQL uses the OS cache as a second caching level.

## Logs {#logs}

The **Logs** page shows the PostgreSQL log entries pgmetrics read and parsed while collecting the selected report — for the last `--log-span` minutes before collection (5 by default).

- The **All levels** selector filters by level (`LOG`, `WARNING`, `ERROR`, `FATAL`…), the **Filter…** box searches the text, user and database.
- Columns: **Time**, **Level** (`PANIC`, `FATAL`, `ERROR` in red, `WARNING` in yellow), **User@database**, **Message**. Related lines (`DETAIL`, `HINT` and so on) are shown under the message.
- To see entries from an earlier period, select an older report in the server bar. Full reports are kept for `PGSCOPE_REPORT_RETENTION_DAYS` days (14 by default, `0` keeps them forever, see [Data storage](data.md#retention)).

From the same entries pgmetrics extracts the autovacuum history, deadlocks (shown on the [**Locks**](activity.md#locks) page and in the diagnostics) and `auto_explain` plans (the query page under [**Queries**](activity.md#queries)).

With no entries the page says **No log entries**. Conditions for the log to get into a report:

- pgmetrics reads log files only if its connection to PostgreSQL is local (a Unix socket, a loopback address, or matching client and server addresses) and the OS user it runs as can read the files. It looks for the files in this order: the file from `--log-file`; all files in the `--log-dir` directory except `.gz` and `.bz2`; the current log file from `pg_current_logfile()`; the most recent file in `/var/log/postgresql`. The `--log-file` and `--log-dir` flags only tell it where the files are; they do not make a remote connection work.
- For AWS RDS and Aurora the log is read through the AWS API when pgmetrics runs with `--aws-rds-dbid`.
- For a log in `stderr` format, `log_line_prefix` must contain a timestamp (`%t`, `%m` or `%n`), otherwise pgmetrics cannot parse the log. The default `'%m [%p] '` works.
- pgmetrics recognizes levels and service messages (autovacuum, deadlocks) by their English text. If the server writes its log in another language, set `lc_messages = 'C'` (or an English locale).
- The log is written in `stderr` or `csvlog` format. If `log_destination` includes `csvlog` and `logging_collector` is on, pgmetrics reads the CSV file. PostgreSQL 13+ `csvlog` is read only by the pgmetrics that pgscope builds (a version with `+pgscope` in the **Collected by** row on **Overview**, see [pgmetrics built by pgscope](collect.md#pgmetrics-build)): official releases expect 23 fields per line while PostgreSQL 13+ writes more, so the report will have no entries. With official pgmetrics keep `stderr`. pgmetrics does not parse the `jsonlog` format.
- With official pgmetrics, `log_timezone` must match the time zone of the host where pgmetrics runs, or be `'UTC'`. Otherwise entry times are shifted by the zone offset, and with a zone west of UTC the entries do not reach the report. [pgmetrics built by pgscope](collect.md#pgmetrics-build) reads times in the `log_timezone` zone and works with any combination of zones, see [PostgreSQL log](postgres.md#logs).
- `--omit=log` turns off log reading.

To avoid gaps between reports, set `--log-span` equal to the collection interval (see [Sending reports](collect.md)).

```ini
# postgresql.conf: a log that pgmetrics can parse
log_destination = 'stderr'              # or 'csvlog' with pgmetrics built by pgscope
log_line_prefix = '%m [%p] %q%u@%d '
lc_messages = 'C'
log_autovacuum_min_duration = 1000
log_lock_waits = on
log_checkpoints = on
```
