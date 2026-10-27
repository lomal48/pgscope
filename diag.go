package main

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/rapidloop/pgmetrics"
)

type issue struct {
	Severity string   `json:"severity"` // crit | warn | info
	Category string   `json:"category"`
	Title    string   `json:"title"`
	Detail   string   `json:"detail"`
	Items    []string `json:"items,omitempty"`
	Link     string   `json:"link,omitempty"` // UI route inside the server, e.g. "/indexes"
}

// addIssue translates cat, title and detail; details built with trf are already
// translated, so tr leaves them unchanged.
func addIssue(out *[]issue, lang, sev, cat, title, detail, link string, items []string) {
	const maxItems = 50
	if len(items) > maxItems {
		items = append(items[:maxItems], trf(lang, "… и ещё %d", len(items)-maxItems))
	}
	*out = append(*out, issue{sev, tr(lang, cat), tr(lang, title), tr(lang, detail), items, link})
}

func tname(t pgmetrics.Table) string { return t.DBName + "." + t.SchemaName + "." + t.Name }

// diagnose scans one report for problems that affect health and performance.
func diagnose(m *pgmetrics.Model, lang string) []issue {
	out := []issue{}
	at := m.Metadata.At
	freeze := setting(m, "autovacuum_freeze_max_age")

	// transaction ID wraparound
	var wrapCrit, wrapWarn, forced []string
	for _, d := range m.Databases {
		pct := 100 * f(d.AgeDatFrozenXid) / 2147483647
		item := trf(lang, "%s: возраст XID %d (%.0f%% от предела переполнения)", d.Name, d.AgeDatFrozenXid, pct)
		switch {
		case pct > 75:
			wrapCrit = append(wrapCrit, item)
		case pct > 40:
			wrapWarn = append(wrapWarn, item)
		case freeze > 0 && f(d.AgeDatFrozenXid) > freeze:
			forced = append(forced, item)
		}
	}
	if len(wrapCrit) > 0 {
		addIssue(&out, lang, "crit", "Очистка", "Угроза переполнения счётчика транзакций (wraparound)",
			"Эти базы данных близки к переполнению счётчика транзакций. Срочно выполните VACUUM FREEZE: при достижении предела PostgreSQL перестаёт принимать запись.", "/vacuum", wrapCrit)
	}
	if len(wrapWarn) > 0 {
		addIssue(&out, lang, "warn", "Очистка", "Высокий возраст XID", "Возраст замороженного XID растёт. Проверьте, успевает ли autovacuum.", "/vacuum", wrapWarn)
	}
	if len(forced) > 0 {
		addIssue(&out, lang, "info", "Очистка", "Скоро запустится autovacuum против переполнения (wraparound)",
			"Возраст XID превышает autovacuum_freeze_max_age — в этих базах запустится агрессивный autovacuum.", "/vacuum", forced)
	}

	// replication slots
	cur := currentLSN(m)
	var inactive []string
	for _, s := range m.ReplicationSlots {
		if s.Active {
			continue
		}
		item := fmt.Sprintf("%s (%s)", s.SlotName, s.SlotType) // retained WAL unknown (no restart LSN)
		if retained, ok := lsnDiff(cur, s.RestartLSN); ok {
			item = trf(lang, "%s (%s), удерживает %s WAL", s.SlotName, s.SlotType, fmtBytes(lang, retained))
		}
		inactive = append(inactive, item)
	}
	if len(inactive) > 0 {
		addIssue(&out, lang, "warn", "Репликация", "Неактивные слоты репликации",
			"Неактивные слоты не дают удалять файлы WAL и старые версии строк, из-за чего может переполниться диск. Удалите ненужные слоты.", "/replication", inactive)
	}
	var lagging []string
	for _, r := range m.ReplicationOutgoing {
		lag, ok := lsnDiff(cur, r.ReplayLSN)
		if (ok && lag > 1<<30) || r.ReplayLag > 60 {
			behind := "—" // unknown: e.g. pg_basebackup reports no replay LSN
			if ok {
				behind = fmtBytes(lang, lag)
			}
			lagging = append(lagging, trf(lang, "%s: отстаёт на %s, отставание воспроизведения %d с", standbyName(r), behind, r.ReplayLag))
		}
	}
	if len(lagging) > 0 {
		addIssue(&out, lang, "warn", "Репликация", "Реплики отстают", "Эти реплики отстают более чем на 1 ГиБ или 60 секунд.", "/replication", lagging)
	}
	notReplayed, known := lsnDiff(m.LastWALReceiveLSN, m.LastWALReplayLSN)
	if m.IsInRecovery && m.LastXActReplayTimestamp > 0 && at-m.LastXActReplayTimestamp > 300 && known && notReplayed > 0 {
		addIssue(&out, lang, "warn", "Репликация", "Реплика не успевает воспроизводить WAL",
			trf(lang, "Последняя транзакция воспроизведена %s назад, а полученный WAL ещё не воспроизведён полностью.", fmtSecs(lang, f(at-m.LastXActReplayTimestamp))), "/replication", nil)
	}
	if m.IsWalReplayPaused {
		addIssue(&out, lang, "warn", "Репликация", "Воспроизведение WAL приостановлено", "Выполните pg_wal_replay_resume(), чтобы продолжить воспроизведение WAL.", "/replication", nil)
	}
	for _, s := range m.Subscriptions {
		if s.ApplyErrorCount > 0 || s.SyncErrorCount > 0 {
			addIssue(&out, lang, "warn", "Репликация", "Ошибки подписки логической репликации",
				trf(lang, "Подписка «%s» в базе «%s»: ошибок применения — %d, ошибок синхронизации — %d.", s.Name, s.DBName, s.ApplyErrorCount, s.SyncErrorCount), "/replication", nil)
		}
	}

	// WAL and archiving
	if m.WALArchiving.FailedCount > 0 && m.WALArchiving.LastFailedTime > m.WALArchiving.LastArchivedTime {
		addIssue(&out, lang, "crit", "WAL", "Сбой архивации WAL",
			trf(lang, "Последняя попытка архивации (%s) завершилась ошибкой. Проверьте archive_command и место назначения архива.", m.WALArchiving.LastFailedWAL), "/wal", nil)
	}
	if m.WALReadyCount > 10 {
		addIssue(&out, lang, "warn", "WAL", "Файлы WAL ожидают архивации",
			trf(lang, "Файлов WAL, готовых к архивации, но ещё не заархивированных: %d. Архивация не успевает.", m.WALReadyCount), "/wal", nil)
	}
	if mw := setting(m, "max_wal_size"); mw > 0 && m.WALCount > 0 && float64(m.WALCount)*16 > 2*mw {
		addIssue(&out, lang, "warn", "WAL", "Слишком много файлов WAL",
			trf(lang, "Файлов в pg_wal: %d (≈%s) — больше удвоенного max_wal_size. Проверьте неактивные слоты, сбои архивации и wal_keep_size.", m.WALCount, fmtBytes(lang, float64(m.WALCount)*16*1024*1024)), "/wal", nil)
	}
	ckTimed, ckReq := m.BGWriter.CheckpointsTimed, m.BGWriter.CheckpointsRequested
	if c := m.Checkpointer; c != nil {
		ckTimed, ckReq = c.NumTimed, c.NumRequested
	}
	if ckReq > 10 && ckReq > ckTimed {
		addIssue(&out, lang, "warn", "WAL", "Слишком частые контрольные точки",
			trf(lang, "Контрольных точек по запросу: %d, по расписанию: %d. Увеличьте max_wal_size, чтобы сгладить пики ввода-вывода.", ckReq, ckTimed), "/wal", nil)
	}

	// connections and backends
	if mc := setting(m, "max_connections"); mc > 0 {
		if pct := 100 * f(len(m.Backends)) / mc; pct > 80 {
			sev := "warn"
			if pct > 95 {
				sev = "crit"
			}
			addIssue(&out, lang, sev, "Бэкенды", "Число подключений близко к max_connections",
				trf(lang, "Занято подключений: %d из %.0f (%.0f%%). Рассмотрите использование пула подключений.", len(m.Backends), mc, pct), "/backends", nil)
		}
	}
	var longX, idleX, waiting []string
	for _, b := range m.Backends {
		q := b.Query
		if t := truncRunes(q, 80); t != q {
			q = t + "…"
		}
		desc := fmt.Sprintf("PID %d (%s@%s): %s", b.PID, b.RoleName, b.DBName, q)
		if b.XactStart > 0 && at-b.XactStart > 300 {
			longX = append(longX, trf(lang, "%s — открыта %s", desc, fmtSecs(lang, f(at-b.XactStart))))
		}
		if strings.HasPrefix(b.State, "idle in transaction") && b.StateChange > 0 && at-b.StateChange > 60 {
			idleX = append(idleX, trf(lang, "%s — бездействует %s", desc, fmtSecs(lang, f(at-b.StateChange))))
		}
		if b.WaitEventType == "Lock" {
			waiting = append(waiting, desc)
		}
	}
	if len(longX) > 0 {
		addIssue(&out, lang, "warn", "Бэкенды", "Долгие транзакции",
			"Транзакции, открытые дольше 5 минут, мешают очистке (vacuum) и могут вызывать раздувание.", "/backends", longX)
	}
	if len(idleX) > 0 {
		addIssue(&out, lang, "warn", "Бэкенды", "Бездействие в транзакции (idle in transaction)",
			"Эти бэкенды открыли транзакцию и бездействуют дольше минуты. Задайте idle_in_transaction_session_timeout.", "/backends", idleX)
	}
	if len(waiting) > 0 {
		addIssue(&out, lang, "warn", "Блокировки", "Бэкенды ожидают блокировок", "Эти бэкенды заблокированы другими транзакциями.", "/locks", waiting)
	}
	if m.NotificationQueueUsage > 0.5 {
		addIssue(&out, lang, "warn", "Бэкенды", "Очередь уведомлений заполняется",
			trf(lang, "Очередь LISTEN/NOTIFY заполнена на %.0f%%: один из слушателей не забирает уведомления.", m.NotificationQueueUsage*100), "/", nil)
	}

	// databases
	var lowHit, lowCommit, temp, dl, csum []string
	for _, d := range m.Databases {
		if n := d.BlksHit + d.BlksRead; n > 10000 {
			if hit := 100 * f(d.BlksHit) / f(n); hit < 90 {
				lowHit = append(lowHit, fmt.Sprintf("%s: %s%%", d.Name, dec(lang, hit, 1)))
			}
		}
		if n := d.XactCommit + d.XactRollback; n > 1000 {
			if cr := 100 * f(d.XactCommit) / f(n); cr < 90 {
				lowCommit = append(lowCommit, trf(lang, "%s: доля фиксаций %s%%", d.Name, dec(lang, cr, 1)))
			}
		}
		if d.TempBytes > 1<<30 {
			temp = append(temp, trf(lang, "%s: %s во временных файлах (файлов: %d)", d.Name, fmtBytes(lang, f(d.TempBytes)), d.TempFiles))
		}
		if d.Deadlocks > 0 {
			dl = append(dl, trf(lang, "%s — взаимоблокировок: %d", d.Name, d.Deadlocks))
		}
		if d.ChecksumFailures > 0 {
			csum = append(csum, trf(lang, "%s — ошибок контрольных сумм: %d", d.Name, d.ChecksumFailures))
		}
	}
	if len(csum) > 0 {
		addIssue(&out, lang, "crit", "Базы данных", "Ошибки контрольных сумм данных", "Ошибки контрольных сумм указывают на повреждение данных на диске.", "/databases", csum)
	}
	if len(lowHit) > 0 {
		addIssue(&out, lang, "warn", "Базы данных", "Низкая доля попаданий в кеш",
			"Менее 90% чтений блоков обслуживается из общего буферного кеша. Рассмотрите увеличение shared_buffers или объёма RAM.", "/databases", lowHit)
	}
	if len(lowCommit) > 0 {
		addIssue(&out, lang, "info", "Базы данных", "Много откатов транзакций", "Многие транзакции откатываются — проверьте приложение на ошибки.", "/databases", lowCommit)
	}
	if len(temp) > 0 {
		addIssue(&out, lang, "info", "Базы данных", "Активное использование временных файлов", "Запросы сбрасывают данные на диск. Рассмотрите увеличение work_mem.", "/databases", temp)
	}
	if len(dl) > 0 {
		addIssue(&out, lang, "info", "Блокировки", "Обнаружены взаимоблокировки", "С момента последнего сброса статистики обнаружены взаимоблокировки.", "/locks", dl)
	}
	if len(m.Deadlocks) > 0 {
		var items []string
		for _, d := range m.Deadlocks {
			items = append(items, fmt.Sprintf("%s: %s", fmtTime(lang, d.At), firstLine(d.Detail)))
		}
		addIssue(&out, lang, "warn", "Блокировки", "Взаимоблокировки в журнале", "В журнале PostgreSQL найдены взаимоблокировки.", "/logs", items)
	}

	// tables
	var bloated, dead, neverVac, seqHeavy, noUnique []string
	unique := map[string]bool{}
	for _, i := range m.Indexes {
		if strings.Contains(i.Definition, "UNIQUE") {
			unique[i.DBName+"."+i.SchemaName+"."+i.TableName] = true
		}
	}
	for _, t := range m.Tables {
		if t.Bloat > 0 && t.Size > 10<<20 && f(t.Bloat)/f(t.Size) > 0.3 {
			bloated = append(bloated, trf(lang, "%s: раздувание %s из %s", tname(t), fmtBytes(lang, f(t.Bloat)), fmtBytes(lang, f(t.Size))))
		}
		if t.NDeadTup > 10000 && f(t.NDeadTup)/f(t.NLiveTup+t.NDeadTup) > 0.2 {
			dead = append(dead, trf(lang, "%s: мёртвых строк %d, живых %d", tname(t), t.NDeadTup, t.NLiveTup))
		}
		if t.NLiveTup > 1000 && t.LastVacuum == 0 && t.LastAutovacuum == 0 && t.LastAnalyze == 0 && t.LastAutoanalyze == 0 {
			neverVac = append(neverVac, tname(t))
		}
		if t.Size > 100<<20 && t.SeqScan > 1000 && t.SeqScan > t.IdxScan {
			seqHeavy = append(seqHeavy, trf(lang, "%s (%s): последовательных сканирований %d, индексных %d", tname(t), fmtBytes(lang, f(t.Size)), t.SeqScan, t.IdxScan))
		}
		if t.RelKind == "r" && t.NLiveTup > 1000 && !unique[tname(t)] {
			noUnique = append(noUnique, tname(t))
		}
	}
	if len(bloated) > 0 {
		addIssue(&out, lang, "warn", "Таблицы", "Раздутые таблицы", "Раздувание этих таблиц превышает 30%. Рассмотрите VACUUM FULL, pg_repack или настройку autovacuum.", "/tables", bloated)
	}
	if len(dead) > 0 {
		addIssue(&out, lang, "warn", "Таблицы", "Много мёртвых строк", "autovacuum не успевает обрабатывать эти таблицы.", "/vacuum", dead)
	}
	if len(neverVac) > 0 {
		addIssue(&out, lang, "info", "Таблицы", "Таблицы ни разу не очищались и не анализировались", "Для этих таблиц может отсутствовать статистика планировщика.", "/vacuum", neverVac)
	}
	if len(seqHeavy) > 0 {
		addIssue(&out, lang, "info", "Таблицы", "Большие таблицы читаются последовательным сканированием", "Возможно, этим таблицам не хватает индекса.", "/tables", seqHeavy)
	}
	if len(noUnique) > 0 {
		addIssue(&out, lang, "info", "Таблицы", "Таблицы без первичного ключа или уникального индекса",
			"Строки нельзя однозначно идентифицировать, из-за чего не работает логическая репликация UPDATE/DELETE.", "/tables", noUnique)
	}

	// indexes
	var unused, bloatIdx []string
	type defIdx struct {
		name       string
		rank       int  // which index of a duplicate group to keep: 0 primary key, 1 unique or constraint, 2 plain
		constraint bool // named like a constraint's index, which DROP INDEX cannot remove
	}
	defs := map[string][]defIdx{}
	rxName := regexp.MustCompile(`^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?\S+ ON `)
	rxConstraint := regexp.MustCompile(`_(pkey|key|excl)$`) // PostgreSQL's default constraint index names
	for _, i := range m.Indexes {
		iname := i.DBName + "." + i.SchemaName + "." + i.Name
		if i.IdxScan == 0 && !strings.Contains(i.Definition, "UNIQUE") && i.Size > 1<<20 {
			unused = append(unused, fmt.Sprintf("%s (%s)", iname, fmtBytes(lang, f(i.Size))))
		}
		if i.Bloat > 0 && i.Size > 10<<20 && f(i.Bloat)/f(i.Size) > 0.3 {
			bloatIdx = append(bloatIdx, trf(lang, "%s: раздувание %s из %s", iname, fmtBytes(lang, f(i.Bloat)), fmtBytes(lang, f(i.Size))))
		}
		if i.Definition != "" {
			k := i.DBName + "|" + rxName.ReplaceAllString(i.Definition, "")
			x := defIdx{name: iname, rank: 2, constraint: rxConstraint.MatchString(i.Name)}
			if strings.HasSuffix(i.Name, "_pkey") {
				x.rank = 0
			} else if x.constraint || strings.HasPrefix(i.Definition, "CREATE UNIQUE ") {
				x.rank = 1
			}
			defs[k] = append(defs[k], x)
		}
	}
	// equal definitions ignoring UNIQUE. pgmetrics reports no constraints: primary keys and unique
	// constraints have a UNIQUE index, and the default names above mark the rest. Keep the primary
	// key, else a unique or constraint index; while a plain equivalent exists propose dropping only
	// plain ones, and never a constraint's index (the same rule as the Duplicates tab, Objects.tsx)
	var dups []string
	for _, g := range defs {
		slices.SortStableFunc(g, func(a, b defIdx) int { return a.rank - b.rank })
		plain := slices.ContainsFunc(g[1:], func(x defIdx) bool { return x.rank == 2 })
		for _, x := range g[1:] {
			if plain && x.rank == 2 || !plain && !x.constraint {
				dups = append(dups, trf(lang, "%s повторяет %s", x.name, g[0].name))
			}
		}
	}
	sort.Strings(dups)
	if len(unused) > 0 {
		addIssue(&out, lang, "warn", "Индексы", "Неиспользуемые индексы",
			"Эти неуникальные индексы ни разу не сканировались с момента сброса статистики. Они замедляют запись — рассмотрите их удаление.", "/index-management", unused)
	}
	if len(dups) > 0 {
		addIssue(&out, lang, "warn", "Индексы", "Дублирующиеся индексы",
			"Каждый из этих индексов повторяет другой, и его можно удалить. Уникальные индексы, в том числе индексы первичных ключей и ограничений, не предлагаются к удалению, пока есть неуникальный дубликат.", "/index-management", dups)
	}
	if len(bloatIdx) > 0 {
		addIssue(&out, lang, "warn", "Индексы", "Раздутые индексы", "Перестройте их с помощью REINDEX CONCURRENTLY.", "/index-management", bloatIdx)
	}

	// misc objects
	var exts []string
	for _, e := range m.Extensions {
		if e.DefaultVersion != "" && e.InstalledVersion != e.DefaultVersion {
			exts = append(exts, fmt.Sprintf("%s.%s: %s → %s", e.DBName, e.Name, e.InstalledVersion, e.DefaultVersion))
		}
	}
	if len(exts) > 0 {
		addIssue(&out, lang, "info", "Расширения", "Доступны обновления расширений", "Выполните ALTER EXTENSION … UPDATE в каждой базе данных.", "/objects", exts)
	}
	if len(m.DisabledTriggers) > 0 {
		var items []string
		for _, t := range m.DisabledTriggers {
			items = append(items, fmt.Sprintf("%s.%s.%s: %s", t.DBName, t.SchemaName, t.TableName, t.Name))
		}
		addIssue(&out, lang, "info", "Объекты", "Отключённые триггеры", "Эти триггеры отключены.", "/objects", items)
	}
	for _, t := range m.Tablespaces {
		if t.DiskTotal > 0 {
			used := 100 * f(t.DiskUsed) / f(t.DiskTotal)
			if used > 80 {
				sev := "warn"
				if used > 90 {
					sev = "crit"
				}
				addIssue(&out, lang, sev, "Диск", "Диск почти заполнен",
					trf(lang, "Диск с табличным пространством «%s» заполнен на %.0f%% (свободно %s).", t.Name, used, fmtBytes(lang, f(t.DiskTotal-t.DiskUsed))), "/tablespaces", nil)
			}
		}
	}
	if v := setting(m, "server_version_num"); v > 0 && v < 140000 {
		addIssue(&out, lang, "warn", "Сервер", "Неподдерживаемая версия PostgreSQL",
			trf(lang, "PostgreSQL %s больше не получает исправлений безопасности. Запланируйте обновление.", m.Settings["server_version"].Setting), "/", nil)
	}
	var supers []string
	for _, r := range m.Roles {
		if r.Rolsuper && r.Rolcanlogin && r.Name != "postgres" && !strings.HasPrefix(r.Name, "rds") {
			supers = append(supers, r.Name)
		}
	}
	if len(supers) > 0 {
		addIssue(&out, lang, "info", "Безопасность", "Дополнительные роли суперпользователя", "Роли суперпользователя с правом входа. По возможности сократите их привилегии.", "/roles", supers)
	}
	if len(m.Statements) == 0 {
		addIssue(&out, lang, "info", "Запросы", "Нет статистики запросов",
			"pg_stat_statements не установлен или недоступен для чтения. Добавьте его в shared_preload_libraries и выполните CREATE EXTENSION pg_stat_statements.", "/queries", nil)
	}

	rank := map[string]int{"crit": 0, "warn": 1, "info": 2}
	sort.SliceStable(out, func(i, j int) bool { return rank[out[i].Severity] < rank[out[j].Severity] })
	return out
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return s
}

func fmtTime(lang string, t int64) string {
	layout := "02.01.2006 15:04 UTC"
	if lang == "en" {
		layout = "2006-01-02 15:04 UTC"
	}
	return time.Unix(t, 0).UTC().Format(layout)
}

//------------------------------------------------------------------------------
// configuration check

type recommendation struct {
	Category   string `json:"category"`    // localized label of CategoryID
	CategoryID string `json:"category_id"` // security | data_safety | performance | reliability
	Severity   string `json:"severity"`
	Setting    string `json:"setting"`
	Current    string `json:"current"`
	Advice     string `json:"advice"`
}

var configCategory = map[string]string{
	"security": "Безопасность", "data_safety": "Сохранность данных",
	"performance": "Производительность", "reliability": "Надёжность",
}

// sizes of the units pg_settings reports for memory settings, in bytes
var settingUnit = map[string]float64{
	"shared_buffers": 8192, "effective_cache_size": 8192, "wal_buffers": 8192,
	"work_mem": 1024, "maintenance_work_mem": 1024, "max_wal_size": 1 << 20, "min_wal_size": 1 << 20,
}

func settingStr(m *pgmetrics.Model, name, lang string) string {
	v, ok := m.Settings[name]
	if !ok {
		return ""
	}
	if u, ok := settingUnit[name]; ok {
		if n, err := strconv.ParseFloat(v.Setting, 64); err == nil && n >= 0 {
			return fmtBytes(lang, n*u)
		}
	}
	return v.Setting
}

func configCheck(m *pgmetrics.Model, lang string) []recommendation {
	out := []recommendation{}
	has := func(n string) bool { _, ok := m.Settings[n]; return ok }
	val := func(n string) string { return m.Settings[n].Setting }
	// advice is a Russian literal or already translated with trf
	add := func(cat, sev, name, advice string) {
		if has(name) {
			out = append(out, recommendation{Category: tr(lang, configCategory[cat]), CategoryID: cat,
				Severity: sev, Setting: name, Current: settingStr(m, name, lang), Advice: tr(lang, advice)})
		}
	}
	bytesOf := func(n string) float64 { return setting(m, n) * settingUnit[n] }

	// security
	if val("ssl") == "off" {
		add("security", "warn", "ssl", "SSL выключен: подключения и пароли передаются открытым текстом. Включите ssl.")
	}
	if val("password_encryption") == "md5" {
		add("security", "warn", "password_encryption", "Используйте scram-sha-256: хеширование паролей md5 ненадёжно и устарело.")
	}
	if val("listen_addresses") == "*" {
		add("security", "info", "listen_addresses", "Сервер принимает подключения на всех интерфейсах; ограничьте их, если клиенты подключаются только из определённых сетей.")
	}
	if val("log_connections") == "off" {
		add("security", "info", "log_connections", "Включите, чтобы вести журнал попыток подключения для аудита.")
	}
	if val("log_disconnections") == "off" {
		add("security", "info", "log_disconnections", "Включите, чтобы записывать длительность сеансов.")
	}
	if val("row_security") == "off" {
		add("security", "info", "row_security", "Защита на уровне строк (row level security) отключена для всего сервера.")
	}

	// data safety
	if val("fsync") == "off" {
		add("data_safety", "crit", "fsync", "fsync выключен: сбой или отключение питания могут повредить базу данных. Включите его.")
	}
	if val("full_page_writes") == "off" {
		add("data_safety", "crit", "full_page_writes", "Частично записанные страницы после сбоя могут повредить данные. Включите этот параметр.")
	}
	if val("synchronous_commit") == "off" {
		add("data_safety", "warn", "synchronous_commit", "При сбое могут быть потеряны недавно зафиксированные транзакции.")
	}
	if val("data_checksums") == "off" {
		add("data_safety", "info", "data_checksums", "Контрольные суммы выявляют повреждения данных в хранилище; включите их при initdb или с помощью pg_checksums.")
	}
	if val("wal_level") == "minimal" {
		add("data_safety", "warn", "wal_level", "Для восстановления на момент времени и репликации нужен wal_level replica или выше.")
	}
	if val("archive_mode") == "off" && !m.IsInRecovery {
		add("data_safety", "info", "archive_mode", "Архивация WAL выключена, поэтому восстановление на момент времени невозможно.")
	}

	// performance
	if sy := m.System; sy != nil && has("shared_buffers") {
		total := f(sy.MemUsed + sy.MemFree + sy.MemBuffers + sy.MemCached)
		if total > 0 && bytesOf("shared_buffers") < total/8 {
			add("performance", "info", "shared_buffers", trf(lang, "Обычно 25%% RAM (здесь — %s).", fmtBytes(lang, total/4)))
		}
	} else if bytesOf("shared_buffers") <= 128<<20 {
		add("performance", "info", "shared_buffers", trf(lang, "Всё ещё значение по умолчанию 128 МиБ; обычно задают 25%% RAM."))
	}
	if bytesOf("effective_cache_size") == 4<<30 {
		add("performance", "info", "effective_cache_size", trf(lang, "Значение по умолчанию; задайте около 50–75%% RAM, чтобы планировщик охотнее выбирал индексное сканирование."))
	}
	if bytesOf("work_mem") <= 4<<20 {
		var tb int64
		for _, d := range m.Databases {
			tb += d.TempBytes
		}
		if tb > 1<<30 {
			add("performance", "warn", "work_mem", trf(lang, "Запросы записали %s во временные файлы; увеличьте work_mem для сортировок и хеш-операций.", fmtBytes(lang, f(tb))))
		}
	}
	if bytesOf("maintenance_work_mem") <= 64<<20 {
		add("performance", "info", "maintenance_work_mem", "Значение по умолчанию 64 МиБ; большее значение ускоряет VACUUM и CREATE INDEX.")
	}
	if val("random_page_cost") == "4" {
		add("performance", "info", "random_page_cost", "Значение по умолчанию рассчитано на HDD; для SSD используйте 1.1.")
	}
	if v := setting(m, "checkpoint_completion_target"); has("checkpoint_completion_target") && v < 0.9 {
		add("performance", "info", "checkpoint_completion_target", "Используйте 0.9, чтобы равномернее распределить ввод-вывод контрольных точек.")
	}
	if val("track_io_timing") == "off" {
		add("performance", "info", "track_io_timing", "Включите, чтобы видеть время ввода-вывода для каждого запроса (на современных системах накладные расходы невелики).")
	}
	if v := val("effective_io_concurrency"); v == "1" || v == "0" {
		add("performance", "info", "effective_io_concurrency", "Для SSD используйте значение около 200, чтобы заранее считывать больше блоков.")
	}
	if setting(m, "max_connections") > 300 {
		add("performance", "warn", "max_connections", "Большое число подключений расходует память и CPU; используйте пул подключений, например PgBouncer.")
	}
	if !strings.Contains(val("shared_preload_libraries"), "pg_stat_statements") {
		add("performance", "info", "shared_preload_libraries", "Добавьте pg_stat_statements, чтобы отслеживать производительность запросов.")
	}

	// reliability
	if val("autovacuum") == "off" {
		add("reliability", "crit", "autovacuum", "autovacuum выключен: таблицы раздуваются, растёт риск переполнения счётчика транзакций (wraparound).")
	}
	if val("track_counts") == "off" {
		add("reliability", "crit", "track_counts", "autovacuum нужен track_counts, чтобы определять, какие таблицы очищать.")
	}
	if val("log_min_duration_statement") == "-1" {
		add("reliability", "info", "log_min_duration_statement", "Записывайте в журнал медленные запросы (например, дольше 1000 мс), чтобы находить проблемные.")
	}
	if val("idle_in_transaction_session_timeout") == "0" {
		add("reliability", "info", "idle_in_transaction_session_timeout", "Задайте тайм-аут, чтобы брошенные транзакции не удерживали блокировки и не мешали очистке (vacuum).")
	}
	if val("log_checkpoints") == "off" {
		add("reliability", "info", "log_checkpoints", "Записывайте контрольные точки в журнал, чтобы диагностировать пики ввода-вывода.")
	}
	if val("log_lock_waits") == "off" {
		add("reliability", "info", "log_lock_waits", "Записывайте в журнал ожидания блокировок дольше deadlock_timeout.")
	}
	if val("log_autovacuum_min_duration") == "-1" {
		add("reliability", "info", "log_autovacuum_min_duration", "Записывайте в журнал запуски autovacuum (например, дольше 1 с), чтобы видеть историю очистки.")
	}
	if m.IsInRecovery && val("hot_standby_feedback") == "off" {
		add("reliability", "info", "hot_standby_feedback", "Запросы на этой реплике могут отменяться из-за конфликтов репликации.")
	}
	if len(m.ReplicationSlots) > 0 && val("max_slot_wal_keep_size") == "-1" {
		add("reliability", "warn", "max_slot_wal_keep_size", "Слоты могут удерживать неограниченный объём WAL и переполнить диск; задайте предел.")
	}
	return out
}
