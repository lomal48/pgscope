package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"mime"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rapidloop/pgmetrics"
)

//------------------------------------------------------------------------------
// alert rule catalog

type objVal struct {
	Name, DB, Link, Query string
	Val                   float64
}

type evalCtx struct {
	m     *pgmetrics.Model
	sid   int64
	name  string
	param float64
}

func (c *evalCtx) link(path string) string { return fmt.Sprintf("%s/#/s/%d%s", cfg.BaseURL, c.sid, path) }

type metricDef struct {
	ID    string `json:"id"`
	Level string `json:"level"` // server | database | table | tablespace | query
	Label string `json:"label"`
	Unit  string `json:"unit"`            // count | bytes | secs | ms | pct
	Param string `json:"param,omitempty"` // label of the extra parameter, if any (in seconds)
	vals  func(c *evalCtx) []objVal
}

func one(c *evalCtx, path string, v float64) []objVal {
	return []objVal{{Name: c.name, Link: c.link(path), Val: v}}
}

func countBackends(c *evalCtx, pred func(b pgmetrics.Backend) bool) []objVal {
	n := 0
	for _, b := range c.m.Backends {
		if pred(b) {
			n++
		}
	}
	return one(c, "/backends", float64(n))
}

func standbyLags(c *evalCtx, pick func(r pgmetrics.ReplicationOut) string) []objVal {
	var out []objVal
	cur := currentLSN(c.m)
	for _, r := range c.m.ReplicationOutgoing {
		if lag, ok := lsnDiff(cur, pick(r)); ok { // e.g. pg_basebackup reports no write/flush/replay LSN
			out = append(out, objVal{Name: standbyName(r), Link: c.link("/replication"), Val: lag})
		}
	}
	return out
}

func perDB(c *evalCtx, fn func(d pgmetrics.Database) (float64, bool)) []objVal {
	var out []objVal
	for _, d := range c.m.Databases {
		if v, ok := fn(d); ok {
			out = append(out, objVal{Name: d.Name, DB: d.Name, Link: c.link("/databases/" + url.PathEscape(d.Name)), Val: v})
		}
	}
	return out
}

func perTable(c *evalCtx, fn func(t pgmetrics.Table) (float64, bool)) []objVal {
	var out []objVal
	for _, t := range c.m.Tables {
		if v, ok := fn(t); ok {
			out = append(out, objVal{Name: t.DBName + "." + t.SchemaName + "." + t.Name, DB: t.DBName,
				Link: c.link("/tables/" + url.PathEscape(t.DBName) + "/" + url.PathEscape(t.SchemaName) + "/" + url.PathEscape(t.Name)), Val: v})
		}
	}
	return out
}

func perTablespace(c *evalCtx, fn func(t pgmetrics.Tablespace) (float64, bool)) []objVal {
	var out []objVal
	for _, t := range c.m.Tablespaces {
		if v, ok := fn(t); ok {
			out = append(out, objVal{Name: t.Name, Link: c.link("/tablespaces"), Val: v})
		}
	}
	return out
}

// truncRunes cuts s to at most n characters without splitting a UTF-8 sequence.
func truncRunes(s string, n int) string {
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}

func perQuery(c *evalCtx, fn func(q pgmetrics.Statement) float64) []objVal {
	var out []objVal
	for _, q := range statements(c.m) {
		out = append(out, objVal{Name: truncRunes(q.Query, 20), DB: q.DBName, Query: q.Query, Val: fn(q),
			Link: c.link(fmt.Sprintf("/queries/%s/%d", url.PathEscape(q.DBName), q.QueryID))})
	}
	return out
}

func lastOf(ts ...int64) int64 { return slices.Max(ts) }

func sinceOrInf(at, t int64) float64 {
	if t == 0 {
		return math.Inf(1) // never happened
	}
	return float64(at - t)
}

var catalog = []metricDef{
	{ID: "xid_range", Level: "server", Label: "Диапазон XID", Unit: "count", vals: func(c *evalCtx) []objVal {
		if c.m.OldestXid == 0 { // not collected
			return nil
		}
		return one(c, "/vacuum", xidRange(c.m))
	}},
	{ID: "checkpoint_age", Level: "server", Label: "Время с последней контрольной точки", Unit: "secs", vals: func(c *evalCtx) []objVal {
		return one(c, "/wal", f(c.m.Metadata.At-c.m.CheckpointTime))
	}},
	{ID: "inactive_slots", Level: "server", Label: "Число неактивных слотов репликации", Unit: "count", vals: func(c *evalCtx) []objVal {
		n := 0
		for _, s := range c.m.ReplicationSlots {
			if !s.Active {
				n++
			}
		}
		return one(c, "/replication", float64(n))
	}},
	{ID: "repl_write_lag", Level: "server", Label: "Отставание репликации по записи (write) на ведущем", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		return standbyLags(c, func(r pgmetrics.ReplicationOut) string { return r.WriteLSN })
	}},
	{ID: "repl_flush_lag", Level: "server", Label: "Отставание репликации по сбросу (flush) на ведущем", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		return standbyLags(c, func(r pgmetrics.ReplicationOut) string { return r.FlushLSN })
	}},
	{ID: "repl_replay_lag", Level: "server", Label: "Отставание репликации по воспроизведению (replay) на ведущем", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		return standbyLags(c, func(r pgmetrics.ReplicationOut) string { return r.ReplayLSN })
	}},
	{ID: "standby_lag_bytes", Level: "server", Label: "Отставание воспроизведения на реплике", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		lag, ok := lsnDiff(c.m.LastWALReceiveLSN, c.m.LastWALReplayLSN)
		if !c.m.IsInRecovery || !ok {
			return nil
		}
		return one(c, "/replication", lag)
	}},
	{ID: "standby_lag_secs", Level: "server", Label: "Отставание воспроизведения на реплике", Unit: "secs", vals: func(c *evalCtx) []objVal {
		if !c.m.IsInRecovery || c.m.LastXActReplayTimestamp == 0 {
			return nil
		}
		return one(c, "/replication", f(c.m.Metadata.At-c.m.LastXActReplayTimestamp))
	}},
	{ID: "wal_files", Level: "server", Label: "Число файлов WAL", Unit: "count", vals: func(c *evalCtx) []objVal {
		return one(c, "/wal", f(c.m.WALCount))
	}},
	{ID: "wal_ready", Level: "server", Label: "Число файлов WAL, готовых к архивации", Unit: "count", vals: func(c *evalCtx) []objVal {
		return one(c, "/wal", f(c.m.WALReadyCount))
	}},
	{ID: "backends_waiting", Level: "server", Label: "Число бэкендов, ожидающих блокировки", Unit: "count", vals: func(c *evalCtx) []objVal {
		return countBackends(c, func(b pgmetrics.Backend) bool { return b.WaitEventType == "Lock" })
	}},
	{ID: "backends_idle_xact", Level: "server", Label: "Число бэкендов в состоянии idle in transaction", Unit: "count", vals: func(c *evalCtx) []objVal {
		return countBackends(c, func(b pgmetrics.Backend) bool { return strings.HasPrefix(b.State, "idle in transaction") })
	}},
	{ID: "backends_long_xact", Level: "server", Label: "Число бэкендов с транзакциями, открытыми дольше", Unit: "count",
		Param: "возраст транзакции", vals: func(c *evalCtx) []objVal {
			return countBackends(c, func(b pgmetrics.Backend) bool {
				return b.XactStart > 0 && float64(c.m.Metadata.At-b.XactStart) > c.param
			})
		}},
	{ID: "server_backends", Level: "server", Label: "Общее число бэкендов", Unit: "count", vals: func(c *evalCtx) []objVal {
		return one(c, "/backends", f(len(c.m.Backends)))
	}},

	{ID: "db_backends", Level: "database", Label: "Число бэкендов", Unit: "count", vals: func(c *evalCtx) []objVal {
		return perDB(c, func(d pgmetrics.Database) (float64, bool) { return f(d.NumBackends), true })
	}},
	{ID: "db_backends_pct", Level: "database", Label: "Доля бэкендов от максимума подключений", Unit: "pct", vals: func(c *evalCtx) []objVal {
		max := setting(c.m, "max_connections")
		return perDB(c, func(d pgmetrics.Database) (float64, bool) {
			lim := max
			if d.DatConnLimit > 0 {
				lim = f(d.DatConnLimit)
			}
			return 100 * ratio(f(d.NumBackends), lim), lim > 0
		})
	}},
	{ID: "db_commit_ratio", Level: "database", Label: "Доля фиксаций", Unit: "pct", vals: func(c *evalCtx) []objVal {
		return perDB(c, func(d pgmetrics.Database) (float64, bool) {
			n := f(d.XactCommit + d.XactRollback)
			return 100 * ratio(f(d.XactCommit), n), n > 0
		})
	}},
	{ID: "db_xid_age_pct", Level: "database", Label: "Возраст XID в процентах от autovacuum_freeze_max_age", Unit: "pct", vals: func(c *evalCtx) []objVal {
		fm := setting(c.m, "autovacuum_freeze_max_age")
		return perDB(c, func(d pgmetrics.Database) (float64, bool) { return 100 * ratio(f(d.AgeDatFrozenXid), fm), fm > 0 })
	}},
	{ID: "db_size", Level: "database", Label: "Размер базы данных", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		return perDB(c, func(d pgmetrics.Database) (float64, bool) { return f(d.Size), d.Size >= 0 })
	}},
	{ID: "db_disabled_triggers", Level: "database", Label: "Число отключённых триггеров", Unit: "count", vals: func(c *evalCtx) []objVal {
		return perDB(c, func(d pgmetrics.Database) (float64, bool) {
			n := 0
			for _, t := range c.m.DisabledTriggers {
				if t.DBName == d.Name {
					n++
				}
			}
			return f(n), true
		})
	}},
	{ID: "db_cache_hit", Level: "database", Label: "Попадания в кеш", Unit: "pct", vals: func(c *evalCtx) []objVal {
		return perDB(c, func(d pgmetrics.Database) (float64, bool) {
			n := f(d.BlksHit + d.BlksRead)
			return 100 * ratio(f(d.BlksHit), n), n > 0
		})
	}},

	{ID: "tbl_since_vacuum", Level: "table", Label: "Время с последней очистки (vacuum)", Unit: "secs", vals: func(c *evalCtx) []objVal {
		return perTable(c, func(t pgmetrics.Table) (float64, bool) {
			return sinceOrInf(c.m.Metadata.At, lastOf(t.LastVacuum, t.LastAutovacuum)), true
		})
	}},
	{ID: "tbl_since_analyze", Level: "table", Label: "Время с последнего сбора статистики (analyze)", Unit: "secs", vals: func(c *evalCtx) []objVal {
		return perTable(c, func(t pgmetrics.Table) (float64, bool) {
			return sinceOrInf(c.m.Metadata.At, lastOf(t.LastAnalyze, t.LastAutoanalyze)), true
		})
	}},
	{ID: "tbl_size", Level: "table", Label: "Размер таблицы", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		return perTable(c, func(t pgmetrics.Table) (float64, bool) { return f(t.Size), t.Size >= 0 })
	}},
	{ID: "tbl_bloat", Level: "table", Label: "Раздувание таблицы", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		return perTable(c, func(t pgmetrics.Table) (float64, bool) { return f(t.Bloat), t.Bloat >= 0 })
	}},
	{ID: "tbl_bloat_pct", Level: "table", Label: "Раздувание таблицы в процентах от размера", Unit: "pct", vals: func(c *evalCtx) []objVal {
		return perTable(c, func(t pgmetrics.Table) (float64, bool) { return 100 * ratio(f(t.Bloat), f(t.Size)), t.Bloat >= 0 && t.Size > 0 })
	}},

	{ID: "ts_size", Level: "tablespace", Label: "Размер табличного пространства", Unit: "bytes", vals: func(c *evalCtx) []objVal {
		return perTablespace(c, func(t pgmetrics.Tablespace) (float64, bool) { return f(t.Size), t.Size >= 0 })
	}},
	{ID: "ts_disk_free_pct", Level: "tablespace", Label: "Свободное место на диске", Unit: "pct", vals: func(c *evalCtx) []objVal {
		return perTablespace(c, func(t pgmetrics.Tablespace) (float64, bool) {
			return 100 * ratio(f(t.DiskTotal-t.DiskUsed), f(t.DiskTotal)), t.DiskTotal > 0
		})
	}},
	{ID: "ts_inodes_free_pct", Level: "tablespace", Label: "Свободные inode", Unit: "pct", vals: func(c *evalCtx) []objVal {
		return perTablespace(c, func(t pgmetrics.Tablespace) (float64, bool) {
			return 100 * ratio(f(t.InodesTotal-t.InodesUsed), f(t.InodesTotal)), t.InodesTotal > 0
		})
	}},

	{ID: "query_max_time", Level: "query", Label: "Макс. время выполнения запроса", Unit: "ms", vals: func(c *evalCtx) []objVal {
		return perQuery(c, func(q pgmetrics.Statement) float64 { return q.MaxTime })
	}},
	{ID: "query_mean_time", Level: "query", Label: "Среднее время выполнения запроса", Unit: "ms", vals: func(c *evalCtx) []objVal {
		return perQuery(c, func(q pgmetrics.Statement) float64 { return ratio(q.TotalTime, f(q.Calls)) })
	}},
}

func findMetric(id string) *metricDef {
	for i := range catalog {
		if catalog[i].ID == id {
			return &catalog[i]
		}
	}
	return nil
}

//------------------------------------------------------------------------------
// rule evaluation (edge-triggered, run whenever a report arrives)

type rule struct {
	ID        int64   `json:"id"`
	Metric    string  `json:"metric"`
	Op        string  `json:"op"`
	Threshold float64 `json:"threshold"`
	Param     float64 `json:"param"`
	Severity  string  `json:"severity"`
	Match     string  `json:"match"`
	MatchText string  `json:"match_text"`
	DBName    string  `json:"db_name"`
}

// alertItem is stored structured (Metric..Never); renderAlerts fills Text/Value
// in a language and drops the structured fields, so rendered JSON keeps the
// public shape {type,text,value,objname,objlink,query}.
type alertItem struct {
	Type      string  `json:"type"`
	Text      string  `json:"text"`
	Value     string  `json:"value"`
	ObjName   string  `json:"objname"`
	ObjLink   string  `json:"objlink"`
	Query     string  `json:"query,omitempty"`
	Metric    string  `json:"metric,omitempty"`
	Op        string  `json:"op,omitempty"`
	Threshold float64 `json:"threshold,omitempty"`
	Param     float64 `json:"param,omitempty"`
	Raw       float64 `json:"raw,omitempty"`
	Never     bool    `json:"never,omitempty"` // value is +Inf (JSON cannot encode it)
}

func (r rule) matches(o objVal) bool {
	if r.DBName != "" && o.DB != r.DBName {
		return false
	}
	t := r.MatchText
	switch r.Match {
	case "contains":
		return strings.Contains(o.Name, t)
	case "notcontains":
		return !strings.Contains(o.Name, t)
	case "startswith":
		return strings.HasPrefix(o.Name, t)
	case "endswith":
		return strings.HasSuffix(o.Name, t)
	case "exact":
		return o.Name == t
	}
	return true
}

func ruleText(lang string, d *metricDef, op string, threshold, param float64) string {
	label := tr(lang, d.Label)
	if d.Param != "" {
		label += " " + fmtSecs(lang, param)
	}
	ops := tr(lang, "больше")
	if op == "lt" {
		ops = tr(lang, "меньше")
	}
	return label + " " + ops + " " + fmtUnit(lang, d.Unit, threshold)
}

func evaluate(sid int64, name string, m *pgmetrics.Model, rules []rule) []alertItem {
	items := []alertItem{}
	for _, r := range rules {
		d := findMetric(r.Metric)
		if d == nil {
			continue
		}
		for _, o := range d.vals(&evalCtx{m: m, sid: sid, name: name, param: r.Param}) {
			if !r.matches(o) || !((r.Op == "gt" && o.Val > r.Threshold) || (r.Op == "lt" && o.Val < r.Threshold)) {
				continue
			}
			a := alertItem{Type: r.Severity, Metric: r.Metric, Op: r.Op, Threshold: r.Threshold, Param: r.Param,
				ObjName: o.Name, ObjLink: o.Link, Query: o.Query}
			if math.IsInf(o.Val, 1) {
				a.Never = true
			} else {
				a.Raw = o.Val
			}
			items = append(items, a)
		}
	}
	slices.SortFunc(items, func(a, b alertItem) int { return strings.Compare(a.key(), b.key()) })
	return items
}

// key identifies an alert independently of the language; legacy items (stored
// already rendered, without Metric) are keyed by their text.
func (a alertItem) key() string {
	if a.Metric == "" {
		return a.Type + "\x00" + a.Text + "\x00" + a.ObjName
	}
	return fmt.Sprint(a.Type, "\x00", a.Metric, "\x00", a.Op, "\x00", a.Threshold, "\x00", a.Param, "\x00", a.ObjName)
}

// renderAlerts returns copies of items with Text/Value in lang (never nil).
func renderAlerts(lang string, items []alertItem) []alertItem {
	out := make([]alertItem, len(items))
	for i, a := range items {
		if d := findMetric(a.Metric); d != nil {
			v := a.Raw
			if a.Never {
				v = math.Inf(1)
			}
			a = alertItem{Type: a.Type, Text: ruleText(lang, d, a.Op, a.Threshold, a.Param), Value: fmtUnit(lang, d.Unit, v),
				ObjName: a.ObjName, ObjLink: a.ObjLink, Query: a.Query}
		}
		out[i] = a
	}
	return out
}

func loadRules(ctx context.Context, sid int64) []rule {
	rules := []rule{}
	rows, err := db.Query(ctx, `select id, metric, op, threshold, param, severity, match, match_text, db_name
		from alert_rules where server_id = $1 order by id`, sid)
	if err != nil {
		return rules
	}
	defer rows.Close()
	for rows.Next() {
		var r rule
		rows.Scan(&r.ID, &r.Metric, &r.Op, &r.Threshold, &r.Param, &r.Severity, &r.Match, &r.MatchText, &r.DBName)
		rules = append(rules, r)
	}
	return rules
}

// runAlerts evaluates all rules and notifies only when the set of triggered
// alerts changed since the last evaluation.
func runAlerts(ctx context.Context, sid int64, name string, m *pgmetrics.Model) {
	items := evaluate(sid, name, m, loadRules(ctx, sid))
	var prevRaw []byte
	db.QueryRow(ctx, `select alerts from alert_state where server_id = $1`, sid).Scan(&prevRaw)
	var prev []alertItem
	json.Unmarshal(prevRaw, &prev)
	changed := !slices.EqualFunc(prev, items, func(a, b alertItem) bool { return a.key() == b.key() })
	at := time.Unix(m.Metadata.At, 0)
	db.Exec(ctx, `insert into alert_state values ($1,$2,$3) on conflict (server_id) do update set at = $2, alerts = $3`, sid, at, items)
	if !changed {
		return
	}
	payload := func(items []alertItem) map[string]any {
		return map[string]any{"version": 1, "server": name, "reported": m.Metadata.At, "alerts": items}
	}
	db.Exec(ctx, `insert into events(server_id, at, kind, body) values ($1,$2,'alerts',$3)`, sid, at, payload(items))
	notifyAll(ctx, sid, "alerts", name, func(lang string) note {
		r := renderAlerts(lang, items)
		subject, text := alertMessage(lang, name, r)
		return note{subject, text, payload(r), r}
	})
}

// alertMessage builds the subject and body of a notification about rendered items.
func alertMessage(lang, name string, items []alertItem) (string, string) {
	if len(items) == 0 {
		return trf(lang, "[pgscope] %s: все оповещения сняты", name), trf(lang, "Все оповещения сервера «%s» сняты.", name) + "\n"
	}
	crit := 0
	var b strings.Builder
	for _, a := range items {
		if a.Type == "crit" {
			crit++
		}
		sev := tr(lang, map[string]string{"crit": "Критично", "warn": "Предупреждение"}[a.Type])
		fmt.Fprintf(&b, "[%s] %s — %s: %s\n      %s\n", sev, a.Text, a.ObjName, a.Value, a.ObjLink)
	}
	return trf(lang, "[pgscope] %s: оповещения (критичных: %d, предупреждений: %d)", name, crit, len(items)-crit), b.String()
}

func afterReport(sid int64, name string, m *pgmetrics.Model) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	runAlerts(ctx, sid, name, m)
	runChangeAlerts(ctx, sid, name, m)
}

//------------------------------------------------------------------------------
// change alerts: differences between two consecutive reports

// change is stored structured (Code..Unit); renderChanges fills Item/Prev/Curr
// in a language and drops the structured fields (public shape {item,prev,curr}).
type change struct {
	Item    string `json:"item"`
	Prev    string `json:"prev,omitempty"`
	Curr    string `json:"curr,omitempty"`
	Code    string `json:"code,omitempty"`
	Obj     string `json:"obj,omitempty"`
	PrevRaw string `json:"prev_raw,omitempty"`
	CurrRaw string `json:"curr_raw,omitempty"`
	Unit    string `json:"unit,omitempty"` // bytes | time | mode | role | ""
}

// changeText: Russian source text of each change code; %s is the object.
var changeText = map[string]string{
	"restart":           "Сервер перезапущен",
	"version":           "Изменилась версия PostgreSQL",
	"sysid":             "Изменился системный идентификатор",
	"recovery":          "Изменился режим восстановления",
	"role_added":        "Добавлен пользователь",
	"role_removed":      "Удалён пользователь",
	"role_changed":      "Изменён пользователь «%s»",
	"database_added":    "Добавлена база данных",
	"database_removed":  "Удалена база данных",
	"table_added":       "Добавлена таблица",
	"table_removed":     "Удалена таблица",
	"index_added":       "Добавлен индекс",
	"index_removed":     "Удалён индекс",
	"table_size":        "Изменился размер таблицы «%s»",
	"table_rows":        "Изменилось число строк таблицы «%s»",
	"db_size":           "Изменился размер базы данных «%s»",
	"tablespace_size":   "Изменился размер табличного пространства «%s»",
	"extension_added":   "Добавлено расширение",
	"extension_removed": "Удалено расширение",
	"extension_version": "Изменилась версия расширения «%s»",
	"setting_changed":   "Изменён параметр «%s»",
	"slot_added":        "Добавлен слот репликации",
	"slot_removed":      "Удалён слот репликации",
	"trigger_disabled":  "Отключён триггер",
}

func changeItem(lang string, c change) string {
	s := changeText[c.Code]
	if strings.Contains(s, "%s") {
		return trf(lang, s, c.Obj)
	}
	return tr(lang, s)
}

func changeVal(lang, unit, raw string) string {
	if raw == "" {
		return ""
	}
	switch unit {
	case "bytes":
		v, _ := strconv.ParseFloat(raw, 64)
		return fmtBytes(lang, v)
	case "time":
		v, _ := strconv.ParseInt(raw, 10, 64)
		return time.Unix(v, 0).UTC().Format(time.RFC3339)
	case "mode":
		return tr(lang, map[string]string{"primary": "ведущий", "standby": "реплика"}[raw])
	case "role":
		attrs, member, _ := strings.Cut(raw, "\n")
		return trf(lang, "атрибуты: %s; входит в: %s", orDash(attrs), orDash(member))
	}
	return raw
}

// renderChanges returns copies of cs with Item/Prev/Curr in lang (never nil).
func renderChanges(lang string, cs []change) []change {
	out := make([]change, len(cs))
	for i, c := range cs {
		if c.Code != "" {
			c = change{Item: changeItem(lang, c), Prev: changeVal(lang, c.Unit, c.PrevRaw), Curr: changeVal(lang, c.Unit, c.CurrRaw)}
		}
		out[i] = c
	}
	return out
}

type changeKind struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

var changeKinds = []changeKind{
	{"restart", "Перезапуск сервера"},
	{"version", "Изменение версии PostgreSQL"},
	{"sysid", "Изменение системного идентификатора (восстановление или новый кластер)"},
	{"recovery", "Изменение режима восстановления (повышение или понижение)"},
	{"roles", "Добавление, удаление или изменение пользователей / ролей"},
	{"databases", "Добавление или удаление баз данных"},
	{"tables", "Добавление или удаление таблиц"},
	{"indexes", "Добавление или удаление индексов"},
	{"table_size", "Резкое изменение размера таблицы"},
	{"table_rows", "Резкое изменение числа строк таблицы"},
	{"db_size", "Резкое изменение размера базы данных"},
	{"tablespace_size", "Резкое изменение размера табличного пространства"},
	{"extensions", "Добавление, удаление или обновление расширений"},
	{"settings", "Изменение параметров конфигурации"},
	{"slots", "Добавление или удаление слотов репликации"},
	{"triggers", "Отключение триггеров"},
}

func setDiff[T any](prev, curr []T, key func(T) string, addCode, delCode string, out *[]change) {
	p, c := map[string]bool{}, map[string]bool{}
	for _, x := range prev {
		p[key(x)] = true
	}
	for _, x := range curr {
		c[key(x)] = true
	}
	for k := range c {
		if !p[k] {
			*out = append(*out, change{Code: addCode, CurrRaw: k})
		}
	}
	for k := range p {
		if !c[k] {
			*out = append(*out, change{Code: delCode, PrevRaw: k})
		}
	}
}

// abrupt reports a relative change above pct; pgmetrics reports -1 for sizes it could not read
func abrupt(prev, curr, pct, min float64) bool {
	return prev >= 0 && curr >= 0 && math.Max(prev, curr) >= min && math.Abs(curr-prev) > pct/100*math.Max(prev, 1)
}

// detectChanges returns structured changes; renderChanges turns them into text.
func detectChanges(p, c *pgmetrics.Model, kinds []string, pct float64) []change {
	on := func(k string) bool { return slices.Contains(kinds, k) }
	out := []change{}
	add := func(code, obj, unit, prev, curr string) {
		out = append(out, change{Code: code, Obj: obj, Unit: unit, PrevRaw: prev, CurrRaw: curr})
	}
	i64 := func(v int64) string { return strconv.FormatInt(v, 10) }
	if on("restart") && p.StartTime != c.StartTime {
		add("restart", "", "time", i64(p.StartTime), i64(c.StartTime))
	}
	if on("version") && p.Settings["server_version"].Setting != c.Settings["server_version"].Setting {
		add("version", "", "", p.Settings["server_version"].Setting, c.Settings["server_version"].Setting)
	}
	if on("sysid") && p.SystemIdentifier != c.SystemIdentifier {
		add("sysid", "", "", p.SystemIdentifier, c.SystemIdentifier)
	}
	if on("recovery") && p.IsInRecovery != c.IsInRecovery {
		mode := map[bool]string{true: "standby", false: "primary"}
		add("recovery", "", "mode", mode[p.IsInRecovery], mode[c.IsInRecovery])
	}
	if on("roles") {
		setDiff(p.Roles, c.Roles, func(r pgmetrics.Role) string { return r.Name }, "role_added", "role_removed", &out)
		attrs := func(r pgmetrics.Role) string { // "flags\nmember of", see changeVal
			flags := []string{}
			for n, v := range map[string]bool{"superuser": r.Rolsuper, "createrole": r.Rolcreaterole, "createdb": r.Rolcreatedb,
				"login": r.Rolcanlogin, "replication": r.Rolreplication, "bypassrls": r.Rolbypassrls} {
				if v {
					flags = append(flags, n)
				}
			}
			slices.Sort(flags)
			m := slices.Clone(r.MemberOf)
			slices.Sort(m)
			return strings.Join(flags, ",") + "\n" + strings.Join(m, ",")
		}
		prev := map[string]string{}
		for _, r := range p.Roles {
			prev[r.Name] = attrs(r)
		}
		for _, r := range c.Roles {
			if a, ok := prev[r.Name]; ok && a != attrs(r) {
				add("role_changed", r.Name, "role", a, attrs(r))
			}
		}
	}
	if on("databases") {
		setDiff(p.Databases, c.Databases, func(d pgmetrics.Database) string { return d.Name }, "database_added", "database_removed", &out)
	}
	tkey := func(t pgmetrics.Table) string { return t.DBName + "." + t.SchemaName + "." + t.Name }
	if on("tables") {
		setDiff(p.Tables, c.Tables, tkey, "table_added", "table_removed", &out)
	}
	if on("indexes") {
		setDiff(p.Indexes, c.Indexes, func(i pgmetrics.Index) string { return i.DBName + "." + i.SchemaName + "." + i.Name }, "index_added", "index_removed", &out)
	}
	if on("table_size") || on("table_rows") {
		prev := map[string]pgmetrics.Table{}
		for _, t := range p.Tables {
			prev[tkey(t)] = t
		}
		for _, t := range c.Tables {
			o, ok := prev[tkey(t)]
			if !ok {
				continue
			}
			// ponytail: fixed noise floors (1 MiB, 1000 rows); make them rule settings if users ask
			if on("table_size") && abrupt(f(o.Size), f(t.Size), pct, 1<<20) {
				add("table_size", tkey(t), "bytes", i64(o.Size), i64(t.Size))
			}
			if on("table_rows") && abrupt(f(o.NLiveTup), f(t.NLiveTup), pct, 1000) {
				add("table_rows", tkey(t), "", i64(o.NLiveTup), i64(t.NLiveTup))
			}
		}
	}
	if on("db_size") {
		prev := map[string]int64{}
		for _, d := range p.Databases {
			prev[d.Name] = d.Size
		}
		for _, d := range c.Databases {
			if o, ok := prev[d.Name]; ok && abrupt(f(o), f(d.Size), pct, 1<<20) {
				add("db_size", d.Name, "bytes", i64(o), i64(d.Size))
			}
		}
	}
	if on("tablespace_size") {
		prev := map[string]int64{}
		for _, t := range p.Tablespaces {
			prev[t.Name] = t.Size
		}
		for _, t := range c.Tablespaces {
			if o, ok := prev[t.Name]; ok && abrupt(f(o), f(t.Size), pct, 1<<20) {
				add("tablespace_size", t.Name, "bytes", i64(o), i64(t.Size))
			}
		}
	}
	if on("extensions") {
		ekey := func(e pgmetrics.Extension) string { return e.DBName + "." + e.Name }
		setDiff(p.Extensions, c.Extensions, ekey, "extension_added", "extension_removed", &out)
		prev := map[string]string{}
		for _, e := range p.Extensions {
			prev[ekey(e)] = e.InstalledVersion
		}
		for _, e := range c.Extensions {
			if v, ok := prev[ekey(e)]; ok && v != e.InstalledVersion {
				add("extension_version", ekey(e), "", v, e.InstalledVersion)
			}
		}
	}
	if on("settings") {
		for k, v := range c.Settings {
			if o, ok := p.Settings[k]; ok && o.Setting != v.Setting {
				add("setting_changed", k, "", o.Setting, v.Setting)
			}
		}
	}
	if on("slots") {
		setDiff(p.ReplicationSlots, c.ReplicationSlots, func(s pgmetrics.ReplicationSlot) string { return s.SlotName },
			"slot_added", "slot_removed", &out)
	}
	if on("triggers") {
		trk := func(t pgmetrics.Trigger) string { return t.DBName + "." + t.SchemaName + "." + t.TableName + "." + t.Name }
		var added []change
		setDiff(p.DisabledTriggers, c.DisabledTriggers, trk, "trigger_disabled", "", &added)
		for _, a := range added {
			if a.Code == "trigger_disabled" {
				out = append(out, a)
			}
		}
	}
	slices.SortStableFunc(out, func(a, b change) int { return strings.Compare(changeItem("ru", a), changeItem("ru", b)) })
	return out
}

func loadChangeRules(ctx context.Context, sid int64) ([]string, float64) {
	kinds, pct := []string{}, 20.0
	db.QueryRow(ctx, `select kinds, size_pct from change_rules where server_id = $1`, sid).Scan(&kinds, &pct)
	return kinds, pct
}

func runChangeAlerts(ctx context.Context, sid int64, name string, m *pgmetrics.Model) {
	kinds, pct := loadChangeRules(ctx, sid)
	if len(kinds) == 0 {
		return
	}
	prev, err := loadModel(ctx, sid, "", m.Metadata.At-1)
	if err != nil {
		return // first report
	}
	changes := detectChanges(prev, m, kinds, pct)
	if len(changes) == 0 {
		return
	}
	payload := func(cs []change) map[string]any {
		return map[string]any{"version": 1, "server": name, "prevreport": prev.Metadata.At, "currreport": m.Metadata.At, "changes": cs}
	}
	db.Exec(ctx, `insert into events(server_id, at, kind, body) values ($1,$2,'changes',$3)`, sid, time.Unix(m.Metadata.At, 0), payload(changes))
	notifyAll(ctx, sid, "changes", name, func(lang string) note {
		cs := renderChanges(lang, changes)
		var b strings.Builder
		for _, c := range cs {
			b.WriteString(c.Item)
			if c.Prev != "" || c.Curr != "" {
				fmt.Fprintf(&b, ": %s → %s", orDash(c.Prev), orDash(c.Curr))
			}
			b.WriteString("\n")
		}
		return note{trf(lang, "[pgscope] %s: обнаружены изменения (%d)", name, len(cs)), b.String(), payload(cs), nil}
	})
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

//------------------------------------------------------------------------------
// notifications

type notifier struct {
	ID     int64  `json:"id"`
	Scope  string `json:"scope"`
	Kind   string `json:"kind"`
	Target string `json:"target"`
	Lang   string `json:"lang"` // language of the notification texts
}

const notifierCols = `id, scope, kind, target, lang`

func (n *notifier) scan(row pgx.Row) error { return row.Scan(&n.ID, &n.Scope, &n.Kind, &n.Target, &n.Lang) }

var notifierKinds = []string{"email", "slack", "pagerduty", "victorops", "xmatters", "webhook"}

// smtpTimeout bounds one whole SMTP delivery, connecting included (smtp.SendMail has no
// timeout: an unresponsive server would hang the sender and the notifier test request).
var smtpTimeout = 30 * time.Second

// sendMail's errors are in lang. Recipients are trimmed, deduplicated and empty ones dropped:
// a trailing comma would otherwise send RCPT TO:<> and fail the delivery to everyone.
func sendMail(lang string, to []string, subject, body string) error {
	if cfg.SMTPAddr == "" {
		return errors.New(tr(lang, "SMTP не настроен (задайте PGSCOPE_SMTP_ADDR)"))
	}
	var rcpt []string
	for _, a := range to {
		if a = strings.TrimSpace(a); a != "" && !slices.ContainsFunc(rcpt, func(b string) bool { return strings.EqualFold(a, b) }) {
			rcpt = append(rcpt, a)
		}
	}
	if len(rcpt) == 0 {
		return errors.New(tr(lang, "Не указан ни один адрес получателя"))
	}
	_, domain, ok := strings.Cut(cfg.SMTPFrom, "@")
	if !ok {
		domain = "localhost"
	}
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@%s>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s",
		cfg.SMTPFrom, strings.Join(rcpt, ", "), mime.QEncoding.Encode("utf-8", subject), time.Now().Format(time.RFC1123Z), rand.Text(), domain, body)
	if err := smtpSend(rcpt, msg); err != nil {
		log.Print("smtp: ", err)
		return errors.New(tr(lang, "SMTP-сервер не принял письмо"))
	}
	return nil
}

// smtpSend does what smtp.SendMail does (STARTTLS when the server offers it, then AUTH PLAIN
// when PGSCOPE_SMTP_USER is set), within smtpTimeout.
func smtpSend(to []string, msg string) error {
	deadline := time.Now().Add(smtpTimeout)
	conn, err := (&net.Dialer{Deadline: deadline}).Dial("tcp", cfg.SMTPAddr)
	if err != nil {
		return err
	}
	conn.SetDeadline(deadline)
	host, _, _ := net.SplitHostPort(cfg.SMTPAddr)
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: host}); err != nil {
			return err
		}
	}
	if cfg.SMTPUser != "" {
		if ok, _ := c.Extension("AUTH"); !ok {
			return errors.New("smtp: server doesn't support AUTH")
		}
		if err := c.Auth(smtp.PlainAuth("", cfg.SMTPUser, cfg.SMTPPass, host)); err != nil {
			return err
		}
	}
	if err := c.Mail(cfg.SMTPFrom); err != nil {
		return err
	}
	for _, a := range to {
		if err := c.Rcpt(a); err != nil {
			return err
		}
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := io.WriteString(wc, msg); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return c.Quit()
}

var hookClient = &http.Client{Timeout: 3 * time.Second}

// postJSON delivers within 3 seconds; on timeout it waits 5 seconds and
// retries, at most 3 times. Status codes are not retried. Errors are in lang.
func postJSON(lang, target string, body any) error {
	b, _ := json.Marshal(body)
	var err error
	for try := 0; try < 4; try++ {
		if try > 0 {
			time.Sleep(5 * time.Second)
		}
		req, _ := http.NewRequest("POST", target, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "pgscope-Webhook/1")
		req.Close = true
		var resp *http.Response
		if resp, err = hookClient.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode/100 != 2 {
				return errors.New(trf(lang, "%s вернул код HTTP %d", target, resp.StatusCode))
			}
			return nil
		}
		var ue *url.Error
		if !errors.As(err, &ue) || !ue.Timeout() {
			break
		}
	}
	log.Print("webhook: ", err)
	return errors.New(trf(lang, "не удалось связаться с %s", target))
}

// note is one notification, rendered in the notifier's language.
type note struct {
	subject, text string
	payload       any
	items         []alertItem // non-nil only for regular alerts
}

// deliver sends one notification; its errors are in errLang.
func deliver(n notifier, name string, nt note, errLang string) error {
	subject, text, payload, items := nt.subject, nt.text, nt.payload, nt.items
	sev, crit := "info", false
	for _, a := range items {
		if a.Type == "crit" {
			crit = true
		}
	}
	if items != nil {
		sev = map[bool]string{true: "critical", false: "warning"}[crit]
	}
	switch n.Kind {
	case "email":
		return sendMail(errLang, strings.Split(n.Target, ","), subject, text)
	case "slack":
		return postJSON(errLang, n.Target, map[string]any{"text": "*" + subject + "*\n```" + text + "```"})
	case "pagerduty":
		ev := map[string]any{"routing_key": n.Target, "event_action": "trigger",
			"payload": map[string]any{"summary": subject, "source": name, "severity": sev, "custom_details": payload}}
		if items != nil {
			ev["dedup_key"] = "pgscope-alerts-" + name
			if len(items) == 0 {
				ev["event_action"] = "resolve"
			}
		}
		return postJSON(errLang, "https://events.pagerduty.com/v2/enqueue", ev)
	case "victorops":
		mt := map[string]string{"critical": "CRITICAL", "warning": "WARNING", "info": "INFO"}[sev]
		if items != nil && len(items) == 0 {
			mt = "RECOVERY"
		}
		return postJSON(errLang, n.Target, map[string]any{"message_type": mt, "entity_id": "pgscope/" + name,
			"entity_display_name": subject, "state_message": text, "monitoring_tool": "pgscope"})
	case "xmatters":
		return postJSON(errLang, n.Target, map[string]any{"subject": subject, "message": text, "severity": sev, "server": name, "details": payload})
	case "webhook":
		return postJSON(errLang, n.Target, payload)
	}
	return errors.New(trf(errLang, "неизвестный тип канала уведомлений «%s»", n.Kind))
}

// notifyAll sends build(lang) to every notifier of the scope, each in its own language.
func notifyAll(ctx context.Context, sid int64, scope, name string, build func(lang string) note) {
	rows, err := db.Query(ctx, `select `+notifierCols+` from notifiers where server_id = $1 and scope = $2`, sid, scope)
	if err != nil {
		return
	}
	var ns []notifier
	for rows.Next() {
		var n notifier
		n.scan(rows)
		ns = append(ns, n)
	}
	rows.Close()
	for _, n := range ns {
		nt := build(n.Lang)
		go func() {
			if err := deliver(n, name, nt, n.Lang); err != nil {
				log.Printf("notify %s %s: %v", n.Kind, n.Target, err)
			}
		}()
	}
}

//------------------------------------------------------------------------------
// HTTP handlers

// renderEvent translates the structured alerts/changes of a stored event body into lang.
func renderEvent(lang string, body json.RawMessage) json.RawMessage {
	var ev map[string]json.RawMessage
	if json.Unmarshal(body, &ev) != nil {
		return body
	}
	var items []alertItem
	if raw, ok := ev["alerts"]; ok && json.Unmarshal(raw, &items) == nil {
		ev["alerts"], _ = json.Marshal(renderAlerts(lang, items))
	}
	var cs []change
	if raw, ok := ev["changes"]; ok && json.Unmarshal(raw, &cs) == nil {
		ev["changes"], _ = json.Marshal(renderChanges(lang, cs))
	}
	out, _ := json.Marshal(ev)
	return out
}

func getAlerts(w http.ResponseWriter, r *http.Request, s *server) {
	ctx, lang := r.Context(), reqLang(r)
	cat := slices.Clone(catalog)
	for i := range cat {
		cat[i].Label, cat[i].Param = tr(lang, cat[i].Label), tr(lang, cat[i].Param)
	}
	kindsL := slices.Clone(changeKinds)
	for i := range kindsL {
		kindsL[i].Label = tr(lang, kindsL[i].Label)
	}
	resp := map[string]any{"catalog": cat, "change_kinds": kindsL, "notifier_kinds": notifierKinds, "rules": loadRules(ctx, s.ID)}
	var status []alertItem
	var at *time.Time
	db.QueryRow(ctx, `select alerts, at from alert_state where server_id = $1`, s.ID).Scan(&status, &at)
	resp["status"], resp["status_at"] = renderAlerts(lang, status), at
	kinds, pct := loadChangeRules(ctx, s.ID)
	resp["changes"] = map[string]any{"kinds": kinds, "size_pct": pct}

	ns := []notifier{}
	rows, _ := db.Query(ctx, `select `+notifierCols+` from notifiers where server_id = $1 order by id`, s.ID)
	for rows.Next() {
		var n notifier
		n.scan(rows)
		ns = append(ns, n)
	}
	rows.Close()
	resp["notifiers"] = ns

	type event struct {
		At   time.Time       `json:"at"`
		Kind string          `json:"kind"`
		Body json.RawMessage `json:"body"`
	}
	evs := []event{}
	rows, _ = db.Query(ctx, `select at, kind, body from events where server_id = $1 order by at desc, id desc limit 200`, s.ID)
	for rows.Next() {
		var e event
		rows.Scan(&e.At, &e.Kind, &e.Body)
		e.Body = renderEvent(lang, e.Body)
		evs = append(evs, e)
	}
	rows.Close()
	resp["events"] = evs
	writeJSON(w, resp)
}

// reevaluate applies rule changes to the latest report right away.
func reevaluate(ctx context.Context, s *server) {
	if m, err := loadModel(ctx, s.ID, "", 0); err == nil {
		runAlerts(ctx, s.ID, s.Name, m)
	}
}

func addRule(w http.ResponseWriter, r *http.Request, s *server) {
	var ru rule
	if err := readJSON(r, &ru); err != nil {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	if findMetric(ru.Metric) == nil || (ru.Op != "gt" && ru.Op != "lt") || (ru.Severity != "warn" && ru.Severity != "crit") ||
		!slices.Contains([]string{"all", "contains", "notcontains", "startswith", "endswith", "exact"}, ru.Match) {
		httpErr(w, 400, "Некорректное правило")
		return
	}
	_, err := db.Exec(r.Context(), `insert into alert_rules(server_id, metric, op, threshold, param, severity, match, match_text, db_name)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, s.ID, ru.Metric, ru.Op, ru.Threshold, ru.Param, ru.Severity, ru.Match, ru.MatchText, ru.DBName)
	if err != nil {
		internalErr(w, err)
		return
	}
	reevaluate(r.Context(), s)
	writeJSON(w, map[string]any{"ok": true})
}

func delRule(w http.ResponseWriter, r *http.Request, s *server) {
	db.Exec(r.Context(), `delete from alert_rules where server_id = $1 and id = $2`, s.ID, r.PathValue("rid"))
	reevaluate(r.Context(), s)
	writeJSON(w, map[string]any{"ok": true})
}

func putChangeRules(w http.ResponseWriter, r *http.Request, s *server) {
	var req struct {
		Kinds   []string `json:"kinds"`
		SizePct float64  `json:"size_pct"`
	}
	if err := readJSON(r, &req); err != nil || req.SizePct <= 0 {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	req.Kinds = slices.DeleteFunc(req.Kinds, func(k string) bool {
		return !slices.ContainsFunc(changeKinds, func(c changeKind) bool { return c.ID == k })
	})
	_, err := db.Exec(r.Context(), `insert into change_rules values ($1,$2,$3) on conflict (server_id) do update set kinds = $2, size_pct = $3`,
		s.ID, req.Kinds, req.SizePct)
	if err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func addNotifier(w http.ResponseWriter, r *http.Request, s *server) {
	var n notifier
	if err := readJSON(r, &n); err != nil {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	n.Target = strings.TrimSpace(n.Target)
	if !slices.Contains(notifierKinds, n.Kind) || (n.Scope != "alerts" && n.Scope != "changes") || n.Target == "" {
		httpErr(w, 400, "Некорректный канал уведомлений")
		return
	}
	if n.Lang == "" {
		n.Lang = reqLang(r)
	}
	if !slices.Contains(langs, n.Lang) {
		httpErr(w, 400, "Неподдерживаемый язык")
		return
	}
	if n.Kind != "email" && n.Kind != "pagerduty" {
		if u, err := url.Parse(n.Target); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			httpErr(w, 400, "Адрес должен быть URL со схемой http или https")
			return
		}
	}
	if _, err := db.Exec(r.Context(), `insert into notifiers(server_id, scope, kind, target, lang) values ($1,$2,$3,$4,$5)`,
		s.ID, n.Scope, n.Kind, n.Target, n.Lang); err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func delNotifier(w http.ResponseWriter, r *http.Request, s *server) {
	db.Exec(r.Context(), `delete from notifiers where server_id = $1 and id = $2`, s.ID, r.PathValue("nid"))
	writeJSON(w, map[string]any{"ok": true})
}

func testNotifier(w http.ResponseWriter, r *http.Request, s *server) {
	var n notifier
	if err := n.scan(db.QueryRow(r.Context(), `select `+notifierCols+` from notifiers where server_id = $1 and id = $2`,
		s.ID, r.PathValue("nid"))); err != nil {
		httpErr(w, 404, "Канал уведомлений не найден")
		return
	}
	l, now := n.Lang, time.Now().Unix()
	nt := note{subject: trf(l, "[pgscope] тестовое уведомление для сервера «%s»", s.Name), text: tr(l, "Это тестовое уведомление от pgscope.") + "\n"}
	if n.Scope == "alerts" {
		item := alertItem{Type: "warn", Text: tr(l, "Тестовое оповещение"), Value: "1", ObjName: s.Name, ObjLink: fmt.Sprintf("%s/#/s/%d/alerts", cfg.BaseURL, s.ID)}
		nt.payload, nt.items = map[string]any{"version": 1, "server": s.Name, "reported": now, "alerts": []alertItem{item}}, []alertItem{item}
	} else {
		nt.payload = map[string]any{"version": 1, "server": s.Name, "prevreport": now, "currreport": now,
			"changes": []change{{Item: tr(l, "Тестовое изменение"), Curr: tr(l, "тест")}}}
	}
	if err := deliver(n, s.Name, nt, reqLang(r)); err != nil {
		httpErr(w, 502, trf(reqLang(r), "Не удалось отправить уведомление: %s", err.Error()))
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}
