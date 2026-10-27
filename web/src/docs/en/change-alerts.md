# Change alerts

Change alerts report what changed on a server between two consecutive reports: a restart, a version upgrade, a replaced cluster (a new system identifier), a standby promotion, users, databases, tables, indexes, extensions and slots that were added or removed, changed configuration settings, disabled triggers, and sudden changes in sizes and row counts. This page describes which changes are tracked and by what rules, how to enable them, how they are delivered and where to see them.

## How it works {#how-it-works}

When a new pgmetrics report arrives for a PostgreSQL server, pgscope compares it with the server's previous stored report and looks for changes of the selected kinds. If at least one change is found:

- an entry with all changes of this report is added to the **Detected changes** list;
- one notification with all the changes is sent to every channel in the **Notifications** card of this page.

Things to know:

- Nothing is tracked by default: you have to select the change kinds and save.
- A server's first report has nothing to compare with, so it yields no changes.
- The comparison is with the previous stored report, however old: if collection stopped for a day, the new report is compared with a day-old one.
- PgBouncer and Pgpool reports are not compared.
- A change that happened and was reverted between two reports is not noticed (except a restart, which shows in the server start time).
- Unlike [alert rules](alerts.md), there is no "triggered / cleared" state: every notification reports a one-off event.

## Setup {#setup}

1. Open the server and choose **Alerting** → **Change alerts** in the sidebar.
2. In the **Tracked changes** card, tick the change kinds you need. The button in the card's corner is a toggle: while not all kinds are ticked it reads **Select all** and ticks all of them; when all are ticked it reads **Clear all** and clears them.
3. In **Sudden change threshold (%)**, set the threshold for sudden changes in sizes and row counts (20 by default). The value must be greater than zero, otherwise saving fails with "Invalid request".
4. Click **Save** — the mark **Saved** appears. Ticked boxes have no effect until saved.
5. Add channels in the **Notifications** card below (see [Notification channels](notifications.md)). These channels are separate from the regular alert channels.

The settings take effect from the next report; reports already stored are not compared again.

To turn change alerts off, untick all boxes (if all kinds are ticked, with **Clear all**) and click **Save**. The channels can stay: with no tracked kinds, no notifications are sent.

Both the server owner and team members can configure change alerts, see [Owner and member permissions](teams.md#permissions).

## Change kinds {#change-types}

| Checkbox | ID | What the notification says | **Before** → **After** |
|---|---|---|---|
| **Server restart** | `restart` | "Server restarted" — the server (postmaster) start time changed | start time in RFC 3339, UTC |
| **PostgreSQL version change** | `version` | "PostgreSQL version changed" (by the `server_version` setting) | old and new version |
| **System identifier change (restore or new cluster)** | `sysid` | "System identifier changed" | old and new identifier |
| **Recovery mode change (promotion or demotion)** | `recovery` | "Recovery mode changed" | "primary" or "standby" |
| **Users / roles added, removed or changed** | `roles` | "User added", "User removed", "User “name” changed" | the role name; for a change — "attributes: …; member of: …" |
| **Databases added or removed** | `databases` | "Database added", "Database removed" | the database name |
| **Tables added or removed** | `tables` | "Table added", "Table removed" | `database.schema.table` |
| **Indexes added or removed** | `indexes` | "Index added", "Index removed" | `database.schema.index` |
| **Sudden change in table size** | `table_size` | "Size of table “database.schema.table” changed" | sizes by `pg_table_size` (table with TOAST, without indexes), for example `1.2 GiB` → `1.9 GiB` |
| **Sudden change in table row count** | `table_rows` | "Row count of table “database.schema.table” changed" | row counts |
| **Sudden change in database size** | `db_size` | "Size of database “name” changed" | sizes |
| **Sudden change in tablespace size** | `tablespace_size` | "Size of tablespace “name” changed" | sizes |
| **Extensions added, removed or updated** | `extensions` | "Extension added", "Extension removed", "Version of extension “database.extension” changed" | `database.extension`; for an update — the versions |
| **Configuration settings changed** | `settings` | "Setting “name” changed" | values from `pg_settings` |
| **Replication slots added or removed** | `slots` | "Replication slot added", "Replication slot removed" | the slot name |
| **Triggers disabled** | `triggers` | "Trigger disabled" | `database.schema.table.trigger` |

When there was no value (the object was added), **Before** is empty; when the object was removed, **After** is empty. In the email and other text notifications an empty value is shown as "—", in the table on the page the cell stays blank, and in the JSON the field is absent. Changes in a notification are sorted by their Russian source text, so the order is the same in both languages. The "ID" column is the change kind identifier in the [API](api.md) (the `kinds` field).

Details by kind:

- **Users / roles.** Roles are compared by name. "User changed" means that the attributes `superuser`, `createrole`, `createdb`, `login`, `replication`, `bypassrls` or the membership in other roles changed. Password changes, `CONNECTION LIMIT`, `VALID UNTIL` and other properties are not tracked. Renaming a role looks like a removal plus an addition. All roles in `pg_roles` are compared, including roles without login and the built-in `pg_*` roles, so after an upgrade to a new PostgreSQL major version you get "User added" for the new built-in roles.
- **Databases, tables, indexes, slots.** Compared by name (tables and indexes by `database.schema.name`). A rename looks like the old object being removed and a new one added.
- **Extensions.** The key is `database.extension`; an upgrade (`ALTER EXTENSION … UPDATE`) is reported as a version change.
- **Configuration settings.** The values from `pg_settings` as seen by the pgmetrics session are compared, in `pg_settings` units (for example, `work_mem` = `4096` means 4096 kB). Only a change of the effective value is reported: a setting that needs a restart shows up after the restart. Settings that appear or disappear between reports are not reported. A PostgreSQL version upgrade also changes the `server_version` and `server_version_num` settings.
- **Triggers.** Only disabling a trigger is reported; re-enabling is not.
- **System identifier** (`system_identifier` from `pg_control_system()`) is created by `initdb` and changes only when a different cluster now reports under the same name: a new `initdb`, moving the data with a logical dump (`pg_dump` / `pg_restore`) into a new cluster, or collection from another, unrelated cluster. Physical copies (`pg_basebackup`, a restore from a file-level backup) and standbys keep the identifier of the source cluster, so a restore from a physical backup and a switch to a standby are not detected by this kind — for a switchover watch **Recovery mode change (promotion or demotion)** and **Server restart**.

> [!WARNING]
> Tables, indexes and extensions are compared only across the databases pgmetrics collects. If you change the list of databases in the pgmetrics command or enable flags that exclude tables, the next report produces a flood of "Table added" / "Table removed" notifications.

## Sudden changes in sizes and row counts {#abrupt}

For the kinds `table_size`, `table_rows`, `db_size` and `tablespace_size` a change counts as sudden when all of the following hold:

1. both values are known (sizes pgmetrics could not read, for example because of a lock timeout, are ignored);
2. the larger of the two values is at least the noise floor: 1 MiB for sizes, 1000 rows for row counts;
3. the difference is larger than the given percentage of the **previous** value: `|after − before| > threshold % × before` (when the previous value is 0, any change above the noise floor counts as sudden).

The percentage is one for all four kinds and is set in **Sudden change threshold (%)**. Examples with a 20% threshold:

| Before | After | Result |
|---|---|---|
| 500 MiB | 650 MiB | sudden: +150 MiB is more than 100 MiB (20% of 500) |
| 500 MiB | 580 MiB | not sudden: +80 MiB is less than 100 MiB |
| 10 GiB | 7 GiB | sudden: −3 GiB (for example after `VACUUM FULL` or deleting data) |
| 100 KiB | 900 KiB | ignored: both values are below 1 MiB |
| 0 rows | 5000 rows | sudden: the table was filled |
| 800 rows | 950 rows | ignored: both values are below 1000 rows |

The row count is `n_live_tup` from `pg_stat_user_tables`: an approximate estimate from PostgreSQL's cumulative statistics, not a `count(*)` result. It changes as inserts and deletes commit and is refined by `VACUUM` and `ANALYZE`, so it can differ from the exact row count.

> [!NOTE]
> Only consecutive reports are compared. Slow growth, say 5% per collection interval, never triggers a notification, even if a table doubles in a day. To watch absolute sizes, use [alert rules](alerts.md#metrics-table) (**Table size**, **Database size**, **Free disk space**).

## Notifications {#notifications}

For each report with changes, one notification is sent to every channel in the **Notifications** card of this page. The card subtitle: "Sent when changes are detected between consecutive reports".

- Subject: "[pgscope] prod-db-1: changes detected (2)" — the number of changes in parentheses.
- Text: one line per change, like "Setting “work_mem” changed: 4096 → 16384"; if there are no values, only the description of the change.
- A webhook receives JSON with the fields `server`, `prevreport`, `currreport` and the `changes` array, see [Webhook format](notifications.md#webhook-changes).
- PagerDuty gets an event with severity `info` and no dedup key (every notification is a separate incident), VictorOps gets an `INFO` message, xMatters gets `severity` = `info`.

An example email:

```text
Subject: [pgscope] prod-db-1: changes detected (3)

User added: — → report_reader
Setting “log_min_duration_statement” changed: 1000 → 250
User “app” changed: attributes: login; member of: — → attributes: login,superuser; member of: —
```

The text language is set per channel, see [Notification language](notifications.md#language).

## Detected changes {#history}

Below the notifications card, the page shows the list **Detected changes (N)**, newest first. Each card is one report with changes: the title is the time of the new report, the subtitle reads "compared with the report from …", followed by a table with the columns **Change**, **Before** and **After**. Until something changes, the page shows **No changes detected yet**.

Entries are recorded even if no notification channels are configured. The page shows up to the server's last 200 events (together with the regular alert history). Entries are kept for `PGSCOPE_METRICS_RETENTION_DAYS` days (90 by default), see [Data storage](data.md#retention).

## Examples {#examples}

**Auditing schema and privilege changes.** Tick **Users / roles added, removed or changed**, **Tables added or removed**, **Indexes added or removed**, **Extensions added, removed or updated** and **Configuration settings changed**, save, and add an Email channel to the DBA group address. Any change that bypassed your release process becomes visible within one collection interval.

**Restarts, failovers and restores.** Tick **Server restart**, **PostgreSQL version change**, **System identifier change (restore or new cluster)** and **Recovery mode change (promotion or demotion)**, and add a webhook into your internal on-call system. A standby promotion arrives as "Recovery mode changed: standby → primary".

**Mass data deletion.** Tick **Sudden change in table row count** and **Sudden change in table size** with a 30% threshold. A table left, by the `n_live_tup` estimate, with less than 70% of the rows of the previous report ends up in a notification (if it had at least 1000 rows in one of the two reports).

**Forgotten replication slots.** Tick **Replication slots added or removed** to learn about every new slot, and add the alert rule **Number of inactive replication slots** greater than 0, see [Alert rules](alerts.md#starter-set).

## Limitations {#limitations}

- Only consecutive reports are compared; gradual changes are invisible.
- The noise floor (1 MiB and 1000 rows) is fixed, and one sudden-change percentage applies to all kinds.
- There are no object filters: if ETL jobs keep creating and dropping tables, the **Tables added or removed** kind will be noisy — untick it.
- Password changes and role properties other than the listed attributes and membership are not tracked, and neither is re-enabling a trigger.
- If reports stop arriving, there are no change notifications either: pgscope does not report that collection itself has stopped.
