package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func listServers(w http.ResponseWriter, r *http.Request, u *user) {
	type row struct {
		ID         int64           `json:"id"`
		Name       string          `json:"name"`
		Kind       string          `json:"kind"`
		Owner      string          `json:"owner"`
		IsOwner    bool            `json:"is_owner"`
		LastReport *time.Time      `json:"last_report"`
		Summary    json.RawMessage `json:"summary"`
		Alerts     []alertItem     `json:"alerts"`
		PgBouncers []string        `json:"pgbouncers"`
	}
	rows, err := db.Query(r.Context(), `
		select s.id, s.name, s.kind, u.email, s.owner_id = $1, s.last_report, coalesce(s.summary, 'null'),
		       coalesce(a.alerts, '[]'), coalesce((select array_agg(distinct source) from reports
		         where server_id = s.id and source <> ''), '{}')
		from servers s join users u on u.id = s.owner_id left join alert_state a on a.server_id = s.id
		where s.owner_id = $1 or exists (select 1 from shares where server_id = s.id and user_id = $1)
		order by s.kind, s.name`, u.ID)
	if err != nil {
		internalErr(w, err)
		return
	}
	defer rows.Close()
	lang := reqLang(r)
	out := []row{}
	for rows.Next() {
		var x row
		var sum, alerts []byte
		if err := rows.Scan(&x.ID, &x.Name, &x.Kind, &x.Owner, &x.IsOwner, &x.LastReport, &sum, &alerts, &x.PgBouncers); err != nil {
			internalErr(w, err)
			return
		}
		var items []alertItem
		json.Unmarshal(alerts, &items)
		x.Summary, x.Alerts = sum, renderAlerts(lang, items)
		out = append(out, x)
	}
	writeJSON(w, out)
}

// getReport streams the stored (gzipped) pgmetrics JSON as-is.
func getReport(w http.ResponseWriter, r *http.Request, s *server) {
	at := qInt(r, "at", time.Now().Unix()+86400)
	var data []byte
	var ts int64
	err := db.QueryRow(r.Context(), `select data, extract(epoch from at)::bigint from reports
		where server_id = $1 and source = $2 and at <= to_timestamp($3) order by at desc limit 1`,
		s.ID, r.URL.Query().Get("source"), at).Scan(&data, &ts)
	if err != nil {
		httpErr(w, 404, "Отчётов пока нет")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Report-At", strconv.FormatInt(ts, 10))
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(data)
		return
	}
	raw, _ := gunzip(data)
	w.Write(raw)
}

func listReports(w http.ResponseWriter, r *http.Request, s *server) {
	rows, err := db.Query(r.Context(), `select extract(epoch from at)::bigint from reports
		where server_id = $1 and source = $2 and at >= to_timestamp($3) order by at desc limit 2000`,
		s.ID, r.URL.Query().Get("source"), qInt(r, "from", 0))
	if err != nil {
		internalErr(w, err)
		return
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var t int64
		rows.Scan(&t)
		out = append(out, t)
	}
	writeJSON(w, out)
}

// getSeries returns raw values of some fields of one object over time.
// Rates and ratios are derived in the browser.
func getSeries(w http.ResponseWriter, r *http.Request, s *server) {
	q := r.URL.Query()
	fields := strings.Split(q.Get("fields"), ",")
	now := time.Now().Unix()
	rows, err := db.Query(r.Context(), `select extract(epoch from at)::bigint, vals from metrics
		where server_id = $1 and obj = $2 and at between to_timestamp($3) and to_timestamp($4) order by at`,
		s.ID, q.Get("obj"), qInt(r, "from", now-86400), qInt(r, "to", now))
	if err != nil {
		internalErr(w, err)
		return
	}
	defer rows.Close()
	resp := struct {
		T []int64               `json:"t"`
		S map[string][]*float64 `json:"s"`
	}{T: []int64{}, S: map[string][]*float64{}}
	for _, f := range fields {
		resp.S[f] = []*float64{}
	}
	for rows.Next() {
		var t int64
		var v map[string]float64
		if err := rows.Scan(&t, &v); err != nil {
			internalErr(w, err)
			return
		}
		resp.T = append(resp.T, t)
		for _, f := range fields {
			var p *float64
			if x, ok := v[f]; ok {
				p = &x
			}
			resp.S[f] = append(resp.S[f], p)
		}
	}
	writeJSON(w, resp)
}

// getBaseline returns one field of all objects with a prefix (tbl:, idx:, ...)
// from the first report at or after `at`. Used for growth and "unused since".
func getBaseline(w http.ResponseWriter, r *http.Request, s *server) {
	q := r.URL.Query()
	prefix := q.Get("prefix")
	if !strings.HasSuffix(prefix, ":") || strings.ContainsAny(prefix, `%_\`) {
		httpErr(w, 400, "Некорректный префикс")
		return
	}
	rows, err := db.Query(r.Context(), `
		with t0 as (select min(at) at from metrics where server_id = $1 and obj = '' and at >= to_timestamp($2))
		select m.obj, extract(epoch from m.at)::bigint, (m.vals->>$3)::float8 from metrics m, t0
		where m.server_id = $1 and m.at = t0.at and m.obj like $4 and m.vals ? $3`,
		s.ID, qInt(r, "at", 0), q.Get("field"), prefix+"%")
	if err != nil {
		internalErr(w, err)
		return
	}
	defer rows.Close()
	resp := struct {
		At   int64              `json:"at"`
		Vals map[string]float64 `json:"vals"`
	}{Vals: map[string]float64{}}
	for rows.Next() {
		var obj string
		var v float64
		rows.Scan(&obj, &resp.At, &v)
		resp.Vals[obj] = v
	}
	writeJSON(w, resp)
}

func getDiagnostics(w http.ResponseWriter, r *http.Request, s *server) {
	m, err := loadModel(r.Context(), s.ID, "", qInt(r, "at", 0))
	if err != nil {
		httpErr(w, 404, "Отчётов пока нет")
		return
	}
	writeJSON(w, map[string]any{"at": m.Metadata.At, "issues": diagnose(m, reqLang(r)), "config": configCheck(m, reqLang(r))})
}

func deleteServer(w http.ResponseWriter, r *http.Request, s *server) {
	if _, err := db.Exec(r.Context(), `delete from servers where id = $1`, s.ID); err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}
