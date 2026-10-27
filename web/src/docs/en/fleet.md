# Servers and Inspector

This page describes the two fleet-wide views: the **Servers** list with a card for each server, and the **Inspector** — summary tables that make it easy to compare servers and databases with each other. Both are built from a summary that pgscope recomputes on every new report of a server.

## The Servers page {#servers}

The **Servers** page opens at `#/` and from the **Servers** item in the side menu. The header shows the number of monitored servers; the server cards are below it.

The list contains:

- servers you own — they are created automatically on the first report with a new server name (the name is set in the sending command, see [Sending reports](collect.md));
- servers shared with you — they carry a **shared** label (see [Team, profile and account](teams.md)).

A server is identified by its owner, type (PostgreSQL or Pgpool) and name. If you send a report under a different name, a new server appears instead of the existing one being updated.

The list is ordered by server type (Pgpool first, then PostgreSQL) and by name. The interface reloads it once a minute, so new values on the cards appear at most a minute after a report arrives. Clicking a card opens the server's **Overview** (for Pgpool, the Pgpool dashboard).

### PostgreSQL server card {#postgres-card}

| Element | What it shows |
|---|---|
| name and **shared** label | the server name from the sending command; **shared** means the server belongs to another user and is shared with you |
| version line | `PostgreSQL` and the `server_version` value; the **standby** suffix means the server is in recovery |
| alert badge | the number of triggered alerts by severity, or **OK** (see [Alert badge](#alert-badge)) |
| **Backends** | client connections in the report and `max_connections`, as `N/M` |
| **Size** | total size of all databases on the server |
| **Cache hit ratio** | share of block reads served from `shared_buffers`, across all databases since the statistics reset; below 90% the value is highlighted in yellow |
| **Report** | time since the latest report; yellow if it is more than 15 minutes or there have been no reports |
| PgBouncer labels | names of the PgBouncer instances that have sent reports for this server (see [PgBouncer](integrations.md#pgbouncer)) |

### Pgpool card {#pgpool-card}

| Element | What it shows |
|---|---|
| version line | `Pgpool` and the Pgpool-II version |
| **Backends up** | nodes in the `up` or `waiting` state out of all nodes; highlighted in yellow if not all are up |
| **Cache hit ratio** | hit ratio of the Pgpool query cache |
| **Report** | time since the latest report (not color-coded) |

Details on Pgpool are in the [Pgpool](integrations.md#pgpool) section.

### Alert badge {#alert-badge}

The top right of the card summarizes triggered [alert rules](alerts.md):

| Badge | Meaning |
|---|---|
| red with a number | how many **Critical** alerts are triggered |
| yellow with a number | how many **Warning** alerts are triggered |
| green **OK** | no alerts are triggered |

The badge counts triggered entries, not rules: one rule matched by several objects (for example, five bloated tables) produces five entries. Rules are evaluated on every new PostgreSQL report and right after a rule is added or deleted.

> [!NOTE]
> The badge reflects alert rules only. Problems found by [diagnostics](monitoring.md#diagnostics) do not affect it. Alert rules cannot be set up for Pgpool servers in the interface, so their card always shows **OK**.

### Stale reports {#stale}

If more than 15 minutes have passed since the latest report, the **Report** value on a PostgreSQL card turns yellow, and on server pages the freshness dot in the top bar turns yellow (see [Report freshness](ui.md#freshness)). All values on the card stay as they were in the latest report.

What to check:

1. Whether the cron job, systemd timer or agent that sends reports is running (see [Sending reports](collect.md) and [Docker and Docker Swarm](docker.md#troubleshooting)).
2. What pgscope returns to the sender — response codes are described in [Server responses](collect.md#responses).
3. Whether the server was renamed in the sending command: reports under a new name create a new server, while the old card stays with stale data.

The owner can delete a server that is no longer needed with the **Delete server** button on the **Team & settings** page (see [Team & settings](teams.md#server-settings)). If reports under that name keep arriving, the server appears again.

### Empty list {#empty}

Until there are reports, the page shows **No servers yet** instead of cards, together with a ready-made command for the first report with your API key and the pgscope address from `PGSCOPE_BASE_URL` (if your account has an API key; team member accounts do not have one). Other ways to connect — PgBouncer, Pgpool, query plans, AWS RDS — are listed on the **Profile** page (see [Profile](teams.md#profile)).

```bash
pgmetrics --no-password -f json -h DBHOST -U DBUSER db1 db2 \
  | pgdash -a APIKEY --base-url=http://monitor:8080/api/v1 report my-server
```

## Inspector {#inspector}

The **Inspector** (address `#/inspector`) gathers key metrics of all servers into five tables. Use it to compare servers with each other and quickly find the worst ones: the highest XID age, the largest standby lag, the least free disk space.

Things to know:

- Only PostgreSQL servers that have sent at least one report take part. Pgpool servers are not shown.
- Values come from the latest report of each server. If a server stopped sending reports, its row shows stale data — watch the **Latest report** column on the **Servers** tab.
- Every table is sorted by clicking a column header (see [Tables](ui.md#tables)); clicking a row opens the corresponding page of that server.
- Values above thresholds are highlighted: yellow for a warning, red for critical. The thresholds are listed in the tables below. They are hints, not alerts.

### Servers tab {#inspector-servers}

One row per server. Sorted by name by default; the **Filter…** field searches server names. Clicking a row opens the server's **Overview**.

| Column | What it shows | Highlighting |
|---|---|---|
| **Server** | server name | — |
| **Version** | the `server_version` value | — |
| **Role** | **primary** or **standby** | — |
| **Uptime** | time since PostgreSQL started | — |
| **Backends** | client connections / `max_connections`; sorts by the share of connections in use | yellow above 75%, red above 90% |
| **Waiting** | backends waiting for a lock (`wait_event_type = Lock`) | yellow above 0 |
| **Idle in transaction** | backends in the `idle in transaction` state | yellow above 0 |
| **Size** | total size of the databases | — |
| **Cache hit ratio** | `shared_buffers` hit ratio across all databases since the statistics reset | yellow below 95%, red below 80% |
| **Commit ratio** | share of committed transactions among all finished ones (commit / (commit + rollback)) | — |
| **Alerts** | number of triggered alerts | red if any are critical, otherwise yellow |
| **Latest report** | time since the latest report | yellow above 15 minutes |

### Databases tab {#inspector-databases}

All databases of all servers in one table. Sorted by size by default (largest first); **Filter…** searches server and database names. Clicking a row opens the database page (see [Databases](objects.md#databases)).

| Column | What it shows | Highlighting |
|---|---|---|
| **Server**, **Database** | where the database is | — |
| **Size** | database size | — |
| **Backends** | connections to the database (`numbackends`) | — |
| **Cache hit ratio** | the database's cache hit ratio since the statistics reset | yellow below 95%, red below 80% |
| **Commit ratio** | share of commits among the database's finished transactions | yellow below 90% |
| **XID age / freeze limit** | `age(datfrozenxid)` as a percentage of `autovacuum_freeze_max_age` | yellow above 100%, red above 150% |
| **Deadlocks** | deadlock counter since the statistics reset | — |
| **Temp files** | volume written to temporary files since the statistics reset | — |

An **XID age / freeze limit** above 100% means an aggressive anti-wraparound autovacuum should already be running for the database. If the value keeps growing, autovacuum is not keeping up — see [Vacuum](server.md#vacuum).

### Replication tab {#inspector-replication}

Sorted by lag by default (largest first). Clicking a row opens the server's **Replication** page (see [Replication](server.md#replication)).

| Column | What it shows | Highlighting |
|---|---|---|
| **Role** | **primary** or **standby** | — |
| **Standbys** | number of connected WAL receivers (rows of `pg_stat_replication`) | — |
| **Max lag** | on a primary, the largest standby lag in bytes (current LSN minus `replay_lsn`); on a standby, the WAL received but not yet replayed, or, if it has cascading standbys of its own, the largest of these values | yellow above 64 MiB, red above 1 GiB |
| **Max time lag** | on a primary, the largest `replay_lag`; on a standby, the time since the last transaction was replayed | — |
| **Inactive slots** | replication slots nobody is connected to | yellow above 0 |

> [!TIP]
> On a standby, **Max time lag** also grows when the primary is simply not running any transactions: there is nothing new to replay. Read it together with the lag in bytes.

### Transaction IDs tab {#inspector-xid}

This tab helps assess the transaction ID wraparound risk. Sorted by the share of the range used by default (largest first). Clicking a row opens the server's **Vacuum** page.

| Column | What it shows | Highlighting |
|---|---|---|
| **XID range used** | (next XID − oldest XID) / 2,147,483,647, with a bar | bar green up to 40%, yellow above 40%, red above 75% |
| **Oldest database (% of freeze_max_age)** | the highest `age(datfrozenxid)` among the server's databases as a percentage of `autovacuum_freeze_max_age` | — |
| **Long-running transactions** | backends whose transaction has been open for more than 5 minutes | yellow above 0 |

Long-running transactions prevent rows from being frozen and the counter from staying within safe limits, which is why they are shown alongside.

### Disk & WAL tab {#inspector-disk}

Sorted by free space by default (least first). With this sort, servers without disk data (**n/a**) come at the very top, before servers with real values. Clicking a row opens the server's **WAL & checkpoints** page (see [WAL](server.md#wal)).

| Column | What it shows | Highlighting |
|---|---|---|
| **Min disk free** | the lowest share of free space among the disks holding tablespaces; **n/a** if pgmetrics did not report disk data | yellow below 20%, red below 10% |
| **WAL files** | number of files in `pg_wal` | — |
| **Ready to archive** | WAL files ready for archiving but not yet archived | yellow above 10 |
| **Archiving** | **failing** if the latest archive attempt failed after the latest successful one, otherwise **ok** | **failing** in red |
| **Load average** | 1-minute load average; **n/a** without system metrics (and when the load is zero) | — |
| **Memory used** | used memory as a percentage of the total (used + free + buffers + cache); **n/a** without system metrics | — |

Disk, load and memory data are available only when pgmetrics collects system metrics: it does so when it runs on the same Linux host as PostgreSQL (connecting through a Unix socket or a local address). When pgmetrics runs from another machine, these columns show **n/a** (see [System](server.md#system)).

## Fleet comparison scenarios {#use-cases}

| Task | Where to look |
|---|---|
| Which servers are close to the connection limit | **Servers** tab, sort by **Backends** (by the share of connections in use) |
| Which servers stopped sending reports | **Servers** tab, sort by **Latest report** ascending (second click on the header) |
| Where reads are cached worst | **Servers** or **Databases** tab, sort by **Cache hit ratio** ascending |
| Where the wraparound risk is highest | **Transaction IDs** tab, then the **Databases** tab sorted by **XID age / freeze limit** |
| Which standbys are lagging | **Replication** tab (already sorted by lag) |
| Where disk space is running out and archiving is broken | **Disk & WAL** tab: **Min disk free**, **Ready to archive**, **Archiving** |
| The largest databases in the fleet and databases that use temp files heavily | **Databases** tab, sort by **Size** or **Temp files** |
| Where there are many rollbacks | **Databases** tab, sort by **Commit ratio** ascending |

Color highlighting in the **Inspector** is a visual hint. To learn about such situations without opening the interface, set up [alert rules](alerts.md) with thresholds that suit your workload.
