# Common scenarios

Step-by-step recipes for common tasks: connect a server, investigate a slow query, deal with bloat, replication lag, wraparound risk and running out of connections, clean up indexes safely, set up on-call alerts in an air-gapped network, connect many Docker databases and give a colleague access. Each interface page is covered in detail in its own section of the documentation; links are given along the way.

## Monitor a new server in 10 minutes {#new-server}

You need a running pgscope, an owner account and a collection host that can reach both PostgreSQL and pgscope. The best collection host is the database host itself: only then does pgmetrics collect system metrics and read the PostgreSQL log. If the databases run in Docker, use the agent instead (see [Add many Docker databases](#docker-fleet)).

1. **Monitoring role.** On the primary, as a superuser:

```sql
CREATE ROLE pgmon LOGIN;
GRANT pg_monitor TO pgmon;
\password pgmon
```

Allow the role to connect from the collection host in `pg_hba.conf`. Preparation in detail, including `pg_stat_statements` and `auto_explain`, is described in [Preparing PostgreSQL](postgres.md). `pg_stat_statements` requires a PostgreSQL restart; without it only the **Queries** page is empty (and **Query** level rules never fire), everything else works right away.

2. **Tools and password.** Put the pgmetrics and pgdash CLI binaries on the collection host (in an air-gapped network, copy the files) and save the role password:

```bash
echo 'DBHOST:5432:*:pgmon:PASSWORD' >> ~/.pgpass
chmod 600 ~/.pgpass
```

3. **First report.** A ready-made command with your key and address is in **Profile** → **Sending reports**; its `db1 db2` are placeholders for database names and can be replaced with the `--all-dbs` flag. Run the command by hand:

```bash
pgmetrics -w -f json -h DBHOST -U pgmon --all-dbs \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report prod-db-1
```

The server name (`prod-db-1`) may use Latin letters, digits and `_ . -`, up to 64 characters; the host name is a convenient choice.

4. **Check.** Open **Servers**: the server is there, and its **Overview** and **Diagnostics** are already filled in. Charts need at least two reports. If the server does not appear, see [Reports do not arrive](troubleshooting.md#no-data).

5. **Schedule.** Add a cron job every 5 minutes. Cron has a short `PATH`, so use full paths:

```text
*/5 * * * * /usr/local/bin/pgmetrics -w -f json -h DBHOST -U pgmon --all-dbs | /usr/local/bin/pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report prod-db-1
```

Do not send reports for one server more often than `PGSCOPE_MIN_REPORT_INTERVAL` (60 seconds by default): extra ones get a 429 response.

6. **Basic alerts.** **Alerts** → **Rules** → **New rule**. A good starter set:

| Level | Metric | Condition | Severity |
|---|---|---|---|
| Server | **Number of backends waiting for locks** | greater than 10 | Warning |
| Server | **Number of backends with transactions open longer than**, **Transaction age (minutes)** 30 | greater than 0 | Warning |
| Server | **Number of inactive replication slots** | greater than 0 | Critical |
| Server | **Number of WAL files ready for archiving** | greater than 10 | Warning |
| Database | **Backends as a percentage of max_connections** | greater than 80 % | Warning |
| Database | **XID age as a percentage of autovacuum_freeze_max_age** | greater than 150 % | Warning |
| Tablespace | **Free disk space** | less than 15 % | Critical |
| Query | **Mean query execution time** | greater than 10 seconds | Warning |

**Free disk space** works only if pgmetrics runs on the database host under Linux and connects locally. Then add a channel on the **Notifications** tab (see [On-call alerts in an air-gapped network](#on-call)). More about rules: [Alert rules](alerts.md).

## Investigate a slow query {#slow-query}

1. **When it started.** On **Overview**, pick a chart range (**1h** … **30d**) and find the moment when transactions, the number of backends or the cache hit ratio changed.
2. **If the problem was in the past**, pick a report from that time in the report list in the top bar (**Latest report** is selected there by default): **Queries**, **Backends**, **Locks** and **Diagnostics** then show the state at that moment. The list holds at most the 500 most recent reports from the last 30 days.
3. **Which queries are the heaviest.** On **Queries**, sort by **Total time**: the bar shows each query's share of the total time. The most expensive queries are not necessarily the slowest: a frequent fast query can take more time than a rare slow one.
4. **Query page.** Click a query to open it. The **Suggestions** block has automatic hints: low cache hit ratio, temp files, too many rows per call, high time variance. On the charts, compare mean time and the number of calls per interval: did the query get slower, or is it called more often?
5. **Plan.** The **Execution plans** section shows `auto_explain` plans with warnings under the nodes (row estimate mismatch, Seq Scan discarding rows, sort spilling to disk). If there are no plans, see [No execution plans](troubleshooting.md#no-plans).
6. **Surroundings.** Check **Locks** → **Blocking chains** (the query may be waiting, not working) and **Backends** with the **Waiting only** checkbox. **System** shows whether the server is short of CPU or memory (if pgmetrics runs on the database host and connects locally).
7. **Fix and verify.** Typical fixes are an index, fresh statistics (`ANALYZE`), a rewritten query or a larger `work_mem` for a specific session. On a production database, create indexes without blocking writes:

```sql
CREATE INDEX CONCURRENTLY orders_customer_id_idx ON public.orders (customer_id);
```

After the change, watch the mean time chart on the query page: it is computed over intervals between reports, so the effect shows after one or two reports.

More on these pages: [Queries](activity.md#queries), [Locks](activity.md#locks).

## Find and fix bloat {#bloat}

1. **What is bloated.** **Diagnostics** → **Health issues**: **Bloated tables** (bloat over 30 % for tables over 10 MiB), **Many dead rows** (over 10,000 and over 20 % of rows), **Bloated indexes**. The full list is on **Tables**, sorted by the **Bloat** column. Bloat is a pgmetrics estimate; with `--omit=bloat` there is none, and the card shows **not estimated**.
2. **Is vacuum keeping up.** On the table page, the **Vacuum & analyze** block shows when `VACUUM` and autovacuum last ran. **Vacuum** has **Tables with the most dead rows** and **In progress**.
3. **What blocks vacuum.** Dead rows cannot be removed while any transaction can still see them:
   - long-running transactions and sessions idle in transaction — **Backends**, and **Long-running transactions** and **Idle in transaction** in diagnostics;
   - replication slots with an old `xmin` — **Replication** → **Replication slots**, the `xmin` column;
   - queries on standbys with `hot_standby_feedback = on`.
4. **Remove the cause** and tune autovacuum for the problem table:

```sql
ALTER TABLE public.orders SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 1000);
VACUUM (VERBOSE, ANALYZE) public.orders;
```

5. **Get disk space back.** Plain `VACUUM` frees space for reuse but does not shrink the file. `VACUUM FULL` rewrites the table and locks it entirely — only in a maintenance window. The `pg_repack` extension, if installed, does the same without a long lock. Rebuild bloated indexes on **Index management** → **Bloated**: select the indexes and run the generated `REINDEX INDEX CONCURRENTLY`.
6. **An alert for the future**: level **Table**, metric **Table bloat as a percentage of size**, greater than 30 %, **Warning**. Conditions of different rules are not combined: a separate **Table size (bytes)** rule fires on its own and does not restrict the first one. To avoid noise from small tables, use the **Table bloat (bytes)** metric with an absolute threshold instead of the percentage (for example greater than 1 GiB), or restrict the rule by table name and database.

## React to replication lag {#replication-lag}

1. **Alerts.**
   - On the primary: level **Server**, metric **Replication replay lag on primary (bytes)**, greater than 1 GiB. The alert fires separately for each standby.
   - On the standby itself, if it also sends reports as a separate server: **Replay lag on standby (bytes)**. The **(time)** variant is measured from the time of the last replayed transaction, so on a mostly idle primary it grows even without real lag.
2. **Diagnostics** reports **Standbys are lagging** (over 1 GiB or 60 seconds), **Standby is not keeping up with WAL replay** and **WAL replay is paused**.
3. **Where the delay is.** On the primary's **Replication** page, compare the write, flush and replay lag:
   - the write lag is already large — WAL is not reaching the standby: network or WAL sending;
   - write is fine but flush lags — slow disk on the standby;
   - only replay lags — the standby cannot apply WAL fast enough: load on its disk and CPU, conflicts with queries on the standby, or paused replay.
4. **On the standby**, check whether replay is paused and the WAL receiver state. To resume replay:

```sql
SELECT pg_wal_replay_resume();
```

5. **The whole fleet at once** — **Inspector** → **Replication**: number of standbys, maximum lag and inactive slots for every server.
6. **Inactive slots.** The slot of a disconnected standby retains WAL, and the primary's disk fills up. If the standby is no longer needed, drop the slot and cap WAL retention with `max_slot_wal_keep_size`:

```sql
SELECT pg_drop_replication_slot('old_standby_slot');
```

More: [Replication](server.md#replication), [Inspector](fleet.md#inspector).

## Prevent transaction ID wraparound {#wraparound}

Diagnostics rates the XID age of each database against the limit of 2,147,483,647 transactions: over 75 % — **Transaction ID wraparound risk** (critical), over 40 % — **High XID age**. When the age exceeds `autovacuum_freeze_max_age` but has not yet reached 40 % of the limit, **Anti-wraparound autovacuum is due** appears — this is normal operation, but worth watching.

1. **Alerts.** Level **Database**, metric **XID age as a percentage of autovacuum_freeze_max_age**: greater than 150 % — **Warning**, greater than 500 % — **Critical**. With the default `autovacuum_freeze_max_age` (200 million) that is 300 million and 1 billion transactions.
2. **Where the old XIDs are.** **Vacuum** → **XID age by database** and **Oldest tables (frozen XID age)**; **In progress** shows whether these tables are already being vacuumed.
3. **What blocks freezing.** Long-running transactions and sessions idle in transaction (**Backends**), replication slots with an old `xmin` or `catalog_xmin` (**Replication** → **Replication slots**), queries on standbys with `hot_standby_feedback = on`, and forgotten prepared transactions:

```sql
SELECT gid, prepared, owner, database FROM pg_prepared_xacts ORDER BY prepared;
```

4. **Freeze the oldest tables** in the affected database:

```sql
VACUUM (FREEZE, VERBOSE) public.big_table;
```

5. **Tune autovacuum** so it does not happen again: `autovacuum_max_workers`, `autovacuum_vacuum_cost_limit`, `maintenance_work_mem`. Do not turn autovacuum off — **Diagnostics** → **Configuration check** flags that as critical.

## Running out of connections {#connections}

Diagnostics reports **Connections are close to max_connections** when more than 80 % of connections are in use (over 95 % is critical).

1. **Alerts.** Level **Database**, metric **Backends as a percentage of max_connections**, greater than 80 % (if a database has its own connection limit, the percentage is computed against it). For the whole server, **Total number of backends** with a threshold as a count, for example 80 % of `max_connections`.
2. **Who holds the connections.** On **Backends**, filter by database, user, application and state. Sessions idle in transaction are highlighted in yellow, sessions waiting for locks in red.
3. **Typical causes:** an application connection pool that is too large (pool size × number of instances), leaked transactions, a queue of queries behind a lock (see **Locks**).
4. **Immediate action.** Terminate stuck sessions:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND state_change < now() - interval '30 minutes';
```

5. **Long-term measures:** `idle_in_transaction_session_timeout` and `idle_session_timeout` (PostgreSQL 14+), a connection pooler (PgBouncer in transaction mode) and monitoring it in pgscope (see [PgBouncer](integrations.md#pgbouncer)). Raising `max_connections` requires a restart and costs memory per connection.

## Clean up indexes safely {#index-cleanup}

1. **Candidates.** **Index management** → **Unused**. In the **Not scanned** field, pick a period: **since stats reset** or **in the last 30 days** / **in the last 90 days**. The scan count is compared with the first report of the period, so you need that much history (see [Retention](data.md#retention)). With less history, the comparison uses the earliest stored time series; their date is shown next to the field (**compared with the report from …**). Unique indexes are not listed.
2. **Check each candidate:**
   - usage statistics are per server: if some queries go to standbys, check the same index on the standby's page in pgscope;
   - for rare jobs (monthly reports, period closing) use the 90-day period;
   - the **Last used** column (PostgreSQL 16+) shows the time of the last scan.
3. **Save the definitions** of the indexes you drop, so you can bring them back quickly if needed:

```sql
SELECT indexrelid::regclass AS index_name, pg_get_indexdef(indexrelid) AS definition
FROM pg_index
WHERE indexrelid = 'public.orders_created_at_idx'::regclass;
```

4. **Dropping.** Tick the indexes — SQL with `DROP INDEX CONCURRENTLY` appears below, grouped by database (with a `\c database` line for psql). Run it in psql outside a transaction (`CONCURRENTLY` does not work inside one), one index at a time, at a quiet time, and watch query times afterwards.
5. **Duplicates.** On the **Duplicates** tab, pgscope groups indexes with the same definition, keeps the first index of each group and proposes dropping the rest. The `UNIQUE` attribute is ignored in this comparison. Before dropping, make sure you are not dropping a unique index that enforces uniqueness of the data.
6. **Bloated indexes** — the **Bloated** tab, SQL `REINDEX INDEX CONCURRENTLY`. The rebuild needs free space roughly the size of the index.
7. **Rollback** — `CREATE INDEX CONCURRENTLY` from the saved definition.

More: [Index management](objects.md#index-management).

## On-call alerts in an air-gapped network {#on-call}

Slack, PagerDuty, VictorOps and xMatters are cloud services and need internet access (the PagerDuty address is fixed in pgscope: `https://events.pagerduty.com/v2/enqueue`). In an air-gapped network, use email through an internal SMTP server or a webhook to an internal address.

1. **SMTP.** Set `PGSCOPE_SMTP_ADDR` (for example `mail.example.local:25`) and `PGSCOPE_SMTP_FROM` to an address your mail server accepts, then restart pgscope (see [Email (SMTP)](config.md#smtp)).
2. **Channels.** On each server: **Alerts** → **Notifications** → **Channel** **Email** (several addresses separated by commas) or **Webhook** with the address of an internal receiver, then **Add** and **Test**. Webhook format: [Webhook format](notifications.md#webhook).
3. **Rules.** Start with the starter set from [Monitor a new server in 10 minutes](#new-server).
4. **Change alerts** are configured separately, with their own channels (see [Change alerts](change-alerts.md)).
5. **How delivery works** — keep this in mind when choosing a receiver:
   - a notification is sent only when the set of triggered alerts changes: a new alert fires or a previous one clears. While the set stays the same there are no repeats, and a change in the value of an already triggered alert does not cause a notification. Adding or deleting a rule re-checks the latest report right away and can also send a notification;
   - when everything is back to normal, a notification says that all alerts have cleared;
   - if delivery fails, the notification is not retried later. HTTP channels (webhook, Slack, PagerDuty, VictorOps, xMatters) retry the request up to three times with a 5-second pause only if the receiver did not answer within 3 seconds; a non-2xx answer is not retried. Errors are written to the pgscope log as `notify …` lines.
6. **Watching for incoming reports.** pgscope checks rules only when a report arrives, so if collection stops, no alerts fire. Check report freshness with an external job against the storage database. A read-only role:

```sql
CREATE ROLE pgscope_check LOGIN PASSWORD 'secret';
GRANT SELECT ON servers TO pgscope_check;
```

Servers with no reports for more than 15 minutes:

```sql
SELECT name, last_report
FROM servers
WHERE last_report IS NULL OR last_report < now() - interval '15 minutes'
ORDER BY last_report NULLS FIRST;
```

An example cron job that sends an email with the system `mail` command:

```bash
#!/bin/sh
# run every 10 minutes; the role password is in ~/.pgpass
out=$(psql "postgres://pgscope_check@dbhost/pgscope" -XAt -c \
  "SELECT name FROM servers WHERE last_report < now() - interval '15 minutes'")
[ -n "$out" ] && printf 'No fresh reports:\n%s\n' "$out" | mail -s 'pgscope: stale servers' oncall@example.com
```

The report time is set by the collection host, so its clock must be synchronized. PgBouncer reports do not update the server's latest report time.

7. **Watching pgscope itself.** If pgscope is down, it sends nothing. Check its availability with external monitoring, for example `curl -fsS -o /dev/null https://pgscope.example.com/`.

## Add many Docker databases {#docker-fleet}

For databases in containers, pgscope-agent replaces per-database cron jobs: one agent per Docker host, or a global service in Swarm. The detailed guide is on the [Docker and Docker Swarm](docker.md) page.

1. **Images.** Build `pgscope-agent` on a machine with internet access and bring it into the network (`docker save` / `docker load` on every host and Swarm node, or an internal registry).
2. **Secrets.** Prepare the API key from **Profile** and the password of the `pgscope_monitor` role.
3. **Monitoring role.** On every Docker host and Swarm node with databases, run `deploy/agent/bootstrap-monitor-role.sh --with-pg-stat-statements`.
4. **Labels.** Add the `pgscope.enable=true` label to database containers; in Swarm, under the service's `labels:`, not `deploy.labels`. The server name in pgscope is built automatically or set with the `pgscope.name` label (see [Container labels](docker.md#labels)).
5. **Start.** On single hosts, use `deploy/agent/docker-compose.yml`; if different hosts have Compose projects with the same names, give each host its own `PGSCOPE_AGENT_CLUSTER`. In Swarm, use the `deploy/agent/docker-stack.yml` stack with the mandatory `PGSCOPE_AGENT_CLUSTER` and the databases' overlay networks declared in the stack.
6. **Check.** On the **Agents** page every target should be **Working**. First collections are spread over the interval (5 minutes by default), so at first targets show **Waiting for first collection**. For any other status, see [Troubleshooting](docker.md#troubleshooting).
7. **Storage size.** Dozens of databases produce many time series: estimate the size in advance (see [Storage size](data.md#sizing)).
8. **Alert rules** are set per server; there are no rule templates. For many servers you can add rules with a script through the internal API (it may change between versions, see [Internal interface API](api.md#internal-api)). The example adds a "free disk space less than 15 %" rule to every server whose name starts with `prod-swarm.`; it needs curl, jq and a session cookie in the `jar` file, obtained as shown in [Example](api.md#internal-example):

```bash
BASE=https://pgscope.example.com
for id in $(curl -sS -b jar "$BASE/api/servers" \
    | jq -r '.[] | select(.kind == "postgres" and (.name | startswith("prod-swarm."))) | .id'); do
  curl -sS -b jar -X POST "$BASE/api/servers/$id/alerts/rules" -H 'Content-Type: application/json' \
    -d '{"metric":"ts_disk_free_pct","op":"lt","threshold":15,"param":0,"severity":"crit","match":"all","match_text":"","db_name":""}'
  echo
done
```

Running it again creates duplicate rules: pgscope does not merge them. Every added rule is checked against the server's latest report right away, so notifications through already configured channels may arrive immediately. Metric ids and threshold units are in the catalog returned by `GET /api/servers/{id}/alerts`.

Keep in mind that the agent's pgmetrics runs in the agent container and connects to the database by the container IP. pgmetrics treats a connection as local only if the client and server addresses match (or the connection goes through the Unix socket), so system metrics and the PostgreSQL log are usually not collected for such databases.

## Give a colleague access {#share-access}

Access is granted to a specific server, and only its owner can grant it.

1. Open the server → **Team & settings** → the **Team sharing** card.
2. Enter the address in **Invite by email** and click **Invite**.
   - If the colleague already has an account in this pgscope, access appears right away (with SMTP configured, both they and you get an email).
   - Otherwise an invitation is created. The link is emailed if SMTP is configured, and a copy is shown in the list next to the address (copy button) so you can pass it on yourself. Following the link, the colleague sets a password and gets a team member account. The link is built from `PGSCOPE_BASE_URL`, so that must be set correctly.
3. What a member can do: view all data of the server, use diagnostics and the AI chat, change alert rules, notification channels and change alert settings. What they cannot do: invite others, revoke access, delete the server, have an API key or send reports. There is no read-only mode: a member can, for example, add a notification channel with their own address.
4. Access is granted to one server. For several servers, invite on each one; if the colleague already has an account, access to further servers appears right away.
5. **Revoke access** — the trash icon next to the member (**Revoke access**) or next to the invitation (**Cancel invitation**). The member's account remains, but without shared servers it sees nothing; the member can delete it (**Profile** → **Delete account**), or an administrator can in the storage database.

More: [Team, profile and account](teams.md#server-settings).
