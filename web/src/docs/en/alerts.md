# Alert rules

This page explains how threshold alerts work in pgscope: what a rule consists of, when rules are evaluated and when notifications are sent, and what the server's Alerts page contains. It also has the complete catalog of metrics available in rules, a recommended starter set and examples. Where notifications go and in what format is covered in [Notification channels](notifications.md); alerts about structural changes (new tables, changed settings, restarts) are covered in [Change alerts](change-alerts.md).

## How alerts work {#how-it-works}

An alert rule belongs to one server and consists of:

- a **level** — the object type: server, database, table, tablespace or query;
- a **metric** from the [catalog](#metrics), for example **Table size** or **Free disk space**;
- a **condition** — **greater than** or **less than**;
- a **threshold** — a number in the metric's unit (bytes, time, percent or count);
- a **severity** — **Warning** or **Critical**;
- an **object filter** — which databases, tables, tablespaces or queries the rule applies to (the **Server** level has no filter).

A rule is checked for every matching object separately, and every object that breaks the threshold produces its own triggered alert. For example, the rule "Table size greater than 10 GiB" produces three alerts if three tables are that large. The comparison is strict: a value equal to the threshold does not trigger.

### When rules are evaluated {#evaluation}

- Whenever a pgmetrics report arrives for a PostgreSQL server. PgBouncer reports (`pgdash report-pgbouncer`) do not trigger evaluation, and Pgpool servers do not support alerts: their menu has no Alerts section.
- Right after a rule is added or deleted: all rules of the server are re-evaluated against the latest stored report. A new rule that is already violated therefore shows up on the **Triggered** tab immediately and causes a notification.

> [!WARNING]
> Rules are evaluated only when reports arrive. If reports stop (cron, the agent or the network fails), pgscope does not alert about it: the last state is simply frozen. The signs are a yellow dot and a yellow report time next to the server name in the top bar, and a yellow **Report** value on the server card in the server list (the latest report is older than 15 minutes). Monitor collection itself separately, for example by the exit code of `pgdash` in the cron job, see [Sending reports](collect.md#responses).

### When notifications are sent {#edge-triggered}

Notifications are sent **only when the set of triggered alerts changes** — when a new alert appears, an old one disappears or an alert changes severity. The set is compared by rule (metric, condition, threshold, **Transaction age (minutes)**, severity) and object name, not by value.

- A notification always carries the **complete current list** of triggered alerts, not just the new ones.
- When no triggered alerts remain, an "all alerts cleared" notification with an empty list is sent.
- While the set stays the same there are no repeat notifications, even if the value keeps getting worse: free space dropping from 14% to 5% does not cause a new notification if a "less than 15%" rule has already triggered.
- Deleting a rule that has triggered alerts also changes the set and causes a notification.

Every change of the set is recorded on the [**History**](#history) tab, even if no notification channels are configured.

### Where triggered alerts are shown {#where-shown}

- The [**Triggered**](#triggered) tab of the server's Alerts page.
- The **Alerts** tile and the **Active alerts** card on the server's Overview page, see [Overview](monitoring.md#overview).
- Badges with the number of critical and warning alerts (or **OK**) on the server card in the [Servers](fleet.md#servers) list, and the **Alerts** column in the [Inspector](fleet.md#inspector).

All of them show the state as of the last evaluated report, even if an earlier report is selected in the top bar.

## The Alerts page {#alerts-page}

Open it from the server's sidebar: **Alerting** → **Alerts**. The subtitle tells which report the rules were checked against ("Checked against the report from …"); if nothing has been checked yet, it says "Rules are checked whenever a report arrives". The page has four tabs, each showing the number of items next to its name.

### The Triggered tab {#triggered}

A table of the alerts triggered by the latest report:

| Column | What it shows |
|---|---|
| **Severity** | **Critical** or **Warning**; critical alerts come first by default |
| **Rule** | the rule text, for example "Table size greater than 10 GiB" |
| **Object** | the object name: server name, database, table as `database.schema.table`, tablespace, standby name or the first 20 characters of the query text |
| **Value** | the current value with its unit |
| **Query** | the full query text (only for **Query** level rules) |

Clicking a row opens the object's page: the database, the table, the query, and for server metrics the matching server page (**Vacuum**, **WAL & checkpoints**, **Replication**, **Backends**).

If nothing has triggered, the tab shows **No triggered alerts** with "All values are within thresholds." or, if there are no rules, "No rules yet." with an **Add rule** link.

### The Rules tab {#rules-tab}

At the top is the **New rule** form (see [Creating a rule](#create-rule)); below it are the existing rules grouped by level in cards such as **Rules · Server** and **Rules · Table**. Each row shows the severity and the rule text with its filter, for example "Table size greater than 10 GiB · name starts with “shop.public.” · in database “shop”". The trash button deletes the rule.

### The Notifications tab {#notifications-tab}

The channels that receive notifications about these alerts: email, Slack, PagerDuty, VictorOps, xMatters and webhook. The card subtitle reminds: "Sent only when the set of triggered alerts changes, including when all alerts clear". Adding, testing and payload formats are covered in [Notification channels](notifications.md). Channels for change alerts are configured separately, on the Change alerts page.

### The History tab {#history}

A timeline of changes of the set of triggered alerts, newest first. Each card is a moment when the set changed: the report time in the title, the caption "Alerts triggered: N" and the list of alerts (severity, rule, object, value), or, when no triggered alerts remain, the caption "All alerts cleared" and the mark **Alerts cleared**. Until the set has changed, the tab shows **No alert notifications yet**.

The page shows the server's last 200 events (alerts and changes together). History is kept as long as time series — `PGSCOPE_METRICS_RETENTION_DAYS` days (90 by default; `0` keeps it forever), see [Data storage](data.md#retention).

## Creating a rule {#create-rule}

Open the **Rules** tab and fill in the **New rule** form:

| Field | What to enter |
|---|---|
| **Level** | **Server**, **Database**, **Table**, **Tablespace** or **Query** |
| **Metric** | a metric of the chosen level; byte metrics get the suffix "(bytes)", time metrics in seconds "(time)" (**Query** level metrics get no suffix) |
| **Transaction age (minutes)** | only for the metric **Number of backends with transactions open longer than**; 5 by default |
| **Condition** | **greater than** or **less than** |
| **Threshold** | a number; fractions are allowed |
| **Unit** | the threshold's unit (see the table below) |
| **Severity** | **Warning** or **Critical** |
| **Apply to …** | the object filter, for every level except **Server** (see [Object filter](#object-filter)) |
| **Text** | the filter text; appears when something other than **all objects** is selected |
| **Only in database (optional)** | only for the **Table** and **Query** levels: the exact database name; empty means **any database** |

Click **Add rule**. The rule is evaluated against the latest report right away.

Threshold units depend on the metric; the first one listed is the default:

| Metric type | Available units |
|---|---|
| Size (bytes) | **MiB**, **GiB**, **KiB**, **TiB** (binary: 1 MiB = 1,048,576 bytes) |
| Time | **minutes**, **seconds**, **hours**, **days** |
| Query execution time | **seconds**, **milliseconds**, **minutes** |
| Percent | % only |
| Count | no unit |

> [!TIP]
> Remember to switch the unit: a threshold of "10" for a size means 10 MiB by default, not 10 GiB.

### Object filter {#object-filter}

For every level except **Server**, the field **Apply to databases** / **Apply to tables** / **Apply to tablespaces** / **Apply to queries** selects which objects to check:

| Option | Condition on the object name |
|---|---|
| **all objects** | no restriction |
| **name contains** | contains the text |
| **name does not contain** | does not contain the text |
| **name starts with** | starts with the text |
| **name ends with** | ends with the text |
| **name equals** | equals the text exactly |

The comparison is case-sensitive. What the text is compared with:

| Level | Object name |
|---|---|
| Database | the database name, for example `shop` |
| Table | `database.schema.table`, for example `shop.public.orders` |
| Tablespace | the tablespace name, for example `pg_default` |
| Query | the first 20 characters of the query text from `pg_stat_statements`, for example `select * from orders` |

For the **Table** and **Query** levels the rule can also be limited to one database with **Only in database (optional)** — the database name must match exactly.

> [!NOTE]
> For queries the name filter only sees the beginning of the text (20 characters). To single out the queries of one database, **Only in database (optional)** is more reliable.

## Changing and deleting rules {#delete-rule}

Rules cannot be edited: delete a rule with the trash button on the **Rules** tab and create it again with the values you need. Deletion is immediate, with no confirmation. After a deletion the server's rules are re-evaluated against the latest report; if the deleted rule had triggered alerts, the set changes and the channels get a notification.

Rules, channels and history are deleted together with the server, see [Deleting a server](teams.md#delete-server). Both the server owner and team members can manage rules, see [Owner and member permissions](teams.md#permissions).

## Metric catalog {#metrics}

Below are all metrics available in rules. The "ID" column is the metric identifier used by the API (the `metric` field). Values come from the latest pgmetrics report.

> [!NOTE]
> pgmetrics cannot get some values (for example without privileges, when not running on the database host, or on a lock timeout). When a value is missing, the object is usually skipped for the rule; a few counters (for example **Number of WAL files** and **Number of WAL files ready for archiving** without the privileges to read the WAL directory, or on AWS RDS) arrive as −1 — a "greater than" rule does not trigger for them, but a "less than" rule may.

### Server {#metrics-server}

The object is the server itself (its name), except for the lag metrics on the primary, where the object is each standby.

| Metric | ID | Unit | What is measured |
|---|---|---|---|
| **XID range** | `xid_range` | count | `next_xid − oldest_xid` modulo 2³² from `pg_control_checkpoint()` (as of the last checkpoint): how many transaction IDs separate the cluster's oldest unfrozen XID from the next one. The wraparound limit is about 2.1 billion (2³¹). For limitations see the notes below the table |
| **Time since last checkpoint** | `checkpoint_age` | time | report time minus the time of the last checkpoint |
| **Number of inactive replication slots** | `inactive_slots` | count | slots in `pg_replication_slots` with `active = false`; such a slot keeps retaining WAL from its `restart_lsn` on (and `xmin`, if set) |
| **Replication write lag on primary** | `repl_write_lag` | bytes | for each standby in `pg_stat_replication`: the current WAL position minus `write_lsn` |
| **Replication flush lag on primary** | `repl_flush_lag` | bytes | the same for `flush_lsn` |
| **Replication replay lag on primary** | `repl_replay_lag` | bytes | the same for `replay_lsn` |
| **Replay lag on standby** (bytes) | `standby_lag_bytes` | bytes | only on a standby whose receive LSN is known: `pg_last_wal_receive_lsn() − pg_last_wal_replay_lsn()` |
| **Replay lag on standby** (time) | `standby_lag_secs` | time | on a standby only: report time minus `pg_last_xact_replay_timestamp()` |
| **Number of WAL files** | `wal_files` | count | WAL segments in `pg_wal` |
| **Number of WAL files ready for archiving** | `wal_ready` | count | `.ready` files in `pg_wal/archive_status` — segments not yet handed to `archive_command` |
| **Number of backends waiting for locks** | `backends_waiting` | count | backends with `wait_event_type = 'Lock'` |
| **Number of backends idle in transaction** | `backends_idle_xact` | count | backends whose `state` starts with `idle in transaction` (including `idle in transaction (aborted)`) |
| **Number of backends with transactions open longer than** | `backends_long_xact` | count | backends whose transaction (`xact_start`) has been open longer than **Transaction age (minutes)** |
| **Total number of backends** | `server_backends` | count | the `pg_stat_activity` rows in the report, including pgmetrics' own connection; from PostgreSQL 10 on, pgmetrics collects client backends only (`backend_type = 'client backend'`) |

Notes:

- The current WAL position for the lag metrics is `pg_current_wal_lsn()` on a primary; on a cascading standby that has its own standbys it is the replay position. The object name is the standby's `application_name`, or the client address if that is empty, otherwise the walsender PID. All `pg_stat_replication` rows count, including `pg_basebackup` processes. If a row has no such LSN (the field is `NULL`, for example for a `pg_basebackup` process or a standby that has just connected), no lag is computed for it, and the rule skips that row.
- The **Replay lag on standby** metrics are computed on standbys only; on a primary there are no objects and the rule never triggers. The byte variant also needs the receive LSN: a standby without a WAL receiver (for example, one that only restores WAL from the archive) has no value, and the rule is not evaluated.
- `standby_lag_secs` also grows when the primary simply has no writes: there is nothing to replay, and the time of the last replayed transaction stands still. For lightly loaded clusters `standby_lag_bytes` is more reliable.
- Checkpoints are skipped when no WAL has been written since the previous one, so on an idle server `checkpoint_age` also grows without a problem.
- `xid_range` is computed as the difference of 32-bit transaction IDs modulo 2³², as PostgreSQL does, so it stays correct after the cluster's transaction counter passes 2³² (about 4.3 billion transactions since `initdb`). On PostgreSQL older than 9.6 pgmetrics does not collect these fields; then there is no value and the rule is not evaluated. The metric describes the whole cluster and does not show which database is behind on freezing, so make **XID age as a percentage of autovacuum_freeze_max_age** (**Database** level) your main wraparound rule and use **XID range** as an extra one.

### Database {#metrics-database}

The object is each database in the report: by default pgmetrics lists all databases of the cluster except templates, and with the `--only-listed` flag only the databases given on the command line.

| Metric | ID | Unit | What is measured |
|---|---|---|---|
| **Number of backends** | `db_backends` | count | `numbackends` from `pg_stat_database` |
| **Backends as a percentage of max_connections** | `db_backends_pct` | % | `numbackends` as a percentage of the database's `datconnlimit`, or of `max_connections` if no limit is set |
| **Commit ratio** | `db_commit_ratio` | % | `xact_commit / (xact_commit + xact_rollback)`; databases without transactions are skipped |
| **XID age as a percentage of autovacuum_freeze_max_age** | `db_xid_age_pct` | % | `age(datfrozenxid)` as a percentage of `autovacuum_freeze_max_age`; 100% is the point where anti-wraparound autovacuum starts |
| **Database size** | `db_size` | bytes | the database size |
| **Number of disabled triggers** | `db_disabled_triggers` | count | disabled triggers in this database |
| **Cache hit ratio** | `db_cache_hit` | % | `blks_hit / (blks_hit + blks_read)` |

> [!NOTE]
> **Commit ratio** and **Cache hit ratio** are computed from the cumulative `pg_stat_database` counters since the last statistics reset. They move slowly and do not show short dips well.

### Table {#metrics-table}

The object is each table in the report, named `database.schema.table`. Tables get into the report only from the databases pgmetrics connected to (the ones listed in the command), subject to the `-c`, `-C`, `-a`, `-A` and `--omit=tables` flags.

| Metric | ID | Unit | What is measured |
|---|---|---|---|
| **Time since last vacuum** | `tbl_since_vacuum` | time | report time minus the later of `last_vacuum` and `last_autovacuum` |
| **Time since last analyze** | `tbl_since_analyze` | time | report time minus the later of `last_analyze` and `last_autoanalyze` |
| **Table size** | `tbl_size` | bytes | the table size as reported by pgmetrics (`pg_table_size`: table with TOAST, without indexes) |
| **Table bloat** | `tbl_bloat` | bytes | pgmetrics' bloat estimate |
| **Table bloat as a percentage of size** | `tbl_bloat_pct` | % | the bloat estimate as a percentage of the table size |

If a table has never been vacuumed (or analyzed), the time is treated as infinite, the value is shown as "never", and a "greater than N" rule triggers for that table at any threshold. Use a name filter to avoid alerts about small or static tables.

### Tablespace {#metrics-tablespace}

The object is each tablespace.

| Metric | ID | Unit | What is measured |
|---|---|---|---|
| **Tablespace size** | `ts_size` | bytes | the tablespace size |
| **Free disk space** | `ts_disk_free_pct` | % | free space on the file system that holds the tablespace (for `pg_default`, the data directory); blocks reserved for root count as free, so the value can be slightly higher than "Avail" in `df` |
| **Free inodes** | `ts_inodes_free_pct` | % | free inodes on that file system |

pgmetrics collects disk and inode data only when it runs on the database host under Linux (connected to a local server). If the report has no such data, these rules are not checked.

### Query {#metrics-query}

The object is each query from `pg_stat_statements` included in the report, that is, a database and `queryid` pair. `pg_stat_statements` keeps a separate row for each user who ran the query; pgscope merges them and evaluates the rule once per query on the merged values. pgmetrics sends only the first `--statements-limit` queries (100 by default) with the highest total execution time and truncates their text to `--sql-length` characters (500 by default); queries outside that list are invisible to rules. The object name is the first 20 characters of the query text; the text from the report is in the **Query** column.

| Metric | ID | Unit | What is measured |
|---|---|---|---|
| **Max query execution time** | `query_max_time` | time (ms) | `max_exec_time` (`max_time` before PostgreSQL 13), the largest over all users of the query |
| **Mean query execution time** | `query_mean_time` | time (ms) | `total_exec_time / calls`, both summed over all users of the query |

> [!WARNING]
> `pg_stat_statements` values accumulate since the last statistics reset (`pg_stat_statements_reset()`). After a single slow execution, a **Max query execution time** alert stays triggered until the statistics are reset. For continuous control **Mean query execution time** is a better fit.

## Recommended starter set {#starter-set}

A starting point for a typical OLTP server. Tune the thresholds to your workload: a rule that fires all the time stops being noticed.

| Level | Metric | Condition and threshold | Severity | Why |
|---|---|---|---|---|
| Server | **Number of inactive replication slots** | greater than 0 | **Critical** | a forgotten slot retains WAL until the disk fills up |
| Server | **Number of WAL files ready for archiving** | greater than 10 | **Warning** | archiving is falling behind or broken |
| Server | **Number of backends waiting for locks** | greater than 5 | **Warning** | lock chains |
| Server | **Number of backends with transactions open longer than** (age 15 minutes) | greater than 0 | **Warning** | long transactions hold back vacuum and freezing |
| Server | **Number of backends idle in transaction** | greater than 5 | **Warning** | the application does not close transactions |
| Server | **XID range** | greater than 860,000,000 | **Warning** | about 40% of the wraparound limit |
| Server | **XID range** | greater than 1,600,000,000 | **Critical** | about 75% of the wraparound limit |
| Server | **Replication replay lag on primary** | greater than 1 GiB | **Warning** | a standby is falling behind |
| Database | **Backends as a percentage of max_connections** | greater than 80% | **Warning** | connections will run out soon |
| Database | **Backends as a percentage of max_connections** | greater than 90% | **Critical** | connections are almost exhausted |
| Database | **XID age as a percentage of autovacuum_freeze_max_age** | greater than 150% | **Warning** | autovacuum cannot keep up with freezing |
| Tablespace | **Free disk space** | less than 25% | **Warning** | time to plan for space |
| Tablespace | **Free disk space** | less than 10% | **Critical** | the disk is almost full |
| Tablespace | **Free inodes** | less than 10% | **Warning** | inodes are running out |
| Query | **Mean query execution time** | greater than 1 second | **Warning** | slow queries |

On standbys, add **Replay lag on standby** (bytes) greater than 1 GiB. The **XID range** thresholds match those of [diagnostics](monitoring.md#diagnostics): it reports **High XID age** when a database's XID age (`age(datfrozenxid)`) exceeds 40% of 2³¹ and **Transaction ID wraparound risk** above 75%. A rule on **XID age as a percentage of autovacuum_freeze_max_age** is still a must: **XID range** describes the whole cluster, while that rule shows which database is behind on freezing (see the [notes on server metrics](#metrics-server)).

> [!NOTE]
> **Warning** and **Critical** rules for the same metric are independent: when the value is above both thresholds, both trigger, and the list shows two alerts for one object.

## Examples {#examples}

**Free space on data disks.** Level **Tablespace**, metric **Free disk space**, condition **less than**, threshold `15`, severity **Critical**, **Apply to tablespaces** — **all objects**. A notification arrives when at least one tablespace drops below 15%, and again when all are back above the threshold ("all alerts cleared").

**Vacuum of large tables in one schema.** Level **Table**, metric **Time since last vacuum**, **greater than** `3`, unit **days**, severity **Warning**, **Apply to tables** — **name starts with**, text `shop.public.`.

**Growth of one table.** Level **Table**, metric **Table size**, **greater than** `200`, unit **GiB**, **Apply to tables** — **name equals**, text `shop.public.events`.

**Slow queries in one database.** Level **Query**, metric **Mean query execution time**, **greater than** `500`, unit **milliseconds**, **Apply to queries** — **all objects**, **Only in database (optional)** — `shop`.

**Transactions open for more than an hour.** Level **Server**, metric **Number of backends with transactions open longer than**, **Transaction age (minutes)** `60`, **greater than** `0`, severity **Critical**. In the list the rule reads "Number of backends with transactions open longer than 1 h greater than 0".

An email notification for two triggered alerts (channel language English):

```text
Subject: [pgscope] prod-db-1: alerts (critical: 1, warning: 1)

[Critical] Free disk space less than 15% — pg_default: 9.8%
      https://pgscope.example.com/#/s/1/tablespaces
[Warning] Number of backends with transactions open longer than 15 min greater than 0 — prod-db-1: 2
      https://pgscope.example.com/#/s/1/backends
```

Links are built from `PGSCOPE_BASE_URL`, so set it to the address users open pgscope at, see [Configuring pgscope](config.md). The webhook JSON is described in [Webhook format](notifications.md#webhook).

## Limitations {#limitations}

- There is no alert for missing reports: rules are evaluated only when a new report arrives.
- There is no trigger delay ("for longer than N minutes"), no maintenance windows and no muting: a rule triggers on the very first report that breaks it. To mute a rule temporarily, delete it and recreate it later.
- There are no repeat reminders while the set of triggered alerts stays the same.
- There is no routing by severity: every channel on the **Notifications** tab receives all of the server's alerts, critical and warning alike.
- A rule has one condition; there are no compound (AND/OR) conditions — create several rules.
- Rules are set per server; the UI cannot copy rules between servers. Rules can be created through the [API](api.md).
