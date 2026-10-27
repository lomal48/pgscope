package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/rapidloop/pgmetrics"
)

func issueItems(is []issue, title string) ([]string, bool) {
	for _, i := range is {
		if i.Title == title {
			return i.Items, true
		}
	}
	return nil, false
}

// C1: an unknown LSN ("" from pgmetrics) gives no lag, no series point, no alert, no diagnostic
func TestUnknownLSN(t *testing.T) {
	m := &pgmetrics.Model{Metadata: pgmetrics.Metadata{At: 1000}, WALLSN: "1/0",
		ReplicationOutgoing: []pgmetrics.ReplicationOut{
			{ApplicationName: "basebackup"}, // a walsender without write/flush/replay LSN
			{ApplicationName: "standby", WriteLSN: "0/0", FlushLSN: "0/0", ReplayLSN: "0/0"},
		},
		ReplicationSlots: []pgmetrics.ReplicationSlot{{SlotName: "new", SlotType: "physical"}}}
	ex := extractMetrics(m, "")
	if v := ex["repl:basebackup"]; v == nil || len(v) != 3 || ex["repl:standby"]["replay_lag_bytes"] != 1<<32 {
		t.Fatalf("repl series = %v / %v", ex["repl:basebackup"], ex["repl:standby"])
	}
	if _, ok := ex["slot:new"]; ok {
		t.Fatal("slot without restart LSN got a retained_bytes point")
	}
	got := evaluate(1, "srv", m, []rule{{Metric: "repl_write_lag", Op: "gt", Threshold: 0, Severity: "warn", Match: "all"}})
	if len(got) != 1 || got[0].ObjName != "standby" {
		t.Fatalf("repl_write_lag alerts = %+v", got)
	}
	if s := summarize(m); s.ReplLagBytes == nil || *s.ReplLagBytes != 1<<32 {
		t.Fatalf("summary lag = %v", s.ReplLagBytes)
	}
	m.ReplicationOutgoing = m.ReplicationOutgoing[:1]
	if s := summarize(m); s.ReplLagBytes != nil {
		t.Fatalf("summary lag of an unknown replica = %v, want null", *s.ReplLagBytes)
	}
	is := diagnose(m, "ru")
	if items, _ := issueItems(is, "Неактивные слоты репликации"); !slices.Equal(items, []string{"new (physical)"}) {
		t.Fatalf("inactive slot items = %q", items)
	}
	if _, ok := issueItems(is, "Реплики отстают"); ok {
		t.Fatal("a replica with unknown replay LSN is reported as lagging")
	}

	// a standby without a WAL receiver: receive LSN unknown
	sb := &pgmetrics.Model{Metadata: pgmetrics.Metadata{At: 1000}, IsInRecovery: true, LastWALReplayLSN: "1/0", LastXActReplayTimestamp: 1}
	if _, ok := extractMetrics(sb, "")[""]["standby_lag_bytes"]; ok {
		t.Fatal("standby_lag_bytes from an unknown receive LSN")
	}
	if _, ok := issueItems(diagnose(sb, "ru"), "Реплика не успевает воспроизводить WAL"); ok {
		t.Fatal("replay issue built on an unknown receive LSN")
	}
	if a := evaluate(1, "srv", sb, []rule{{Metric: "standby_lag_bytes", Op: "lt", Threshold: 1, Severity: "warn", Match: "all"}}); len(a) != 0 {
		t.Fatalf("standby_lag_bytes alerts = %+v", a)
	}
}

// C2: the XID range is taken modulo 2^32, so it stays right after next_xid wraps around
func TestXIDRangeWraps(t *testing.T) {
	m := &pgmetrics.Model{NextXid: 100, OldestXid: 1<<32 - 296}
	if got := extractMetrics(m, "")[""]["xid_range"]; got != 396 {
		t.Fatalf("xid_range = %v, want 396", got)
	}
	if a := evaluate(1, "srv", m, []rule{{Metric: "xid_range", Op: "gt", Threshold: 300, Severity: "warn", Match: "all"}}); len(a) != 1 {
		t.Fatalf("xid_range alerts = %+v", a)
	}
}

// C3: query names in alerts are cut by characters, not bytes
func TestQueryNameRunes(t *testing.T) {
	m := &pgmetrics.Model{Statements: []pgmetrics.Statement{{DBName: "d", QueryID: 1, Query: "SELECT * FROM таблица_пользователей", MaxTime: 5}}}
	a := evaluate(1, "srv", m, []rule{{Metric: "query_max_time", Op: "gt", Threshold: 1, Severity: "warn", Match: "endswith", MatchText: "таблиц"}})
	if len(a) != 1 || a[0].ObjName != "SELECT * FROM таблиц" || !utf8.ValidString(a[0].ObjName) {
		t.Fatalf("alerts = %+v", a)
	}
}

// C4: Date and Message-ID headers, cleaned recipients, and a bounded wait on a silent server
func TestSendMail(t *testing.T) {
	defer func(a, f string, d time.Duration) { cfg.SMTPAddr, cfg.SMTPFrom, smtpTimeout = a, f, d }(cfg.SMTPAddr, cfg.SMTPFrom, smtpTimeout)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	session := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		var b strings.Builder
		r, data := bufio.NewReader(c), false
		fmt.Fprint(c, "220 test\r\n")
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				break
			}
			b.WriteString(line)
			switch {
			case data:
				if line == ".\r\n" {
					data = false
					fmt.Fprint(c, "250 ok\r\n")
				}
			case strings.HasPrefix(line, "DATA"):
				data = true
				fmt.Fprint(c, "354 go on\r\n")
			case strings.HasPrefix(line, "QUIT"):
				fmt.Fprint(c, "221 bye\r\n")
				session <- b.String()
				return
			default:
				fmt.Fprint(c, "250 ok\r\n")
			}
		}
		session <- b.String()
	}()
	cfg.SMTPAddr, cfg.SMTPFrom, smtpTimeout = ln.Addr().String(), "pgscope@example.org", 5*time.Second
	if err := sendMail("en", strings.Split(" a@x.org, ,A@x.org,b@y.org,", ","), "Тема", "body\n"); err != nil {
		t.Fatal(err)
	}
	s := <-session
	if strings.Count(s, "RCPT TO:") != 2 || !strings.Contains(s, "RCPT TO:<a@x.org>") || !strings.Contains(s, "RCPT TO:<b@y.org>") ||
		!regexp.MustCompile(`\r\nDate: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} [-+]\d{4}\r\n`).MatchString(s) ||
		!regexp.MustCompile(`\r\nMessage-ID: <\w+@example\.org>\r\n`).MatchString(s) {
		t.Fatalf("SMTP session:\n%s", s)
	}
	if err := sendMail("en", []string{" ", ""}, "s", "b"); err == nil || err.Error() != "No recipient address given" {
		t.Fatalf("no recipients: %v", err)
	}

	silent, err := net.Listen("tcp", "127.0.0.1:0") // accepts and never greets
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	go func() {
		if c, err := silent.Accept(); err == nil {
			defer c.Close()
			io.Copy(io.Discard, c)
		}
	}()
	cfg.SMTPAddr, smtpTimeout = silent.Addr().String(), 300*time.Millisecond
	start := time.Now()
	if err := sendMail("en", []string{"a@x.org"}, "s", "b"); err == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("silent SMTP server: err %v after %v", err, time.Since(start))
	}
}

// endless is a request body that never ends; n counts the bytes read from it.
type endless struct{ n int }

func (e *endless) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	e.n += len(p)
	return len(p), nil
}

// C5: the API key is checked before the data member is read; oversized bodies get 413
func TestReadReport(t *testing.T) {
	defer func(v int64) { cfg.MaxReport = v }(cfg.MaxReport)
	cfg.MaxReport = 1 << 20
	read := func(body io.Reader, gz bool) (int, bool) {
		r := httptest.NewRequest("POST", "/api/v1/report", body)
		if gz {
			r.Header.Set("Content-Encoding", "gzip")
		}
		w, slot := httptest.NewRecorder(), false
		readReport(w, r, &slot)
		if slot {
			<-reportSlots
		}
		return w.Code, slot
	}

	rest := &endless{}
	code, slot := read(io.MultiReader(strings.NewReader(`{"apikey": "not-a-key", "server": "s", "data": "`), rest), false)
	if code != 401 || slot || rest.n > 64<<10 {
		t.Fatalf("bad key first: HTTP %d, slot %v, %d data bytes read", code, slot, rest.n)
	}
	big := `{"data": "` + strings.Repeat("a", 2<<20) + `", "apikey": "x"}`
	if code, slot := read(strings.NewReader(big), false); code != 413 || !slot {
		t.Fatalf("over the wire limit: HTTP %d, slot %v", code, slot)
	}
	if code, _ := read(strings.NewReader(string(gzipBytes([]byte(big)))), true); code != 413 {
		t.Fatalf("over the decompressed limit: HTTP %d", code)
	}
	if code, slot := read(strings.NewReader(`{"data": {"metadata": {"at": 1}}, "apikey": "not-a-key"}`), false); code != 401 || !slot {
		t.Fatalf("data before a bad key: HTTP %d, slot %v", code, slot)
	}
	if code, _ := read(strings.NewReader(`{"server": "`+strings.Repeat("a", 100<<10)+`"}`), false); code != 400 {
		t.Fatalf("100 KiB before data: HTTP %d", code)
	}
}

// C6: pg_stat_statements rows of one database + queryid (one per user) are merged
func TestStatementsMerged(t *testing.T) {
	m := &pgmetrics.Model{Statements: []pgmetrics.Statement{
		{UserName: "a", DBName: "d", QueryID: 7, Query: "q", Calls: 2, TotalTime: 4, MinTime: 1, MaxTime: 3, StddevTime: 1, Rows: 10, SharedBlksHit: 5},
		{UserName: "x", DBName: "other", QueryID: 7, Calls: 1, TotalTime: 100},
		{UserName: "b", DBName: "d", QueryID: 7, Query: "q", Calls: 1, TotalTime: 5, MinTime: 5, MaxTime: 5, Rows: 1, SharedBlksHit: 1},
		{UserName: "c", DBName: "d", QueryID: 7, Query: "q", Plans: 1, TotalPlanTime: 2}, // planned, never executed
	}}
	st := statements(m)
	q := st[0] // samples 1, 3 and 5
	if len(st) != 2 || q.Calls != 3 || q.TotalTime != 9 || q.MinTime != 1 || q.MaxTime != 5 || q.Rows != 11 || q.SharedBlksHit != 6 ||
		q.Plans != 1 || math.Abs(q.StddevTime-math.Sqrt(8.0/3)) > 1e-9 {
		t.Fatalf("merged = %+v", st)
	}
	if v := extractMetrics(m, "")["q:d:7"]; v["calls"] != 3 || v["total_time"] != 9 || v["max_time"] != 5 {
		t.Fatalf("series = %v", v)
	}
	a := evaluate(1, "srv", m, []rule{{Metric: "query_mean_time", Op: "gt", Threshold: 0, Severity: "warn", Match: "all", DBName: "d"}})
	if r := renderAlerts("en", a); len(r) != 1 || r[0].Value != "3 ms" {
		t.Fatalf("mean time alerts = %+v", r)
	}
}

// C7: a unique index is never proposed for dropping while a non-unique equivalent exists, a constraint's never
func TestDuplicateIndexes(t *testing.T) {
	idx := func(name, def string) pgmetrics.Index {
		return pgmetrics.Index{DBName: "d", SchemaName: "s", Name: name, IdxScan: 1, Definition: fmt.Sprintf(def, name)}
	}
	m := &pgmetrics.Model{Indexes: []pgmetrics.Index{
		idx("n", "CREATE INDEX %s ON s.t USING btree (a)"), idx("u", "CREATE UNIQUE INDEX %s ON s.t USING btree (a)"),
		idx("u2", "CREATE UNIQUE INDEX %s ON s.t USING btree (a)"),
		idx("p1", "CREATE INDEX %s ON s.t USING btree (b)"), idx("p2", "CREATE INDEX %s ON s.t USING btree (b)"),
		idx("pk", "CREATE UNIQUE INDEX %s ON s.t USING btree (c)"), idx("uc", "CREATE UNIQUE INDEX %s ON s.t USING btree (c)"),
		// constraint index names: the primary key is kept, a constraint's index is never proposed
		idx("uq", "CREATE UNIQUE INDEX %s ON s.t USING btree (d)"), idx("t_pkey", "CREATE UNIQUE INDEX %s ON s.t USING btree (d)"),
		idx("t2_pkey", "CREATE UNIQUE INDEX %s ON s.t2 USING btree (e)"), idx("t2_e_key", "CREATE UNIQUE INDEX %s ON s.t2 USING btree (e)"),
		idx("x_idx", "CREATE INDEX %s ON s.t USING gist (f)"), idx("t_f_excl", "CREATE INDEX %s ON s.t USING gist (f)"),
	}}
	items, _ := issueItems(diagnose(m, "ru"), "Дублирующиеся индексы")
	want := []string{"d.s.n повторяет d.s.u", "d.s.p2 повторяет d.s.p1", "d.s.uc повторяет d.s.pk",
		"d.s.uq повторяет d.s.t_pkey", "d.s.x_idx повторяет d.s.t_f_excl"}
	if !slices.Equal(items, want) {
		t.Fatalf("duplicates = %q, want %q", items, want)
	}
}

// C8: every diagnostic links to a route of the server UI
func TestDiagLinks(t *testing.T) {
	src, err := os.ReadFile("web/src/pages/server/routes.tsx")
	if err != nil {
		t.Fatal(err)
	}
	routes := map[string]bool{}
	for _, m := range regexp.MustCompile(`\['(/[^']*)'`).FindAllStringSubmatch(string(src), -1) {
		routes[m[1]] = true
	}
	for _, i := range diagnose(diagModel(), "ru") { // a model that triggers nearly every issue
		if i.Link != "" && !routes[i.Link] {
			t.Errorf("%q links to %q, which is not a route", i.Title, i.Link)
		}
	}
}

// C9: 0 days keeps data forever; a negative retention stops pgscope at startup
func TestRetention(t *testing.T) {
	if os.Getenv("PGSCOPE_TEST_RETENTION") != "" {
		retentionDays("PGSCOPE_REPORT_RETENTION_DAYS", 14)
		return
	}
	defer func(m, r int) { cfg.MetricsDays, cfg.ReportDays = m, r }(cfg.MetricsDays, cfg.ReportDays)
	cfg.MetricsDays, cfg.ReportDays = 0, 14
	var sqls []string
	for _, d := range retentionPass() {
		sqls = append(sqls, strings.Fields(d.sql)[2])
	}
	if !slices.Equal(sqls, []string{"sessions", "reports"}) {
		t.Fatalf("retention pass deletes from %q", sqls)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestRetention$")
	cmd.Env = append(os.Environ(), "PGSCOPE_TEST_RETENTION=1", "PGSCOPE_REPORT_RETENTION_DAYS=-1")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "PGSCOPE_REPORT_RETENTION_DAYS=-1") {
		t.Fatalf("negative retention: err %v, output %s", err, out)
	}
}
