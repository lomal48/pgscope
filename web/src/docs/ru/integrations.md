# Облачные метрики, PgBouncer и Pgpool

Эта страница описывает данные, которые pgscope принимает помимо отчётов самого PostgreSQL: метрики облачных платформ AWS и Azure, отчёты пулера подключений PgBouncer и отчёты Pgpool-II. Здесь объяснено, когда соответствующие пункты появляются в интерфейсе, как настроить сбор и как читать показатели.

Пункты «Облачные метрики» и «PgBouncer» находятся в группе «Интеграции» бокового меню сервера. Группа показывается, только если у сервера есть такие данные. Pgpool — не пункт меню, а отдельный вид сервера в списке серверов.

## Облачные метрики {#cloud}

Для управляемых баз AWS RDS / Aurora и Azure Database for PostgreSQL pgmetrics может дополнить отчёт метриками облачной платформы: CloudWatch (AWS) или Azure Monitor (Azure). Пункт «Облачные метрики» появляется в меню, когда последний отчёт сервера содержит такие метрики.

> [!NOTE]
> Облачные метрики нужны только для баз, работающих в AWS или Azure. Обращения к API облака выполняет pgmetrics на машине, где он запущен; сам pgscope с облаком не связывается. В закрытом контуре с собственными серверами PostgreSQL этот раздел не используется: нагрузку, память и диски хоста pgmetrics собирает сам, если запущен на хосте базы данных (см. [Система](server.md#system)).

### Подключение AWS RDS и Aurora {#cloud-aws}

Запускайте pgmetrics с флагом `--aws-rds-dbid` — идентификатором экземпляра базы:

```bash
export AWS_REGION=eu-central-1
pgmetrics -w -f json -h mydb.xxxx.eu-central-1.rds.amazonaws.com -U pgmon --aws-rds-dbid=mydb db1 \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report mydb
```

С этим флагом pgmetrics:

- находит экземпляр (`DescribeDBInstances`), запрашивает список его метрик в пространстве имён `AWS/RDS` и для каждой берёт самое свежее минутное среднее (статистика `Average`, период 60 с) за последние 5 минут;
- если для экземпляра включён Enhanced Monitoring, читает последнюю запись из группы журналов CloudWatch Logs `RDSOSMetrics`;
- читает журнал PostgreSQL через API RDS (если не указан `--omit=log`) за последние `--log-span` минут, поэтому для RDS работает и страница [«Журнал»](server.md#logs).

Ошибки AWS не прерывают сбор: pgmetrics пишет предупреждение `failed to collect from AWS RDS` и формирует отчёт дальше. Если не удалось получить метрики или запись Enhanced Monitoring, в отчёте не будет ни облачных метрик, ни журнала из RDS; ошибка чтения журнала на метрики не влияет.

Учётные данные AWS pgmetrics берёт стандартным для AWS SDK способом: переменные окружения (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`), файлы `~/.aws/credentials` и `~/.aws/config` или роль IAM машины. pgmetrics вызывает следующие действия API, на которые учётной записи нужны права:

| Действие | Зачем |
|---|---|
| `rds:DescribeDBInstances` | найти экземпляр и узнать, включён ли Enhanced Monitoring |
| `cloudwatch:ListMetrics`, `cloudwatch:GetMetricData` | метрики CloudWatch |
| `logs:GetLogEvents` | запись Enhanced Monitoring (только если он включён) |
| `rds:DescribeDBLogFiles`, `rds:DownloadDBLogFilePortion` | журнал PostgreSQL (если не указан `--omit=log`) |

Запросы к API CloudWatch AWS может тарифицировать отдельно.

### Подключение Azure {#cloud-azure}

Запускайте pgmetrics с флагом `--az-resource` — полным идентификатором ресурса Azure (поддерживаются Flexible Server, Single Server и Cosmos DB for PostgreSQL):

```bash
pgmetrics -w -f json -h myserver.postgres.database.azure.com -U pgmon \
  --az-resource=/subscriptions/SUB_ID/resourceGroups/RG/providers/Microsoft.DBforPostgreSQL/flexibleServers/myserver db1 \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report myserver
```

Идентификатор должен иметь вид `/subscriptions/<ID подписки>/resourceGroups/<группа>/providers/Microsoft.DBforPostgreSQL/<тип>/<имя>`, где тип — `flexibleServers`, `servers` (Single Server) или `serverGroupsv2` (Cosmos DB for PostgreSQL); иначе pgmetrics сообщает `invalid resource ID`. Учётные данные pgmetrics получает через стандартную цепочку Azure SDK (`DefaultAzureCredential`): переменные окружения сервисного субъекта, управляемое удостоверение или вход через Azure CLI. Учётной записи нужно право читать метрики Azure Monitor этого ресурса.

pgmetrics запрашивает фиксированный набор метрик за последние 5 минут (интервал 1 минута, для Single Server — 15 минут) и берёт для каждой последнее значение (среднее, а если его нет — сумму или максимум):

| Тип ресурса | Метрики |
|---|---|
| Flexible Server | `backup_storage_used`, `cpu_percent`, `memory_percent`, `iops`, `disk_queue_depth`, `read_throughput`, `write_throughput`, `read_iops`, `write_iops`, `storage_percent`, `storage_used`, `storage_free`, `txlogs_storage_used`, `active_connections`, `network_bytes_egress`, `network_bytes_ingress`, `connections_failed`, `connections_succeeded`, `maximum_used_transactionIDs` |
| Single Server | `cpu_percent`, `memory_percent`, `io_consumption_percent`, `storage_percent`, `storage_used`, `storage_limit`, `serverlog_storage_percent`, `serverlog_storage_usage`, `serverlog_storage_limit`, `active_connections`, `connections_failed`, `backup_storage_used`, `network_bytes_egress`, `network_bytes_ingress`, `pg_replica_log_delay_in_seconds`, `pg_replica_log_delay_in_bytes` |
| Cosmos DB for PostgreSQL | `cpu_percent`, `memory_percent`, `apps_reserved_memory_percent`, `iops`, `storage_percent`, `storage_used`, `active_connections`, `network_bytes_egress`, `network_bytes_ingress` |

Для Azure собираются только метрики Azure Monitor; журнал PostgreSQL таким способом не читается.

### Что показывает страница {#cloud-page}

- Подзаголовок — «AWS CloudWatch» или «Azure Monitor · имя ресурса (регион)».
- Карточки — первые 12 метрик отчёта с текущими значениями.
- «Динамика» — по графику на каждую метрику под её исходным именем (например, `CPUUtilization`, `FreeableMemory`, `FreeStorageSpace`, `ReadIOPS`, `WriteIOPS`, `DatabaseConnections` у AWS). Единицу pgscope определяет по имени метрики, проверяя правила по порядку (действует первое подходящее): `percent`, `Utilization`, `HitRatio`, `%` и `BurstBalance` — проценты; `Aurora…Lag` и `CommitLatency` — миллисекунды; `Latency`, `ReplicaLag`, `CheckpointLag`, `_in_seconds` и `Uptime` — секунды; `CommitThroughput` — операции в секунду; прочие `Throughput` и `LogsGeneration` — байты в секунду; `IOPS` — количество; `Bytes`, `Memory`, `Storage`, `Space`, `Swap`, `DiskUsage` и `SlotLag` — байты; остальные — количество. Например, `memory_percent` и `storage_percent` у Azure выводятся в процентах, `ReadThroughput` — в байтах в секунду, `AuroraReplicaLag` — в миллисекундах, `SwapUsage` и `OldestReplicationSlotLag` — в байтах. Карточки показывают значения в тех же единицах, что и графики.
- «Расширенный мониторинг (Enhanced Monitoring)» — последняя запись Enhanced Monitoring в исходном виде (JSON), если он включён для экземпляра RDS.

Если открыть страницу у сервера без облачных метрик, выводится «Нет облачных метрик» с подсказкой про флаги pgmetrics.

## PgBouncer {#pgbouncer}

pgscope принимает отчёты PgBouncer и привязывает их к серверу PostgreSQL, за которым стоит пулер. У одного сервера может быть несколько экземпляров PgBouncer, каждый под своим именем. Пункт «PgBouncer» появляется в меню сервера после первого принятого отчёта пулера (список серверов в интерфейсе обновляется раз в минуту), а имена пулеров выводятся под карточкой сервера в списке серверов.

### Подключение {#pgbouncer-setup}

pgmetrics переходит в режим PgBouncer, когда подключается к служебной базе `pgbouncer`, и выполняет `SHOW POOLS`, `SHOW SERVERS`, `SHOW CLIENTS`, `SHOW STATS` и `SHOW DATABASES`. Пользователь должен быть указан в `admin_users` или `stats_users` PgBouncer. Используемая версия pgmetrics разбирает вывод PgBouncer 1.15–1.25; если число столбцов в выводе другое, pgmetrics завершается с ошибкой `unsupported number of columns`, и отчёт не формируется.

```bash
pgmetrics -w -f json -h PGB_HOST -p 6432 -U pgb_stats pgbouncer \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report-pgbouncer prod-db-1 pgb-1
```

Здесь `prod-db-1` — имя сервера PostgreSQL в pgscope, `pgb-1` — имя экземпляра PgBouncer. Оба имени — латинские буквы, цифры, `_`, `.`, `-`, до 64 символов. Если сервера с таким именем ещё нет, он будет создан. Лимит частоты отчётов (`PGSCOPE_MIN_REPORT_INTERVAL`) считается отдельно для каждого экземпляра PgBouncer, поэтому отчёт пулера можно отправлять сразу после отчёта PostgreSQL. Отчёт без данных PgBouncer отклоняется с кодом 400 («В отчёте нет данных PgBouncer»); остальные ответы — как у обычных отчётов, в том числе 413 для отчёта больше `PGSCOPE_MAX_REPORT_MB` (см. [Отправка отчётов](collect.md#responses)).

В Docker и Docker Swarm отчёты PgBouncer может отправлять агент pgscope: кроме метки, по которой агент находит контейнеры (по умолчанию `pgscope.enable=true`), контейнеру пулера нужны метки `pgscope.kind=pgbouncer` и `pgscope.server` с именем сервера PostgreSQL (см. [Docker и Docker Swarm](docker.md#labels)).

### Что показывает страница {#pgbouncer-page}

Страница «PgBouncer» показывает последний отчёт выбранного экземпляра, а если в верхней панели выбран прошлый момент — его отчёт не позже этого момента (время отчёта — в подзаголовке «Отчёт от …»; если отчётов PgBouncer до этого момента нет — «Нет отчёта PgBouncer на этот момент»). Кнопки «‹» и «›» переключают отчёты основного сервера; графики строятся за выбранный период, щелчок по ним выбирает момент. Если экземпляров несколько, переключатель находится справа вверху.

Карточки (по данным `SHOW CLIENTS` и `SHOW SERVERS`):

| Карточка | Что показывает |
|---|---|
| «Активные клиентские соединения» | клиенты, связанные с серверным соединением или готовые к работе |
| «Ожидающие клиенты» | клиенты, ждущие свободного серверного соединения; больше нуля подсвечивается |
| «Макс. ожидание клиентов» | самое долгое ожидание среди ждущих клиентов; подсвечивается, если больше секунды; в подписи — среднее |
| «Активные серверные соединения» | соединения с PostgreSQL, занятые клиентами |
| «Простаивающие серверные соединения» | свободные соединения, готовые к выдаче |
| «Использованные серверные соединения» | соединения, ожидающие проверки (`server_check_query`) перед повторным использованием |

Блок «Динамика соединений»: графики «Клиентские соединения» (активные, ожидающие, простаивающие), «Серверные соединения» (активные, простаивающие, использованные) и «Время ожидания клиентов» (максимальное и среднее, в секундах).

Блок «Базы данных» (`SHOW DATABASES`): «Имя», «Целевой сервер» (`хост:порт/база`, `local` — Unix-сокет), «Пользователь (force_user)», «Соединения» (текущие и максимум) и «Состояние» — «работает», «приостановлена» (`PAUSE`) или «отключена» (`DISABLE`).

Блок «Трафик по базам» (`SHOW STATS`): «База», «Транзакции», «Запросы», «Ср. время запроса», «Ср. ожидание», «Получено», «Отправлено». «Ср. время запроса» и «Ср. ожидание» — значения `avg_query_time` и `avg_wait_time` из `SHOW STATS`. Счётчики накопительные с запуска PgBouncer. Для базы, выбранной в списке справа, строятся графики «Транзакции и запросы · …» (в час) и «Сеть · …» (байт в секунду).

Блок «Пулы» (`SHOW POOLS`): «Пул» (`база/пользователь`), «Режим» (`session`, `transaction`, `statement`), «Активные клиенты», «Ожидающие клиенты» (подсвечиваются), «Активные серверы», «Простаивающие серверы», «Использованные серверы», «Макс. ожидание». Для пула, выбранного в списке справа, строятся графики «Соединения · …» и «Ожидание клиентов · …».

### Как читать показатели {#pgbouncer-tuning}

- **Клиенты ждут** («Ожидающие клиенты» больше нуля, растёт «Макс. ожидание»), а все серверные соединения пула активны — пул мал для нагрузки. Увеличьте `default_pool_size` (или `pool_size` базы) с учётом `max_connections` PostgreSQL либо ищите долгие транзакции, которые держат соединения (страница [«Бэкенды»](activity.md#backends)).
- **Клиенты ждут, хотя серверных соединений в пуле меньше `default_pool_size`** — проверьте ограничения PgBouncer `max_db_connections` и `max_user_connections`, а также не исчерпан ли `max_connections` в PostgreSQL.
- **Режим `session`** держит серверное соединение на всё время клиентской сессии; для коротких запросов эффективнее `transaction`, если приложение не использует состояние сессии.
- **«приостановлена» / «отключена»** у базы — кто-то выполнил `PAUSE` или `DISABLE` в консоли; новые подключения к такой базе ждут или отклоняются.

> [!NOTE]
> Правила оповещений строятся только по метрикам PostgreSQL (см. [Правила оповещений](alerts.md)); по показателям PgBouncer, Pgpool и облачным метрикам правил нет.

## Pgpool {#pgpool}

Pgpool-II мониторится как отдельный сервер вида `pgpool`: в списке серверов у него своя иконка, подпись «Pgpool» с версией и карточки «Бэкенды в работе», «Попадания в кеш» (кеша запросов) и «Отчёт». В переключателе серверов к имени добавляется `(pgpool)`.

### Подключение {#pgpool-setup}

pgmetrics собирает данные Pgpool при флаге `--pgpool`:

```bash
pgmetrics -w -f json -h PGPOOL_HOST -p 9999 -U pgmon --pgpool postgres \
  | pgdash -a APIKEY --base-url=https://pgscope.example.com/api/v1 report-pgpool pool-1
```

pgmetrics выполняет `SHOW POOL_VERSION`, `SHOW POOL_NODES`, `SHOW POOL_CACHE`, а на Pgpool-II 4.2+ ещё `SHOW POOL_HEALTH_CHECK_STATS` и `SHOW POOL_BACKEND_STATS`; используемая версия разбирает вывод Pgpool-II 4.0–4.7 и на другом формате завершается с ошибкой.

`pool-1` — имя сервера Pgpool в pgscope (те же правила, что для имён серверов PostgreSQL). Имена серверов PostgreSQL и Pgpool не пересекаются: сервер `pool-1` вида `pgpool` и сервер `pool-1` вида `postgres` — разные объекты. Отчёт без данных Pgpool отклоняется с кодом 400 («В отчёте нет данных Pgpool»). Агент pgscope для Docker отчёты Pgpool не отправляет — используйте cron или systemd-таймер.

### Что показывает страница {#pgpool-page}

В меню сервера Pgpool два пункта: «Обзор» (страница «Pgpool») и «Команда и настройки» (см. [Команда, профиль и аккаунт](teams.md#server-settings)). Подзаголовок страницы — версия Pgpool-II и время отчёта.

Карточки:

| Карточка | Что показывает |
|---|---|
| «Бэкенды в работе» | узлы со статусом `up` или `waiting` из общего числа; подсвечивается, если работают не все |
| «Попадания в кеш запросов» | доля попаданий в кеш запросов Pgpool |
| «Попаданий в кеш» | число попаданий и, в подписи, число SELECT |
| «Записи кеша» | записи кеша и использование хеш-таблицы |
| «Занято в кеше» | занятый объём кеша и, в подписи, свободный |
| «Фрагментировано» | фрагментированный объём кеша |

Показатели кеша имеют смысл, только если в Pgpool включён кеш запросов в памяти (`memory_cache_enabled`).

Блок «Бэкенды» — узлы PostgreSQL за Pgpool: «Узел», «Хост», «Статус» (`up` и `waiting` — зелёным, `down` — красным), «Роль», «Вес балансировки», «Узел балансировки», SELECT, «Запись» (INSERT + UPDATE + DELETE), «Ошибки» (ERROR + FATAL + PANIC, выделяются красным), «Отставание репликации» (в секундах, если Pgpool сообщает его во времени, иначе в байтах) и «Состояние репл.».

Блок «Проверки состояния» — статистика health check по узлам: «Всего», «Доля успешных», «Неудачные» (выделяются красным), «Пропущенные», «Повторы», «Ср. длительность», «Макс. длительность», «Последняя проверка», «Последний сбой».

Блок «Динамика» с выбором узла: «Кеш запросов» (SELECT и попадания в кеш в секунду), «Бэкенды в работе» (в работе и всего), «Операторы · узел …» (SELECT, INSERT, UPDATE, DELETE в секунду) и «Отставание репликации · узел …» (в секундах). На последнем графике сохраняется только отставание во времени: если Pgpool сообщает отставание в байтах, график показывает ноль, а актуальное значение видно в таблице «Бэкенды».

Часть показателей (счётчики записей и ошибок, статистика проверок состояния) Pgpool-II отдаёт начиная с версии 4.2; на старых версиях эти поля пусты.

Как читать: узел в статусе `down` исключён из работы — проверьте его доступность и выполните `pcp_attach_node` после восстановления; растущие «Неудачные» проверки состояния — нестабильная сеть или перегруженный узел; большое отставание реплики при балансировке чтения приводит к чтению устаревших данных.

## Ограничения {#limitations}

- Для серверов Pgpool нет диагностики, AI-чата, правил оповещений и оповещений об изменениях: любой адрес страницы такого сервера, кроме «Команда и настройки», открывает страницу «Pgpool». В разделе «Инспектор» серверы Pgpool не показываются.
- Оповещений по облачным метрикам и показателям PgBouncer нет.
- Пункт «Облачные метрики» зависит от последнего отчёта сервера: если в нём нет облачных метрик (например, pgmetrics не смог получить их из-за ошибки доступа), пункт пропадает до следующего отчёта с метриками.
- Последний отчёт каждого экземпляра PgBouncer хранится бессрочно (как и последний отчёт любого источника, см. [Хранение данных](data.md#retention)), поэтому выведенный из эксплуатации пулер остаётся в переключателе, пока сервер не удалён.
