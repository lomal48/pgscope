package main

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/rapidloop/pgmetrics"
)

func TestCore(t *testing.T) {
	if got, ok := parseLSN("1/10"); got != 4294967312 || !ok {
		t.Fatalf("parseLSN = %v", got)
	}
	if k := newAPIKey(); !rxAPIKey.MatchString(k) {
		t.Fatalf("API key %q would be rejected by the pgdash CLI", k)
	}

	prev := &pgmetrics.Model{
		Roles:    []pgmetrics.Role{{Name: "app"}},
		Tables:   []pgmetrics.Table{{DBName: "d", SchemaName: "s", Name: "t", Size: -1, NLiveTup: 10000}},
		Settings: map[string]pgmetrics.Setting{"work_mem": {Setting: "4096"}},
	}
	curr := &pgmetrics.Model{
		Roles:    []pgmetrics.Role{{Name: "app", Rolsuper: true}, {Name: "new"}},
		Tables:   []pgmetrics.Table{{DBName: "d", SchemaName: "s", Name: "t", Size: 50 << 20, NLiveTup: 30000}, {DBName: "d", SchemaName: "s", Name: "u"}},
		Settings: map[string]pgmetrics.Setting{"work_mem": {Setting: "16384"}},
	}
	all := []string{"roles", "tables", "table_size", "table_rows", "settings"}
	changes := detectChanges(prev, curr, all, 20)
	items := func(lang string) []string {
		var out []string
		for _, c := range renderChanges(lang, changes) {
			out = append(out, c.Item)
		}
		slices.Sort(out)
		return out
	}
	want := []string{"Добавлен пользователь", "Добавлена таблица", "Изменилось число строк таблицы «d.s.t»", "Изменён параметр «work_mem»", "Изменён пользователь «app»"}
	if got := items("ru"); !slices.Equal(got, want) { // the unknown (-1) previous size must not count as a change
		t.Fatalf("changes = %q, want %q", got, want)
	}
	wantEN := []string{"Row count of table “d.s.t” changed", "Setting “work_mem” changed", "Table added", "User added", "User “app” changed"}
	if got := items("en"); !slices.Equal(got, wantEN) {
		t.Fatalf("changes (en) = %q, want %q", got, wantEN)
	}
	for _, c := range renderChanges("en", changes) {
		if c.Item == "User “app” changed" && c.Curr != "attributes: superuser; member of: —" {
			t.Fatalf("role change (en) = %+v", c)
		}
	}
	// rendered changes keep the public webhook shape
	if b, _ := json.Marshal(renderChanges("en", changes[:1])); string(b) != `[{"item":"User added","curr":"new"}]` {
		t.Fatalf("rendered change JSON = %s", b)
	}

	m := &pgmetrics.Model{Metadata: pgmetrics.Metadata{At: 1000}, Databases: []pgmetrics.Database{{Name: "big", Size: 2 << 30}, {Name: "small", Size: 1 << 20}},
		Tables: []pgmetrics.Table{{DBName: "d", SchemaName: "s", Name: "t"}}}
	rules := []rule{{Metric: "db_size", Op: "gt", Threshold: 1 << 30, Severity: "crit", Match: "all"},
		{Metric: "db_size", Op: "gt", Threshold: 0, Severity: "warn", Match: "startswith", MatchText: "sm"}}
	stored := evaluate(1, "srv", m, rules)
	got := renderAlerts("ru", stored)
	if len(got) != 2 || got[0].ObjName != "big" || got[0].Value != "2 ГиБ" || got[0].Text != "Размер базы данных больше 1 ГиБ" || got[1].ObjName != "small" {
		t.Fatalf("evaluate = %+v", got)
	}
	en := renderAlerts("en", stored)
	if en[0].Value != "2 GiB" || en[0].Text != "Database size greater than 1 GiB" {
		t.Fatalf("evaluate (en) = %+v", en)
	}
	if b, _ := json.Marshal(en[0]); string(b) != `{"type":"crit","text":"Database size greater than 1 GiB","value":"2 GiB","objname":"big","objlink":"/#/s/1/databases/big"}` {
		t.Fatalf("rendered alert JSON = %s", b)
	}
	if subj, _ := alertMessage("en", "srv", en); subj != "[pgscope] srv: alerts (critical: 1, warning: 1)" {
		t.Fatalf("alert subject (en) = %q", subj)
	}
	// stored events keep structured items and are rendered per request language
	body, _ := json.Marshal(map[string]any{"version": 1, "alerts": stored, "changes": changes[:1]})
	var ev struct {
		Alerts  []alertItem
		Changes []change
	}
	json.Unmarshal(renderEvent("en", body), &ev)
	if len(ev.Alerts) != 2 || ev.Alerts[0].Text != en[0].Text || ev.Alerts[0].Metric != "" || len(ev.Changes) != 1 || ev.Changes[0].Item != "User added" {
		t.Fatalf("rendered event = %+v", ev)
	}

	// a never-vacuumed table: +Inf is stored as never, survives JSON and renders per language
	never := evaluate(1, "srv", m, []rule{{Metric: "tbl_since_vacuum", Op: "gt", Threshold: 3600, Severity: "warn", Match: "all"}})
	b, err := json.Marshal(never)
	if err != nil {
		t.Fatal(err)
	}
	var back []alertItem
	json.Unmarshal(b, &back)
	if len(back) != 1 || !back[0].Never || back[0].key() != never[0].key() || renderAlerts("en", back)[0].Value != "never" || renderAlerts("ru", back)[0].Value != "никогда" {
		t.Fatalf("never alert = %s", b)
	}

	if tr("en", "Некорректный запрос") != "Invalid request" || trf("en", "[pgscope] %s: обнаружены изменения (%d)", "x", 2) != "[pgscope] x: changes detected (2)" ||
		tr("ru", "Некорректный запрос") != "Некорректный запрос" {
		t.Fatal("tr/trf do not translate")
	}
}
