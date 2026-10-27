# Database objects

This page covers the **Objects** section of a PostgreSQL server: **Databases**, **Tables**, **Indexes**, **Index management**, **Top-k**, **Tablespaces**, **Extensions & more** and **Roles**. It explains where the numbers come from, how to read them, which values should worry you and how to use the SQL that pgscope generates for index and tablespace maintenance.

## Where the data comes from {#data-source}

Every page in this section is built from a pgmetrics report: the latest one by default, or the past report selected in the server bar (see [The interface](ui.md)). The **Over time** charts are built from the time series pgscope stores when it accepts each report, and they cover the period selected in the server bar.

Keep in mind when reading the numbers:

- A report contains only the databases pgmetrics visited: the ones listed on its command line, or all user databases with `--all-dbs` (see [Sending reports](collect.md)). Tables and indexes are filtered by the pgmetrics flags `-c`, `-C`, `-a`, `-A`, while `--omit=tables`, `--omit=indexes` and `--omit=indexdefs` turn off the collection of tables, indexes or index definitions (`--omit=tables` also turns off indexes and disabled triggers).
- PostgreSQL counters (scans, inserts, cache hits, temp files, deadlocks and so on) are cumulative: tables show the value since the last statistics reset. A database's reset time is shown on its page in the **Stats reset** field. Charts turn the same counters into a rate between consecutive reports.
- Sizes come from PostgreSQL functions: a table uses `pg_table_size` (data, TOAST and auxiliary forks, without indexes), an index uses `pg_total_relation_size` of the index, a database uses `pg_database_size`, a tablespace uses `pg_tablespace_size`. If pgmetrics could not get a size (lock timeout, or the `-S` / `--no-sizes` flag), the value is missing and the chart shows a gap rather than zero.
- Bloat is an estimate that pgmetrics computes from planner statistics (the check_postgres formula), not an exact measurement. With `--omit=bloat` there is no estimate and the **Bloat** column shows "—".

Tables on these pages sort by clicking a column header, the **Filter…** box searches the row text, and clicking a row opens the object's page.

## Databases {#databases}

The **Databases** page lists every database in the report, sorted by size by default.

| Column | What it shows |
|---|---|
| **Database** | database name; click to open the database page |
| **Size** | `pg_database_size` |
| **Backends** | current connections to the database (`numbackends`) |
| **Commit ratio** | `xact_commit / (xact_commit + xact_rollback)` since the stats reset |
| **Cache hit ratio** | share of block reads served from shared buffers: `blks_hit / (blks_hit + blks_read)`; values below 90% are highlighted |
| **XID age / freeze limit** | `age(datfrozenxid)` as a percentage of `autovacuum_freeze_max_age` |
| **Transactions** | commits plus rollbacks |
| **Temp files** | bytes written to temporary files (`temp_bytes`) |
| **Deadlocks** | number of deadlocks (`deadlocks`) |
| **Conflicts** | queries canceled due to conflicts with recovery (meaningful on standbys) |

How to read it:

- *A cache hit ratio below 90%* on a busy database means the working set does not fit in `shared_buffers`. Check `shared_buffers` (usually about 25% of RAM) and the heavy queries on the **Queries** page ([Queries, backends and locks](activity.md#queries)).
- *A commit ratio below 90%* means the application rolls back transactions often: look for application errors and check the **Logs** page ([Logs](server.md#logs)).
- *XID age above 100%* means an aggressive anti-wraparound autovacuum is already due for the database. See [Vacuum](server.md#vacuum).
- *Growing temp files* mean sorts and hash operations do not fit in `work_mem`.

### Database page {#database-detail}

Cards at the top of the page:

| Card | What it shows |
|---|---|
| **Size** | database size |
| **Backends** | current connections; the caption is "limit N" if the database has a `CONNECTION LIMIT`, otherwise **no connection limit** |
| **Commit ratio** | as in the database list |
| **Cache hit ratio** | highlighted in yellow below 90% |
| **Frozen XID age** | `age(datfrozenxid)` and its share of `autovacuum_freeze_max_age` |
| **Tables** | number of the database's tables in the report, and the number of indexes |

Below is a summary of cumulative counters: **Rows fetched**, **Rows inserted**, **Rows updated**, **Rows deleted**, **Temp files** (file count and bytes), **Deadlocks**, **Conflicts**, **Block read time** and **Block write time** (filled only with `track_io_timing = on`), **Sessions** and **Sessions abandoned / killed** (PostgreSQL 14+), **Checksum failures** and **Stats reset**.

The **Over time** block has these charts: **Transactions** (commits and rollbacks per second), **Rows** (fetched, inserted, updated, deleted per second), **Cache hit ratio** (the ratio for each interval between reports), **Size**, **Backends**, **Temp files** (bytes per second), **Frozen XID age**, **Deadlocks & conflicts** (per minute).

Below the charts:

- **Largest tables** — the database's tables by size, with row counts and the share of dead rows;
- **Extensions** — extensions installed in the database with their schema, version and description; if a newer version is available, the installed version is marked "X available";
- **Disabled triggers** — shown only if the database has disabled triggers.

> [!TIP]
> If **Checksum failures** is above zero, data on disk is corrupted. This is critical: check the storage and your backups. The counter is filled only if data checksums are enabled in the cluster (`data_checksums`).

## Tables {#tables}

The **Tables** page lists every table in the report, including partitions of partitioned tables (marked **partition**). Filter the list by database with the **All databases** selector and by text with the search box.

| Column | What it shows |
|---|---|
| **Table** | `schema.name` |
| **Database** | the database the table belongs to |
| **Size** | `pg_table_size` |
| **Bloat** | estimated wasted space and its share of the size; above 30% is highlighted, "—" means no estimate |
| **Live rows** | `n_live_tup` |
| **Dead rows** | `n_dead_tup`; highlighted if dead rows exceed 20% and 1000 |
| **Seq scans** | number of sequential scans (`seq_scan`) |
| **Index scans** | number of index scans (`idx_scan`) |
| **Cache hit ratio** | share of heap block reads served from cache |
| **Last vacuum** | the later of the last manual vacuum and autovacuum; **never** if there was none |
| **Last analyze** | the later of the last manual ANALYZE and autoanalyze |

How to read it:

- Many dead rows and an old **Last vacuum** mean autovacuum is not keeping up. See [Vacuum](server.md#vacuum) and the per-table `autovacuum_vacuum_scale_factor` / `autovacuum_vacuum_cost_limit` settings.
- A large table with more sequential scans than index scans probably lacks an index. Find the queries that hit it on the **Queries** page.
- Bloat above 30% makes the table a candidate for `VACUUM FULL` (which locks the table) or `pg_repack`; first find out why autovacuum cannot cope.

### Table page {#table-detail}

Cards: **Size** (with the tablespace if it is not the default), **Bloat** (bytes and share of size, **not estimated** without an estimate), **Live rows**, **Dead rows** (with the share of all rows, highlighted above 20%), **Cache hit ratio**, **HOT updates** (the share of updates performed without touching indexes).

The **Vacuum & analyze** block:

- **Last manual vacuum**, **Last autovacuum**, **Last manual analyze**, **Last autoanalyze**;
- **Vacuums (manual / auto)** and **Analyzes (manual / auto)** — run counters;
- **Modified since analyze** (`n_mod_since_analyze`) and **Inserted since vacuum** (`n_ins_since_vacuum`, PostgreSQL 13+);
- the table's **Frozen XID age** (`age(relfrozenxid)`).

The **Activity** block: sequential and index scans with the number of rows read and fetched, **Last seq / index scan** (PostgreSQL 16+), **Rows inserted / updated / deleted**, heap, index and TOAST block hits and reads, the number of columns, **Type** (table, partitioned table, materialized view, foreign table; unlogged tables get ", unlogged") and, for a partition, **Partition of** with the parent and the bounds.

**Over time** charts: **Size** (with bloat), **Rows** (live and dead), **Row changes** (inserts, updates, deletes per second), **Scans** (sequential and index per second), **Cache hit ratio** (heap), **Vacuum & analyze runs** (autovacuum and autoanalyze per hour).

Below are the table's **Indexes (N)** in the same format as on the **Indexes** page, and, for a partitioned table, **Partitions (N)** with each partition's bounds, size and row count.

> [!TIP]
> A low share of HOT updates on a frequently updated table means every update also changes the indexes. Lowering the table's `fillfactor` and avoiding indexes on frequently changed columns helps.

## Indexes {#indexes}

The **Indexes** page lists every index in the report; the subtitle shows their count and total size. The database filter and search work as on the **Tables** page.

| Column | What it shows |
|---|---|
| **Index** | index name; unique indexes are marked **unique** |
| **Table** | `schema.table` |
| **Database** | the index's database |
| **Type** | access method: `btree`, `gin`, `gist`, `brin` and so on |
| **Size** | index size |
| **Bloat** | estimated wasted space and its share, "—" means no estimate |
| **Scans** | `idx_scan`; zero is highlighted |
| **Cache hit ratio** | share of index block reads served from cache |
| **Last used** | time of the last scan (PostgreSQL 16+); **n/a** means the time is unknown or there were no scans |

### Index page {#index-detail}

The top shows the index definition (`CREATE INDEX …`) and a link to the table. Cards: **Size**, **Bloat**, **Scans** (with the time of the last one on PostgreSQL 16+), **Tuples read**, **Tuples fetched**, **Cache hit ratio**.

The **Maintenance SQL** block contains ready-made commands with properly quoted names:

```sql
-- connect to database shop
REINDEX INDEX CONCURRENTLY "public"."orders_created_at_idx";
-- or, if the index is not needed:
DROP INDEX CONCURRENTLY "public"."orders_created_at_idx";
```

**Over time** charts: **Scans** per second, **Size** (with bloat), **Tuples** (read and fetched per second), **Cache hit ratio**.

If the report selected in the server bar does not contain the index (for example, it was created later), the cards are replaced by **Not in the selected report**, while the charts stay available.

## Index management {#index-management}

The **Index management** page helps you find indexes worth dropping or rebuilding and generates the SQL for them. It has three tabs: **Unused**, **Bloated** and **Duplicates**. The number on a tab is the count of indexes found.

On each tab, tick the indexes you want (the checkbox in the header ticks all of them). The SQL appears below the table, grouped by database, with a copy button.

### Unused indexes {#unused-indexes}

The **Unused** tab shows non-unique indexes that were not scanned during the chosen period. The period is set with the **Not scanned** selector:

| Option | How "not used" is determined |
|---|---|
| **since stats reset** | `idx_scan = 0` in the selected report |
| **in the last day**, **in the last 7 days**, **in the last 30 days**, **in the last 90 days** | `idx_scan` in the selected report equals the value from the first stored report received no earlier than the start of the period |

Unlike the **Unused indexes** check on the **Diagnostics** page, which takes only indexes larger than 1 MiB, the tab does not filter indexes by size. The start of the period is counted from the current moment, not from the report selected in the server bar.

In the "last N days" mode the page shows "compared with the report from …" — the date of the report used for the comparison. Check it: if the server's history is shorter than the chosen period, the comparison uses the earliest stored report, and "90 days" may actually mean a few days. History is limited by the time-series retention `PGSCOPE_METRICS_RETENTION_DAYS` (90 days by default, see [Data storage](data.md#retention)).

Columns: **Index**, **Table**, **Size**, **Total scans** (the cumulative `idx_scan`) and **Last used**. For the selected indexes the page generates:

```sql
\c "shop"
DROP INDEX CONCURRENTLY "public"."orders_tmp_idx";
DROP INDEX CONCURRENTLY "public"."orders_status_idx";
```

> [!WARNING]
> No scans does not always mean the index is not needed. Before dropping, consider the limitations:
> - Usage statistics are per server. An index unused on the primary may serve queries on standbys. Standbys appear in pgscope as separate servers — check the index in their reports.
> - `pg_stat_reset()` and a crash restart of PostgreSQL zero the counters. The **since stats reset** mode then lists indexes that simply have not had time to be used since the reset; check **Stats reset** on the database page. In the "last N days" mode, an index whose counter dropped below the baseline after a reset is, on the contrary, not listed.
> - An index that was not in the report at the start of the period (created later) is not shown in the "last N days" mode.
> - Only indexes whose definition contains `UNIQUE` (including primary keys) are excluded from the list. Indexes that enforce exclusion constraints (`EXCLUDE`) are not excluded. If pgmetrics runs with `--omit=indexdefs`, there are no definitions, and unique indexes get listed too.
> - Rare but important queries (monthly reports, emergency procedures) may fall outside the chosen period.

### Bloated indexes {#bloated-indexes}

The **Bloated** tab shows every index that has a bloat estimate, by wasted space in descending order, with a **Bloat** column (bytes and share). Without estimates (for example, when pgmetrics runs with `--omit=bloat`) it shows **No index bloat estimates**. For the selected indexes it generates `REINDEX INDEX CONCURRENTLY`:

```sql
\c "shop"
REINDEX INDEX CONCURRENTLY "public"."orders_created_at_idx";
```

The estimate is approximate. Rebuilding makes sense for indexes with a noticeable share of bloat and a significant size; the pgscope diagnostics, for example, report bloated indexes over 10 MiB with more than 30% bloat (see [Checks reference](checks.md)). `REINDEX CONCURRENTLY` does not block writes, but it needs free space for a new copy of the index and takes longer than a plain `REINDEX`.

### Duplicates {#duplicate-indexes}

The **Duplicates** tab finds indexes in the same database with the same definition: the index name and the word `UNIQUE` are removed from `CREATE [UNIQUE] INDEX name ON …`, and the rest (table, method, columns, `INCLUDE`, `WHERE` condition) must match exactly. In each group the first index (in report order) is treated as the primary one; the others are listed with the columns **Duplicate of** (the name of the primary index) and **Definition**. For the selected ones it generates:

```sql
\c "shop"
DROP INDEX CONCURRENTLY "public"."orders_customer_id_idx1";  -- duplicate of orders_customer_id_idx
```

> [!WARNING]
> Because `UNIQUE` is ignored in the comparison, a unique index and a regular index on the same columns count as duplicates, and whichever comes first in the report becomes the "primary" one. Before dropping, make sure no unique index ended up in the drop list: dropping a standalone `CREATE UNIQUE INDEX` removes the uniqueness guarantee, and PostgreSQL refuses to drop an index that backs a `PRIMARY KEY` or `UNIQUE` constraint. Indexes that match only partially (for example, `(a)` and `(a, b)`) are not considered duplicates.

### Running the generated SQL {#running-sql}

- The SQL is meant for `psql`: the `\c "database"` lines are psql meta-commands that switch databases. In another client, connect to each database yourself and run only the commands.
- `DROP INDEX CONCURRENTLY` and `REINDEX … CONCURRENTLY` cannot run inside a transaction block (`BEGIN … COMMIT`); run them one at a time in autocommit mode. `DROP INDEX CONCURRENTLY` cannot be used on indexes of partitioned tables — use a plain `DROP INDEX` in a maintenance window for those.
- If a `CONCURRENTLY` command is interrupted, it may leave an invalid (`INVALID`) index behind — drop it and retry.
- Drop indexes on a test environment first and save their definitions (`pg_get_indexdef`) so you can quickly recreate an index if needed.

## Top-k {#topk}

The **Top-k** page ranks the largest, busiest and fastest-growing objects. Pick the object type, the criterion and the list length (**Top 10**, **Top 25**, **Top 50**).

| Type | Criteria |
|---|---|
| **Tables** | **Size**, **Live rows**, **Dead rows**, **Bloat**, **Sequential scans**, **Writes (ins + upd + del)**, **Size growth**, **Row count growth** |
| **Indexes** | **Size**, **Bloat**, **Scans**, **Size growth** |
| **Schemas** | **Table size**, **Index size**, **Rows**, **Table count**, **Index count** |

A schema in the ranking is a `database.schema` pair; its size and row count add up the tables and indexes of that schema in the report. Objects whose criterion value is zero are left out. The **Sequential scans**, **Writes (ins + upd + del)** and **Scans** counters are cumulative — they show the load since the stats reset, not over the last few days. Clicking a table or index opens its page.

### Object growth {#growth}

The **Size growth** and **Row count growth** criteria compare the current report with the first stored report received no earlier than the start of the period: **over 1 day**, **over 7 days** or **over 30 days**. Above the list the page shows "Compared with the report from …". A decrease is shown with a "−" sign and a yellow bar.

Details:

- If the server's history is shorter than the period, the comparison uses the earliest stored report — check the date in the caption.
- Objects that were not in the report at the start of the period (created later) do not appear in the growth ranking.
- The start of the period is counted from the current moment, not from the report selected in the server bar.
- Without suitable history the page shows **Nothing to rank** with the explanation **Not enough history for this period yet.**

Size growth is the main tool for finding out where the disk space is going: combine it with [Tablespaces](#tablespaces) and [WAL and checkpoints](server.md#wal).

## Tablespaces {#tablespaces}

The **Tablespaces** page shows a card for each tablespace:

- name, owner ("owned by …") and directory location; if pgmetrics' connection to PostgreSQL is not local (see [System](server.md#system)), `pg_default` and `pg_global` show **(data directory)** instead of a path;
- tablespace size (`pg_tablespace_size`);
- **Disk** — used and total space on the file system holding the tablespace, and **Inodes** — the share of inodes used. The bar turns yellow above 80% and red above 90%. pgmetrics collects this only on Linux and only over a local connection on the database host; otherwise the card says **Disk usage is collected when pgmetrics runs on the database host**.

Clicking a card selects the tablespace. Below appear:

- "Disk usage: …" — the **Tablespace size** and **Disk** (used and total) charts;
- "Objects in …" — the tables and indexes from the report that live in this tablespace, with type and size.

You can generate SQL for these objects: in the **Generate SQL to** row choose **move to** and a target tablespace, or **drop**, then tick the objects.

```sql
\c "shop"
ALTER TABLE "public"."events_2025" SET TABLESPACE "archive";
ALTER INDEX "public"."events_2025_pkey" SET TABLESPACE "archive";
```

With **drop** the page generates `DROP TABLE` and `DROP INDEX` without `CASCADE`.

> [!WARNING]
> `ALTER TABLE … SET TABLESPACE` and `ALTER INDEX … SET TABLESPACE` physically copy the object and hold an `ACCESS EXCLUSIVE` lock on it for the whole copy: reads and writes to the table will wait. Moving a table leaves its indexes where they are — move them separately. Do it in a maintenance window or use `pg_repack`. The **drop** commands delete data permanently.

> [!NOTE]
> The report does not tie tables and indexes in their database's default tablespace to a specific tablespace, and pgscope shows them under `pg_default`. If a database has a different default tablespace (`CREATE DATABASE … TABLESPACE`), its objects still end up in the `pg_default` list.

## Extensions & more {#extensions}

The **Extensions & more** page has four tabs.

| Tab | What it shows |
|---|---|
| **Extensions** | extensions in all databases: **Database**, **Schema**, **Installed**, **Available**, **Status** — **update available** or **up to date** — and **Description**. Extensions with an update available come first |
| **Functions** | user function statistics: **Calls**, **Total time**, **Self time** (without nested calls), **Mean**. Requires `track_functions = pl` or `all`; without it the tab shows a hint |
| **Sequences** | sequence access: **Blocks hit** and **Blocks read** |
| **Disabled triggers** | disabled triggers with their table and function |

An extension is updated in each database separately, for example:

```sql
ALTER EXTENSION pg_stat_statements UPDATE;
```

Read the extension's release notes before updating. **Available** is the version offered by the extension package installed on the server (`default_version`); it changes after an OS package upgrade, while the version installed in the database does not.

A disabled trigger (`ALTER TABLE … DISABLE TRIGGER`) does not fire, so auditing or denormalization, for example, silently stops working. If disabling it was temporary, enable the trigger again:

```sql
ALTER TABLE "public"."orders" ENABLE TRIGGER "orders_audit";
```

[Change alerts](change-alerts.md) can notify you when extensions are installed or removed, when their versions change and when triggers are disabled.

## Roles {#roles}

The **Roles** page lists all cluster roles with their attributes:

| Column | What it shows |
|---|---|
| **Role** | role name |
| **Can log in** | the `LOGIN` attribute |
| **Superuser** | the `SUPERUSER` attribute, marked **superuser** |
| **Create DB** | `CREATEDB` |
| **Create role** | `CREATEROLE` |
| **Replication** | `REPLICATION` |
| **Bypass RLS** | `BYPASSRLS` |
| **Conn. limit** | `CONNECTION LIMIT`, "∞" means no limit |
| **Valid until** | password expiry (`VALID UNTIL`), **no expiry** if not set |
| **Member of** | roles this role is a member of |

What to look for: every extra superuser that can log in is a security risk (the diagnostics report them with the **Additional superuser roles** check, see [Checks reference](checks.md)); `REPLICATION` and `BYPASSRLS` should be granted only to those who really need them. Monitoring needs only a role that is a member of `pg_monitor`; superuser is not required (see [Preparing PostgreSQL](postgres.md)).

To learn about new roles and changes to their attributes, turn on [change alerts](change-alerts.md).
