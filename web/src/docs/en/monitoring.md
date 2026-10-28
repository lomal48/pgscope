# Overview, diagnostics and AI chat

This page describes the **Monitor** group of a PostgreSQL server: the **Overview** — the server's main page with key metrics and charts, **Diagnostics** — an automatic check of the report for problems and configuration mistakes, and the **AI chat** — questions about the server in natural language.

## Overview {#overview}

The **Overview** opens when you click a server card on the **Servers** page, pick a server in the switcher or choose **Overview** in the menu (address `#/s/<id>`). The header shows the full PostgreSQL version string and a role badge: **Primary** or **Standby**.

All values except alerts come from the displayed report — the latest one or the report of the moment selected in the top bar (see [Viewing a past report](ui.md#report-picker)). If the server has not sent a single report yet, the page shows **No report received yet**, and if the selected moment is earlier than the earliest stored report, **No report at this moment**.

### Metric cards {#overview-stats}

| Card | What it shows | Highlighting |
|---|---|---|
| **Version** | the version number from `server_version` (without build details); below it, the host name if pgmetrics collected system metrics | — |
| **Uptime** | time from PostgreSQL start to the report; below it, the start date | — |
| **Backends** | client connections / `max_connections`; below it, the percentage | yellow above 75%, red above 90% |
| **Databases** | number of databases; below it, their total size | — |
| **Cache hit ratio** | share of block reads served from `shared_buffers` across all databases since the statistics reset | yellow below 90%, green otherwise |
| **Alerts** | number of triggered alerts, or **None**; the **view alerts** link opens the rules page | red with critical alerts, yellow with warnings, green with none |

How to read them:

- **Backends.** If connections are consistently above 75% of `max_connections`, applications risk being refused a connection during a spike. The usual fix is a connection pooler (such as PgBouncer) rather than a higher `max_connections`.
- **Cache hit ratio.** The value is cumulative, so it smooths out recent changes. For a typical OLTP workload it is usually 99% or higher. A value below 90% means the working set does not fit in memory or queries read a lot of unnecessary data. The **Cache hit ratio** chart below shows the picture per interval.

### Cluster {#overview-cluster}

The **Cluster** card collects instance-level information.

| Field | What it shows |
|---|---|
| **System identifier** | the cluster identifier from the control file; a primary and its physical standbys share it |
| **Timeline** | the timeline number; it increases after a standby promotion or point-in-time recovery |
| **Last checkpoint** | time from the last checkpoint to the report; the exact time on hover |
| **Checkpoint / REDO LSN** | WAL positions of the last checkpoint and of its REDO start point |
| **Current WAL LSN** | the current WAL write position (on a primary) |
| **Replay LSN** | the position of the last replayed WAL (on a standby, instead of the previous field) |
| **Transaction IDs** | how many transaction IDs are in use (next XID minus the oldest, modulo 2³²) and the share of the 2,147,483,647 limit; the oldest and next XID on hover |
| **Notification queue** | LISTEN/NOTIFY queue usage as a percentage |
| **Configuration reloaded** | time from the last configuration reload to the report |
| **Data directory** | the `data_directory` value; "—" if the setting is not visible to the monitoring role |
| **Collected by** | the version of pgmetrics that collected the report, for example "pgmetrics 1.19.1"; the **(local)** mark means pgmetrics ran on the database host. Reports without the pgmetrics version show "pgmetrics (report schema 1.x)": that is the version of the report format, not of pgmetrics |

Things worth attention: an old last checkpoint under active writes (check `checkpoint_timeout` and the [WAL](server.md#wal) page), a high share of transaction IDs in use (see [Vacuum](server.md#vacuum)), non-zero notification queue usage (some listener is not consuming notifications).

### Active alerts {#overview-alerts}

The **Active alerts** card shows up to 20 triggered alerts: a severity icon, the rule text, the object and the current value. The **Manage** button opens the rules page (see [Alert rules](alerts.md)). If nothing is triggered, it says **No triggered alerts**.

The card and the **Alerts** counter always show the current alert state, even when a past moment is selected in the top bar; the card then reads **Current state, not as of the report** under its title.

### Activity charts {#overview-charts}

The **Activity** section contains charts for the range selected in the top bar (see [Charts](ui.md#charts) for how charts work).

| Chart | Series | What it shows |
|---|---|---|
| **Transactions** | **Commits**, **Rollbacks** | commits and rollbacks per second across all databases; a spike in rollbacks usually means application errors |
| **Backends** | **Total**, **Active**, **Idle in transaction**, **Waiting for locks** | client connections by state; growth of **Waiting for locks** is a reason to open [Locks](activity.md#locks) |
| **Rows** | **Fetched**, **Inserted**, **Updated**, **Deleted** | rows per second across all databases (`tup_fetched`, `tup_inserted`, `tup_updated`, `tup_deleted`) |
| **Cache hit ratio** | **Hit ratio** | `shared_buffers` hit ratio for each interval between reports |
| **WAL generation** | **WAL** | WAL bytes per second from the change in WAL position; on a standby, the replay rate. A report without the current WAL position adds no point |
| **Total database size** | **Size** | total size of all databases |
| **Temp files written** | **Temp files** | bytes per second written to temporary files; a persistently high value means sorts and hashes do not fit in `work_mem` |
| **Transaction ID range** | **XIDs in use** | difference between the next and the oldest XID (modulo 2³²); normally a sawtooth — freezing regularly brings it down; steady growth without drops means freezing is not keeping up |
| **Load average** | **Load (1m)** | host load average; only with system metrics |
| **Memory** | **Used**, **Cache**, **Buffers**, **Free** | host memory usage; only with system metrics |

pgmetrics collects system metrics (load, memory, host name) only when it runs on the same Linux host as PostgreSQL.

### Databases table {#overview-databases}

The **Databases** section is a compact list of the server's databases (10 rows per page, largest first):

| Column | What it shows |
|---|---|
| **Database** | database name |
| **Size** | database size |
| **Backends** | connections to the database |
| **Commit ratio** | share of commits among finished transactions since the statistics reset |
| **Cache hit ratio** | the database's cache hit ratio since the statistics reset |
| **XID age** | `age(datfrozenxid)` — the age of the oldest unfrozen transaction ID in the database |

Clicking a row opens the database page; the **All databases** button opens the full list (see [Databases](objects.md#databases)).

## Diagnostics {#diagnostics}

**Diagnostics** (address `#/s/<id>/diagnostics`) checks the server's report automatically and shows the problems it finds and recommendations for settings. It is a quick way to see what is wrong with a server without going through every page.

### How results are produced {#diagnostics-how}

- When you open the page, the pgscope server analyzes the displayed report — the latest one or the one selected in the top bar. The header shows the time of the checked report: **Automatic checks on the report from …**.
- Checks run again each time the page is opened or refreshed (and automatically once a minute while the latest report is displayed); results are not stored anywhere and not sent out. To get notified about problems, set up [alert rules](alerts.md).
- Problem and recommendation texts are produced in the interface language.
- Many checks rely on cumulative PostgreSQL counters that grow from the last statistics reset: unused indexes, deadlocks, cache hit ratio, rollback ratio, temp files. Right after a statistics reset such checks find nothing, and with statistics that have not been reset for a long time they may show old problems.
- The same results are passed to the [AI chat](#ai-chat) as part of its context.

### Health issues tab {#issues}

Above the tabs there are three counters: **Critical**, **Warnings** and **Suggestions**. Below are cards for the problems found, sorted by severity: critical first, then warnings, then suggestions.

| Severity | Stripe and icon color | Meaning |
|---|---|---|
| critical | red | a threat to availability or data safety: act immediately |
| warning | yellow | a performance or reliability problem: look into it soon |
| suggestion | blue | a recommendation that improves operation or simplifies maintenance |

A problem card contains:

- the title and a category label;
- the number of affected objects;
- an explanation of the problem and what to do;
- a **Show details** / **Hide** button with the list of objects (databases, tables, indexes, backends, slots); for critical problems the list is expanded right away; the list has at most 50 lines, the rest are summarized as "… and N more";
- a **View** button that leads to the server page where the problem is easiest to work on.

If there are no problems, the tab shows **No issues found** and **This server looks healthy.**

### What is checked {#issue-checks}

| Category | What is checked | Possible severities |
|---|---|---|
| **Vacuum** | databases close to transaction ID wraparound, high XID age, an anti-wraparound autovacuum that is due | critical, warning, suggestion |
| **Replication** | inactive slots, lagging standbys, a standby not keeping up with WAL replay, paused replay, logical replication subscription errors | warning |
| **WAL** | archiving failure, files waiting to be archived, too many files in `pg_wal`, checkpoints that are too frequent | critical, warning |
| **Backends** | connections close to `max_connections`, long-running transactions, idle in transaction, a filling notification queue | critical, warning |
| **Locks** | backends waiting for locks, deadlocks by counter and in the log | warning, suggestion |
| **Databases** | data checksum failures, low cache hit ratio, many rollbacks, heavy temp file usage | critical, warning, suggestion |
| **Tables** | bloat, many dead rows, tables never vacuumed or analyzed, large tables read by sequential scans, tables without a primary key or unique index | warning, suggestion |
| **Indexes** | unused, duplicate and bloated indexes | warning |
| **Extensions**, **Objects** | available extension updates, disabled triggers | suggestion |
| **Disk** | a disk holding a tablespace filling up | critical, warning |
| **Server** | a PostgreSQL version that no longer receives fixes | warning |
| **Security** | additional superuser roles that can log in | suggestion |
| **Queries** | missing `pg_stat_statements` statistics | suggestion |

The full list of checks with thresholds and recommendations is in the [Checks reference](checks.md).

### Configuration check tab {#config-check}

This tab compares the PostgreSQL settings in the report with common recommendations. Recommendations are grouped into four cards:

| Card | Examples of checked settings |
|---|---|
| **Security** | `ssl`, `password_encryption`, `listen_addresses`, `log_connections`, `log_disconnections`, `row_security` |
| **Data Safety** | `fsync`, `full_page_writes`, `synchronous_commit`, `data_checksums`, `wal_level`, `archive_mode` |
| **Performance** | `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `random_page_cost`, `checkpoint_completion_target`, `track_io_timing`, `effective_io_concurrency`, `max_connections`, `shared_preload_libraries` |
| **Reliability** | `autovacuum`, `track_counts`, `log_min_duration_statement`, `idle_in_transaction_session_timeout`, `log_checkpoints`, `log_lock_waits`, `log_autovacuum_min_duration`, `hot_standby_feedback`, `max_slot_wal_keep_size` |

Each card header shows the number of recommendations, or **Nothing to recommend** with a **Looks good** note. Each recommendation contains a severity (**Critical**, **Warning** or **Info**), the setting name with its current value and the advice. A recommendation is shown only if the setting is present in the report.

Recommendations are general-purpose heuristics. For example, the advice to lower `random_page_cost` to 1.1 assumes SSDs, and the `shared_buffers` advice assumes a server dedicated to PostgreSQL. Evaluate them against your hardware and workload. The same check is available on the **Configuration check** tab of the [Configuration](server.md#config) page.

### Diagnostics and alerts {#diagnostics-vs-alerts}

| | Diagnostics | Alert rules |
|---|---|---|
| What is checked | a fixed set of pgscope checks | metrics and thresholds you define yourself |
| When | when the page is opened, on the displayed report | on every new report |
| Notifications | none | yes, through the configured channels |
| Where it shows | the **Diagnostics** page, the AI chat context | the badge on the server card, the **Overview**, the **Alerts** page |

A convenient way to work: use diagnostics for periodic server reviews, and create [alert rules](alerts.md) for situations you need to learn about right away (disk filling up, standby lag, XID age).

## AI chat {#ai-chat}

The **AI chat** (address `#/s/<id>/chat`, the robot button in the top bar) answers questions about the server in natural language, based on the data of the latest report.

> [!WARNING]
> The AI chat sends data about the server to an external cloud service: questions and a condensed extract of the report go to the Anthropic API. Without the `PGSCOPE_AI_KEY` key the chat is disabled and sends nothing anywhere. For a closed network, see [Closed networks](#ai-air-gapped).

### Enabling the chat {#ai-setup}

The chat is configured with environment variables of the pgscope process (details in [Configuring pgscope](config.md#ai)):

| Variable | Default | Purpose |
|---|---|---|
| `PGSCOPE_AI_KEY` | — | Anthropic API key; without it the chat is disabled |
| `PGSCOPE_AI_MODEL` | `claude-opus-5-5` | the model questions are sent to |
| `PGSCOPE_AI_BASE_URL` | — | a different Anthropic API address, for example a corporate proxy or gateway |

There are no other providers: the chat always uses the Anthropic API. The `PGSCOPE_AI_PROVIDER` variable from earlier versions is no longer read; you can remove it from your settings.

The variables are read only at startup, so pgscope must be restarted after a change:

```bash
PGSCOPE_AI_KEY=your-anthropic-key \
PGSCOPE_DB=postgres://pgscope@dbhost/pgscope \
PGSCOPE_BASE_URL=http://monitor:8080 \
./pgscope
```

If no key is set, the chat page shows **AI chat is not configured. Set PGSCOPE_AI_KEY (an Anthropic API key) and restart pgscope.**, and the input field and suggested questions are disabled.

### Using the chat {#ai-usage}

- While the conversation is empty, the page offers ready-made questions: **Briefly assess the health of this server.**, **Which queries should I optimize first, and how?**, **Which indexes should I drop or add?**, **Is autovacuum keeping up? Is there a transaction ID wraparound risk?**, **Review the configuration for the current workload.** Clicking such a question sends it right away.
- Enter sends the question, Shift+Enter inserts a line break. While the model is answering, **Thinking…** is shown; the answer arrives in one piece, without streaming.
- Answers are formatted: headings, lists, bold text, code and SQL blocks.
- The model answers in the interface language; if you ask in another language, it answers in the language of the question.
- The answer is always based on the server's **latest** report, even if a past report is selected in the top bar.
- The conversation is kept only in the current browser tab, separately for each server: it survives a page reload but disappears when the tab is closed. It is not stored on the pgscope server and is not visible to other users. The **New conversation** button clears it.
- Every question sends the whole conversation history. A conversation can have at most 50 messages, that is at most 25 questions; after that, start a **New conversation**.
- Any user with access to the server can use the chat.

Model answers can contain mistakes. Check the suggested SQL commands and configuration changes before applying them to a production server.

### What data is sent to the model {#ai-context}

With every question pgscope sends the Anthropic API an instruction for the model (the system prompt), the conversation history and a condensed extract of the latest report in JSON:

| Extract section | Contents |
|---|---|
| server information | the server name in pgscope, the report collection time, the full PostgreSQL version, the start time, the recovery mode, the system identifier, the timeline |
| WAL and background processes | number of WAL files and of files ready for archiving, archiver statistics, bgwriter, checkpointer and WAL statistics |
| host and storage | system metrics (if any, including the host name), tablespaces, databases |
| replication | outgoing and incoming replication, slots |
| activity | process counts by type, the total number of backends, up to 60 backends in any state other than `idle` (backends without a state are not sent either) with their query texts, ungranted locks and blocking PID chains |
| analysis | the results of [diagnostics](#diagnostics) and the [configuration check](#config-check) |
| objects | extensions, roles, progress of running VACUUM operations, the 40 largest tables and the 40 largest indexes |
| settings | all settings whose values differ from the defaults |
| queries | the 25 queries with the highest total time from `pg_stat_statements`: text, database, user, calls, total, mean and maximum time, rows, blocks |
| cloud | AWS RDS metrics, if present in the report |

The extract is rebuilt for every question from the latest report at that moment. The system prompt together with the extract is marked for caching on the Anthropic side: until a new report arrives the extract does not change, and follow-up questions are processed more cheaply. Once a new report arrives the extract is different and the cache is not used.

> [!WARNING]
> Query texts from `pg_stat_activity` contain actual parameter values, and texts from `pg_stat_statements` may contain literals. Together with database, table, role and host names they leave your network. Assess this against your data requirements before enabling the chat.

### Limitations and errors {#ai-errors}

| Message | HTTP code | Cause and what to do |
|---|---|---|
| **AI chat is not configured: set an Anthropic API key in PGSCOPE_AI_KEY** | 501 | no key is set; set `PGSCOPE_AI_KEY` and restart pgscope |
| **Invalid request** | 400 | the conversation has more than 50 messages or the request is malformed; start a **New conversation** |
| **No reports yet** | 404 | the server has not sent a single report yet |
| **The AI provider returned HTTP N** | 502 | the Anthropic API returned an error: for example, 401 — invalid key, 429 — rate limit exceeded, 5xx — a failure on the provider's side |
| **Could not reach the AI provider** | 502 | no network access to the API: check internet or proxy access, DNS and the `PGSCOPE_AI_BASE_URL` value; details are in the pgscope log |
| **The AI model declined to answer this question** | 502 | the model rejected the question; rephrase it |
| **(response truncated)** at the end of an answer | — | the answer hit the length limit (16,000 tokens); ask a narrower question |

On an error the question goes back into the input field and the conversation stays as it was, so you can send it again once the cause is fixed.

### Closed networks {#ai-air-gapped}

pgscope is designed to work without internet access. Only the AI chat and notifications to cloud services (Slack, PagerDuty, VictorOps, xMatters — see [Notification channels](notifications.md)) need outside access. For the AI chat in a closed network:

- **Leave `PGSCOPE_AI_KEY` empty.** The chat is disabled and makes no outside calls; the other pages of the interface work fully offline.
- **`PGSCOPE_AI_BASE_URL`** lets you route requests through a corporate proxy or gateway, but the data still goes to the Anthropic API.
- **Local models are not supported out of the box:** the request uses Anthropic-specific API parameters, and running through compatible gateways to local models has not been tested.
- **The in-network alternative** is [diagnostics](#diagnostics) and the [configuration check](#config-check): it is the same analysis the model receives, and it runs entirely on the pgscope server.
