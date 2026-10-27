# Notification channels

This page describes where pgscope sends notifications about alerts and changes: every channel type and the fields to fill in, the notification language, the test button, timeouts and retries, the exact webhook format, and which channels need internet access and what to use instead on a closed network. When exactly notifications are sent is covered in [Alert rules](alerts.md#edge-triggered) and [Change alerts](change-alerts.md#notifications).

## How notifications are delivered {#delivery}

Every server has two independent sets of channels:

| Set | Where it is configured | What it receives |
|---|---|---|
| Alert channels | **Alerts** → **Notifications** tab | changes of the set of triggered alerts, including "all alerts cleared" |
| Change alert channels | **Change alerts** → **Notifications** card | changes found when comparing consecutive reports |

Channels belong to a server: each server has its own. Every notification goes to all channels of its set, with no filtering by severity. Sending happens in the background after the report is stored, and each channel is handled separately: a failing channel does not block the others and does not affect report ingestion.

There is no queue of undelivered notifications. If a channel is unavailable, the error is written to the pgscope log as a line like `notify <kind> <destination>: <error>` (on a network error of an HTTP channel it is preceded by a `webhook: …` line, when the SMTP server refuses — by an `smtp: …` line with the original cause) and the notification is lost; pgscope will not notify about the same state again. The current state is always visible on the **Triggered** tab and in the history.

## Adding a channel {#add-channel}

1. Open the **Notifications** tab of the Alerts page (or the **Notifications** card of the Change alerts page).
2. Pick a **Channel**: **Email**, **Slack**, **PagerDuty**, **VictorOps**, **xMatters** or **Webhook**.
3. Fill in **Destination** — what exactly depends on the channel type (see [Channel types](#channel-types)); the field's placeholder shows the format.
4. Pick the **Notification language** (see [Notification language](#language)).
5. Click **Add**.

Validation when adding:

- an empty destination is rejected with "Invalid notification channel";
- for Slack, VictorOps, xMatters and webhook the destination must be a URL with the `http` or `https` scheme and a host name, otherwise "The address must be an http or https URL";
- for Email and PagerDuty the format is not checked; verify the channel with the **Test** button.

Added channels are listed with their type, destination, a language badge (`RU` or `EN`), a **Test** button and a trash button to delete them. Deletion is immediate, with no confirmation. Channels cannot be edited — delete and add again.

If Email is selected but SMTP is not configured in pgscope, a warning appears under the form: "SMTP is not configured on this pgscope server (PGSCOPE_SMTP_ADDR), so emails will not be delivered."

## Notification language {#language}

The language is set per channel: **Русский** or **English**. The current UI language is selected by default. The channel language determines the subject and body of the message, the rule and change texts inside the JSON, the units (`ГиБ` / `GiB`) and the decimal separator (`9,8%` / `9.8%`). This way you can, for example, send notifications to a Russian-speaking mailing list and an English-speaking on-call system at the same time.

The language of an existing channel cannot be changed: delete the channel and add it again with another language. Error messages from a channel test are shown in the UI language, while the test notification itself is in the channel language.

## Testing a channel {#test}

The **Test** button next to a channel immediately sends a test notification in the channel language:

- the subject is "[pgscope] test notification for server “prod-db-1”", the text is "This is a test notification from pgscope.";
- for alert channels the body contains one test alert with severity `warn`, the text "Test alert", the value `1` and a link to the server's Alerts page;
- for change alert channels it contains one change "Test change" with the value "test".

On success the page shows "Test notification sent (…)" with the channel type. On failure it shows "Could not send the notification: …" with the reason, for example "SMTP is not configured (set PGSCOPE_SMTP_ADDR)", "No recipient address given", "The SMTP server did not accept the message", "https://… returned HTTP status 404" or "could not reach https://…". A test does not change the alert state and is not added to the history.

> [!WARNING]
> Testing a PagerDuty or VictorOps channel on the **Notifications** tab of the Alerts page sends a real event with warning severity: PagerDuty gets a `trigger` with the same `dedup_key` as the server's real alerts, VictorOps gets a `WARNING` with the same `entity_id`. If there are no real alerts, resolve the opened incident manually. Testing a PagerDuty channel on the Change alerts page opens a separate incident with severity `info` and no `dedup_key`, which also has to be resolved manually.

## Channel types {#channel-types}

| Channel | What to enter in **Destination** | What is sent | Needs internet access |
|---|---|---|---|
| **Email** | addresses separated by commas | an email through the SMTP server from pgscope settings | no, if the SMTP server is internal |
| **Slack** | an Incoming Webhook URL | `POST` JSON `{"text": …}` | yes, for cloud Slack |
| **PagerDuty** | an Events API v2 integration key (routing key) | `POST` to `https://events.pagerduty.com/v2/enqueue` | yes, the address is hard-coded in pgscope |
| **VictorOps** | a REST endpoint URL with the routing key | `POST` JSON in the REST integration format | yes (cloud service) |
| **xMatters** | an inbound integration URL | `POST` JSON | yes (cloud service) |
| **Webhook** | any `http(s)` URL | `POST` JSON, see [Webhook format](#webhook) | no, if the address is internal |

Slack, VictorOps and xMatters use the same notification subject and text as the email (see [Email](#email)). PagerDuty gets only the subject (`summary`) and the webhook JSON (`custom_details`), the webhook only the JSON.

### Email {#email}

- **Destination**: one or more addresses separated by commas, for example `ops@example.com, dba@example.com`. Spaces around addresses are removed, empty entries (for example, after an extra comma) are skipped, and repeats of an address (ignoring case) are kept once. All recipients get one email (all are listed in the `To` header). If no address is left, sending fails with "No recipient address given".
- **Sender**: `PGSCOPE_SMTP_FROM` (`pgscope@localhost` by default).
- **Format**: plain text in UTF-8, MIME-encoded subject. pgscope writes the `From`, `To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and `Content-Type` headers. `Message-ID` looks like `<random-string@domain>`, where the domain comes from `PGSCOPE_SMTP_FROM` (`localhost` if the address has no domain).
- **Requires**: `PGSCOPE_SMTP_ADDR` (`host:port`), plus `PGSCOPE_SMTP_USER` and `PGSCOPE_SMTP_PASS` if needed, see [Configuring pgscope](config.md#smtp).

Sending details (the standard Go SMTP client):

- if the server offers STARTTLS, the connection is encrypted and the server certificate is verified;
- when `PGSCOPE_SMTP_USER` is set, the user name and password (PLAIN mechanism) are sent only over an encrypted connection or to `localhost`, otherwise sending fails; it also fails when the server does not advertise AUTH;
- SMTPS with implicit TLS (usually port 465) is not supported — use a STARTTLS port (usually 587) or an internal relay on port 25;
- there are no retries; one delivery (connecting plus the whole exchange with the SMTP server) gets 30 seconds. If the SMTP server has not finished by then, the delivery fails with "The SMTP server did not accept the message" (the cause is in the pgscope log, in the `smtp: …` line), and the **Test** button waits at most 30 seconds;
- the proxy variables (`HTTPS_PROXY` and others) do not apply to SMTP: pgscope connects to `PGSCOPE_SMTP_ADDR` directly.

An example of an alert email is on the [Alert rules](alerts.md#examples) page. A change email looks like this:

```text
Subject: [pgscope] prod-db-1: changes detected (2)

Table added: — → shop.public.invoices
Setting “work_mem” changed: 4096 → 16384
```

### Slack {#slack}

- **Destination**: a Slack Incoming Webhook URL, for example `https://hooks.slack.com/services/T000/B000/XXXX`.
- **Request body**: JSON with a single `text` field. It holds the notification subject in bold (`*subject*`), a line break and the notification text in a code block (between triple backticks).

The channel posts to whatever URL is configured, so it also suits self-hosted messengers with Slack-compatible incoming webhooks (for example Mattermost), provided they accept this format. Verify it with the **Test** button.

### PagerDuty {#pagerduty}

- **Destination**: the integration key of a PagerDuty service of type Events API v2 (Integration Key / routing key). It is not a URL: pgscope always sends events to `https://events.pagerduty.com/v2/enqueue`, and the address cannot be changed.
- **Alerts**: on any change of the set, a `trigger` event with a `dedup_key` of the form `pgscope-alerts-<server name>` and severity `critical` if any alert is critical, otherwise `warning`. Since there is one dedup key per server, PagerDuty keeps one incident that gets updated. When all alerts clear, a `resolve` with the same `dedup_key` is sent and the incident is resolved.
- **Changes**: a `trigger` event with severity `info` and no `dedup_key`, so every change notification is a separate incident that pgscope never resolves.
- `payload.summary` is the notification subject, `payload.source` is the server name, `payload.custom_details` is the same JSON the webhook receives.

An example event for alerts (fields in the order pgscope writes them):

```json
{
  "dedup_key": "pgscope-alerts-prod-db-1",
  "event_action": "trigger",
  "payload": {
    "custom_details": {
      "alerts": [
        {
          "type": "crit",
          "text": "Free disk space less than 15%",
          "value": "9.8%",
          "objname": "pg_default",
          "objlink": "https://pgscope.example.com/#/s/1/tablespaces"
        }
      ],
      "reported": 1793008773,
      "server": "prod-db-1",
      "version": 1
    },
    "severity": "critical",
    "source": "prod-db-1",
    "summary": "[pgscope] prod-db-1: alerts (critical: 1, warning: 0)"
  },
  "routing_key": "0123456789abcdef0123456789abcdef"
}
```

### VictorOps {#victorops}

- **Destination**: the REST Endpoint integration URL from VictorOps (Splunk On-Call), already containing the routing key at the end. pgscope posts to this URL as is; the URL format is defined by VictorOps and usually looks like `https://alert.victorops.com/integrations/generic/20131114/alert/<API_KEY>/<ROUTING_KEY>`.
- **Request body**:

| Field | Value |
|---|---|
| `message_type` | `CRITICAL` if there are critical alerts, otherwise `WARNING`; `RECOVERY` when all alerts clear; `INFO` for change notifications |
| `entity_id` | `pgscope/<server name>` — one per server |
| `entity_display_name` | the notification subject |
| `state_message` | the notification text (as in the email) |
| `monitoring_tool` | `pgscope` |

### xMatters {#xmatters}

- **Destination**: an xMatters inbound integration URL.
- **Request body**:

| Field | Value |
|---|---|
| `subject` | the notification subject |
| `message` | the notification text (as in the email) |
| `severity` | `critical` or `warning` for alerts (`warning` also when all alerts clear), `info` for changes |
| `server` | the server name |
| `details` | the same JSON the webhook receives |

### Webhook {#webhook-channel}

- **Destination**: any `http` or `https` URL, for example `https://hooks.internal.example/pgscope`.
- **Request body**: the JSON described in [Webhook format](#webhook).

The webhook is the main integration method on a closed network: a receiver inside the perimeter can forward notifications to an internal messenger, a ticketing system or your own on-call tool.

## Timeouts, retries and errors {#retries}

Slack, PagerDuty, VictorOps, xMatters and webhook follow the same rules:

| Situation | What pgscope does |
|---|---|
| A 2xx response | delivered; the response body is not read |
| A response with any other status | error "… returned HTTP status …", no retry |
| No response within 3 seconds (connect or response timeout) | wait 5 seconds and retry; at most 4 attempts in total (the first one and 3 retries) |
| An immediate connection error: connection refused, DNS or certificate error | error "could not reach …", no retry |
| A timeout on all 4 attempts | error "could not reach …" |

In the worst case delivery to one channel takes about 27 seconds (4 attempts of 3 seconds plus 3 pauses of 5 seconds); the **Test** button may wait just as long for an answer.

Redirects (3xx) are followed by the standard Go rules: on 301, 302 and 303 the follow-up request is sent as a `GET` without a body, so configure the final URL. Because of retries on timeout, a receiver may get one notification twice if the first attempt was processed but the response was late: respond quickly and handle notifications idempotently.

Email is sent in a single attempt, with no retries, within 30 seconds (see [Email](#email)).

## Webhook format {#webhook}

The format is designed to be compatible with pgDash webhooks. The same JSON is passed to PagerDuty (`custom_details`) and xMatters (`details`).

### Request {#webhook-request}

| Parameter | Value |
|---|---|
| Method | `POST` to the channel URL |
| `Content-Type` | `application/json` |
| `User-Agent` | `pgscope-Webhook/1` |
| `Connection` | `close` (every request uses a new connection) |
| Body | JSON in UTF-8 |
| Authentication | none; the request is not signed |
| Timeout | 3 seconds per attempt, for retries see [Timeouts, retries and errors](#retries) |
| Success | any 2xx status |

Texts inside the JSON are in the channel language. The characters `<`, `>` and `&` in strings are escaped as `<`, `>` and `&` (standard Go behaviour); any JSON parser decodes them. The field order in objects is fixed (the examples below show it as in real requests), but there is no need to rely on it.

### Alerts {#webhook-alerts}

Sent on every change of the set of triggered alerts. The `alerts` field holds **all** currently triggered alerts, not only the new ones; an empty array means all alerts have cleared.

```json
{
  "alerts": [
    {
      "type": "crit",
      "text": "Free disk space less than 15%",
      "value": "9.8%",
      "objname": "pg_default",
      "objlink": "https://pgscope.example.com/#/s/1/tablespaces"
    },
    {
      "type": "warn",
      "text": "Number of backends with transactions open longer than 15 min greater than 0",
      "value": "2",
      "objname": "prod-db-1",
      "objlink": "https://pgscope.example.com/#/s/1/backends"
    },
    {
      "type": "warn",
      "text": "Mean query execution time greater than 1 s",
      "value": "2 s",
      "objname": "select * from orders",
      "objlink": "https://pgscope.example.com/#/s/1/queries/shop/712461705543615171",
      "query": "select * from orders where customer_id = $1"
    }
  ],
  "reported": 1793008773,
  "server": "prod-db-1",
  "version": 1
}
```

| Field | Type | Description |
|---|---|---|
| `version` | number | format version, always `1` |
| `server` | string | the server name in pgscope |
| `reported` | number | time of the report the rules were evaluated against (Unix time, seconds) |
| `alerts` | array | all triggered alerts; empty means all cleared |
| `alerts[].type` | string | `warn` (warning) or `crit` (critical) |
| `alerts[].text` | string | the rule text |
| `alerts[].value` | string | the current value with its unit, for humans; "never" for a table that has never been vacuumed |
| `alerts[].objname` | string | the object name: server, database, `database.schema.table`, tablespace, standby or the first 20 characters of the query text |
| `alerts[].objlink` | string | link to the object in pgscope, built from `PGSCOPE_BASE_URL` |
| `alerts[].query` | string | the query text from the report (pgmetrics truncates it to 500 characters by default); only for **Query** level rules |

Alerts in the array are sorted: critical first, then warnings; within a severity, in a stable order by metric ID and rule, then by object name. `value` is a string with the unit and decimal separator of the channel language; if you need numbers, read them from the report through the [API](api.md).

The "all alerts cleared" notification:

```json
{
  "alerts": [],
  "reported": 1793009073,
  "server": "prod-db-1",
  "version": 1
}
```

### Change alerts {#webhook-changes}

Sent when at least one tracked change is found while comparing a new report with the previous one.

```json
{
  "changes": [
    {
      "item": "Table added",
      "curr": "shop.public.invoices"
    },
    {
      "item": "Size of table “shop.public.orders” changed",
      "prev": "1.2 GiB",
      "curr": "1.9 GiB"
    },
    {
      "item": "Setting “work_mem” changed",
      "prev": "4096",
      "curr": "16384"
    },
    {
      "item": "Server restarted",
      "prev": "2026-10-20T03:12:45Z",
      "curr": "2026-10-26T09:57:02Z"
    }
  ],
  "currreport": 1793008773,
  "prevreport": 1793008473,
  "server": "prod-db-1",
  "version": 1
}
```

| Field | Type | Description |
|---|---|---|
| `version` | number | always `1` |
| `server` | string | the server name |
| `prevreport` | number | time of the previous report (Unix time, seconds) |
| `currreport` | number | time of the new report (Unix time, seconds) |
| `changes[].item` | string | what changed, with the object name if there is one |
| `changes[].prev` | string | the value in the previous report; absent if there was no value (for example, the object was added) |
| `changes[].curr` | string | the value in the new report; absent if the object was removed |

Sizes are human-readable (`1.9 GiB`), the restart time is RFC 3339 in UTC, and the recovery mode is "primary" or "standby". Changes are ordered by their Russian source text, so the order is the same for both languages. The full list of changes and their values is on the [Change alerts](change-alerts.md#change-types) page.

### Test notifications {#webhook-test}

The **Test** button sends the same format with test data to a webhook; `reported`, `prevreport` and `currreport` are set to the current time.

```json
{
  "alerts": [
    {
      "type": "warn",
      "text": "Test alert",
      "value": "1",
      "objname": "prod-db-1",
      "objlink": "https://pgscope.example.com/#/s/1/alerts"
    }
  ],
  "reported": 1793010000,
  "server": "prod-db-1",
  "version": 1
}
```

```json
{
  "changes": [
    {
      "item": "Test change",
      "curr": "test"
    }
  ],
  "currreport": 1793010000,
  "prevreport": 1793010000,
  "server": "prod-db-1",
  "version": 1
}
```

### Example receiver {#webhook-receiver}

A minimal receiver for testing (Go 1.22 or later): it prints the received JSON and responds with `204`.

```go
// A minimal pgscope webhook receiver.
// Run: go run hook.go; channel destination: http://<host>:9000/pgscope-hook
package main

import (
	"io"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("POST /pgscope-hook", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		log.Printf("%s: %s", r.Header.Get("User-Agent"), body)
		w.WriteHeader(http.StatusNoContent) // any 2xx, within 3 seconds
	})
	log.Fatal(http.ListenAndServe(":9000", nil))
}
```

To send it a request by hand:

```bash
curl -sS -X POST http://127.0.0.1:9000/pgscope-hook \
  -H 'Content-Type: application/json' -H 'User-Agent: pgscope-Webhook/1' \
  -d '{"alerts":[],"reported":1793009073,"server":"prod-db-1","version":1}'
```

## Closed networks {#air-gapped}

pgscope itself needs no internet access, but some channels are cloud services:

| Channel | On a closed network |
|---|---|
| **Email** | works through an internal SMTP server or relay |
| **Webhook** | works with any internal receiver |
| **Slack** | cloud Slack is unreachable; a self-hosted messenger with Slack-compatible webhooks may work |
| **PagerDuty** | does not work: the address `events.pagerduty.com` is hard-coded in pgscope |
| **VictorOps**, **xMatters** | work only if the cloud service is reachable from the pgscope network |

The recommended setup for an isolated network: Email through an internal SMTP server for people, and a webhook into an internal system for automation.

If outbound access is only allowed through a proxy, set the `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` variables for the pgscope process: the pgscope HTTP client honours them the standard Go way (they do not apply to email). For receivers with a certificate from an internal certificate authority, add that certificate to the trust store of the host or container (the pgscope image is based on Alpine with the `ca-certificates` package); Go programs also honour the `SSL_CERT_FILE` and `SSL_CERT_DIR` variables.

## Security {#security}

- Channel destinations, including tokens in webhook URLs and PagerDuty keys, are visible to everyone with access to the server: the owner and team members.
- Team members can add channels, including webhooks to arbitrary addresses, and thus receive the content of alerts (object names, query texts). Keep this in mind when sharing a server, see [Owner and member permissions](teams.md#permissions).
- On a delivery error the full channel destination is written to the pgscope log and shown in the on-screen error.
- Webhooks are not signed, and there are no separate credential fields. Protect the receiver yourself: use `https`, a secret token in the URL path or query, and network-level access restrictions. If the destination contains a user name and password (`https://user:password@hooks.internal.example/pgscope`), the Go HTTP client sends them as an `Authorization: Basic …` header — this way you can enable basic authentication on the receiver; these credentials, like the whole destination, are visible to everyone with access to the server.
