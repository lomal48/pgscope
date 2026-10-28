# Docker and Docker Swarm

When PostgreSQL databases run in containers and are reachable only on internal Docker networks, a separate cron job per database is impractical. Instead, **pgscope-agent** is installed on every Docker host. The agent finds the database containers on its own, connects to them over Docker networks, runs pgmetrics and sends the reports to pgscope. pgscope itself never connects to the databases; it only needs incoming HTTP(S) from the agents. The agent needs no external services, so the setup works inside a closed network. This page covers how the agent works, images, container labels, the monitoring role and secrets, networks, installation on a standalone host and in Swarm, environment variables, the **Agents** page, troubleshooting and security.

## How the agent works {#how-it-works}

```text
Docker host or Swarm node
┌──────────────────────────────────────────────────────────────────┐
│  pgscope-agent ──(Docker API, /var/run/docker.sock)──► dockerd   │
│       │ pgmetrics over an internal Docker network                │
│       ▼                                                          │
│  PostgreSQL and PgBouncer containers labeled pgscope.enable=true │
└──────────────────────────────────────────────────────────────────┘
        │ HTTP(S): /api/v1/report, /api/v1/reportpgbouncer, /api/v1/agent
        ▼
     pgscope ──► Agents page, servers, alerts
```

1. Every 30 seconds (`PGSCOPE_AGENT_DISCOVERY_INTERVAL`) the agent asks Docker for running containers that carry all labels from `PGSCOPE_AGENT_LABEL_SELECTOR` (`pgscope.enable=true` by default) and reads their labels.
2. For each target it picks a network the target is reachable on and, if needed, connects its own container to that network, see [Networks](#networks).
3. Each target is collected every 300 seconds (`PGSCOPE_AGENT_INTERVAL`). The first collection of a new target is scheduled at a random moment within the interval, so the databases are not polled all at once. At most 4 collections run at the same time (`PGSCOPE_AGENT_CONCURRENCY`).
4. Before collecting, the agent connects to the `postgres` database (or the first database from the `pgscope.dbs` label, `pgbouncer` for PgBouncer) as the monitoring role with a 10-second timeout. This tells an unreachable database from a wrong password and gives the list of databases the role may connect to. pgmetrics receives this list explicitly: `--all-dbs` mode would abort the whole report at the first database it cannot open.
5. The agent runs pgmetrics (for no longer than `PGSCOPE_AGENT_TIMEOUT`, 120 seconds) and sends the report to pgscope. On a network error or a 5xx response it retries once after 5 seconds.
6. Once a minute the agent sends pgscope a heartbeat about itself and the state of every target. This is what the [**Agents** page](#agents-page) shows.

The agent works only with the containers of its own host, through the local Docker API. That is why in Swarm it runs as a global service: one task per node, each serving the databases of its node.

> [!NOTE]
> The agent connects to the databases over a Docker network, not locally. pgmetrics reads the PostgreSQL log and system metrics only over a local connection, so servers collected by the agent have empty **Logs**, **Execution plans**, **Autovacuum history (from logs)**, **Deadlocks in logs** and **System**, **Overview** has no **Load average** and **Memory** charts, and the **Tablespaces** page shows no disk usage. All other pages work fully. See [Logs, plans and autovacuum history](collect.md#logs).

## Images {#images}

The images are built from the repository root on a machine with internet access:

```bash
docker build -t pgscope:latest .
docker build -f Dockerfile.agent --build-arg VERSION=1.0.0 -t pgscope-agent:latest .
```

- The agent image is based on `alpine:3.22` and contains only `pgscope-agent`, pgmetrics and root certificates. pgmetrics is built from source at exactly the version pgscope uses (per `go.mod`), so the report model matches. The `tools/build-pgmetrics.sh` script builds it with pgscope's fixes (including reading PostgreSQL 13+ `csvlog`); this pgmetrics can also be copied to database hosts, see [pgmetrics built by pgscope](collect.md#pgmetrics-build).
- `VERSION` ends up in the **Agent version** field on the **Agents** page. Without it the version is `dev`.

For a closed network, move the images as files:

```bash
docker save pgscope-agent:latest | gzip > pgscope-agent.tar.gz   # on the machine with internet access
docker load -i pgscope-agent.tar.gz                               # on every Docker host and Swarm node
```

You can also push the image to an internal registry and set its name in the `PGSCOPE_AGENT_IMAGE` variable when starting the agent's compose file or stack (`pgscope-agent:latest` by default). Running pgscope itself in Docker is covered in [Installation and upgrades](install.md).

## Container labels {#labels}

The agent serves only containers that match `PGSCOPE_AGENT_LABEL_SELECTOR` (by default the `pgscope.enable` label with the value exactly `true`). All other labels are optional.

| Label | Default | Purpose |
|---|---|---|
| `pgscope.enable` | — | `true` means the container is served |
| `pgscope.name` | derived automatically | the server name in pgscope (for PgBouncer, the pooler name). Invalid characters are replaced with `-`, the length is cut to 64. The cluster prefix is not added to it |
| `pgscope.port` | `5432` | the PostgreSQL or PgBouncer port inside the container, 1 to 65535 |
| `pgscope.dbs` | all databases the role may access | comma-separated databases, for example `app,billing`. The first one is used for the connection check |
| `pgscope.network` | chosen automatically | the network to connect through: the full name or the short name from a compose project or stack |
| `pgscope.sslmode` | `PGSCOPE_AGENT_SSLMODE` | `sslmode` for this target |
| `pgscope.kind` | `postgres` | `postgres` or `pgbouncer` |
| `pgscope.server` | — | required for `pgbouncer`: the full name of the PostgreSQL server in pgscope that the pooler belongs to |
| `pgscope.user` | `PGSCOPE_AGENT_PGUSER` | a separate role for this target |
| `pgscope.password-file` | the agent's password | a password file for this target: only an agent secret inside `/run/secrets/` |

A label error does not stop the agent: the target gets the **Error** status and is not collected, and **Details** shows the cause:

| Text in **Details** | Cause |
|---|---|
| `invalid pgscope.port label: …` | the port is not a number or outside 1–65535 |
| `invalid database name in the label pgscope.dbs: "…"` | a database name contains `=`, whitespace control characters or `://` |
| `invalid role name in the label pgscope.user: "…"` | the same for the role name |
| `the label pgscope.password-file must name a secret of the agent under /run/secrets/` | the path is not inside `/run/secrets/` or not in canonical form (for example, with `..`) |
| `the label pgscope.password-file names the agent's API key` | the file from the label holds the agent's API key |
| `a pgbouncer container needs the label pgscope.server with the name of its PostgreSQL server` | a PgBouncer has no `pgscope.server`, or the name breaks the rule `A-Z a-z 0-9 _ . -`, up to 64 characters |
| `unknown pgscope.kind label: …` | the value is neither `postgres` nor `pgbouncer` |

Besides its own labels the agent reads Docker's service labels:

| Docker label | Used for |
|---|---|
| `com.docker.compose.project`, `com.docker.compose.service`, `com.docker.compose.container-number` | the server name of Compose containers; the short network name in `pgscope.network` |
| `com.docker.swarm.service.name`, `com.docker.swarm.task.name`, `com.docker.swarm.node.id` | the server name of Swarm tasks |
| `com.docker.stack.namespace` | the short network name in `pgscope.network` for stack services |
| `com.docker.swarm.task.id` | the agent learns that it runs as a Swarm task itself |

Docker Compose example:

```yaml
services:
  db:
    image: postgres:17
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]
    labels:
      pgscope.enable: "true"
    networks: [backend]
networks:
  backend:
    internal: true
```

In a Swarm stack, labels go under the service's `labels:`, **not** under `deploy.labels`: only `labels:` end up on the containers the agent sees.

```yaml
services:
  db:
    image: postgres:17
    labels:
      pgscope.enable: "true"
      pgscope.dbs: "billing"
    networks: [backend]
```

`PGSCOPE_AGENT_LABEL_SELECTOR` is a comma-separated list of Docker filters of the form `key` or `key=value`; a container must match all of them. For example, `pgscope.enable=true,env=prod` serves only databases labeled `env=prod`.

### Server name {#server-names}

Without a `pgscope.name` label the agent derives the name like this:

| Container | Name | With `PGSCOPE_AGENT_CLUSTER=prod` |
|---|---|---|
| Compose: project `shop`, service `db`, first instance | `shop-db` | `prod.shop-db` |
| Compose: third instance of the same service | `shop-db-3` | `prod.shop-db-3` |
| Swarm: replicated service `billing_db`, slot 1 | `billing_db` | `prod.billing_db` |
| Swarm: the same service, slot 2 | `billing_db-2` | `prod.billing_db-2` |
| Swarm: global service `edge_cache` on the node with id `x7y8z9w0…` | `edge_cache-x7y8z9` | `prod.edge_cache-x7y8z9` |
| Any other container | the container name | `prod.` + the container name |
| Label `pgscope.name: orders main` | `orders-main` | `orders-main` (no prefix added) |

- In a stack, the service name already contains the stack name: `<stack>_<service>`. For a global service the suffix is the first 6 characters of the node id.
- Characters outside `A-Z a-z 0-9 _ . -` are replaced with `-`, and the final length is at most 64.
- The name does not change when the container restarts or is recreated. If you rename the project, service or stack, a new server appears in pgscope and the old one stops updating.
- Without `PGSCOPE_AGENT_CLUSTER` names have no prefix. If different hosts run Compose projects with the same names, their reports land in one pgscope server (and some of them get 429). Give every host its own `PGSCOPE_AGENT_CLUSTER`.
- If two containers on one host get the same name, the agent serves the first and skips the second with an entry in its log: `discovery: containers A and B both map to postgres NAME; ignoring B (set the label pgscope.name)`. The second container is not shown on the **Agents** page. Give it a `pgscope.name`.

### PgBouncer in a container {#pgbouncer}

```yaml
services:
  pgbouncer:
    image: registry.example.com/pgbouncer:1.23   # your PgBouncer image
    labels:
      pgscope.enable: "true"
      pgscope.kind: pgbouncer
      pgscope.server: prod.shop-db     # the full PostgreSQL server name in pgscope
      pgscope.port: "6432"
```

- The agent connects to the `pgbouncer` admin database and sends the report as `report-pgbouncer`: the server comes from `pgscope.server`, and the pooler name is derived by the same rules as a server name (with the cluster prefix).
- `pgscope.server` is used as is; the cluster prefix is not added. Give the name exactly as the server appears in pgscope.
- The monitoring role must be in PgBouncer's `stats_users` and pass its authentication, see [PgBouncer](postgres.md#pgbouncer). The `bootstrap-monitor-role.sh` script skips PgBouncer containers.
- PgBouncer can use a separate user. Its password is passed as one more agent secret:

```yaml
# addition to deploy/agent/docker-compose.yml
services:
  agent:
    secrets: [pgscope_api_key, pgscope_monitor_password, bouncer_stats_pw]
secrets:
  bouncer_stats_pw:
    file: ./secrets/bouncer_stats_pw
```

And on the PgBouncer container: the labels `pgscope.user: stats` and `pgscope.password-file: /run/secrets/bouncer_stats_pw`.

## Monitoring role and secrets {#secrets}

All databases of a host use one role, `pgscope_monitor` by default, with `pg_monitor` rights. The agent receives two Docker secrets:

| Secret | Path in the agent container | Contents |
|---|---|---|
| `pgscope_api_key` | `/run/secrets/pgscope_api_key` | the API key from the pgscope **Profile**, 22 characters |
| `pgscope_monitor_password` | `/run/secrets/pgscope_monitor_password` | the password of the `pgscope_monitor` role |

- Trailing line breaks in the files are dropped.
- Instead of files, the values can be passed in the `PGSCOPE_API_KEY` and `PGSCOPE_AGENT_PGPASSWORD` variables: when the variable is set, the file is not read. Files are preferable: variable values are visible in `docker inspect`.
- pgmetrics gets the password only through `PGPASSWORD` in its own environment. `PGSCOPE_*` variables are not passed into the pgmetrics environment.
- In the error texts the agent sends to pgscope the password is replaced with `***`, and the text is cut to 500 bytes.

### The bootstrap-monitor-role.sh script {#bootstrap}

The `deploy/agent/bootstrap-monitor-role.sh` script creates the monitoring role in all labeled containers of a host. Run it on every Docker host and every Swarm node with databases: `docker exec` works only with the containers of its own node.

```bash
cd deploy/agent
./bootstrap-monitor-role.sh --dry-run                       # show what would be done
./bootstrap-monitor-role.sh --password-file secrets/pgscope_monitor_password --with-pg-stat-statements
./bootstrap-monitor-role.sh db-1 db-2                       # only the given containers
```

| Option | Default | Purpose |
|---|---|---|
| `--password-file FILE` | `./secrets/pgscope_monitor_password` | the role password file; not empty, must not contain `$pgscope_pw$` |
| `--role NAME` | `pgscope_monitor` | the role name, only `[a-z_][a-z0-9_]*` |
| `--label KEY=VALUE` | `pgscope.enable=true` | the label that marks the containers |
| `--with-pg-stat-statements` | — | run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` in every database that accepts connections; databases with `=` or `://` in the name are skipped, as the agent does |
| `--dry-run` | — | change nothing, only show the actions (the password file must still exist) |
| `-h`, `--help` | — | help |
| `container…` | all running with the label | container ids or names |

What the script does in each container:

- skips containers with `pgscope.kind=pgbouncer` and standbys (`pg_is_in_recovery()`): the role reaches standbys from the primary;
- creates the role with `LOGIN` and the password from the file, or, if it exists, sets this password; grants it `pg_monitor`;
- with `--with-pg-stat-statements`, creates the extension in all databases and warns if `pg_stat_statements` is not in `shared_preload_libraries`.

The SQL reaches `psql` inside the container on stdin of `docker exec -i`, so the password never shows up in a process list. For its own session the script turns off statement logging (`log_statement`, `log_min_duration_statement`, `log_min_error_statement`) and the tracking of utility statements in `pg_stat_statements` (`pg_stat_statements.track_utility`); otherwise the password would end up in the PostgreSQL log and, through `pg_stat_statements`, in pgscope reports. The script is safe to run again, for example after a password change. If any containers fail, it exits with code 2 and the message `N container(s) failed`.

The script is written for the official `postgres` image: `psql` connects to the `postgres` database over the local socket as `$POSTGRES_USER` (`postgres` by default), which this image trusts without a password. For other images, create the role by hand in `psql` as a superuser:

```sql
CREATE ROLE pgscope_monitor LOGIN;
GRANT pg_monitor TO pgscope_monitor;
\password pgscope_monitor
```

**pg_stat_statements in a container.** The library must be loaded at server start: add `command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]` to the compose file or stack and recreate the container. For several libraries, list them comma-separated. Then run `./bootstrap-monitor-role.sh --with-pg-stat-statements`.

## Networks {#networks}

For each target the agent looks for a path in this order:

1. the network from the `pgscope.network` label (the full name, `<project>_<network>` from Compose or `<stack>_<network>`). If the container is not attached to it, the status is **Unreachable**;
2. a network the agent already shares with the database;
3. if auto-connect is on (`PGSCOPE_AGENT_AUTOCONNECT=true`, the default) and the agent is not a Swarm task, it connects its container to the database's network. User-defined networks are preferred over the default `bridge`;
4. if the agent runs with `network_mode: host` or outside a container, it connects to the container's IP. This works only for bridge networks; overlay networks are not reachable from the host namespace;
5. otherwise the target gets the **Unreachable** status with the reason.

The `ingress`, `docker_gwbridge`, `host` and `none` networks are never used.

- Internal networks (`internal: true`) work: joining them does not change the agent's route to pgscope.
- A network with the `com.docker.network.bridge.enable_icc=false` option blocks traffic between containers; the agent cannot see the database through it.
- An overlay network the agent joins on its own must have been created with `--attachable`.

### Auto-connect on a standalone host {#autoconnect}

Auto-connect needs `POST /networks/{id}/connect`, that is, write access to the Docker API. The agent leaves the networks it joined once no target needs them, and on a clean shutdown (SIGTERM). It keeps the list of these networks inside its container (`/var/tmp/pgscope-agent-joined.json`), so it leaves them on its own even after a crash restart (OOM, `kill -9`, host power loss).

If the agent may not have write access, set `PGSCOPE_AGENT_AUTOCONNECT=false` and list the database networks in the agent's compose file. Keep the `default` network: it is the agent's way to pgscope:

```yaml
# deploy/agent/docker-compose.yml, excerpt
services:
  agent:
    environment:
      PGSCOPE_AGENT_AUTOCONNECT: "false"
    networks: [default, app_backend]
networks:
  app_backend:
    external: true
    name: myapp_backend   # the real network name from docker network ls
```

### Networks in Docker Swarm {#swarm-networks}

A running Swarm task cannot join a network, so in Swarm the agent never joins networks on its own. List every overlay network with databases in `deploy/agent/docker-stack.yml`:

```yaml
services:
  agent:
    networks: [default, billing_backend]
networks:
  default:
  billing_backend:
    external: true
```

Or add the network to the running service: `docker service update --network-add billing_backend pgscope-agent_agent`. The service then restarts all agent tasks. Services do not need `--attachable`.

## Installing on a standalone Docker host {#standalone}

```bash
docker load -i pgscope-agent.tar.gz          # if the host has no registry access
cd deploy/agent
mkdir -p secrets
printf '%s' 'API key'                  > secrets/pgscope_api_key
printf '%s' 'pgscope_monitor password' > secrets/pgscope_monitor_password
chmod 600 secrets/*
echo 'PGSCOPE_URL=https://pgscope.example.com' > .env
./bootstrap-monitor-role.sh --with-pg-stat-statements
docker compose up -d
docker compose logs -f agent
```

- The API key is on **Profile** → **API key**, see [Profile](teams.md#profile).
- `.env` sets only the variables that `deploy/agent/docker-compose.yml` passes to the agent: `PGSCOPE_AGENT_CLUSTER` (for example, `PGSCOPE_AGENT_CLUSTER=dc1-host7`), `PGSCOPE_AGENT_INTERVAL`, `PGSCOPE_AGENT_DISCOVERY_INTERVAL`, `PGSCOPE_AGENT_LABEL_SELECTOR`, `PGSCOPE_AGENT_QUERY_TIMEOUT`, `PGSCOPE_AGENT_AUTOCONNECT`, `PGSCOPE_AGENT_SSLMODE`, `PGSCOPE_AGENT_CONCURRENCY`, `PGSCOPE_AGENT_PGMETRICS_ARGS`, plus the image name `PGSCOPE_AGENT_IMAGE`. Add the other variables from [Agent environment variables](#environment) (`PGSCOPE_AGENT_TIMEOUT`, `PGSCOPE_AGENT_PGUSER`, `SSL_CERT_FILE`, `PGSSLROOTCERT` and so on) to the `environment:` section of the `agent` service in the compose file: values in `.env` that the compose file does not reference never reach the container.
- While there are no agents, the **Agents** page shows instructions and a ready-made compose file with your key and pgscope address filled in.
- If the host is part of a Swarm, `PGSCOPE_AGENT_CLUSTER` is required when running through Compose too.

## Installing in Docker Swarm {#swarm}

On a manager:

```bash
printf '%s' 'API key'                  | docker secret create pgscope_api_key -
printf '%s' 'pgscope_monitor password' | docker secret create pgscope_monitor_password -
# list the overlay networks with databases in deploy/agent/docker-stack.yml, see "Networks in Docker Swarm"
PGSCOPE_URL=https://pgscope.example.com PGSCOPE_AGENT_CLUSTER=prod-swarm \
  docker stack deploy --resolve-image never -c deploy/agent/docker-stack.yml pgscope-agent
```

- `PGSCOPE_AGENT_CLUSTER` is required and must be the same on all nodes of one cluster. Worker nodes cannot read the cluster id, and without a shared name the server names would differ between nodes. Without this variable the agent on a Swarm node exits with an error.
- The service is global: one task per node, limited to 1 CPU and 512 MB of memory, with 64 MB reserved.
- The image must be present on every node: `docker load` on each node or an internal registry. `--resolve-image never` keeps `docker stack deploy` from querying a registry for the image.
- Run `bootstrap-monitor-role.sh` on every node with databases. Give it a file with the same password as the secret, and delete the file afterwards.
- The stack passes the same set of variables to the agent as the compose file; their values come from the environment of the `docker stack deploy` command, like `PGSCOPE_URL` in the example. `PGSCOPE_AGENT_AUTOCONNECT` is always `false` in the stack. Add other variables to the stack's `environment:`.
- Logs: `docker service logs -f pgscope-agent_agent`.

## Agent environment variables {#environment}

| Variable | Default | Purpose |
|---|---|---|
| `PGSCOPE_URL` | — | required: the pgscope base address with `http://` or `https://`, without `/api/v1` |
| `PGSCOPE_API_KEY_FILE` | `/run/secrets/pgscope_api_key` | file with the API key |
| `PGSCOPE_API_KEY` | — | the API key as a value; when set, the file is not read |
| `PGSCOPE_AGENT_CLUSTER` | — | the cluster name: prefix of server names and part of the agent id. Without it there is no prefix, and the Docker host name serves as the cluster. Required on a Swarm node |
| `PGSCOPE_AGENT_INTERVAL` | `300` | collection interval per target: seconds (`300`) or a duration (`5m`), at least 1 second |
| `PGSCOPE_AGENT_DISCOVERY_INTERVAL` | `30` | how often to look for containers, same format |
| `PGSCOPE_AGENT_TIMEOUT` | `120` | limit for one pgmetrics run, same format |
| `PGSCOPE_AGENT_QUERY_TIMEOUT` | `30` | timeout of each pgmetrics query (`-t`), a whole number of seconds. A query that does not finish in time aborts the whole report |
| `PGSCOPE_AGENT_CONCURRENCY` | `4` | how many targets to collect at once, a whole number |
| `PGSCOPE_AGENT_PGUSER` | `pgscope_monitor` | the monitoring role |
| `PGSCOPE_AGENT_PGPASSWORD_FILE` | `/run/secrets/pgscope_monitor_password` | file with the role password |
| `PGSCOPE_AGENT_PGPASSWORD` | — | the password as a value; when set, the file is not read |
| `PGSCOPE_AGENT_SSLMODE` | `prefer` | `sslmode` of the database connections |
| `PGSCOPE_AGENT_PGMETRICS_ARGS` | — | extra pgmetrics flags, for example `--omit=bloat -S`. Split at whitespace, quotes are not supported. Do not pass `--all-dbs` or connection flags here |
| `PGSCOPE_AGENT_AUTOCONNECT` | `true` | join database networks on its own: `true`, `1`, `yes` or `false`, `0`, `no`. Always off in a Swarm task, in `host` mode and outside a container |
| `PGSCOPE_AGENT_LABEL_SELECTOR` | `pgscope.enable=true` | comma-separated Docker label filters; a container must match all of them |
| `PGSCOPE_AGENT_CONTAINER` | detected automatically | id or name of the agent's container if auto-detection fails |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | the Docker API: `unix://…` or `tcp://host:port` (no TLS), for example a socket proxy |
| `PGMETRICS` | `pgmetrics` | path to pgmetrics |
| `SSL_CERT_FILE` | — | PEM file with an internal CA certificate if pgscope's HTTPS is signed by it; mount the file into the agent container |

All other agent environment variables except `PGSCOPE_*` are passed to pgmetrics as is (for example, `PGSSLROOTCERT`). The agent itself sets `PGPASSWORD`, `PGSSLMODE` and `PGCONNECT_TIMEOUT=10` for pgmetrics. pgmetrics sessions show up in `pg_stat_activity` with `application_name=pgmetrics`: pgmetrics always sets it itself, and `PGAPPNAME` does not change that. Only the agent's check session shows up with `application_name=pgscope-agent`.

The compose file and the stack pass only the variables they list into the container, see [Installing on a standalone Docker host](#standalone).

With an invalid value the agent does not start and logs `configuration: …` with the list of all problems, for example `PGSCOPE_AGENT_INTERVAL="5x": expected a duration such as 300s` or `the API key must be 22 letters and digits (see the pgscope profile page)`.

The collection interval must not be shorter than the pgscope server's `PGSCOPE_MIN_REPORT_INTERVAL` (60 seconds by default). Otherwise pgscope answers 429, and the agent skips the report until the next interval, see [Server responses](collect.md#responses).

## The Agents page {#agents-page}

The **Agents** item in the side menu. The page refreshes every 30 seconds. It lists the agents that send heartbeats with your account's API key. Team members have no key of their own, so their list is empty. Each agent has a card headed by the agent id of the form `<cluster>/<host>` (`<cluster>/<node id>` in Swarm).

| Field | What it shows |
|---|---|
| **Cluster** | `PGSCOPE_AGENT_CLUSTER` or, if not set, the Docker host name |
| **Host** | the Docker host name |
| **Mode** | `Swarm` or **standalone host** |
| **Agent version** | the `VERSION` value at image build time |
| **Docker version** | the host's Docker Engine version |
| **Last seen** | when the agent last checked in (heartbeat once a minute) |
| **Collection interval** | `PGSCOPE_AGENT_INTERVAL` |
| **Joining database networks** | **automatic** or **manual** — the effective mode, taking Swarm and `host` mode into account |

The targets table:

| Column | What it shows |
|---|---|
| **Name** | the server name (for PgBouncer, the pooler name and a PgBouncer badge). It links to the server or PgBouncer page once reports have arrived |
| **Container** | the container name; the short id on hover |
| **Image** | the container image |
| **Network** | the network the agent connects through |
| **Address** | IP and port |
| **Status** | the target state, see below |
| **Details** | the text of the last error or the reason it is unreachable |
| **Last successful collection** | when a report last went out successfully; the time of the last attempt on hover |

| Status | Meaning |
|---|---|
| **Working** | the last collection and upload succeeded |
| **Waiting for first collection** | the container was found; its first collection has not come yet |
| **Unreachable** | no path to the database (no shared network, unsuitable network) or no TCP connection: `connection refused`, `no route to host`, `i/o timeout`, `no such host` and the like |
| **Authentication failed** | `password authentication failed`, `no pg_hba.conf entry` or another error with a SQLSTATE of class 28 |
| **Error** | a label error, a pgmetrics failure, or pgscope did not accept the report |

Statuses arrive with the agent's heartbeat, so they lag reality by up to a minute. If an agent stays silent for more than 3 minutes, its card shows **Agent not responding** and a **Remove** button. Removing only deletes the record: if the agent is actually running, it reappears with its next heartbeat. If the agent found no containers at all, the table reads **The agent found no containers labeled pgscope.enable=true**.

## Troubleshooting {#troubleshooting}

| Target status | What to do |
|---|---|
| **Waiting for first collection** | wait up to one collection interval: first runs are spread over the interval |
| **Unreachable** | read the reason in **Details**: add the network to the agent stack or use `--network-add`, set `pgscope.network`, check `pgscope.port` and that PostgreSQL listens on more than `localhost` (`listen_addresses`) |
| **Authentication failed** | run `bootstrap-monitor-role.sh` with the same password file as the agent secret; check that `pg_hba.conf` lets `pgscope_monitor` in from the agent's network; for PgBouncer check `stats_users` and the users file |
| **Error** | read the text in **Details** and find it below |

Common texts in **Details**:

| Text | What to do |
|---|---|
| `canceling statement due to statement timeout` | raise `PGSCOPE_AGENT_QUERY_TIMEOUT` or add `--omit=bloat` / `-S` to `PGSCOPE_AGENT_PGMETRICS_ARGS` |
| `pgmetrics did not finish within 2m0s (PGSCOPE_AGENT_TIMEOUT)` | raise `PGSCOPE_AGENT_TIMEOUT` or reduce the collection volume as above |
| `database "postgres" does not exist` | list the databases in the `pgscope.dbs` label: the first one is used for the connection check |
| `role pgscope_monitor may not connect to any database` | grant the role `CONNECT` on the databases you need |
| `pgscope answered HTTP 429: Reports are being sent too often` | the collection interval is shorter than `PGSCOPE_MIN_REPORT_INTERVAL`, or two sources report under the same name (for example, hosts without `PGSCOPE_AGENT_CLUSTER`) |
| `pgscope answered HTTP 403: Unknown API key` | update the `pgscope_api_key` secret with the key from **Profile** |
| `pgscope answered HTTP 413: The report is larger than … MiB, the limit set by PGSCOPE_MAX_REPORT_MB on the pgscope server` | the report exceeds the pgscope limit: shrink the collection with `--omit=bloat`, `-S` or schema and table filters in `PGSCOPE_AGENT_PGMETRICS_ARGS`, or raise `PGSCOPE_MAX_REPORT_MB` on the pgscope server, see [Rate and size limits](collect.md#limits) |
| `the agent is not on network …; add it to the agent stack …` | Swarm: declare the network in the agent stack, see [Networks in Docker Swarm](#swarm-networks) |
| `overlay network … is not attachable …` | deploy the agent as a Swarm service or recreate the network with `--attachable` |
| `network … blocks traffic between containers (enable_icc=false)` | use another network of the database or set it in `pgscope.network` |
| `the agent is not on network …; declare it in the agent's compose file or set PGSCOPE_AGENT_AUTOCONNECT=true` | auto-connect is off: declare the network in the agent's compose file, see [Auto-connect on a standalone host](#autoconnect) |
| `could not join network …: …` | the agent was not allowed to join the network, for example a socket proxy with `POST=0`: set `PGSCOPE_AGENT_AUTOCONNECT=false` and declare the networks statically |
| `the container is not attached to network "…" from the label pgscope.network` | fix the `pgscope.network` label or attach the database container to that network |
| `overlay network … is not reachable from the host network namespace; …` | an agent in `host` mode or outside a container cannot see overlay networks: run it as a Swarm service on that network |
| `the container has no IP address on a usable network` | the database container is attached only to `host`, `none` or Swarm's service networks: attach it to a bridge or overlay network |
| `pgscope.password-file: open …` | the file from the label was not found: attach that secret to the agent service (`secrets:`) |
| `sending the report: …` | pgscope is unreachable from the agent container: check `PGSCOPE_URL`, DNS and the certificate (`SSL_CERT_FILE`) |

**The agent does not start or keeps restarting.** Look at `docker compose logs agent` or `docker service logs pgscope-agent_agent`:

- `configuration: …` — invalid variables, see [Agent environment variables](#environment). For example, `set PGSCOPE_API_KEY or PGSCOPE_API_KEY_FILE (…)` means the API key secret is not attached, `pgmetrics binary: … (set PGMETRICS)` means pgmetrics was not found;
- `DOCKER_HOST "…": only unix:// and tcp:// are supported` — an unsupported scheme in `DOCKER_HOST`;
- `cannot reach the Docker Engine API at … (mount /var/run/docker.sock or set DOCKER_HOST)` — the Docker socket is not mounted or `DOCKER_HOST` is unreachable;
- `PGSCOPE_AGENT_CLUSTER is required on Swarm nodes` — set the cluster name;
- `ERROR: the Docker daemon refuses API …` — the daemon rejected the Docker API version; report it together with the output of `docker version`.

**The agent is missing from the Agents page.** Check that `PGSCOPE_URL` is reachable from the agent container and that the key in the secret matches the one on **Profile**. With a wrong key the agent logs `ERROR: pgscope rejected the API key (HTTP 403: …); check PGSCOPE_API_KEY` and keeps running. If pgscope's HTTPS is signed by an internal CA, mount the CA certificate and set `SSL_CERT_FILE`.

**A database container is missing from the targets table.** Check that the container is running, that it has the `pgscope.enable` label with the value exactly `true`, and in Swarm that the label is under `labels:`, not `deploy.labels`. If its name clashed with another container's, the agent log has a `both map to` entry; set `pgscope.name`.

**`docker compose down` of a database project reports `Resource is still in use` for its network.** The agent is still attached to the network, so Compose does not remove it. This is harmless: the next `docker compose up` reuses the network, and the agent leaves it once the database is gone.

**`docker compose up` of a database project fails with `error while removing network … has active endpoints`, and the database container stays stopped.** This happens after the network settings in the compose file change: Compose recreates the network while the agent is attached to it. Disconnect the agent and try again:

```bash
docker network disconnect NETWORK AGENT_CONTAINER
docker compose up -d
```

To avoid this, create the database network once with `docker network create` and declare it in the projects as `external: true`; Compose will then never remove it. Alternatively use `PGSCOPE_AGENT_AUTOCONNECT=false` with the networks in the agent's compose file: then stop the agent before changing a network (`docker compose stop agent`) and start it again afterwards (`docker compose up -d --force-recreate agent`).

**The agent's root filesystem is read-only (`read_only: true`).** The agent cannot save the list of networks it joined and says so in its log (`cannot remember the joined networks`). After a crash restart, disconnect it from those networks by hand: `docker network disconnect NETWORK AGENT_CONTAINER`.

## Security {#security}

- **Access to `/var/run/docker.sock` equals root on the host.** That is why the agent runs as root, and the image holds nothing but the agent and pgmetrics. Mounting the socket with `:ro` does not restrict the API.
- **Socket proxy.** Access can be narrowed with [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy). Only `POST=0` gives a real restriction: in this proxy `POST=1` together with `CONTAINERS=1` also allows `POST /containers/create` and `/start`, which is root again. With `POST=0` auto-connect is impossible, so set `PGSCOPE_AGENT_AUTOCONNECT=false` and declare the networks statically. An addition to `deploy/agent/docker-compose.yml` (move the proxy image into the closed network with `docker save` too):

  ```yaml
  services:
    socket-proxy:
      image: tecnativa/docker-socket-proxy:0.3.0
      restart: unless-stopped
      environment: {CONTAINERS: 1, NETWORKS: 1, INFO: 1, POST: 0}
      volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
      networks: [docker-api]
    agent:
      # remove the docker.sock mount from the agent
      environment:
        DOCKER_HOST: tcp://socket-proxy:2375
        PGSCOPE_AGENT_AUTOCONNECT: "false"
      networks: [default, docker-api, billing_backend]
  networks:
    docker-api:
      internal: true
    billing_backend:
      external: true
  ```

- **The role password is presented to every labeled container.** Whoever can start containers with labels on the host can obtain the `pgscope_monitor` password. That is why the role must have no rights beyond `pg_monitor`. The `pgscope.password-file` label reads only files inside `/run/secrets/` in canonical form, that is, the agent's own secrets, not arbitrary files of its container. If such a file holds the agent's API key, the target gets an error: otherwise the key would go to that container as a password.
- **Protection against connection-string injection.** pgmetrics inserts database and role names into its connection string unquoted. The agent therefore rejects names containing `=`, tabs, line breaks and other whitespace control characters, or `://`: such a name could add a connection parameter (for example, another `host` that would receive the password). Databases from `pg_database` with such names are skipped: any user with `CREATEDB` can create a database. pgmetrics receives the connection parameters as flags, not as a URL.
- **Secrets stay out of the environment, arguments and logs** when passed as files. `PGSCOPE_*` variables are not passed into the pgmetrics environment, and the password is masked in the error texts the agent sends.
- **Encryption of database connections.** `sslmode=prefer` encrypts the connection if the server supports TLS, but does not verify the certificate. To verify it, set `PGSCOPE_AGENT_SSLMODE` or the `pgscope.sslmode` label. The agent connects to the container's IP address, so `verify-full` needs that IP address in the server certificate. The CA file can be passed with the standard `PGSSLROOTCERT` variable in the agent's environment: add it to `environment:` and mount the file into the agent container. This scenario has not been tested live.
- **Statement texts.** The `pg_monitor` role sees statement texts in `pg_stat_statements` and `pg_stat_activity`, and they may contain literals with data. They travel to pgscope with the report.

General pgscope security topics are covered in [Security](security.md).

## Limitations and what is not tested {#limitations}

- Agent reports contain no PostgreSQL log and no system metrics: **Logs**, **Execution plans**, **Autovacuum history (from logs)**, **Deadlocks in logs** and **System** stay empty, see [How the agent works](#how-it-works).
- The agent sees only the containers of its own host. Every host and every Swarm node needs its own agent.
- `DOCKER_HOST` supports only `unix://` and `tcp://` without TLS.
- The agent has been tested live on Docker Desktop. **Not tested live:** Docker Swarm, operation through a socket proxy, `network_mode: host`, databases with TLS (`verify-ca`, `verify-full`) and Docker Engine 29. The code covers these cases: for example, the Docker API version is negotiated with the daemon (at most 1.47), because Docker Engine 29.0–29.2 rejects versions below 1.44. If the daemon still refuses, the agent logs `ERROR: the Docker daemon refuses API …`. Before production use in these configurations, try them on a test setup.
