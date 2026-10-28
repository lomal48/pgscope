# Security

This page describes how pgscope protects data and access to it: the threat model, accounts and passwords, sessions and the cookie, sign-up, API keys, ingestion protections, the monitoring role, the agent and the Docker socket, secrets handling and the data that can leave your network. It ends with a checklist for a production installation.

## Threat model {#threat-model}

**What needs protection.**

- **Monitoring data.** pgmetrics reports contain query texts from `pg_stat_statements` and `pg_stat_activity` (with literals, so possibly personal or business data), names of databases, schemas, tables and roles, configuration settings, host names, client addresses and PostgreSQL log lines if pgmetrics reads the log.
- **pgscope accounts and their sessions.**
- **API keys.** A key lets anyone write reports on behalf of an account.
- **Integration secrets**: the SMTP password, the AI key, Slack webhook URLs, PagerDuty keys and other notification channel destinations.

**Entry points.**

| Entry point | Who uses it | Protected by |
|---|---|---|
| Web interface and its API (`/api/…`) | users' browsers | session cookie |
| Report ingestion API (`/api/v1/…`) | pgdash CLI, pgscope-agent | API key in the request body |
| Outgoing connections | pgscope → SMTP, webhooks, notification services, AI API | destinations set by users (channels) and the administrator (environment variables) |
| Storage database | pgscope, administrator | PostgreSQL roles and `pg_hba.conf` |

pgscope never connects to the monitored databases itself: collectors send the reports. Compromising pgscope does not give direct access to the databases, but it exposes everything in the reports.

**What pgscope does not have** (factor this into your risk assessment):

- built-in TLS: HTTPS is provided by a reverse proxy (see [Reverse proxy and HTTPS](install.md#reverse-proxy));
- single sign-on (SSO, LDAP) and two-factor authentication;
- sign-in attempt limiting;
- an administrator role: every account sees only its own servers and the servers shared with it, and instance-wide actions are done in the storage database;
- an audit log of user actions;
- password reset by email.

## Accounts and passwords {#accounts}

- Passwords are hashed with bcrypt at the default cost of the `golang.org/x/crypto/bcrypt` library (10). Plain-text passwords are not stored.
- A password must be at least 8 characters and at most 72 bytes long (72 bytes is the bcrypt limit). A Cyrillic character takes 2 bytes, so an all-Cyrillic password is at most 36 letters. The rule is the same for sign-up, accepting an invitation and changing the password.
- Email addresses are lowercased. Email is not verified, and the format check is minimal: contains `@`, at most 254 characters, no spaces.
- A failed sign-in gets the same answer for an unknown email and a wrong password: **Incorrect email address or password**. The response time does not tell them apart either: for an unknown address the password is compared with a dummy hash of the same cost. Open sign-up, however, answers **An account with this email address already exists**, so it can be used to find out whether an address is registered. Closed sign-up answers 403 before looking at the address and reveals nothing.
- There is no limit on sign-in attempts. Set one up on the reverse proxy, for example `limit_req` in nginx for `/api/login`.
- There are two kinds of accounts: the owner (signs up on their own and gets an API key) and the team member (created from an invitation, no API key). See [Team, profile and account](teams.md).

### Resetting a forgotten password {#password-reset}

There is no self-service password reset. An administrator of the storage database can set a temporary password for a user. This needs the pgcrypto extension; in PostgreSQL 13 and later the database owner can install it.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE users SET pwhash = crypt('Temporary-Passw0rd', gen_salt('bf', 10))
WHERE email = 'user@example.com';
```

The temporary password may stay in the psql history and in the storage database log, so the user should change it right away in **Profile** → **Change password**.

## Sessions and the cookie {#sessions}

- Signing in creates a session with a random 52-character token from a cryptographic generator. The token is stored in the `sessions` table as is.
- A session lasts 30 days from sign-in. Activity does not extend it.
- **Sign out** deletes the session on the server.
- Changing the password ends all other sessions of the user; the session the change was made from stays. Regenerating the API key does **not** end sessions. You can end all sessions of a user, the current one included, in the storage database:

```sql
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com');
```

Cookie attributes:

| Attribute | Value |
|---|---|
| Name | `pgscope_session` |
| `Path` | `/` |
| `Expires` | 30 days after sign-in |
| `HttpOnly` | always: page scripts cannot read the token |
| `SameSite` | `Lax` |
| `Secure` | if the proxy sent the `X-Forwarded-Proto: https` header or if `PGSCOPE_BASE_URL` starts with `https://` |

Behind an HTTPS proxy, set `PGSCOPE_BASE_URL` with `https://` or pass `X-Forwarded-Proto`; otherwise the cookie lacks the `Secure` flag. Conversely, if the flag is set but pgscope is opened over `http://`, the browser does not store the cookie and sign-in fails. All combinations are covered in [Reverse proxy and HTTPS](install.md#reverse-proxy).

**CSRF protection.** Every interface API request that changes state must carry `Content-Type: application/json`, otherwise pgscope answers 415 **The request body must be JSON**. This covers requests with any method other than GET to the part of the API that requires sign-in, and the requests available without signing in: `POST /api/signup`, `/api/login`, `/api/logout` and `/api/invite/…`. A plain HTML form on another site cannot send such a request, and for `fetch` the browser needs CORS permission, which pgscope never grants. So another site can neither quietly sign the user's browser in to an attacker's account nor end the user's session. `SameSite=Lax` adds another layer: the browser does not send the cookie with POST requests from other sites. The ingestion API (`/api/v1/…`) does not check the header: it authenticates with an API key, not a cookie.

## Sign-up {#signup}

Sign-up (`POST /api/signup`) is available without signing in. Who can use it is set by `PGSCOPE_SIGNUP` (see [PGSCOPE_SIGNUP](config.md#pgscope-signup)):

| Value | Who can sign up |
|---|---|
| `first` (the default) | only the first user, while the database has no account. Concurrent attempts on an empty database queue up, and only one of them gets an account |
| `open` | anyone who can open the web interface |
| `closed` | nobody: accounts are created only from team invitations (`/api/invite/…`) |

When sign-up is closed, the sign-in page has no **Sign up** link, the sign-up page shows **Sign-up of new accounts is disabled. Ask an administrator to invite you.** instead of the form, and `POST /api/signup` answers 403.

With `first`, anyone who opens pgscope before the first sign-up can become the owner, so create your own account right after installation. With `open`, anyone with network access to pgscope gets an account with an API key and can:

- see only their own servers: other people's data is not available to them;
- send reports and thus consume space in the storage database;
- add notification channels to their servers. pgscope then sends POST requests to destinations they choose, including internal-network addresses reachable from the pgscope host. The **Test** button sends a request right away and shows the HTTP status or the connection error, so it can be used to probe internal addresses;
- send emails to any address through your SMTP server: notifications and invitations (pgscope composes the text).

What to do:

1. Make the web interface reachable only from the networks where pgscope users work: firewall, VPN, reverse proxy rules.
2. Keep `PGSCOPE_SIGNUP=first` or set `closed`. If you had to turn on `open`, restore the previous value as soon as the accounts you need exist.

3. Restrict outgoing connections from the pgscope host: allow only the SMTP server and the destinations that actually need webhooks.

## API keys {#api-keys}

- A key is created when an owner signs up. It is 22 characters long; pgscope generates it from uppercase Latin letters and the digits 2 to 7 (about 110 bits of randomness). Any key in the `[A-Za-z0-9]{22}` format is accepted — the pgdash CLI validates keys the same way.
- An account has one key. Team members have none.
- **What a key grants.** Writing only: sending PostgreSQL, PgBouncer and Pgpool reports and agent heartbeats on behalf of the account. A server with a new name is created automatically on its first report. A key cannot read data.
- **Why a leak is dangerous.** Someone can flood the account with servers and data or fake the reports of an existing server, for example to hide a problem and thereby clear alerts.
- The key is stored in the storage database as is (`users.apikey`).
- **Regeneration**: **Profile** → **API key** → **Regenerate**. The old key stops working immediately (403), so prepare the update of cron jobs and agent secrets in advance (see [Profile](teams.md#profile)).
- In commands like `pgdash -a KEY` the key is visible in the process list and in the collection host's crontab. Restrict access to these hosts. The agent reads the key from a Docker secret and never puts it on a command line.

## Ingestion protections {#ingest-protection}

| Measure | How it works |
|---|---|
| Body size | a report is limited to `PGSCOPE_MAX_REPORT_MB` (256 MiB by default) both on the wire and after gzip decompression, otherwise the answer is 413 (see [PGSCOPE_MAX_REPORT_MB](config.md#pgscope-max-report-mb)); an agent heartbeat to 4 MiB, otherwise the answer is 400; web interface requests to 1 MiB |
| Key before the report | `apikey` must come before `data` in the body (the pgdash CLI and pgscope-agent send it that way), otherwise the answer is 400. The key is checked before the report is read: an invalid or unknown key gets 401 or 403 after at most 64 KiB has been read, and a request without a valid key never takes one of the 4 report slots. At most 64 KiB of JSON is allowed before the `data` member, otherwise the answer is 400 |
| Format checks | the key is exactly 22 Latin letters or digits; server, PgBouncer and Pgpool names use `A–Z a–z 0–9 _ . -`, 1 to 64 characters; `data` must be a pgmetrics report with the collection time set and, for PgBouncer and Pgpool, with their section |
| Rate | a report of one source (a server or one of its PgBouncers) is accepted at most once per `PGSCOPE_MIN_REPORT_INTERVAL` seconds (60 by default), otherwise the answer is 429 |
| Concurrency | while the previous report of the same source is being saved, a new one gets 409. At most 4 reports in total are read and stored at once; the others wait until a slot frees up or the client disconnects |
| Connection timeouts | request headers must arrive within 10 seconds and the whole request with its body within 10 minutes; an idle connection is closed after 2 minutes. A client cannot hold connections open indefinitely |
| Errors | database error details go to the pgscope log; the client only gets a generic message |

Limitations worth knowing:

- Rate tracking lives in process memory: it resets on restart and does not count failed requests. There is no global request rate limit.
- An agent heartbeat is read and parsed (up to 4 MiB) **before** its key is checked, so even a client without a key can make pgscope use a lot of memory. Reports are not affected: their key is checked before the report is read.

So on the reverse proxy, open `/api/v1/` only to the networks where collectors run, and cap the body size at what your reports need (the average report size is shown by a query in [Checking the actual size](data.md#size-check)):

```nginx
location /api/v1/ {
    allow 10.20.0.0/16;          # collection hosts and Docker hosts with agents
    deny  all;
    client_max_body_size 64m;
    proxy_pass http://127.0.0.1:8080;
}
```

Response codes of the ingestion API are listed on the [API](api.md) page.

## Monitoring role {#monitoring-role}

- Collectors need a role with `pg_monitor`; a superuser is not required. How to create it is described in [Preparing PostgreSQL](postgres.md).
- `pg_monitor` exposes the full query texts of other users in `pg_stat_statements` and `pg_stat_activity`. They may contain literals with data, and all of it ends up in pgscope, visible to everyone with access to the server, team members included. The pgmetrics `--sql-length` flag limits the stored text length (500 characters by default).
- pgmetrics reads the PostgreSQL log only over a local connection on the database host (for example through the Unix socket) and as an OS user allowed to read the log files. Log lines also end up in the report.
- Keep the role password in `~/.pgpass` with `0600` permissions, not on the command line.
- For databases in Docker, the `deploy/agent/bootstrap-monitor-role.sh` script creates the `pgscope_monitor` role by passing SQL over stdin and, for its own session, turning off statement logging and utility statement tracking in `pg_stat_statements`, so the password ends up neither in the process list, nor in the log, nor in reports. See [Docker and Docker Swarm](docker.md).

## The agent and the Docker socket {#docker-agent}

- Access to `/var/run/docker.sock` is equivalent to root on the host. The agent runs as root in its container because it talks to the socket; its image is based on Alpine Linux and, besides the base system, contains only the agent, pgmetrics and the root certificates (`ca-certificates`). Mounting the socket with `:ro` does not restrict the API.
- Access can be narrowed with docker-socket-proxy. Only denying POST requests (`POST=0`) is a real restriction; automatic network joining is then impossible, and the database networks must be listed in the agent's compose file (`PGSCOPE_AGENT_AUTOCONNECT=false`).
- The agent presents the monitoring role password to every container labeled `pgscope.enable=true`. Anyone who can start labeled containers on that host can obtain the password. The role must therefore have no rights beyond `pg_monitor`.
- The default `sslmode=prefer` encrypts the connection if the server supports TLS but does not verify the certificate. To verify it, set `PGSCOPE_AGENT_SSLMODE` or the `pgscope.sslmode` label.

Details and an example configuration with a socket proxy are on the [Docker and Docker Swarm](docker.md) page.

## Secrets {#secrets}

| Secret | Where it is kept | Recommendation |
|---|---|---|
| Storage database password | in `PGSCOPE_DB` or in `PGPASSWORD` (as in `deploy/docker-compose.yml`) | an environment file with `0600` permissions (`EnvironmentFile` in systemd, `deploy/.env`) |
| `PGSCOPE_SMTP_PASS`, `PGSCOPE_AI_KEY` | process environment variables | the same; environment variables are visible to root and through `docker inspect` |
| Password hashes, API keys, session and invitation tokens | the `users`, `sessions` and `invites` tables, as is (except the hashes) | restrict access to the storage database and its backups, encrypt backups |
| Notification channel destinations (Slack webhook URLs, PagerDuty keys, VictorOps and xMatters URLs) | the `notifiers` table | visible in the interface to everyone with access to the server, and written to the pgscope log when delivery fails |
| The agent's API key and role password | Docker secrets in `/run/secrets/` | the agent does not pass `PGSCOPE_*` variables to pgmetrics and passes the role password only in its environment (`PGPASSWORD`) |

**TLS.** pgscope itself only speaks HTTP. Publish it through a reverse proxy with HTTPS and keep the service on the loopback interface: `PGSCOPE_LISTEN=127.0.0.1:8080`, or `PGSCOPE_PORT=127.0.0.1:8080` in Docker Compose. Outgoing TLS connections (STARTTLS to SMTP, webhooks, the AI API) verify certificates against the system store. If a certificate is issued by an internal CA, add the CA to the system store or point `SSL_CERT_FILE` at a PEM file (standard Go behavior on Linux). The connection to the storage database is encrypted with the `sslmode` parameter in `PGSCOPE_DB`.

## Data leaving your network {#egress}

pgscope is designed for air-gapped networks: the web interface loads no external resources (fonts, CDNs), and the links to the pgmetrics and pgdash CLI websites on the **Profile** page are ordinary hyperlinks. Data leaves only through the features in the table below, and you enable each of them yourself.

| Feature | Where data goes | What is sent | Air-gapped alternative |
|---|---|---|---|
| AI chat | the Anthropic API (cloud) or the address in `PGSCOPE_AI_BASE_URL` | the whole current conversation (questions and earlier answers) and a summary of the latest report: server name, version, non-default settings, databases, roles, extensions, the 40 largest tables and indexes, the 25 most expensive queries with their texts, up to 60 active sessions with query texts and client addresses, locks, replication, system metrics, diagnostics results | leave `PGSCOPE_AI_KEY` empty (see [AI chat](config.md#ai)) |
| Slack channel | the Incoming Webhook URL (usually `hooks.slack.com`) | notification subject and text: rule texts, object names, values | email through an internal SMTP server or a webhook to an internal address |
| PagerDuty channel | always `https://events.pagerduty.com/v2/enqueue`; the address cannot be changed | subject, server name, all notification data including query texts | the same |
| VictorOps and xMatters channels | the URL in the channel settings (cloud services) | VictorOps: subject, text and server name; xMatters: subject, text, severity, server name and all notification data including query texts | the same |
| Email channel | your SMTP server | notification subject and text | an internal SMTP server (see [Email (SMTP)](config.md#smtp)) |
| **Webhook** channel | any URL in the channel settings | JSON with alerts or changes (see [Webhook format](notifications.md#webhook)) | an internal receiver |

Watch the collector side too:

- Without `--base-url`, the pgdash CLI sends the report to the pgDash cloud. Always specify your pgscope address; in an air-gapped network such a request simply fails.
- pgmetrics with `--aws-rds-dbid` calls AWS APIs (CloudWatch for metrics, RDS for the log), and with `--az-resource` Azure Monitor. These calls come from the collection host, not from pgscope.

## Checklist {#checklist}

1. pgscope listens only on the loopback interface (`PGSCOPE_LISTEN=127.0.0.1:8080` or `PGSCOPE_PORT=127.0.0.1:8080`), and users and collectors reach it through a reverse proxy with HTTPS.
2. `PGSCOPE_BASE_URL` starts with `https://`, and the session cookie gets the `Secure` flag.
3. The web interface is reachable only from the networks that need it; `PGSCOPE_SIGNUP` is `first` (the default) or `closed`, and the first account was created right after installation.
4. `/api/v1/` is reachable only from collector networks, and `client_max_body_size` matches the size of your reports.
5. Sign-in attempts (`/api/login`) are rate-limited on the proxy.
6. The monitoring role has only `pg_monitor`; its password is kept in `~/.pgpass` with `0600` permissions or in a Docker secret.
7. pgscope passwords and keys are kept in environment files with `0600` permissions, not in a unit file or compose file under version control.
8. The storage database is accessible only to pgscope and administrators, and backups are encrypted.
9. The pgscope host is allowed only the outgoing connections it needs: SMTP and internal webhook receivers. If data must not leave the network, `PGSCOPE_AI_KEY` is empty and Slack, PagerDuty, VictorOps and xMatters channels are not used.
10. Owners regularly review the **Team sharing** list and pending invitations and revoke access that is no longer needed. There is no audit log, so these reviews are the only control.
11. The agent runs through docker-socket-proxy with `POST=0` when automatic network joining is not needed.
12. If an API key may have leaked, regenerate it at once; if a session may have been stolen, the user changes their password, which ends all their other sessions (or delete the user's sessions in the storage database, see [Sessions and the cookie](#sessions)).
