# The interface

This page describes how the pgscope web interface is organized: the side menu and its sections, the server top bar with past reports and the chart range, working with charts and tables, the language, the color theme, page addresses and the documentation section itself.

## Overall layout {#layout}

The interface is a single-page application. The side menu is on the left and the selected page is on the right. When a server is open, the server top bar is pinned above the content (see [Server top bar](#server-bar)).

Server pages are built from pgmetrics reports: every report is a snapshot of PostgreSQL at the moment it was collected. Charts are built from time series that pgscope extracts from every report it accepts. Everything pgscope shows therefore reflects the state at the time of the latest (or the selected) report, not the current second.

## Side menu {#sidebar}

The top of the menu always has three items:

| Item | Opens |
|---|---|
| **Servers** | all your servers and the servers shared with you — see [Servers and Inspector](fleet.md#servers) |
| **Inspector** | fleet-wide tables across all servers — see [Inspector](fleet.md#inspector) |
| **Agents** | collection agents in Docker and Docker Swarm and the state of their targets — see [the Agents page](docker.md#agents-page) |

When a server is open, a server switcher and the sections of that server appear below these items.

### Server switcher {#server-switcher}

A drop-down list of all servers you can access. Pgpool servers have a `(pgpool)` suffix. Picking a server opens its **Overview** page; if a past moment is selected in the top bar, the other server opens at the same moment (see [Viewing a past report](#report-picker)). The interface reloads the server list once a minute, so a new server appears in the switcher at most a minute after its first report (or immediately after a page reload).

### PostgreSQL server sections {#server-sections}

| Group | Items | Documentation |
|---|---|---|
| **Monitor** | **Overview**, **Diagnostics**, **AI chat** | [Overview](monitoring.md#overview), [Diagnostics](monitoring.md#diagnostics), [AI chat](monitoring.md#ai-chat) |
| **Activity** | **Queries**, **Backends**, **Locks** | [Queries](activity.md#queries), [Backends](activity.md#backends), [Locks](activity.md#locks) |
| **Objects** | **Databases**, **Tables**, **Indexes**, **Index management**, **Top-k**, **Tablespaces**, **Extensions & more**, **Roles** | [Database objects](objects.md) |
| **Server** | **Replication**, **WAL & checkpoints**, **Vacuum**, **Configuration**, **System**, **Logs** | [Replication, WAL, vacuum and system](server.md) |
| **Integrations** | **Cloud metrics**, **PgBouncer** | [Cloud metrics](integrations.md#cloud), [PgBouncer](integrations.md#pgbouncer) |
| **Alerting** | **Alerts**, **Change alerts**, **Team & settings** | [Alert rules](alerts.md), [Change alerts](change-alerts.md), [Team & settings](teams.md#server-settings) |

The **Integrations** group appears only when there is data for it:

- **Cloud metrics** — when the server's latest report contains AWS RDS / Aurora or Azure metrics;
- **PgBouncer** — after the first PgBouncer report has been sent for this server.

### Pgpool server sections {#pgpool-sections}

A Pgpool server has a shorter menu: a single **Pgpool** group with **Overview** (the Pgpool dashboard, see [Pgpool](integrations.md#pgpool)) and **Team & settings**. The other pages do not apply to Pgpool.

### Bottom of the menu {#sidebar-bottom}

| Element | Action |
|---|---|
| **Documentation** | opens the built-in documentation (see [Documentation and help](#docs)) |
| your email | opens the **Profile** page — API key, language, password change, account deletion (see [Profile](teams.md#profile)) |
| **Dark theme** / **Light theme** | switches the color theme (see [Color theme](#theme)) |
| **Русский** / **English** | switches the interface language and saves the choice to your profile (see [Interface language](#language)) |
| **Sign out** | ends the session and returns to the sign-in page |

A session lasts 30 days from sign-in. When it expires, the interface shows the sign-in page on its next request to the server. Changing the password in the profile ends all other sessions of the account, in other browsers and on other devices; the session that changed the password stays signed in (see [Changing the password](teams.md#password)).

### Mobile layout {#mobile}

On narrow screens (below 1024 pixels) the side menu is hidden. A bar with a menu button and the logo appears at the top of the screen. The button opens the menu over the page; it closes when you navigate to another page, press the button again or tap the dimmed area.

## Server top bar {#server-bar}

The bar is pinned above every server page and contains, from left to right: the freshness indicator and server name, report navigation (the **‹** and **›** buttons, a button with the time of the displayed report and, while a past moment is selected, the **Latest** button), the chart range buttons, the refresh button, the AI chat button and the help button. On a narrow screen the bar takes three rows: the server name, report navigation, the other buttons.

### Report freshness {#freshness}

Next to the server name there is a colored dot and a caption such as **reported 3 min ago**. The dot and the caption always refer to the server's latest report, not to the displayed one: while a past moment is selected, the caption reads **latest report 3 min ago**. Hovering over the caption shows the exact date and time of the latest report.

| Dot color | Meaning |
|---|---|
| green | the server's latest report is at most 15 minutes old |
| yellow | the latest report is more than 15 minutes old — the caption turns yellow too |
| gray | the server has not sent a report yet |

A yellow dot means new reports are not arriving: check the cron job, the agent or the collector's log (see [Sending reports](collect.md) and [Troubleshooting](troubleshooting.md)).

### Viewing a past report {#report-picker}

Report navigation lets you look at the server in the past: which queries, backends, locks, settings and diagnostics results there were at the moment of a particular report. The selected moment is kept in the page address (`?at=`), so you can send it as a link (see [Page addresses](#urls)).

- **‹ and ›** open the previous and the next report. The button tooltip shows the time of the neighbouring report and the distance to it, which makes gaps in reporting visible.
- **The time button** shows the time of the report on screen and opens the **Go to a moment** dialog:
  - the **Date and time** field is in the [UI time zone](#time-zone): the nearest report at or before that minute opens; the earliest stored report is named below the field;
  - the **−24h**, **−1h**, **+1h** and **+24h** buttons shift the moment from the displayed report; a result in the future opens the latest report;
  - **Link to this report** is the address of the current page with the moment of the displayed report (even when the latest report is displayed); the copy button is there only over HTTPS or on `localhost`, otherwise select the address and copy it by hand;
  - the **Use the [ and ] keys to move between reports** checkbox turns the keyboard shortcuts on and off (the choice is remembered in the browser).
- **Keys.** `[` and `]` open the previous and the next report, `Shift+[` and `Shift+]` the report an hour earlier or later than the displayed one. The keys do nothing while the cursor is in an input field or the **Go to a moment** dialog is open, or together with Ctrl, Cmd or Alt (Cmd+[ on macOS stays the browser's Back). If the shortcuts get in the way, turn them off with the checkbox in the **Go to a moment** dialog.
- **Clicking a chart with the mouse** opens the report of that moment (see [Using a chart](#chart-interaction)).
- While a past moment is selected, a colored line runs along the top edge of the bar, the time button is highlighted and automatic refresh is off. This stays so even when the selected report turns out to be the newest one, which lets you freeze the page while you study it. Reports that arrive meanwhile become reachable with **›** after you press **Refresh**.
- **Latest** returns to the latest report and automatic refresh.
- If there is no report at the selected moment, the nearest earlier one is shown, and when it is more than 15 minutes earlier a warning below the bar says **No report at …. Showing the nearest earlier one …**. Such a gap in reports is often the incident itself.
- History depth is limited by the raw report retention `PGSCOPE_REPORT_RETENTION_DAYS` (14 days by default, `0` keeps reports forever; the latest report is always kept) — see [Data storage](data.md#retention). For a moment before the earliest stored report the time button turns yellow, pages built from a report show **No report at this moment** with the **Earliest report** and **Latest report** buttons, and the **›** button opens the earliest stored report. This happens, for example, with **Open report** on an old event in the alert history: events are kept longer than reports.
- The selected moment is kept while you move between pages of the same server and when you switch to another server in the sidebar, which helps to compare a primary and a replica at the time of an incident. Server cards on the **Servers** page and links in notifications open the latest report.
- The browser's Back and Forward buttons work with moments: going to another moment (through the dialog, a chart click, **Latest**) adds a history step, while **‹**, **›** and the keys replace the current step once a past moment is selected, so Back after a series of steps returns to where you started. If you remove `?at=` from the address by hand, the moment is kept; press **Latest** to return to current data.

> [!NOTE]
> Not everything on a server page follows the selected report. The list of triggered alerts (the **Active alerts** card, labelled **Current state, not as of the report**, and the **Alerts** counter on the **Overview**, the **Triggered** tab of the **Alerts** page) always shows the current state, and the AI chat always answers from the latest report.

### Chart range and refresh {#ranges}

The **1h**, **6h**, **24h**, **7d** and **30d** buttons set the period that all charts on server pages cover. The default is 6 hours. The choice is remembered in the browser and applies to all servers.

A range longer than 30 days cannot be selected. Time-series retention is set by `PGSCOPE_METRICS_RETENTION_DAYS` (90 days by default, `0` keeps them forever).

While the latest report is displayed, the server page re-reads the report and the charts once a minute. The **Refresh** button (circular arrow icon) does it immediately.

### AI and help buttons {#bar-buttons}

- The **Ask AI** button (robot icon) opens the [AI chat](monitoring.md#ai-chat) for this server.
- The **Help** button (question mark icon) opens the documentation section for the current page. For example, on the **Locks** page it leads to [Locks](activity.md#locks), and on the pages of a Pgpool server to [Pgpool](integrations.md#pgpool).

## Charts {#charts}

Charts on server pages are built from the time series pgscope stores from every report. Each chart has a title and sometimes a note (for example, **per interval between reports**); below the chart is a legend with series names and values.

### How values are computed {#chart-values}

Most PostgreSQL counters are cumulative (they grow from the last statistics reset), so charts show values derived from the counters rather than the counters themselves:

| Series type | How it is computed | Examples |
|---|---|---|
| value | the value from the report as is | number of backends, database size, memory |
| rate | difference between neighboring reports divided by the time between them; per second unless the label says otherwise | transactions, rows, WAL generation, temp file writes |
| ratio | ratio of the increments of two counters over the interval | mean query execution time = increase in total time / increase in calls |
| hit ratio | 100 × increase in hits / (increase in hits + increase in reads) | cache hit ratio |

Ratios are computed over the interval between neighboring reports, not over all time. So, for example, the cache hit ratio on a chart can differ noticeably from the cumulative ratio in the **Cache hit ratio** card on the **Overview**.

Values are labeled in readable units: bytes (KiB, MiB, GiB), bytes per second, operations per second, per minute or per hour (the unit is shown in the axis labels), percentages, durations. The value axis starts at zero.

### Using a chart {#chart-interaction}

- **Hovering.** A vertical line with points on the series appears over the chart, and the legend below the chart shows the time and the values of all series at that moment. There is no separate pop-up tooltip — values are shown in the legend.
- **Without hovering** the legend shows the last known value of each series, and while a past report is selected, the value at the time of that report.
- **A past report on the chart.** While a past moment is selected, the chart period is built around it (the moment is near the middle; if it is closer to the current time than half the period, the chart ends at the current time), and the time of the displayed report is marked with a dashed vertical line.
- **Clicking a chart with the mouse** opens the report of that moment: all server pages show the state at that time (see [Viewing a past report](#report-picker)). A tap on a touch screen only shows the values.
- **Clicking a series in the legend** hides it or shows it again.
- **Ctrl+click (Cmd+click on macOS) on a series in the legend** leaves only that series on the chart; another such click shows all series.
- Zooming by selecting with the mouse is not supported: to see a longer or shorter period, switch the range in the top bar.
- Time axis labels depend on the range: for ranges up to 24 hours only the time, for **7d** and **30d** the date and time or only the date. The axis and the legend show times in the [UI time zone](#time-zone), and axis ticks are aligned to the hours and days of that zone.

### Gaps and empty charts {#chart-gaps}

A break in a line means there is no value for that moment:

- no report arrived at that time;
- a counter went down (statistics reset, crash restart of the server) — the rate is not computed for that interval;
- pgmetrics could not read the value (for example, a table size because of a lock timeout) — such points are skipped rather than drawn as zero;
- the object was not in the report (for example, a query was not among those collected by pgmetrics).

If the selected range has fewer than two points, the chart is replaced by **Not enough data in this range yet**. Rate charts need at least two reports, so charts are empty right after a server is connected.

## Tables {#tables}

Tables work the same way throughout the interface:

- **Sorting.** Clicking a column header sorts by that column (the first click sorts in descending order); another click reverses the direction. The current sort column is marked with an arrow. The whole filtered list is sorted, not only the current page. Rows whose value is unknown (for example **n/a**, or "—" for a standby lag) go to the end in either direction.
- **Filter.** If there is a **Filter…** field above the table, it keeps the rows that contain the entered text, case-insensitively. Which fields the filter searches depends on the table (for example, on the **Queries** page it searches the query text, the user and the database).
- **Additional filters.** Drop-downs and checkboxes next to the filter field (database, user, state and so on) narrow the list by a specific attribute.
- **Row counter.** If the table has a filter above it, the number of rows after filtering is shown to its right.
- **Opening an object.** If rows are clickable (they are highlighted on hover), a click opens the detail page of the object: a database, table, index, query or server.
- **Pages.** When there are more rows than fit on a page (usually 50; 10, 15 or 100 in some tables), page buttons and a **Page N of M** caption appear below the table. Typing in the **Filter…** field returns to the first page.
- **Highlighting.** Values above thresholds are highlighted in yellow (warning) or red (critical); problem rows (for example, backends waiting for a lock) are tinted as a whole. Highlighting is a visual hint, not an alert: to get notified, set up [alert rules](alerts.md).

There is no table export (CSV or similar) in the interface. Query texts and SQL commands in code blocks can be copied with the **Copy** button.

## Interface language {#language}

The interface is available in Russian and English. The **Русский** / **English** switch is at the bottom of the side menu, on the profile page (the **Language** card), on the sign-in and sign-up pages and in the documentation header. The language changes immediately, without a reload; number, date and unit formats change with it (for example, "1,5 ГиБ" and "1.5 GiB").

How the language is chosen:

1. Before sign-in — the language chosen earlier in this browser, or, if there was no choice, the browser language: Russian for a Russian-language browser, English otherwise.
2. After sign-in the language saved in your profile takes precedence over the browser's.
3. A choice made in the side menu, on the profile page or in the documentation header (when signed in) is saved to your user profile and applies on any device after sign-in. A choice made on the sign-in page is saved only in the browser.

Texts produced by the pgscope server also come in the interface language: diagnostics and configuration check results, texts of triggered alerts, error messages and AI chat answers. Every team member therefore sees them in their own language.

The language of notifications (email, webhooks and other channels) is set separately for each channel — see [Notification channels](notifications.md). Sharing and invitation emails are sent in the language of the user who grants access.

## Time zone {#time-zone}

Dates and times in the interface — in tables, report navigation, the alert history and on charts — are shown in one time zone. By default it is the browser's zone. Another zone is chosen on the profile page, in the **Time zone** card (see [Time zone](teams.md#time-zone)). The choice applies at once, without a reload, is saved to your profile and applies on any device after sign-in. Before sign-in the browser's zone is used.

The zone changes only how times are shown and how the **Date and time** field in the **Go to a moment** dialog is read: the chart range and the report age do not depend on it. The moment in a link (`?at=`) is in UTC, so the link opens the same report for a colleague in another zone. Date formats follow the [interface language](#language).

A few texts composed by the pgscope server do not depend on the zone and give times in UTC, marked as such: entry times in the **Deadlocks in logs** item on the **Health issues** tab of the **Diagnostics** page (see [Locks](checks.md#diag-locks)) and the start time in the **Server restart** change in the change history (see [Change alerts](change-alerts.md#change-types)). The AI chat gets the report and server start times in UTC and may give them in UTC in its answers. The texts of alert notifications do not depend on the zone either.

## Color theme {#theme}

pgscope supports light and dark themes. On first visit the theme follows the operating system setting. The **Dark theme** / **Light theme** button at the bottom of the side menu (and the moon or sun button in the documentation header) switches the theme; the choice is remembered in the browser, not in the profile, so you need to choose it again on another device or browser. Charts are redrawn in the colors of the selected theme.

## Page addresses {#urls}

The address of every page is kept in the URL fragment after `#`, so you can copy a link from the address bar and send it to a colleague or paste it into a ticket.

| Address | Page |
|---|---|
| `#/` | **Servers** |
| `#/inspector` | **Inspector** |
| `#/agents` | **Agents** |
| `#/profile` | **Profile** |
| `#/s/<id>` | **Overview** of the server with ID `<id>` |
| `#/s/<id>/<section>` | a server section: `diagnostics`, `chat`, `queries`, `backends`, `locks`, `databases`, `tables`, `indexes`, `index-management`, `topk`, `tablespaces`, `objects`, `roles`, `replication`, `wal`, `vacuum`, `config`, `system`, `logs`, `cloud`, `pgbouncer`, `alerts`, `change-alerts`, `settings` |
| `#/s/<id>/queries/<database>/<queryid>` | a single query page |
| `#/s/<id>/databases/<database>` | a database page |
| `#/s/<id>/tables/<database>/<schema>/<table>` | a table page |
| `#/s/<id>/indexes/<database>/<schema>/<index>` | an index page |
| `#/s/<id>/<section>?at=<time>` | any server page as of `<time>`: UTC in ISO 8601, for example `2026-10-27T00:12:57Z`; Unix time in seconds is accepted too. The nearest report at or before that moment opens; a time in the future or an invalid value means the latest report |
| `#/docs/<page>/<section>` | a documentation section |

Example: `http://monitor:8080/#/s/3/locks` opens the **Locks** page of the server with ID 3.

What to keep in mind about links:

- The recipient must have access to the server (be its owner or a team member, see [Team, profile and account](teams.md)). Otherwise they see **Server not found**, also when they have no servers at all. If the server list fails to load, the error is shown instead.
- If the recipient is not signed in, the sign-in page opens; after sign-in the same link opens.
- The selected past moment is part of the link (`?at=`), the chart range is not: it comes from the recipient's browser. To show a colleague the moment of an incident, send the **Link to this report** from the **Go to a moment** dialog.

## Documentation and help {#docs}

The documentation is built into pgscope and is available through the **Documentation** link at the bottom of the side menu and on the sign-in and sign-up pages. It opens without signing in and needs no internet access: the pages are part of the application.

What the documentation section offers:

- **Navigation.** Groups and pages are on the left; **Previous** and **Next** links are at the bottom of each page. On wide screens an **On this page** table of contents is shown on the right.
- **Search.** The **Search the docs** field searches section titles and text (all entered words must match). Ctrl+K (Cmd+K on macOS) or the `/` key moves the cursor into the search field, Enter opens the first result, Esc clears the field.
- **Section links.** Section headings have a `#` icon — a link to that section of the form `#/docs/<page>/<section>`. Section links do not change when you switch the language.
- **Copying examples.** Every code block has a **Copy** button.
- **Language and theme.** The documentation header has a language switch and a theme button. The documentation is shown in the interface language; if a page has not been translated yet, the Russian version is shown.
- **Going back.** The **Open the app** button (or **Sign in** if you are not signed in) returns to the interface.

Context help:

- on the **Servers**, **Inspector**, **Agents** and **Profile** pages there is a **Help** question mark icon next to the title;
- on server pages the **Help** button is in the top bar (see [AI and help buttons](#bar-buttons)).

Both lead straight to the relevant documentation section.
