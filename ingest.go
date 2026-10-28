package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rapidloop/pgmetrics"
)

// same validation the pgdash CLI applies before sending
var (
	rxAPIKey = regexp.MustCompile("^[A-Za-z0-9]{22}$")
	rxServer = regexp.MustCompile("^[A-Za-z0-9_.-]{1,64}$")
)

var (
	ingestMu   sync.Mutex
	lastIngest = map[string]time.Time{}
	inProgress = map[string]bool{}
)

// reportSlots bounds how many report bodies are read and stored at once: each holds its
// report in memory several times over (JSON buffer, raw copy, parsed model, gzip copy).
// ponytail: fixed at 4; make it a setting if reports of a large fleet queue up behind it.
var reportSlots = make(chan struct{}, 4)

func ingest(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slot := false
		defer func() {
			if slot {
				<-reportSlots
			}
		}()
		req, uid, ok := readReport(w, r, &slot)
		if !ok {
			return
		}
		name, skind, source := req.Server, "postgres", ""
		switch kind {
		case "pgbouncer":
			source = req.PgBouncer
		case "pgpool":
			name, skind = req.Pgpool, "pgpool"
		}
		if !rxServer.MatchString(name) || (kind == "pgbouncer" && !rxServer.MatchString(source)) {
			httpErr(w, 400, "Некорректное имя сервера")
			return
		}
		var m pgmetrics.Model
		if err := json.Unmarshal(req.Data, &m); err != nil || m.Metadata.At == 0 {
			httpErr(w, 400, "Данные не являются JSON-отчётом pgmetrics")
			return
		}
		if (kind == "pgbouncer" && m.PgBouncer == nil) || (kind == "pgpool" && m.Pgpool == nil) {
			httpErr(w, 400, trf(reqLang(r), "В отчёте нет данных %s", map[string]string{"pgbouncer": "PgBouncer", "pgpool": "Pgpool"}[kind]))
			return
		}

		key := fmt.Sprint(uid, "/", skind, "/", name, "/", source)
		ingestMu.Lock()
		if inProgress[key] {
			ingestMu.Unlock()
			httpErr(w, http.StatusConflict, "Предыдущий отчёт этого сервера ещё сохраняется")
			return
		}
		if time.Since(lastIngest[key]) < cfg.MinInterval {
			ingestMu.Unlock()
			httpErr(w, http.StatusTooManyRequests, "Отчёты отправляются слишком часто")
			return
		}
		inProgress[key] = true
		ingestMu.Unlock()
		defer func() { ingestMu.Lock(); delete(inProgress, key); ingestMu.Unlock() }()

		if err := storeReport(r.Context(), uid, skind, name, source, req.Data, &m); err != nil {
			log.Printf("store report %s: %v", key, err)
			httpErr(w, 500, "Не удалось сохранить отчёт")
			return
		}
		ingestMu.Lock()
		lastIngest[key] = time.Now()
		ingestMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("{}"))
	}
}

type reportReq struct {
	APIKey, Server, PgBouncer, Pgpool string
	Data                              json.RawMessage // stored as received
}

// readReport streams the JSON object of a report request and answers errors itself. "apikey"
// must precede "data" (the pgdash CLI and pgscope-agent send it first): the key is checked before
// the large data member is read, so a client without a valid key never makes pgscope buffer a
// report or take one of reportSlots. Data is read only while holding a slot (*slot is set; the
// caller releases it when done with the report).
func readReport(w http.ResponseWriter, r *http.Request, slot *bool) (req reportReq, uid int64, ok bool) {
	body, ok := reqBody(w, r, cfg.MaxReport, cfg.MaxReport)
	if !ok {
		return req, 0, false
	}
	// the members before data are a few short strings: read at most 64 KiB until data starts
	head := &io.LimitedReader{R: body, N: 64 << 10}
	dec := json.NewDecoder(head)
	authed := false
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		bodyErr(w, err)
		return req, 0, false
	}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			bodyErr(w, err)
			return req, 0, false
		}
		k, _ := t.(string)
		switch strings.ToLower(k) { // encoding/json matches member names case-insensitively too
		case "apikey":
			err = dec.Decode(&req.APIKey)
		case "server":
			err = dec.Decode(&req.Server)
		case "pgbouncer":
			err = dec.Decode(&req.PgBouncer)
		case "pgpool":
			err = dec.Decode(&req.Pgpool)
		case "data":
			if !authed {
				if req.APIKey == "" {
					httpErr(w, 400, "Поле apikey должно идти в теле запроса до поля data")
					return req, 0, false
				}
				if uid, authed = apiKeyOwner(w, r, req.APIKey); !authed {
					return req, 0, false
				}
			}
			if !*slot {
				select {
				case reportSlots <- struct{}{}:
					*slot = true
				case <-r.Context().Done():
					return req, 0, false // the client went away
				}
				head.N = math.MaxInt64 // reqBody's limits still apply
			}
			err = dec.Decode(&req.Data)
		default:
			err = dec.Decode(new(json.RawMessage))
		}
		if err != nil {
			bodyErr(w, err)
			return req, 0, false
		}
	}
	if _, err := dec.Token(); err != nil { // the closing brace
		bodyErr(w, err)
		return req, 0, false
	}
	if !authed {
		if uid, authed = apiKeyOwner(w, r, req.APIKey); !authed {
			return req, 0, false
		}
	}
	return req, uid, true
}

// bodyErr answers a report body that could not be read: 413 when it is over the size limit.
func bodyErr(w http.ResponseWriter, err error) {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		httpErr(w, http.StatusRequestEntityTooLarge, trf(writerLang(w), "Отчёт больше %d МиБ — это предел PGSCOPE_MAX_REPORT_MB на сервере pgscope", tooBig.Limit>>20))
		return
	}
	httpErr(w, 400, "Некорректное тело запроса")
}

// reqBody limits the request body to wire bytes as sent and to raw bytes after gzip
// decompression; reading past either limit fails with *http.MaxBytesError.
func reqBody(w http.ResponseWriter, r *http.Request, wire, raw int64) (io.Reader, bool) {
	var body io.Reader = http.MaxBytesReader(w, r.Body, wire)
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(body)
		if err != nil {
			httpErr(w, 400, "Не удалось распаковать тело запроса (gzip)")
			return nil, false
		}
		body = http.MaxBytesReader(w, gz, raw)
	}
	return body, true
}

// apiKeyOwner resolves an API key to its user and answers the error itself. A storage
// outage answers 503, not 403: the pgdash CLI does not retry 4xx and would drop the report.
func apiKeyOwner(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	if !rxAPIKey.MatchString(key) {
		httpErr(w, 401, "Некорректный API-ключ")
		return 0, false
	}
	var uid int64
	err := db.QueryRow(r.Context(), `select id from users where apikey = $1`, key).Scan(&uid)
	if errors.Is(err, pgx.ErrNoRows) {
		httpErr(w, 403, "Неизвестный API-ключ")
		return 0, false
	}
	if err != nil {
		log.Print("API key lookup: ", err)
		httpErr(w, http.StatusServiceUnavailable, "Хранилище временно недоступно")
		return 0, false
	}
	return uid, true
}

func storeReport(ctx context.Context, uid int64, skind, name, source string, raw []byte, m *pgmetrics.Model) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var sid int64
	// select first so that repeated reports don't burn sequence values
	if err := tx.QueryRow(ctx, `with found as (select id from servers where owner_id = $1 and kind = $2 and name = $3),
		ins as (insert into servers(owner_id, kind, name) select $1, $2, $3 where not exists (select 1 from found)
		        on conflict do nothing returning id)
		select id from found union all select id from ins`, uid, skind, name).Scan(&sid); err != nil {
		return err
	}
	at := time.Unix(m.Metadata.At, 0)
	if _, err := tx.Exec(ctx, `insert into reports(server_id, source, at, data) values ($1,$2,$3,$4)`, sid, source, at, gzipBytes(raw)); err != nil {
		return err
	}
	objs := extractMetrics(m, source)
	rows := make([][]any, 0, len(objs))
	for obj, vals := range objs {
		rows = append(rows, []any{sid, at, obj, vals})
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"metrics"}, []string{"server_id", "at", "obj", "vals"}, pgx.CopyFromRows(rows)); err != nil {
		return err
	}
	if source == "" {
		var sum any = summarize(m)
		if skind == "pgpool" {
			sum = summarizePgpool(m)
		}
		if _, err := tx.Exec(ctx, `update servers set last_report = $2, summary = $3 where id = $1`, sid, at, sum); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if skind == "postgres" && source == "" {
		go afterReport(sid, name, m)
	}
	return nil
}

//------------------------------------------------------------------------------
// time-series extraction: one row of {field: value} per object per report

type vals map[string]float64

func f(v any) float64 {
	switch x := v.(type) {
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0
		}
		return x
	case bool:
		if x {
			return 1
		}
	}
	return 0
}

func ratio(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

// parseLSN converts "16/B374D848" to a byte position. ok is false for an unknown LSN:
// pgmetrics sends "" for NULL (e.g. a walsender of pg_basebackup has no replay LSN), and
// treating it as 0 would make every lag measured from it as large as the whole WAL.
func parseLSN(s string) (lsn float64, ok bool) {
	hi, lo, ok := strings.Cut(s, "/")
	h, err1 := strconv.ParseUint(hi, 16, 32)
	l, err2 := strconv.ParseUint(lo, 16, 32)
	if !ok || err1 != nil || err2 != nil {
		return 0, false
	}
	return float64(h<<32 | l), true
}

// lsnDiff is a-b in bytes, at least 0; ok is false when either LSN is unknown, and then
// there must be no series point, alert or diagnostic built on it.
func lsnDiff(a, b string) (float64, bool) {
	x, okA := parseLSN(a)
	y, okB := parseLSN(b)
	return math.Max(0, x-y), okA && okB
}

// currentLSN is the server's WAL position: replayed WAL on a standby.
func currentLSN(m *pgmetrics.Model) string {
	if m.IsInRecovery {
		return m.LastWALReplayLSN
	}
	return m.WALLSN
}

// xidRange is the number of transaction IDs in use, next_xid - oldest_xid. Both are 32-bit
// (pgmetrics strips the epoch), so the difference is taken modulo 2^32 like PostgreSQL does:
// after 2^32 transactions next_xid wraps around and is smaller than oldest_xid.
func xidRange(m *pgmetrics.Model) float64 { return float64(uint32(m.NextXid) - uint32(m.OldestXid)) }

func standbyName(r pgmetrics.ReplicationOut) string {
	if r.ApplicationName != "" {
		return r.ApplicationName
	}
	if r.ClientAddr != "" {
		return r.ClientAddr
	}
	return strconv.Itoa(r.PID)
}

// statements merges the pg_stat_statements rows of one query: the view has a row per user
// (and toplevel flag) of the same database + queryid, pgscope shows one per query. Counters
// and times are summed, min/max are the extremes over rows that ran, stddev is pooled, so a
// mean is always total/calls. User and query text are the first row's.
func statements(m *pgmetrics.Model) []pgmetrics.Statement {
	out := []pgmetrics.Statement{}
	at := map[string]int{}
	for _, q := range m.Statements {
		k := q.DBName + "\x00" + strconv.FormatInt(q.QueryID, 10)
		i, ok := at[k]
		if !ok {
			at[k] = len(out)
			out = append(out, q)
			continue
		}
		a := &out[i]
		a.StddevTime = pooledStddev(f(a.Calls), a.TotalTime, a.StddevTime, f(q.Calls), q.TotalTime, q.StddevTime)
		a.StddevPlanTime = pooledStddev(f(a.Plans), a.TotalPlanTime, a.StddevPlanTime, f(q.Plans), q.TotalPlanTime, q.StddevPlanTime)
		a.MinTime, a.MaxTime = minRan(a.Calls, a.MinTime, q.Calls, q.MinTime), max(a.MaxTime, q.MaxTime)
		a.MinPlanTime, a.MaxPlanTime = minRan(a.Plans, a.MinPlanTime, q.Plans, q.MinPlanTime), max(a.MaxPlanTime, q.MaxPlanTime)
		for _, p := range [][2]*int64{{&a.Calls, &q.Calls}, {&a.Rows, &q.Rows}, {&a.Plans, &q.Plans},
			{&a.SharedBlksHit, &q.SharedBlksHit}, {&a.SharedBlksRead, &q.SharedBlksRead}, {&a.SharedBlksDirtied, &q.SharedBlksDirtied},
			{&a.SharedBlksWritten, &q.SharedBlksWritten}, {&a.LocalBlksHit, &q.LocalBlksHit}, {&a.LocalBlksRead, &q.LocalBlksRead},
			{&a.LocalBlksDirtied, &q.LocalBlksDirtied}, {&a.LocalBlksWritten, &q.LocalBlksWritten}, {&a.TempBlksRead, &q.TempBlksRead},
			{&a.TempBlksWritten, &q.TempBlksWritten}, {&a.WALRecords, &q.WALRecords}, {&a.WALFPI, &q.WALFPI}, {&a.WALBytes, &q.WALBytes},
			{&a.WALBuffersFull, &q.WALBuffersFull}, {&a.JITFuntions, &q.JITFuntions}, {&a.JITInliningCount, &q.JITInliningCount},
			{&a.JITOptimizationCount, &q.JITOptimizationCount}, {&a.JITEmissionCount, &q.JITEmissionCount}, {&a.JITDeformCount, &q.JITDeformCount},
			{&a.ParallelWorkersToLaunch, &q.ParallelWorkersToLaunch}, {&a.ParallelWorkersLaunched, &q.ParallelWorkersLaunched},
			{&a.GenericPlanCalls, &q.GenericPlanCalls}, {&a.CustomPlanCalls, &q.CustomPlanCalls}} {
			*p[0] += *p[1]
		}
		for _, p := range [][2]*float64{{&a.TotalTime, &q.TotalTime}, {&a.TotalPlanTime, &q.TotalPlanTime},
			{&a.BlkReadTime, &q.BlkReadTime}, {&a.BlkWriteTime, &q.BlkWriteTime}, {&a.LocalBlkReadTime, &q.LocalBlkReadTime},
			{&a.LocalBlkWriteTime, &q.LocalBlkWriteTime}, {&a.TempBlkReadTime, &q.TempBlkReadTime}, {&a.TempBlkWriteTime, &q.TempBlkWriteTime},
			{&a.JITGenerationTime, &q.JITGenerationTime}, {&a.JITInliningTime, &q.JITInliningTime},
			{&a.JITOptimizationTime, &q.JITOptimizationTime}, {&a.JITEmissionTime, &q.JITEmissionTime}, {&a.JITDeformTime, &q.JITDeformTime}} {
			*p[0] += *p[1]
		}
	}
	return out
}

// minRan is the smaller of two minimum times, ignoring a side with no executions (its min is 0).
func minRan(n1 int64, v1 float64, n2 int64, v2 float64) float64 {
	switch {
	case n1 == 0:
		return v2
	case n2 == 0:
		return v1
	}
	return min(v1, v2)
}

// pooledStddev is the population standard deviation of two groups given as count, total and stddev.
func pooledStddev(n1, t1, s1, n2, t2, s2 float64) float64 {
	n := n1 + n2
	if n == 0 {
		return 0
	}
	sumSq := func(n, t, s float64) float64 { return n*s*s + ratio(t*t, n) } // Σx² = n·(σ² + μ²)
	mean := (t1 + t2) / n
	return math.Sqrt(math.Max(0, (sumSq(n1, t1, s1)+sumSq(n2, t2, s2))/n-mean*mean))
}

func setting(m *pgmetrics.Model, name string) float64 {
	v, _ := strconv.ParseFloat(m.Settings[name].Setting, 64)
	return v
}

func extractMetrics(m *pgmetrics.Model, source string) map[string]vals {
	out := map[string]vals{}
	if source != "" { // pgbouncer
		extractPgBouncer(out, m.PgBouncer, "pgb:"+source)
		return out
	}
	if m.Pgpool != nil {
		extractPgpool(out, m.Pgpool)
		return out
	}
	at := m.Metadata.At
	s := vals{
		"backends": f(len(m.Backends)), "max_connections": setting(m, "max_connections"),
		"wal_count": f(m.WALCount), "wal_ready": f(m.WALReadyCount),
		"notif_queue": m.NotificationQueueUsage, "archived": f(m.WALArchiving.ArchivedCount), "archive_failed": f(m.WALArchiving.FailedCount),
		"ckpt_timed": f(m.BGWriter.CheckpointsTimed), "ckpt_req": f(m.BGWriter.CheckpointsRequested),
		"buffers_checkpoint": f(m.BGWriter.BuffersCheckpoint), "buffers_clean": f(m.BGWriter.BuffersClean),
		"buffers_backend": f(m.BGWriter.BuffersBackend), "buffers_alloc": f(m.BGWriter.BuffersAlloc),
		"maxwritten_clean": f(m.BGWriter.MaxWrittenClean), "locks": f(len(m.Locks)),
	}
	if v, ok := parseLSN(currentLSN(m)); ok {
		s["lsn"] = v
	}
	if m.OldestXid > 0 {
		s["xid_range"] = xidRange(m)
	}
	if m.CheckpointTime > 0 {
		s["checkpoint_age"] = f(at - m.CheckpointTime)
	}
	if c := m.Checkpointer; c != nil {
		s["ckpt_timed"], s["ckpt_req"], s["buffers_checkpoint"] = f(c.NumTimed), f(c.NumRequested), f(c.BuffersWritten)
	}
	if w := m.WAL; w != nil {
		s["wal_records"], s["wal_fpi"], s["wal_bytes"], s["wal_buffers_full"] = f(w.Records), f(w.FPI), f(w.Bytes), f(w.BuffersFull)
	}
	for _, b := range m.Backends {
		switch b.State {
		case "active":
			s["active"]++
		case "idle":
			s["idle"]++
		case "idle in transaction", "idle in transaction (aborted)":
			s["idle_in_xact"]++
		}
		if b.WaitEventType == "Lock" {
			s["waiting"]++
		}
		if b.XactStart > 0 && at-b.XactStart > 300 {
			s["long_xact"]++
		}
	}
	for _, l := range m.Locks {
		if !l.Granted {
			s["locks_waiting"]++
		}
	}
	if sy := m.System; sy != nil {
		s["load"], s["cores"] = sy.LoadAvg, f(sy.NumCores)
		s["mem_used"], s["mem_free"], s["mem_buffers"], s["mem_cached"] = f(sy.MemUsed), f(sy.MemFree), f(sy.MemBuffers), f(sy.MemCached)
		s["swap_used"], s["swap_free"] = f(sy.SwapUsed), f(sy.SwapFree)
	}
	if m.IsInRecovery {
		if lag, ok := lsnDiff(m.LastWALReceiveLSN, m.LastWALReplayLSN); ok {
			s["standby_lag_bytes"] = lag
		}
		if m.LastXActReplayTimestamp > 0 {
			s["standby_lag_secs"] = f(at - m.LastXActReplayTimestamp)
		}
	}
	cur := currentLSN(m)
	for _, r := range m.ReplicationOutgoing {
		v := vals{"write_lag": f(r.WriteLag), "flush_lag": f(r.FlushLag), "replay_lag": f(r.ReplayLag)}
		for k, lsn := range map[string]string{"write_lag_bytes": r.WriteLSN, "flush_lag_bytes": r.FlushLSN, "replay_lag_bytes": r.ReplayLSN} {
			if lag, ok := lsnDiff(cur, lsn); ok {
				v[k] = lag
			}
		}
		out["repl:"+standbyName(r)] = v
	}
	for _, sl := range m.ReplicationSlots {
		if !sl.Active {
			s["inactive_slots"]++
		}
		if retained, ok := lsnDiff(cur, sl.RestartLSN); ok {
			out["slot:"+sl.SlotName] = vals{"retained_bytes": retained, "active": f(sl.Active)}
		}
	}
	for _, d := range m.Databases {
		v := vals{
			"numbackends": f(d.NumBackends), "xact_commit": f(d.XactCommit), "xact_rollback": f(d.XactRollback),
			"blks_read": f(d.BlksRead), "blks_hit": f(d.BlksHit), "tup_returned": f(d.TupReturned), "tup_fetched": f(d.TupFetched),
			"tup_inserted": f(d.TupInserted), "tup_updated": f(d.TupUpdated), "tup_deleted": f(d.TupDeleted),
			"conflicts": f(d.Conflicts), "temp_files": f(d.TempFiles), "temp_bytes": f(d.TempBytes), "deadlocks": f(d.Deadlocks),
			"blk_read_time": d.BlkReadTime, "blk_write_time": d.BlkWriteTime, "size": f(d.Size), "age_datfrozenxid": f(d.AgeDatFrozenXid),
		}
		out["db:"+d.Name] = v
		for _, k := range []string{"xact_commit", "xact_rollback", "blks_read", "blks_hit", "tup_returned", "tup_fetched",
			"tup_inserted", "tup_updated", "tup_deleted", "temp_bytes", "deadlocks", "size"} {
			s[k] += v[k]
		}
	}
	for _, t := range m.Tablespaces {
		out["ts:"+t.Name] = vals{"size": f(t.Size), "disk_used": f(t.DiskUsed), "disk_total": f(t.DiskTotal),
			"inodes_used": f(t.InodesUsed), "inodes_total": f(t.InodesTotal)}
	}
	for _, t := range m.Tables {
		out["tbl:"+t.DBName+"."+t.SchemaName+"."+t.Name] = vals{
			"seq_scan": f(t.SeqScan), "seq_tup_read": f(t.SeqTupRead), "idx_scan": f(t.IdxScan), "idx_tup_fetch": f(t.IdxTupFetch),
			"n_tup_ins": f(t.NTupIns), "n_tup_upd": f(t.NTupUpd), "n_tup_del": f(t.NTupDel), "n_tup_hot_upd": f(t.NTupHotUpd),
			"n_live_tup": f(t.NLiveTup), "n_dead_tup": f(t.NDeadTup), "heap_blks_read": f(t.HeapBlksRead), "heap_blks_hit": f(t.HeapBlksHit),
			"idx_blks_read": f(t.IdxBlksRead), "idx_blks_hit": f(t.IdxBlksHit), "size": f(t.Size), "bloat": f(t.Bloat),
			"vacuum_count": f(t.VacuumCount), "autovacuum_count": f(t.AutovacuumCount), "analyze_count": f(t.AnalyzeCount),
			"autoanalyze_count": f(t.AutoanalyzeCount),
		}
	}
	for _, i := range m.Indexes {
		out["idx:"+i.DBName+"."+i.SchemaName+"."+i.Name] = vals{"idx_scan": f(i.IdxScan), "idx_tup_read": f(i.IdxTupRead),
			"idx_tup_fetch": f(i.IdxTupFetch), "idx_blks_read": f(i.IdxBlksRead), "idx_blks_hit": f(i.IdxBlksHit), "size": f(i.Size), "bloat": f(i.Bloat)}
	}
	for _, q := range statements(m) {
		out[fmt.Sprintf("q:%s:%d", q.DBName, q.QueryID)] = vals{"calls": f(q.Calls), "total_time": q.TotalTime, "rows": f(q.Rows),
			"max_time": q.MaxTime, "shared_blks_hit": f(q.SharedBlksHit), "shared_blks_read": f(q.SharedBlksRead),
			"temp_blks_written": f(q.TempBlksWritten), "blk_read_time": q.BlkReadTime, "blk_write_time": q.BlkWriteTime, "wal_bytes": f(q.WALBytes)}
	}
	for _, fn := range m.UserFunctions {
		out["fn:"+fn.DBName+"."+fn.SchemaName+"."+fn.Name] = vals{"calls": f(fn.Calls), "total_time": fn.TotalTime, "self_time": fn.SelfTime}
	}
	if m.RDS != nil {
		for k, v := range m.RDS.Basic {
			s["rds."+k] = f(v)
		}
	}
	if m.Azure != nil {
		for k, v := range m.Azure.Metrics {
			s["azure."+k] = f(v)
		}
	}
	out[""] = s
	// -1 means pgmetrics could not read the value (e.g. lock timeout): leave a gap
	for _, v := range out {
		for _, k := range []string{"size", "bloat"} {
			if x, ok := v[k]; ok && x < 0 {
				delete(v, k)
			}
		}
	}
	return out
}

func extractPgBouncer(out map[string]vals, p *pgmetrics.PgBouncer, prefix string) {
	out[prefix] = vals{"sc_active": f(p.SCActive), "sc_idle": f(p.SCIdle), "sc_used": f(p.SCUsed), "sc_maxwait": p.SCMaxWait,
		"cc_active": f(p.CCActive), "cc_waiting": f(p.CCWaiting), "cc_idle": f(p.CCIdle), "cc_used": f(p.CCUsed),
		"cc_maxwait": p.CCMaxWait, "cc_avgwait": p.CCAvgWait}
	for _, s := range p.Stats {
		out[prefix+":db:"+s.Database] = vals{"xacts": f(s.TotalXactCount), "queries": f(s.TotalQueryCount), "received": f(s.TotalReceived),
			"sent": f(s.TotalSent), "xact_time": s.TotalXactTime, "query_time": s.TotalQueryTime, "wait_time": s.TotalWaitTime}
	}
	for _, pl := range p.Pools {
		out[prefix+":pool:"+pl.Database+"/"+pl.UserName] = vals{"cl_active": f(pl.ClActive), "cl_waiting": f(pl.ClWaiting),
			"sv_active": f(pl.SvActive), "sv_idle": f(pl.SvIdle), "sv_used": f(pl.SvUsed), "maxwait": pl.MaxWait}
	}
}

func extractPgpool(out map[string]vals, p *pgmetrics.Pgpool) {
	q := p.QueryCache
	s := vals{"cache_hits": f(q.NumCacheHits), "selects": f(q.NumSelects), "cache_hit_ratio": q.CacheHitRatio,
		"hash_entries_used": f(q.UsedHashEntries), "cache_entries": f(q.NumCacheEntries), "cache_used": f(q.UsedCacheEntriesSize),
		"cache_free": f(q.FreeCacheEntriesSize)}
	for _, b := range p.Backends {
		if b.Status == "up" || b.Status == "waiting" {
			s["backends_up"]++
		}
		out["be:"+strconv.Itoa(b.NodeID)] = vals{"select": f(b.SelectCount), "insert": f(b.InsertCount), "update": f(b.UpdateCount),
			"delete": f(b.DeleteCount), "ddl": f(b.DDLCount), "other": f(b.OtherCount), "errors": f(b.ErrorCount + b.FatalCount + b.PanicCount),
			"repl_delay": f(b.ReplicationDelay), "repl_delay_secs": b.ReplicationDelaySeconds, "hc_fail": f(b.HCFailCount), "hc_total": f(b.HCTotalCount)}
	}
	s["backends"] = f(len(p.Backends))
	out[""] = s
}

//------------------------------------------------------------------------------
// per-server summary used by the server list and the fleet-wide Inspector

type dbSummary struct {
	Name        string  `json:"name"`
	Size        int64   `json:"size"`
	Backends    int     `json:"backends"`
	CommitRatio float64 `json:"commit_ratio"`
	CacheHit    float64 `json:"cache_hit"`
	XIDAgePct   float64 `json:"xid_age_pct"`
	Deadlocks   int64   `json:"deadlocks"`
	TempBytes   int64   `json:"temp_bytes"`
}

type serverSummary struct {
	Version       string      `json:"version"`
	Start         int64       `json:"start"`
	Recovery      bool        `json:"recovery"`
	Hostname      string      `json:"hostname,omitempty"`
	Backends      int         `json:"backends"`
	MaxConn       int         `json:"max_conn"`
	Active        int         `json:"active"`
	IdleInXact    int         `json:"idle_in_xact"`
	Waiting       int         `json:"waiting"`
	LongXact      int         `json:"long_xact"`
	Size          int64       `json:"size"`
	Tables        int         `json:"tables"`
	Indexes       int         `json:"indexes"`
	XIDRangePct   float64     `json:"xid_range_pct"`
	CacheHit      float64     `json:"cache_hit"`
	CommitRatio   float64     `json:"commit_ratio"`
	WALCount      int         `json:"wal_count"`
	WALReady      int         `json:"wal_ready"`
	ArchiveFailed bool        `json:"archive_failed"`
	ReplicaCount  int         `json:"replicas"`
	ReplLagBytes  *float64    `json:"repl_lag_bytes"` // null when every lag there is is unknown
	ReplLagSecs   float64     `json:"repl_lag_secs"`
	InactiveSlots int         `json:"inactive_slots"`
	DiskFreePct   float64     `json:"disk_free_pct"` // -1 = unknown
	LoadAvg       float64     `json:"load"`
	MemUsedPct    float64     `json:"mem_used_pct"`
	Statements    int         `json:"statements"`
	Cloud         bool        `json:"cloud"`
	DBs           []dbSummary `json:"dbs"`
}

func summarize(m *pgmetrics.Model) serverSummary {
	ex := extractMetrics(m, "")[""]
	s := serverSummary{Version: m.Settings["server_version"].Setting, Start: m.StartTime, Recovery: m.IsInRecovery,
		Backends: len(m.Backends), MaxConn: int(setting(m, "max_connections")), Active: int(ex["active"]), IdleInXact: int(ex["idle_in_xact"]),
		Waiting: int(ex["waiting"]), LongXact: int(ex["long_xact"]), Tables: len(m.Tables), Indexes: len(m.Indexes),
		XIDRangePct: 100 * ex["xid_range"] / 2147483647, WALCount: m.WALCount, WALReady: m.WALReadyCount,
		ArchiveFailed: m.WALArchiving.LastFailedTime > m.WALArchiving.LastArchivedTime, ReplicaCount: len(m.ReplicationOutgoing),
		ReplLagSecs: ex["standby_lag_secs"], InactiveSlots: int(ex["inactive_slots"]),
		DiskFreePct: -1, Statements: len(m.Statements), Cloud: m.RDS != nil || m.Azure != nil, DBs: []dbSummary{}}
	if sy := m.System; sy != nil {
		s.Hostname, s.LoadAvg = sy.Hostname, sy.LoadAvg
		s.MemUsedPct = 100 * ratio(f(sy.MemUsed), f(sy.MemUsed+sy.MemFree+sy.MemBuffers+sy.MemCached))
	}
	freeze := setting(m, "autovacuum_freeze_max_age")
	var hit, read, commit, rollback float64
	for _, d := range m.Databases {
		s.Size += d.Size
		hit, read, commit, rollback = hit+f(d.BlksHit), read+f(d.BlksRead), commit+f(d.XactCommit), rollback+f(d.XactRollback)
		s.DBs = append(s.DBs, dbSummary{Name: d.Name, Size: d.Size, Backends: d.NumBackends,
			CommitRatio: 100 * ratio(f(d.XactCommit), f(d.XactCommit+d.XactRollback)), CacheHit: 100 * ratio(f(d.BlksHit), f(d.BlksHit+d.BlksRead)),
			XIDAgePct: 100 * ratio(f(d.AgeDatFrozenXid), freeze), Deadlocks: d.Deadlocks, TempBytes: d.TempBytes})
	}
	s.CacheHit, s.CommitRatio = 100*ratio(hit, hit+read), 100*ratio(commit, commit+rollback)
	lag, known := ex["standby_lag_bytes"] // the largest known replay lag
	cur := currentLSN(m)
	for _, r := range m.ReplicationOutgoing {
		if l, ok := lsnDiff(cur, r.ReplayLSN); ok {
			lag, known = math.Max(lag, l), true
		}
		s.ReplLagSecs = math.Max(s.ReplLagSecs, f(r.ReplayLag))
	}
	if known || (!m.IsInRecovery && len(m.ReplicationOutgoing) == 0) {
		s.ReplLagBytes = &lag
	}
	for _, t := range m.Tablespaces {
		if t.DiskTotal > 0 {
			free := 100 * f(t.DiskTotal-t.DiskUsed) / f(t.DiskTotal)
			if s.DiskFreePct < 0 || free < s.DiskFreePct {
				s.DiskFreePct = free
			}
		}
	}
	return s
}

func summarizePgpool(m *pgmetrics.Model) map[string]any {
	up := 0
	for _, b := range m.Pgpool.Backends {
		if b.Status == "up" || b.Status == "waiting" {
			up++
		}
	}
	return map[string]any{"version": m.Pgpool.Version, "backends": len(m.Pgpool.Backends), "backends_up": up,
		"cache_hit_ratio": m.Pgpool.QueryCache.CacheHitRatio}
}
