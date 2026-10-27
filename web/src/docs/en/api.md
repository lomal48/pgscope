# API

pgscope has three groups of HTTP methods: the public report ingestion API, compatible with the pgdash CLI; the heartbeat method for pgscope-agent; and the internal API the web interface runs on. This page covers request formats, checks, limits and response codes. Requests that pgscope itself sends (notification webhooks) are described separately in [Webhook format](notifications.md#webhook).

## General rules {#conventions}

- **Address.** Paths are relative to the public pgscope address (`PGSCOPE_BASE_URL`), for example `https://pgscope.example.com/api/v1/report`. The pgdash CLI takes the base address including `/api/v1`: `--base-url=https://pgscope.example.com/api/v1`.
- **Format.** Request and response bodies are UTF-8 JSON.
- **Errors.** On error pgscope answers with an HTTP status and the body `{"error": "text"}`. If the `Accept-Language` header starts with `en`, the text is in English, otherwise in Russian. pgscope-agent sends `Accept-Language: en`.
- **Compression.** The body of an ingestion or heartbeat request can be gzip-compressed with the `Content-Encoding: gzip` header. Without that header the body is read as is.
- **HTTPS** is provided by a reverse proxy (see [Reverse proxy and HTTPS](install.md#reverse-proxy)).

## Report ingestion API {#ingest}

The API is compatible with the pgdash CLI `report`, `report-pgbouncer` and `report-pgpool` commands, so existing jobs only need `--base-url`. For sending reports in practice, see [Sending reports](collect.md).

### Methods {#ingest-endpoints}

| Method and path | pgdash CLI command | Accepts | Name fields |
|---|---|---|---|
| `POST /api/v1/report` | `report` | a PostgreSQL server report | `server` |
| `POST /api/v1/reportpgbouncer` | `report-pgbouncer` | a PgBouncer report tied to a PostgreSQL server | `server`, `pgbouncer` |
| `POST /api/v1/reportpgpool` | `report-pgpool` | a Pgpool-II report | `pgpool` |

### Request body {#ingest-body}

| Field | Type | Required for | Description |
|---|---|---|---|
| `apikey` | string | all | the owner's API key from the **Profile** page: exactly 22 Latin letters or digits |
| `server` | string | `report`, `reportpgbouncer` | the PostgreSQL server name in pgscope: `A–Z a–z 0–9 _ . -`, 1 to 64 characters |
| `pgbouncer` | string | `reportpgbouncer` | the PgBouncer instance name, same rules |
| `pgpool` | string | `reportpgpool` | the Pgpool name in pgscope, same rules |
| `data` | object | all | the full output of `pgmetrics -f json` — a JSON object, not a string |

Other top-level fields are ignored. A request skeleton (in a real request `data` is the whole pgmetrics report; only the field pgscope always checks is shown here):

```json
{
  "apikey": "ABCDEFGHIJKLMNOPQRSTUV",
  "server": "prod-db-1",
  "data": { "meta": { "at": 1793008773 } }
}
```

From the report pgscope uses:

- `data.meta.at` — collection start time in Unix seconds. It becomes the report time in pgscope: charts, the choice of the latest report and the cleanup all rely on it. The clocks of collection hosts must therefore be synchronized.
- `data.pgbouncer` — required for `reportpgbouncer` (pgmetrics connected to the `pgbouncer` admin database).
- `data.pgpool` — required for `reportpgpool` (pgmetrics with the `--pgpool` flag).

### Request processing {#ingest-processing}

pgscope checks a request in this order and stops at the first error:

1. gzip decompression (if `Content-Encoding: gzip` is set) and JSON parsing. The body is read as a stream; at most 64 KiB of JSON is allowed before the `data` field.
2. API key format, then a lookup of the key in the storage database. If `apikey` comes before `data` in the body (the pgdash CLI and pgscope-agent send it that way), the key is checked before the report is read: a request with a bad key gets its answer without uploading the report. If `data` comes first, the key is checked after the whole body has been read.
3. The names in `server`, `pgbouncer`, `pgpool`.
4. The `data` field: a pgmetrics report with `meta.at` set and, for PgBouncer and Pgpool, the matching section.
5. Whether the previous report of the same source is still being saved.
6. Whether `PGSCOPE_MIN_REPORT_INTERVAL` seconds (60 by default) have passed since the previous report of the same source was saved.

A source is the combination of account, type (PostgreSQL or Pgpool), server name and PgBouncer name. Reports of a server and of each of its PgBouncers are counted separately. The time of the last report is kept in process memory and resets when pgscope restarts.

pgscope reads and stores the reports of at most 4 requests at once; the others wait for their turn until the client disconnects. The whole request, body included, must arrive within 10 minutes, otherwise pgscope closes the connection.

Then pgscope stores the report:

- The server is looked up by the key owner's account, type and name and is created automatically if it does not exist. For `reportpgbouncer`, the PostgreSQL server named in `server` is found or created the same way, and the report is stored as a report of its PgBouncer.
- The whole report is stored compressed, and time series are extracted from it. For the server's own reports the latest report time and the server list summary are updated. PgBouncer reports do not change the server's latest report time.
- For PostgreSQL reports (not PgBouncer or Pgpool), after saving, alert rules are checked in the background and the report is compared with the previous one for change alerts. The response to the client does not wait for this.

A successful response is status 200 with the body `{}`.

### Responses {#ingest-responses}

| Status | Message | Cause |
|---|---|---|
| 200 | — (body `{}`) | report saved |
| 400 | **Could not decompress the request body (gzip)** | `Content-Encoding: gzip` is set but the body is not gzip |
| 400 | **Invalid request body** | the body is not JSON of the expected shape, is truncated or has more than 64 KiB before the `data` field |
| 413 | **The report is larger than N MiB, the limit set by PGSCOPE_MAX_REPORT_MB on the pgscope server** | the body exceeds `PGSCOPE_MAX_REPORT_MB` (256 MiB by default) as sent or after gzip decompression |
| 401 | **Invalid API key** | the key is not 22 Latin letters or digits |
| 403 | **Unknown API key** | no such key, for example it was regenerated |
| 503 | **Storage is temporarily unavailable** | the storage database did not answer during the key lookup |
| 400 | **Invalid server name** | the name is empty, longer than 64 characters or contains invalid characters |
| 400 | **The data is not a pgmetrics JSON report** | `data` does not parse as a pgmetrics report or has no `meta.at` |
| 400 | **The report has no PgBouncer data**, **The report has no Pgpool data** | the report was not taken from PgBouncer or without the `--pgpool` flag |
| 409 | **The previous report for this server is still being saved** | the same source sent a report while the previous one was being saved |
| 429 | **Reports are being sent too often** | `PGSCOPE_MIN_REPORT_INTERVAL` seconds have not passed yet |
| 500 | **Could not save the report** | write error in the storage database; details in the pgscope log (the `store report …` line) |

The body size is limited by `PGSCOPE_MAX_REPORT_MB` (256 MiB by default, see [Summary table](config.md#reference)): one limit for the body as sent and for the same body after gzip decompression. pgscope answers an oversized body with 413, a JSON body and the text from the table. A 413 without such a body (for example an HTML page) comes from a reverse proxy with a smaller body limit (nginx defaults to 1 MiB).

A request to a wrong path (for example when `--base-url` lacks `/api/v1`) reaches the web interface file handler and gets 404 with the text `404 page not found` instead of JSON.

What to do for each status is described in [Server responses](collect.md#responses) and on the [Troubleshooting and FAQ](troubleshooting.md#http-errors) page.

### Example: sending a report with curl {#curl-example}

Sending a report by hand is handy for checking connectivity and the key: you see the status and the error text.

```bash
# 1. Save a report to a file
pgmetrics -w -f json -h DBHOST -U pgmon -o report.json db1 db2

# 2. Wrap the report in a request body, compress and send it
KEY=ABCDEFGHIJKLMNOPQRSTUV   # API key from the Profile page
{ printf '{"apikey":"%s","server":"%s","data":' "$KEY" prod-db-1; cat report.json; printf '}'; } \
  | gzip -c \
  | curl -sS -X POST https://pgscope.example.com/api/v1/report \
      -H 'Content-Type: application/json' -H 'Content-Encoding: gzip' \
      --data-binary @- -w '\nHTTP %{http_code}\n'
```

On success curl prints `{}` and `HTTP 200`. To get error texts in English, add `-H 'Accept-Language: en'`. For PgBouncer, send a report taken from the `pgbouncer` database to `/api/v1/reportpgbouncer` and add the `"pgbouncer":"pgb-1"` field to the body; for Pgpool, send to `/api/v1/reportpgpool` with a `"pgpool"` field instead of `"server"`.

## Agent heartbeat {#agent-heartbeat}

`POST /api/v1/agent` is the method pgscope-agent uses once a minute to report on itself and on the state of its targets. The **Agents** page is built from this data (see [The Agents page](docker.md#agents-page)). The agent sends the reports themselves through the regular ingestion API.

```json
{
  "apikey": "ABCDEFGHIJKLMNOPQRSTUV",
  "agent": {
    "id": "prod-swarm/x7k2m9q4w1e8r5t3y6u0i2o4p",
    "cluster": "prod-swarm",
    "host": "node-1",
    "mode": "swarm",
    "version": "dev",
    "docker_version": "28.3.3",
    "autoconnect": false,
    "interval": 300
  },
  "targets": [
    {
      "name": "prod-swarm.billing_db",
      "kind": "postgres",
      "container": "billing_db.1.k2x9q8w7e6r5t4y3u2i1o0p9a",
      "container_id": "3f2a9c1b7d4e",
      "image": "postgres:17",
      "network": "billing_backend",
      "address": "10.0.5.12:5432",
      "status": "ok",
      "error": "",
      "last_ok": 1793008773,
      "last_attempt": 1793008773
    }
  ]
}
```

| Field | Description |
|---|---|
| `apikey` | the owner's API key, as in the ingestion API |
| `agent.id` | agent identifier `<cluster>/<host or node id>`: `A–Z a–z 0–9 _ . : / -`, 1 to 128 characters |
| `agent.cluster`, `agent.host` | the cluster (the `PGSCOPE_AGENT_CLUSTER` value or the Docker host name) and the host name |
| `agent.mode` | `standalone` (a single host) or `swarm` |
| `agent.version`, `agent.docker_version` | agent and Docker versions |
| `agent.autoconnect` | whether the agent joins database networks on its own |
| `agent.interval` | collection interval, seconds |
| `targets[]` | discovered containers: server name in pgscope, type (`postgres` or `pgbouncer`), container, image, network, address, status, error text, time of the last successful collection and of the last attempt (Unix seconds) |
| `targets[].status` | `ok` (**Working**), `pending` (**Waiting for first collection**), `unreachable` (**Unreachable**), `auth_failed` (**Authentication failed**), `error` (**Error**) |

How pgscope handles a heartbeat:

- The body is limited to 4 MiB on the wire and after decompression, and can be gzip-compressed.
- The agent record is keyed by "key owner's account + `agent.id`" and is fully replaced by every heartbeat. Heartbeats do not create servers.
- An agent is considered lost (**Agent not responding**) if there has been no heartbeat for 3 minutes by the storage database clock.
- Heartbeats are not rate-limited.

| Status | Message | Cause |
|---|---|---|
| 200 | — (body `{}`) | heartbeat accepted |
| 400 | **Could not decompress the request body (gzip)**, **Invalid request body** | the body is not gzip, not JSON of the expected shape or larger than 4 MiB (for heartbeats an oversized body gets 400, not 413) |
| 401, 403, 503 | as in the ingestion API | the key has the wrong format, is unknown, or the storage database is unavailable |
| 400 | **Invalid agent ID** | `agent.id` is empty, longer than 128 characters or contains invalid characters |
| 500 | **Internal server error** | write error in the storage database |

## Internal interface API {#internal-api}

> [!WARNING]
> This is the internal API of the web interface. It is not documented as stable and may change between versions without notice. You can use it for one-off tasks and scripts, but expect to re-check such scripts after upgrading pgscope.

### Authentication and general rules {#internal-auth}

- Sign in: `POST /api/login` with the body `{"email": "…", "password": "…"}`. pgscope sets the `pgscope_session` cookie (see [Sessions and the cookie](security.md#sessions)) and returns `{"ok": true}`. Wrong credentials get 401 **Incorrect email address or password**. The answer for an unknown email takes as long as for a wrong password, so it does not reveal whether such an account exists.
- All other requests send that cookie.
- Requests with any HTTP method other than GET must have the `Content-Type: application/json` header, otherwise the answer is 415 **The request body must be JSON**. This applies to all methods that require sign-in and to the methods without sign-in `POST /api/signup`, `/api/login`, `/api/logout` and `/api/invite/{token}`. This is the CSRF protection; for methods with sign-in the header is checked before the session. The report ingestion API and the agent heartbeat do not check this header.
- Without a valid session the answer is 401 **Not signed in**.
- A body that does not parse as JSON of the expected shape gets 400 **Invalid request**. An unexpected storage database error gets 500 **Internal server error**, with details in the pgscope log.
- For server methods, `{id}` is the numeric id, the same as in the page address `#/s/{id}`. If the server is neither owned by nor shared with the user, the answer is 404 **Server not found**. If the action is owner-only and a team member makes the request, the answer is 403 **Only the server owner can do this**.
- The request body is limited to 1 MiB.

### Methods {#internal-routes}

Without signing in:

| Method and path | Purpose |
|---|---|
| `GET /api/signup` | whether sign-up is open right now: `{"open": true}` or `{"open": false}`. Depends on `PGSCOPE_SIGNUP` and, in the `first` mode, on whether the database has any account |
| `POST /api/signup` | sign up `{"email","password"}`; creates an owner account with an API key and starts a session right away. If sign-up is closed, the answer is 403 **Sign-up of new accounts is disabled. Ask an administrator to invite you.** (this check comes before the email and password checks) |
| `POST /api/login` | sign in |
| `POST /api/logout` | sign out: deletes the session from the cookie |
| `GET /api/invite/{token}` | invitation details: email and server name |
| `POST /api/invite/{token}` | accept an invitation `{"password"}`: creates a team member account, grants access and starts a session. Works with any `PGSCOPE_SIGNUP` value. The invitation is used up only when the account is created: after an error it stays valid. If the email already has an account, the answer is 409 **An account with this email address already exists. Sign in to it and ask the server owner to share the server with that account.** |

The password for sign-up, accepting an invitation and changing the password must have at least 8 characters and take at most 72 bytes in UTF-8, otherwise the answer is 400 **The password must be at least 8 characters and at most 72 bytes (a Cyrillic character takes 2 bytes)**. A password of Cyrillic letters only can be at most 36 letters long.

Account:

| Method and path | Purpose |
|---|---|
| `GET /api/me` | the current user: id, email, API key, team member flag, `PGSCOPE_BASE_URL`, whether AI chat and SMTP are enabled, language, the time zone `tz` (`null` = the browser's zone) and `min_report_interval`, the `PGSCOPE_MIN_REPORT_INTERVAL` value in seconds |
| `POST /api/me/apikey` | issue a new API key (403 for team members) |
| `POST /api/me/password` | change the password `{"Old","New"}`. All other sessions of the user are ended; the current one stays |
| `PUT /api/me/lang` | save the language `{"lang": "ru"}` or `{"lang": "en"}` |
| `PUT /api/me/tz` | save the UI time zone `{"tz": "Europe/Moscow"}` (an IANA zone name); `{"tz": ""}` goes back to the browser's zone. An unknown name gets 400 **Unknown time zone** |
| `DELETE /api/me` | delete the account; for an owner, together with all their servers |
| `GET /api/servers` | the user's servers and those shared with them: summary, triggered alerts, PgBouncer names. In the summary `repl_lag_bytes` is `null` when the server has replication but no lag is known, and `0` when there is no replication |
| `GET /api/agents` | the account's agents with their targets |
| `DELETE /api/agents?id=…` | delete an agent record |

Server:

| Method and path | Purpose | Available to |
|---|---|---|
| `GET /api/servers/{id}/report` | the full pgmetrics report: the latest one, or the latest at or before `?at=` (Unix seconds); `?source=` is a PgBouncer name. The report time is in the `X-Report-At` header. If the client accepts gzip, the report is sent compressed | owner and members |
| `GET /api/servers/{id}/reports` | report times starting from `?from=` (Unix seconds), at most 2000, newest first; `?source=` is a PgBouncer name | owner and members |
| `GET /api/servers/{id}/series` | an object's time series: `?obj=` is the object key (see [Storage database tables](data.md#tables)), `?fields=` comma-separated fields, `?from=` and `?to=` Unix seconds (the last day by default) | owner and members |
| `GET /api/servers/{id}/baseline` | the value of field `?field=` for all objects with prefix `?prefix=` (for example `tbl:`) from the first report at or after `?at=` | owner and members |
| `GET /api/servers/{id}/diagnostics` | diagnostics and configuration check for the latest report or the report at `?at=` | owner and members |
| `GET /api/servers/{id}/alerts` | metric catalog, rules, triggered alerts, change alert settings, channels, the latest 200 events | owner and members |
| `POST /api/servers/{id}/alerts/rules` | add a rule | owner and members |
| `DELETE /api/servers/{id}/alerts/rules/{rid}` | delete a rule | owner and members |
| `PUT /api/servers/{id}/changes` | change alert settings `{"kinds": […], "size_pct": 20}` | owner and members |
| `POST /api/servers/{id}/notifiers` | add a channel `{"scope","kind","target","lang"}` | owner and members |
| `DELETE /api/servers/{id}/notifiers/{nid}` | delete a channel | owner and members |
| `POST /api/servers/{id}/notifiers/{nid}/test` | send a test notification; 502 if delivery fails. An email the SMTP server has not accepted within 30 seconds counts as not delivered | owner and members |
| `GET /api/servers/{id}/shares` | owner, members and (for the owner only) invitations with links | owner and members |
| `POST /api/servers/{id}/shares` | invite `{"email"}`. Inviting the same address again does not create a second invitation; it refreshes the first one and returns the same link | owner only |
| `DELETE /api/servers/{id}/shares/{uid}` | revoke a member's access | owner only |
| `DELETE /api/servers/{id}/invites/{token}` | cancel an invitation | owner only |
| `DELETE /api/servers/{id}` | delete the server with all its data | owner only |
| `POST /api/servers/{id}/chat` | ask the AI chat `{"messages": [{"role": "user", "content": "…"}]}`; 501 if the chat is not configured | owner and members |

The query series `q:…` in `GET /api/servers/{id}/series` are summed over all users who ran the query (`max_time` is the maximum). The lag and WAL retention series (`repl:…`, `slot:…`, the server's `lsn` and `standby_lag_bytes` fields) have no point when pgmetrics did not get the WAL position (LSN) involved.

An alert rule body is an object with the fields `metric` (a metric id from the `GET /api/servers/{id}/alerts` catalog), `op` (`gt` or `lt`), `threshold` (the threshold in the metric's base units: bytes, seconds, milliseconds for query times, percent or a count), `param` (transaction age in seconds, only for the `backends_long_xact` metric), `severity` (`warn` or `crit`), `match` (`all`, `contains`, `notcontains`, `startswith`, `endswith`, `exact`), `match_text` and `db_name`. An unknown metric or an invalid `op`, `severity` or `match` value gets 400 **Invalid rule**. Adding or deleting a rule re-checks the rules against the latest report right away: if the set of triggered alerts changed, notifications go out immediately.

A notification channel body has `scope` (`alerts` for alerts, `changes` for change alerts), `kind` (`email`, `slack`, `pagerduty`, `victorops`, `xmatters`, `webhook`), `target` (for `email`, comma-separated addresses; for `pagerduty`, an Events API v2 integration key; for the others, a URL with the `http` or `https` scheme) and `lang` (`ru` or `en`, the language of notification texts; if omitted, the request language is used). Errors: 400 **Invalid notification channel** (unknown `kind` or `scope`, empty `target`), **The address must be an http or https URL**, **Unsupported language**. In change alert settings `size_pct` must be greater than 0, and unknown values in `kinds` are dropped.

### Example {#internal-example}

```bash
BASE=https://pgscope.example.com

# sign in: the session cookie is saved to the jar file (treat it like a password)
read -rs PW
printf '{"email":"%s","password":"%s"}' dba@example.com "$PW" \
  | curl -sS -c jar -H 'Content-Type: application/json' --data-binary @- "$BASE/api/login"

# server list
curl -sS -b jar "$BASE/api/servers"

# latest full report of the server with id 42
curl -sS -b jar --compressed "$BASE/api/servers/42/report" -o prod-db-1.json
```

If the password contains quotes or backslashes, escape them according to JSON rules. If the cookie was issued with the `Secure` flag, curl sends it back only over HTTPS.

## Outgoing notifications {#outgoing}

pgscope itself sends POST requests to **Webhook** notification channels (and to Slack, PagerDuty, VictorOps and xMatters in their formats). The body format, headers, timeouts and retries are described in [Webhook format](notifications.md#webhook), and the contents of change notifications on the [Change alerts](change-alerts.md) page.
