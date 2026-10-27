# Team, profile and account

This page describes how to give colleagues access to a server, how invitations work (including without SMTP), how a team member's permissions differ from the owner's, what the server's Team & settings page contains, how to delete a server with all its data, and everything about the Profile page: the API key, language, password change and account deletion.

## Accounts {#accounts}

pgscope has two kinds of accounts:

| Kind | How it is created | API key | Own servers |
|---|---|---|---|
| Regular | sign-up on the **Sign up** page | yes | yes: servers are created by reports sent with this key |
| Team member | accepting an invitation link | no | no: sees only the servers shared with it |

A team member account is marked **Team member account** on the Profile page. Such an account cannot get an API key. If a member also needs servers of their own, they need a separate regular account with a different address (addresses must be unique).

A regular account can also get access to someone else's server: it then has both its own servers and shared ones (marked with the **shared** badge in the server list).

Rules for all accounts:

- sign-up is open to anyone who can open the pgscope page; there is no administrator role — every user sees only their own servers and the ones shared with them. Restrict network access to pgscope, see [Security](security.md);
- the email address is lowercased and must be unique; it is not verified;
- the password is 8 to 72 bytes in UTF-8 (characters for Latin text; a Cyrillic letter takes 2 bytes);
- a session lasts 30 days after sign-in; **Sign out** in the sidebar ends only the current session;
- there is no password reset by email (see [Changing the password](#password)).

## Sharing a server {#sharing}

Access is granted per server. Only the server's owner can share it — the user whose API key sends the server's reports. Access is managed on the server's Team & settings page, in the **Team sharing** card.

### Inviting by email {#invite}

Enter an address in **Invite by email** and click **Invite**. There are two cases:

- **The person already has a pgscope account** with this address. Access is granted immediately, and the person appears in the list marked **member**. If SMTP is configured, they and the owner get the email "pgscope: you now have access to server “…”" with a link to the server.
- **There is no account.** An invitation is created: the address appears in the list marked **invited**. If SMTP is configured, the invitee and the owner get the email "pgscope: invitation to server “…”" with the link. The emails are written in the owner's current UI language.

The invitation link looks like `<PGSCOPE_BASE_URL>/#/invite/<token>`. Only the owner sees it, in the list next to the invitation, and can copy it with the copy button. **Invitations work without SMTP**: if email is not configured, the form shows "SMTP is not configured: copy the invitation link from the list and send it yourself." — pass the link on by any convenient means.

Invitation properties:

- the link is single-use: the invitation is deleted once accepted;
- it does not expire: the link works until it is used or cancelled;
- the account is created strictly for the address in the invitation, and the address is not verified — anyone holding the link can accept the invitation. Send the link over a trusted channel and cancel unused invitations.

You cannot invite yourself: your own address is rejected with "Invalid email address".

### Accepting an invitation {#accept}

The link opens the **Join the team** page with the text "You've been invited to view the server “…”. Set a password for …". The invitee enters a password (8 to 72 bytes, see [Accounts](#accounts)) and clicks **Accept invitation**. pgscope creates a team member account, grants access to the server, signs the user in and shows the server's page.

Possible errors:

- "Invitation not found or already used" — the link has already been used, the invitation was cancelled or the server was deleted;
- "An account with this email address already exists" — the person signed up on their own in the meantime. The invitation is used up in this case; invite them again — for an existing account access is granted immediately.

### Revoking access and cancelling invitations {#revoke}

In the **Team sharing** list the owner sees trash buttons (hovering shows the action name):

- next to a member — **Revoke access**: access disappears immediately, and the member's next request to this server returns "Server not found". The member's account itself is not deleted;
- next to an invitation — **Cancel invitation**: the link stops working.

There is no confirmation; the action takes effect immediately.

## Owner and member permissions {#permissions}

| Action | Owner | Member |
|---|---|---|
| See every server page: metrics, charts, past reports, diagnostics | yes | yes |
| Use the server's AI chat (if enabled) | yes | yes |
| Create and delete alert rules | yes | yes |
| Configure change alerts | yes | yes |
| Add, test and delete notification channels | yes | yes |
| See the list of members | yes | yes |
| See invitations and invitation links | yes | no |
| Invite, revoke access, cancel invitations | yes | no |
| See the reporting command with the owner's API key | yes | no |
| Delete the server and its data | yes | no |
| Send reports for this server | yes (with their API key) | no |

The restrictions are enforced by the server: a member's request for an owner-only action gets a `403` response with "Only the server owner can do this". The top of the **Team sharing** card sums it up: "Team members can view all data, metrics and charts, and can change alert rules and notifications. They cannot delete the server's data or share it further."

> [!WARNING]
> A member sees everything in the reports: query texts, configuration settings, role and object names. They also see notification channel destinations (including tokens in webhook URLs) and can add their own webhook. Share only with people you can trust with this data.

## The Team & settings page {#server-settings}

Open it from the server's sidebar: **Alerting** → **Team & settings** (for Pgpool servers, the **Team & settings** item in their menu). The subtitle shows the server name. The page has up to three cards:

| Card | Who sees it | What it contains |
|---|---|---|
| **Team sharing** | everyone | the owner (marked **owner**), members (**member**), for the owner — invitations (**invited**) with their links; for the owner — the **Invite by email** form, for a member — the line "Shared with you by …" |
| **Reporting command for this server** | owner only | a ready-made pgmetrics and pgdash CLI command (`pgdash -a <key> … report <server name>`) with the owner's API key and the pgscope address |
| **Delete server data** | owner only | deleting the server with all its data |

The reporting command on this page is for a PostgreSQL server. Commands for PgBouncer and Pgpool are on the Profile page; details are in [Sending reports](collect.md).

### Deleting a server and its data {#delete-server}

In the **Delete server data** card, type the server name exactly as written (the field hint reads "type … to confirm") — this enables the **Delete server** button. Deletion is immediate and irreversible; afterwards the server list opens.

Everything related to the server is deleted:

- all stored reports, including this server's PgBouncer reports;
- metric time series;
- alert rules, change alert settings, notification channels;
- the current alert state, the alert history and detected changes;
- member access and unused invitations.

> [!WARNING]
> Deleting a server does not stop collection. If a cron job or a Docker agent keeps sending reports under this name with your key, the server is created again — empty, without rules, channels or members. Stop collection first (see [Sending reports](collect.md) and [Docker and Docker Swarm](docker.md)), then delete the server.

Only the owner can delete a server. A member who no longer needs a server can ask the owner to revoke access or delete their own account.

## Profile {#profile}

The Profile page opens from your email address at the bottom of the sidebar. Under the **Profile** title is your email address, and member accounts carry the mark **Team member account** on the right. The page has these cards:

| Card | For whom | What it does |
|---|---|---|
| **API key** | regular accounts | shows the key, copies it, issues a new one |
| **Sending reports** | regular accounts | ready-made commands for PostgreSQL, PgBouncer and Pgpool, and tips on `pg_stat_statements`, `auto_explain` and AWS RDS |
| **Language** | everyone | the UI language |
| **Change password** | everyone | changing the password |
| **Danger zone** | everyone | deleting the account |

### API key {#api-key}

The API key is a 22-character string (Latin letters and digits). The pgdash CLI (`pgdash -a <key>`) or the Docker agent passes it when sending reports. There is one key per account: every server whose reports are sent with this key belongs to this account, and servers are told apart by name. Details are in [Sending reports](collect.md).

The **Regenerate** button, after the confirmation "Generate a new API key? The current key will stop working immediately.", issues a new key. The old one stops working at once: reports sent with it get a `403` response "Unknown API key", see [Server responses](collect.md#responses). After regenerating, update the key everywhere it is used:

- in cron jobs and scripts with `pgdash -a`;
- in the `pgscope_api_key` secret (or the `PGSCOPE_API_KEY` variable) of the Docker agents, then restart the agents: an agent reads the key only at startup. A Docker Swarm secret cannot be changed in place, and a secret in use cannot be removed: remove the agent stack (`docker stack rm`), recreate the `pgscope_api_key` secret with the new key and deploy the stack again, see [Docker and Docker Swarm](docker.md).

Servers, rules and data do not change when the key is regenerated.

### Language {#language}

The **Русский** / **English** switch in the **Language** card changes the UI language and saves the choice to your profile ("Your language preference is saved to your profile."). On the next sign-in from any browser, the saved language takes precedence over the browser's language. The same switch is at the bottom of the sidebar.

The UI language affects page texts, error messages and the language of the emails sent when inviting someone to a team. It does not affect the language of alert notifications: that is set per channel, see [Notification language](notifications.md#language).

### Changing the password {#password}

In the **Change password** card enter the **Current password** and the **New password** (8 to 72 bytes, see [Accounts](#accounts)) and click **Change password**. On success the page shows "Password changed."; with a wrong current password it shows the error "The current password is incorrect".

Changing the password does not end sessions already open on other devices: they last until their 30 days run out or until sign-out.

pgscope has no password reset by email. If a user forgets their password, an administrator can set a new one directly in the pgscope database (`PGSCOPE_DB`). Passwords are stored as bcrypt hashes; the `pgcrypto` extension can build a compatible hash:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE users SET pwhash = crypt('new-password', gen_salt('bf', 10))
 WHERE email = 'user@example.com';
```

> [!NOTE]
> This is a manual operation that bypasses the UI: run it as the owner of the pgscope database and ask the user to change the password in their profile right away.

### Deleting the account {#delete-account}

The **Delete account** button in the **Danger zone** card deletes the account after a browser confirmation dialog and ends the session. The text next to the button warns what happens: "All your servers and all their data will be deleted along with your account." for a regular account and "Deleting your account won't affect servers shared with you." for a member. What is deleted depends on the account kind:

| Account kind | Confirmation | What is deleted |
|---|---|---|
| Regular | "Delete your account and ALL data of the servers you own? This cannot be undone." | the account, the API key, all sessions, all your servers with all their data (as when [deleting a server](#delete-server)), the records of your Docker agents, your access to other people's servers |
| Team member | "Delete your account?" | the account, all sessions, access to servers; the servers themselves and their data are not affected |

Team members of your servers lose access to them, but their accounts remain. Once a regular account is deleted, its API key no longer works: reports sent with it get `403` "Unknown API key", so the servers are not recreated. Stop the collection jobs so they do not keep sending reports in vain.

> [!WARNING]
> Deleting an account is irreversible. If you need the data, back up the pgscope database first, see [Data storage](data.md).
