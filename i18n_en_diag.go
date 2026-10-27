package main

// English for diag.go (diagnostics and configuration check).

func init() {
	registerEN(map[string]string{
		"… и ещё %d": "… and %d more",

		// categories
		"Очистка":            "Vacuum",
		"Репликация":         "Replication",
		"Бэкенды":            "Backends",
		"Блокировки":         "Locks",
		"Базы данных":        "Databases",
		"Таблицы":            "Tables",
		"Индексы":            "Indexes",
		"Расширения":         "Extensions",
		"Объекты":            "Objects",
		"Диск":               "Disk",
		"Сервер":             "Server",
		"Безопасность":       "Security",
		"Запросы":            "Queries",
		"Сохранность данных": "Data Safety",
		"Производительность": "Performance",
		"Надёжность":         "Reliability",

		// vacuum
		"%s: возраст XID %d (%.0f%% от предела переполнения)":  "%s: XID age %d (%.0f%% of the wraparound limit)",
		"Угроза переполнения счётчика транзакций (wraparound)": "Transaction ID wraparound risk",
		"Эти базы данных близки к переполнению счётчика транзакций. Срочно выполните VACUUM FREEZE: при достижении предела PostgreSQL перестаёт принимать запись.": "These databases are close to transaction ID wraparound. Run VACUUM FREEZE urgently: once the limit is reached, PostgreSQL stops accepting writes.",
		"Высокий возраст XID": "High XID age",
		"Возраст замороженного XID растёт. Проверьте, успевает ли autovacuum.":                              "The frozen XID age is growing. Check whether autovacuum is keeping up.",
		"Скоро запустится autovacuum против переполнения (wraparound)":                                      "Anti-wraparound autovacuum is due",
		"Возраст XID превышает autovacuum_freeze_max_age — в этих базах запустится агрессивный autovacuum.": "XID age exceeds autovacuum_freeze_max_age, so an aggressive autovacuum will run in these databases.",

		// replication
		"%s (%s), удерживает %s WAL":  "%s (%s), retaining %s of WAL",
		"Неактивные слоты репликации": "Inactive replication slots",
		"Неактивные слоты не дают удалять файлы WAL и старые версии строк, из-за чего может переполниться диск. Удалите ненужные слоты.": "Inactive slots prevent removal of WAL files and old row versions, which can fill up the disk. Drop the slots you no longer need.",
		"%s: отстаёт на %s, отставание воспроизведения %d с": "%s: %s behind, replay lag %d s",
		"Реплики отстают": "Standbys are lagging",
		"Эти реплики отстают более чем на 1 ГиБ или 60 секунд.":                                          "These standbys are more than 1 GiB or 60 seconds behind.",
		"Реплика не успевает воспроизводить WAL":                                                         "Standby is not keeping up with WAL replay",
		"Последняя транзакция воспроизведена %s назад, а полученный WAL ещё не воспроизведён полностью.": "The last transaction was replayed %s ago, and the received WAL has not been fully replayed yet.",
		"Воспроизведение WAL приостановлено":                                                             "WAL replay is paused",
		"Выполните pg_wal_replay_resume(), чтобы продолжить воспроизведение WAL.":                        "Run pg_wal_replay_resume() to resume WAL replay.",
		"Ошибки подписки логической репликации":                                                          "Logical replication subscription errors",
		"Подписка «%s» в базе «%s»: ошибок применения — %d, ошибок синхронизации — %d.":                  "Subscription “%s” in database “%s” has %d apply and %d sync errors.",

		// WAL
		"Сбой архивации WAL": "WAL archiving failure",
		"Последняя попытка архивации (%s) завершилась ошибкой. Проверьте archive_command и место назначения архива.": "The last archive attempt (%s) failed. Check archive_command and the archive destination.",
		"Файлы WAL ожидают архивации": "WAL files waiting to be archived",
		"Файлов WAL, готовых к архивации, но ещё не заархивированных: %d. Архивация не успевает.": "%d WAL files are ready for archiving but not yet archived. Archiving is falling behind.",
		"Слишком много файлов WAL": "Too many WAL files",
		"Файлов в pg_wal: %d (≈%s) — больше удвоенного max_wal_size. Проверьте неактивные слоты, сбои архивации и wal_keep_size.": "pg_wal holds %d files (≈%s), more than twice max_wal_size. Check for inactive slots, archiving failures and wal_keep_size.",
		"Слишком частые контрольные точки": "Checkpoints are too frequent",
		"Контрольных точек по запросу: %d, по расписанию: %d. Увеличьте max_wal_size, чтобы сгладить пики ввода-вывода.": "Requested checkpoints: %d, timed: %d. Increase max_wal_size to smooth out I/O spikes.",

		// backends and locks
		"Число подключений близко к max_connections":                                           "Connections are close to max_connections",
		"Занято подключений: %d из %.0f (%.0f%%). Рассмотрите использование пула подключений.": "%d of %.0f connections in use (%.0f%%). Consider using a connection pooler.",
		"%s — открыта %s":      "%s — open for %s",
		"%s — бездействует %s": "%s — idle for %s",
		"Долгие транзакции":    "Long-running transactions",
		"Транзакции, открытые дольше 5 минут, мешают очистке (vacuum) и могут вызывать раздувание.":                 "Transactions open for more than 5 minutes hold back vacuum and can cause bloat.",
		"Бездействие в транзакции (idle in transaction)":                                                            "Idle in transaction",
		"Эти бэкенды открыли транзакцию и бездействуют дольше минуты. Задайте idle_in_transaction_session_timeout.": "These backends opened a transaction and have been idle for over a minute. Set idle_in_transaction_session_timeout.",
		"Бэкенды ожидают блокировок":                                                                                "Backends waiting for locks",
		"Эти бэкенды заблокированы другими транзакциями.":                                                           "These backends are blocked by other transactions.",
		"Очередь уведомлений заполняется":                                                                           "Notification queue is filling up",
		"Очередь LISTEN/NOTIFY заполнена на %.0f%%: один из слушателей не забирает уведомления.":                    "The LISTEN/NOTIFY queue is %.0f%% full: a listener is not consuming notifications.",

		// databases
		"%s: доля фиксаций %s%%":                                            "%s: commit ratio %s%%",
		"%s: %s во временных файлах (файлов: %d)":                           "%s: %s in temp files (files: %d)",
		"%s — взаимоблокировок: %d":                                         "%s — deadlocks: %d",
		"%s — ошибок контрольных сумм: %d":                                  "%s — checksum failures: %d",
		"Ошибки контрольных сумм данных":                                    "Data checksum failures",
		"Ошибки контрольных сумм указывают на повреждение данных на диске.": "Checksum failures indicate on-disk data corruption.",
		"Низкая доля попаданий в кеш":                                       "Low cache hit ratio",
		"Менее 90% чтений блоков обслуживается из общего буферного кеша. Рассмотрите увеличение shared_buffers или объёма RAM.": "The shared buffer cache hit ratio is below 90%. Consider increasing shared_buffers or RAM.",
		"Много откатов транзакций": "High rollback rate",
		"Многие транзакции откатываются — проверьте приложение на ошибки.":    "Many transactions are rolled back. Check the application for errors.",
		"Активное использование временных файлов":                             "Heavy temp file usage",
		"Запросы сбрасывают данные на диск. Рассмотрите увеличение work_mem.": "Queries are spilling to disk. Consider increasing work_mem.",
		"Обнаружены взаимоблокировки":                                         "Deadlocks detected",
		"С момента последнего сброса статистики обнаружены взаимоблокировки.": "Deadlocks have occurred since the last statistics reset.",
		"Взаимоблокировки в журнале":                                          "Deadlocks in logs",
		"В журнале PostgreSQL найдены взаимоблокировки.":                      "Deadlocks were found in the PostgreSQL log.",

		// tables
		"%s: раздувание %s из %s":                                 "%s: %s of %s is bloat",
		"%s: мёртвых строк %d, живых %d":                          "%s: %d dead rows, %d live",
		"%s (%s): последовательных сканирований %d, индексных %d": "%s (%s): %d sequential scans, %d index scans",
		"Раздутые таблицы":                                        "Bloated tables",
		"Раздувание этих таблиц превышает 30%. Рассмотрите VACUUM FULL, pg_repack или настройку autovacuum.": "Bloat in these tables exceeds 30%. Consider VACUUM FULL, pg_repack or tuning autovacuum.",
		"Много мёртвых строк":                                                                                    "Many dead rows",
		"autovacuum не успевает обрабатывать эти таблицы.":                                                       "autovacuum is not keeping up with these tables.",
		"Таблицы ни разу не очищались и не анализировались":                                                      "Tables never vacuumed or analyzed",
		"Для этих таблиц может отсутствовать статистика планировщика.":                                           "These tables may be missing planner statistics.",
		"Большие таблицы читаются последовательным сканированием":                                                "Large tables read by sequential scans",
		"Возможно, этим таблицам не хватает индекса.":                                                            "These tables may be missing an index.",
		"Таблицы без первичного ключа или уникального индекса":                                                   "Tables without a primary key or unique index",
		"Строки нельзя однозначно идентифицировать, из-за чего не работает логическая репликация UPDATE/DELETE.": "Rows cannot be uniquely identified, so logical replication of UPDATE/DELETE does not work.",

		// indexes
		"Неиспользуемые индексы": "Unused indexes",
		"Эти неуникальные индексы ни разу не сканировались с момента сброса статистики. Они замедляют запись — рассмотрите их удаление.": "These non-unique indexes have not been scanned since the last statistics reset. They slow down writes; consider dropping them.",
		"Дублирующиеся индексы": "Duplicate indexes",
		"Каждый из этих индексов повторяет другой, и его можно удалить. Уникальные индексы, в том числе индексы первичных ключей и ограничений, не предлагаются к удалению, пока есть неуникальный дубликат.": "Each of these indexes duplicates another one and can be dropped. Unique indexes, including those of primary keys and constraints, are not proposed for dropping while a non-unique duplicate exists.",
		"%s повторяет %s":                                "%s duplicates %s",
		"Раздутые индексы":                               "Bloated indexes",
		"Перестройте их с помощью REINDEX CONCURRENTLY.": "Rebuild them with REINDEX CONCURRENTLY.",

		// misc
		"Доступны обновления расширений":                                                      "Extension updates available",
		"Выполните ALTER EXTENSION … UPDATE в каждой базе данных.":                            "Run ALTER EXTENSION … UPDATE in each database.",
		"Отключённые триггеры":                                                                "Disabled triggers",
		"Эти триггеры отключены.":                                                             "These triggers are disabled.",
		"Диск почти заполнен":                                                                 "Disk almost full",
		"Диск с табличным пространством «%s» заполнен на %.0f%% (свободно %s).":               "The disk holding tablespace “%s” is %.0f%% full (%s free).",
		"Неподдерживаемая версия PostgreSQL":                                                  "Unsupported PostgreSQL version",
		"PostgreSQL %s больше не получает исправлений безопасности. Запланируйте обновление.": "PostgreSQL %s no longer receives security fixes. Plan an upgrade.",
		"Дополнительные роли суперпользователя":                                               "Additional superuser roles",
		"Роли суперпользователя с правом входа. По возможности сократите их привилегии.":      "Superuser roles that can log in. Reduce their privileges where possible.",
		"Нет статистики запросов":                                                             "No query statistics",
		"pg_stat_statements не установлен или недоступен для чтения. Добавьте его в shared_preload_libraries и выполните CREATE EXTENSION pg_stat_statements.": "pg_stat_statements is not installed or not readable. Add it to shared_preload_libraries and run CREATE EXTENSION pg_stat_statements.",

		// configuration check: security
		"SSL выключен: подключения и пароли передаются открытым текстом. Включите ssl.":                                            "SSL is off: connections and passwords are sent in plain text. Enable ssl.",
		"Используйте scram-sha-256: хеширование паролей md5 ненадёжно и устарело.":                                                 "Use scram-sha-256: md5 password hashing is weak and deprecated.",
		"Сервер принимает подключения на всех интерфейсах; ограничьте их, если клиенты подключаются только из определённых сетей.": "The server accepts connections on all interfaces; restrict them if clients only connect from specific networks.",
		"Включите, чтобы вести журнал попыток подключения для аудита.":                                                             "Enable to log connection attempts for auditing.",
		"Включите, чтобы записывать длительность сеансов.":                                                                         "Enable to log session durations.",
		"Защита на уровне строк (row level security) отключена для всего сервера.":                                                 "Row-level security is disabled server-wide.",

		// configuration check: data safety
		"fsync выключен: сбой или отключение питания могут повредить базу данных. Включите его.":                        "fsync is off: a crash or power loss can corrupt the database. Turn it on.",
		"Частично записанные страницы после сбоя могут повредить данные. Включите этот параметр.":                       "Partially written pages after a crash can corrupt data. Turn this setting on.",
		"При сбое могут быть потеряны недавно зафиксированные транзакции.":                                              "Recently committed transactions can be lost in a crash.",
		"Контрольные суммы выявляют повреждения данных в хранилище; включите их при initdb или с помощью pg_checksums.": "Checksums detect data corruption in storage; enable them at initdb or with pg_checksums.",
		"Для восстановления на момент времени и репликации нужен wal_level replica или выше.":                           "Point-in-time recovery and replication need wal_level replica or higher.",
		"Архивация WAL выключена, поэтому восстановление на момент времени невозможно.":                                 "WAL archiving is off, so point-in-time recovery is not possible.",

		// configuration check: performance
		"Обычно 25%% RAM (здесь — %s).":                                  "Typically 25%% of RAM (%s here).",
		"Всё ещё значение по умолчанию 128 МиБ; обычно задают 25%% RAM.": "Still the 128 MiB default; typically set to 25%% of RAM.",
		"Значение по умолчанию; задайте около 50–75%% RAM, чтобы планировщик охотнее выбирал индексное сканирование.":         "Still the default; set it to about 50–75%% of RAM so the planner favors index scans.",
		"Запросы записали %s во временные файлы; увеличьте work_mem для сортировок и хеш-операций.":                           "Queries wrote %s to temp files; increase work_mem for sorts and hash operations.",
		"Значение по умолчанию 64 МиБ; большее значение ускоряет VACUUM и CREATE INDEX.":                                      "Still the 64 MiB default; a larger value speeds up VACUUM and CREATE INDEX.",
		"Значение по умолчанию рассчитано на HDD; для SSD используйте 1.1.":                                                   "The default is tuned for HDDs; use 1.1 for SSDs.",
		"Используйте 0.9, чтобы равномернее распределить ввод-вывод контрольных точек.":                                       "Use 0.9 to spread checkpoint I/O more evenly.",
		"Включите, чтобы видеть время ввода-вывода для каждого запроса (на современных системах накладные расходы невелики).": "Enable to see I/O time per query (the overhead is low on modern systems).",
		"Для SSD используйте значение около 200, чтобы заранее считывать больше блоков.":                                      "Use around 200 for SSDs to prefetch more blocks.",
		"Большое число подключений расходует память и CPU; используйте пул подключений, например PgBouncer.":                  "Many connections consume memory and CPU; use a connection pooler such as PgBouncer.",
		"Добавьте pg_stat_statements, чтобы отслеживать производительность запросов.":                                         "Add pg_stat_statements to track query performance.",

		// configuration check: reliability
		"autovacuum выключен: таблицы раздуваются, растёт риск переполнения счётчика транзакций (wraparound).": "autovacuum is off: tables bloat and the risk of transaction ID wraparound grows.",
		"autovacuum нужен track_counts, чтобы определять, какие таблицы очищать.":                              "autovacuum needs track_counts to decide which tables to vacuum.",
		"Записывайте в журнал медленные запросы (например, дольше 1000 мс), чтобы находить проблемные.":        "Log slow queries (for example, over 1000 ms) to find problematic ones.",
		"Задайте тайм-аут, чтобы брошенные транзакции не удерживали блокировки и не мешали очистке (vacuum).":  "Set a timeout so abandoned transactions do not hold locks or block vacuum.",
		"Записывайте контрольные точки в журнал, чтобы диагностировать пики ввода-вывода.":                     "Log checkpoints to diagnose I/O spikes.",
		"Записывайте в журнал ожидания блокировок дольше deadlock_timeout.":                                    "Log lock waits longer than deadlock_timeout.",
		"Записывайте в журнал запуски autovacuum (например, дольше 1 с), чтобы видеть историю очистки.":        "Log autovacuum runs (for example, over 1 s) to see the vacuum history.",
		"Запросы на этой реплике могут отменяться из-за конфликтов репликации.":                                "Queries on this standby can be canceled due to replication conflicts.",
		"Слоты могут удерживать неограниченный объём WAL и переполнить диск; задайте предел.":                  "Slots can retain unlimited WAL and fill up the disk; set a limit.",
	})
}
