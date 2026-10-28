# Cloud metrics, PgBouncer and Pgpool

This page covers the data pgscope accepts besides PostgreSQL's own reports: AWS and Azure cloud platform metrics, reports from the PgBouncer connection pooler and reports from Pgpool-II. It explains when the related items appear in the interface, how to set up collection and how to read the numbers.

The **Cloud metrics** and **PgBouncer** items are in the **Integrations** group of the server sidebar. The group is shown only if the server has such data. Pgpool is not a menu item but a separate server kind in the server list.

## Cloud metrics {#cloud}

For managed AWS RDS / Aurora and Azure Database for PostgreSQL databases, pgmetrics can add cloud platform metrics to the report: CloudWatch (AWS) or Azure Monitor (Azure). The **Cloud metrics** item appears in the menu when the server's latest report contains such metrics.

> [!NOTE]
> Cloud metrics are needed only for databases running in AWS or Azure. The cloud API calls are made by pgmetrics on the machine where it runs; pgscope itself never contacts the cloud. In a closed perimeter with your own PostgreSQL servers this section is not used: pgmetrics collects host load, memory and disks itself when it runs on the database host (see [System](server.md#system)).

### Connecting AWS RDS and Aurora {#cloud-aws}

Run pgmetrics with the `--aws-rds-dbid` flag — the database instance identifier:

```bash
export AWS_REGION=eu-central-1
pgmetrics -w -f json -h mydb.xxxx.eu-central-1.rds.amazonaws.com -U pgmon --aws-rds-dbid=mydb db1 \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report mydb
```

With this flag pgmetrics:

- looks up the instance (`DescribeDBInstances`), lists its metrics in the `AWS/RDS` namespace and, for each one, takes the most recent one-minute average (the `Average` statistic with a 60 s period) from the last 5 minutes;
- if Enhanced Monitoring is enabled for the instance, reads the latest entry from the `RDSOSMetrics` CloudWatch Logs group;
- reads the PostgreSQL log through the RDS API (unless `--omit=log` is given) for the last `--log-span` minutes, so the [**Logs**](server.md#logs) page works for RDS too.

AWS errors do not stop the collection: pgmetrics prints a `failed to collect from AWS RDS` warning and builds the rest of the report. If it could not get the metrics or the Enhanced Monitoring entry, the report has neither cloud metrics nor the RDS log; a log read error does not affect the metrics.

pgmetrics gets AWS credentials the standard AWS SDK way: environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`), the `~/.aws/credentials` and `~/.aws/config` files, or the machine's IAM role. pgmetrics calls these API actions, which the account needs permission for:

| Action | Purpose |
|---|---|
| `rds:DescribeDBInstances` | find the instance and check whether Enhanced Monitoring is enabled |
| `cloudwatch:ListMetrics`, `cloudwatch:GetMetricData` | CloudWatch metrics |
| `logs:GetLogEvents` | the Enhanced Monitoring entry (only if it is enabled) |
| `rds:DescribeDBLogFiles`, `rds:DownloadDBLogFilePortion` | the PostgreSQL log (unless `--omit=log` is given) |

AWS may bill CloudWatch API requests separately.

### Connecting Azure {#cloud-azure}

Run pgmetrics with the `--az-resource` flag — the full Azure resource ID (Flexible Server, Single Server and Cosmos DB for PostgreSQL are supported):

```bash
pgmetrics -w -f json -h myserver.postgres.database.azure.com -U pgmon \
  --az-resource=/subscriptions/SUB_ID/resourceGroups/RG/providers/Microsoft.DBforPostgreSQL/flexibleServers/myserver db1 \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report myserver
```

The ID must look like `/subscriptions/<subscription ID>/resourceGroups/<group>/providers/Microsoft.DBforPostgreSQL/<type>/<name>`, where the type is `flexibleServers`, `servers` (Single Server) or `serverGroupsv2` (Cosmos DB for PostgreSQL); otherwise pgmetrics reports `invalid resource ID`. pgmetrics obtains credentials through the standard Azure SDK chain (`DefaultAzureCredential`): service principal environment variables, a managed identity, or an Azure CLI login. The account needs permission to read the resource's Azure Monitor metrics.

pgmetrics requests a fixed set of metrics for the last 5 minutes (1-minute interval, 15 minutes for Single Server) and takes the latest value of each (the average, or the total or maximum if there is no average):

| Resource type | Metrics |
|---|---|
| Flexible Server | `backup_storage_used`, `cpu_percent`, `memory_percent`, `iops`, `disk_queue_depth`, `read_throughput`, `write_throughput`, `read_iops`, `write_iops`, `storage_percent`, `storage_used`, `storage_free`, `txlogs_storage_used`, `active_connections`, `network_bytes_egress`, `network_bytes_ingress`, `connections_failed`, `connections_succeeded`, `maximum_used_transactionIDs` |
| Single Server | `cpu_percent`, `memory_percent`, `io_consumption_percent`, `storage_percent`, `storage_used`, `storage_limit`, `serverlog_storage_percent`, `serverlog_storage_usage`, `serverlog_storage_limit`, `active_connections`, `connections_failed`, `backup_storage_used`, `network_bytes_egress`, `network_bytes_ingress`, `pg_replica_log_delay_in_seconds`, `pg_replica_log_delay_in_bytes` |
| Cosmos DB for PostgreSQL | `cpu_percent`, `memory_percent`, `apps_reserved_memory_percent`, `iops`, `storage_percent`, `storage_used`, `active_connections`, `network_bytes_egress`, `network_bytes_ingress` |

For Azure only Azure Monitor metrics are collected; the PostgreSQL log is not read this way.

### What the page shows {#cloud-page}

- The subtitle is "AWS CloudWatch" or "Azure Monitor · resource name (region)".
- The cards show the first 12 metrics of the report with their current values.
- **Over time** has one chart per metric under its original name (for example, `CPUUtilization`, `FreeableMemory`, `FreeStorageSpace`, `ReadIOPS`, `WriteIOPS`, `DatabaseConnections` for AWS). pgscope derives the unit from the metric name, applying the rules in order (the first match wins): `percent`, `Utilization`, `HitRatio`, `%` and `BurstBalance` are percentages; `Aurora…Lag` and `CommitLatency` are milliseconds; `Latency`, `ReplicaLag`, `CheckpointLag`, `_in_seconds` and `Uptime` are seconds; `CommitThroughput` is operations per second; other `Throughput` names and `LogsGeneration` are bytes per second; `IOPS` is a count; `Bytes`, `Memory`, `Storage`, `Space`, `Swap`, `DiskUsage` and `SlotLag` are bytes; everything else is a count. For example, Azure's `memory_percent` and `storage_percent` are shown as percentages, `ReadThroughput` in bytes per second, `AuroraReplicaLag` in milliseconds, `SwapUsage` and `OldestReplicationSlotLag` in bytes. The cards use the same units as the charts.
- **Enhanced Monitoring** — the latest Enhanced Monitoring entry as raw JSON, if it is enabled for the RDS instance.

If you open the page for a server without cloud metrics, it shows **No cloud metrics** with a hint about the pgmetrics flags.

## PgBouncer {#pgbouncer}

pgscope accepts PgBouncer reports and attaches them to the PostgreSQL server behind the pooler. One server can have several PgBouncer instances, each under its own name. The **PgBouncer** item appears in the server menu after the first accepted pooler report (the server list in the interface refreshes once a minute), and the pooler names are listed under the server's card in the server list.

### Connecting {#pgbouncer-setup}

pgmetrics switches to PgBouncer mode when it connects to the special `pgbouncer` database, and runs `SHOW POOLS`, `SHOW SERVERS`, `SHOW CLIENTS`, `SHOW STATS` and `SHOW DATABASES`. The user must be listed in PgBouncer's `admin_users` or `stats_users`. The pgmetrics version in use parses the output of PgBouncer 1.15–1.25; if the output has a different number of columns, pgmetrics exits with an `unsupported number of columns` error and no report is produced.

```bash
pgmetrics -w -f json -h PGB_HOST -p 6432 -U pgb_stats pgbouncer \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report-pgbouncer prod-db-1 pgb-1
```

Here `prod-db-1` is the PostgreSQL server name in pgscope and `pgb-1` is the PgBouncer instance name. Both names may contain Latin letters, digits, `_`, `.`, `-`, up to 64 characters. If no server with that name exists yet, it is created. The report rate limit (`PGSCOPE_MIN_REPORT_INTERVAL`) is counted separately for each PgBouncer instance, so a pooler report can be sent right after the PostgreSQL report. A report without PgBouncer data is rejected with code 400 ("The report has no PgBouncer data"); other responses are the same as for regular reports, including 413 for a report larger than `PGSCOPE_MAX_REPORT_MB` (see [Sending reports](collect.md#responses)).

In Docker and Docker Swarm, the pgscope agent can send PgBouncer reports: besides the label the agent uses to find containers (`pgscope.enable=true` by default), the pooler container needs the labels `pgscope.kind=pgbouncer` and `pgscope.server` with the PostgreSQL server name (see [Docker and Docker Swarm](docker.md#labels)).

### What the page shows {#pgbouncer-page}

The **PgBouncer** page shows the latest report of the selected instance, and when a past moment is selected in the server bar, its report at or before that moment (the report time is in the subtitle "Report from …"; if there is no PgBouncer report up to that moment, the page shows **No PgBouncer report at this moment**). The **‹** and **›** buttons step through the main server's reports; the charts cover the selected period, and clicking them selects a moment. If there are several instances, the switcher is at the top right.

Cards (from `SHOW CLIENTS` and `SHOW SERVERS`):

| Card | What it shows |
|---|---|
| **Active client connections** | clients linked to a server connection or ready to run queries |
| **Waiting clients** | clients waiting for a free server connection; above zero is highlighted |
| **Max client wait** | the longest wait among waiting clients; highlighted when above one second; the caption shows the average |
| **Active server connections** | connections to PostgreSQL in use by clients |
| **Idle server connections** | free connections ready to be handed out |
| **Used server connections** | connections waiting for a check (`server_check_query`) before reuse |

The **Connections over time** block: the **Client connections** chart (active, waiting, idle), **Server connections** (active, idle, used) and **Client wait time** (maximum and average, in seconds).

The **Databases** block (`SHOW DATABASES`): **Name**, **Target server** (`host:port/database`, `local` means a Unix socket), **User (force_user)**, **Connections** (current and maximum) and **State** — **running**, **paused** (`PAUSE`) or **disabled** (`DISABLE`).

The **Traffic by database** block (`SHOW STATS`): **Database**, **Transactions**, **Queries**, **Avg query time**, **Avg wait**, **Received**, **Sent**. **Avg query time** and **Avg wait** are `avg_query_time` and `avg_wait_time` from `SHOW STATS`. The counters are cumulative since PgBouncer started. For the database chosen in the selector on the right, the page shows the "Transactions & queries · …" (per hour) and "Network · …" (bytes per second) charts.

The **Pools** block (`SHOW POOLS`): **Pool** (`database/user`), **Mode** (`session`, `transaction`, `statement`), **Active clients**, **Waiting clients** (highlighted), **Active servers**, **Idle servers**, **Used servers**, **Max wait**. For the pool chosen in the selector on the right, the page shows the "Connections · …" and "Client wait · …" charts.

### How to read the numbers {#pgbouncer-tuning}

- *Clients are waiting* (**Waiting clients** above zero, **Max wait** growing) and all server connections of the pool are active — the pool is too small for the load. Increase `default_pool_size` (or the database's `pool_size`) with PostgreSQL's `max_connections` in mind, or look for long transactions holding connections (the [**Backends**](activity.md#backends) page).
- *Clients are waiting although the pool has fewer server connections than `default_pool_size`* — check PgBouncer's `max_db_connections` and `max_user_connections` limits, and whether PostgreSQL's `max_connections` is exhausted.
- *`session` mode* holds a server connection for the whole client session; for short queries `transaction` mode is more efficient, provided the application does not rely on session state.
- **paused** / **disabled** for a database — someone ran `PAUSE` or `DISABLE` in the console; new connections to that database wait or are rejected.

> [!NOTE]
> Alert rules work only on PostgreSQL metrics (see [Alert rules](alerts.md)); there are no rules for PgBouncer, Pgpool or cloud metrics.

## Pgpool {#pgpool}

Pgpool-II is monitored as a separate server of kind `pgpool`: in the server list it has its own icon, the "Pgpool" caption with the version, and the **Backends up**, **Cache hit ratio** (of the query cache) and **Report** cards. In the server switcher its name gets the `(pgpool)` suffix.

### Connecting {#pgpool-setup}

pgmetrics collects Pgpool data with the `--pgpool` flag:

```bash
pgmetrics -w -f json -h PGPOOL_HOST -p 9999 -U pgmon --pgpool postgres \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report-pgpool pool-1
```

pgmetrics runs `SHOW POOL_VERSION`, `SHOW POOL_NODES`, `SHOW POOL_CACHE` and, on Pgpool-II 4.2+, also `SHOW POOL_HEALTH_CHECK_STATS` and `SHOW POOL_BACKEND_STATS`; the version in use parses the output of Pgpool-II 4.0–4.7 and exits with an error on any other format.

`pool-1` is the Pgpool server name in pgscope (the same rules as for PostgreSQL server names). PostgreSQL and Pgpool server names do not collide: a `pool-1` server of kind `pgpool` and a `pool-1` server of kind `postgres` are different objects. A report without Pgpool data is rejected with code 400 ("The report has no Pgpool data"). The pgscope agent for Docker does not send Pgpool reports — use cron or a systemd timer.

### What the page shows {#pgpool-page}

A Pgpool server's menu has two items: **Overview** (the "Pgpool" page) and **Team & settings** (see [Team, profile and account](teams.md#server-settings)). The page subtitle shows the Pgpool-II version and the report time.

Cards:

| Card | What it shows |
|---|---|
| **Backends up** | nodes in `up` or `waiting` status out of the total; highlighted when not all are up |
| **Query cache hit ratio** | Pgpool query cache hit ratio |
| **Cache hits** | number of hits and, in the caption, the number of SELECTs |
| **Cache entries** | cache entries and hash table usage |
| **Cache used** | cache space used and, in the caption, free space |
| **Fragmented** | fragmented cache space |

The cache figures make sense only if Pgpool's in-memory query cache is enabled (`memory_cache_enabled`).

The **Backends** block lists the PostgreSQL nodes behind Pgpool: **Node**, **Host**, **Status** (`up` and `waiting` in green, `down` in red), **Role**, **LB weight**, **LB node**, SELECT, **Write** (INSERT + UPDATE + DELETE), **Errors** (ERROR + FATAL + PANIC, shown in red), **Replication lag** (in seconds if Pgpool reports it as time, otherwise in bytes) and **Repl. state**.

The **Health checks** block shows per-node health check statistics: **Total**, **Success rate**, **Failed** (shown in red), **Skipped**, **Retries**, **Avg duration**, **Max duration**, **Last check**, **Last failure**.

The **Over time** block with a node selector: **Query cache** (SELECTs and cache hits per second), **Backends up** (up and total), "Statements · node …" (SELECT, INSERT, UPDATE, DELETE per second) and "Replication lag · node …" (in seconds). The last chart stores only the time-based lag: if Pgpool reports the lag in bytes, the chart shows zero, and the actual value is in the **Backends** table.

Some figures (write and error counters, health check statistics) are reported by Pgpool-II starting with version 4.2; on older versions these fields are empty.

How to read it: a node in `down` status is out of service — check that it is reachable and run `pcp_attach_node` once it has recovered; growing **Failed** health checks mean an unstable network or an overloaded node; a large standby lag with read load balancing means clients read stale data.

## Limitations {#limitations}

- Pgpool servers have no diagnostics, AI chat, alert rules or change alerts: any page address of such a server except **Team & settings** opens the Pgpool page. Pgpool servers are not shown in the **Inspector**.
- There are no alerts on cloud metrics or PgBouncer figures.
- The **Cloud metrics** item depends on the server's latest report: if it has no cloud metrics (for example, pgmetrics could not get them because of an access error), the item disappears until the next report with metrics.
- The latest report of each PgBouncer instance is kept indefinitely (like the latest report of any source, see [Data storage](data.md#retention)), so a decommissioned pooler stays in the switcher until the server is deleted.
