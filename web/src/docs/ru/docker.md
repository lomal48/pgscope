# Docker и Docker Swarm

Если базы PostgreSQL работают в контейнерах и доступны только во внутренних сетях Docker, отдельное задание cron на каждую базу неудобно. Вместо этого на каждый Docker-хост ставится **pgscope-agent**. Агент сам находит контейнеры с базами, подключается к ним по сетям Docker, запускает pgmetrics и отправляет отчёты в pgscope. Сам pgscope к базам не подключается, ему нужен только входящий HTTP(S) от агентов. Внешние сервисы агенту не нужны, поэтому схема работает в закрытом контуре. На этой странице описаны устройство агента, образы, метки контейнеров, роль мониторинга и секреты, сети, установка на отдельный хост и в Swarm, переменные окружения, страница «Агенты», решение проблем и безопасность.

## Как работает агент {#how-it-works}

```text
Docker-хост или узел Swarm
┌──────────────────────────────────────────────────────────────────┐
│  pgscope-agent ──(Docker API, /var/run/docker.sock)──► dockerd   │
│       │ pgmetrics по внутренней сети Docker                      │
│       ▼                                                          │
│  контейнеры PostgreSQL и PgBouncer с меткой pgscope.enable=true  │
└──────────────────────────────────────────────────────────────────┘
        │ HTTP(S): /api/v1/report, /api/v1/reportpgbouncer, /api/v1/agent
        ▼
     pgscope ──► страница «Агенты», серверы, оповещения
```

1. Каждые 30 секунд (`PGSCOPE_AGENT_DISCOVERY_INTERVAL`) агент запрашивает у Docker запущенные контейнеры, у которых есть все метки из `PGSCOPE_AGENT_LABEL_SELECTOR` (по умолчанию `pgscope.enable=true`), и читает их метки.
2. Для каждой цели он выбирает сеть, через которую её видно, и при необходимости подключает к этой сети свой контейнер, см. [Сети](#networks).
3. Каждая цель собирается раз в 300 секунд (`PGSCOPE_AGENT_INTERVAL`). Первый сбор новой цели назначается на случайный момент внутри интервала, чтобы базы не опрашивались одновременно. Одновременно идёт не больше 4 сборов (`PGSCOPE_AGENT_CONCURRENCY`).
4. Перед сбором агент подключается к базе `postgres` (или к первой базе из метки `pgscope.dbs`, у PgBouncer — к `pgbouncer`) под ролью мониторинга с таймаутом 10 секунд. Так он отличает недоступную базу от неверного пароля и получает список баз, к которым роль может подключиться. pgmetrics получает этот список явно: режим `--all-dbs` прервал бы весь отчёт на первой базе, к которой подключиться нельзя.
5. Агент запускает pgmetrics (не дольше `PGSCOPE_AGENT_TIMEOUT`, 120 секунд) и отправляет отчёт в pgscope. При сетевой ошибке или ответе 5xx он повторяет отправку один раз через 5 секунд.
6. Раз в минуту агент отправляет pgscope сигнал о себе и о состоянии каждой цели. Это видно на странице [«Агенты»](#agents-page).

Агент работает только с контейнерами своего хоста через локальный Docker API. Поэтому в Swarm он запускается глобальным сервисом: по одной задаче на каждом узле, каждая обслуживает базы своего узла.

> [!NOTE]
> Агент подключается к базам по сети Docker, а не локально. pgmetrics читает журнал PostgreSQL и системные метрики только при локальном подключении, поэтому у серверов, собранных агентом, пусты «Журнал», «Планы выполнения», «История autovacuum (из журнала)», «Взаимоблокировки в журнале» и «Система», на «Обзоре» нет графиков «Средняя нагрузка» и «Память», а на странице «Табличные пространства» — заполнения дисков. Остальные страницы работают полностью. Подробнее — в разделе [Логи, планы и история autovacuum](collect.md#logs).

## Образы {#images}

Образы собираются из корня репозитория на машине с доступом в интернет:

```bash
docker build -t pgscope:latest .
docker build -f Dockerfile.agent --build-arg VERSION=1.0.0 -t pgscope-agent:latest .
```

- Образ агента основан на `alpine:3.22` и содержит только `pgscope-agent`, pgmetrics и корневые сертификаты. pgmetrics собирается из исходников ровно той версии, которую использует pgscope (по `go.mod`), поэтому модель отчёта совпадает. Собирает его скрипт `tools/build-pgmetrics.sh` с исправлениями pgscope (в том числе чтением `csvlog` PostgreSQL 13+); этот pgmetrics можно скопировать и на хосты баз данных, см. [pgmetrics из сборки pgscope](collect.md#pgmetrics-build).
- `VERSION` попадает в поле «Версия агента» карточки агента на странице «Агенты». Без него версия — `dev`.

Для закрытого контура перенесите образы файлами:

```bash
docker save pgscope-agent:latest | gzip > pgscope-agent.tar.gz   # на машине с интернетом
docker load -i pgscope-agent.tar.gz                               # на каждом Docker-хосте и узле Swarm
```

Можно положить образ во внутренний registry и указать его имя в переменной `PGSCOPE_AGENT_IMAGE` при запуске compose-файла или стека агента (по умолчанию `pgscope-agent:latest`). Запуск самого pgscope в Docker описан в разделе [Установка и обновление](install.md).

## Метки контейнеров {#labels}

Агент обслуживает только контейнеры, подходящие под `PGSCOPE_AGENT_LABEL_SELECTOR` (по умолчанию нужна метка `pgscope.enable` со значением ровно `true`). Остальные метки необязательны.

| Метка | По умолчанию | Назначение |
|---|---|---|
| `pgscope.enable` | — | `true` — контейнер обслуживается |
| `pgscope.name` | строится автоматически | имя сервера (для PgBouncer — имя пулера) в pgscope. Недопустимые символы заменяются на `-`, длина обрезается до 64. Префикс кластера к нему не добавляется |
| `pgscope.port` | `5432` | порт PostgreSQL или PgBouncer внутри контейнера, от 1 до 65535 |
| `pgscope.dbs` | все базы, доступные роли | базы через запятую, например `app,billing`. Первая используется для проверки подключения |
| `pgscope.network` | выбирается автоматически | сеть для подключения: полное имя или короткое имя из compose-проекта или стека |
| `pgscope.sslmode` | `PGSCOPE_AGENT_SSLMODE` | `sslmode` для этой цели |
| `pgscope.kind` | `postgres` | `postgres` или `pgbouncer` |
| `pgscope.server` | — | для `pgbouncer` обязательна: полное имя сервера PostgreSQL в pgscope, к которому относится пулер |
| `pgscope.user` | `PGSCOPE_AGENT_PGUSER` | своя роль для этой цели |
| `pgscope.password-file` | пароль агента | файл с паролем для этой цели: только секрет агента внутри `/run/secrets/` |

Ошибка в метках не останавливает агента: цель получает статус «Ошибка» и не собирается, а в колонке «Подробности» видна причина:

| Текст в «Подробности» | Причина |
|---|---|
| `invalid pgscope.port label: …` | порт не число или вне диапазона 1–65535 |
| `invalid database name in the label pgscope.dbs: "…"` | имя базы содержит `=`, пробельные управляющие символы или `://` |
| `invalid role name in the label pgscope.user: "…"` | то же для имени роли |
| `the label pgscope.password-file must name a secret of the agent under /run/secrets/` | путь не внутри `/run/secrets/` или не в канонической форме (например, с `..`) |
| `a pgbouncer container needs the label pgscope.server with the name of its PostgreSQL server` | у PgBouncer нет `pgscope.server` или имя не подходит под правило `A-Z a-z 0-9 _ . -`, до 64 символов |
| `unknown pgscope.kind label: …` | значение не `postgres` и не `pgbouncer` |

Кроме своих меток агент читает служебные метки Docker:

| Метка Docker | Для чего |
|---|---|
| `com.docker.compose.project`, `com.docker.compose.service`, `com.docker.compose.container-number` | имя сервера у контейнеров Compose; короткое имя сети в `pgscope.network` |
| `com.docker.swarm.service.name`, `com.docker.swarm.task.name`, `com.docker.swarm.node.id` | имя сервера у задач Swarm |
| `com.docker.stack.namespace` | короткое имя сети в `pgscope.network` у сервисов стека |
| `com.docker.swarm.task.id` | агент узнаёт, что сам запущен задачей Swarm |

Пример для Docker Compose:

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

В стеке Swarm метки пишутся в `labels:` сервиса, а **не** в `deploy.labels`: только метки из `labels:` попадают на контейнеры, которые видит агент.

```yaml
services:
  db:
    image: postgres:17
    labels:
      pgscope.enable: "true"
      pgscope.dbs: "billing"
    networks: [backend]
```

`PGSCOPE_AGENT_LABEL_SELECTOR` — это список фильтров Docker через запятую вида `ключ` или `ключ=значение`, контейнер должен подходить под все. Например, `pgscope.enable=true,env=prod` обслуживает только базы с меткой `env=prod`.

### Имя сервера {#server-names}

Если метки `pgscope.name` нет, агент строит имя так:

| Контейнер | Имя | С `PGSCOPE_AGENT_CLUSTER=prod` |
|---|---|---|
| Compose: проект `shop`, сервис `db`, первый экземпляр | `shop-db` | `prod.shop-db` |
| Compose: третий экземпляр того же сервиса | `shop-db-3` | `prod.shop-db-3` |
| Swarm: реплицируемый сервис `billing_db`, слот 1 | `billing_db` | `prod.billing_db` |
| Swarm: тот же сервис, слот 2 | `billing_db-2` | `prod.billing_db-2` |
| Swarm: глобальный сервис `edge_cache` на узле с id `x7y8z9w0…` | `edge_cache-x7y8z9` | `prod.edge_cache-x7y8z9` |
| Любой другой контейнер | имя контейнера | `prod.` + имя контейнера |
| Метка `pgscope.name: orders main` | `orders-main` | `orders-main` (префикс не добавляется) |

- В стеке имя сервиса уже содержит имя стека: `<стек>_<сервис>`. У глобального сервиса суффикс — первые 6 символов id узла.
- Символы вне `A-Z a-z 0-9 _ . -` заменяются на `-`, итоговая длина — не больше 64.
- Имя не меняется при перезапуске и пересоздании контейнера. Если переименовать проект, сервис или стек, в pgscope появится новый сервер, а старый перестанет обновляться.
- Без `PGSCOPE_AGENT_CLUSTER` имена строятся без префикса. Если на разных хостах есть проекты Compose с одинаковыми именами, их отчёты попадут в один сервер pgscope (и часть из них получит 429). Задайте каждому хосту свой `PGSCOPE_AGENT_CLUSTER`.
- Если два контейнера одного хоста получают одно имя, агент обслуживает первый, а второй пропускает с записью в своём журнале: `discovery: containers A and B both map to postgres NAME; ignoring B (set the label pgscope.name)`. На странице «Агенты» второй контейнер не показывается. Задайте ему `pgscope.name`.

### PgBouncer в контейнере {#pgbouncer}

```yaml
services:
  pgbouncer:
    image: registry.example.com/pgbouncer:1.23   # ваш образ PgBouncer
    labels:
      pgscope.enable: "true"
      pgscope.kind: pgbouncer
      pgscope.server: prod.shop-db     # полное имя сервера PostgreSQL в pgscope
      pgscope.port: "6432"
```

- Агент подключается к служебной базе `pgbouncer` и отправляет отчёт как `report-pgbouncer`: сервер — из `pgscope.server`, имя пулера строится по тем же правилам, что имя сервера (с префиксом кластера).
- `pgscope.server` используется как есть, префикс кластера к нему не добавляется. Указывайте имя ровно так, как сервер виден в pgscope.
- Роль мониторинга должна быть в `stats_users` PgBouncer и проходить его аутентификацию, см. [PgBouncer](postgres.md#pgbouncer). Скрипт `bootstrap-monitor-role.sh` контейнеры PgBouncer пропускает.
- Для PgBouncer можно задать отдельного пользователя. Пароль передаётся ещё одним секретом агента:

```yaml
# дополнение к deploy/agent/docker-compose.yml
services:
  agent:
    secrets: [pgscope_api_key, pgscope_monitor_password, bouncer_stats_pw]
secrets:
  bouncer_stats_pw:
    file: ./secrets/bouncer_stats_pw
```

И метки у контейнера PgBouncer: `pgscope.user: stats` и `pgscope.password-file: /run/secrets/bouncer_stats_pw`.

## Роль мониторинга и секреты {#secrets}

Для всех баз хоста используется одна роль, по умолчанию `pgscope_monitor`, с правами `pg_monitor`. Агент получает два секрета Docker:

| Секрет | Путь в контейнере агента | Что внутри |
|---|---|---|
| `pgscope_api_key` | `/run/secrets/pgscope_api_key` | API-ключ из «Профиль» pgscope, 22 символа |
| `pgscope_monitor_password` | `/run/secrets/pgscope_monitor_password` | пароль роли `pgscope_monitor` |

- Переводы строки в конце файлов отбрасываются.
- Вместо файлов можно передать значения переменными `PGSCOPE_API_KEY` и `PGSCOPE_AGENT_PGPASSWORD`: если переменная задана, файл не читается. Файлы предпочтительнее: значения переменных видны в `docker inspect`.
- pgmetrics получает пароль только через `PGPASSWORD` в своём окружении. Переменные `PGSCOPE_*` в окружение pgmetrics не передаются.
- В текстах ошибок, которые агент отправляет в pgscope, пароль заменяется на `***`, текст сокращается до 500 байт.

### Скрипт bootstrap-monitor-role.sh {#bootstrap}

Скрипт `deploy/agent/bootstrap-monitor-role.sh` создаёт роль мониторинга во всех размеченных контейнерах хоста. Его запускают на каждом Docker-хосте и каждом узле Swarm, где есть базы: `docker exec` работает только с контейнерами своего узла.

```bash
cd deploy/agent
./bootstrap-monitor-role.sh --dry-run                       # показать, что будет сделано
./bootstrap-monitor-role.sh --password-file secrets/pgscope_monitor_password --with-pg-stat-statements
./bootstrap-monitor-role.sh db-1 db-2                       # только указанные контейнеры
```

| Параметр | По умолчанию | Назначение |
|---|---|---|
| `--password-file FILE` | `./secrets/pgscope_monitor_password` | файл с паролем роли; не пустой, без строки `$pgscope_pw$` |
| `--role NAME` | `pgscope_monitor` | имя роли, только `[a-z_][a-z0-9_]*` |
| `--label KEY=VALUE` | `pgscope.enable=true` | метка, по которой ищутся контейнеры |
| `--with-pg-stat-statements` | — | выполнить `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` во всех базах, принимающих подключения |
| `--dry-run` | — | ничего не менять, только показать действия (файл с паролем всё равно должен существовать) |
| `-h`, `--help` | — | справка |
| `контейнер…` | все запущенные с меткой | id или имена контейнеров |

Что делает скрипт в каждом контейнере:

- пропускает контейнеры с `pgscope.kind=pgbouncer` и реплики (`pg_is_in_recovery()`): на реплики роль придёт с primary;
- создаёт роль с `LOGIN` и паролем из файла, а если она уже есть, задаёт ей этот пароль; выдаёт ей `pg_monitor`;
- с `--with-pg-stat-statements` создаёт расширение во всех базах и предупреждает, если `pg_stat_statements` нет в `shared_preload_libraries`.

SQL передаётся в `psql` внутри контейнера через stdin `docker exec -i`, поэтому пароль не виден в списке процессов. На время своей сессии скрипт отключает журналирование команд (`log_statement`, `log_min_duration_statement`, `log_min_error_statement`) и учёт служебных команд в `pg_stat_statements` (`pg_stat_statements.track_utility`), иначе пароль попал бы в журнал PostgreSQL и через `pg_stat_statements` в отчёты pgscope. Скрипт можно запускать повторно, например после смены пароля. При ошибках в каких-либо контейнерах он завершается с кодом 2 и сообщением `N container(s) failed`.

Скрипт рассчитан на официальный образ `postgres`: `psql` подключается к базе `postgres` через локальный сокет от имени `$POSTGRES_USER` (по умолчанию `postgres`), и такое подключение в этом образе не требует пароля. Для других образов создайте роль вручную в `psql` под суперпользователем:

```sql
CREATE ROLE pgscope_monitor LOGIN;
GRANT pg_monitor TO pgscope_monitor;
\password pgscope_monitor
```

**pg_stat_statements в контейнере.** Библиотеку нужно загрузить при старте сервера: добавьте в compose-файл или стек `command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]` и пересоздайте контейнер. Если библиотек несколько, перечислите их через запятую. После этого выполните `./bootstrap-monitor-role.sh --with-pg-stat-statements`.

## Сети {#networks}

Для каждой цели агент ищет путь в таком порядке:

1. сеть из метки `pgscope.network` (полное имя, `<проект>_<сеть>` из Compose или `<стек>_<сеть>`). Если контейнер в ней не состоит — статус «Недоступна»;
2. сеть, в которой агент уже состоит вместе с базой;
3. если автоподключение включено (`PGSCOPE_AGENT_AUTOCONNECT=true`, по умолчанию) и агент не задача Swarm, он подключает свой контейнер к сети базы. Пользовательские сети предпочтительнее стандартной `bridge`;
4. если агент запущен с `network_mode: host` или вне контейнера, он подключается по IP контейнера. Так работают только сети bridge, overlay из пространства имён хоста недоступны;
5. иначе у цели статус «Недоступна» с причиной.

Сети `ingress`, `docker_gwbridge`, `host` и `none` не используются.

- Внутренние сети (`internal: true`) подходят: подключение к ним не меняет маршрут агента до pgscope.
- Сеть с опцией `com.docker.network.bridge.enable_icc=false` запрещает трафик между контейнерами, через неё агент базу не увидит.
- Overlay-сеть, к которой агент подключается сам, должна быть создана с `--attachable`.

### Автоподключение на отдельном хосте {#autoconnect}

Для автоподключения агенту нужен `POST /networks/{id}/connect`, то есть право записи в Docker API. Агент выходит из подключённых им сетей, когда они больше не нужны ни одной цели, и при штатной остановке (SIGTERM). Список этих сетей он хранит в своём контейнере (`/var/tmp/pgscope-agent-joined.json`), поэтому и после аварийного перезапуска (OOM, `kill -9`, сбой питания хоста) выходит из них сам.

Если давать агенту право записи нельзя, задайте `PGSCOPE_AGENT_AUTOCONNECT=false` и перечислите сети баз в compose-файле агента. Сеть `default` оставьте, через неё агент выходит к pgscope:

```yaml
# deploy/agent/docker-compose.yml, фрагмент
services:
  agent:
    environment:
      PGSCOPE_AGENT_AUTOCONNECT: "false"
    networks: [default, app_backend]
networks:
  app_backend:
    external: true
    name: myapp_backend   # настоящее имя сети из docker network ls
```

### Сети в Docker Swarm {#swarm-networks}

Работающую задачу Swarm нельзя подключить к сети, поэтому в Swarm агент к сетям сам не подключается. Перечислите все overlay-сети с базами в `deploy/agent/docker-stack.yml`:

```yaml
services:
  agent:
    networks: [default, billing_backend]
networks:
  default:
  billing_backend:
    external: true
```

Или добавьте сеть к уже запущенному сервису: `docker service update --network-add billing_backend pgscope-agent_agent`. Сервис при этом перезапустит все задачи агента. Флаг `--attachable` для сервисов не нужен.

## Установка на отдельный Docker-хост {#standalone}

```bash
docker load -i pgscope-agent.tar.gz          # если на хосте нет доступа к registry
cd deploy/agent
mkdir -p secrets
printf '%s' 'API-ключ'               > secrets/pgscope_api_key
printf '%s' 'пароль pgscope_monitor' > secrets/pgscope_monitor_password
chmod 600 secrets/*
echo 'PGSCOPE_URL=https://pgscope.example.com' > .env
./bootstrap-monitor-role.sh --with-pg-stat-statements
docker compose up -d
docker compose logs -f agent
```

- API-ключ берётся в «Профиль» → «API-ключ», см. [Профиль](teams.md#profile).
- В `.env` задаются только переменные, которые `deploy/agent/docker-compose.yml` передаёт агенту: `PGSCOPE_AGENT_CLUSTER` (например, `PGSCOPE_AGENT_CLUSTER=dc1-host7`), `PGSCOPE_AGENT_INTERVAL`, `PGSCOPE_AGENT_DISCOVERY_INTERVAL`, `PGSCOPE_AGENT_LABEL_SELECTOR`, `PGSCOPE_AGENT_QUERY_TIMEOUT`, `PGSCOPE_AGENT_AUTOCONNECT`, `PGSCOPE_AGENT_SSLMODE`, `PGSCOPE_AGENT_CONCURRENCY`, `PGSCOPE_AGENT_PGMETRICS_ARGS`, а также имя образа `PGSCOPE_AGENT_IMAGE`. Остальные переменные из таблицы [Переменные окружения агента](#environment) (`PGSCOPE_AGENT_TIMEOUT`, `PGSCOPE_AGENT_PGUSER`, `SSL_CERT_FILE`, `PGSSLROOTCERT` и другие) добавьте в секцию `environment:` сервиса `agent` в compose-файле: значения из `.env`, которых нет в compose-файле, в контейнер не попадают.
- Пока агентов нет, страница «Агенты» показывает инструкцию и готовый compose-файл с уже подставленными ключом и адресом pgscope.
- Если хост входит в Swarm, `PGSCOPE_AGENT_CLUSTER` обязателен и при запуске через Compose.

## Установка в Docker Swarm {#swarm}

На менеджере:

```bash
printf '%s' 'API-ключ'               | docker secret create pgscope_api_key -
printf '%s' 'пароль pgscope_monitor' | docker secret create pgscope_monitor_password -
# в deploy/agent/docker-stack.yml перечислите overlay-сети с базами, см. «Сети в Docker Swarm»
PGSCOPE_URL=https://pgscope.example.com PGSCOPE_AGENT_CLUSTER=prod-swarm \
  docker stack deploy --resolve-image never -c deploy/agent/docker-stack.yml pgscope-agent
```

- `PGSCOPE_AGENT_CLUSTER` обязателен и одинаков для всех узлов одного кластера. Рабочие узлы не видят id кластера, а без общего имени имена серверов различались бы между узлами. Без этой переменной агент на узле Swarm завершается с ошибкой.
- Сервис глобальный: по одной задаче на узел, лимиты 1 CPU и 512 МБ памяти, резерв 64 МБ.
- Образ должен быть на каждом узле: `docker load` на каждом узле или внутренний registry. `--resolve-image never` не даёт `docker stack deploy` обращаться к registry за образом.
- `bootstrap-monitor-role.sh` запускается на каждом узле с базами. Передайте ему файл с тем же паролем, что в секрете, и удалите файл после запуска.
- Стек передаёт агенту тот же набор переменных, что и compose-файл, их значения берутся из окружения команды `docker stack deploy`, как `PGSCOPE_URL` в примере. `PGSCOPE_AGENT_AUTOCONNECT` в стеке всегда `false`. Другие переменные добавьте в `environment:` стека.
- Логи: `docker service logs -f pgscope-agent_agent`.

## Переменные окружения агента {#environment}

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PGSCOPE_URL` | — | обязательна: базовый адрес pgscope с `http://` или `https://`, без `/api/v1` |
| `PGSCOPE_API_KEY_FILE` | `/run/secrets/pgscope_api_key` | файл с API-ключом |
| `PGSCOPE_API_KEY` | — | API-ключ значением; если задан, файл не читается |
| `PGSCOPE_AGENT_CLUSTER` | — | имя кластера: префикс имён серверов и часть id агента. Без него префикса нет, а кластером считается имя Docker-хоста. На узле Swarm обязательна |
| `PGSCOPE_AGENT_INTERVAL` | `300` | интервал сбора каждой цели: секунды (`300`) или длительность (`5m`), не меньше 1 секунды |
| `PGSCOPE_AGENT_DISCOVERY_INTERVAL` | `30` | как часто искать контейнеры, в том же формате |
| `PGSCOPE_AGENT_TIMEOUT` | `120` | предел на один запуск pgmetrics, в том же формате |
| `PGSCOPE_AGENT_QUERY_TIMEOUT` | `30` | таймаут каждого запроса pgmetrics (`-t`), целое число секунд. Запрос, не уложившийся в него, прерывает весь отчёт |
| `PGSCOPE_AGENT_CONCURRENCY` | `4` | сколько целей собирать одновременно, целое число |
| `PGSCOPE_AGENT_PGUSER` | `pgscope_monitor` | роль мониторинга |
| `PGSCOPE_AGENT_PGPASSWORD_FILE` | `/run/secrets/pgscope_monitor_password` | файл с паролем роли |
| `PGSCOPE_AGENT_PGPASSWORD` | — | пароль значением; если задан, файл не читается |
| `PGSCOPE_AGENT_SSLMODE` | `prefer` | `sslmode` подключений к базам |
| `PGSCOPE_AGENT_PGMETRICS_ARGS` | — | дополнительные флаги pgmetrics, например `--omit=bloat -S`. Разбиваются по пробелам, кавычки не поддерживаются. Не передавайте здесь `--all-dbs` и флаги подключения |
| `PGSCOPE_AGENT_AUTOCONNECT` | `true` | подключаться к сетям баз самому: `true`, `1`, `yes` или `false`, `0`, `no`. В задаче Swarm, в режиме `host` и вне контейнера всегда выключено |
| `PGSCOPE_AGENT_LABEL_SELECTOR` | `pgscope.enable=true` | фильтры меток Docker через запятую; контейнер должен подходить под все |
| `PGSCOPE_AGENT_CONTAINER` | определяется сам | id или имя контейнера агента, если автоопределение не сработало |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker API: `unix://…` или `tcp://host:port` (без TLS), например socket proxy |
| `PGMETRICS` | `pgmetrics` | путь к pgmetrics |
| `SSL_CERT_FILE` | — | PEM-файл с сертификатом внутреннего CA, если HTTPS pgscope подписан им; смонтируйте файл в контейнер агента |

Все остальные переменные окружения агента, кроме `PGSCOPE_*`, передаются pgmetrics как есть (например, `PGSSLROOTCERT`). Агент сам задаёт pgmetrics `PGPASSWORD`, `PGSSLMODE` и `PGCONNECT_TIMEOUT=10`. Сессии pgmetrics видны в `pg_stat_activity` с `application_name=pgmetrics`: pgmetrics всегда задаёт его сам, и `PGAPPNAME` этого не меняет. С `application_name=pgscope-agent` видна только проверочная сессия агента.

Compose-файл и стек передают в контейнер только перечисленные в них переменные, см. [Установка на отдельный Docker-хост](#standalone).

При неверном значении агент не запускается и пишет в журнал `configuration: …` со списком всех проблем, например `PGSCOPE_AGENT_INTERVAL="5x": expected a duration such as 300s` или `the API key must be 22 letters and digits (see the pgscope profile page)`.

Интервал сбора не должен быть меньше `PGSCOPE_MIN_REPORT_INTERVAL` сервера pgscope (по умолчанию 60 секунд). Иначе pgscope ответит 429, и агент пропустит отчёт до следующего интервала, см. [Ответы сервера](collect.md#responses).

## Страница «Агенты» {#agents-page}

Пункт «Агенты» в боковом меню. Страница обновляется каждые 30 секунд. На ней видны агенты, которые отправляют сигналы с API-ключом вашего аккаунта. У участников команды своего ключа нет, поэтому у них список пуст. Для каждого агента показана карточка, её заголовок — id агента вида `<кластер>/<хост>` (в Swarm — `<кластер>/<id узла>`).

| Поле | Что показывает |
|---|---|
| «Кластер» | `PGSCOPE_AGENT_CLUSTER` или, если он не задан, имя Docker-хоста |
| «Хост» | имя Docker-хоста |
| «Режим» | `Swarm` или «отдельный хост» |
| «Версия агента» | значение `VERSION` при сборке образа |
| «Версия Docker» | версия Docker Engine хоста |
| «Последний сигнал» | когда агент последний раз выходил на связь (сигнал раз в минуту) |
| «Интервал сбора» | `PGSCOPE_AGENT_INTERVAL` |
| «Подключение к сетям баз» | «автоматически» или «вручную» — фактический режим с учётом Swarm и режима `host` |

Таблица целей:

| Колонка | Что показывает |
|---|---|
| «Имя» | имя сервера (у PgBouncer — имя пулера и значок PgBouncer). Ссылка на страницу сервера или PgBouncer появляется, когда отчёты уже пришли |
| «Контейнер» | имя контейнера; при наведении — короткий id |
| «Образ» | образ контейнера |
| «Сеть» | сеть, через которую агент подключается |
| «Адрес подключения» | IP и порт |
| «Статус» | состояние цели, см. ниже |
| «Подробности» | текст последней ошибки или причина недоступности |
| «Последний успешный сбор» | когда отчёт последний раз ушёл успешно; при наведении — время последней попытки |

| Статус | Значение |
|---|---|
| «Работает» | последний сбор и отправка прошли успешно |
| «Ожидает первого сбора» | контейнер найден, первый сбор ещё не наступил |
| «Недоступна» | нет пути к базе (нет общей сети, сеть не подходит) или нет TCP-подключения: `connection refused`, `no route to host`, `i/o timeout`, `no such host` и подобные |
| «Ошибка аутентификации» | `password authentication failed`, `no pg_hba.conf entry` или другая ошибка с кодом SQLSTATE класса 28 |
| «Ошибка» | ошибка в метках, сбой pgmetrics или pgscope не принял отчёт |

Статусы приходят с сигналом агента, поэтому отстают от реальности на время до минуты. Если агент молчит дольше 3 минут, на карточке появляются отметка «Нет связи с агентом» и кнопка «Удалить». Удаление только убирает запись: если агент на самом деле работает, он появится снова со следующим сигналом. Если агент не нашёл ни одного контейнера, в таблице написано «Агент не нашёл контейнеров с меткой pgscope.enable=true».

## Решение проблем {#troubleshooting}

| Статус цели | Что делать |
|---|---|
| «Ожидает первого сбора» | подождите до одного интервала сбора: первые запуски распределены по интервалу |
| «Недоступна» | прочитайте причину в «Подробности»: добавьте сеть в стек агента или `--network-add`, укажите `pgscope.network`, проверьте `pgscope.port` и что PostgreSQL слушает не только `localhost` (`listen_addresses`) |
| «Ошибка аутентификации» | запустите `bootstrap-monitor-role.sh` с тем же файлом пароля, что в секрете агента; проверьте, что `pg_hba.conf` пускает `pgscope_monitor` из сети агента; для PgBouncer проверьте `stats_users` и файл пользователей |
| «Ошибка» | прочитайте текст в «Подробности» и найдите его ниже |

Частые тексты в «Подробности»:

| Текст | Что делать |
|---|---|
| `canceling statement due to statement timeout` | увеличьте `PGSCOPE_AGENT_QUERY_TIMEOUT` или добавьте `--omit=bloat` / `-S` в `PGSCOPE_AGENT_PGMETRICS_ARGS` |
| `pgmetrics did not finish within 2m0s (PGSCOPE_AGENT_TIMEOUT)` | увеличьте `PGSCOPE_AGENT_TIMEOUT` или сократите объём сбора, как выше |
| `database "postgres" does not exist` | укажите базы в метке `pgscope.dbs`: первая используется для проверки подключения |
| `role pgscope_monitor may not connect to any database` | выдайте роли `CONNECT` на нужные базы |
| `pgscope answered HTTP 429: Reports are being sent too often` | интервал сбора меньше `PGSCOPE_MIN_REPORT_INTERVAL`, или два источника отправляют отчёты под одним именем (например, хосты без `PGSCOPE_AGENT_CLUSTER`) |
| `pgscope answered HTTP 403: Unknown API key` | обновите секрет `pgscope_api_key` ключом из «Профиль» |
| `pgscope answered HTTP 413: The report is larger than … MiB, the limit set by PGSCOPE_MAX_REPORT_MB on the pgscope server` | отчёт больше предела pgscope: сократите сбор флагами `--omit=bloat`, `-S` или схемами и таблицами в `PGSCOPE_AGENT_PGMETRICS_ARGS` либо поднимите `PGSCOPE_MAX_REPORT_MB` на сервере pgscope, см. [Ограничения частоты и размера](collect.md#limits) |
| `the agent is not on network …; add it to the agent stack …` | Swarm: объявите сеть в стеке агента, см. [Сети в Docker Swarm](#swarm-networks) |
| `overlay network … is not attachable …` | разверните агента сервисом Swarm или пересоздайте сеть с `--attachable` |
| `network … blocks traffic between containers (enable_icc=false)` | используйте другую сеть базы или укажите её в `pgscope.network` |
| `the agent is not on network …; declare it in the agent's compose file or set PGSCOPE_AGENT_AUTOCONNECT=true` | автоподключение выключено: объявите сеть в compose-файле агента, см. [Автоподключение на отдельном хосте](#autoconnect) |
| `could not join network …: …` | агенту не дали подключиться к сети, например socket proxy с `POST=0`: задайте `PGSCOPE_AGENT_AUTOCONNECT=false` и объявите сети статически |
| `the container is not attached to network "…" from the label pgscope.network` | исправьте метку `pgscope.network` или подключите контейнер базы к этой сети |
| `overlay network … is not reachable from the host network namespace; …` | агент в режиме `host` или вне контейнера не видит overlay-сети: запустите его сервисом Swarm в этой сети |
| `the container has no IP address on a usable network` | контейнер базы подключён только к `host`, `none` или служебным сетям Swarm: подключите его к сети bridge или overlay |
| `pgscope.password-file: open …` | файл из метки не найден: подключите этот секрет к сервису агента (`secrets:`) |
| `sending the report: …` | pgscope недоступен из контейнера агента: проверьте `PGSCOPE_URL`, DNS и сертификат (`SSL_CERT_FILE`) |

**Агент не запускается или постоянно перезапускается.** Посмотрите `docker compose logs agent` или `docker service logs pgscope-agent_agent`:

- `configuration: …` — неверные переменные, см. [Переменные окружения агента](#environment). Например, `set PGSCOPE_API_KEY or PGSCOPE_API_KEY_FILE (…)` — секрет с API-ключом не подключён, `pgmetrics binary: … (set PGMETRICS)` — не найден pgmetrics;
- `DOCKER_HOST "…": only unix:// and tcp:// are supported` — неподдерживаемая схема в `DOCKER_HOST`;
- `cannot reach the Docker Engine API at … (mount /var/run/docker.sock or set DOCKER_HOST)` — не смонтирован сокет Docker или недоступен `DOCKER_HOST`;
- `PGSCOPE_AGENT_CLUSTER is required on Swarm nodes` — задайте имя кластера;
- `ERROR: the Docker daemon refuses API …` — демон отверг версию Docker API; сообщите об этом вместе с выводом `docker version`.

**Агента нет на странице «Агенты».** Проверьте, что `PGSCOPE_URL` доступен из контейнера агента и что ключ в секрете совпадает с ключом из «Профиль». При неверном ключе агент пишет в журнал `ERROR: pgscope rejected the API key (HTTP 403: …); check PGSCOPE_API_KEY` и продолжает работу. Если HTTPS pgscope подписан внутренним CA, смонтируйте сертификат CA и задайте `SSL_CERT_FILE`.

**Контейнера с базой нет в таблице целей.** Проверьте, что контейнер запущен, у него метка `pgscope.enable` со значением ровно `true`, а в Swarm метка задана в `labels:`, а не в `deploy.labels`. Если имя совпало с именем другого контейнера, в журнале агента будет запись `both map to`, задайте `pgscope.name`.

**`docker compose down` проекта с базой пишет `Resource is still in use` про его сеть.** Агент ещё подключён к этой сети, поэтому Compose её не удаляет. Это безопасно: следующий `docker compose up` использует ту же сеть, а агент выйдет из неё, когда база исчезнет.

**`docker compose up` проекта с базой падает с `error while removing network … has active endpoints`, контейнер базы остаётся остановленным.** Так бывает после изменения настроек сети в compose-файле: Compose пересоздаёт сеть, а агент к ней подключён. Отключите агента и повторите:

```bash
docker network disconnect СЕТЬ КОНТЕЙНЕР_АГЕНТА
docker compose up -d
```

Чтобы это не повторялось, создайте сеть баз один раз командой `docker network create` и объявите её в проектах как `external: true`, тогда Compose не будет её удалять. Другой вариант — `PGSCOPE_AGENT_AUTOCONNECT=false` и сети в compose-файле агента: тогда перед изменением сети агента останавливают (`docker compose stop agent`), а после запускают заново (`docker compose up -d --force-recreate agent`).

**Корневая файловая система агента только для чтения (`read_only: true`).** Агент не может сохранить список подключённых им сетей и пишет об этом в журнал (`cannot remember the joined networks`). После аварийного перезапуска отключите его от этих сетей вручную: `docker network disconnect СЕТЬ КОНТЕЙНЕР_АГЕНТА`.

## Безопасность {#security}

- **Доступ к `/var/run/docker.sock` равен root на хосте.** Поэтому агент работает от root, а в образе нет ничего, кроме агента и pgmetrics. Монтирование сокета с `:ro` API не ограничивает.
- **Socket proxy.** Доступ можно сузить через [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy). Реальное ограничение даёт только `POST=0`: в этом прокси `POST=1` вместе с `CONTAINERS=1` разрешает и `POST /containers/create` и `/start`, а это тот же root. С `POST=0` автоподключение невозможно, поэтому задайте `PGSCOPE_AGENT_AUTOCONNECT=false` и объявите сети статически. Дополнение к `deploy/agent/docker-compose.yml` (образ прокси в закрытый контур тоже переносится через `docker save`):

  ```yaml
  services:
    socket-proxy:
      image: tecnativa/docker-socket-proxy:0.3.0
      restart: unless-stopped
      environment: {CONTAINERS: 1, NETWORKS: 1, INFO: 1, POST: 0}
      volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
      networks: [docker-api]
    agent:
      # монтирование docker.sock у агента удалите
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

- **Пароль роли предъявляется каждому размеченному контейнеру.** Кто может запускать на хосте контейнеры с метками, тот может получить пароль `pgscope_monitor`. Поэтому у роли не должно быть прав сверх `pg_monitor`. Метка `pgscope.password-file` читает только файлы внутри `/run/secrets/` в канонической форме, то есть секреты самого агента, а не произвольные файлы его контейнера.
- **Защита от подстановки в строку подключения.** pgmetrics подставляет имена баз и ролей в строку подключения без кавычек. Поэтому агент отвергает имена с `=`, табуляцией, переводами строк и другими пробельными управляющими символами и с `://`: такое имя могло бы добавить параметр подключения (например, другой `host`, которому ушёл бы пароль). Базы из `pg_database` с такими именами пропускаются: создать базу может любой пользователь с правом `CREATEDB`. pgmetrics получает параметры подключения флагами, а не URL.
- **Секреты не попадают в окружение, аргументы и журналы**, если передавать их файлами. Переменные `PGSCOPE_*` не передаются в окружение pgmetrics, пароль в отправляемых текстах ошибок маскируется.
- **Шифрование подключений к базам.** `sslmode=prefer` шифрует соединение, если сервер поддерживает TLS, но сертификат не проверяет. Для проверки задайте `PGSCOPE_AGENT_SSLMODE` или метку `pgscope.sslmode`. Агент подключается по IP-адресу контейнера, поэтому для `verify-full` в сертификате сервера нужен этот IP-адрес. Файл CA можно передать стандартной переменной `PGSSLROOTCERT` в окружении агента: добавьте её в `environment:` и смонтируйте файл в контейнер агента. Этот сценарий не проверялся вживую.
- **Тексты запросов.** Роль `pg_monitor` видит тексты запросов из `pg_stat_statements` и `pg_stat_activity`, а в них могут быть литералы с данными. Они уходят в pgscope вместе с отчётом.

Общие вопросы безопасности pgscope описаны в разделе [Безопасность](security.md).

## Ограничения и что не проверено {#limitations}

- Отчёты агента не содержат журнала PostgreSQL и системных метрик: пусты «Журнал», «Планы выполнения», «История autovacuum (из журнала)», «Взаимоблокировки в журнале» и «Система», см. [Как работает агент](#how-it-works).
- Агент видит только контейнеры своего хоста. На каждом хосте и каждом узле Swarm нужен свой агент.
- `DOCKER_HOST` поддерживает только `unix://` и `tcp://` без TLS.
- Агент проверен вживую на Docker Desktop. **Не проверялись вживую:** Docker Swarm, работа через socket proxy, режим `network_mode: host`, базы с TLS (`verify-ca`, `verify-full`) и Docker Engine 29. Код для этих случаев есть: например, версия Docker API согласуется с демоном (не выше 1.47), потому что Docker Engine 29.0–29.2 отвергает версии ниже 1.44. Если демон всё же откажет, агент напишет `ERROR: the Docker daemon refuses API …`. Перед промышленным использованием в этих конфигурациях проверьте их на стенде.
