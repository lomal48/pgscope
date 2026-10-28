# Troubleshooting and FAQ

This page collects common problems grouped by symptom: what to check and how to fix it. Answers to frequent questions are at the end. pgscope-agent problems are covered separately on the [Docker and Docker Swarm](docker.md#troubleshooting) page.

## Where to start {#first-steps}

**The pgscope log.** pgscope writes its log to standard error (stderr):

```bash
journalctl -u pgscope -f                      # systemd service
cd deploy && docker compose logs -f pgscope   # Docker Compose
```

At startup the log shows a `pgscope listening on ADDRESS (public URL ADDRESS)` line — a quick way to check `PGSCOPE_LISTEN` and `PGSCOPE_BASE_URL`. Other messages:

| Log message | Meaning |
|---|---|
| `schema setup: …`, then the process exits | no connection to the storage database or no permission to create tables (see [pgscope does not start](#startup)) |
| `store report …` | a report was not saved; the client got 500 |
| `API key lookup: …` | the storage database did not answer during the key lookup; the client got 503 |
| `notify <type> <destination>: …` | a notification was not delivered |
| `smtp: …` | the SMTP server is unreachable, did not answer within 30 seconds or rejected the message |
| `team emails are not sent: SMTP is not configured (PGSCOPE_SMTP_ADDR); pass invitation links on yourself` | SMTP is not configured, so server access emails and invitations are not sent; written once per process run |
| `team email "…" to … not sent: …` | a server access email or an invitation was not delivered |
| `webhook: …` | a webhook or notification service address is unreachable |
| `ai chat: …`, `ai request: …` | AI chat error |
| `retention: …` | error while cleaning up old data |

**The sending side.** Look at the pgdash CLI output in cron (cron mail or output redirected to a file). To see the exact status and error text, send a report by hand with curl (see [Example: sending a report with curl](api.md#curl-example)).

## Reports do not arrive, the server does not appear {#no-data}

Check in this order:

1. **pgmetrics works.** Run the collection command on its own and make sure the output is JSON:

```bash
pgmetrics -w -f json -h DBHOST -U pgmon --all-dbs > /tmp/report.json; echo "exit $?"; head -c 200 /tmp/report.json
```

Without `-f json` pgmetrics prints a text report, and such a report is not accepted (sent with curl, pgscope answers 400). The `-w` flag keeps pgmetrics from waiting for a password prompt in cron.

2. **Address.** The pgdash CLI needs `--base-url` with the `/api/v1` suffix, for example `--base-url=https://pgscope.example.com/api/v1`. Without the suffix the request goes to a wrong path and gets 404 (see [404](#http-404)). Without `--base-url` the pgdash CLI sends the report to the pgDash cloud, and in an air-gapped network it just gets a network error.
3. **Reachability.** From the collection host, `curl -sS -o /dev/null -w '%{http_code}\n' https://pgscope.example.com/` must return 200. If the certificate is issued by an internal CA, the collection host must trust it.
4. **Key.** The key comes from the **Profile** page of this same pgscope and has not been regenerated since. Team members have no key.
5. **Whose server.** The server appears for the key owner. If you are signed in with another account, you will not see it until the owner shares it.
6. **Response status** — see [HTTP errors when sending](#http-errors).

If the server is in the list but its pages show **No report received yet**, most often only PgBouncer reports have arrived under that name. As a rule, this is a typo in the server name in the `report-pgbouncer` command: such a report creates a separate empty server. Fix the name and delete the extra server (see [Deleting data](data.md#deleting)). Another possible cause is a storage database restored from a backup without the `reports` table data (see [Backup](data.md#backup)); the pages then fill in with the next report.

## HTTP errors when sending {#http-errors}

The full response table is in [Responses](api.md#ingest-responses) and in [Server responses](collect.md#responses).

### 400 {#http-400}

| Message | What to do |
|---|---|
| **Invalid request body** | the body is not JSON, is truncated or has more than 64 KiB before the `data` field. Check that pgmetrics finished successfully and printed the whole JSON. A report that is too large gets 413, not 400 (see [413](#http-413)) |
| **Could not decompress the request body (gzip)** | the client set `Content-Encoding: gzip` but the body is not compressed. Remove the header or compress the body |
| **Invalid server name** | server, PgBouncer and Pgpool names may only use `A–Z a–z 0–9 _ . -`, 1 to 64 characters. Spaces, non-Latin letters and `:` are not allowed |
| **The data is not a pgmetrics JSON report** | `data` is not a pgmetrics report: run without `-f json`, a different tool, or a report without a collection time |
| **The report has no PgBouncer data** | `report-pgbouncer` sent a report that was not taken from the `pgbouncer` admin database. Point pgmetrics at the PgBouncer port and the `pgbouncer` database |
| **The report has no Pgpool data** | for `report-pgpool`, pgmetrics must run with the `--pgpool` flag |

### 401 and 403 {#http-401-403}

- **401 Invalid API key** — the key is not 22 Latin letters or digits. Usually the key was cut off when copying, or has an extra space or quote.
- **403 Unknown API key** — this pgscope has no such key: it was regenerated (**Regenerate**), the account was deleted, or the key comes from another installation. Copy the current key from the **Profile** page and update all cron jobs and agent secrets.

### 404 {#http-404}

A 404 response with the text `404 page not found` (not JSON) means the request went to a wrong path and reached the web interface file handler. Usually `--base-url` lacks the `/api/v1` suffix or has a typo. The correct paths are `/api/v1/report`, `/api/v1/reportpgbouncer` and `/api/v1/reportpgpool` (see [Report ingestion API](api.md#ingest)). A 404 with a different text (for example an HTML page) comes from the reverse proxy: check that it forwards `/api/` paths to pgscope unchanged.

### 409 {#http-409}

**The previous report for this server is still being saved**: a new report of the same source arrived while the previous one was being saved. This happens with very large reports, a slow storage database, or when two collectors send reports under the same name. No need to retry: the next report arrives on schedule. If the error persists, look for duplicate cron jobs or agents and check the load on the storage database.

### 413 {#http-413}

A 413 answer comes in two cases:

- **413 The report is larger than N MiB, the limit set by PGSCOPE_MAX_REPORT_MB on the pgscope server** (JSON) — the report exceeds the pgscope limit as sent or after gzip decompression (256 MiB by default). Shrink the report with pgmetrics flags (`--omit=bloat`, `-S`, schema and table filters) or raise `PGSCOPE_MAX_REPORT_MB`, keeping the memory of the pgscope host in mind (see [Rate and size limits](collect.md#limits)).
- **413 without JSON** (for example an HTML page) — a reverse proxy response: the report body exceeds its limit. nginx defaults to 1 MiB. Raise the limit for `/api/v1/` to at least `PGSCOPE_MAX_REPORT_MB`:

```nginx
location /api/v1/ {
    client_max_body_size 256m;
    proxy_pass http://127.0.0.1:8080;
}
```

A complete configuration example is in [Reverse proxy and HTTPS](install.md#reverse-proxy).

### 429 {#http-429}

**Reports are being sent too often**: less than `PGSCOPE_MIN_REPORT_INTERVAL` seconds (60 by default) have passed since the previous report of the same source was saved. Common causes:

- cron runs every minute. The interval counts from the moment the previous report was saved, and collection and saving take a few seconds, so the next run arrives before the limit. Send every 5 minutes;
- two collectors send the same server: two cron jobs, cron plus an agent, or two agents producing the same server names. Every server needs its own name;
- the agent interval (`PGSCOPE_AGENT_INTERVAL`) is shorter than `PGSCOPE_MIN_REPORT_INTERVAL`.

A rejected report is not saved. The counter resets when pgscope restarts.

### 500 and 503 {#http-5xx}

- **500 Could not save the report** — a write error in the storage database. The cause is in the pgscope log on the `store report …` line: disk full, missing permissions, an overloaded database.
- **503 Storage is temporarily unavailable** — the storage database did not answer during the key lookup. Check that it is running and reachable from the pgscope host.

The pgdash CLI retries on 5xx responses and network errors (the number of retries is set by `--retries`); the agent retries once after 5 seconds.

### 502 and 504 {#http-502-504}

These responses come from the reverse proxy, not from pgscope:

- **502** — pgscope is not running or listens on a different address and port than `proxy_pass`. Check `PGSCOPE_LISTEN` and the `pgscope listening on …` line in the log.
- **504** — pgscope did not answer within the proxy timeout. Saving a large report or an AI chat answer can take more than a minute; raise `proxy_read_timeout` (for example to `300s`).

pgscope has its own limits too: request headers must arrive within 10 seconds and the whole request with its body within 10 minutes, a response takes at most 35 minutes, and an idle connection is closed after 2 minutes. These values are not configurable.

## A server is marked stale {#stale-server}

If the latest report is more than 15 minutes old, the **Report** value on the card on the **Servers** page and the dot with the report time in the server top bar turn yellow. pgscope itself does not alert on this (see [On-call alerts in an air-gapped network](scenarios.md#on-call)).

What to check:

- whether the cron job or the agent is running: cron mail, the agent log, the **Agents** page;
- whether pgscope answers with an error (see [HTTP errors when sending](#http-errors)). 403 and 429 errors in cron are easy to miss;
- whether collection has become too slow: on large databases pgmetrics can run longer than the interval. Collect less with flags (`--omit=bloat`, `-S`) or increase the interval;
- whether the clocks are synchronized. The report time is set by the collection host, while the browser computes the report "age" from its own clock. If the collection host clock is behind, the report looks stale;
- PgBouncer reports do not update the server's latest report time: a server that only receives PgBouncer reports always looks stale.

## The Queries page is empty {#empty-queries}

The page shows **No query statistics**, and diagnostics reports the **No query statistics** issue. Causes:

- `pg_stat_statements` is not in `shared_preload_libraries`. After adding it, PostgreSQL must be restarted; reloading the configuration is not enough;
- `CREATE EXTENSION pg_stat_statements` has not been run in the databases pgmetrics collects;
- pgmetrics runs with `--omit=statements`.

If the page lists queries but some show `<insufficient privilege>` instead of the text, the monitoring role lacks `pg_monitor` (or `pg_read_all_stats`): without it PostgreSQL hides the query texts of other users.

Check as the monitoring role:

```sql
SELECT count(*) FROM pg_stat_statements;
SELECT query FROM pg_stat_statements LIMIT 1;
```

By default pgmetrics collects the 100 queries with the highest total time; `--statements-limit=N` collects more. See [Preparing PostgreSQL](postgres.md).

## No execution plans {#no-plans}

The **Execution plans** section of a query page shows **No execution plans captured**. Plans come from the PostgreSQL log, where `auto_explain` writes them, so all of the following is needed:

- `auto_explain` is loaded (`shared_preload_libraries` or `session_preload_libraries`);
- `auto_explain.log_format = json` — other formats are not parsed into a tree;
- the query ran longer than `auto_explain.log_min_duration`;
- pgmetrics reads the log: it connects to the database locally on its host and runs as an OS user allowed to read the log files (see [the next section](#no-logs)); for RDS and Aurora the log is read through the AWS API with `--aws-rds-dbid`;
- the plan was logged within the last `--log-span` minutes (5 by default). Make `--log-span` equal to the collection interval.

Plans are shown for the selected report and matched to the query by its identifier or by its text with literals removed. If a plan is in the log but not shown, open the report taken right after the query ran: with **›** or the **Go to a moment** dialog in the top bar (see [Viewing a past report](ui.md#report-picker)).

## No logs, system metrics or autovacuum history {#no-logs}

The **Logs** page shows **No log entries**, and **System**, tablespace disk usage and **Autovacuum history (from logs)** are empty. pgmetrics collects all of this only over a local connection: on the database host through the Unix socket, with the same client and server address, or over loopback addresses `127.0.0.0/8`. Local collection shows as the **pgmetrics … (local)** mark in the **Collected by** row of the **Cluster** card on the **Overview** page. In addition:

- pgmetrics collects system metrics and disk usage only on Linux;
- the log files must be readable by the OS user pgmetrics runs as. If pgmetrics does not find the log on its own, specify `--log-file` or `--log-dir`; these flags do not help over a remote connection. For RDS and Aurora the log is read through the AWS API with `--aws-rds-dbid`;
- the log is `csvlog` on PostgreSQL 13+ and pgmetrics is an official release (no `+pgscope` in the **Collected by** row): it silently skips such files. Install [pgmetrics built by pgscope](collect.md#pgmetrics-build) or switch the log to `stderr`;
- the log has entries, but they do not reach the report, or their times are off by the zone offset: pgmetrics is an official release and `log_timezone` does not match the time zone of its host. Install [pgmetrics built by pgscope](collect.md#pgmetrics-build), which reads times in the `log_timezone` zone, or set `log_timezone` to the pgmetrics host's zone or to `'UTC'`, see [PostgreSQL log](postgres.md#logs).

Autovacuum history also needs `log_autovacuum_min_duration` (for example `1000`). PostgreSQL logs deadlocks by default on its own (the `deadlock detected` error), while `log_lock_waits = on` adds long lock waits to the log.

The Docker agent runs pgmetrics in its own container and connects to the database by the container IP. Such a connection is not local, so for containerized databases this data is usually not collected.

## Empty charts and gaps {#empty-charts}

- **Not enough data in this range yet.** Most charts show a rate or ratio over the interval between neighboring reports, so the selected range needs at least two reports. Right after connecting a server, wait for the second report or pick a longer range.
- **Gaps.** A report did not arrive; counters were reset (PostgreSQL restart, `pg_stat_reset()`) — that interval is skipped rather than drawn negative; pgmetrics could not read a size because of a lock (`--lock-timeout`) — the point is skipped rather than drawn as zero; pgmetrics did not get a WAL position (LSN), for example for `pg_basebackup` or a standby without a WAL receiver — the standby lag, slot WAL retention or WAL generation point is skipped.
- **The chart shows a past time.** A past moment is selected in the top bar (a colored line runs along its top edge): charts are built around the selected report, which is marked with a dashed line. Press **Latest**.
- **No recent points although reports arrive.** The collection host clock runs fast: the report time is set by the collection host, while charts are drawn up to the browser's current time. Synchronize clocks (NTP).
- **No old data.** Time series older than `PGSCOPE_METRICS_RETENTION_DAYS` days are deleted unless the value is `0` (see [Retention](data.md#retention)).
- **Load and memory charts are empty.** pgmetrics does not connect to the database locally or does not run on Linux (see [No logs, system metrics or autovacuum history](#no-logs)).

## Alerts are not delivered {#alerts-not-delivered}

1. **Has the alert fired?** Open **Alerts** → **Triggered**. Rules are checked on every incoming report and right after a rule is added or deleted. No reports means no checks.
2. **Has the set changed?** A notification is sent only when the set of triggered alerts changes: a new alert fires or a previous one clears. While the set stays the same there are no repeats; a change in the value of a triggered alert does not cause a notification. The **History** tab shows when the set changed.
3. **Is the channel in the right place?** Channels for regular alerts are added on the **Notifications** tab of the **Alerts** page; channels for change alerts are added on the **Change alerts** page. These are separate lists.
4. **Does the channel work?** Click **Test** next to the channel. An error is shown in the interface, for example **Could not send the notification: SMTP is not configured (set PGSCOPE_SMTP_ADDR)** or **Could not send the notification: … returned HTTP status 404**.
5. **Errors of real notifications** are visible only in the pgscope log (`notify …`, `smtp: …`, `webhook: …` lines). Such a notification is not retried later.
6. **A webhook and the other HTTP channels** (Slack, PagerDuty, VictorOps, xMatters) must answer with a 2xx status within 3 seconds. If there is no answer, pgscope retries up to three times with a 5-second pause; an answer with any other status is not retried (see [Webhook format](notifications.md#webhook)).
7. **Is internet access needed?** Slack, PagerDuty, VictorOps and xMatters are cloud services. The PagerDuty address is fixed (`https://events.pagerduty.com/v2/enqueue`). In an air-gapped network use email or a webhook to an internal address. If outgoing traffic goes through an HTTP proxy, set `HTTPS_PROXY` and `NO_PROXY` for pgscope: notification requests honor them.
8. **Report type.** Rules are checked only for PostgreSQL reports. There are no alerts for PgBouncer and Pgpool.
9. **Change alerts.** On the **Change alerts** page, the **Tracked changes** card must have the needed kinds of changes ticked and **Save** clicked. Every report is compared with the server's previous report, so after connecting a server the first comparison happens only with the second report. A notification goes out only if changes are found.

## Emails are not sent {#email}

- If `PGSCOPE_SMTP_ADDR` is not set, choosing the **Email** channel shows the warning **SMTP is not configured on this pgscope server (PGSCOPE_SMTP_ADDR), so emails will not be delivered.**
- Test the channel with **Test**. **Could not send the notification: The SMTP server did not accept the message** means the SMTP server is unreachable, did not answer within 30 seconds or rejected the message; the exact cause is in the pgscope log on the `smtp: …` line.
- **Could not send the notification: No recipient address given** means the channel's address list has no address at all, for example only commas. Delete the channel and add it again with addresses. pgscope drops spaces, empty list entries and repeated addresses on its own.

Common causes:

| Cause | What to do |
|---|---|
| port 465 (TLS from the first byte) | not supported: use 587 with STARTTLS or 25 |
| `PGSCOPE_SMTP_USER` is set but the server does not support STARTTLS | pgscope does not send the password over an unencrypted connection (except to a server on `localhost`). Enable STARTTLS or use a relay without authentication that allows the pgscope host by IP |
| `PGSCOPE_SMTP_USER` is set but the server does not offer AUTH, including an old server that answers only HELO (the log shows `smtp: server doesn't support AUTH`) | if the server accepts mail without authentication, unset `PGSCOPE_SMTP_USER`; otherwise enable AUTH on it |
| the SMTP server certificate is issued by an internal CA | add the CA to the system store of the pgscope host or point `SSL_CERT_FILE` at it |
| the sender `pgscope@localhost` (the default) is rejected | set `PGSCOPE_SMTP_FROM` to a real address in your domain |
| wrong `host:port` | the port is required, for example `mail.example.local:25` |

Invitation emails are sent in the background, and the interface does not report a sending error: an SMTP server refusal shows up only in the log (the `team email "…" to … not sent: …` and `smtp: …` lines). If SMTP is not configured, the invitation form shows **SMTP is not configured: copy the invitation link from the list and send it yourself.**, and the log gets `team emails are not sent: SMTP is not configured …` once. In both cases the invitation link can be copied on the **Team & settings** page. See [Email (SMTP)](config.md#smtp).

## Invitation problems {#invites}

- **Invitation not found or already used.** The invitation has already been accepted, was cancelled by the owner, the server was deleted, or the link was copied incompletely. Ask the owner to invite again.
- **The link points to `localhost` or a wrong address.** Links are built from `PGSCOPE_BASE_URL`. Set the correct address and restart pgscope; the link in the list on the **Team & settings** page is updated, while emails already sent keep the old address — replace it by hand, the token stays valid.
- **On accepting — An account with this email address already exists. Sign in to it and ask the server owner to share the server with that account.** (HTTP 409). The colleague already has an account with this email (for example, they signed up on their own). The invitation is not used up. The colleague signs in to their account, and the owner invites the same address again: for an existing account access is granted right away, and the no longer needed invitation is deleted.
- **The password must be at least 8 characters and at most 72 bytes (a Cyrillic character takes 2 bytes).** The invitation remains valid: choose another password. A password of Cyrillic letters only can be at most 36 letters long.
- **Two invitations for one address.** This does not happen: inviting again refreshes the previous invitation and sends the same link.
- **The email did not arrive.** See [Emails are not sent](#email); the link can be passed on by hand.

## Cannot sign in {#login}

- **Incorrect email address or password.** There is no password reset by email; an administrator can set a temporary password in the storage database (see [Resetting a forgotten password](security.md#password-reset)).
- **Sign-up of new accounts is disabled. Ask an administrator to invite you.** Sign-up is closed by the `PGSCOPE_SIGNUP` setting: by default (`first`) you can sign up only while the database has no account, and with `closed` never. The sign-in page then has no **Sign up** link. New users are added by invitation (see [Give a colleague access](scenarios.md#share-access)); if self-registration is needed, set `PGSCOPE_SIGNUP=open` and restart pgscope.
- **Sign-in succeeds, but the sign-in page shows again right away.** The browser did not store the cookie. Usually the cookie was issued with the `Secure` flag (`PGSCOPE_BASE_URL` starts with `https://` or the proxy sends `X-Forwarded-Proto: https`) while pgscope is opened over `http://`. Use the HTTPS address (see [Reverse proxy and HTTPS](install.md#reverse-proxy)). Also check that the browser does not block cookies for the site.
- **Had to sign in again.** A session lasts 30 days from sign-in and is not extended. After the pgscope address changes, users must sign in again. A password change ends all other sessions of the account: in other browsers and on other devices you sign in again with the new password.
- **A script gets 415.** Interface API requests with any method other than GET need the `Content-Type: application/json` header, including `/api/login`, `/api/logout`, `/api/signup` and `/api/invite/…` (see [Internal interface API](api.md#internal-api)).

## AI chat errors {#ai-chat}

| Message | Cause and fix |
|---|---|
| **AI chat is not configured. Set PGSCOPE_AI_KEY (an Anthropic API key) and restart pgscope.** | no key is set. In an air-gapped network this is the normal state: the chat sends data to the Anthropic cloud |
| **The AI provider returned HTTP 401** (or 403) | the key is wrong or revoked |
| **The AI provider returned HTTP 404** | usually an unknown model: check `PGSCOPE_AI_MODEL` and, if `PGSCOPE_AI_BASE_URL` is set, that address too |
| **The AI provider returned HTTP 429** (or 5xx) | rate limits exceeded or a provider-side failure; try again later |
| **Could not reach the AI provider** | no network access to the Anthropic API or to the address in `PGSCOPE_AI_BASE_URL` |
| **The AI model declined to answer this question** | rephrase the question |
| **No reports yet** | the server has no reports yet |
| **Invalid request** in a long conversation | a conversation is limited to 50 messages and the request body to 1 MiB. Start a **New conversation** |
| 504 from the reverse proxy | the answer takes longer than the proxy timeout: raise `proxy_read_timeout` |

If an answer ends with **(response truncated)**, it hit the length limit (16,000 tokens): ask a narrower question. See [AI chat](config.md#ai).

## Docker agent {#docker-agent}

Target statuses, networks, authentication errors and Docker network issues are covered on the [Docker and Docker Swarm](docker.md#troubleshooting) page. In short:

- the agent is missing from the **Agents** page — check its log (`docker compose logs agent` or `docker service logs pgscope-agent_agent`). An `ERROR: pgscope rejected the API key (HTTP 403 …)` line means the key in the secret is wrong;
- `pgscope answered HTTP 429` — the agent interval is shorter than `PGSCOPE_MIN_REPORT_INTERVAL`, or someone else sends the same server;
- the agent exits right away with `configuration: …` — `PGSCOPE_URL` is not set, the secrets are missing or the key format is wrong;
- on a Swarm node the agent requires `PGSCOPE_AGENT_CLUSTER`.

## pgscope does not start {#startup}

- **`schema setup: …`** — pgscope could not connect to the storage database or create its tables. Check `PGSCOPE_DB` (host, port, database name, role, password, `pg_hba.conf`). If the cause is `permission denied for schema public`, the role cannot create tables: in PostgreSQL 15 and later the `public` schema forbids this by default to everyone except the database owner. Make the pgscope role the database owner:

```sql
ALTER DATABASE pgscope OWNER TO pgscope;
```

- **`listen tcp …: bind: address already in use`** — the port is taken: free it or change `PGSCOPE_LISTEN`.
- **`PGSCOPE_SIGNUP=…: use first, open or closed`** — an invalid `PGSCOPE_SIGNUP` value.
- **`PGSCOPE_METRICS_RETENTION_DAYS=-1: set a number of days to keep the data, or 0 to keep it forever`** (or the same for `PGSCOPE_REPORT_RETENTION_DAYS`) — a negative retention period. Set a number of days, or `0` to keep the data forever.
- **`PGSCOPE_MAX_REPORT_MB must be at least 1`** — the report size limit is below 1 MiB.
- **Docker Compose:** pgscope waits until the database in the `db` service passes its readiness check. If `.env` lacks `PGSCOPE_DB_PASSWORD`, Compose refuses to start and says so.

## FAQ {#faq}

**Does pgscope need internet access?** Not to run. Collecting and receiving reports, storage, the interface, diagnostics and notifications by email and webhook all work in an air-gapped network. Internet is needed only for the AI chat and the Slack, PagerDuty, VictorOps and xMatters channels (see [Data leaving your network](security.md#egress)), and for building the images, which is done on a separate machine.

**Does pgscope connect to the databases itself?** No. The pgdash CLI and pgscope-agent send reports; pgscope only receives them. It only needs incoming HTTP(S) from the collectors.

**Can sign-up be disabled?** Yes, with the `PGSCOPE_SIGNUP` variable. By default (`first`) you can sign up only while the database has no account: the first user becomes the owner, and the others are added by invitation. `closed` turns sign-up off completely, `open` opens it to anyone who can reach the interface. An invitation can be accepted with any value. If your installation already has accounts and relied on open sign-up, set `PGSCOPE_SIGNUP=open` after upgrading (see [Open sign-up](security.md#signup)).

**How do I reset a forgotten password?** Through the storage database (see [Resetting a forgotten password](security.md#password-reset)).

**Why does a team member have no API key?** Reports are sent on behalf of the server owner. A member views the servers shared with them and does not create servers.

**Why did a notification arrive only once although the problem persists?** Notifications are sent only when the set of triggered alerts changes (see [Alerts are not delivered](#alerts-not-delivered)).

**Are there alerts for PgBouncer and Pgpool?** No, rules are checked only for PostgreSQL reports.

**Where is the AI chat conversation stored?** Only in the browser tab, until it is closed. The storage database does not keep it.

**Why does an old report not open?** Full reports are kept for `PGSCOPE_REPORT_RETENTION_DAYS` days (14 by default). Any report within that period can be opened with **‹** and **›**, the **Go to a moment** dialog or a chart click; for an earlier moment the page shows **No report at this moment** (see [Viewing a past report](ui.md#report-picker) and [What depends on what](data.md#dependencies)).

**How do I rename a server?** The name is the server's identifier. Reports under a new name create a new server, and the old one stays with its history and latest report until it is deleted. History cannot be moved to the new name in the interface.

**Can several pgscope instances share one database?** pgscope is not designed for this, and such a setup has not been tested: report rate limiting and the protection against concurrent saves live in process memory, and every instance would run the old-data cleanup. Use a single instance.

**How often should reports be sent?** Usually every 5 minutes (the agent's default). Not more often than once per `PGSCOPE_MIN_REPORT_INTERVAL`, and more frequent reports fill the storage database faster (see [Storage size](data.md#sizing)).

**How long is history kept?** By default 90 days of time series and 14 days of full reports (see [Retention](data.md#retention)). A value of `0` in `PGSCOPE_METRICS_RETENTION_DAYS` or `PGSCOPE_REPORT_RETENTION_DAYS` turns the cleanup off: the data is kept forever.
