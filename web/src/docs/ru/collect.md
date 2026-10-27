# Отправка отчётов

Данные попадают в pgscope в виде отчётов: pgmetrics собирает снимок состояния сервера в JSON, а pgdash CLI отправляет его в pgscope. На этой странице описаны установка обеих утилит, их флаги, регулярная отправка через cron и systemd, сбор с многих серверов, журнал и облачные метрики, отчёты PgBouncer и Pgpool-II, ограничения частоты и размера и все ответы сервера. Что включить на самом PostgreSQL, описано в разделе [Подготовка PostgreSQL](postgres.md). Базы в контейнерах удобнее собирать агентом, см. [Docker и Docker Swarm](docker.md).

## Как устроен сбор {#how-it-works}

```text
PostgreSQL ──► pgmetrics ──(JSON)──► pgdash CLI ──(HTTP POST, gzip)──► pgscope
PgBouncer ───┘                                    /api/v1/report
Pgpool-II ───┘                                    /api/v1/reportpgbouncer
                                                  /api/v1/reportpgpool
```

- **pgmetrics** за один запуск собирает сотни показателей сервера и выводит их в JSON. Каждый отчёт — снимок на момент сбора.
- **pgdash CLI** отправляет этот JSON в pgscope. pgscope реализует те же адреса `/api/v1/report`, `/api/v1/reportpgbouncer` и `/api/v1/reportpgpool`, что и pgDash, поэтому в существующих заданиях cron достаточно заменить API-ключ на ключ pgscope и добавить `--base-url`.
- **pgscope** сохраняет отчёт в сжатом виде, извлекает из него временные ряды и сводку для списка серверов. После отчёта PostgreSQL он проверяет правила [оповещений](alerts.md) и сравнивает отчёт с предыдущим для [оповещений об изменениях](change-alerts.md). Отчёты PgBouncer и Pgpool-II правила не запускают.

Что важно знать заранее:

- Сервер создаётся автоматически при первом отчёте и принадлежит аккаунту, чей API-ключ использован.
- Графики строятся по последовательности отчётов, поэтому отправлять их нужно регулярно, обычно раз в 5 минут, и не чаще, чем раз в `PGSCOPE_MIN_REPORT_INTERVAL` секунд (по умолчанию 60).
- Время отчёта — это время сбора по часам хоста, где запущен pgmetrics. Держите часы сборщика синхронизированными (NTP). pgdash CLI отказывается отправлять отчёт, время которого отличается от текущего больше чем на 180 дней.
- pgscope сам к базам не подключается. Ему нужны только входящие HTTP(S)-запросы от сборщиков, поэтому вся схема работает внутри закрытого периметра.

## Установка pgmetrics и pgdash CLI {#install-tools}

Обе утилиты — открытые (Apache 2.0) программы RapidLoop: [pgmetrics](https://pgmetrics.io) и [pgdash CLI](https://github.com/rapidloop/pgdash). Это статические бинарные файлы без зависимостей. Их ставят на хост, откуда идёт сбор: на сервер базы данных или на отдельный хост-сборщик.

Для закрытого контура скачайте архивы релизов на машине с доступом в интернет и перенесите файлы. Можно собрать их из исходников Go, тоже на машине с доступом в интернет (`go install` скачивает модули) и под Linux той же архитектуры, что и хосты сбора. pgmetrics лучше брать той же версии, с которой собран pgscope: так модель отчёта совпадает полностью. В каталоге с исходниками pgscope:

```bash
export CGO_ENABLED=0   # статический бинарный файл без зависимости от libc
v=$(go list -m -f '{{.Version}}' github.com/rapidloop/pgmetrics)
GOBIN=$PWD/bin go install "github.com/rapidloop/pgmetrics/cmd/pgmetrics@$v"
GOBIN=$PWD/bin go install github.com/rapidloop/pgdash@latest
```

Ещё один путь — взять pgmetrics из образа агента, если он уже есть в контуре. Бинарный файл статический и работает на любом Linux той же архитектуры:

```bash
docker create --name pgm pgscope-agent:latest
docker cp pgm:/usr/local/bin/pgmetrics ./pgmetrics
docker rm pgm
```

> [!NOTE]
> pgdash CLI разбирает отчёт моделью pgmetrics своей версии и кодирует его заново. Поля, которых нет в модели этой версии, при отправке теряются. Используйте свежие и согласованные версии pgmetrics и pgdash CLI. pgscope-agent и отправка через curl ([Отправка без pgdash CLI](#curl)) передают JSON без перекодирования.

## Первый отчёт {#first-report}

1. Скопируйте API-ключ: «Профиль» → карточка «API-ключ». Ключ состоит из 22 латинских букв и цифр. У аккаунтов участников команды ключа нет: отчёты отправляет владелец серверов, см. [Профиль](teams.md#profile).
2. В карточке «Отправка отчётов» на той же странице есть готовые команды с уже подставленными ключом и адресом.
3. Запустите сбор вручную:

```bash
pgmetrics --no-password -f json -h DBHOST -U pgmon db1 db2 \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report prod-db-1
```

- `prod-db-1` — имя сервера в pgscope, см. [Имя сервера](#server-name).
- `--base-url` — публичный адрес pgscope с суффиксом `/api/v1`.
- При успехе pgdash CLI ничего не выводит и завершается с кодом 0. Сервер появляется в списке «Серверы», см. [Серверы](fleet.md#servers).

> [!WARNING]
> Без `--base-url` pgdash CLI отправляет отчёт в облачный pgDash (`https://app.pgdash.io/api/v1`). В закрытом контуре это просто ошибка сети, в открытом — утечка данных о сервере за пределы периметра. Всегда указывайте `--base-url`.

Ключ в аргументах команды виден в списке процессов и в crontab. pgdash CLI читает ключ и из переменной `PDAPIKEY`, если флаг `-a` не задан:

```bash
export PDAPIKEY=$(cat /etc/pgscope/apikey)
pgmetrics --no-password -f json -h DBHOST -U pgmon --all-dbs \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report prod-db-1
```

После перегенерации ключа («Сгенерировать заново» в «Профиль») старый ключ перестаёт работать сразу: обновите его во всех заданиях.

## Флаги pgmetrics {#pgmetrics-flags}

| Флаг | По умолчанию | Назначение |
|---|---|---|
| `-h`, `--host=HOST` | `PGHOST` или `/var/run/postgresql` | хост или каталог Unix-сокета |
| `-p`, `--port=PORT` | `PGPORT` или `5432` | порт |
| `-U`, `--username=USER` | `PGUSER` или имя пользователя ОС | роль для подключения |
| `-w`, `--no-password` | — | никогда не запрашивать пароль. Без этого флага и без `PGPASSWORD` pgmetrics спрашивает пароль даже при наличии `~/.pgpass`, а без терминала (cron, systemd) сразу завершается с ошибкой |
| `--role=ROLE` | — | выполнить `SET ROLE` перед сбором |
| базы аргументами | `PGDATABASE` или имя роли | какие базы собирать: `db1 db2` |
| `--all-dbs` | — | все базы, кроме шаблонов и `postgres`. Список pgmetrics получает, подключившись к базе `postgres`. Если к любой из баз нельзя подключиться, весь сбор завершается ошибкой |
| `--only-listed` | — | включать в отчёт сведения только о перечисленных базах |
| `-c`, `--schema=REGEXP` / `-C`, `--exclude-schema=REGEXP` | — | собирать только схемы, совпадающие с POSIX-выражением, или исключить их |
| `-a`, `--table=REGEXP` / `-A`, `--exclude-table=REGEXP` | — | то же для таблиц |
| `--omit=WHAT` | — | не собирать части отчёта через запятую: `tables`, `indexes`, `sequences`, `functions`, `extensions`, `triggers`, `statements`, `log`, `citus`, `indexdefs`, `bloat`. `tables` выключает и индексы с триггерами, `extensions` — и статистику запросов (версию `pg_stat_statements` pgmetrics узнаёт из списка расширений) |
| `-S`, `--no-sizes` | — | не собирать размеры баз, табличных пространств, таблиц и индексов (ускоряет сбор на огромных базах; на графиках размеров будут разрывы) |
| `--sql-length=N` | `500` | сколько символов текста запроса сохранять |
| `--statements-limit=N` | `100` | сколько запросов из `pg_stat_statements` брать (по убыванию суммарного времени) |
| `-t`, `--timeout=SECS` | `5` | `statement_timeout` каждого запроса pgmetrics. Запрос, не уложившийся в него, обычно прерывает весь сбор |
| `--lock-timeout=MS` | `50` | `lock_timeout` запросов. Размер, который не удалось прочитать из-за блокировки, в отчёт не попадает, на графике будет разрыв |
| `--log-file=PATH` / `--log-dir=DIR` | поиск автоматически | где искать журнал PostgreSQL (только при локальном подключении) |
| `--log-span=MIN` | `5` | за сколько последних минут читать журнал |
| `--aws-rds-dbid=ID` | — | метрики CloudWatch и журнал AWS RDS / Aurora, см. [AWS RDS и Aurora](#aws) |
| `--az-resource=ID` | — | метрики Azure Monitor, см. [Azure](#azure) |
| `--pgpool` | — | собрать только данные Pgpool-II |
| `-f`, `--format=FORMAT` | `human` | для отправки обязательно `json` |
| `-o`, `--output=FILE` | stdout | записать отчёт в файл |
| `--query-proto=PROTO` | `simple` | протокол запросов: `simple` или `extended` |

Флаги можно объединять: `-wfjson` — то же, что `-w -f json`.

pgmetrics понимает стандартные переменные libpq: `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGPASSFILE`, `PGSSLMODE`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLROOTCERT`, `PGCONNECT_TIMEOUT`. Полный список выводит `pgmetrics --help=variables`. `PGAPPNAME` в этом списке тоже есть, но не действует: pgmetrics всегда подключается с `application_name=pgmetrics`.

> [!WARNING]
> Если `PGSSLMODE` не задан, pgmetrics подключается с `sslmode=disable`, то есть без TLS. Для шифрованного подключения задайте, например, `PGSSLMODE=verify-full` и `PGSSLROOTCERT=/path/to/ca.crt`.

На больших базах с тысячами таблиц сбор может не уложиться в `-t 5`. Увеличьте `-t` (агент для Docker по умолчанию использует 30 секунд) или сократите объём флагами `--omit=bloat`, `-S`, `-c`, `-A`.

## Флаги pgdash CLI {#pgdash-flags}

| Команда | Назначение |
|---|---|
| `report SERVERNAME` | отчёт PostgreSQL для сервера `SERVERNAME` |
| `report-pgbouncer SERVERNAME PGBOUNCERNAME` | отчёт экземпляра PgBouncer `PGBOUNCERNAME`, обслуживающего сервер `SERVERNAME` |
| `report-pgpool PGPOOLNAME` | отчёт Pgpool-II `PGPOOLNAME` |

| Флаг | По умолчанию | Назначение |
|---|---|---|
| `-a`, `--api-key=APIKEY` | переменная `PDAPIKEY` | API-ключ из профиля pgscope |
| `--base-url=URL` | `https://app.pgdash.io/api/v1` | адрес pgscope с суффиксом `/api/v1`; обязателен |
| `-i`, `--input=FILE` | stdin | взять отчёт из файла, сохранённого `pgmetrics -f json -o FILE` |
| `--timeout=SECS` | `60` | таймаут одного запроса и пауза перед повтором |
| `--retries=COUNT` | `5` | сколько попыток делать при сетевых ошибках и ответах 5xx (должно быть больше 1) |
| `--debug` | — | отладочный вывод: размер сжатого отчёта, ход запроса и повторов |
| `-V`, `--version` | — | версия |
| `-h`, `--help` | — | справка. Внимание: у pgdash CLI `-h` — это справка, а не хост, как у pgmetrics |

Перед отправкой pgdash CLI проверяет формат ключа и имени, что JSON — отчёт pgmetrics схемы `1.x` и что время сбора не дальше 180 дней от текущего. Команда `report` откажется отправлять отчёт с данными PgBouncer: для него есть `report-pgbouncer`.

Повторы: при сетевой ошибке или ответе 5xx pgdash CLI повторяет запрос, всего до `--retries` попыток, с паузой `--timeout` секунд (после ошибки по таймауту — без паузы). Ответы 4xx, включая 409 и 429, не повторяются. Что именно выводит pgdash CLI для каждого кода, показано в разделе [Ответы сервера](#responses).

## Имя сервера {#server-name}

Имя сервера, PgBouncer и Pgpool-II — от 1 до 64 символов из набора `A-Z a-z 0-9 _ . -`. Это правило проверяют и pgdash CLI, и pgscope.

- Сервер определяется парой «аккаунт владельца + имя». Отчёт с новым именем создаёт новый сервер.
- Переименование источника — это новый сервер в pgscope: история начнётся заново, а старый сервер перестанет обновляться и останется до удаления. Удаление — «Команда и настройки» → «Удаление данных сервера», см. [Настройки сервера](teams.md#server-settings).
- Имена Pgpool-II живут отдельно от имён PostgreSQL: сервер `db1` и Pgpool `db1` — два разных объекта.
- Удобная схема — имя хоста или `<окружение>.<кластер>-<роль>`, например `prod.billing-1`. Агент для Docker строит имена по похожим правилам, см. [Имя сервера](docker.md#server-names).

## Регулярная отправка: cron {#cron}

Удобно оформить отправку небольшим скриптом. `pipefail` нужен, чтобы ошибка pgmetrics не терялась в конвейере:

```bash
#!/bin/bash
# /usr/local/bin/pgscope-report — отправляет один отчёт
# использование: pgscope-report ИМЯ_СЕРВЕРА [флаги pgmetrics...]
set -euo pipefail
name=$1
shift
PDAPIKEY=$(cat /etc/pgscope/apikey)
export PDAPIKEY
pgmetrics --no-password -f json "$@" \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report "$name"
```

```bash
install -m 755 pgscope-report /usr/local/bin/pgscope-report
install -d -m 750 -o postgres /etc/pgscope
install -m 600 -o postgres /dev/null /etc/pgscope/apikey   # затем запишите в файл ключ
```

Задание cron раз в 5 минут от имени `postgres`. Так pgmetrics подключается через Unix-сокет и может читать журнал. Подключение идёт под ролью `pgmon` с паролем из `~postgres/.pgpass`:

```text
# /etc/cron.d/pgscope
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * postgres flock -n /tmp/pgscope-prod-db-1.lock /usr/local/bin/pgscope-report prod-db-1 -U pgmon --all-dbs --log-span=5
```

Строка `PATH` нужна, потому что cron по умолчанию не ищет программы в `/usr/local/bin`, куда обычно кладут pgmetrics и pgdash. `flock -n` пропускает запуск, если предыдущий сбор ещё идёт. Не ставьте задание на каждую минуту: сбор занимает секунды, и следующий отчёт может прийти раньше, чем через `PGSCOPE_MIN_REPORT_INTERVAL` после предыдущего сохранённого, тогда pgscope ответит 429.

## Регулярная отправка: systemd {#systemd}

Таймер systemd удобнее cron: журнал запусков в journald, разброс времени старта и защита от наложения запусков (systemd не запускает службу, пока предыдущий запуск не завершился). Шаблон на любое число серверов использует тот же скрипт `pgscope-report`:

```ini
# /etc/systemd/system/pgscope-report@.service
[Unit]
Description=pgscope: report for %i
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=postgres
EnvironmentFile=/etc/pgscope/%i.env
ExecStart=/usr/local/bin/pgscope-report %i $PGMETRICS_ARGS
```

```ini
# /etc/systemd/system/pgscope-report@.timer
[Unit]
Description=pgscope: report timer for %i

[Timer]
OnCalendar=*:0/5
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
```

Параметры подключения каждого сервера лежат в своём файле. pgmetrics берёт хост, порт и роль из переменных `PGHOST`, `PGPORT`, `PGUSER`:

```ini
# /etc/pgscope/prod-db-1.env
PGHOST=/var/run/postgresql
PGUSER=pgmon
PGMETRICS_ARGS=--all-dbs --log-span=5
```

```bash
systemctl daemon-reload
systemctl enable --now pgscope-report@prod-db-1.timer
systemctl list-timers 'pgscope-report@*'
journalctl -u pgscope-report@prod-db-1.service
```

Имя экземпляра (`prod-db-1`) — это имя сервера в pgscope. `$PGMETRICS_ARGS` без фигурных скобок systemd разбивает по пробелам на отдельные аргументы. `RandomizedDelaySec=60` разносит запуски разных серверов во времени, при этом между двумя отчётами одного сервера остаётся не меньше 4 минут.

## Много серверов {#many-servers}

| Схема | Что даёт | Ограничения |
|---|---|---|
| pgmetrics на каждом хосте БД, подключение через сокет | все данные: журнал, планы, история autovacuum, «Система» | установка утилит и настройка на каждом хосте |
| один хост-сборщик опрашивает много серверов по сети | одна точка настройки, один ключ | нет журнала, планов, истории autovacuum и системных метрик |
| pgscope-agent для баз в Docker и Swarm | автоматическое обнаружение баз | те же ограничения, что у сетевого сбора, см. [Docker и Docker Swarm](docker.md) |

Для сборщика на много серверов заведите на каждый сервер свой экземпляр таймера и свой файл переменных:

```ini
# /etc/pgscope/billing-1.env
PGHOST=billing-1.db.example.com
PGUSER=pgmon
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/pgscope/ca.crt
PGMETRICS_ARGS=--all-dbs
```

```bash
for s in billing-1 billing-2 crm-1; do systemctl enable --now "pgscope-report@$s.timer"; done
```

Все серверы можно отправлять одним ключом. Ограничение частоты считается отдельно для каждого имени, поэтому отчёты разных серверов друг другу не мешают.

## Логи, планы и история autovacuum {#logs}

Журнал PostgreSQL (страница «Журнал», планы `auto_explain`, «История autovacuum (из журнала)», взаимоблокировки) pgmetrics читает только при **локальном** подключении: через Unix-сокет, по одинаковому адресу клиента и сервера или по loopback-адресам. Флаги `--log-file` и `--log-dir` лишь указывают, где лежит журнал; при удалённом запуске они не помогают. Для AWS RDS и Aurora журнал читается через API при `--aws-rds-dbid`.

Системные метрики (страница «Система», нагрузка и память на «Обзоре», заполнение дисков у табличных пространств) pgmetrics собирает тоже только при локальном подключении и только под Linux.

Задавайте `--log-span` равным интервалу отправки (5 минут при запуске раз в 5 минут). Все требования к параметрам журнала и правам на файлы — в разделе [Журнал PostgreSQL](postgres.md#logs).

## AWS RDS и Aurora {#aws}

```bash
export AWS_REGION=eu-central-1
pgmetrics --no-password -f json -h mydb.xxxx.eu-central-1.rds.amazonaws.com -U pgmon \
  --aws-rds-dbid=mydb --log-span=5 app \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report mydb
```

С флагом `--aws-rds-dbid` pgmetrics дополнительно:

- читает все метрики пространства `AWS/RDS` для этого экземпляра в CloudWatch (последнее значение средних за минуту за последние 5 минут);
- если у экземпляра включён Enhanced Monitoring, берёт его последнюю запись из группы журналов CloudWatch Logs `RDSOSMetrics`;
- читает журнал PostgreSQL через API RDS за последние `--log-span` минут.

`--aws-rds-dbid` — идентификатор **экземпляра** (`DBInstanceIdentifier`). Для Aurora это экземпляр кластера, а не идентификатор кластера: отправляйте отчёт с каждого экземпляра под своим именем.

Учётные данные берутся стандартной цепочкой AWS SDK: переменные `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, файлы `~/.aws/credentials` и `~/.aws/config` (профиль `AWS_PROFILE`), роль экземпляра EC2. Права, которые использует pgmetrics:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances",
        "rds:DescribeDBLogFiles",
        "rds:DownloadDBLogFilePortion",
        "cloudwatch:ListMetrics",
        "cloudwatch:GetMetricData",
        "logs:GetLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

Ошибка обращения к AWS не прерывает сбор: pgmetrics пишет `warning: failed to collect from AWS RDS: …`, и отчёт уходит без облачных данных. Учтите: если у экземпляра включён Enhanced Monitoring, а права `logs:GetLogEvents` нет, pgmetrics отбрасывает все облачные метрики отчёта, а не только данные Enhanced Monitoring. Ошибка чтения журнала через API RDS облачные метрики не отменяет. Метрики появятся в пункте «Облачные метрики» раздела «Интеграции», см. [Облачные метрики](integrations.md#cloud).

> [!NOTE]
> Этот режим требует доступа хоста-сборщика к API AWS через интернет или VPC endpoints. Запросы к CloudWatch AWS тарифицирует отдельно. Сам pgscope с AWS не связывается.

## Azure Database for PostgreSQL {#azure}

```bash
export AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=...
pgmetrics --no-password -f json -h myserver.postgres.database.azure.com -U pgmon \
  --az-resource=/subscriptions/SUBSCRIPTION-ID/resourceGroups/RG/providers/Microsoft.DBforPostgreSQL/flexibleServers/myserver \
  app | pgdash --base-url=https://pgscope.example.com/api/v1 report myserver
```

`--az-resource` — полный идентификатор ресурса вида `/subscriptions/…/resourceGroups/…/providers/Microsoft.DBforPostgreSQL/ТИП/ИМЯ`, где тип — `flexibleServers`, `servers` или `serverGroupsv2`. pgmetrics читает метрики Azure Monitor за последние 5 минут (с шагом 1 минута, для `servers` — 15 минут).

Учётные данные pgmetrics получает через `DefaultAzureCredential`: переменные `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (или `AZURE_CLIENT_CERTIFICATE_PATH`, `AZURE_USERNAME` и `AZURE_PASSWORD`) либо другие источники этого механизма, например managed identity. У учётной записи должно быть право читать метрики ресурса. Ошибка не прерывает сбор: pgmetrics пишет `warning: failed to collect from Azure: …`. Все обращения к Azure должны уложиться в таймаут запроса pgmetrics `-t` (по умолчанию 5 секунд); если сбор из Azure обрывается по таймауту, увеличьте `-t`. Как и для AWS, нужен доступ сборщика к API Azure.

## PgBouncer {#pgbouncer}

```bash
pgmetrics -h PGB_HOST -p 6432 -U pgmon -wfjson pgbouncer \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report-pgbouncer prod-db-1 pgb-1
```

- pgmetrics переходит в режим PgBouncer, когда единственная база в аргументах называется ровно `pgbouncer`. Подготовка пользователя — в разделе [PgBouncer](postgres.md#pgbouncer).
- Первый аргумент `report-pgbouncer` — имя сервера PostgreSQL в pgscope, к которому относится пулер, второй — имя экземпляра PgBouncer.
- Отчёт сохраняется у этого сервера. Если сервера с таким именем ещё нет, pgscope создаст его запись, а данные PostgreSQL появятся с первым отчётом `report`.
- Ограничение частоты считается отдельно для каждого экземпляра PgBouncer, поэтому отправляйте отчёт пулера сразу после отчёта PostgreSQL в том же скрипте.
- Несколько пулеров — несколько отчётов под разными именами; на странице PgBouncer экземпляр выбирается переключателем.
- После первого отчёта у сервера появится пункт «PgBouncer» в разделе «Интеграции» (может понадобиться обновить страницу), см. [PgBouncer](integrations.md#pgbouncer).

## Pgpool-II {#pgpool}

```bash
pgmetrics -h PGPOOL_HOST -p 9999 -U pgmon -wfjson --pgpool postgres \
  | pgdash --base-url=https://pgscope.example.com/api/v1 report-pgpool pool-1
```

Pgpool-II появляется в списке «Серверы» отдельным объектом со своим дашбордом, у него есть только «Обзор» и «Команда и настройки». Подготовка — в разделе [Pgpool-II](postgres.md#pgpool), дашборд — в разделе [Pgpool](integrations.md#pgpool).

## Ограничения частоты и размера {#limits}

**Частота.** Отчёт принимается, если с последнего *успешно сохранённого* отчёта того же источника прошло не меньше `PGSCOPE_MIN_REPORT_INTERVAL` секунд (по умолчанию 60). Источник — это аккаунт, тип (PostgreSQL или Pgpool-II), имя сервера и имя PgBouncer. Иначе pgscope отвечает 429. Отметки хранятся в памяти процесса и сбрасываются при его перезапуске. Значение `0` отключает проверку. Пока предыдущий отчёт того же источника ещё сохраняется, следующий получает 409. Настройка переменной — в разделе [Настройка pgscope](config.md).

**Размер.** Тело запроса ограничено 256 МиБ в переданном виде и 2 ГиБ после распаковки gzip (у сигналов агентов — 4 МиБ). Тело больше предела pgscope отвергает с кодом 400 «Некорректное тело запроса». Отчёты обычно в разы меньше. Если отчёт огромный (десятки тысяч таблиц), сократите его флагами `-c`, `-C`, `-a`, `-A`, `--omit`, `-S`, `--statements-limit`.

> [!WARNING]
> Обратный прокси перед pgscope может ограничивать размер тела сильнее. У nginx по умолчанию `client_max_body_size 1m`, и крупные отчёты получат 413 от прокси, а не от pgscope. Поднимите предел для `/api/v1/`, см. [Обратный прокси](install.md#reverse-proxy).

Большие отчёты по медленному каналу могут не уложиться в `--timeout` pgdash CLI (60 секунд): увеличьте его.

## Ответы сервера {#responses}

Адреса приёма отчётов принимают только `POST`. Тело — JSON, по желанию сжатый gzip (`Content-Encoding: gzip`). Успешный ответ — `200` с телом `{}`. Ошибка — JSON вида `{"error": "…"}`. Текст ошибки по-русски, а при заголовке `Accept-Language: en` — по-английски. pgdash CLI этот текст не показывает, только код. Чтобы увидеть сообщение, отправьте отчёт через curl, см. [Отправка без pgdash CLI](#curl).

| Код | Сообщение pgscope | Причина | Что делать |
|---|---|---|---|
| 200 | — | отчёт принят и сохранён | — |
| 400 | «Некорректное тело запроса» | тело не JSON, обрезано или больше предела | проверьте, что отправляется вывод `pgmetrics -f json`; уменьшите отчёт, см. [Ограничения](#limits) |
| 400 | «Не удалось распаковать тело запроса (gzip)» | заголовок `Content-Encoding: gzip`, но тело не gzip | уберите заголовок или сжимайте тело |
| 400 | «Некорректное имя сервера» | имя сервера (или PgBouncer, Pgpool) не подходит под правило | см. [Имя сервера](#server-name) |
| 400 | «Данные не являются JSON-отчётом pgmetrics» | поле `data` — не отчёт pgmetrics или в нём нет времени сбора | запускайте pgmetrics с `-f json` |
| 400 | «В отчёте нет данных PgBouncer» / «В отчёте нет данных Pgpool» | отчёт PostgreSQL отправлен командой `report-pgbouncer` или `report-pgpool` | для PgBouncer собирайте базу `pgbouncer`, для Pgpool-II добавьте `--pgpool` |
| 401 | «Некорректный API-ключ» | ключ не из 22 латинских букв и цифр | скопируйте ключ из «Профиль» заново |
| 403 | «Неизвестный API-ключ» | такого ключа нет: его перегенерировали, он от другого экземпляра pgscope или скопирован с ошибкой | скопируйте актуальный ключ из «Профиль» |
| 404 | — | неверный путь или метод, например `--base-url` без `/api/v1` | проверьте `--base-url` |
| 409 | «Предыдущий отчёт этого сервера ещё сохраняется» | одновременно пришли два отчёта одного источника | следующий отчёт по расписанию пройдёт; проверьте, нет ли двух заданий на одно имя |
| 413 | — | ответ обратного прокси: тело больше его предела | поднимите `client_max_body_size` или аналог |
| 429 | «Отчёты отправляются слишком часто» | с последнего сохранённого отчёта этого источника прошло меньше `PGSCOPE_MIN_REPORT_INTERVAL` | увеличьте интервал отправки; проверьте, нет ли двух заданий на одно имя |
| 500 | «Не удалось сохранить отчёт» | ошибка записи в базу pgscope | смотрите журнал pgscope (строка `store report …`) |
| 502, 504 | — | ответ обратного прокси: pgscope недоступен или не ответил вовремя | проверьте, что pgscope запущен, и таймауты прокси |
| 503 | «Хранилище временно недоступно» | база pgscope недоступна при проверке ключа | восстановите доступ к `PGSCOPE_DB`; pgdash CLI повторит запрос сам |

Как реагируют клиенты:

| Код | pgdash CLI | pgscope-agent |
|---|---|---|
| 200 | молча завершается с кодом 0 | статус цели «Работает» |
| 400 | `pgdash: invalid API key or account limit reached` для `report` или `invalid API key or server "…" not found` для остальных команд (формулировка pgDash; в pgscope 400 означает ошибку данных), без повтора | статус «Ошибка» с текстом ответа |
| 401, 403, 404, 413 | `pgdash: API request failed: server returned HTTP error code N`, без повтора | статус «Ошибка»; при 403 в журнале агента `ERROR: pgscope rejected the API key` |
| 409 | `pgdash: API request failed: previous store for this server is still in progress`, без повтора | статус «Ошибка», следующий отчёт через интервал |
| 429 | `pgdash: API request failed: rate limited, retry after 60 seconds`, без повтора | статус «Ошибка», следующий отчёт через интервал |
| 5xx и сетевые ошибки | повтор до `--retries` раз с паузой `--timeout`; в конце `internal server error` (500) или `server returned HTTP error code N` | один повтор через 5 секунд, затем статус «Ошибка» |

Для подробной диагностики запустите pgdash CLI с `--debug`. Адрес `/api/v1/agent` для сигналов агентов описан в разделе [API](api.md).

## Отправка без pgdash CLI {#curl}

Формат запроса простой, поэтому отчёт можно отправить curl и jq, если pgdash CLI нельзя установить. Так же удобно смотреть текст ошибки pgscope:

```bash
pgmetrics --no-password -f json -h DBHOST -U pgmon --all-dbs \
  | jq -c --rawfile k /etc/pgscope/apikey --arg s prod-db-1 \
      '{apikey: ($k | rtrimstr("\n")), server: $s, data: .}' \
  | gzip \
  | curl -sS --fail-with-body \
      -H 'Content-Type: application/json' -H 'Content-Encoding: gzip' -H 'Accept-Language: en' \
      --data-binary @- https://pgscope.example.com/api/v1/report
```

Нужны jq 1.7+ и curl 7.76+ (`--fail-with-body`). jq 1.6 тоже знает `--rawfile`, но округляет 64-битные числа, в том числе идентификаторы запросов `queryid`. Ключ читается из файла и не попадает в список процессов. Для других типов отчётов меняется адрес и поля JSON:

| Адрес | Поля |
|---|---|
| `/api/v1/report` | `apikey`, `server`, `data` |
| `/api/v1/reportpgbouncer` | `apikey`, `server` (сервер PostgreSQL), `pgbouncer` (имя пулера), `data` |
| `/api/v1/reportpgpool` | `apikey`, `pgpool`, `data` |

В отличие от pgdash CLI, этот вариант не повторяет запрос при ошибках 5xx и не проверяет отчёт перед отправкой.
