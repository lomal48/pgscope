# Configuring pgscope

A reference of every pgscope server setting: the storage database connection, addresses, sign-up, the report rate and size limits, retention, email (SMTP) and AI chat, plus the environment variables of third-party components that affect pgscope. The settings of the Docker agent are described separately in [Docker and Docker Swarm](docker.md).

## How settings are applied {#how-to-set}

- pgscope is configured **with environment variables only**. There are no command-line arguments and no configuration file.
- The variables are read once at startup. Restart pgscope to apply changes.
- An empty value is the same as an unset variable: the default applies, and SMTP and AI chat stay disabled.
- Numeric variables accept integers only. A value that cannot be parsed (for example `5m` or `30d`) is silently replaced with the default. An invalid value — a negative retention period, `PGSCOPE_MAX_REPORT_MB` below 1 or an unknown `PGSCOPE_SIGNUP` mode — stops pgscope at startup with a message in the log.
- Where to set them: in the systemd `EnvironmentFile` (see [Running as a systemd service](install.md#systemd)), in `deploy/.env` for Docker Compose (see [Docker Compose variables](#compose-vars)) or with `docker run -e`.

At startup pgscope logs a line `pgscope listening on ADDRESS (public URL BASE-URL)`, which is handy for checking `PGSCOPE_LISTEN` and `PGSCOPE_BASE_URL`. Whether SMTP and AI chat are enabled is visible in the UI: if not, the notifications form, the invitation form and the AI chat show warnings.

## Summary table {#reference}

| Variable | Default | Purpose |
|---|---|---|
| `PGSCOPE_DB` | `postgres://localhost/pgscope` | connection string of the storage database |
| `PGSCOPE_LISTEN` | `:8080` | HTTP server address and port |
| `PGSCOPE_BASE_URL` | `http://localhost:8080` | public address of pgscope: links in notifications and invitations, commands in the UI, the cookie Secure flag |
| `PGSCOPE_SIGNUP` | `first` | who can sign up on their own: `first` — only the first user, `open` — anyone, `closed` — nobody (invitations only) |
| `PGSCOPE_MIN_REPORT_INTERVAL` | `60` | minimum interval between reports of one server, seconds; `0` means no limit |
| `PGSCOPE_MAX_REPORT_MB` | `256` | the largest report accepted, in MiB, both compressed and decompressed |
| `PGSCOPE_METRICS_RETENTION_DAYS` | `90` | how many days to keep time series and the history of alerts and changes; `0` keeps them forever |
| `PGSCOPE_REPORT_RETENTION_DAYS` | `14` | how many days to keep full reports; the latest report is always kept; `0` keeps them forever |
| `PGSCOPE_SMTP_ADDR` | — | SMTP server `host:port`; empty disables email |
| `PGSCOPE_SMTP_USER` | — | SMTP login; empty means no authentication |
| `PGSCOPE_SMTP_PASS` | — | SMTP password |
| `PGSCOPE_SMTP_FROM` | `pgscope@localhost` | sender address |
| `PGSCOPE_AI_KEY` | — | Anthropic API key; empty disables AI chat |
| `PGSCOPE_AI_MODEL` | `claude-opus-5-5` | model used by AI chat |
| `PGSCOPE_AI_BASE_URL` | — | a different Anthropic API address (proxy or gateway) |

## Connection and addresses {#core}

### PGSCOPE_DB {#pgscope-db}

The connection string of the PostgreSQL database where pgscope keeps all its data. Preparing the database and the required privileges are described in [Storage database](install.md#storage-db).

- **Format** — the libpq one: a URL `postgres://user:password@host:port/database?param=value` or a `host=… port=… dbname=… user=…` string.
- **The default** `postgres://localhost/pgscope` means port 5432, database `pgscope`, and a user name equal to the OS user pgscope runs as.
- **Password.** Special characters in a URL must be percent-encoded (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `%` → `%25`). It is simpler to pass the password in `PGPASSWORD` or a `~/.pgpass` file (its path can be set with `PGPASSFILE`) — that is what `deploy/docker-compose.yml` does.
- **TLS** is controlled by the `sslmode` parameter. The default is `prefer`: TLS is used when the server supports it, but the certificate is not verified. To verify it, set `sslmode=verify-full` and the root certificate in `sslrootcert` (a path to a PEM file, or `system` for the system trust store). Without TLS use `sslmode=disable`.
- **Unix socket**: `host=/var/run/postgresql dbname=pgscope user=pgscope`.
- **Connection pool**: up to max(4, number of CPU cores) connections by default. Change it with the `pool_max_conns` parameter, for example `?pool_max_conns=20`.

If the string is invalid or the database is unreachable at startup, pgscope logs the error and exits (with the `schema setup:` prefix when the database is unreachable).

```bash
PGSCOPE_DB='postgres://pgscope@db.example.local:5432/pgscope?sslmode=verify-full&sslrootcert=/etc/pgscope/db-ca.crt'
PGPASSWORD='p@ss:word'

PGSCOPE_DB='host=/var/run/postgresql dbname=pgscope user=pgscope'

PGSCOPE_DB='postgres://pgscope:p%40ss@db.example.local/pgscope?sslmode=require&pool_max_conns=20'
```

### PGSCOPE_LISTEN {#pgscope-listen}

The address and port where pgscope accepts HTTP requests: the web UI, the UI API and report ingestion (`/api/v1/…`).

- The default is `:8080` — all interfaces.
- Examples: `127.0.0.1:8080` (local only, behind a reverse proxy), `[::1]:8080`, `0.0.0.0:9000`, `:9000`.
- pgscope speaks HTTP only. HTTPS is provided by a reverse proxy (see [Reverse proxy and HTTPS](install.md#reverse-proxy)).
- If the port is taken, pgscope exits with an error.
- In the Docker image keep `:8080`, as `deploy/docker-compose.yml` does, and choose the host address when publishing the port (`PGSCOPE_PORT`).
- The HTTP server timeouts are fixed: request headers must arrive within 10 seconds and the whole request with its body within 10 minutes, a response may take up to 35 minutes (enough for an AI chat answer), and an idle connection is closed after 2 minutes. This way a client cannot hold connections open indefinitely.

### PGSCOPE_BASE_URL {#pgscope-base-url}

The public address of pgscope — the one users open and the pgdash CLI and agents talk to. The default is `http://localhost:8080`. A trailing `/` is dropped.

Where it is used:

| Where | How |
|---|---|
| Alert notifications | links to objects: `BASE-URL/#/s/ID/…` |
| Team invitations | the `BASE-URL/#/invite/TOKEN` link in the email and in the invitation list |
| Access granted emails | a link to the server: `BASE-URL/#/s/ID` |
| Ready-made commands in the UI | `--base-url=BASE-URL/api/v1` in the profile, on the empty **Servers** page and in the server settings; `PGSCOPE_URL` on the **Agents** page |
| Session cookie | if the address starts with `https://`, the cookie gets the `Secure` flag (see [Session cookie and the Secure flag](install.md#secure-cookie)) |

Requirements:

- Scheme, host and port only, no path: pgscope works only at the root of a host.
- Behind an HTTPS proxy use `https://…`. If you set `https://` but open pgscope directly over `http://`, sign-in will not work.
- pgscope does not redirect requests to this address and answers on any host name. The variable affects only links and the cookie.

### PGSCOPE_SIGNUP {#pgscope-signup}

Who can create an account on their own on the **Sign up** page (`POST /api/signup`). The default is `first`.

| Value | Who can sign up |
|---|---|
| `first` | only the first user: sign-up is open while the database has no account. The first person to open pgscope becomes the owner, and after that the **Sign up** link disappears from the sign-in page. If every account is deleted, sign-up opens again |
| `open` | anyone who can open the web UI |
| `closed` | nobody: accounts are created only from team invitations |

- Accepting a team invitation works with every value.
- When sign-up is closed, the sign-up page shows **Sign-up of new accounts is disabled. Ask an administrator to invite you.**, and `POST /api/signup` answers 403 with the same text before checking the address and password. `GET /api/signup` tells whether sign-up is open right now (`{"open": true}` or `{"open": false}`); it works without signing in.
- With `first`, create your own account right after the first start: until then anyone who opens pgscope can sign up and become the owner.
- Sign-up is the only way to get a regular account with an API key: an invitation creates a team member account without a key (see [Accounts](teams.md#accounts)). If someone else needs servers of their own, set `open` for a while, restart pgscope, let them sign up and restore the previous value.
- Any other value stops pgscope at startup, for example `PGSCOPE_SIGNUP=yes: use first, open or closed`.

> [!WARNING]
> When upgrading from a version without this setting: if the database already has accounts, new users can no longer sign up on their own. To keep the old behaviour, set `PGSCOPE_SIGNUP=open`.

### PGSCOPE_MIN_REPORT_INTERVAL {#pgscope-min-report-interval}

The minimum interval in seconds between accepted reports of one server. The default is `60`.

- The limit applies separately to every combination of "account, server type (PostgreSQL or Pgpool), server name, PgBouncer instance". PgBouncer reports do not interfere with the reports of their PostgreSQL server or with each other.
- A report that comes too soon is rejected with status 429 and the message **Reports are being sent too often**. While the previous report of the same server is still being stored, a new one is rejected with status 409 — regardless of this setting.
- `0` disables the limit.
- The timestamps are kept in process memory and reset on restart.
- The effective value is shown in the **Sending reports** card of the profile page (**Reports for the same server must be at least … apart.**; with `0` the sentence is hidden) and returned in the `min_report_interval` field of `GET /api/me`.
- The limit protects the storage database from jobs that send reports in a loop by mistake. The pgscope-agent interval (`PGSCOPE_AGENT_INTERVAL`) and cron schedules must not be shorter than this value; the recommended reporting interval is 5 minutes.

Ingestion status codes are described in detail in [Server responses](collect.md#responses).

### PGSCOPE_MAX_REPORT_MB {#pgscope-max-report-mb}

The largest report pgscope accepts, in MiB. The default is `256`.

- The limit is checked twice: for the request body as it arrives (usually gzip-compressed) and for the data after decompression. It applies to `POST /api/v1/report`, `/api/v1/reportpgbouncer` and `/api/v1/reportpgpool`; the agent heartbeat has its own 4 MiB limit.
- A larger report is rejected with status 413 and the message **The report is larger than 256 MiB, the limit set by PGSCOPE_MAX_REPORT_MB on the pgscope server** (the message shows the current value).
- pgmetrics writes about 0.4–1 KiB per table or index, so 256 MiB fits about 250,000 objects.
- pgscope reads and stores at most 4 reports at once; the others wait their turn. Storing a report takes 5–7 times its size in memory, so in the worst case ingestion needs about 24 × `PGSCOPE_MAX_REPORT_MB` MiB of memory — about 6 GiB with the default. On a host with little memory, lower the limit while keeping a margin above the size of your largest reports.
- A value below `1` stops pgscope at startup with the message `PGSCOPE_MAX_REPORT_MB must be at least 1`.
- The body size limit of the reverse proxy must be no lower (`client_max_body_size` in nginx, see [Reverse proxy and HTTPS](install.md#reverse-proxy)).

### Retention {#retention-vars}

| Variable | Default | What is deleted |
|---|---|---|
| `PGSCOPE_METRICS_RETENTION_DAYS` | `90` | time series (charts, size growth) and the history of alerts and changes older than the given number of days |
| `PGSCOPE_REPORT_RETENTION_DAYS` | `14` | full reports older than the given number of days, except the latest report of every server and every PgBouncer instance |

- Cleanup runs when pgscope starts and then every hour. Expired sessions are deleted at the same time, whatever the retention values.
- Values are whole days. `0` means keep forever: with `PGSCOPE_METRICS_RETENTION_DAYS=0` time series and history are not deleted, and with `PGSCOPE_REPORT_RETENTION_DAYS=0` full reports are not deleted. A negative value stops pgscope at startup with the message `PGSCOPE_METRICS_RETENTION_DAYS=-1: set a number of days to keep the data, or 0 to keep it forever` (the same for `PGSCOPE_REPORT_RETENTION_DAYS`).
- Report retention determines how far back you can open a past report and see its queries, backends and locks. Time series retention determines how deep the charts go: the **30d** range needs at least 30 days.
- The longer the retention and the more objects in the reports, the larger the storage database. How to estimate and reduce its size is described in [Data storage](data.md#retention).

## Email (SMTP) {#smtp}

pgscope sends email through the SMTP server from its settings. In an isolated network this is the standard way to deliver notifications: point it at your internal mail server.

| Variable | Default | Purpose |
|---|---|---|
| `PGSCOPE_SMTP_ADDR` | — | SMTP server address as `host:port`; the port is mandatory. An empty value disables email |
| `PGSCOPE_SMTP_USER` | — | login. If set, PLAIN authentication is used |
| `PGSCOPE_SMTP_PASS` | — | password for the login |
| `PGSCOPE_SMTP_FROM` | `pgscope@localhost` | sender address: the `From` header and the `MAIL FROM` address. Use an address your mail server accepts |

**What is sent by email:**

| Message | Recipients | If SMTP is not configured |
|---|---|---|
| Notifications of email channels — about alerts and about changes | the addresses of the channel (several addresses separated by commas) | the channel can be created, but the form shows the warning **SMTP is not configured on this pgscope server (PGSCOPE_SMTP_ADDR), so emails will not be delivered.** when email is selected. The **Test** button returns the error **Could not send the notification: SMTP is not configured (set PGSCOPE_SMTP_ADDR)**, and real notifications are not sent (the error is written to the pgscope log) |
| Invitation of a new user to a team | the invitee and the owner (one message, both addresses in the `To` header) | the invitation is still created, and the owner sees the link in the invitation list: **SMTP is not configured: copy the invitation link from the list and send it yourself.** |
| Access granted to a user who already has an account | that user and the owner (one message) | access is granted immediately, no email is sent |

Emails are plain UTF-8 text. Notifications are written in the language chosen for the channel, invitations in the language of the person who invites. If a channel has several addresses, all of them are in the `To` header of one message and every recipient sees them.

Every email gets the `Date` and `Message-ID` headers (the `Message-ID` domain is taken from `PGSCOPE_SMTP_FROM`, or `localhost` if the address has none), so strict mail filters do not reject the messages for lacking them.

The channel's address list is cleaned before sending: surrounding spaces are dropped, empty entries (an extra or trailing comma) are skipped, and repeated addresses (case-insensitive) get one copy. If no address remains, sending fails with **No recipient address given**.

**How the connection is made:**

- pgscope connects to `PGSCOPE_SMTP_ADDR` over plain TCP. If the server offers STARTTLS, the connection is upgraded to TLS and the certificate is verified against the host name from `PGSCOPE_SMTP_ADDR`.
- SMTPS with TLS from the first byte (usually port 465) is not supported. Use port 587 (submission with STARTTLS) or 25.
- Sending one email — connecting and the whole exchange with the SMTP server — is limited to 30 seconds. If the server does not respond, sending fails, and the **Test** button shows **Could not send the notification: The SMTP server did not accept the message** within 30 seconds.
- The password is sent only over an encrypted connection: if `PGSCOPE_SMTP_USER` is set, the server must support STARTTLS (except for a server on `localhost`). If the server does not advertise AUTH, sending fails.
- If the mail server certificate is issued by an internal certificate authority, add its root certificate to the host's system trust store or pass it to pgscope with `SSL_CERT_FILE` (see [Environment variables of third-party components](#other-env)).
- If the SMTP server rejects a message or is unreachable, pgscope writes the reason to its log with the `smtp:` prefix. The UI shows the error only when you test a channel with the **Test** button: **Could not send the notification: The SMTP server did not accept the message**. Failed notifications are also logged with a `notify email …` line. Invitation and access emails are sent in the background: if SMTP is not configured, pgscope logs `team emails are not sent: SMTP is not configured (PGSCOPE_SMTP_ADDR); pass invitation links on yourself` once per run, and a failed delivery is logged as `team email "…" to … not sent: …`. The UI does not report these emails, so the invitation link can always be copied from the invitation list.

An internal relay without authentication:

```bash
PGSCOPE_SMTP_ADDR=mail.example.local:25
PGSCOPE_SMTP_FROM=pgscope@example.com
```

A mail server with authentication:

```bash
PGSCOPE_SMTP_ADDR=smtp.example.com:587
PGSCOPE_SMTP_USER=pgscope@example.com
PGSCOPE_SMTP_PASS=mailbox-password
PGSCOPE_SMTP_FROM=pgscope@example.com
```

After configuring it, create an email channel on the **Alerts** page of any server and click **Test** (see [Notification channels](notifications.md)).

## AI chat {#ai}

AI chat answers questions about a server based on its latest report (how it looks in the UI: see [AI chat](monitoring.md#ai-chat)). It is disabled by default.

> [!WARNING]
> The current implementation works only through the Anthropic cloud API. An enabled chat sends data of the monitored servers outside your network. In an isolated network leave `PGSCOPE_AI_KEY` empty: the chat stays disabled and pgscope does not contact external addresses.

| Variable | Default | Purpose |
|---|---|---|
| `PGSCOPE_AI_KEY` | — | Anthropic API key. A non-empty value enables AI chat for all users and servers of this pgscope |
| `PGSCOPE_AI_MODEL` | `claude-opus-5-5` | Anthropic model identifier |
| `PGSCOPE_AI_BASE_URL` | — | API base address instead of the standard Anthropic address: a corporate proxy or a gateway compatible with the Anthropic Messages API |

`PGSCOPE_AI_PROVIDER` from earlier versions is no longer read: there are no other providers, local models included.

**When the chat is disabled** (no key set), the **AI chat** page shows the message **AI chat is not configured. Set PGSCOPE_AI_KEY (an Anthropic API key) and restart pgscope.**, the input field is disabled, and the chat API answers with status 501.

**What is sent to Anthropic.** Every question is sent together with the whole conversation and a summary of the server's latest report — even if a past report is selected in the UI. A conversation can have at most 50 messages, that is 25 questions with answers; after that the server answers with status 400, and you need to start a new conversation. The summary includes:

- the server name, PostgreSQL version, start time, standby flag;
- configuration settings that differ from their defaults;
- databases, tablespaces, roles, extensions;
- the 40 largest tables and the 40 largest indexes;
- the 25 queries with the highest total time from `pg_stat_statements`, with their texts;
- up to 60 sessions, excluding idle ones (`idle`) and background processes without a state: role, database, application, client address, query text;
- waiting locks, replication and slots, WAL, checkpoints, system metrics, diagnostics and configuration check results.

Query texts may contain literals with data. Role passwords are not part of a pgmetrics report, but setting values are sent as they are: if a password is written in a configuration setting (for example, in `primary_conninfo`) and the monitoring role can read it, it ends up in the summary.

**How the request is made.** pgscope calls the Anthropic Messages API through the official Go SDK: up to 16,000 tokens per answer, caching of the report context between the questions of one conversation, and beta API features (effort level and a server-side fallback model). Only the browser keeps the conversation, in the tab's session storage (`sessionStorage`), separately for each server: it is not stored on the server or in the database, survives a page reload, and disappears when the tab is closed or with the **New conversation** button. Anyone with access to the server can use the chat — the owner and team members. The answer comes in the UI language unless the user writes in another language. The SDK waits up to 10 minutes per attempt and makes up to 3 attempts, so pgscope keeps a chat response open for up to 35 minutes; allow for this in the proxy's response read timeout (`proxy_read_timeout`).

**Errors.**

| Status | Message | Cause |
|---|---|---|
| 501 | **AI chat is not configured: set an Anthropic API key in PGSCOPE_AI_KEY** | no key set |
| 400 | **Invalid request** | the conversation has more than 50 messages: start a new conversation |
| 404 | **No reports yet** | the server has no reports yet |
| 502 | **The AI provider returned HTTP …** | the API rejected the request: wrong key, unknown model, rate limits |
| 502 | **Could not reach the AI provider** | no network access to the API or the proxy |
| 502 | **The AI model declined to answer this question** | the model declined to answer |

**`PGSCOPE_AI_BASE_URL` and isolated networks.** The variable lets you route requests through a corporate gateway that inspects and logs traffic to Anthropic. The data still goes to the cloud. A local model behind such an address would have to support the Anthropic Messages API together with the beta parameters pgscope sends; this setup has not been tested and is not supported. Note also that the Anthropic API is not available in every country.

Enabling the chat (if your security policy allows the data transfer):

```bash
PGSCOPE_AI_KEY=YOUR_ANTHROPIC_KEY
PGSCOPE_AI_MODEL=claude-opus-5-5
```

## Environment variables of third-party components {#other-env}

These variables are read not by pgscope itself but by the libraries it is built on. They are sometimes useful.

| Variable | Read by | Purpose |
|---|---|---|
| `PGPASSWORD`, `PGPASSFILE`, `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `PGSSLROOTCERT`, `PGAPPNAME`, `PGCONNECT_TIMEOUT` and other `PG*` | the PostgreSQL driver (pgx) when connecting to the storage database | values missing from `PGSCOPE_DB`. `deploy/docker-compose.yml` passes the password this way (`PGPASSWORD`) |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | TLS in Go | root certificates pgscope trusts for STARTTLS to SMTP, HTTPS webhooks, the AI API and verifying the database certificate with `sslrootcert=system`. `SSL_CERT_FILE` is a PEM file used instead of the system bundle file (for example `/etc/ssl/certs/ca-certificates.crt`); the certificates in the `/etc/ssl/certs` and `/etc/pki/tls/certs` directories are still read. `SSL_CERT_DIR` is a `:`-separated list of directories used instead of these standard ones. Needed when services use certificates of an internal certificate authority that is not in the system trust store |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | the Go HTTP client | a proxy for outbound HTTP requests: webhooks, Slack, PagerDuty, VictorOps, xMatters, AI chat. Email does not go through the proxy. List internal webhook addresses in `NO_PROXY` |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` and other `ANTHROPIC_*` | the Anthropic SDK | `PGSCOPE_AI_KEY` and `PGSCOPE_AI_BASE_URL` take precedence; the chat is enabled only by `PGSCOPE_AI_KEY` |

## Docker Compose variables {#compose-vars}

`deploy/docker-compose.yml` reads variables from `deploy/.env`. Three of them are used only by the compose file itself:

| Variable | Default | Purpose |
|---|---|---|
| `PGSCOPE_DB_PASSWORD` | required | password of the `pgscope` user in the database container. Applied only when the `pgscope-data` volume is initialized for the first time; passed to pgscope as `PGPASSWORD` |
| `PGSCOPE_PORT` | `8080` | the host port pgscope is published on; `127.0.0.1:8080` means the loopback interface only |
| `PGSCOPE_IMAGE` | `pgscope:latest` | the pgscope image; use a versioned tag so upgrades and rollbacks are explicit |

`PGSCOPE_DB` (`postgres://pgscope@db:5432/pgscope?sslmode=disable`) and `PGSCOPE_LISTEN` (`:8080`) are fixed in the compose file. To keep the data in an external database, edit the compose file. The other variables (`PGSCOPE_BASE_URL`, `PGSCOPE_SIGNUP`, `PGSCOPE_MIN_REPORT_INTERVAL`, `PGSCOPE_MAX_REPORT_MB`, retention, `PGSCOPE_SMTP_*`, `PGSCOPE_AI_KEY`, `PGSCOPE_AI_MODEL`, `PGSCOPE_AI_BASE_URL`) are passed from `.env` with the same defaults as pgscope's.

Variables that are not in the `environment` section of the `pgscope` service (for example `SSL_CERT_FILE`, `HTTPS_PROXY`, `NO_PROXY`) do not reach the container from `.env`: `.env` only supplies values substituted into the compose file. Add such variables to `environment` yourself, and mount certificate files into the container with `volumes`.

## Configuration examples {#examples}

A trial installation on one host, without a proxy:

```bash
PGSCOPE_DB=postgres://pgscope:secret@localhost/pgscope
PGSCOPE_BASE_URL=http://monitor.example.local:8080
```

A production installation behind an HTTPS proxy, with internal email, in an isolated network (AI chat is disabled because `PGSCOPE_AI_KEY` is not set):

```bash
PGSCOPE_DB=postgres://pgscope@pgstore.example.local:5432/pgscope?sslmode=verify-full&sslrootcert=/etc/pgscope/db-ca.crt
PGPASSWORD=strong-password
PGSCOPE_LISTEN=127.0.0.1:8080
PGSCOPE_BASE_URL=https://pgscope.example.local
PGSCOPE_SMTP_ADDR=mail.example.local:25
PGSCOPE_SMTP_FROM=pgscope@example.local
PGSCOPE_METRICS_RETENTION_DAYS=60
PGSCOPE_REPORT_RETENTION_DAYS=7
# root certificate of the internal certificate authority (instead of the system bundle file)
SSL_CERT_FILE=/etc/pgscope/internal-ca.pem
```

## Agent variables {#agent-vars}

pgscope-agent has its own variables: `PGSCOPE_URL`, `PGSCOPE_API_KEY` or `PGSCOPE_API_KEY_FILE`, `PGSCOPE_AGENT_*` (collection interval, monitoring role, timeouts, networks), and also `DOCKER_HOST` and `PGMETRICS`. They are described in [Docker and Docker Swarm](docker.md). The agent's collection interval must not be shorter than the server's `PGSCOPE_MIN_REPORT_INTERVAL`, otherwise some reports are rejected with status 429.
