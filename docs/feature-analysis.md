# pgscope: продуктовый анализ и приоритеты развития

*Дата: 26.10.2026. Читатель: владелец продукта pgscope. Назначение: решить, что строить в ближайшие 12 месяцев. Жёсткое ограничение: продукт только self-hosted / on-premise, включая полностью изолированные (air-gapped) установки.*

**Содержание:** 1. Краткое резюме · 2. Методология · 3. Где мы сейчас · 4. Конкурентный ландшафт · 5. Self-hosted как принцип · 6. Боли пользователей · 7. Приоритизированный список (топ-15) · 8. Быстрые победы и стратегические ставки · 9. Российский рынок · 10. AI · 11. Архитектурные предпосылки · 12. Дорожная карта · 13. Чего не делать · 14. Риски и открытые вопросы · Приложения A–C

---

## 1. Краткое резюме

- **Главный пробел — доверие к алертингу, а не нехватка графиков.** Алерта «нет данных» нет: правила оцениваются только при приходе отчёта ([`ingest.go:153-155`](../ingest.go), [`alerts.go:454-459`](../alerts.go)), поэтому падение хоста или cron проходит молча. Пользователи pgDash закрывают эту дыру внешним Healthchecks.io ([healthchecks.io](https://blog.healthchecks.io/hp-rewrite/16ddd04e14f6e9c04d4f8dba06e127a7)). Условия правил — только мгновенное gt/lt, настройка идёт на каждый сервер отдельно, тишины и окон обслуживания нет. Первый квартал стоит потратить на алертинг, которому можно доверить ночь: `no-data-alert` → `alert-conditions-v2` → `alert-catalog`, плюс `notification-delivery` и `onprem-channels`. Вместе с пакетом правил по умолчанию нужен этап 1 `alert-noise-controls` (флаг «включено», «заглушить до…», окна обслуживания): включать 25–30 правил на каждом сервере без возможности заглушить их на время плановых работ — значит самим создать шум (боль 7).
- **Лучшее соотношение «эффект/затраты» дают прогнозы медленно назревающих аварий.** Wraparound XID/MultiXact, брошенные слоты, полный диск и сломанная архивация копятся днями, и данные для их прогноза уже приходят в каждом отчёте. `xmin-horizon` (приоритет 3,12) и `exhaustion-forecasts` (1,95) закрывают сценарии вроде аварий в [Metronome](https://metronome.com/blog/root-cause-analysis-postgresql-multixact-member-exhaustion-incidents-may-2025) и [LLM Gateway](https://llmgateway.io/blog/incident-report-october-19-2026).
- **AI-чат противоречит ограничению self-hosted.** [`ai.go`](../ai.go) жёстко вызывает облачный Anthropic API, а переменная `PGSCOPE_AI_PROVIDER` читается, но не используется ([`main.go:57`](../main.go)). К тому же Anthropic не обслуживает Россию ([список стран](https://www.anthropic.com/supported-countries)). Решение — `ai-local-llm`: OpenAI-совместимый endpoint внутри периметра (Ollama, vLLM, llama.cpp, LiteLLM; открытые веса GigaChat 3 и YandexGPT 5 Lite; корпоративный GigaChat в контуре через прокси gpt2giga), AI выключен по умолчанию, облачные провайдеры только как опция.
- **Платформенных качеств self-hosted продукта пока нет.** Нет пакетов, образов, версионированных миграций, SSO, RBAC, журнала аудита и HA ([`README.md:13-19`](../README.md), [`store.go:15-104`](../store.go)). Для закрытых контуров и российских тендеров это входной билет: [PPEM](https://postgrespro.com/docs/ppem/current/ppem-supported-platforms-and-operating-systems.html) уже ставится на Astra, RED OS, ALT и ROSA и умеет LDAP/AD. Эту работу нужно вести параллельной дорожкой с первого месяца.
- **Позиционирование.** pgscope — нейтральный к форкам мониторинг в режиме только чтения: один бинарь, push-модель, без входящих соединений к БД и без хранения паролей, с RU/EN и локальным AI. Каждый из соседей проигрывает в чём-то своём. У pganalyze Enterprise Server цена договорная и годовой контракт на 10+ серверов ([pricing](https://pganalyze.com/pricing)). pgDash self-hosted продаётся только на тарифах Pro/Enterprise с годовой предоплатой и пакетами под amd64 ([self-hosted](https://docs.pgdash.io/self-hosted.md)). PMM и Coroot тянут за собой тяжёлые стеки. PPEM и Tantor — консоли с агентами, которые могут менять СУБД, и они привязаны к своему форку или поядерной лицензии.
- **Существующая функция даёт опасный совет.** Диагностика «Неиспользуемые индексы» предлагает удалить индекс с `idx_scan = 0`, не учитывая реплики и давность сброса статистики ([`diag.go:259-285`](../diag.go)). Если чтение идёт с реплик, удаление такого индекса уронит их запросы; pganalyze пришлось сделать свой советник «знающим о кластере» именно по этой причине ([2026-02](https://pganalyze.com/docs/enterprise/releases/2026-02-0), [index_unused](https://pganalyze.com/docs/checks/schema/index_unused)). Это исправление ошибки, его нужно сделать в первый месяц (`index-hygiene` этап 0).
- **HA и Kubernetes недооценены.** Фокус продукта — self-managed PostgreSQL на железе, ВМ и в Kubernetes, где почти всегда стоит Patroni или оператор. Сейчас pgscope видит failover только как change alert. Первый этап `cluster-topology` не требует агента: в каждом отчёте pgmetrics уже есть `system_identifier`, `timeline_id` и `is_in_recovery`, по ним серверы группируются в кластеры и строится таймлайн переключений (фаза «Далее»; Patroni REST и etcd — этап 2 через агент). Helm-чарт и рецепты сбора для операторов переносятся в первую фазу `offline-packaging`.
- **Главный структурный разрыв в глубине анализа — 5-минутные снимки.** Из-за них не видно ожиданий, коротких блокировок, `last_value` последовательностей, pg_hba, Patroni и бэкапов. Ответ — опциональный компаньон-коллектор (`collector-agent`), который сохраняет push-модель. Формула ставит его низко (0,73), потому что не учитывает, что он открывает дорогу примерно 12 другим фичам. Это главная стратегическая ставка второго квартала.
- **Российский рынок.** Дешёвые и редкие у конкурентов шаги: имена объектов 1С вместо `_AccumRg15195` (`1c-name-mapping`), Mattermost и VK Teams on-prem вместо почти заблокированного Telegram, локальные LLM, поддержка форков, отчёты в стиле AWR/pg_profile. Включение в реестр российского ПО и сертификация — бизнес-решения, а не код.
- **Сроки поджимают:** PostgreSQL 14 теряет поддержку 12.11.2026, PostgreSQL 19 выходит 19.11.2026 ([versioning](https://www.postgresql.org/support/versioning/), [PG19 RC1](https://www.postgresql.org/about/news/postgresql-19-rc-1-3409/)). Части `upgrade-readiness` (обратный отсчёт EOL) и `collected-data-usage` (поля PG18/PG19, которые pgmetrics уже присылает) стоит выпустить в ближайшие 3–4 недели как маркетинговый повод «PG19 с первого дня».

---

## 2. Методология

### 2.1. Источники

Анализ опирается на восемь потоков данных:

1. **pganalyze**: документация, release notes Enterprise Server, цены, отзывы G2.
2. **Коммерческие APM и облачные инструменты** (Datadog, AWS, Google, Azure, Dynatrace, SolarWinds). Их используем только как источник идей.
3. **Open source**: PMM, pgwatch, PoWA, PgHero, pgBadger, pg_profile, Coroot, check_pgactivity, postgres_exporter.
4. **pgDash и pgmetrics**: документация, страница загрузок, коммиты pgmetrics.
5. **Российский рынок**: PPEM, Tantor, Platform V, okmeter, 1С ИТС, Хабр, Infostart, CNews, нормативка.
6. **AI-тренды 2025–2026**: MCP, локальные LLM, безопасность агентов.
7. **Боли пользователей**: постмортемы, DBA.SE, HN, сниппеты Reddit.
8. **Внутренний анализ кода pgscope** (`auth.go`, `alerts.go`, `ingest.go`, `store.go`, `ai.go`, `diag.go`, `web/src/...`).

Предпочтение отдавалось первичным источникам за 2024–2026 годы. Сегодня дополнительно сверены факты о конкурентах:

- pgDash self-hosted ставится из deb/rpm/tar, пакеты есть только под amd64, Docker-образ нужно собирать из своего Dockerfile, для запуска нужен лицензионный файл, для работы интернет не требуется, поддерживается работа под подпутём ([docs.pgdash.io/self-hosted.md](https://docs.pgdash.io/self-hosted.md), [загрузки](https://packages.rapidloop.com/downloads/)). Self-hosted доступен только на Pro/Enterprise с ежегодной предоплатой ([pricing](https://pgdash.io/pricing)).
- AI в pgDash self-hosted поддерживает только `provider = openai | gemini`; своего base URL и локальных моделей в документации нет ([ai](https://docs.pgdash.io/ai.md)).
- okmeter можно развернуть on-prem, а не только как облачный сервис; в реестр российского ПО он включён в 2023 году ([Хабр](https://habr.com/ru/post/716486)).
- Алерты в PPEM 2.9 помечены как бета и отправляются только по email ([docs](https://postgrespro.com/docs/ppem/current/ppem-alerts.html)).
- В PMM вход через LDAP и OAuth делается средствами встроенной Grafana; SAML в Grafana есть только в Enterprise-редакции ([Percona](https://www.percona.com/blog/enable-ldap-on-percona-monitoring-and-management-pmm/), [Grafana SAML](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/saml/)). Прежняя формулировка «SAML в PMM 3.9» источником не подтверждается и исправлена.
- Zabbix в марте 2022 года прекратил коммерческую деятельность в РФ (поддержку, продажи, обучение); сам продукт остаётся open source ([PR](https://www.zabbix.com/de/pr/pr389)).

### 2.2. Как считались оценки

Каждый из 60 кандидатов оценён по шести осям от 1 до 5:

- **value** — насколько функция сокращает инциденты и время диагностики;
- **freq** — как часто пользователь с ней сталкивается;
- **demand** — рыночный спрос, включая требования тендеров;
- **diff** — насколько функция отличает нас от self-hosted конкурентов;
- **effort** — трудоёмкость;
- **risk** — технические и продуктовые риски.

Веса восстановлены по итоговым числам и сверены на всех 60 строках:

- **benefit** = 0,40·value + 0,15·freq + 0,25·demand + 0,20·diff
- **cost** = 0,75·effort + 0,25·risk
- **priority** = benefit / cost

### 2.3. Ограничения метода

1. **Это экспертные оценки.** Интервью с заказчиками, телеметрии и данных о продажах нет. Спрос оценён по публичным источникам, которые смещены в сторону англоязычных и облачных пользователей. Российские источники отчасти представляют собой PR-новости вендоров.
2. **Отношение benefit/cost завышает дешёвые фичи.** Например, `prometheus-export` занимает 3-е место по приоритету (2,05) при benefit всего 2,05. Поэтому топ-15 отобран с фильтром benefit ≥ 3,0 и ручной проверкой на дубли.
3. **Роль платформы как основы для других фич не учитывается.** `collector-agent`, `storage-scaling`, `rbac-orgs`, `api-tokens` и `offline-packaging` получают низкий приоритет, хотя открывают десятки других функций. Это учтено в разделах 11 и 12.
4. **Зависимости в формулу не входят.** Порядок задаёт дорожная карта, а не голый рейтинг.
5. **Ограничение self-hosted делает часть пунктов обязательной независимо от балла.** Это `ai-local-llm` (устранение конфликта с ограничением) и `offline-packaging`.
6. **Трудоёмкость оценена с точностью ±50%.** Размер команды неизвестен: дорожная карта рассчитана на 3 инженеров, при 1–2 сроки растягиваются примерно вдвое при том же порядке работ.
7. **Self-hosted означает, что продуктовой телеметрии нет и не будет.** Успех нужно измерять на тестовых стендах с внедрением сбоев, на пилотах и через отчёт об использовании, который администратор по желанию выгружает сам (локальный файл без автоматической отправки).

---

## 3. Где мы сейчас

### 3.1. Сильные стороны

- **По экранам pgscope на уровне pgDash, а кое-где выше.** Есть pg_stat_io и pg_stat_lock, язык уведомлений на канал, инвайт-ссылки без SMTP. (Azure-метрики тоже есть, но облачные управляемые БД — не наш фокус, и в позиционировании на них не опираемся, см. 5.2.) pgscope закреплён на master-коммите pgmetrics со схемой PG19 и уже показывает `stat_locks` и `repack_progress` ([коммиты pgmetrics](https://github.com/rapidloop/pgmetrics/commits/master)). Значит, утверждение «PG19 с первого дня» можно подтвердить.
- **Модель безопасности.** pgscope не хранит учётных данных к БД и не подключается к ним. Тот же аргумент pganalyze выдвигает для своего MCP-сервера ([блог pganalyze](https://pganalyze.com/blog/mcp-server-public-preview)). На фоне агентов PPEM и Tantor, которые могут выполнять действия на сервере ([Tproger](https://tproger.ru/articles/platformy-administrirovaniya-i-monitoringa-baz-dannyh-na-osnove-postgresql-259927)), это сильный довод для закрытых контуров.
- **Лёгкий след.** pgscope — один Go-бинарь со встроенным SPA и PostgreSQL. UI не загружает внешних ресурсов: `web/index.html` и `web/src` без CDN, иконка встроена как data-URI. Для сравнения, PMM включает Grafana, VictoriaMetrics, ClickHouse и PostgreSQL ([GitHub PMM](https://github.com/percona/pmm)).
- **Широкая готовая база:**
  - около 30 диагностик и 30 правил проверки конфигурации ([`diag.go`](../diag.go));
  - 16 типов change alerts;
  - SQL для управления индексами и табличными пространствами;
  - Top-k с ростом;
  - дашборды PgBouncer и Pgpool;
  - дерево плана auto_explain.
- **Полная локализация RU/EN**, включая тексты уведомлений.
- **Главный прямой аналог развивается в режиме поддержки.** pgDash self-hosted выпускает 3–4 сборки в год (3.5.27 — октябрь 2025, 3.5.30 — январь 2026, 3.5.32 — 22.09.2026) ([загрузки](https://packages.rapidloop.com/downloads/)). Последние заметные функции — AI-чат (SaaS, 2024) и AI в self-hosted через облачные OpenAI или Gemini ([ai](https://docs.pgdash.io/ai.md)); новую поддержку данных в основном приносит pgmetrics. Советников, MCP и зрелого алертинга, которые pganalyze выпустил в 2026 году, у pgDash нет.

### 3.2. Ключевые пробелы (по коду)

| Область | Пробел | Чем опасно | Где в коде |
|---|---|---|---|
| Алертинг | Нет алерта «нет данных» | Сбой сервера или сбора проходит незамеченным | `ingest.go:153-155`, `alerts.go:454-459` |
| Алертинг | Только мгновенное gt/lt; «среднее время» считается накопительно | Правила дребезжат или пропускают медленные инциденты | `alerts.go:345-368`, `alerts.go:263-268` |
| Алертинг | Правила и каналы задаются для каждого сервера; новый сервер получает ноль правил | Флот из 50 серверов приходится настраивать 50 раз | `store.go:65-88` |
| Алертинг | Нет тишины, окон обслуживания, подтверждения, флага «включено» | Чтобы заглушить алерт, приходится удалять правило | `alerts.go:412-435` |
| Доставка | Отправка из горутины без очереди, ответы 4xx/5xx не повторяются; нет Mattermost и Telegram; нет SMTPS на порту 465 | Алерты теряются без следа | `alerts.go:788-911` |
| AI | Только облачный Anthropic, без маскирования и без истории. Без ключа чат отвечает 501 и в сеть не ходит; `PGSCOPE_AI_BASE_URL` меняет лишь адрес Anthropic-совместимого API, а beta-параметры запроса (effort, server-side fallback) локальные шлюзы не примут; модель по умолчанию — `claude-opus-5-5` | Противоречит self-hosted и 152-ФЗ, недоступно в РФ | `ai.go:37-200`, `main.go:57-58` |
| Индексы | Совет удалить «неиспользуемый» индекс (`idx_scan = 0`) не учитывает реплики и давность сброса статистики | Удаление индекса, нужного репликам, ломает чтение на них | `diag.go:259-285` |
| Доступ | Только email и пароль; открытая регистрация позволяет перехватить инвайт; роли owner/member, участник может удалять правила; нет аудита; один ключ API хранится открытым текстом | Блокирует закупку и проверку ИБ | `auth.go:98-200`, `auth.go:317-336`, `store.go:15-104` |
| Безопасность | Кнопкой «Тест» вебхука можно опрашивать внутренние адреса (SSRF), редиректы выполняются | Сканирование внутренней сети с хоста мониторинга | `alerts.go:809-839`, `alerts.go:1035-1093` |
| Данные | Логи, планы и автовакуум видны только из текущего отчёта; сырые отчёты хранятся 14 дней | Нет истории планов и логов | `ServerPages.tsx:294-300`, `store.go:113-118` |
| Запросы | Итоги считаются с момента сброса; топ-100 и 500 символов текста | Свежая регрессия прячется за старыми тяжёлыми запросами | `Activity.tsx:24-65`, `ingest.go:335-339` |
| Хранилище | Heap-таблица с jsonb, ~1,7 млн строк в сутки на сервер, без партиций и роллапов; браузер скачивает весь отчёт раз в 60 с | База растёт, страницы тормозят на крупных схемах | `store.go:57-64`, `api.go:93-131`, `web/src/lib/server.tsx:68-95` |
| Эксплуатация | Нет пакетов, Docker, Helm, миграций; HA невозможна из-за состояния в памяти; нет healthz и метрик самого pgscope | Не внедряется в закрытых контурах | `README.md:13-19`, `ingest.go:28-32`, `main.go:48-115` |
| Неиспользуемые данные | Citus; держатели xmin; ожидания кроме Lock; `confl_*`; `wal_status` слотов; поля PG18/19; `system_identifier` и `timeline_id` используются только в change alerts, но не для группировки серверов в кластеры | Дешёвые фичи лежат на полу | `ingest.go:223-363`, `alerts.go:608-613` |
| HA и Kubernetes | Нет понятия «кластер»: primary и реплики — несвязанные серверы; нет Patroni, нет рецептов сбора для операторов | Failover виден только как change alert; советы по индексам и алерты не учитывают реплики | — |
| Качество | Два файла тестов, нет CI | Миграции хранилища и авторизации опасны | `pgscope_test.go`, `diag_test.go` |

### 3.3. Архитектурные ограничения

1. **Push-снимки pgmetrics по cron, обычно раз в 5 минут, не чаще раза в 60 секунд** ([`ingest.go:86-100`](../ingest.go)). Всё, что происходит между снимками, не видно. Для живых сценариев (ASH, live view, kill, EXPLAIN по кнопке) нужен новый компонент.
2. **pgscope не хранит учётных данных и не подключается к БД.** Это одновременно ограничение и главное преимущество. Pull-режим и агент с действиями меняют модель безопасности, поэтому они могут быть только опциональными и выключенными по умолчанию.
3. **Контракт с pgdash CLI.** Ключ из 22 символов, имя сервера, тело `{apikey, server, pgbouncer|pgpool, data}` ([`ingest.go:22-26, 45-75`](../ingest.go)). Теги и окружения вместе с отчётом передать нельзя, их придётся задавать в UI.
4. **Два уровня данных.** Сырой отчёт (gzip JSON, 14 дней) питает UI, таблица `metrics` (90 дней) — ряды. Фичи, которые работают только по последнему отчёту, обходятся дёшево. Любая история требует правки `extractMetrics` и накапливается только с момента деплоя.
5. **Алерты оцениваются в процессе сразу после отчёта.** Всему, что срабатывает по времени (нет данных, «держится N минут», конец окна обслуживания, напоминания), нужен планировщик. При нескольких экземплярах он должен работать под advisory lock.
6. **pgmetrics не собирает ряд данных:** `pg_wait_sampling`, `last_value` последовательностей, `pg_hba_file_rules`, `pg_prepared_xacts`, `pg_stats`, `reloptions`, Patroni, каталоги бэкапов, `pg_stat_kcache` и `pg_qualstats`. Это прямо видно по [модели pgmetrics](https://github.com/rapidloop/pgmetrics/blob/master/model.go).
7. **Внешняя зависимость.** pgmetrics развивает RapidLoop. Схема PG19 пока не выпущена релизом 1.20.0, а пользователи PgBouncer страдают от открытой проблемы с ping ([issue #78](https://github.com/rapidloop/pgmetrics/issues/78)).
8. **У каждой фичи есть цена локализации:** ключами служат русские строки, проверка идёт через `tools/i18ncheck`.

---

## 4. Конкурентный ландшафт (только self-hosted)

Облачные SaaS-продукты сюда не входят: мы используем их лишь как источник идей (в конце раздела).

### 4.1. Модель, развёртывание, доступ, цена

| Продукт | Модель сбора | Развёртывание и закрытые контуры | SSO / RBAC / аудит | Лицензия и цена |
|---|---|---|---|---|
| **pgscope** | Push pgmetrics примерно раз в 5 мин, без учётных данных к БД | Один Go-бинарь и PostgreSQL; пакетов и образов нет; UI без внешних ресурсов | Owner/member на сервер; SSO и аудита нет | Не определена |
| **pgDash self-hosted** | Push pgmetrics ([docs](https://docs.pgdash.io/automation.md)) | deb/rpm/tar только под amd64; Docker собирается из своего Dockerfile; нужен лицензионный файл; работает без интернета, поддерживает подпуть ([docs](https://docs.pgdash.io/self-hosted.md)) | Общий доступ по email; SSO и RBAC не описаны ([teams](https://docs.pgdash.io/teams.md)) | Только Pro/Enterprise с годовой предоплатой; Pro — $200/мес за 5 серверов + $50 за каждый следующий ([pricing](https://pgdash.io/pricing)) |
| **pganalyze Enterprise Server** | Коллектор подключается к БД; полные снимки каждые 10 мин, некоторые данные чаще ([collector](https://pganalyze.com/docs/collector)) | Docker, EKS/AKS, LDAP; с августа 2026 multi-arch-образы ([pricing](https://pganalyze.com/pricing), [release](https://pganalyze.com/docs/enterprise/releases/2026-08-0)) | SSO, RBAC с областями прав ([permissions](https://pganalyze.com/docs/accounts/permissions)) | Цена договорная, годовой контракт, от 10 серверов ([pricing](https://pganalyze.com/pricing)) |
| **Percona PMM** | pmm-agent, экспортеры и QAN | Docker, Podman, Helm; стек Grafana + VictoriaMetrics + ClickHouse + PG ([GitHub](https://github.com/percona/pmm), [3.8](https://docs.percona.com/percona-monitoring-and-management/3/release-notes/3.8.0.html)) | LDAP и OAuth средствами встроенной Grafana; SAML только в Grafana Enterprise ([LDAP](https://www.percona.com/blog/enable-ldap-on-percona-monitoring-and-management-pmm/), [SAML](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/saml/)) | Open source, бесплатно; платная поддержка |
| **pgwatch** | Pull, метрики описываются SQL | Лёгкий Go-коллектор, хранилище PG, TimescaleDB или Prometheus, визуализация в Grafana ([pgwat.ch](https://pgwat.ch/latest/)) | Через Grafana | Open source (CYBERTEC) |
| **PoWA** | Pull на расширениях, локальный или удалённый режим | Требует `shared_preload_libraries` и рестарт, HypoPG ставится в каждую БД ([docs](https://powa.readthedocs.io/en/latest/), [issue](https://github.com/powa-team/powa-web/issues/123)) | Не заявлено | Open source |
| **PgHero** | Pull из одного приложения | Rails или Docker; без авторизации открывать нельзя, потому что дашборд умеет убивать сессии ([hex](https://readme.hex.pm/pghero/0.1.1)) | Не заявлено | MIT |
| **Zabbix / Prometheus + Grafana** | Агент или экспортер (Zabbix Agent 2, postgres_exporter) | Стандарт NOC; сборка своими силами ([Zabbix](https://www.zabbix.com/integrations/postgresql), [postgres_exporter](https://github.com/prometheus-community/postgres_exporter)) | Средствами Zabbix и Grafana | Бесплатно; Zabbix в 2022 году прекратил коммерческую деятельность в РФ, сам продукт остаётся open source ([PR](https://www.zabbix.com/de/pr/pr389)) |
| **Coroot** | eBPF-агенты + Prometheus + ClickHouse | Тяжёлый стек ([netdata guide](https://www.netdata.cloud/resources/best-postgresql-monitoring-tools/)) | SSO и RBAC в Enterprise | Community под Apache 2.0; Enterprise от $1 за ядро в месяц ([docs](https://docs.coroot.com/ai/)) |
| **Postgres Pro PPEM** | Агенты консоли управления (могут менять СУБД) и pgpro-otel-collector | Alt, Astra, RED OS, ROSA; есть инструкция для защищённой среды ([ОС](https://postgrespro.com/docs/ppem/current/ppem-supported-platforms-and-operating-systems.html), [secure](https://postgrespro.com/docs/ppem/current/ppem-installation-in-secure-environments.html)) | LDAP, AD, OIDC; аудит в syslog; mTLS ([LDAP](https://postgrespro.com/docs/ppem/current/ppem-configuring-integration-with-a-directory-service), [2.9](https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-9.html)) | Входит в Postgres Pro без доплаты; реестр №104 |
| **Tantor Platform** | Агенты консоли управления | Реестр №12905; Patroni и etcd ([Tproger](https://tproger.ru/articles/platformy-administrirovaniya-i-monitoringa-baz-dannyh-na-osnove-postgresql-259927)) | Несколько LDAP-каталогов в 6.4 ([CNews](https://zoom.cnews.ru/news/item/692962)) | Лицензия за ядро СУБД |
| **okmeter (on-prem)** | Агент с автообнаружением, хранилище совместимо с Prometheus ([Хабр](https://habr.com/ru/post/716486)) | On-prem или облако; продукт в реестре ([Хабр](https://habr.com/ru/post/716486)) | SAML SSO в Enterprise | SaaS 349–2499 ₽ за сервер в месяц, Enterprise по запросу ([okmeter](https://okmeter.io/)) |

### 4.2. Функциональность

| Продукт | Запросы и планы | Ожидания (ASH) | Советники | Алертинг и каналы | AI |
|---|---|---|---|---|---|
| **pgscope** | pg_stat_statements (топ-100), планы auto_explain только из текущего отчёта | Только Lock в момент снимка | Эвристики по индексам с SQL, диагностика | Правила на каждый сервер; email, Slack, PagerDuty, VictorOps, xMatters, webhook; нет «нет данных» | Облачный Claude — конфликт с ограничением |
| **pgDash SH** | Топ-100, 500 символов, auto_explain ([queries](https://docs.pgdash.io/queries.md)) | Не заявлено | Мало рекомендаций ([сравнение](https://pganalyze.com/comparison/pganalyze-vs-pgdash)) | Те же каналы, без тишины ([alerts](https://docs.pgdash.io/alerts.md)) | Только облачные OpenAI и Gemini, свой endpoint не настраивается ([ai](https://docs.pgdash.io/ai.md)) |
| **pganalyze ES** | Статистика планов, сравнение планов, Workbooks ([docs](https://pganalyze.com/docs/query-performance), [workbooks](https://pganalyze.com/docs/workbooks)) | Да ([connections](https://pganalyze.com/docs/connections)) | Index, Query, VACUUM Advisor ([indexing](https://pganalyze.com/docs/indexing-engine)) | Правила, отправляемые в направления (Destinations), подпись Standard Webhooks ([webhooks](https://pganalyze.com/docs/checks/webhooks)) | MCP-сервер для агентов пользователя ([mcp](https://pganalyze.com/docs/mcp)) |
| **PMM** | QAN; планы PG только через pg_stat_monitor, Explain для PG не поддерживается ([QAN](https://docs.percona.com/percona-monitoring-and-management/3/use/qan/panels/details.html)) | Топ запросов по IO wait в 3.9 ([3.9](https://docs.percona.com/percona-monitoring-and-management/3/release-notes/3.9.0.html)) | Advisors: CVE, EOL, конфигурация ([advisors](https://docs.percona.com/percona-monitoring-and-management/3/advisors/advisors-details.html)) | Шаблоны, тишина ([alert](https://docs.percona.com/percona-monitoring-and-management/3/alert/index.html)) | Не заявлено |
| **pgwatch** | Метрики pg_stat_statements, без планов | Не заявлено | Рекомендации вида `reco_add_index` ([pgwat.ch](https://pgwat.ch/latest/)) | Своего алертинга нет, только через Grafana ([netdata](https://www.netdata.cloud/resources/best-postgresql-monitoring-tools/)) | Нет |
| **PoWA** | pg_stat_statements + pg_stat_kcache ([kcache](https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_stat_kcache.html)) | pg_wait_sampling ([docs](https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_wait_sampling.html)) | Индексный советник по всей нагрузке: pg_qualstats + HypoPG ([rjuju](https://rjuju.github.io/postgresql/2020/01/06/pg_qualstats-2-global-index-advisor.html)) | Не заявлено | Нет |
| **PgHero** | EXPLAIN по кнопке, kill ([PgHero 2.0](https://ankane.org/pghero-2-0)) | Нет | Неиспользуемые индексы, отдельно Dexter ([Dexter](https://ankane.org/introducing-dexter)) | Не заявлено | Нет |
| **Zabbix / Prometheus** | Нет анализа планов и рекомендаций по PG ([postgres_exporter](https://github.com/prometheus-community/postgres_exporter)) | Нет | Готовые наборы правил ([awesome-prometheus-alerts](https://samber.github.io/awesome-prometheus-alerts/rules/databases/postgresql/)) | Триггеры; медиатипы Mattermost и Telegram ([Zabbix](https://www.zabbix.com/integrations/mattermost)) | Нет |
| **Coroot** | Инспекции PostgreSQL с указанием причин ([inspections](https://docs.coroot.com/inspections/postgres)) | Не заявлено | Причинные цепочки | Встроенные | AI RCA в Enterprise; любой OpenAI-совместимый endpoint ([config](https://docs.coroot.com/ai/configuration)) |
| **PPEM** | pgpro_pwr, общий доступ к планам ([2.4](https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-4.html)) | ASH и профиль ожиданий ([2.9](https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-9.html)) | Healthcheck Advisor в 2.10 ([CNews](https://zoom.cnews.ru/news/item/707524)) | Бета, только email ([alerts](https://postgrespro.com/docs/ppem/current/ppem-alerts.html)) | Ask Postgres: нужен интернет, в сертифицированных редакциях выключен ([docs](https://postgrespro.com/docs/ppem/current/ppem-askpostgres.html)) |
| **Tantor** | pg_store_plans в 6.3 ([Хабр](https://habr.com/ru/companies/tantor/news/1014610/)) | pg_wait_profile ([docs](https://docs.tantorlabs.ru/tdb/en/17_10/se/pg_wait_profile.html)) | Профили 1С/BI, CVE, pg_hba ([CNews](https://zoom.cnews.ru/news/item/692962)) | Telegram, Mattermost, YCHAT; тишина и массовое подтверждение ([CNews](https://zoom.cnews.ru/news/item/692962)) | Ассистент с настройкой `LLM_BASE_URL` в 6.4 ([CNews](https://zoom.cnews.ru/news/item/692962)) |
| **okmeter** | Запросы, автовакуум, блокировки ([Хабр](https://habr.com/ru/post/716486)) | Не заявлено | Сотни автопроверок ([okmeter](https://okmeter.io/)) | Telegram, SMS | Не заявлено |

**Чего нет в таблице, но важно для self-managed: HA и бэкапы.**
- Топология Patroni/etcd и переключения есть у Tantor и PPEM ([Tproger](https://tproger.ru/articles/platformy-administrirovaniya-i-monitoringa-baz-dannyh-na-osnove-postgresql-259927), [CNews](https://zoom.cnews.ru/news/item/707524)), дашборды Patroni — у pgwatch ([CYBERTEC](https://www.cybertec-postgresql.com/en/pgwatch-v6-dashboards-reimagined-and-a-reaper-that-doesnt-choke/)), обнаружение в Kubernetes — у Coroot ([docs](https://docs.coroot.com/databases/postgres/)).
- Мониторинг pg_probackup, pgBackRest и WAL-G есть у PPEM, Tantor и pgwatch ([PPEM 2.4](https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-4.html), [CNews](https://zoom.cnews.ru/news/item/692962), [pgwat.ch](https://pgwat.ch/latest/)).
- У pgscope и pgDash нет ни того, ни другого: failover виден только как событие. Это пробел ровно в целевом сегменте, поэтому `cluster-topology` и `backup-monitoring` подняты в дорожной карте.

### 4.3. Позиционирование против каждого

- **pgDash self-hosted.** Сборщик и push-модель у нас общие. pgDash отстаёт по ширине (Azure, pg_stat_io/lock, язык каналов) и по доступности self-hosted (только Pro/Enterprise, пакеты только под amd64, лицензионный файл даже для триала). Остаются пробелы паритета: работа под подпутём, пакеты и выбор AI-провайдера.
- **pganalyze Enterprise Server.** Это эталон глубины: три советника, ожидания, MCP, зрелые правила алертов. При этом коллектор требует подключения к БД, контракт годовой и рассчитан на 10+ серверов, вендор американский. Предположение, требующее проверки: российским компаниям такой продукт трудно закупить. Наш клин — малые и средние флоты, закрытый контур и РФ, плюс облегчённые версии их советников, построенные на уже собираемых данных.
- **PMM, pgwatch, Prometheus + Grafana.** Бесплатны, но тяжелы или требуют сборки своими силами, а PostgreSQL в PMM поддерживается хуже MySQL ([netdata](https://www.netdata.cloud/resources/best-postgresql-monitoring-tools/)). С ними не конкурируем, а встраиваемся: экспорт `/metrics` и шаблон Zabbix.
- **PoWA и PgHero.** У первого глубина за счёт расширений, у второго простота. Через секции агента мы можем взять расширения PoWA и не требовать при этом отдельного веб-стека.
- **Coroot.** AI RCA доступен только в платной Enterprise-версии, стек тяжёлый. У нас локальный AI работает «из коробки» и бесплатно в рамках лицензии pgscope.
- **PPEM и Tantor.** Это полноценные консоли управления с агентами записи, привязанные к своему форку и к поядерной или бандловой лицензии. С PPEM не стоит воевать в компаниях на Postgres Pro, где он бесплатен. Наша ниша — ванильный PostgreSQL, смешанные флоты, 1С и SMB, интеграторы.
- **okmeter.** Изначально SaaS с вариантом on-prem. Его цены (349–2499 ₽ за сервер в месяц) — полезный ценовой ориентир.

### 4.4. Идеи из облачных продуктов (только как источник)

- Детекция регрессий запросов в Datadog ([блог](https://www.datadoghq.com/blog/database-monitoring-query-regressions/)) → `query-regression`.
- Хеш нормализованного плана (plan_id) в Azure Query Store ([docs](https://learn.microsoft.com/en-us/azure/postgresql/monitor/concepts-query-store)) → `plan-history`.
- Сводка здоровья флота в AWS Database Insights ([docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Database-Insights-Fleet-Health-Dashboard.html)) → `fleet-organization`.
- Анализ блокировок в Database Insights ([docs](https://docs.aws.amazon.com/en_en/AmazonCloudWatch/latest/monitoring/Database-Insights-Lock-Analysis.html)) → `lock-history`.
- Наблюдение: облака продают глубокую диагностику (история планов и блокировок, ASH) в премиальных тарифах, например Enterprise Plus в Google ([Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/using-query-insights)). Это подтверждает ценность самих функций, но не задаёт позиционирование: облачные продукты не работают в закрытом контуре, и сравниваем мы себя только с self-hosted соседями из 4.3.

---

## 5. Self-hosted как принцип

### 5.1. Платформенные требования on-prem и air-gapped продукта

| Требование | Сейчас | Что сделать | Фича |
|---|---|---|---|
| Офлайн-установка: deb/rpm, Docker, Helm, офлайн-бандл, отечественные ОС | Только сборка из исходников (Go 1.26 + Node 20) | nfpm и systemd, multi-arch-образ, Helm-чарт (с первой фазы: Kubernetes — один из трёх целевых вариантов размещения), архив с pgscope + pgmetrics + pgdash; Astra SE, RED OS, ALT, ROSA | `offline-packaging` |
| Сбор в Kubernetes | Не описан | Готовые манифесты CronJob с pgmetrics + pgdash и секретом роли `pg_monitor`; рецепты для CloudNativePG (метка `cnpg.io/cluster`, [docs](https://cloudnative-pg.io/docs/1.27/monitoring)) и Patroni-операторов вроде Zalando postgres-operator ([GitHub](https://github.com/zalando/postgres-operator)); образы с pgmetrics кладутся во внутренний registry | `offline-packaging`, `collector-onboarding` |
| Офлайн-обновления | DDL выполняется при старте, без версий | Таблица `schema_version`, встроенные SQL-миграции, бэкап и откат, admin-CLI | `offline-packaging` |
| Ноль исходящих соединений по умолчанию | UI чистый; AI без ключа выключен, с ключом умеет только облачный Anthropic | AI выключен по умолчанию; справочники CVE и EOL поставляются с релизом; никакого phone-home | `ai-local-llm`, `upgrade-readiness`, `security-advisor` |
| HA самого pgscope | Невозможна: лимиты и защита от параллельной загрузки хранятся в памяти, `alert_state` пишется без блокировок | Состояние в БД, фоновые задачи под `pg_try_advisory_lock`, очередь через `SKIP LOCKED` | `self-ops`, `notification-delivery` |
| Бэкап собственных данных | Не описан | Сразу: инструкция в пакете (pg_dump или pgBackRest для БД pgscope — данные уже лежат в PostgreSQL). Затем экспорт и импорт конфигурации (правила, каналы, пользователи), сроки хранения по типу данных | `offline-packaging`, `self-ops` |
| Поддержка без удалённого доступа | Нет | Выгрузка обезличенного диагностического пакета (версии, настройки, находки, выборка рядов, без текстов запросов) одним файлом для вендора или консультанта; похожее есть в pgpro_pwr (экспорт и импорт снимков) и в PMM (PMM Dump, с 3.8 зашифрованный) ([pgpro_pwr](https://postgrespro.com/docs/postgrespro/current/pgpro-pwr), [PMM 3.8](https://docs.percona.com/percona-monitoring-and-management/3/release-notes/3.8.0.html)) | `self-ops`, `pii-redaction` |
| Документация офлайн | Внешних ссылок в UI почти нет, у находок короткие встроенные пояснения; подробных статей «почему и что делать» и стабильных ID нет | Объяснения каждой находки, проверки и алерта встроены в бинарь и открываются локально на RU/EN; у каждой находки стабильный ID | `findings-lifecycle`, `checks-catalog` |
| Малый ресурсный след | Бинарь лёгкий, но таблица `metrics` растёт быстро | Партиции, роллапы, упаковка в массивы; только PostgreSQL, без ClickHouse и Elasticsearch | `storage-scaling` |
| LDAP / AD / FreeIPA / Keycloak | Нет | go-ldap и go-oidc, сопоставление групп с ролями | `sso-ldap-oidc` |
| RBAC | owner/member | viewer, operator, admin, администратор инсталляции, право «видеть SQL» | `rbac-orgs` |
| Журнал аудита | Нет | Таблица только на добавление и поток в syslog/SIEM | `audit-log` |
| Каналы внутри периметра | SMTP (без 465) и webhook | Mattermost, Rocket.Chat, VK Teams on-prem, ntfy, Gotify; Telegram только опционально | `onprem-channels`, `notification-delivery` |
| Самонаблюдение | Нет | `/healthz`, `/readyz`, `/metrics`, структурированные логи | `self-ops` |
| Защита самой консоли | Открытая регистрация, SSRF, нет таймаутов HTTP | Выключатель регистрации, allowlist для вебхуков, таймауты, CSP, хеши токенов, mTLS на приёме через прокси; свой корпоративный CA и HTTP-прокси для всех исходящих соединений (SMTP, LDAPS, вебхуки, LLM) | `security-hardening` |

### 5.2. Что сейчас конфликтует с ограничением и как это исправить

1. **AI-чат через облачный Anthropic API (главный конфликт).** [`ai.go:85-200`](../ai.go) использует `anthropic-sdk-go` без альтернатив и отправляет туда тексты запросов, текущие запросы бэкендов, имена ролей, conninfo репликации и настройки. Маскирования нет. Обходного пути через `PGSCOPE_AI_BASE_URL` на практике нет: запрос использует beta-параметры Anthropic (effort, server-side fallback, cache control), которые OpenAI-совместимые локальные серверы не понимают, а модель по умолчанию — облачная `claude-opus-5-5` ([`ai.go:92-106`](../ai.go)).
   **Исправление:** слой провайдеров. Основной провайдер — OpenAI-совместимый `/v1/chat/completions` внутри периметра: [Ollama](https://docs.ollama.com/api/openai-compatibility), [vLLM](https://docs.vllm.ai/en/v0.21.0/serving/openai_compatible_server/), llama.cpp server, LiteLLM-шлюз. Российские модели: открытые веса GigaChat 3 (10B-A1.8B, MIT, запуск в vLLM — [llmrun](https://llmrun.dev/model/ai-sage-gigachat3-10b-a1-8b-base)) и YandexGPT 5 Lite 8B ([kod.ru](https://kod.ru/yandexgpt-open-source-new-models)); корпоративный GigaChat в контуре заказчика подключается через прокси gpt2giga, который сам переводит формат OpenAI ([Сбер](https://developers.sber.ru/docs/ru/gigachain/tools/utilities/gpttogiga-proxy-server)), потому что собственный API GigaChat совместим с OpenAI лишь частично ([Сбер](https://developers.sber.ru/docs/ru/gigachat/guides/compatible-openai)). По умолчанию AI выключен. Перед отправкой данные маскируются, есть предпросмотр того, что уйдёт в модель. Anthropic и другие облачные API остаются опцией там, где политика разрешает интернет. Подробности — в разделах 7.12 и 10.
2. **Интеграции с облачными управляемыми БД (AWS RDS/CloudWatch, Azure).** Метрики облаков забирает pgmetrics (флаг `--aws-rds-dbid`), сам pgscope в облако не ходит. Поэтому прямого нарушения нет, но это и не наш фокус. Существующее оставляем как есть и не развиваем. Никаких Yandex Managed, Database Insights API или UI для Enhanced Monitoring.
3. **SaaS-каналы уведомлений (Slack, PagerDuty, VictorOps, xMatters).** Они остаются как опция, но по умолчанию в документации и мастере настройки предлагаются on-prem каналы. URL PagerDuty сейчас зашит в код ([`alerts.go:848-911`](../alerts.go)) — его стоит вынести в настройку, чтобы работали прокси и шлюзы.
4. **Telegram.** Только опциональный канал с HTTP/SOCKS5-прокси или своим base URL. В 2026 году он в РФ практически недоступен ([Meduza](https://meduza.io/feature/2026/04/10/telegram-prakticheski-nedostupen-v-rossii-pomoch-mogut-proksi-s-nedavnimobnovleniem-messendzhera-oni-dolzhny-rabotat-namnogo-luchshe), [vc.ru](https://vc.ru/id5779154/2795944-blokirovka-telegram-api-v-rossii)).
5. **Справочные данные (CVE, EOL, удалённые параметры, особенности форков).** Они встраиваются в бинарь и обновляются вместе с релизом, без проверок обновлений по сети. Справочник между релизами устаревает, и UI должен честно показывать его дату.
6. **Лицензирование (бизнес-решение).** Если оно появится, то только офлайн-файлом лицензии, без проверки по сети. Иначе мы повторим требование pgDash получать файл у отдела продаж даже для триала, только хуже.

### 5.3. Правило для всех новых фич

Каждая фича проходит проверку из пяти пунктов:

1. Работает ли она без интернета?
2. Если она обращается к чему-то внешнему, есть ли у неё выключатель и локальная альтернатива?
3. Не добавляет ли она тяжёлую зависимость сверх PostgreSQL?
4. Не требует ли она хранить учётные данные к БД? Если требует, она опциональна и выключена по умолчанию.
5. Можно ли измерить её успех без телеметрии?

---

## 6. Боли пользователей

Таблица ниже отсортирована по сочетанию цены последствий и частоты. В последней колонке указано, какие фичи из списка закрывают боль.

| # | Боль | Свидетельства | Фичи |
|---|---|---|---|
| 1 | **Медленно назревающие аварии.** Wraparound XID и MultiXact на часы останавливают запись. Место в MultiXact members даже не выводится как метрика, поэтому дашборды выглядят здоровыми до самого простоя. | [Metronome](https://metronome.com/blog/root-cause-analysis-postgresql-multixact-member-exhaustion-incidents-may-2025), [Sentry](https://blog.sentry.io/transaction-id-wraparound-in-postgres), [Mailchimp](https://mailchimp.com/what-we-learned-from-the-recent-mandrill-outage/), [Хабр](https://habr.com/ru/articles/919982/) | `exhaustion-forecasts`, `xmin-horizon` |
| 2 | **Очередь блокировок при миграциях.** ALTER встаёт за долгим или idle-in-transaction читателем и замораживает таблицу. `lock_timeout` не задан, алерта на многочасовые запросы нет. | [LLM Gateway, окт. 2026](https://llmgateway.io/blog/incident-report-october-19-2026), [Autumn](https://useautumn.com/blog/post-mortem-database-outage-caused-by-collation-migration-locking-conflict.md), [Xata](https://xata.io/blog/migrations-and-exclusive-locks), [GoCardless](https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/) | `lock-history`, `xmin-horizon`, `safe-ddl` |
| 3 | **Неактивные слоты репликации** (чаще всего CDC) держат WAL, пока не кончится диск. | [Morling](https://morling.dev/blog/insatiable-postgres-replication-slot), [dev.to](https://dev.to/sasikumart/postgres-almost-outage-postmortem-the-hidden-dangers-of-replication-slots-and-autovacuum-2nem), [Netdata](https://www.netdata.cloud/guides/postgres/postgres-replication-slot-bloat/) | `replication-health`, `exhaustion-forecasts`, `alert-catalog` |
| 4 | **Исчерпание подключений и насыщение пулера**, которые усугубляют failover и циклы рестартов. | [DBA.SE](https://dba.stackexchange.com/questions/69438/psql-fatal-sorry-too-many-clients-already), [GitLab](https://gitlab.com/gitlab-com/gl-infra/production/-/issues/19464) | `alert-catalog` (PgBouncer, Pgpool, % подключений) |
| 5 | **Внезапная смена плана** после ANALYZE, роста данных, релиза или апгрейда, когда нет истории планов для сравнения. | [DBA.SE](https://dba.stackexchange.com/questions/335830/what-is-the-postgres-equivalent-of-sql-servers-query-store), [Reddit](https://www.reddit.com/r/PostgreSQL/comments/16tmukv/major_slowdown_after_upgrade/), [PGConf.EU 2025](https://www.postgresql.eu/events/pgconfeu2025/sessions/session/7112-tracking-plan-shapes-over-time-with-plan-ids-and-the-new-pg_stat_plans) | `plan-history`, `query-regression`, `query-window-analytics` |
| 6 | **Автовакуум трудно понять и настроить.** Раздувание и многочасовые агрессивные вакуумы выглядят случайными. | [DBA.SE](https://dba.stackexchange.com/questions/21068/aggressive-autovacuum-on-postgresql), [Coroot](https://coroot.com/blog/lets-break-autovacuum-in-postgres/) | `vacuum-advisor`, `xmin-horizon` |
| 7 | **Шум алертов.** Статичные пороги, сработки на плановых работах, нет тишины. Metronome прямо пишет, что усталость от алертов задержала реакцию. | [Metronome](https://metronome.com/blog/root-cause-analysis-postgresql-multixact-member-exhaustion-incidents-may-2025), [Хабр](https://habr.com/en/posts/952394) | `alert-noise-controls`, `alert-conditions-v2` |
| 8 | **Push-модель молчит, если отчёты перестали приходить.** pgDash не предупреждает об этом. | [Healthchecks.io](https://blog.healthchecks.io/hp-rewrite/16ddd04e14f6e9c04d4f8dba06e127a7), [pgDash alerts](https://docs.pgdash.io/alerts.md) | `no-data-alert` |
| 9 | **Тихие сбои бэкапов и архивации WAL**, которые обнаруживаются только при восстановлении. | [ITNEXT](https://itnext.io/when-the-watchman-cant-see-how-a-silent-backup-failure-almost-stayed-silent-forever-98ccc9597043), [Netdata](https://www.netdata.cloud/guides/postgres/postgres-wal-archive-failures/) | `backup-monitoring` |
| 10 | **Побочные эффекты failover.** Пулер смотрит на старый primary, CDC молча встаёт. В Kubernetes переключения делает оператор (CloudNativePG, Patroni в Zalando), и без понятия «кластер» мониторинг видит лишь разрозненные поды. | [GitLab](https://gitlab.com/gitlab-com/gl-infra/production/-/work_items/20154), [OneUptime](https://oneuptime.com/blog/post/2026-09-18-pgbouncer-old-primary-after-cloudnativepg-failover/markdown), [Palark](https://palark.com/blog/patroni-postgresql-logical-replication-failover.md) | `cluster-topology`, `replication-health` |
| 11 | **Опасные советы по индексам в кластере.** Индекс, который не используется на primary, нужен запросам на репликах; его удаление по совету мониторинга роняет чтение. Счётчики после сброса статистики или рестарта тоже вводят в заблуждение. | [pganalyze 2026-02](https://pganalyze.com/docs/enterprise/releases/2026-02-0), [index_unused](https://pganalyze.com/docs/checks/schema/index_unused), [postgres.ai](https://postgres.ai/docs/postgres-howtos/performance-optimization/indexing/how-to-find-unused-indexes) | `index-hygiene`, `cluster-topology` |
| 12 | **Метрики без объяснений.** Без DBA сырые pg_stat_* никто не читает. | [Т-Банк, Хабр](https://habr.com/ru/companies/tbank/articles/886488/), [HN](https://news.ycombinator.com/item?id=39877258) | `findings-lifecycle`, `checks-catalog`, AI |
| 13 | **Логи читаются только локально.** Лог-функции pgmetrics работают лишь при запуске на хосте БД, syslog и journald не поддерживаются. | [pgmetrics #33](https://github.com/rapidloop/pgmetrics/issues/33), [pgmetrics log](https://pgmetrics.io/docs/log.html) | `log-analytics` |
| 14 | **Приватность и AI.** Схема и запросы уходят в чужой LLM, агенту дают живой SQL. | [Supabase MCP](https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta/), [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) | `ai-local-llm`, `ai-governance`, `pii-redaction`, `mcp-server` |
| 15 | **Специфика РФ.** Отключены Slack ([Computerworld](https://www.computerworld.com/article/3654168/slack-suspends-access-for-russia-based-customers.html)) и Claude ([Anthropic](https://www.anthropic.com/supported-countries)), заблокирован Telegram ([Meduza](https://meduza.io/feature/2026/04/10/telegram-prakticheski-nedostupen-v-rossii-pomoch-mogut-proksi-s-nedavnimobnovleniem-messendzhera-oni-dolzhny-rabotat-namnogo-luchshe)), флоты переехали на форки. | см. ссылки | `onprem-channels`, `ai-local-llm`, `fork-awareness` |
| 16 | **1С на PostgreSQL.** Нет аналога Profiler; временные таблицы засоряют pg_stat_statements и раздувают каталог; источник проблем — конфигурация. | [ИТС 1С](https://its.1c.ru/db/content/metod8dev/src/developers/scalability/troubleshooting/i8106011.htm), [Tantor, Хабр](https://habr.com/ru/companies/tantor/articles/930038/), [Infostart](https://infostart.ru/1c/articles/2487972/) | `1c-name-mapping`, `1c-workload`, `config-advisor` |
| 17 | **Цена и тарифные ограничения.** У pganalyze self-hosted есть только в Enterprise. У pgDash self-hosted доступен только с Pro и годовой предоплатой. Tantor лицензируется за ядро. | [G2 pganalyze](https://g2.com/products/pganalyze/reviews), [pgDash](https://pgdash.io/self-hosted), [Tproger](https://tproger.ru/articles/platformy-administrirovaniya-i-monitoringa-baz-dannyh-na-osnove-postgresql-259927) | Ценообразование (вне кода) |

---

## 7. Приоритизированный список фич: топ-15

**Правило отбора.** Кандидаты с benefit ≥ 3,0 отсортированы по priority, ближайшие дубли объединены. Из-за порога на benefit в список не попали `prometheus-export` (2,05) и `index-hygiene` (2,85): они дешёвые, но дают мало пользы, и перенесены в «Быстрые победы». `wait-event-profile` и `query-regression` взяты вместо `plan-insights`, `config-advisor` и `fork-awareness` (1,32 — тоже выше 1,28) за счёт benefit 3,85; минимальная часть `fork-awareness` (распознать форк и не считать wraparound по 32 битам) всё равно идёт в первую фазу вместе с 7.1 и 7.3. `ai-local-llm` обязательна независимо от рейтинга из-за ограничения self-hosted. Вне рейтинга в первую фазу идут два исправления: `index-hygiene` этап 0 (опасный совет удалить индекс, раздел 3.2) и `security-hardening` этап 1 (SSRF, перехват инвайтов).

**Формат оценок:** V — value, F — freq, D — demand, Δ — differentiation, E — effort, R — risk. Затем benefit / cost → **priority**.

### 7.1. `xmin-horizon` — кто держит горизонт очистки (алерт «вакуум заблокирован»)

**Что сделать.** Детектор называет самого старого держателя горизонта. Им может быть:
- сессия с `backend_xmin` (долгая или idle in transaction);
- `xmin` или `catalog_xmin` слота;
- реплика с hot_standby_feedback (`backend_xmin` в исходящей репликации).

Показываются возраст горизонта в транзакциях и минутах, график, готовый SQL (`pg_terminate_backend`, `pg_drop_replication_slot`) с предупреждениями и алерт «горизонт старше N минут».

**Проблема.** Одна забытая сессия раздувает все таблицы и приближает wraparound. В инциденте LLM Gateway вакуум был заблокирован около 8 часов, и ни один алерт не сработал ([постмортем](https://llmgateway.io/blog/incident-report-october-19-2026)).

**У кого есть.**
- pganalyze: проверка xmin horizon ([check](https://pganalyze.com/docs/checks/vacuum/xmin_horizon), [VACUUM Advisor](https://pganalyze.com/docs/vacuum-advisor/bloat)).
- Coroot называет держателя горизонта ([inspections](https://docs.coroot.com/inspections/postgres)).
- Большинство self-hosted инструментов этого не умеют.

**Оценки:** V5 · F2 · D4 · Δ3 · E1 · R2 → 3,90 / 1,25 → **3,12**.

**Архитектура и зависимости.** Все нужные поля уже есть в отчёте (`backends`, `replication_slots`, `replication_outgoing`, `oldest_active_xid`). Нужны расчёт возраста по модулю 2³², ряд и метрика в каталоге алертов ([`alerts.go:126-269`](../alerts.go)). `pg_prepared_xacts` pgmetrics не собирает, этот держатель появится на втором этапе через `collector-agent`. Для форков с 64-битными XID (Postgres Pro Enterprise) ETA до wraparound по 32 битам будет ложным, поэтому в ту же поставку входит минимальный детект форка по полю `full_version` (вывод `version()`, его присылает pgmetrics) и характерным параметрам: на таких серверах показываем возраст горизонта в минутах и не строим ETA по XID. Полная поддержка — в `fork-awareness`. Блокирующих зависимостей нет.

**Как измерить успех.** На стенде три сценария (idle in transaction, брошенный слот, hot_standby_feedback с долгим запросом на реплике) распознаются в 100% случаев за 1–2 отчёта. На пилотах считаем долю случаев, где держатель найден без ручного SQL, и долю серверов с включённым правилом.

### 7.2. `no-data-alert` — сервер перестал присылать отчёты

**Что сделать.** Фоновый планировщик сравнивает время последнего отчёта с медианой интервалов у каждого сервера, PgBouncer и Pgpool.
- Если отчётов нет N интервалов (по умолчанию в 3 раза дольше ожидаемого), поднимается алерт, который снимается сам при следующем отчёте.
- Остальные алерты сервера помечаются как устаревшие (серым), а не застывают в «зелёном».
- Правило включено по умолчанию.

**Проблема.** Это самая опасная дыра. Если падает хост БД или cron либо меняется пароль, ничего не срабатывает, и остальные алерты теряют смысл ([Grafana о missing data](https://grafana.com/docs/grafana/latest/alerting/best-practices/missing-data/)).

**У кого есть.** Prometheus (`absent`, `up == 0`) ([functions](https://prometheus.io/docs/prometheus/latest/querying/functions/)), nodata в Zabbix, здоровье коллектора в pganalyze ([2026-05](https://pganalyze.com/docs/enterprise/releases/2026-05-0)). В pgDash такого нет ([alerts](https://docs.pgdash.io/alerts.md)).

**Оценки:** V5 · F2 · D5 · Δ1 · E1 · R2 → 3,75 / 1,25 → **3,00**.

**Архитектура и зависимости.** Это первый цикл, запускаемый по времени (ticker рядом с `retentionLoop`). Он работает под `pg_try_advisory_lock`, чтобы при нескольких экземплярах не было дублей, и избегает гонки с `afterReport` за `alert_state` через блокировку строки. Этот планировщик потом используют `alert-conditions-v2`, `alert-noise-controls`, дайджесты и `self-ops`.

**Как измерить успех.** На стенде с остановкой cron, хоста и сменой пароля уведомление приходит не позже 3 интервалов (около 15 минут при 5-минутном cron). При одиночной задержке отчёта ложных срабатываний нет. Правило активно на 100% серверов.

### 7.3. `exhaustion-forecasts` — прогнозы исчерпания (диск, WAL, XID/MultiXact, последовательности)

**Что сделать.** Робастная регрессия Тейла–Сена по рядам, бейджи «закончится через ~N дней» и условие алерта «ETA < N дней». Прогнозы строятся для:
- свободного места на ФС, табличных пространств и БД;
- pg_wal с разбивкой причин;
- скорости расхода XID и MultiXact с ETA до `autovacuum_freeze_max_age`, failsafe и жёсткого предела;
- штормов anti-wraparound на статичных таблицах (с советом выполнить `VACUUM FREEZE` заранее).

На втором этапе добавляются последовательности int4 и размер `pg_multixact/members`.

**Проблема.** Полный диск, wraparound и переполнение int4 назревают днями. У Metronome дашборды показывали меньше 50%, пока место в members заканчивалось ([разбор](https://metronome.com/blog/root-cause-analysis-postgresql-multixact-member-exhaustion-incidents-may-2025)). Похожий разбор есть на русском ([Хабр](https://habr.com/ru/articles/919982/)).

**У кого есть.** pganalyze (скорость расхода XID и MXID, [freezing](https://pganalyze.com/docs/vacuum-advisor/freezing)), Coroot (wraparound). В Prometheus то же делают вручную через `predict_linear` ([docs](https://prometheus.io/docs/prometheus/latest/querying/functions/)).

**Оценки:** V5 · F2 · D4 · Δ3 · E2 · R2 → 3,90 / 2,00 → **1,95**.

**Архитектура и зависимости.**
- Этап 1 работает на существующих рядах (`ts:disk_used`, размеры, возраст XID) плюс `age_relfrozenxid` по таблицам в `extractMetrics`. Это почти бесплатно: поле ложится в ту же jsonb-строку.
- Этап 2 (возраст MultiXact, `last_value` последовательностей, размер `pg_multixact`) ждёт `collector-agent`.
- Мягкая зависимость от `alert-conditions-v2` (условие-прогноз).
- Риск — ложные ETA после разовых массовых загрузок. Его снижают минимальная длина истории, доверительный интервал и подавление после скачков.

**Как измерить успех.** На истории пилотов прогноз предупреждает не позже чем за 7 дней до порога. Доля ложных ETA (прогноз «меньше 7 дней», который не сбылся) ниже 10%. За время пилота нет неожиданных заполнений диска.

### 7.4. `alert-catalog` — покрытие алертами и пакет правил по умолчанию

**Что сделать.** Сделать алертируемыми:
- PgBouncer и Pgpool: `cl_waiting`, `maxwait`, насыщение пула, backend down, сумма `pool_size` против `max_connections`;
- находки Diagnostics;
- load, память и swap;
- `wal_status` и удерживаемый WAL слота;
- возраст XID таблицы, сбой архивации, процент подключений, checksum failures, ожидание блокировки, истечение пароля, ошибки подписок, долгий вакуум.

Новый сервер автоматически получает версионированный пакет из 25–30 правил с разумными порогами, который можно редактировать.

**Проблема.** Многие инциденты, которые Diagnostics уже видит, замечает только тот, кто открыл UI. Новый сервер стартует с нулём правил, то есть остаётся без мониторинга и никто этого не замечает.

**У кого есть.** awesome-prometheus-alerts ([rules](https://samber.github.io/awesome-prometheus-alerts/rules/databases/postgresql/)), шаблоны PMM ([docs](https://docs.percona.com/percona-monitoring-and-management/3/alert/index.html)), триггеры Zabbix ([шаблон](https://www.zabbix.com/integrations/postgresql)), автопроверки okmeter ([okmeter](https://okmeter.io/)), check-up по умолчанию в pganalyze ([checks](https://pganalyze.com/docs/checks/)).

**Оценки:** V5 · F3 · D4 · Δ2 · E2 · R2 → 3,85 / 2,00 → **1,93**.

**Архитектура и зависимости.** Новая метрика в `catalog` занимает 5–10 строк плюс перевод. Пакет — JSON, встроенный в бинарь и применяемый при создании сервера. Сейчас `afterReport` вызывается только для postgres-отчётов без source ([`ingest.go:153-155`](../ingest.go)), поэтому PgBouncer и Pgpool нужен отдельный ключ состояния. Метрики-скорости (дедлоки в минуту и т. п.) зависят от `alert-conditions-v2`, мгновенные можно выпускать сразу. Включать пакет по умолчанию на всех серверах можно только вместе с этапом 1 `alert-noise-controls` (флаг «включено», «заглушить до…», окна обслуживания по серверу и группе, использует планировщик P3): иначе первое же плановое обслуживание даст поток ложных уведомлений, и пользователь начнёт удалять правила.

**Как измерить успех.** Доля серверов с активными правилами — 100% (сейчас у новых серверов 0%). На стенде сценарии «слот unreserved», «архивация падает», «пул насыщен» дают алерт за 1–2 отчёта. По опросу пилотов не менее 70% сработок признаны полезными.

### 7.5. `change-timeline` — аннотации и таймлайн изменений на графиках

**Что сделать.**
- Выводить на все графики события, которые pgscope уже обнаруживает: рестарт, смена версии, параметры, роли, индексы, таблицы, failover.
- Ручные аннотации.
- Деплои из CI через `POST /api/v1/annotation` (после `api-tokens`).
- Таймлайн по параметру и по таблице.
- Кнопка «сравнить час до и после».

**Проблема.** Большинство инцидентов следуют за изменениями: по данным Google SRE, около 70% сбоев ([SRE book](https://sre.google/sre-book/introduction/)). Сейчас изменения видны только списком и в уведомлениях.

**У кого есть.** PoWA + pg_track_settings ([docs](https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_track_settings.html)), pgwatch Change Events ([dashboards](https://pgwat.ch/latest/gallery/dashboards.html)), история параметров в Tantor 6.4 ([CNews](https://zoom.cnews.ru/news/item/692962)).

**Оценки:** V4 · F4 · D3 · Δ2 · E2 · R1 → 3,35 / 1,75 → **1,91**.

**Архитектура и зависимости.** События уже лежат в `events` ([`alerts.go:461-764`](../alerts.go)), а все графики проходят через один `Chart.tsx`, поэтому метки делаются плагином uPlot за несколько дней. API-аннотации зависят от `api-tokens`, кнопка «до/после» — от `reports-period-compare`. Выпускать поэтапно.

**Как измерить успех.** Метки есть на 100% графиков. На 5–10 пилотных разборах время «найти изменение перед деградацией» сравнивается с базовой линией до внедрения. Отдельно смотрим, как пользуются кнопкой «до/после».

### 7.6. `query-window-analytics` — запросы за выбранное окно

**Что сделать.**
- Страница Queries считает топ по дельтам за выбранный интервал, а не по итогам с момента сброса.
- Учитываются сбросы отдельных записей (`stats_since`, `minmax_stats_since` в PG17) и `toplevel`.
- Ранжирование по времени I/O, temp, WAL, планированию и JIT; показываются «блоки на строку» и «строки на вызов».
- Панели pg_stat_kcache и pg_stat_monitor появляются, только если пришли соответствующие секции.
- Подсказки по флагам pgmetrics `--statements-limit` и `--sql-length`.

**Проблема.** Запрос, который деградировал за последний час, прячется за долгоживущими тяжёлыми ([`Activity.tsx:24-65`](../web/src/pages/server/Activity.tsx)). Ограничение pgDash «топ-100, 500 символов» ([docs](https://docs.pgdash.io/queries.md)) унаследовано и у нас.

**У кого есть.** PoWA ([pg_stat_kcache](https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_stat_kcache.html)), PMM 3.9 с топом по CPU, IO wait и temp ([RN](https://docs.percona.com/percona-monitoring-and-management/3/release-notes/3.9.0.html)), pg_profile ([GitHub](https://github.com/zubkov-andrei/pg_profile)), PgHero.

**Оценки:** V4 · F5 · D4 · Δ2 · E2 · R2 → 3,75 / 2,00 → **1,88**.

**Архитектура и зависимости.** Нужен серверный эндпоинт дельт по рядам `q:*` и новые поля в `extractMetrics` (pgmetrics их уже присылает). Если запрос выпадал из топ-N, дельта неполная, и это нужно явно помечать. Для окон в 30 дней понадобятся роллапы из `storage-scaling`, для окон до 7 дней хватит текущей схемы. Блокирующих зависимостей нет.

**Как измерить успех.**
- Эндпоинт отвечает за 1 с или быстрее на окне 24 часа для сервера с 5 тыс. запросов.
- В сценарии «регрессия за последний час» запрос попадает в топ-5 окна, хотя в накопительном топе его нет.
- Доля открытий Queries с изменённым окном.

### 7.7. `onprem-channels` — уведомления внутри периметра

**Что сделать.**
- Нативные каналы: Mattermost и Rocket.Chat (incoming webhook), VK Teams on-prem (Bot API на своём домене), ntfy и Gotify.
- Шаблонный generic-webhook для SMS-шлюзов и прочего.
- Опционально, где разрешён интернет: Telegram через прокси или свой base URL, MAX, Пачка, Яндекс Мессенджер.

**Проблема.** В закрытых контурах и в РФ Slack и PagerDuty неприменимы, а Telegram в 2026 году почти заблокирован ([vc.ru](https://vc.ru/id5779154/2795944-blokirovka-telegram-api-v-rossii)). Дежурный должен получать алерт без выхода в интернет.

**У кого есть.** Tantor: Telegram, Mattermost, YCHAT ([CNews](https://zoom.cnews.ru/news/item/692962)). Zabbix: медиатип Mattermost ([Zabbix](https://www.zabbix.com/integrations/mattermost)). pgEdge: Mattermost ([docs](https://docs.pgedge.com/ai-dba-workbench/v1-0-0/)). Grafana contact points. ntfy — open source ([GitHub](https://github.com/binwiederhier/ntfy)); у VK Teams есть Go-клиент Bot API ([bot-golang](https://pkg.go.dev/github.com/mail-ru-im/bot-golang)).

**Оценки:** V4 · F3 · D4 · Δ3 · E2 · R2 → 3,65 / 2,00 → **1,83**.

**Архитектура и зависимости.** Каждый канал — отдельная ветка в `deliver()` ([`alerts.go:860-888`](../alerts.go)), 10–30 строк без новых зависимостей. Модель канала расширяется с одного `target` до пары «токен + chat id». Прокси задаётся через `http.Transport.Proxy`. Мягкая зависимость от `notification-delivery` (очередь и повторы). Защита от SSRF из `security-hardening` должна пропускать внутренние адреса из allowlist, иначе on-prem каналы сломаются.

**Как измерить успех.** Доставка в Mattermost и VK Teams on-prem подтверждена на стенде без интернета. Считаем долю пилотов, где основной канал — on-prem мессенджер. С outbox за пилот не теряется ни одного сообщения.

### 7.8. `replication-health` — здоровье репликации и слотов

**Что сделать.**
- Отставание делится на получение и применение WAL; показываются статус WAL receiver и пауза replay (`pg_stat_recovery`, PG19).
- Конфликты восстановления разбиваются по причинам `confl_*` с подсказками; отмечается риск `recovery_prefetch` на дисках с лимитом IOPS.
- Для логической репликации — ошибки apply/sync и счётчики конфликтов PG18/19 с алертом.
- Для слотов — `wal_status`, `safe_wal_size`, `conflicting`, удерживаемый WAL и прогноз.
- Исправить ключ рядов standby: сейчас разные реплики склеиваются под именем `walreceiver`.

**Проблема.** Логическая репликация ломается молча. Брошенный CDC-слот — классическая причина полного диска ([Morling](https://morling.dev/blog/insatiable-postgres-replication-slot)). Свежий пример скрытой опасности — `recovery_prefetch` ([ardentperf, окт. 2026](https://ardentperf.com/2026/10/20/postgres-recovery_prefetch-considered-harmful-and-causing-outages/)).

**У кого есть.** Coroot (причины лага, [inspections](https://docs.coroot.com/inspections/postgres)), шаблон Zabbix с конфликтами восстановления ([Zabbix](https://www.zabbix.com/integrations/postgresql)), проверки репликации в pganalyze.

**Оценки:** V4 · F3 · D4 · Δ2 · E2 · R2 → 3,45 / 2,00 → **1,73**.

**Архитектура и зависимости.** pgmetrics 1.19+ уже собирает эти данные ([v1.19.0](https://github.com/rapidloop/pgmetrics/releases/tag/v1.19.0), [model.go](https://github.com/rapidloop/pgmetrics/blob/master/model.go)), их нужно вынести в ряды и каталог алертов. Смена ключа standby ([`ingest.go:208-216, 287-301`](../ingest.go)) требует миграции истории. Зависит от `alert-catalog`.

**Как измерить успех.** На стенде с двумя и более физическими репликами у каждой свой ряд. Сценарии «слот unreserved», «подписка с ошибкой», «пауза replay» дают алерт. Склеенных рядов нет.

### 7.9. `1c-name-mapping` — имена объектов 1С вместо `_AccumRg15195`

**Что сделать.**
- Для каждой БД загружается CSV или JSON, полученный из `ПолучитьСтруктуруХраненияБазыДанных(, Истина)` или из поставляемой обработки.
- Рядом с таблицами, индексами и полями (на страницах, в тексте запросов, блокировках и отчётах о раздувании) показываются имена объектов 1С.
- Сравнение регистронезависимое.

**Проблема.** В базах 1С все таблицы названы обезличенно, и топ тяжёлых запросов ничего не говорит 1С-разработчику ([ИТС 1С](https://its.1c.ru/db/content/metod8dev/src/developers/scalability/troubleshooting/i8106011.htm)).

**У кого есть.** Платные инструменты сопоставления на Infostart ([Infostart](https://infostart.ru/1c/tools/306894/)) и Softpoint PerfExpert ([Хабр](https://habr.com/en/companies/softpoint/articles/734534)). Среди PG-мониторингов такого почти нет.

**Оценки:** V3 · F3 · D4 · Δ4 · E2 · R2 → 3,45 / 2,00 → **1,73**.

**Архитектура и зависимости.** Таблица соответствий хранится в БД pgscope, подстановка идёт на фронтенде, сбор данных не меняется. Риски — поддержка обработки `.epf` и производительность браузера на маппингах из сотен тысяч полей; при необходимости словарь можно загружать с сервера по требованию. Зависимостей нет.

**Как измерить успех.** На эталонной базе 1С:ERP не менее 95% таблиц и индексов в топах получают имена. Пилоты у 2–3 франчайзи. Время сопоставления запроса с объектом метаданных до и после (интервью).

### 7.10. `fleet-organization` — имена, теги, группы, поиск, рейтинг здоровья

**Что сделать.**
- Отображаемые имена, теги, окружения, группы, избранное, глобальный поиск, сохранённые представления. Кластеры из `cluster-topology` становятся автоматическими группами.
- Рейтинг здоровья по находкам, ETA, регрессиям, репликации и бэкапам.
- Список «требует внимания», тепловая карта, сводка по группам.

**Проблема.** Когда серверов сотни, главный вопрос — куда смотреть первым. Сейчас имя сервера жёстко задаётся аргументом CLI ([`api.go:11-50`](../api.go)). Т-Банк описывает модель «около 10 DBA на 10 000 инстансов» за счёт самообслуживания команд ([Хабр](https://habr.com/ru/companies/tbank/articles/886488/)).

**У кого есть.** pganalyze Server Groups ([docs](https://pganalyze.com/docs/accounts/server_groups)), метки в PMM ([filters](https://docs.percona.com/percona-monitoring-and-management/3/use/qan/panels/filters.html)), Coroot, Tantor. Идея из облака: сводка здоровья флота в AWS ([docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Database-Insights-Fleet-Health-Dashboard.html)).

**Оценки:** V3 · F4 · D4 · Δ2 · E2 · R2 → 3,20 / 2,00 → **1,60**.

**Архитектура и зависимости.** Атрибуты задаются только в UI, потому что контракт pgdash не передаёт теги. Переименовать сервер можно только через отображаемое имя: ключ приёма `(owner_id, kind, name)` менять нельзя. Рейтинг первой версии строится по `summary` и `alert_state`, полный — после `findings-lifecycle`. Группы и теги потом используют `alert-fleet-routing` и `config-advisor`.

**Как измерить успех.** На флоте из 50+ серверов «требует внимания» выводит серверы с открытыми crit-находками на первом экране. Считаем число тегов и групп на пилотах и время навигации по интервью.

### 7.11. `lock-history` — история блокировок и очередь за DDL

**Что сделать.**
- Цепочки блокировок из снимков агрегируются в историю: топ корневых блокировщиков и их запросов за период.
- Алерт на долгое ожидание блокировки.
- Алерт на «очередь за DDL», когда сессия ждёт ACCESS EXCLUSIVE, а за ней выстраиваются другие. В алерте указан корень очереди и совет: `lock_timeout` или отмена DDL.
- Копируемый SQL `pg_cancel_backend` и `pg_terminate_backend`.
- С агентом — дополнительные снимки блокировок между отчётами.

**Проблема.** Инцидент с блокировками заканчивается раньше, чем кто-то успевает посмотреть. Без истории не видно, что виновник — один и тот же повторяющийся джоб ([LLM Gateway](https://llmgateway.io/blog/incident-report-october-19-2026), [Xata](https://xata.io/blog/migrations-and-exclusive-locks)).

**У кого есть.** pganalyze Connection Traces ([docs](https://pganalyze.com/docs/connections)), живой просмотр в pg_activity ([GitHub](https://github.com/dalibo/pg_activity)), PPEM. Идея из облака: анализ блокировок в AWS ([docs](https://docs.aws.amazon.com/en_en/AmazonCloudWatch/latest/monitoring/Database-Insights-Lock-Analysis.html)).

**Оценки:** V4 · F2 · D4 · Δ3 · E2 · R3 → 3,50 / 2,25 → **1,56**.

**Архитектура и зависимости.** `locks[].waitstart` и `blocking_pids` уже есть в отчёте. При приёме корни очередей пишутся в новую небольшую таблицу, группировка идёт по `query_id` (PG14+). Зависит от `alert-catalog`. Очереди короче 5 минут ловит только `collector-agent` (мягкая зависимость). Честное ограничение: на снимках видны лишь длинные инциденты.

**Как измерить успех.** На стенде сценарий «ALTER TABLE за долгим читателем» длиной не меньше одного интервала даёт алерт с правильным корнем. За неделю история выявляет повторяющегося виновника. На пилотах считаем долю инцидентов с блокировками, где корень найден по истории.

### 7.12. `ai-local-llm` — локальная модель через OpenAI-совместимый endpoint (обязательная)

**Что сделать.**
- Слой провайдеров из двух реализаций:
  - `openai-compatible`: `net/http`, `/v1/chat/completions`, стриминг через SSE, tools по возможности;
  - существующий `anthropic`.
- Настройки: base URL, ключ, модель.
- По умолчанию AI выключен и не делает исходящих запросов.
- Бюджет контекста под небольшие окна локальных моделей.
- Если модель не умеет tool calling, работает режим «отчёт в промпте».
- Рецепт для документации: Ollama или vLLM на соседнем GPU-хосте, открытые модели: GigaChat 3 10B-A1.8B под MIT ([llmrun](https://llmrun.dev/model/ai-sage-gigachat3-10b-a1-8b-base)), YandexGPT 5 Lite 8B ([kod.ru](https://kod.ru/yandexgpt-open-source-new-models)), Qwen. Для корпоративного GigaChat в контуре — прокси gpt2giga ([Сбер](https://developers.sber.ru/docs/ru/gigachain/tools/utilities/gpttogiga-proxy-server)).
- Облачные API — только опция. В провайдере `anthropic` убрать жёсткий дефолт `claude-opus-5-5` и beta-параметры из общего пути: модель задаётся явно.

**Проблема.** Это прямой конфликт с ограничением self-hosted. Air-gapped и регулируемые заказчики (152-ФЗ, КИИ) не могут отправлять метаданные БД во внешний LLM, а Anthropic не обслуживает Россию ([список](https://www.anthropic.com/supported-countries)). Для сравнения, Ask Postgres в PPEM требует интернета и выключен в сертифицированных редакциях ([docs](https://postgrespro.com/docs/ppem/current/ppem-askpostgres.html)).

**У кого есть.**
- Coroot: любой OpenAI-совместимый endpoint ([config](https://docs.coroot.com/ai/configuration)).
- Tantor 6.4: `LLM_BASE_URL` ([CNews](https://zoom.cnews.ru/news/item/692962)).
- pgEdge AI DBA Workbench: Ollama, air-gapped ([docs](https://docs.pgedge.com/ai-dba-workbench/v1-0-0/)).
- pgDash: только облачные OpenAI и Gemini ([docs](https://docs.pgdash.io/ai.md)).

**Оценки:** V3 · F3 · D4 · Δ3 · E2 · R3 → 3,25 / 2,25 → **1,44**. Балл занижает важность фичи: без неё AI-функция для целевой аудитории фактически мертва.

**Архитектура и зависимости.**
- `ai.go:85-200` жёстко привязан к `anthropic-sdk-go`, а `cfg.AIProvider` не используется ([`main.go:57`](../main.go)). Переменная `PGSCOPE_AI_BASE_URL` уже есть, её стоит переиспользовать как base URL OpenAI-совместимого провайдера.
- `aiContext()` кладёт в промпт десятки килобайт JSON (40 таблиц, 40 индексов, 60 бэкендов), что не помещается в окно типичной 7–14B-модели. Нужны отбор контекста и лимиты.
- Ollama поддерживает stream и tools в OpenAI-режиме ([docs](https://docs.ollama.com/api/openai-compatibility)), vLLM тоже ([docs](https://docs.vllm.ai/en/v0.21.0/serving/openai_compatible_server/)).
- Зависимостей нет. Фича открывает `ai-history-tools`, кнопку «Объяснить план» в `plan-insights`, `ai-incident-analysis` и `mcp-server`.

**Как измерить успех.**
- При установке по умолчанию ноль исходящих соединений (проверка tcpdump на стенде).
- Чат работает с Ollama и vLLM на изолированном стенде.
- Эталонный набор из ~40 вопросов RU/EN по фикстурам отчётов: доля корректных ответов локальной модели сравнивается с базовой линией облачной.
- Время до первого токена со стримингом — не больше 3 с.

### 7.13. `backup-monitoring` — бэкапы и архивация WAL

**Что сделать.**
- **Этап 1.** Алерты по `pg_stat_archiver`: последняя ошибка новее последнего успеха, растёт `failed_count`, растёт число `.ready`-файлов или размер pg_wal.
- **Этап 2.** Приём JSON из `pgbackrest info --output=json`, `wal-g backup-list --json` и `pg_probackup show --format=json` через обёртку агента. По ним видны последний полный и инкрементальный бэкап, валидация, размер, окно PITR (от самого старого восстановимого бэкапа до последнего заархивированного WAL), разрывы WAL и тепловая карта успешных бэкапов за год. Алерты: «последний успешный бэкап старше N часов», «окно PITR короче политики», «архивация отстаёт больше N сегментов». В Kubernetes у CloudNativePG сбой архивации определяется по тому же `pg_stat_archiver` ([runbook](https://kb.vshn.ch/app-catalog/service/postgresql/runbooks/system/CNPGPostgreSQLArchiveFailing.html)), так что его покрывает этап 1; статус базовых бэкапов оператора забирает CronJob-обёртка, pgscope к API кластера не обращается.

**Проблема.** Сбои бэкапа молчат до момента восстановления ([ITNEXT](https://itnext.io/when-the-watchman-cant-see-how-a-silent-backup-failure-almost-stayed-silent-forever-98ccc9597043)). Сбой `archive_command` копит WAL до заполнения диска ([Netdata](https://www.netdata.cloud/guides/postgres/postgres-wal-archive-failures/)). Аудиторы требуют доказательств, что бэкапы работают.

**У кого есть.** PPEM для pg_probackup ([2.4](https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-4.html)), тепловые карты в Tantor 6.4 ([CNews](https://zoom.cnews.ru/news/item/692962)), Coroot, источники pgBackRest и WAL-G в pgwatch ([pgwat.ch](https://pgwat.ch/latest/)), check_pgbackrest ([GitHub](https://github.com/pgstef/check_pgbackrest)). Сводного мониторинга сразу по трём инструментам в нейтральном продукте почти нет.

**Оценки:** V5 · F2 · D4 · Δ3 · E3 · R2 → 3,90 / 2,75 → **1,42**.

**Архитектура и зависимости.** Для этапа 1 данные уже есть в отчёте, работа займёт несколько дней и зависит только от `alert-catalog`. Этапу 2 нужны эндпоинт по образцу `/reportpgbouncer`, три парсера стабильных JSON-форматов и `collector-agent` на хосте с репозиторием бэкапов.

**Как измерить успех.** Этап 1: на стенде сломанный `archive_command` даёт алерт за 1–2 отчёта. Этап 2: возраст последнего успешного бэкапа виден на 100% серверов с агентом. Есть экспорт отчёта для аудитора.

### 7.14. `wait-event-profile` — профиль ожиданий (ASH-lite)

**Что сделать.**
- **Этап 1 («ASH-lite»).** На каждом снимке считать бэкенды по `wait_event_type`/`wait_event`, БД, пользователю и `query_id` и строить график «средних активных сессий».
- **Этап 2.** Принимать кумулятивный профиль `pg_wait_sampling` через агент и пересчитывать его в дельты с учётом сбросов. Добавить вкладку «Ожидания» на странице запроса.

**Проблема.** Сейчас из ожиданий считаются только Lock. На вопрос «чего ждала БД в 14:03», с которого начинается любой разбор, ответа нет. Российские DBA привыкли к ASH в PPEM и pg_profile ([CNews](https://zoom.cnews.ru/news/item/707524)).

**У кого есть.** PoWA ([pg_wait_sampling](https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_wait_sampling.html)), PPEM ([2.9](https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-9.html)), pg_profile, Tantor ([pg_wait_profile](https://docs.tantorlabs.ru/tdb/en/17_10/se/pg_wait_profile.html)), pganalyze ([docs](https://pganalyze.com/docs/connections)).

**Оценки:** V4 · F4 · D5 · Δ2 · E3 · R3 → 3,85 / 3,00 → **1,28**.

**Архитектура и зависимости.** Этап 1 занимает дни: `extractMetrics` уже перебирает `m.Backends`. Кардинальность ограничиваем: тип ожидания плюс топ событий. Этап 2 зависит от `collector-agent`, потому что pgmetrics не собирает `pg_wait_sampling` ([GitHub](https://github.com/postgrespro/pg_wait_sampling)). Это расширение входит в Postgres Pro и Tantor, так что фича хорошо ложится на российский рынок.

**Как измерить успех.** Этап 1: график есть на 100% серверов PG14+. Этап 2: на серверах с `pg_wait_sampling` профиль строится по `queryid`. В сценариях «IO-шторм» и «LWLock contention» доминирующее ожидание определяется верно.

### 7.15. `query-regression` — регрессии запросов по базовой линии и APDEX

**Что сделать.**
- Для каждого `queryid` строится базовая линия времени на вызов и частоты: медиана и MAD по часу недели, по дельтам между отчётами.
- Устойчивая регрессия (например, ×3 к базе три отчёта подряд при заметной доле нагрузки) ранжируется по доле нагрузки и связывается со сменой плана, конфигурации или схемы.
- Новый тип правила «регрессия запроса».
- APDEX для ключевых запросов и объектов 1С.

**Проблема.** Статический порог не замечает, что запрос стал выполняться не за 50, а за 400 мс. Текущая метрика «среднее время» накапливается с момента сброса и реагирует очень поздно ([`alerts.go:263-268`](../alerts.go)).

**У кого есть.** pganalyze New Slow Queries ([docs](https://pganalyze.com/docs/checks/queries/slowness)), APDEX в 1С:КИП ([ИТС](https://its.1c.ru/db/content/metod8dev/src/developers/scalability/methods/i8105807.htm)). Идея из облака: регрессии в Datadog ([блог](https://www.datadoghq.com/blog/database-monitoring-query-regressions/)).

**Оценки:** V4 · F3 · D4 · Δ4 · E3 · R3 → 3,85 / 3,00 → **1,28**.

**Архитектура и зависимости.**
- Ряды `q:db:queryid` уже есть, но база за недели истории по jsonb без роллапов будет медленной. На старте хватит окна в 7 дней, полная версия появится после `storage-scaling`.
- Нужна обработка сбросов pg_stat_statements и выпадений из топ-100.
- Зависимости: `alert-conditions-v2`, `change-timeline`; мягкая — `plan-history`.
- APDEX можно лишь аппроксимировать: pg_stat_statements даёт среднее и stddev, а не распределение. Это нужно честно указать в UI.

**Как измерить успех.** На стенде (`DROP INDEX`, перекос данных) регрессия обнаруживается за 3 отчёта или быстрее. На пилотах не менее 70% флагов признаны реальными. После сброса pg_stat_statements ложных срабатываний нет.

---

## 8. Быстрые победы и стратегические ставки

### 8.1. Быстрые победы (benefit высокий, effort ≤ 2)

| Фича | Benefit | E | Почему быстро | Срок* |
|---|---|---|---|---|
| `xmin-horizon` | 3,90 | 1 | Все поля уже в отчёте | 1 нед. |
| `no-data-alert` | 3,75 | 1 | Один цикл-планировщик и существующие каналы | 1 нед. |
| `exhaustion-forecasts` (этап 1) | 3,90 | 2 | Тейл–Сен над существующими рядами | 2 нед. |
| `alert-catalog` | 3,85 | 2 | 5–10 строк на метрику и JSON-пакет | 2 нед. |
| `query-window-analytics` | 3,75 | 2 | Эндпоинт дельт и новые поля в той же jsonb-строке | 2 нед. |
| `onprem-channels` | 3,65 | 2 | Ветка в `deliver()` на канал | 1–2 нед. |
| `lock-history` (по снимкам) | 3,50 | 2 | `blocking_pids` и `waitstart` уже в отчёте | 2 нед. |
| `replication-health` | 3,45 | 2 | pgmetrics 1.19+ уже собирает данные | 2 нед. |
| `1c-name-mapping` | 3,45 | 2 | Таблица соответствий и фронтенд | 1–2 нед. |
| `change-timeline` (без API) | 3,35 | 2 | События уже в `events`, плагин uPlot | 1 нед. |
| `ai-local-llm` | 3,25 | 2 | Клиент на `net/http` и SSE | 2 нед. |
| `plan-insights` | 3,25 | 2 | Правила над JSON-планом и статистикой таблиц ([pgMustard](https://pgmustard.com/docs), [pganalyze](https://pganalyze.com/docs/query-advisor/insights)) | 2 нед. |
| `fleet-organization` (v1) | 3,20 | 2 | Колонки и UI | 2 нед. |
| `wait-event-profile` (этап 1, ASH-lite) | 3,85 | ≈1 | Подсчёт по `m.Backends` | несколько дней |
| `backup-monitoring` (этап 1) | 3,90 | ≈1 | Только `pg_stat_archiver` | несколько дней |
| `alert-noise-controls` (этап 1) | 3,40 | ≈2 | Флаг «включено», «заглушить до…», окна обслуживания на планировщике P3; подтверждение и группировка — этап 2 | 1–2 нед. |
| `index-hygiene` (этап 0, исправление) | 2,85 | ≈1 | Не советовать DROP, если у сервера есть реплики или статистика сброшена недавно (`stats_reset` есть в отчёте); предупреждение рядом с SQL | несколько дней |
| `cluster-topology` (этап 1, без агента) | 3,70 | ≈2 | `system_identifier`, `timeline_id`, `is_in_recovery` и линии репликации уже в отчёте | 2 нед. |
| `collected-data-usage` | 2,65 | 2 | Поля PG18/19 уже приходят; повод к выходу PG19 19.11.2026 ([ClickHouse о PG19](https://clickhouse.com/blog/postgres-19-new-system-views)) | 1–2 нед. |
| `upgrade-readiness` (EOL-часть) | 2,70 | 2 | Справочник в бинаре; PG14 EOL 12.11.2026 ([versioning](https://www.postgresql.org/support/versioning/)) | 1 нед. |
| `prometheus-export` | 2,05 | 1 | Текстовый формат на stdlib; снимает возражение «ещё один изолированный инструмент» ([postgres_exporter](https://github.com/prometheus-community/postgres_exporter)) | несколько дней |

*Сроки указаны для одного инженера. Это ориентир с точностью ±50%.*

### 8.2. Стратегические ставки (высокая ценность, высокая стоимость или сильное отличие)

1. **Компаньон-коллектор (`collector-agent`, E5).** Без него не будет полноценных ожиданий, последовательностей, pg_hba, Patroni, бэкапов, pg_stat_kcache и раздувания каталога для 1С. Это 10–12 функций. Модель push сохраняется: небольшой Go-бинарь с ролью `pg_monitor`, без входящих соединений, отправка через отдельный эндпоинт с тем же ключом. Примеры подхода — PoWA, pgwatch, Zabbix Agent 2 ([PoWA](https://powa.readthedocs.io/en/latest/), [pgwatch](https://pgwat.ch/latest/), [Zabbix](https://www.zabbix.com/integrations/postgresql)).
2. **Интеллект по запросам.** Цепочка `plan-history` → `query-regression` → `plan-insights` → `index-advisor`: облегчённая версия трёх флагманов pganalyze на данных, которые уже приходят. Индексный советник можно построить на `pg_query_go` (BSD-3, [GitHub](https://github.com/pganalyze/pg_query_go)) или на варианте без cgo ([go-pgquery](https://pkg.go.dev/github.com/wasilibs/go-pgquery)). Сама pganalyze советует проверять каждое предложение на бенчмарке ([docs](https://pganalyze.com/docs/index-advisor/getting-started)), поэтому прозрачность здесь важнее точности.
3. **Отчёты в стиле AWR (`reports-period-compare`).** Привычный в РФ формат pg_profile/pgpro_pwr ([pgpro_pwr](https://postgrespro.com/docs/postgrespro/current/pgpro-pwr)). Эти отчёты служат ядром для `ai-incident-analysis`, сравнения «до и после» в `upgrade-readiness` и еженедельных дайджестов.
4. **Хранилище (`storage-scaling`).** Партиции, роллапы и упаковка в массивы прямо в PostgreSQL. pganalyze получила примерно в 55 раз более компактное хранение без отдельной TSDB ([блог](https://pganalyze.com/blog/extended-retention)). Это даёт 13+ месяцев истории и дешёвый self-hosting.
5. **Корпоративный доступ (`rbac-orgs`, `sso-ldap-oidc`, `audit-log`, `api-tokens`).** Без них нет закупок у корпораций и госсектора.
6. **AI на фактах (`ai-history-tools`, `mcp-server`, `ai-incident-analysis`) на локальных моделях.** Подробности в разделе 10.
7. **Цикл «советуй и проверяй» (`safe-ddl` + `proposed-actions`).** Линтер миграций знает реальные размеры таблиц, а после применения изменения его эффект измеряется. Конкуренты так не делают: они либо дают статичный CI-линтер ([Squawk](https://github.com/sbdchd/squawk)), либо применяют изменения автоматически.
8. **Пакет для 1С.** `1c-name-mapping` → `1c-workload` → профиль 1С в `config-advisor` → `1c-investigation`. Продаётся через партнёрскую сеть 1С (раздел 9).
9. **Кластеры, HA и Kubernetes (`cluster-topology`).** Для целевого сегмента (железо, ВМ, Kubernetes с Patroni или оператором) это базовая ожидаемая функция, а не отличие: она есть у Tantor и PPEM.
   - *Этап 1, без агента:* серверы с одинаковым `system_identifier` объединяются в кластер; роль берётся из `is_in_recovery`, связи — из исходящей и входящей репликации; смена `timeline_id` даёт таймлайн failover на графиках (`change-timeline`). Отсюда же сводное отставание реплик и данные для `index-hygiene` по всему кластеру.
   - *Этап 2, через агент:* Patroni REST API `/cluster` (участники, роли, лаг, запланированный switchover) и `/history` (история переключений) ([Patroni](https://patroni.readthedocs.io/en/latest/rest_api.html)), здоровье etcd, режим паузы. Для CloudNativePG — метки `cnpg.io/cluster` ([docs](https://cloudnative-pg.io/docs/1.27/monitoring)); Zalando postgres-operator построен на Patroni ([GitHub](https://github.com/zalando/postgres-operator)), поэтому покрывается тем же этапом.
   - *Чего не делаем:* switchover и управление кластером из pgscope. Это работа PPEM и Tantor и прямое противоречие модели «только чтение».

---

## 9. Российский рынок

Ниже — рекомендации с честной оценкой их стоимости.

1. **1С — главная ниша, которую соседи закрывают лишь частично.**
   - *Сделать сразу:* `1c-name-mapping` (1–2 недели).
   - *Сделать на следующем шаге:*
     - профиль 1С в `config-advisor`: mchar/fulleq/fasttrun, plantuner, `max_locks_per_transaction ≥ 256`, `standard_conforming_strings=off`, `pg_stat_statements.max` ([Postgres Pro для 1С](https://postgrespro.com/docs/postgrespro/15/one-c-additional-modules), [Infostart](https://infostart.ru/1c/articles/2487972/));
     - `1c-workload`: схлопывание запросов с временными таблицами и мониторинг раздувания `pg_attribute`/`pg_class`. В тесте Tantor TPS падал с 18,9 до 13,1 ([Хабр](https://habr.com/ru/companies/tantor/articles/930038/)). Задача стоит около месяца и для части данных требует агента.
   - *Отложить:* `1c-investigation` (связь с техжурналом). Это дорого (E4, R4), формат журнала меняется, а нишу уже занимают PerfExpert и Yellow Watcher ([Хабр](https://habr.com/en/companies/softpoint/articles/734534)).
   - *Канал продаж:* Tantor SE 1C продаётся только через дистрибуцию 1С. Партнёрская сеть и франчайзи с десятками клиентских баз, вероятно, основной путь и для нас. Это гипотеза, её нужно проверить.
2. **SSO и LDAP.** AD, FreeIPA и ALD Pro через LDAPS со своим CA; Keycloak, Avanpost FAM и Blitz через OIDC/SAML ([Avanpost](https://www.anti-malware.ru/reviews/Avanpost-FAM), [Blitz](https://www.anti-malware.ru/reviews/Blitz-Identity-Provider-5-31)). Стоимость 3–4 недели, но только после ролевой модели (`rbac-orgs`), иначе группам не на что сопоставляться. Особенности AD (вложенные группы, пейджинг) — главный риск. SAML можно отложить: Keycloak закрывает OIDC.
3. **Уведомления.** Mattermost (корпоративный TiMe в Т-Банке), VK Teams on-prem, Rocket.Chat — основа, примерно 2 недели вместе с очередью. Telegram, MAX, Пачку и Яндекс Мессенджер подключать опционально, через прокси. PagerDuty и xMatters из РФ почти не закупаются, вкладываться в них не нужно.
4. **On-prem LLM.**
   - Открытые модели: GigaChat 3 10B-A1.8B (MIT, [llmrun](https://llmrun.dev/model/ai-sage-gigachat3-10b-a1-8b-base)), YandexGPT 5 Lite 8B ([kod.ru](https://kod.ru/yandexgpt-open-source-new-models)) и Qwen через vLLM или Ollama.
   - Корпоративный GigaChat в контуре заказчика — через прокси gpt2giga, который принимает формат OpenAI ([Сбер](https://developers.sber.ru/docs/ru/gigachain/tools/utilities/gpttogiga-proxy-server)); нативный API GigaChat совместим с OpenAI лишь частично ([Сбер](https://developers.sber.ru/docs/ru/gigachat/guides/compatible-openai)). On-prem поставку YandexGPT и её API нужно подтверждать у вендора: публичной спецификации нет, OpenAI-совместимость описана только для облачного API.
   - *Честно о стоимости:* GPU оплачивает заказчик. Малые модели заметно слабее облачных, поэтому качество нужно мерить на русскоязычном эталонном наборе, а чат проектировать так, чтобы его ядром оставались детерминированные находки.
5. **Форки (`fork-awareness`).** Postgres Pro, Tantor, Pangolin, Jatoba: 64-битные XID, расширения из поставки, специфичные параметры, отчёт по ядрам для сверки поядерных лицензий. Кода немного (E2), но риск высокий (R4): для проверки нужны лицензированные сборки, а 64-битные XID ломают логику wraparound в `diag.go` ([Хабр](https://habr.com/ru/companies/postgrespro/articles/487590/)).
6. **Формат AWR и Zabbix.** `reports-period-compare` на русском с экспортом в самодостаточный HTML. `zabbix-integration` — шаблон с LLD поверх API, около недели после `api-tokens`. Zabbix в 2022 году прекратил коммерческую деятельность в РФ ([PR](https://www.zabbix.com/de/pr/pr389)), но как open source остаётся стандартом NOC ([Moscow Times](https://ru.themoscowtimes.com/2025/03/03/vrossii-nesmogli-zamenit-95-kriticheskogo-importnogo-po-a156792)).
7. **Комплаенс.**
   - Приказ ФСТЭК № 117 действует с 01.03.2026 и требует регистрировать и анализировать события ([Контур](https://kontur.ru/aegis/blog/82649-chto_menyaet_prikaz_fstek_117_i_kak_podgotovit_biznes)). Отсюда `audit-log` с потоком в syslog/SIEM (KUMA, MaxPatrol), около 1–2 недель.
   - 152-ФЗ: `pii-redaction` при приёме данных и запрет трансграничной передачи в AI.
   - Готовится проект требований ФСТЭК к ИИ ([ppt.ru](https://ppt.ru/news/nejroseti/fstek-podgotovila-proekt-novykh-trebovaniy-k-zashchite-informatsii-pri-ispolzovanii-ii)). Это ещё один аргумент за локальный AI, выключенный по умолчанию.
8. **Реестр российского ПО и сертификация — не код.** Для реестра нужны российское владение и права на ПО. Tantor (№12905), Kintsugi (№18302) и PerfExpert в нём есть. Это решение о структуре бизнеса. Сертификация ФСТЭК — многомесячный процесс с отдельным бюджетом. Чтобы не закрыть себе эту дорогу, технически готовиться можно уже сейчас: пакеты для Astra SE и RED OS, подпись ELF для замкнутой программной среды Astra, отсутствие исходящих соединений, журнал аудита.
9. **Цена (вне кода, но влияет на приоритеты).** PPEM входит в Postgres Pro бесплатно, поэтому в компаниях на Postgres Pro мы ему не конкуренты. Ориентиры: okmeter 349–2499 ₽ за сервер в месяц ([okmeter](https://okmeter.io/)), Tantor лицензируется за ядро ([Tproger](https://tproger.ru/articles/platformy-administrirovaniya-i-monitoringa-baz-dannyh-na-osnove-postgresql-259927)). Бесплатный уровень на 1–3 сервера поможет зайти в сегменты 1С и SMB.

---

## 10. AI: что строить поверх текущего чата

### 10.1. Исходная точка

Сейчас `ai.go` отправляет сжатый последний отчёт в кэшируемый системный промпт: топ-40 таблиц и индексов, топ-25 запросов, до 60 бэкендов. У чата нет истории, инструментов, маскирования и стриминга. Ответ приходит одним синхронным вызовом с лимитом 16 тыс. токенов, а модель по умолчанию — флагманская облачная. Рынок в 2025–2026 годах пришёл к схеме «детерминированные детекторы плюс LLM-рассказчик»:

- Index Advisor в pganalyze построен на модели ограничений, а Query Advisor — на экспертных правилах ([Query Advisor GA](https://pganalyze.com/blog/query-advisor-ga));
- советники Supabase — это SQL-линтеры ([Supabase](https://supabase.com/blog/security-performance-advisor));
- Coroot отправляет в LLM выводы, а не сырую телеметрию ([Coroot AI](https://docs.coroot.com/ai/overview)).

### 10.2. Что действительно полезно (по порядку)

1. **P0 — `ai-local-llm` и базовая часть `ai-governance`**: выключатель «AI выключен», предпросмотр того, что уйдёт в модель (это просто вывод `aiContext()`), квоты токенов. Устраняет конфликт с ограничением.
2. **P0 — детерминированные «умные» фичи, которым LLM не нужен вовсе:** `exhaustion-forecasts`, `query-regression`, `xmin-horizon`, `plan-insights` без AI-кнопки. По сути это и есть AI-функции рынка, только без модели. Робастной статистики (медиана и MAD по часу недели) достаточно. Классическое ML-обнаружение аномалий сворачивают даже облака: AWS закрывает DevOps Guru ([AWS](https://docs.aws.amazon.com/devops-guru/latest/userguide/devops-guru-end-of-support.html)).
3. **P1 — `ai-history-tools`.** Модель вызывает read-only инструменты над данными pgscope: ряды за период, сравнение двух отчётов, история алертов и изменений, планы, логи, диагностика. Это дешевле, чем класть весь отчёт в промпт, и критично для локальных моделей с маленьким окном. Сценарии расследования задаются на RU/EN. Диагностический SQL модель предлагает только по системным представлениям; пользователь выполняет его сам, а pgscope заранее проверяет, что запрос read-only.
4. **P1 — кнопка «Объяснить план» в `plan-insights`.** LLM получает план вместе с уже найденными анти-паттернами и пишет разбор на языке пользователя. Похожая функция есть в pgAdmin 4 9.13 ([pgAdmin](https://www.postgresql.org/about/news/pgadmin-4-v913-released-3253)).
5. **P2 — `ai-incident-analysis` («объяснить интервал»).** Детерминированно сравниваем окно с базой (ядро — `reports-period-compare`), а LLM только связывает найденные факты в рассказ и помечает гипотезы. Обогащение алертов запускается асинхронно после основной доставки, чтобы медленная локальная модель её не задерживала. Coroot продаёт аналог только в Enterprise ([Coroot](https://docs.coroot.com/ai/overview)).
6. **P2 — `mcp-server`.** Курируемые read-only инструменты: тот же слой, что в `ai-history-tools`, токены с областями, лимиты, выключатель. Выполнять произвольный SQL через него нельзя в принципе, потому что pgscope не хранит паролей к БД. Это повторяет главный аргумент pganalyze ([MCP](https://pganalyze.com/docs/mcp)). Спрос в РФ ниже, поэтому фича отложена.
7. **P2 — замкнутый цикл проверки (`proposed-actions`).** Рекомендация проходит путь «предложено → одобрено → применено (видно по следующему отчёту) → эффект измерен». Измеренный эффект — честный ответ на непроверяемые обещания вендоров вроде «до 10 раз быстрее» ([Blocks and Files](https://www.blocksandfiles.com/data-management/2026/10/07/dbtune-autonomous-optimization-blows-postgresql-bottlenecks-away/5301616)).

### 10.3. Что хайп или опасно (не делать)

- **Автономный тюнинг и автоматическое применение DDL.** OtterTune закрылся ([блог Павло](https://www.cs.cmu.edu/~pavlo/blog)), агент Replit удалил продовую БД ([eWeek](https://www.eweek.com/news/replit-ai-coding-assistant-failure/)), а Azure только рекомендует ([docs](https://learn.microsoft.com/en-us/azure/postgresql/monitor/concepts-autonomous-tuning)).
- **MCP с произвольным `execute_sql`.** Его «read-only» режим обходили через пакет с COMMIT ([Datadog Security Labs](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/)), а prompt injection остаётся нерешённой проблемой ([Willison](https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta/)).
- **Свободный NL→SQL по бизнес-схемам.** На Spider 2.0 решается около 21% задач ([arXiv](https://arxiv.org/abs/2411.07763)).
- **Непрерывный GenAI-анализ всего подряд.** Он дорог даже для pganalyze ([Query Advisor GA](https://pganalyze.com/blog/query-advisor-ga)), а в self-hosted платит заказчик своими GPU. Вызывать модель стоит только по событию и с кэшем.
- **Дашборды, сгенерированные AI**, и «AI DBA» как отдельный продукт. Отдельных агентов закрывают или перепрофилируют: Xata Agent архивирован ([GitHub](https://github.com/xataio/agent)), Tembo сменил профиль ([Founderpath](https://founderpath.com/resources/ry-walker-tembo-ai-developer-teammate-pivot)).

### 10.4. Риски AI на локальных моделях

- Окно контекста и качество tool calling сильно зависят от модели.
- Нужен эталонный набор вопросов RU/EN по фикстурам и прогон на каждом релизе.
- Без tool calling должен работать резервный режим.
- Generic LLM без опоры на факты даёт правдоподобные, но неверные первопричины ([D-Bot, VLDB](https://www.vldb.org/pvldb/vol17/p2514-li.pdf)). Поэтому каждый ответ ссылается на метрику и время отчёта, а при нехватке данных прямо говорит «недостаточно данных».

---

## 11. Архитектурные предпосылки

Формула ставит эти работы низко, но каждая открывает дорогу сразу нескольким функциям.

| # | Предпосылка | Что открывает | Оценка | Когда |
|---|---|---|---|---|
| P1 | CI, интеграционные тесты HTTP и БД, нагрузочный тест на больших отчётах | Безопасные изменения авторизации, хранилища, схемы | 2–3 нед. | Сейчас, первой |
| P2 | Версионированные миграции (`schema_version`, embed SQL, откат) | `storage-scaling`, `rbac-orgs`, офлайн-обновления (`offline-packaging`) | 1–2 нед. | Сейчас |
| P3 | Планировщик по времени под advisory lock | `no-data-alert`, «держится N минут», тишина и окна, напоминания, дайджесты, HA | 1 нед. | Сейчас |
| P4 | Состояние и события на уровне отдельного алерта (since, pending, ack) вместо снимка набора | `alert-conditions-v2`, `alert-noise-controls`, `alert-fleet-routing`, dedup по алерту, аналитика шума | 2–3 нед. | Сейчас → Далее |
| P5 | Outbox доставки с повторами и журналом | `notification-delivery`, `onprem-channels`, `self-ops`, подпись Standard Webhooks ([spec](https://www.standardwebhooks.com/)) | 1–2 нед. | Сейчас |
| P6 | Слой LLM-провайдеров, затем слой read-only инструментов | `ai-local-llm`, `ai-history-tools`, `mcp-server`, `ai-incident-analysis` | 2 + 3 нед. | Сейчас / Позже |
| P7 | Роли (viewer/operator/admin на shares), затем API-токены, затем организации | `prometheus-export`, `zabbix-integration`, CI-аннотации, `sso-ldap-oidc`, `safe-ddl` в CI, `mcp-server`, `alert-fleet-routing` | 4–8 нед. | Далее |
| P8 | Компаньон-коллектор и эндпоинт секций | `wait-event-profile`, `backup-monitoring` (этап 2), `exhaustion-forecasts` (этап 2), `security-advisor`, `checks-catalog`, `cluster-topology` (этап 2: Patroni/etcd), `1c-workload`, `schema-memory-insights`, `lock-history` (субсэмплы), `agent-jobs` | 2–3 мес. | Далее |
| P9 | Хранилище: партиции, роллапы, серверные эндпоинты вместо сырого отчёта в браузере | Долгая история, `reports-period-compare`, базы для `query-regression`, право «видеть SQL» и доступ по БД в `rbac-orgs`, быстрые страницы | 1–2 мес. | Далее → Позже |
| P10 | SQL-парсер (`pg_query_go` или вариант без cgo) | `index-advisor`, `safe-ddl`, `pii-redaction`, нормализация для 1С, проверка SQL от AI | 1–2 нед. интеграции + сборка | Позже (начало) |

**Порядок.** P1 → P2 → P3 → P5 → P4 → P6a (провайдеры) → P7 (роли → токены) → P8 → P9 → P10 → P6b (инструменты) → P7c (организации).

Разделение запросов: без P9 право «видеть SQL» не реализовать честно. Сейчас браузер получает весь сырой отчёт ([`api.go:52-73`](../api.go)), и скрыть текст запросов можно только серверной фильтрацией.

---

## 12. Дорожная карта

*Допущение: 3 инженера. При 1–2 инженерах фазы растягиваются примерно вдвое, порядок сохраняется. Зависимости соблюдены; мягкие зависимости отмечены как «этап 1 / этап 2».*

### Сейчас (0–3 месяца): «Мониторинг, которому можно доверить ночь» и self-hosted-гигиена

| Тема | Фичи (id) | Комментарий |
|---|---|---|
| Платформа-0 | P1 (CI и тесты), P2 (миграции), `offline-packaging` этап 1 (deb/rpm через nfpm, systemd, multi-arch-образ, Helm-чарт, манифесты CronJob для сбора в Kubernetes, офлайн-бандл, подпуть, инструкция по бэкапу БД pgscope), `security-hardening` этап 1 (выключатель регистрации, allowlist вебхуков, таймауты HTTP, CSP, хеши токенов, свой CA и прокси для исходящих) | Входной билет в закрытые контуры |
| Алертинг-1 | `no-data-alert` → `alert-conditions-v2` этап 1 (скорости, «держится N», гистерезис; без сезонности) → `alert-noise-controls` этап 1 (флаг «включено», «заглушить до…», окна обслуживания) → `alert-catalog` (пакет по умолчанию включается только после тишины и окон); `notification-delivery`; `onprem-channels` | P3, P4 (начало), P5 |
| Диагностика без новых коллекторов | `xmin-horizon`, `exhaustion-forecasts` этап 1 (вместе с детектом форков с 64-битными XID из `fork-awareness`), `replication-health`, `backup-monitoring` этап 1, `wait-event-profile` этап 1 (ASH-lite), `index-hygiene` этап 0 (исправление опасного совета DROP INDEX) | Всё на уже приходящих данных |
| Сроки рынка | `collected-data-usage` (к 19.11.2026), `upgrade-readiness` EOL-часть (к 12.11.2026) | Маркетинговый повод «PG19 с первого дня» |
| Запросы | `query-window-analytics`, `change-timeline` (без API) | |
| AI | `ai-local-llm` и базовый `ai-governance` (выключатель, предпросмотр, квоты) | Устраняет конфликт с ограничением |
| RU | `1c-name-mapping` | Пилоты у 1С-франчайзи |

**Ёмкость фазы.** По оценкам из 8.1 список выше занимает около 36 инженер-недель (±50%) при ёмкости около 39 (3 инженера × 13 недель), то есть запаса почти нет. Если фаза не помещается, первыми в «Далее» переезжают `query-window-analytics` и `1c-name-mapping` (второй — если пилоты с 1С ещё не подтверждены, см. вопрос 4 в разделе 14). Алертинг, исправления безопасности и `index-hygiene` этап 0 не переносятся.

**Критерии выхода из фазы:**
- установка без интернета на Astra/RED OS/Ubuntu и в Kubernetes через Helm с нулём исходящих соединений;
- 100% серверов покрыты пакетом правил и алертом «нет данных», плановые работы глушатся без удаления правил;
- AI работает с Ollama или vLLM на изолированном стенде.

### Далее (3–6 месяцев): доступ, агент, глубина по запросам

| Тема | Фичи (id) |
|---|---|
| Доступ и платформа | `rbac-orgs` этап 1 (роли на shares, администратор инсталляции) → `api-tokens` → `sso-ldap-oidc`; `audit-log`; `self-ops` (healthz, метрики, HA под advisory lock); `storage-scaling` этап 1 (партиции и часовые роллапы) |
| Агент | `collector-agent` v1: секции pg_wait_sampling, sequences, pg_hba, Patroni, JSON от pgBackRest/WAL-G/pg_probackup, pg_stat_kcache. Затем `wait-event-profile` этап 2, `backup-monitoring` этап 2, `exhaustion-forecasts` этап 2 |
| Шум и флот | `alert-noise-controls` этап 2 (подтверждение, группировка, повторы), `findings-lifecycle`, `fleet-organization`, `lock-history` |
| HA | `cluster-topology` этап 1 (кластеры по `system_identifier`, роли, линии репликации, таймлайн failover — без агента) |
| Запросы | `plan-history` → `plan-insights` → `query-regression` (база на 7 дней) |
| Интеграции | `prometheus-export`, `zabbix-integration`, API-часть `change-timeline` (аннотации из CI) |
| RU | `fork-awareness`, `config-advisor` (профили OLTP, BI, 1С и дрейф по флоту) |

**Критерии выхода из фазы:**
- вход через AD/Keycloak, роль viewer, журнал аудита в SIEM;
- агент в пилоте на 10+ серверах с суммарной нагрузкой на БД меньше 1% CPU;
- регрессии запросов ловятся на стенде.

### Позже (6–12+ месяцев): советники, AWR, AI на фактах, enterprise

| Тема | Фичи (id) |
|---|---|
| Отчёты и сравнение | `reports-period-compare` (AWR-подобные отчёты, HTML/PDF, дайджесты), сравнение «до и после» в `upgrade-readiness`, `charts-dashboards` (произвольный период, зум, свои панели) |
| Советники | P10 (SQL-парсер) → `safe-ddl` → `index-advisor` (связь «запрос ↔ таблица», затем подбор и скрипт HypoPG); `vacuum-advisor`; `proposed-actions`; `index-hygiene` полностью (сумма `idx_scan` по всем узлам кластера, после `cluster-topology` этап 1) |
| Флот и HA | `cluster-topology` этап 2 (Patroni REST и etcd из агента), `alert-fleet-routing` (после организаций в `rbac-orgs` этап 2), `collector-onboarding` (страница здоровья сбора, мастер с флагами pgmetrics `--role`, `--statements-limit`, `--sql-length`; опциональный pull-режим) |
| Наблюдаемость | P10 → `pii-redaction` (маскирование литералов в текстах запросов, планах и логах при приёме) → `log-analytics` (классификация, история, syslog-приёмник); `security-advisor`; `checks-catalog`; `schema-memory-insights` |
| AI | P6b → `ai-history-tools` → `mcp-server`, `ai-incident-analysis`; полный `ai-governance` (маскирование через `pii-redaction`, журнал через `audit-log`) |
| RU | `1c-workload`, затем `1c-investigation` (только при подтверждённом спросе пилотов) |
| Опционально и осторожно | `agent-jobs` (EXPLAIN, HypoPG, cancel — выключено по умолчанию, только с RBAC и аудитом), `workbooks`, `query-tags`, `security-hardening` этап 2 (2FA, mTLS на приёме), `storage-scaling` этап 2 (13+ месяцев, упаковка в массивы), `offline-packaging` этап 2 (сертифицируемые репозитории, подпись пакетов под ЗПС Astra) |

---

## 13. Чего не делать (и почему)

1. **Развивать мониторинг облачных управляемых БД** (Cloud SQL, Yandex Managed, VK Cloud, Neon, Supabase, API Database Insights, UI для RDS Enhanced Monitoring) и строить позиционирование на закрытии AWS Performance Insights. Это противоречит фокусу на self-managed PostgreSQL. Существующие AWS/Azure-метрики остаются как есть.
2. **Принимать логи через облачные API** (Yandex Cloud Logging, Pub/Sub, Heroku drain). Локальная альтернатива — syslog/journald/OTLP в `log-analytics`.
3. **Публичные онлайн-инструменты для лидогенерации** (онлайн-визуализатор EXPLAIN, Index Advisor). Для них нужен наш собственный хостинг, то есть SaaS.
4. **Облачный LLM как основной провайдер.** Облако допустимо только как опция.
5. **Автономный тюнинг, автоматическое применение DDL, агенты, которые сами открывают PR.** Небезопасно, и рынок от этого уходит (раздел 10.3).
6. **Проверка рекомендаций на клоне инстанса** в стиле облачных Assessments. Нужна инфраструктура клонирования. Достаточно скрипта HypoPG и проверки на staging.
7. **MCP с произвольным SQL** и запись в БД из агента по умолчанию. Это убивает главное преимущество — «только чтение, без входящих соединений».
8. **Pull-режим по умолчанию.** Он делает pgscope хранилищем учётных данных к продовым БД. Pull-режим допустим только как опция.
9. **Тяжёлые зависимости** (ClickHouse, Elasticsearch, обязательный TimescaleDB). Наше преимущество — один бинарь и PostgreSQL.
10. **Нативные Teams, Opsgenie, синхронизация тредов Slack и инцидентов PagerDuty, SLO с burn-rate.** Это SaaS-ориентированные функции с малой отдачей. Нужное закрывается generic-webhook и APDEX в `query-regression`.
11. **Telegram как основной канал.** Только опционально через прокси.
12. **Дашборды, сгенерированные AI.** Хватит пользовательских дашбордов.
13. **Ценовая конкуренция с PPEM в компаниях на Postgres Pro**, где он бесплатен.
14. **Переписывать то, что уже есть:** базовые диагностики, SQL для индексов, change alerts, локализацию, дашборды PgBouncer и Pgpool. Развивать их нужно через `checks-catalog`, `findings-lifecycle`, `index-hygiene` и `change-timeline`.
15. **Управлять кластером из pgscope** (switchover через Patroni, рестарты, изменение конфигурации). Это территория PPEM и Tantor и прямое нарушение модели «только чтение»; pgscope показывает топологию и готовит команды, но не выполняет их.

---

## 14. Риски и открытые вопросы

**Риски**

1. **Ставка на агента меняет модель безопасности.** Даже read-only агент на хосте БД ИБ будет проверять отдельно. Нужны минимальная роль `pg_monitor`, отсутствие входящих портов, подписанные бинари и открытый список SQL-запросов агента.
2. **Без телеметрии продукт растёт вслепую.** Нужен отчёт об использовании, который администратор выгружает сам, программа пилотов и стенды с внедрением сбоев. Метрики успеха в разделе 7 привязаны к стендам и пилотам.
3. **Зависимость от pgmetrics и RapidLoop.** pgDash, судя по всему, в режиме поддержки. Схема PG19 есть только в master, проблема с ping в PgBouncer открыта ([#78](https://github.com/rapidloop/pgmetrics/issues/78)), есть падения на сильно партиционированных таблицах ([#56](https://github.com/rapidloop/pgmetrics/issues/56)). Нужен план Б: собственный форк pgmetrics или перенос новых данных в секции агента.
4. **Сборка с cgo.** `pg_query_go` требует cgo, что усложняет deb/rpm и мультиархитектурную сборку. Вариант на wasm без cgo нужно проверить по скорости.
5. **Миграция живых установок хранилища** (партиции, роллапы) без простоя и без потери 90 дней истории.
6. **Качество локальных LLM на русском** и доступность GPU у заказчиков. Ядро ценности должно оставаться детерминированным.
7. **Совместимость с контрактом pgdash CLI.** Ключи с областями обязаны сохранять формат из 22 символов.
8. **Ложные срабатывания новых детекторов** (ETA, регрессии) подорвут доверие сильнее, чем их отсутствие. Новые детекторы выпускать в режиме «только показывать» и включать алерт после калибровки на пилотах.
9. **Доступ к форкам.** Для проверки `fork-awareness` нужны лицензированные Postgres Pro Enterprise, Tantor SE и Pangolin.
10. **Источники по РФ частично рекламные** (новости вендоров), так что спрос на 1С-функции и каналы через франчайзи — гипотеза.

**Открытые вопросы к владельцу продукта**

1. Делаем ли опциональный `collector-agent` или остаёмся строго на pgmetrics? От этого зависит судьба 10–12 функций.
2. Какова модель лицензирования без phone-home (офлайн-файл лицензии?) и будет ли бесплатный уровень на 1–3 сервера?
3. Идём ли в реестр российского ПО (структура владения) и когда начинаем сертификацию?
4. Каков целевой сегмент первого года: 1С/SMB через франчайзи, корпоративные смешанные флоты или международные dev-команды? От ответа зависят веса `1c-*`, `sso-ldap-oidc` и `mcp-server`/`query-tags`.
5. Сколько инженеров доступно? Дорожная карта рассчитана на трёх.
6. Какую минимальную локальную модель считаем поддерживаемой (размер, контекст) и кто готовит русскоязычный эталонный набор вопросов?
7. Поддерживаем ли Citus (данные уже приходят) или исключаем его из фокуса?
8. Какие Kubernetes-операторы поддерживаем первыми (CloudNativePG, Zalando, Percona, StackGres) и есть ли у пилотов Patroni вне Kubernetes? От этого зависит объём этапа 2 `cluster-topology`.

---

## Приложение A. Все оценённые кандидаты (по priority)

Статус: «частично» — что-то уже есть, «нет» — отсутствует. V — value, F — freq, D — demand, Δ — differentiation, E — effort, R — risk.

При ревизии 26.10.2026 переоценён `cluster-topology`: V 3→4, D 4→5. Причина — фокус на self-managed PostgreSQL с Patroni и Kubernetes, функция есть у Tantor и PPEM, failover — боль №10 в разделе 6. Priority вырос с 1,02 до 1,23 (с 44-го места на 29-е). Остальные оценки не менялись; таблица пересортирована.

| # | id | Название | Категория | Статус | V | F | D | Δ | E | R | Benefit | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | xmin-horizon | Кто держит xmin-горизонт: детектор и алерт | Обслуживание | частично | 5 | 2 | 4 | 3 | 1 | 2 | 3,90 | 3,12 |
| 2 | no-data-alert | Алерт «нет данных» | Оповещения | нет | 5 | 2 | 5 | 1 | 1 | 2 | 3,75 | 3,00 |
| 3 | prometheus-export | Экспорт в Prometheus (/metrics) | Интеграции | нет | 2 | 2 | 3 | 1 | 1 | 1 | 2,05 | 2,05 |
| 4 | exhaustion-forecasts | Прогнозы исчерпания: диск, WAL, XID/MultiXact, последовательности | Обслуживание | частично | 5 | 2 | 4 | 3 | 2 | 2 | 3,90 | 1,95 |
| 5 | alert-catalog | Покрытие алертами и пакет правил по умолчанию | Оповещения | частично | 5 | 3 | 4 | 2 | 2 | 2 | 3,85 | 1,93 |
| 6 | change-timeline | Аннотации и таймлайн изменений | Наблюдаемость | частично | 4 | 4 | 3 | 2 | 2 | 1 | 3,35 | 1,91 |
| 7 | query-window-analytics | Аналитика запросов за окно | Производительность запросов | частично | 4 | 5 | 4 | 2 | 2 | 2 | 3,75 | 1,88 |
| 8 | onprem-channels | Каналы внутри периметра | Оповещения | нет | 4 | 3 | 4 | 3 | 2 | 2 | 3,65 | 1,83 |
| 9 | 1c-name-mapping | 1С: имена объектов метаданных | Российский рынок | нет | 3 | 3 | 4 | 4 | 2 | 2 | 3,45 | 1,73 |
| 10 | replication-health | Здоровье репликации и слотов | Наблюдаемость | частично | 4 | 3 | 4 | 2 | 2 | 2 | 3,45 | 1,73 |
| 11 | fleet-organization | Организация флота и рейтинг здоровья | UX | частично | 3 | 4 | 4 | 2 | 2 | 2 | 3,20 | 1,60 |
| 12 | lock-history | История блокировок, очередь за DDL | Наблюдаемость | частично | 4 | 2 | 4 | 3 | 2 | 3 | 3,50 | 1,56 |
| 13 | ai-local-llm | Локальный LLM через OpenAI-совместимый endpoint | AI | частично | 3 | 3 | 4 | 3 | 2 | 3 | 3,25 | 1,44 |
| 14 | plan-insights | Советник по планам (Query Advisor) | Производительность запросов | частично | 3 | 3 | 4 | 3 | 2 | 3 | 3,25 | 1,44 |
| 15 | index-hygiene | Гигиена индексов с учётом реплик | Производительность запросов | частично | 3 | 2 | 3 | 3 | 2 | 2 | 2,85 | 1,43 |
| 16 | backup-monitoring | Бэкапы и архивация WAL | Наблюдаемость | частично | 5 | 2 | 4 | 3 | 3 | 2 | 3,90 | 1,42 |
| 17 | config-advisor | Советник по конфигурации: профили, дрейф | Обслуживание | частично | 3 | 2 | 4 | 3 | 2 | 3 | 3,10 | 1,38 |
| 18 | upgrade-readiness | Готовность к обновлению версии | Обслуживание | частично | 3 | 1 | 3 | 3 | 2 | 2 | 2,70 | 1,35 |
| 19 | checks-catalog | Расширенный каталог проверок | Наблюдаемость | частично | 3 | 2 | 3 | 2 | 2 | 2 | 2,65 | 1,33 |
| 20 | collected-data-usage | PG18/PG19 с первого дня и Citus | Наблюдаемость | частично | 3 | 2 | 3 | 2 | 2 | 2 | 2,65 | 1,33 |
| 21 | fork-awareness | Поддержка российских форков | Российский рынок | нет | 3 | 2 | 4 | 4 | 2 | 4 | 3,30 | 1,32 |
| 22 | zabbix-integration | Шаблон Zabbix и медиатип | Интеграции | нет | 2 | 2 | 3 | 2 | 2 | 1 | 2,25 | 1,29 |
| 23 | wait-event-profile | Профиль ожиданий (ASH-lite) | Производительность запросов | частично | 4 | 4 | 5 | 2 | 3 | 3 | 3,85 | 1,28 |
| 24 | query-regression | Регрессии запросов и APDEX | Производительность запросов | нет | 4 | 3 | 4 | 4 | 3 | 3 | 3,85 | 1,28 |
| 25 | notification-delivery | Надёжная доставка уведомлений | Оповещения | частично | 3 | 1 | 3 | 2 | 2 | 2 | 2,50 | 1,25 |
| 26 | ai-governance | Политика и контроль AI | AI | нет | 2 | 1 | 3 | 4 | 2 | 2 | 2,50 | 1,25 |
| 27 | self-ops | Эксплуатация самого pgscope: HA, бэкап, health | Платформа | нет | 3 | 1 | 3 | 2 | 2 | 2 | 2,50 | 1,25 |
| 28 | alert-noise-controls | Тишина, окна обслуживания, подтверждение | Оповещения | нет | 4 | 4 | 4 | 1 | 3 | 2 | 3,40 | 1,24 |
| 29 | cluster-topology | Кластеры, HA и Kubernetes: Patroni, CNPG, failover | Наблюдаемость | нет | 4 | 3 | 5 | 2 | 3 | 3 | 3,70 | 1,23 |
| 30 | mcp-server | Read-only MCP-сервер | AI | нет | 2 | 2 | 3 | 3 | 2 | 2 | 2,45 | 1,23 |
| 31 | vacuum-advisor | VACUUM Advisor и прогресс с ETA | Обслуживание | частично | 4 | 3 | 4 | 3 | 3 | 3 | 3,65 | 1,22 |
| 32 | reports-period-compare | Отчёты в стиле AWR и дайджесты | Наблюдаемость | нет | 4 | 3 | 4 | 3 | 3 | 3 | 3,65 | 1,22 |
| 33 | safe-ddl | Безопасный DDL: линтер и ревью миграций | Обслуживание | нет | 4 | 3 | 3 | 4 | 3 | 3 | 3,60 | 1,20 |
| 34 | security-advisor | Советник по безопасности СУБД | Безопасность и доступ | частично | 3 | 1 | 3 | 3 | 2 | 3 | 2,70 | 1,20 |
| 35 | workbooks | Лаборатория тюнинга запроса | Производительность запросов | нет | 2 | 2 | 2 | 4 | 2 | 2 | 2,40 | 1,20 |
| 36 | plan-history | История планов и сравнение | Производительность запросов | нет | 4 | 2 | 4 | 3 | 3 | 3 | 3,50 | 1,17 |
| 37 | alert-conditions-v2 | Условия алертов v2 | Оповещения | частично | 4 | 3 | 4 | 2 | 3 | 3 | 3,45 | 1,15 |
| 38 | charts-dashboards | Графики, дашборды, экспорт | UX | частично | 3 | 5 | 4 | 1 | 3 | 2 | 3,15 | 1,15 |
| 39 | ai-incident-analysis | AI-разбор инцидента | AI | нет | 4 | 2 | 4 | 4 | 3 | 4 | 3,70 | 1,14 |
| 40 | schema-memory-insights | Схема и память: treemap, TOAST, HOT | Наблюдаемость | частично | 2 | 2 | 3 | 2 | 2 | 2 | 2,25 | 1,13 |
| 41 | audit-log | Журнал аудита с экспортом в SIEM | Безопасность и доступ | нет | 1 | 1 | 4 | 2 | 2 | 1 | 1,95 | 1,11 |
| 42 | alert-fleet-routing | Правила на уровне флота, маршрутизация | Оповещения | частично | 4 | 2 | 4 | 2 | 3 | 3 | 3,30 | 1,10 |
| 43 | findings-lifecycle | Инбокс находок, настраиваемые пороги | Наблюдаемость | частично | 3 | 3 | 3 | 3 | 3 | 2 | 3,00 | 1,09 |
| 44 | 1c-workload | 1С: временные таблицы и раздувание каталога | Российский рынок | нет | 3 | 2 | 3 | 4 | 3 | 3 | 3,05 | 1,02 |
| 45 | offline-packaging | Дистрибуция для закрытых контуров | Платформа | нет | 3 | 1 | 5 | 2 | 3 | 3 | 3,00 | 1,00 |
| 46 | collector-onboarding | Онбординг и здоровье сбора | Платформа | нет | 3 | 2 | 4 | 2 | 3 | 3 | 2,90 | 0,97 |
| 47 | api-tokens | API-токены с областями, OpenAPI | Безопасность и доступ | нет | 3 | 2 | 3 | 2 | 3 | 2 | 2,65 | 0,96 |
| 48 | index-advisor | Советник по недостающим индексам | Производительность запросов | нет | 4 | 2 | 5 | 3 | 4 | 4 | 3,75 | 0,94 |
| 49 | log-analytics | Аналитика логов и приём syslog | Наблюдаемость | частично | 4 | 3 | 4 | 2 | 4 | 3 | 3,45 | 0,92 |
| 50 | sso-ldap-oidc | LDAP/AD/FreeIPA и OIDC/SAML | Безопасность и доступ | нет | 2 | 3 | 5 | 1 | 3 | 3 | 2,70 | 0,90 |
| 51 | proposed-actions | Очередь действий с согласованием и проверкой | Производительность запросов | нет | 2 | 2 | 3 | 4 | 3 | 3 | 2,65 | 0,88 |
| 52 | query-tags | Теги приложений (sqlcommenter) | Производительность запросов | нет | 2 | 2 | 2 | 3 | 2 | 4 | 2,20 | 0,88 |
| 53 | ai-history-tools | AI-чат с инструментами по истории | AI | частично | 3 | 2 | 3 | 3 | 3 | 4 | 2,85 | 0,88 |
| 54 | pii-redaction | Маскирование ПДн и секретов | Безопасность и доступ | нет | 2 | 1 | 4 | 3 | 3 | 4 | 2,55 | 0,78 |
| 55 | security-hardening | Укрепление безопасности pgscope | Безопасность и доступ | частично | 2 | 1 | 4 | 1 | 3 | 2 | 2,15 | 0,78 |
| 56 | collector-agent | Компаньон-коллектор | Платформа | нет | 4 | 3 | 4 | 2 | 5 | 4 | 3,45 | 0,73 |
| 57 | agent-jobs | Действия через агента: EXPLAIN, HypoPG, cancel | Платформа | нет | 3 | 2 | 3 | 3 | 4 | 4 | 2,85 | 0,71 |
| 58 | storage-scaling | Масштабирование хранения и UI | Платформа | частично | 3 | 3 | 3 | 2 | 4 | 4 | 2,80 | 0,70 |
| 59 | rbac-orgs | Организации и ролевая модель | Безопасность и доступ | частично | 2 | 2 | 4 | 2 | 4 | 4 | 2,50 | 0,63 |
| 60 | 1c-investigation | 1С: техжурнал и пакет воспроизведения | Российский рынок | нет | 2 | 1 | 3 | 3 | 4 | 4 | 2,30 | 0,58 |

## Приложение B. Отклонено или уже есть

**Отклонено:**
- мониторинг облачных управляемых БД;
- приём логов через облачные API;
- публичные онлайн-инструменты (требуют SaaS);
- облачный AI как основной провайдер;
- автономный тюнинг и автоматическое применение изменений;
- проверка рекомендаций на клоне инстанса;
- MCP с `execute_sql`;
- дашборды, сгенерированные AI;
- синхронизация со Slack/PagerDuty, нативные Teams и Opsgenie;
- SLO с burn-rate;
- позиционирование на закрытии AWS Performance Insights;
- Telegram как основной канал;
- управление кластером из pgscope (switchover, рестарты).

**Вне кода (бизнес или инженерная гигиена):** реестр ПО, тарифы, llms.txt, CI и тесты (они учтены как предпосылка P1).

**Уже есть:**
- UI без CDN;
- около 30 диагностик и 30 правил конфигурации;
- SQL для управления индексами, Top-k, перенос табличных пространств (совет удалить неиспользуемый индекс требует исправления — `index-hygiene` этап 0);
- 16 типов change alerts;
- локализация RU/EN и язык каналов;
- дашборды PgBouncer и Pgpool, pg_stat_io и pg_stat_lock, цепочки блокировок на снимок, дерево плана;
- базовые каналы уведомлений;
- owner/member и инвайты без SMTP.

Развитие уже существующего вынесено в отдельных кандидатов (см. Приложение A).

## Приложение C. Источники

Ниже все внешние ссылки, процитированные в документе, сгруппированные по домену. Внутренние ссылки ведут на файлы репозитория pgscope.

- **ankane.org**: https://ankane.org/introducing-dexter · https://ankane.org/pghero-2-0
- **anthropic.com**: https://www.anthropic.com/supported-countries
- **anti-malware.ru**: https://www.anti-malware.ru/reviews/Avanpost-FAM · https://www.anti-malware.ru/reviews/Blitz-Identity-Provider-5-31
- **ardentperf.com**: https://ardentperf.com/2026/10/20/postgres-recovery_prefetch-considered-harmful-and-causing-outages/
- **arxiv.org**: https://arxiv.org/abs/2411.07763
- **blocksandfiles.com**: https://www.blocksandfiles.com/data-management/2026/10/07/dbtune-autonomous-optimization-blows-postgresql-bottlenecks-away/5301616
- **blog.healthchecks.io**: https://blog.healthchecks.io/hp-rewrite/16ddd04e14f6e9c04d4f8dba06e127a7
- **blog.sentry.io**: https://blog.sentry.io/transaction-id-wraparound-in-postgres
- **clickhouse.com**: https://clickhouse.com/blog/postgres-19-new-system-views
- **cloudnative-pg.io**: https://cloudnative-pg.io/docs/1.27/monitoring
- **computerworld.com**: https://www.computerworld.com/article/3654168/slack-suspends-access-for-russia-based-customers.html
- **coroot.com**: https://coroot.com/blog/lets-break-autovacuum-in-postgres/
- **cs.cmu.edu**: https://www.cs.cmu.edu/~pavlo/blog
- **cybertec-postgresql.com**: https://www.cybertec-postgresql.com/en/pgwatch-v6-dashboards-reimagined-and-a-reaper-that-doesnt-choke/
- **datadoghq.com**: https://www.datadoghq.com/blog/database-monitoring-query-regressions/
- **dba.stackexchange.com**: https://dba.stackexchange.com/questions/21068/aggressive-autovacuum-on-postgresql · https://dba.stackexchange.com/questions/335830/what-is-the-postgres-equivalent-of-sql-servers-query-store · https://dba.stackexchange.com/questions/69438/psql-fatal-sorry-too-many-clients-already
- **dev.to**: https://dev.to/sasikumart/postgres-almost-outage-postmortem-the-hidden-dangers-of-replication-slots-and-autovacuum-2nem
- **developers.sber.ru**: https://developers.sber.ru/docs/ru/gigachain/tools/utilities/gpttogiga-proxy-server · https://developers.sber.ru/docs/ru/gigachat/guides/compatible-openai
- **docs.aws.amazon.com**: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Database-Insights-Fleet-Health-Dashboard.html · https://docs.aws.amazon.com/devops-guru/latest/userguide/devops-guru-end-of-support.html · https://docs.aws.amazon.com/en_en/AmazonCloudWatch/latest/monitoring/Database-Insights-Lock-Analysis.html
- **docs.cloud.google.com**: https://docs.cloud.google.com/sql/docs/postgres/using-query-insights
- **docs.coroot.com**: https://docs.coroot.com/ai/ · https://docs.coroot.com/ai/configuration · https://docs.coroot.com/ai/overview · https://docs.coroot.com/databases/postgres/ · https://docs.coroot.com/inspections/postgres
- **docs.ollama.com**: https://docs.ollama.com/api/openai-compatibility
- **docs.percona.com**: https://docs.percona.com/percona-monitoring-and-management/3/advisors/advisors-details.html · https://docs.percona.com/percona-monitoring-and-management/3/alert/index.html · https://docs.percona.com/percona-monitoring-and-management/3/release-notes/3.8.0.html · https://docs.percona.com/percona-monitoring-and-management/3/release-notes/3.9.0.html · https://docs.percona.com/percona-monitoring-and-management/3/use/qan/panels/details.html · https://docs.percona.com/percona-monitoring-and-management/3/use/qan/panels/filters.html
- **docs.pgdash.io**: https://docs.pgdash.io/ai.md · https://docs.pgdash.io/alerts.md · https://docs.pgdash.io/automation.md · https://docs.pgdash.io/queries.md · https://docs.pgdash.io/self-hosted.md · https://docs.pgdash.io/teams.md
- **docs.pgedge.com**: https://docs.pgedge.com/ai-dba-workbench/v1-0-0/
- **docs.tantorlabs.ru**: https://docs.tantorlabs.ru/tdb/en/17_10/se/pg_wait_profile.html
- **docs.vllm.ai**: https://docs.vllm.ai/en/v0.21.0/serving/openai_compatible_server/
- **eweek.com**: https://www.eweek.com/news/replit-ai-coding-assistant-failure/
- **founderpath.com**: https://founderpath.com/resources/ry-walker-tembo-ai-developer-teammate-pivot
- **g2.com**: https://g2.com/products/pganalyze/reviews
- **github.com**: https://github.com/binwiederhier/ntfy · https://github.com/dalibo/pg_activity · https://github.com/percona/pmm · https://github.com/pganalyze/pg_query_go · https://github.com/pgstef/check_pgbackrest · https://github.com/postgrespro/pg_wait_sampling · https://github.com/powa-team/powa-web/issues/123 · https://github.com/prometheus-community/postgres_exporter · https://github.com/rapidloop/pgmetrics/blob/master/model.go · https://github.com/rapidloop/pgmetrics/commits/master · https://github.com/rapidloop/pgmetrics/issues/33 · https://github.com/rapidloop/pgmetrics/issues/56 · https://github.com/rapidloop/pgmetrics/issues/78 · https://github.com/rapidloop/pgmetrics/releases/tag/v1.19.0 · https://github.com/sbdchd/squawk · https://github.com/xataio/agent · https://github.com/zalando/postgres-operator · https://github.com/zubkov-andrei/pg_profile
- **gitlab.com**: https://gitlab.com/gitlab-com/gl-infra/production/-/issues/19464 · https://gitlab.com/gitlab-com/gl-infra/production/-/work_items/20154
- **gocardless.com**: https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/
- **grafana.com**: https://grafana.com/docs/grafana/latest/alerting/best-practices/missing-data/ · https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/saml/
- **habr.com**: https://habr.com/en/companies/softpoint/articles/734534 · https://habr.com/en/posts/952394 · https://habr.com/ru/articles/919982/ · https://habr.com/ru/companies/postgrespro/articles/487590/ · https://habr.com/ru/companies/tantor/articles/930038/ · https://habr.com/ru/companies/tantor/news/1014610/ · https://habr.com/ru/companies/tbank/articles/886488/ · https://habr.com/ru/post/716486
- **infostart.ru**: https://infostart.ru/1c/articles/2487972/ · https://infostart.ru/1c/tools/306894/
- **itnext.io**: https://itnext.io/when-the-watchman-cant-see-how-a-silent-backup-failure-almost-stayed-silent-forever-98ccc9597043
- **its.1c.ru**: https://its.1c.ru/db/content/metod8dev/src/developers/scalability/methods/i8105807.htm · https://its.1c.ru/db/content/metod8dev/src/developers/scalability/troubleshooting/i8106011.htm
- **kb.vshn.ch**: https://kb.vshn.ch/app-catalog/service/postgresql/runbooks/system/CNPGPostgreSQLArchiveFailing.html
- **kod.ru**: https://kod.ru/yandexgpt-open-source-new-models
- **kontur.ru**: https://kontur.ru/aegis/blog/82649-chto_menyaet_prikaz_fstek_117_i_kak_podgotovit_biznes
- **learn.microsoft.com**: https://learn.microsoft.com/en-us/azure/postgresql/monitor/concepts-autonomous-tuning · https://learn.microsoft.com/en-us/azure/postgresql/monitor/concepts-query-store
- **llmgateway.io**: https://llmgateway.io/blog/incident-report-october-19-2026
- **llmrun.dev**: https://llmrun.dev/model/ai-sage-gigachat3-10b-a1-8b-base
- **mailchimp.com**: https://mailchimp.com/what-we-learned-from-the-recent-mandrill-outage/
- **meduza.io**: https://meduza.io/feature/2026/04/10/telegram-prakticheski-nedostupen-v-rossii-pomoch-mogut-proksi-s-nedavnimobnovleniem-messendzhera-oni-dolzhny-rabotat-namnogo-luchshe
- **metronome.com**: https://metronome.com/blog/root-cause-analysis-postgresql-multixact-member-exhaustion-incidents-may-2025
- **morling.dev**: https://morling.dev/blog/insatiable-postgres-replication-slot
- **netdata.cloud**: https://www.netdata.cloud/guides/postgres/postgres-replication-slot-bloat/ · https://www.netdata.cloud/guides/postgres/postgres-wal-archive-failures/ · https://www.netdata.cloud/resources/best-postgresql-monitoring-tools/
- **news.ycombinator.com**: https://news.ycombinator.com/item?id=39877258
- **okmeter.io**: https://okmeter.io/
- **oneuptime.com**: https://oneuptime.com/blog/post/2026-09-18-pgbouncer-old-primary-after-cloudnativepg-failover/markdown
- **packages.rapidloop.com**: https://packages.rapidloop.com/downloads/
- **palark.com**: https://palark.com/blog/patroni-postgresql-logical-replication-failover.md
- **patroni.readthedocs.io**: https://patroni.readthedocs.io/en/latest/rest_api.html
- **percona.com**: https://www.percona.com/blog/enable-ldap-on-percona-monitoring-and-management-pmm/
- **pganalyze.com**: https://pganalyze.com/blog/extended-retention · https://pganalyze.com/blog/mcp-server-public-preview · https://pganalyze.com/blog/query-advisor-ga · https://pganalyze.com/comparison/pganalyze-vs-pgdash · https://pganalyze.com/docs/accounts/permissions · https://pganalyze.com/docs/accounts/server_groups · https://pganalyze.com/docs/checks/ · https://pganalyze.com/docs/checks/queries/slowness · https://pganalyze.com/docs/checks/schema/index_unused · https://pganalyze.com/docs/checks/vacuum/xmin_horizon · https://pganalyze.com/docs/checks/webhooks · https://pganalyze.com/docs/collector · https://pganalyze.com/docs/connections · https://pganalyze.com/docs/enterprise/releases/2026-02-0 · https://pganalyze.com/docs/enterprise/releases/2026-05-0 · https://pganalyze.com/docs/enterprise/releases/2026-08-0 · https://pganalyze.com/docs/index-advisor/getting-started · https://pganalyze.com/docs/indexing-engine · https://pganalyze.com/docs/mcp · https://pganalyze.com/docs/query-advisor/insights · https://pganalyze.com/docs/query-performance · https://pganalyze.com/docs/vacuum-advisor/bloat · https://pganalyze.com/docs/vacuum-advisor/freezing · https://pganalyze.com/docs/workbooks · https://pganalyze.com/pricing
- **pgdash.io**: https://pgdash.io/pricing · https://pgdash.io/self-hosted
- **pgmetrics.io**: https://pgmetrics.io/docs/log.html
- **pgmustard.com**: https://pgmustard.com/docs
- **pgwat.ch**: https://pgwat.ch/latest/ · https://pgwat.ch/latest/gallery/dashboards.html
- **pkg.go.dev**: https://pkg.go.dev/github.com/mail-ru-im/bot-golang · https://pkg.go.dev/github.com/wasilibs/go-pgquery
- **postgres.ai**: https://postgres.ai/docs/postgres-howtos/performance-optimization/indexing/how-to-find-unused-indexes
- **postgrespro.com**: https://postgrespro.com/docs/postgrespro/15/one-c-additional-modules · https://postgrespro.com/docs/postgrespro/current/pgpro-pwr · https://postgrespro.com/docs/ppem/current/ppem-alerts.html · https://postgrespro.com/docs/ppem/current/ppem-askpostgres.html · https://postgrespro.com/docs/ppem/current/ppem-configuring-integration-with-a-directory-service · https://postgrespro.com/docs/ppem/current/ppem-installation-in-secure-environments.html · https://postgrespro.com/docs/ppem/current/ppem-supported-platforms-and-operating-systems.html · https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-4.html · https://postgrespro.com/docs/ppem/current/whats-new-in-ppem-2-9.html
- **postgresql.eu**: https://www.postgresql.eu/events/pgconfeu2025/sessions/session/7112-tracking-plan-shapes-over-time-with-plan-ids-and-the-new-pg_stat_plans
- **postgresql.org**: https://www.postgresql.org/about/news/pgadmin-4-v913-released-3253 · https://www.postgresql.org/about/news/postgresql-19-rc-1-3409/ · https://www.postgresql.org/support/versioning/
- **powa.readthedocs.io**: https://powa.readthedocs.io/en/latest/ · https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_stat_kcache.html · https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_track_settings.html · https://powa.readthedocs.io/en/latest/components/stats_extensions/pg_wait_sampling.html
- **ppt.ru**: https://ppt.ru/news/nejroseti/fstek-podgotovila-proekt-novykh-trebovaniy-k-zashchite-informatsii-pri-ispolzovanii-ii
- **prometheus.io**: https://prometheus.io/docs/prometheus/latest/querying/functions/
- **readme.hex.pm**: https://readme.hex.pm/pghero/0.1.1
- **reddit.com**: https://www.reddit.com/r/PostgreSQL/comments/16tmukv/major_slowdown_after_upgrade/
- **rjuju.github.io**: https://rjuju.github.io/postgresql/2020/01/06/pg_qualstats-2-global-index-advisor.html
- **ru.themoscowtimes.com**: https://ru.themoscowtimes.com/2025/03/03/vrossii-nesmogli-zamenit-95-kriticheskogo-importnogo-po-a156792
- **samber.github.io**: https://samber.github.io/awesome-prometheus-alerts/rules/databases/postgresql/
- **securitylabs.datadoghq.com**: https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/
- **simonwillison.net**: https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta/
- **sre.google**: https://sre.google/sre-book/introduction/
- **standardwebhooks.com**: https://www.standardwebhooks.com/
- **supabase.com**: https://supabase.com/blog/security-performance-advisor
- **tproger.ru**: https://tproger.ru/articles/platformy-administrirovaniya-i-monitoringa-baz-dannyh-na-osnove-postgresql-259927
- **useautumn.com**: https://useautumn.com/blog/post-mortem-database-outage-caused-by-collation-migration-locking-conflict.md
- **vc.ru**: https://vc.ru/id5779154/2795944-blokirovka-telegram-api-v-rossii
- **vldb.org**: https://www.vldb.org/pvldb/vol17/p2514-li.pdf
- **xata.io**: https://xata.io/blog/migrations-and-exclusive-locks
- **zabbix.com**: https://www.zabbix.com/de/pr/pr389 · https://www.zabbix.com/integrations/mattermost · https://www.zabbix.com/integrations/postgresql
- **zoom.cnews.ru**: https://zoom.cnews.ru/news/item/692962 · https://zoom.cnews.ru/news/item/707524
