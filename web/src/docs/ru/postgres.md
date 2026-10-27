# Подготовка PostgreSQL

pgscope получает данные только из отчётов pgmetrics, поэтому интерфейс показывает ровно то, что pgmetrics смог прочитать на сервере. Базовые метрики собираются без настройки. Для полной картины нужны роль мониторинга, расширение `pg_stat_statements`, `auto_explain`, доступ к журналу PostgreSQL и несколько параметров статистики. На этой странице описано, что включить в PostgreSQL, PgBouncer и Pgpool-II и какие страницы pgscope от этого зависят. Как запускать сбор, описано в разделе [Отправка отчётов](collect.md), для баз в контейнерах — в разделе [Docker и Docker Swarm](docker.md).

## Что нужно для каждой страницы {#requirements}

| Что в pgscope | Что нужно на сервере | Подробности |
|---|---|---|
| Все страницы: бэкенды, блокировки, базы, таблицы, индексы, репликация, WAL, настройки | роль с `pg_monitor` и правом `CONNECT` к базам | [Роль для мониторинга](#monitoring-role) |
| «Запросы», страница запроса, «Советы» по запросу | расширение `pg_stat_statements` | [pg_stat_statements](#pg-stat-statements) |
| «Время чтения блоков», «Время записи блоков», совет о доле дискового ввода-вывода | `track_io_timing = on` | [Параметры статистики](#track-settings) |
| «Планирований», «Общее время планирования», совет о долгом планировании | `pg_stat_statements.track_planning = on` | [Параметры статистики](#track-settings) |
| «Планы выполнения» на странице запроса | `auto_explain` с `log_format = json` и доступ pgmetrics к журналу | [auto_explain](#auto-explain) |
| «Журнал», «Взаимоблокировки в журнале» на странице «Блокировки» | доступ pgmetrics к журналу, для `stderr` — метка времени в `log_line_prefix` | [Журнал PostgreSQL](#logs) |
| «История autovacuum (из журнала)» на странице «Очистка (vacuum)» | `log_autovacuum_min_duration` не равен `-1` и доступ к журналу | [Журнал PostgreSQL](#logs) |
| «Функции» в разделе «Расширения и прочее» | `track_functions = pl` или `all` | [Параметры статистики](#track-settings) |
| «Система», графики «Средняя нагрузка» и «Память» на «Обзоре», заполнение дисков в «Табличные пространства» | pgmetrics запущен на хосте базы данных под Linux | [Логи, планы и история autovacuum](collect.md#logs) |
| «Облачные метрики» | флаг pgmetrics `--aws-rds-dbid` или `--az-resource` | [AWS RDS и Aurora](collect.md#aws) |
| «PgBouncer» | пользователь в `stats_users` PgBouncer | [PgBouncer](#pgbouncer) |
| Дашборд Pgpool | пользователь, которого пропускает Pgpool-II | [Pgpool-II](#pgpool) |

> [!TIP]
> После первого отчёта откройте «Диагностика» → «Проверка конфигурации». pgscope сам отметит выключенные `track_io_timing`, `log_checkpoints`, `log_lock_waits`, `log_min_duration_statement`, `log_autovacuum_min_duration` и отсутствие `pg_stat_statements` в `shared_preload_libraries`. Подробнее — в разделе [Диагностика](monitoring.md#diagnostics).

## Поддерживаемые версии {#versions}

| Компонент | Версии | Примечание |
|---|---|---|
| PostgreSQL | от 9.3 до 19 | pgmetrics, с которым собран pgscope, выбирает запросы по `server_version_num` и содержит ветки для этих версий. Версию `pg_stat_statements` (до 1.13) он определяет отдельно, поэтому расширение, не обновлённое после обновления сервера, тоже читается |
| PostgreSQL ниже 14 | собираются, но помечаются | на «Диагностике» появляется предупреждение «Неподдерживаемая версия PostgreSQL»: такие версии больше не получают исправлений безопасности |
| PgBouncer | 1.15–1.25 | pgmetrics разбирает вывод `SHOW POOLS`, `SHOW SERVERS`, `SHOW CLIENTS`, `SHOW STATS`, `SHOW DATABASES` по числу столбцов. На неизвестной раскладке сбор завершается ошибкой `unsupported number of columns` |
| Pgpool-II | 4.0–4.7 | статистика проверок состояния (`SHOW POOL_HEALTH_CHECK_STATS`) и счётчики запросов по бэкендам (`SHOW POOL_BACKEND_STATS`) собираются с версии 4.2 |
| pgmetrics | 1.19.x | pgscope разбирает отчёты моделью pgmetrics 1.19.x. Образ pgscope-agent содержит pgmetrics ровно той версии, с которой собран pgscope |

На PostgreSQL 11 число файлов WAL, готовых к архивации, а на PostgreSQL 10 и старше ещё и общее число файлов WAL pgmetrics читает через `pg_ls_dir`, которую по умолчанию может вызывать только суперпользователь. С ролью `pg_monitor` эти значения не собираются, остальные данные собираются.

## Роль для мониторинга {#monitoring-role}

Для сбора нужна отдельная роль с правом входа и членством в `pg_monitor`. Права суперпользователя не нужны и не рекомендуются: pgscope показывает лишние роли суперпользователя как замечание на «Диагностике».

```sql
CREATE ROLE pgmon LOGIN;
GRANT pg_monitor TO pgmon;
\password pgmon
```

`\password` в psql хеширует пароль на стороне клиента, поэтому открытый пароль не попадает ни в журнал PostgreSQL, ни в `pg_stat_statements`, откуда он ушёл бы в отчёты pgscope. Команда `CREATE ROLE ... PASSWORD '...'` с паролем в тексте этого не гарантирует.

Что даёт `pg_monitor` (через роли `pg_read_all_settings`, `pg_read_all_stats`, `pg_stat_scan_tables`):

- тексты запросов чужих сессий в `pg_stat_activity` и всех запросов в `pg_stat_statements`. Без этого вместо текста будет `<insufficient privilege>`;
- все настройки, включая `data_directory`, по которому pgmetrics ищет файл журнала;
- функции `pg_ls_waldir()` и `pg_ls_archive_statusdir()`: число файлов WAL и очередь архивации.

Право `CONNECT` к базам по умолчанию есть у `PUBLIC`. Если в вашей инсталляции оно отозвано, выдайте его явно для каждой базы, которую нужно видеть:

```sql
GRANT CONNECT ON DATABASE app TO pgmon;
```

pgmetrics открывает одно соединение на базу и задаёт в нём `statement_timeout` (флаг `-t`, по умолчанию 5 секунд) и `lock_timeout` (флаг `--lock-timeout`, по умолчанию 50 мс), поэтому сбор не задерживает рабочую нагрузку. В `pg_stat_activity` эти сессии видны с `application_name = pgmetrics`.

> [!NOTE]
> Оценка раздувания (bloat) строится по представлению `pg_stats`, а PostgreSQL показывает в нём только столбцы, которые роль может читать (`SELECT`). Для таблиц, на которые у роли мониторинга нет права `SELECT`, оценка раздувания может получиться заниженной или нулевой. Если она важна, выдайте роли `SELECT` на нужные таблицы или роль `pg_read_all_data` (PostgreSQL 14+), понимая, что это право читать все данные.

### Доступ по сети и pg_hba.conf {#pg-hba}

Если pgmetrics запускается не на хосте базы, сервер должен слушать сетевой интерфейс (`listen_addresses`), а `pg_hba.conf` — пускать роль мониторинга с адреса сборщика:

```text
# TYPE  DATABASE  USER   ADDRESS        METHOD
host    all       pgmon  10.0.0.5/32    scram-sha-256
```

Если pgmetrics запускается на хосте базы через Unix-сокет (так собираются журнал и системные метрики), добавьте строку для локальных подключений:

```text
local   all       pgmon                 scram-sha-256
```

Строки `pg_hba.conf` проверяются сверху вниз до первого совпадения, поэтому размещайте эти строки выше общих правил вроде `local all all peer`.

Пароль pgmetrics берёт из `~/.pgpass` того пользователя ОС, от имени которого запускается сбор (или из файла, указанного в `PGPASSFILE`), либо из переменной `PGPASSWORD`. С `~/.pgpass` запускайте pgmetrics с флагом `-w` (`--no-password`): без него и без `PGPASSWORD` pgmetrics сам спрашивает пароль, а без терминала (в cron, в systemd) сразу завершается с ошибкой. Файл `~/.pgpass` должен иметь права `0600`:

```text
*:5432:*:pgmon:пароль
```

После изменения `pg_hba.conf` перечитайте конфигурацию: `SELECT pg_reload_conf();`.

## pg_stat_statements {#pg-stat-statements}

Без `pg_stat_statements` страница «Запросы» показывает «Нет статистики запросов», а «Диагностика» — замечание с тем же названием.

1. Добавьте библиотеку в `postgresql.conf` (через запятую, если там уже что-то есть):

   ```ini
   shared_preload_libraries = 'pg_stat_statements'
   ```

2. Перезапустите PostgreSQL. Перечитать конфигурацию недостаточно: `shared_preload_libraries` применяется только при старте.
3. Создайте расширение в каждой базе, которую собирает pgmetrics:

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

4. Проверьте под ролью мониторинга. В колонке `query` не должно быть `<insufficient privilege>`:

   ```sql
   SELECT query, calls FROM pg_stat_statements LIMIT 5;
   ```

Как pgmetrics читает статистику:

- Представление `pg_stat_statements` возвращает запросы всех баз сервера, поэтому pgmetrics читает его один раз за отчёт — в первой собираемой базе, где установлено расширение. Формально достаточно одной такой базы. Учтите, что режим `--all-dbs` не собирает базу `postgres`, так что расширения только в `postgres` в этом режиме мало. Надёжнее создать его во всех отслеживаемых базах.
- В отчёт попадают 100 строк `pg_stat_statements` с наибольшим суммарным временем выполнения (флаг pgmetrics `--statements-limit`), а текст каждого запроса обрезается до 500 символов (`--sql-length`).
- В `pg_stat_statements` у запроса отдельная строка для каждого пользователя, который его выполнял. pgscope объединяет строки с одной базой и одним `queryid`: страница «Запросы», страница запроса, графики и оповещения уровня «Запрос» показывают сумму по всем пользователям, средние считаются как общее время, делённое на общее число вызовов, а максимум — по всем пользователям. Учтите, что каждая такая строка занимает место в лимите `--statements-limit`.
- Строки баз, удалённых после сброса статистики, приходят с пустым именем базы, и pgscope объединяет их по `queryid` в один запрос.

Полезные параметры расширения:

| Параметр | По умолчанию | Зачем менять |
|---|---|---|
| `pg_stat_statements.max` | `5000` | при большом числе разных запросов редкие вытесняются; увеличьте, если статистика «плавает» (нужен перезапуск) |
| `pg_stat_statements.track` | `top` | `all` учитывает и запросы внутри функций |
| `pg_stat_statements.track_planning` | `off` | `on` включает время планирования на странице запроса (PostgreSQL 13+), ценой небольших накладных расходов |

Для контейнеров библиотеку задают в команде запуска, а расширение во всех базах создаёт скрипт `bootstrap-monitor-role.sh` с флагом `--with-pg-stat-statements`, см. [Скрипт bootstrap-monitor-role.sh](docker.md#bootstrap).

## auto_explain {#auto-explain}

Модуль `auto_explain` пишет в журнал PostgreSQL планы медленных запросов. pgmetrics находит их в журнале, а pgscope показывает их в блоке «Планы выполнения» на странице запроса: последние три плана сразу, остальные по кнопке «Показать все планы ({n})».

```ini
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = 2000   # мс: планы запросов дольше 2 секунд
auto_explain.log_analyze = on          # фактические строки и циклы в узлах
auto_explain.log_timing = off          # без времени узлов: меньше накладных расходов
auto_explain.log_format = json         # только JSON pgscope показывает деревом
```

Изменение `shared_preload_libraries` требует перезапуска.

Как формат влияет на отображение:

| `auto_explain.log_format` | Что увидите в pgscope |
|---|---|
| `json` | дерево плана: тип узла, таблица или индекс, фактические и ожидаемые строки, стоимость, время, условия; предупреждения под узлами и советы «План: …» на странице запроса |
| `text` | план показывается как обычный текст, без разбора и предупреждений |
| `xml`, `yaml` | pgmetrics такие планы не разбирает и пишет в stderr `warning: xml format auto_explain output not supported yet` (или то же для `yaml`); план не будет показан |

Замечания:

- `log_analyze = on` даёт фактические строки, по которым pgscope находит ошибки оценки планировщика. По документации PostgreSQL инструментирование включается для всех запросов, а не только для попавших в журнал, поэтому накладные расходы есть всегда. `log_timing = off` заметно их снижает. Тогда полосы под узлами показывают долю стоимости, и над деревом выводится «полосы показывают долю стоимости (нет данных о времени)». Чтобы снизить нагрузку ещё сильнее, используйте `auto_explain.sample_rate`.
- Планы связываются с запросом из `pg_stat_statements` по идентификатору запроса или по тексту, в котором литералы, числа и параметры `$n` заменены на `?`. Текст в `pg_stat_statements` обрезан до `--sql-length` (500 символов), поэтому длинные запросы по тексту не сопоставятся. Для них добавьте `%Q` в `log_line_prefix` (PostgreSQL 14+, при `compute_query_id = auto` и загруженном `pg_stat_statements`), чтобы pgmetrics получил идентификатор запроса, или увеличьте `--sql-length`. В `csvlog` PostgreSQL 14+ идентификатор записывается в отдельную колонку, и pgmetrics из [сборки pgscope](collect.md#pgmetrics-build) берёт его оттуда без `%Q`.
- Планы читаются только из записей журнала за последние `--log-span` минут каждого отчёта. Все условия чтения журнала — в разделе [Журнал PostgreSQL](#logs).

## Журнал PostgreSQL {#logs}

Из журнала pgmetrics берёт:

- все записи за период отчёта — страница «Журнал»;
- планы `auto_explain` — страница запроса;
- строки `automatic vacuum of table "…"` со временем выполнения — «История autovacuum (из журнала)» на странице «Очистка (vacuum)»;
- записи `deadlock detected` с подробностями — «Взаимоблокировки в журнале» на странице «Блокировки».

pgmetrics читает журнал, только если выполнены все условия:

1. **Подключение локальное.** pgmetrics подключился через Unix-сокет, по одному и тому же адресу клиента и сервера или по loopback-адресам `127.0.0.0/8`. При удалённом запуске журнал не читается, даже если указан `--log-file` или `--log-dir`. Исключение — AWS RDS и Aurora: там журнал читается через API AWS при флаге `--aws-rds-dbid`, см. [AWS RDS и Aurora](collect.md#aws). Строка «Собрано» карточки «Кластер» на «Обзоре» показывает версию pgmetrics, например «pgmetrics 1.19.1 (локально)», а пометка «(локально)» — что отчёт собран локально.
2. **Файл найден.** pgmetrics ищет его по порядку: флаг `--log-file`; все файлы каталога из `--log-dir`, кроме `.gz` и `.bz2`; результат `pg_current_logfile()` (PostgreSQL 10+, только при `logging_collector = on`; абсолютный путь или путь относительно `data_directory`), если роли разрешено вызывать эту функцию; самый свежий файл в `/var/log/postgresql`. Если файл из `--log-file` не читается, pgmetrics пишет `warning: failed to locate/read specified log file …` и других мест не перебирает. Если ничего не нашлось, pgmetrics пишет в stderr предупреждение `failed to guess log file location/access denied, specify explicitly with --log-file or --log-dir`, и отчёт уходит без данных журнала.
3. **Формат поддерживается.** pgmetrics читает текстовый журнал (`stderr`) и `csvlog`. Формат он выбирает по настройкам сервера, а не по имени файла: если `log_destination` содержит `csvlog` и `logging_collector = on`, все найденные файлы читаются как CSV (текстовые файлы `.log` из `--log-dir` при этом пропускаются, иногда с предупреждением `warning: while reading log file …`), иначе — как текст. `csvlog` PostgreSQL 13 и новее читает только pgmetrics, собранный pgscope (версия оканчивается на `+pgscope`, см. [pgmetrics из сборки pgscope](collect.md#pgmetrics-build)). Официальные выпуски pgmetrics разбирают только 23-колоночный `csvlog` PostgreSQL 12, а в PostgreSQL 13 и новее колонок больше, и такой файл они молча пропускают: журнал в отчёте будет пустым, без предупреждений. С официальным pgmetrics оставьте `log_destination = 'stderr'`, без `csvlog`. Формат `jsonlog` pgmetrics не читает.
4. **Для `stderr` в `log_line_prefix` есть метка времени** `%t`, `%m` или `%n`. Значение по умолчанию `'%m [%p] '` подходит. Без метки времени журнал не читается, а pgmetrics пишет `no timestamp escape sequence was found in log_line_prefix`. В `csvlog` время есть в каждой записи, и pgmetrics из сборки pgscope `log_line_prefix` при нём не проверяет; официальные выпуски требуют метку времени и для `csvlog`.
5. **Файл доступен на чтение** пользователю ОС, от имени которого запущен pgmetrics. По умолчанию `log_file_mode = 0600`, и читать журнал может только владелец (обычно `postgres`). Либо запускайте сбор от имени `postgres`, либо задайте `log_file_mode = 0640` и добавьте пользователя сборщика в группу владельца. Во втором случае пользователю нужен доступ и к каталогу журнала. По умолчанию `log_directory = 'log'` находится внутри каталога данных, а у него права `0700`, и `log_file_mode = 0640` не поможет. Вынесите `log_directory` за пределы каталога данных (например, в `/var/log/postgresql`) или запускайте сбор от имени `postgres`.

Читаются только записи за последние `--log-span` минут (по умолчанию 5). Делайте это значение равным интервалу отправки отчётов, иначе часть записей не попадёт ни в один отчёт.

> [!WARNING]
> Официальные выпуски pgmetrics правильно читают время записей, только если `log_timezone` совпадает с часовым поясом хоста, где работает pgmetrics (`/etc/localtime` или переменная `TZ` процесса), либо равен `'UTC'`. Они определяют время записи по сокращению пояса (`MSK`, `CET`, `+05`) и понимают только `UTC`, `GMT` и сокращения своего местного пояса, а остальные считают UTC. При поясе восточнее UTC (например, `MSK`) время записей уходит вперёд на смещение пояса: в отчёт попадают записи за `--log-span` минут плюс это смещение, время на странице «Журнал» сдвинуто, а одни и те же записи повторяются в нескольких отчётах подряд. При поясе западнее UTC время уходит назад, записи не попадают в окно `--log-span`, и журнал в отчёте пустой. Это касается меток `%m` и `%t` в `stderr` и журнала `csvlog`; метка `%n` (время Unix) от пояса не зависит.
>
> [pgmetrics из сборки pgscope](collect.md#pgmetrics-build) читает время записей в поясе из `log_timezone` сервера, поэтому оно верно при любом сочетании поясов сервера и хоста pgmetrics. Если имя пояса ему неизвестно, он пишет в stderr `warning: unknown log_timezone …` и читает время в поясе своего хоста.

Рекомендуемые параметры журнала:

| Параметр | Рекомендация | Что даёт в pgscope |
|---|---|---|
| `logging_collector` | `on` | файлы журнала, которые pgmetrics находит через `pg_current_logfile()` (нужен перезапуск) |
| `log_destination` | `'stderr'` | формат, который читает любой pgmetrics; `'csvlog'` PostgreSQL 13+ читает только [сборка pgscope](collect.md#pgmetrics-build) |
| `log_line_prefix` | `'%m [%p] %q%u@%d '` | метка времени (обязательна для `stderr`), пользователь и база у записей; добавьте `%Q` для связи планов с запросами |
| `log_timezone` | любой со [сборкой pgscope](collect.md#pgmetrics-build); с официальным pgmetrics — часовой пояс его хоста или `'UTC'` | правильное время записей и их попадание в окно `--log-span` |
| `log_file_mode` | `0640` | чтение журнала не от имени владельца |
| `log_autovacuum_min_duration` | `1000` (мс) или `0` | «История autovacuum (из журнала)». Значение `-1` выключает запись (по умолчанию до PostgreSQL 14; с 15 по умолчанию `10min`) |
| `log_lock_waits` | `on` | ожидания блокировок дольше `deadlock_timeout` видны в «Журнал» |
| `log_checkpoints` | `on` | контрольные точки в журнале, контекст для страницы «WAL и контрольные точки» (с PostgreSQL 15 включено по умолчанию) |
| `log_min_duration_statement` | например `1000` (мс) | медленные запросы в «Журнал» |

Все параметры, кроме `logging_collector`, применяются без перезапуска: `SELECT pg_reload_conf();`.

## Параметры статистики {#track-settings}

| Параметр | По умолчанию | Что даёт в pgscope | Замечания |
|---|---|---|---|
| `track_counts` | `on` | статистика таблиц и индексов; без неё не работает autovacuum | при `off` «Проверка конфигурации» показывает критичное замечание |
| `track_activities` | `on` | текущие запросы на странице «Бэкенды» | |
| `track_activity_query_size` | `1024` | длина текста запроса в `pg_stat_activity` | нужен перезапуск; pgmetrics дополнительно обрезает текст до `--sql-length` |
| `track_io_timing` | `off` | «Время чтения блоков» и «Время записи блоков» у баз и запросов, совет «… времени уходит на дисковый ввод-вывод» | на современных системах накладные расходы невелики, проверить можно утилитой `pg_test_timing` |
| `track_functions` | `none` | вкладка «Функции» в «Расширения и прочее» | `pl` — только функции на процедурных языках, `all` — ещё и SQL- и C-функции |
| `pg_stat_statements.track_planning` | `off` | время планирования у запросов | PostgreSQL 13+ |
| `compute_query_id` | `auto` | идентификатор запроса для `%Q` в журнале и в `pg_stat_activity` | PostgreSQL 14+; при `auto` вычисляется, когда загружен `pg_stat_statements` |

```sql
ALTER SYSTEM SET track_io_timing = on;
ALTER SYSTEM SET track_functions = 'pl';
SELECT pg_reload_conf();
```

## PgBouncer {#pgbouncer}

pgmetrics собирает данные PgBouncer через его служебную консоль: подключается к порту PgBouncer (обычно `6432`) к базе с именем ровно `pgbouncer` и выполняет `SHOW POOLS`, `SHOW SERVERS`, `SHOW CLIENTS`, `SHOW STATS` и `SHOW DATABASES`. Для этого достаточно пользователя из `stats_users` (только чтение консоли), права `admin_users` не нужны.

```ini
; pgbouncer.ini
[pgbouncer]
stats_users = pgmon
auth_file = /etc/pgbouncer/userlist.txt
```

Пользователь должен проходить аутентификацию PgBouncer; надёжнее всего завести его строкой в `auth_file`. После изменения выполните в консоли PgBouncer `RELOAD;`. Проверка:

```bash
psql -h PGB_HOST -p 6432 -U pgmon pgbouncer -c 'SHOW POOLS;'
```

Если PgBouncer требует TLS от клиентов, задайте `PGSSLMODE` перед запуском pgmetrics: без этой переменной pgmetrics подключается с `sslmode=disable`. Команда отправки — в разделе [PgBouncer](collect.md#pgbouncer), PgBouncer в контейнере — в разделе [PgBouncer в контейнере](docker.md#pgbouncer).

## Pgpool-II {#pgpool}

С флагом `--pgpool` pgmetrics подключается к порту Pgpool-II (обычно `9999`) как обычный клиент к любой базе (например, `postgres`) и выполняет `SHOW POOL_VERSION`, `SHOW POOL_NODES`, `SHOW POOL_HEALTH_CHECK_STATS`, `SHOW POOL_BACKEND_STATS` и `SHOW POOL_CACHE`. Отдельной роли в Pgpool-II не нужно: достаточно, чтобы Pgpool-II пропускал пользователя по своим правилам аутентификации (`pool_hba.conf`, `pool_passwd`) и тот мог подключиться к бэкендам.

```bash
psql -h PGPOOL_HOST -p 9999 -U pgmon postgres -c 'SHOW POOL_NODES;'
```

Если какая-либо из команд `SHOW POOL_*` завершилась ошибкой, pgmetrics прерывает сбор с сообщением вида `pgpool: show pool_nodes query failed`, и отчёт не отправляется. Команда отправки — в разделе [Pgpool-II](collect.md#pgpool).

## Проверка готовности {#checklist}

Под ролью мониторинга на сервере PostgreSQL:

```sql
SHOW shared_preload_libraries;                 -- pg_stat_statements, auto_explain
SELECT extname, extversion FROM pg_extension;  -- pg_stat_statements в базе
SELECT count(*) FROM pg_stat_statements;       -- не ошибка
SHOW track_io_timing;                          -- on
SHOW log_line_prefix;                          -- для stderr: есть %m, %t или %n
SHOW log_timezone;                             -- с официальным pgmetrics: пояс его хоста или UTC
SELECT pg_current_logfile();                   -- путь к файлу журнала, если функция доступна роли
```

Затем запустите pgmetrics вручную в обычном текстовом формате и посмотрите предупреждения в stderr: недоступный журнал, ошибки `pg_stat_statements`, нехватку прав.

```bash
pgmetrics -h localhost -U pgmon app
```

Если всё в порядке, настройте регулярную отправку по разделу [Отправка отчётов](collect.md).
