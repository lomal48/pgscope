# Queries, backends and locks

This page describes the **Activity** group of a PostgreSQL server: **Queries** — `pg_stat_statements` statistics with charts, suggestions and execution plans, **Backends** — all client connections at the time of the report, and **Locks** — blocking chains and the list of all locks.

All three pages show a snapshot from a report — the latest one or the one selected in the top bar (see [Viewing a past report](ui.md#report-picker)). pgscope sees the server only at the moments reports are collected (usually every few minutes), so short spikes between reports do not appear in the snapshot.

## Queries {#queries}

The **Queries** page (address `#/s/<id>/queries`) shows the heaviest queries on the server based on the `pg_stat_statements` extension.

### Where the data comes from {#queries-source}

- pgmetrics reads the `pg_stat_statements` view and puts the queries with the highest total execution time into the report. By default that is 100 queries (the pgmetrics `--statements-limit` flag), with texts truncated to 500 characters (the `--sql-length` flag).
- All metrics are cumulative: they grow from the last `pg_stat_statements` statistics reset (`pg_stat_statements_reset()`).
- Query texts are normalized by PostgreSQL itself: as a rule, constants are replaced with `$1`, `$2` and so on.

If the extension is not installed or not readable by the monitoring role, the page shows **No query statistics** with instructions: add `pg_stat_statements` to `shared_preload_libraries`, restart PostgreSQL and run `CREATE EXTENSION pg_stat_statements` in each database. Details are in [Preparing PostgreSQL](postgres.md).

Some metrics appear only with additional PostgreSQL settings:

| Metric | What is needed |
|---|---|
| block read and write time | `track_io_timing = on` |
| planning time and number of plans | `pg_stat_statements.track_planning = on` |
| JIT metrics | PostgreSQL 15 or later |
| execution plans | `auto_explain` with `auto_explain.log_format = json` and pgmetrics access to the PostgreSQL log: the log in `stderr` or `csvlog` format (PostgreSQL 13+ `csvlog` only with [pgmetrics built by pgscope](collect.md#pgmetrics-build)), pgmetrics running on the database host with a local connection (`--aws-rds-dbid` for RDS / Aurora), see [Execution plans](#plans) |

### Query list {#queries-list}

The header shows the number of distinct queries in the report (the rows of one query from different users count as one query) and their total execution time. Above the table there is a database picker (**All databases** or a specific one) and a **Filter…** field that searches the query text, the user and the database. By default the table is sorted by total time.

| Column | What it shows |
|---|---|
| **Query** | the normalized query text; the table cuts it to two lines, the full text is on the query page |
| **Database**, **User** | where and as whom the query ran; if several users ran the query in that database, they are listed separated by commas |
| **Calls** | number of executions |
| **Total time** | total execution time; the bar shows the query's share of the total time of all collected queries |
| **Mean** | total time / calls |
| **Max** | the longest single execution |
| **Rows/call** | average number of rows returned or affected |
| **Cache hit ratio** | share of blocks read from `shared_buffers`; below 90% it is highlighted in yellow |
| **Temp files** | volume the query wrote to temporary files (number of temp blocks × 8 KiB) |

How to use it:

- **Sorting by Total time** shows where the server spends most of its time. That is the main optimization candidate: making a frequent query 10% faster can give more than making a rare one 10 times faster.
- **Sorting by Mean and Max** finds slow individual executions that users notice.
- **Sorting by Calls** finds queries the application calls too often (for example, N+1 in an ORM).
- **Temp files** indicate sorts and hashes that do not fit in `work_mem`.

Clicking a row opens the query page.

> [!NOTE]
> `pg_stat_statements` keeps a separate row for each user who ran a query. pgscope merges the rows of one query in one database (with the same `queryid`): calls, time, rows, blocks and the other counters are summed, **Max** and the minimum time are taken over all users, the standard deviation covers all executions, and **Mean** is total time / calls. The cards and charts of the query page and the **Query**-level alert rules use the same numbers (see [Query](alerts.md#metrics-query)). Rows of dropped databases come without a database name, so the same query from several dropped databases is merged into one as well.

### Query page {#query-detail}

The page address is `#/s/<id>/queries/<database>/<queryid>`. If the query is not in the displayed report (for example, a past report is selected or the query dropped out of the collected set), the header says **Not in the selected report**. In that case the charts are still shown if there is data for them; the cards, suggestions and the **Statistics** section are absent, and the plans section is empty.

The page contains:

- below the title, the users and the database as `user@database` (several users separated by commas);
- the full query text (within `--sql-length`) with a **Copy** button;
- cards: **Calls**, **Total time**, **Mean time**, **Max time** (with the minimum time below it), **Rows** (with rows per call), **Cache hit ratio**, each covering all users of the query;
- a **Suggestions** card — automatic recommendations (see [Query suggestions](#query-suggestions));
- the **Over time** section — charts for this query (see [Query charts](#query-charts));
- the **Statistics** section — all remaining `pg_stat_statements` fields: time standard deviation, shared blocks (hit, read, dirtied, written), local and temp blocks, block read and write time, number of plans and planning time, WAL records, full-page images, WAL bytes, JIT functions and JIT generation time, query ID;
- the **Execution plans** section (see [Execution plans](#plans)).

### Query suggestions {#query-suggestions}

The **Suggestions** card appears when at least one rule matches the query:

| Condition | Suggestion |
|---|---|
| more than 10,000 shared block accesses (hits + reads) and a cache hit ratio below 90% | an index that reduces the rows scanned, or more `shared_buffers` / RAM |
| the query wrote temporary files | increase `work_mem` for this workload or add an index that provides the required order |
| more than 1,000 rows per call on average | `LIMIT`, keyset pagination or aggregation in SQL |
| more than 10 calls, standard deviation above 2 means and maximum above 10 means | look for parameter-dependent plans, lock waits, a cold cache |
| block read and write time above 30% of the total time (with a total time above 1 s) | the query is bound by disk I/O |
| planning time above half of the execution time (and above 100 ms in total) | prepared statements, to plan once |
| JIT takes more than 10% of the time (and more than 100 ms) | `jit = off` or a higher `jit_above_cost` |
| more than 100,000 calls with a mean time below 0.5 ms | caching results in the application or batching calls |
| the query generated more than 1 GiB of WAL | batch bulk changes or use `COPY` |
| problems found in the collected JSON plans | plan warnings prefixed with **Plan:** (see [Reading a plan](#plan-view)) |

### Query charts {#query-charts}

The **Over time** section is built from this query's values in every report within the selected range:

| Chart | What it shows |
|---|---|
| **Calls** | calls per second |
| **Mean execution time** | the mean time of one execution for each interval between reports; shows when the query started running slower |
| **Rows** | rows per second |
| **Shared blocks** | block **Hits** and **Reads** per second |
| **Total time spent** | milliseconds of execution per second: 1000 ms/s means that on average one connection was executing this query all the time |
| **Temp blocks written** | temp blocks per second |

There are points only for reports that contain the query. If the query keeps entering and dropping out of the set collected by pgmetrics, the charts have gaps. After `pg_stat_statements_reset()` the rate is not computed for the interval containing the reset.

### Execution plans {#plans}

The **Execution plans** section shows the plans of this query that the `auto_explain` module wrote to the PostgreSQL log. For them to appear:

1. Enable `auto_explain` and set the JSON format — only JSON is drawn as a tree; plans in other formats are shown as text:

```ini
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = 2000   # plans of queries longer than 2 seconds
auto_explain.log_analyze = on          # actual rows and loops
auto_explain.log_timing = off          # on gives per-node time, at a higher overhead
auto_explain.log_format = json
```

2. Give pgmetrics access to the log. pgmetrics reads the log only when it runs on the database host and connects locally (through a Unix socket or 127.0.0.1); the `--log-file` and `--log-dir` flags only tell it where the log is and do not replace a local connection. For AWS RDS / Aurora the log is read through the API with the `--aws-rds-dbid` flag. The log is written in `stderr` format (`log_destination = 'stderr'`) with a timestamp in `log_line_prefix`, for example `'%m [%p] %q%u@%d '`, or in `csvlog` format. PostgreSQL 13+ `csvlog` is read only by [pgmetrics built by pgscope](collect.md#pgmetrics-build); official releases skip such files (details in [Logs](server.md#logs)). Only entries from the last few minutes are taken from the log: 5 by default, set by the `--log-span` flag (see [Sending reports](collect.md)).

Without plans the section shows **No execution plans captured** with the same hints.

How plans are matched to a query: by query ID if the plan contains one, otherwise by text (among plans of the same database or plans without a database). When texts are compared, constants and `$n` parameters are replaced with the same placeholder, and case and whitespace are ignored. For very long queries whose text is truncated in `pg_stat_statements`, text matching may fail.

The three latest plans are shown; the rest are behind the **Show all N plans** button. Above each plan are the time it was logged, the user and the database.

### Reading a plan {#plan-view}

A JSON plan is shown as a tree of nodes. Nodes with children collapse when you click the arrow.

Above the tree:

- **total …** — the total execution time, if the plan has per-node timing (`auto_explain.log_timing = on`);
- **bars show share of cost (no timing data)** — if there is no per-node timing;
- the total number of result rows, if `log_analyze` is on.

A node line:

| Element | What it shows |
|---|---|
| node type | for example, `Seq Scan`, `Index Scan`, `Hash Join (Inner)` |
| object | a table (`on schema.table alias`), an index (`using index`) or a CTE |
| actual rows | rows the node returned, and `× N` — the number of loops if the node ran several times |
| **est. N** | how many rows the planner expected |
| time | the node's own time (excluding children), if there is per-node timing |
| **cost N** | the node's total cost as estimated by the planner |
| conditions | `Index Cond`, `Recheck Cond`, `Hash Cond`, `Merge Cond`, `Join Filter`, `Filter`, `Sort Key`, `Group Key` |

The bar under a node is its share of the total time (the node's own time) or, if there is no timing, its cost as a share of the whole plan's cost. Bar color: red above 50%, yellow above 20%, otherwise the regular color. Start the analysis with the red nodes. Note that a node's estimated cost includes the cost of its children: without timing data the root bar is always full, and the bars of upper nodes are longer than their own contribution.

Warnings are shown under a node:

| Warning | When it appears | What to do |
|---|---|---|
| the planner expected fewer rows than it got | actual rows exceed the estimate by more than 10 times (when either value is above 100); overestimates are not counted because they are normal under `LIMIT` | `ANALYZE` the table or add extended statistics (`CREATE STATISTICS`) |
| `Seq Scan` discards many rows | the filter removed more than 1,000 rows and 10 times more than it returned | an index on the filter columns |
| sort spilled to disk | an `external` sort method | increase `work_mem` |
| hash split into batches | the hash has more than one batch | increase `work_mem` |
| `Nested Loop` ran many times | more than 1,000 loops of the node | check row estimates and indexes for the join |
| many heap fetches in an Index Only Scan | `Heap Fetches` above 10,000 | `VACUUM` to update the visibility map |

Estimate mismatch warnings need actual rows, that is `auto_explain.log_analyze = on`.

## Backends {#backends}

The **Backends** page (address `#/s/<id>/backends`) shows all client connections to the server at the time of the report. The header shows the number of connections and the report time. All ages (transaction, query, connection) are measured from the time of the report.

On PostgreSQL 10 and later pgmetrics collects only client backends (`backend_type = 'client backend'`); background processes are counted in the **Backend types** section. Query texts are truncated to 500 characters (the pgmetrics `--sql-length` flag).

### Cards and filters {#backends-filters}

| Card | What it counts | Highlighting |
|---|---|---|
| **Total** | all client connections | — |
| **Active** | the `active` state | green |
| **Idle** | the `idle` state | — |
| **Idle in transaction** | the `idle in transaction` and `idle in transaction (aborted)` states | yellow if above 0 |
| **Waiting for locks** | `wait_event_type = Lock` | red if above 0 |
| **Transactions > 5 min** | the transaction has been open for more than 5 minutes | yellow if above 0 |

Above the table are the **All databases**, **All users**, **All applications** and **All states** filters, a **Waiting only** checkbox (only backends waiting for locks) and a **Filter…** field that searches the PID, the query text and the client address.

### Backends table {#backends-table}

Sorted by transaction age by default (oldest first). Rows of backends waiting for a lock are tinted red, rows of backends idle in transaction are tinted yellow.

| Column | What it shows |
|---|---|
| **PID** | the process ID — used with `pg_cancel_backend` and `pg_terminate_backend` |
| **Database**, **User** | which database and role the backend is connected as |
| **Application** | `application_name` (first 24 characters) |
| **Client** | the client host name (if `log_hostname` is on) or IP address; **local** means there is no address: a Unix socket connection (or the address is hidden from the monitoring role) |
| **State** | `active` (green), `idle in transaction` (yellow), `idle` (gray), others (blue) |
| **Wait event** | the wait event type and name; a lock wait is highlighted in red |
| **Transaction age** | how long the current transaction has been open; above 5 minutes it is highlighted in yellow |
| **Query age** | how long the current query has been running (or since the last query started) |
| **Connected** | how long the connection has existed |
| **Query** | the text of the current or last query |

What to look for:

- **Long-running transactions** (especially in the `idle in transaction` state) hold a data snapshot, hold back vacuum and row freezing, and may hold locks. Limit them with `idle_in_transaction_session_timeout`.
- **Many `idle` backends** with a large `max_connections` are a sign the application needs a connection pooler.
- **Many backends waiting for locks** — open [Locks](#locks) to find the culprit.

```sql
-- terminate sessions that stay idle in a transaction for more than 10 minutes
ALTER SYSTEM SET idle_in_transaction_session_timeout = '10min';
SELECT pg_reload_conf();
```

### Charts and process types {#backends-charts}

The **Over time** section has two charts:

- **Backends by state** — **Active**, **Idle**, **Idle in transaction** and **Waiting** (waiting for locks);
- **Long-running transactions (> 5 min)** — the number of backends with a transaction longer than 5 minutes.

The **Backend types** section (PostgreSQL 10 or later) shows the number of processes of each type from `pg_stat_activity`, including background ones: `autovacuum worker`, `walsender`, `checkpointer` and others.

## Locks {#locks}

The **Locks** page (address `#/s/<id>/locks`) helps you find who is blocking whom. The header shows the total number of locks in the report and the number not granted.

### Blocking chains {#blocking-chains}

The **Blocking chains** card is built from `pg_blocking_pids()` for every backend that is waiting for a lock. It shows trees:

- at the root, a backend labeled **blocking**: it holds a lock and is not waiting for anything itself;
- below it, backends labeled **waiting** that wait for it (and, further down, those waiting for them).

For each backend the card shows the PID, the user and database, the state, how long the transaction has been open and the query text. If the locks form a cycle and there is no root, all blocking backends are shown.

If nothing is waiting, the card shows **No blocked backends**.

A typical picture: at the root, a backend in the `idle in transaction` state with a long-open transaction, and below it a queue of application queries or a migration with `ALTER TABLE`.

### All locks {#all-locks}

The **All locks** section lists every `pg_locks` row in the report. Ungranted locks come first by default and are tinted red. **Filter…** searches the PID, mode, type and relation name.

| Column | What it shows |
|---|---|
| **PID** | the process that holds or waits for the lock |
| **Database** | the database of the locked object |
| **Type** | lock type (`relation`, `transactionid`, `tuple`, `virtualxid` and so on) |
| **Mode** | lock mode (`AccessShareLock`, `RowExclusiveLock`, `AccessExclusiveLock` and so on) |
| **Relation** | the table or index name (`schema.name`); `oid N` if the object is not in the report |
| **Granted** | **granted** or **waiting** |
| **Waiting for** | how long the backend has been waiting for this lock (PostgreSQL 14 or later) |

### Wait statistics and deadlocks {#lock-stats}

- **Lock wait statistics** — cumulative statistics by lock type from `pg_stat_lock`: **Waits**, **Wait time**, **Fast-path exceeded**. The section appears only for PostgreSQL 19 or later with a pgmetrics version that collects `pg_stat_lock`.
- **The Over time section**: the **Locks** chart (**Held** — all locks in the report, **Not granted** — waiting ones) and the **Deadlocks** chart — deadlocks per minute across all databases.
- **Deadlocks in logs** — deadlock messages from the PostgreSQL log with the time and details (which processes and queries were involved). The section appears if pgmetrics reads the log (see [Execution plans](#plans), step 2).

### Dealing with a lock {#lock-actions}

pgscope shows a snapshot at the time of the report and does not terminate sessions itself. Before acting, check the current state on the server:

```sql
-- who is blocking backend 12345 right now
SELECT pid, usename, state, now() - xact_start AS xact_age, query
FROM pg_stat_activity
WHERE pid = ANY (pg_blocking_pids(12345));
```

Then, if it is acceptable for the application:

```sql
-- cancel the current query of the blocking backend
SELECT pg_cancel_backend(23456);
-- terminate the whole session: its transaction will be rolled back
SELECT pg_terminate_backend(23456);
```

To run into this less often:

- set `idle_in_transaction_session_timeout` so abandoned transactions do not hold locks;
- run migrations with `SET lock_timeout = '5s'` so `ALTER TABLE` does not build a queue behind it;
- enable `log_lock_waits = on` so waits longer than `deadlock_timeout` reach the log — otherwise pgscope does not see short locks between reports.
