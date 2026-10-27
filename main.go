// pgscope: a self-hosted PostgreSQL monitoring server. It accepts pgmetrics
// reports through the same API the open-source `pgdash` CLI speaks, stores
// them in PostgreSQL and serves a web UI on top.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed all:web/dist
var webDist embed.FS

var db *pgxpool.Pool

var cfg struct {
	Listen, DB, BaseURL                    string
	Signup                                 string // first | open | closed
	MinInterval                            time.Duration
	MetricsDays, ReportDays                int   // 0 = keep forever
	MaxReport                              int64 // bytes of a report body, compressed and decompressed
	SMTPAddr, SMTPUser, SMTPPass, SMTPFrom string
	AIKey, AIModel, AIBaseURL              string
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return n
	}
	return def
}

// retentionDays reads a retention setting: days to keep, 0 = keep forever.
func retentionDays(k string, def int) int {
	n := envInt(k, def)
	if n < 0 {
		log.Fatalf("%s=%d: set a number of days to keep the data, or 0 to keep it forever", k, n)
	}
	return n
}

func main() {
	cfg.Listen = env("PGSCOPE_LISTEN", ":8080")
	cfg.DB = env("PGSCOPE_DB", "postgres://localhost/pgscope")
	cfg.BaseURL = strings.TrimSuffix(env("PGSCOPE_BASE_URL", "http://localhost:8080"), "/")
	// first: self-registration only while there is no account; open: anyone; closed: invitations only
	cfg.Signup = env("PGSCOPE_SIGNUP", "first")
	if !slices.Contains([]string{"first", "open", "closed"}, cfg.Signup) {
		log.Fatalf("PGSCOPE_SIGNUP=%s: use first, open or closed", cfg.Signup)
	}
	cfg.MinInterval = time.Duration(envInt("PGSCOPE_MIN_REPORT_INTERVAL", 60)) * time.Second
	cfg.MetricsDays = retentionDays("PGSCOPE_METRICS_RETENTION_DAYS", 90)
	cfg.ReportDays = retentionDays("PGSCOPE_REPORT_RETENTION_DAYS", 14)
	// pgmetrics writes up to ~1 KiB per table or index, so 256 MiB fits ~250 000 of them;
	// storing a report takes 5-7 times its size in memory (measured) and at most 4 are
	// stored at once (reportSlots), which bounds the worst case to ~6 GiB
	cfg.MaxReport = int64(envInt("PGSCOPE_MAX_REPORT_MB", 256)) << 20
	if cfg.MaxReport < 1<<20 {
		log.Fatal("PGSCOPE_MAX_REPORT_MB must be at least 1")
	}
	cfg.SMTPAddr, cfg.SMTPUser, cfg.SMTPPass = os.Getenv("PGSCOPE_SMTP_ADDR"), os.Getenv("PGSCOPE_SMTP_USER"), os.Getenv("PGSCOPE_SMTP_PASS")
	cfg.SMTPFrom = env("PGSCOPE_SMTP_FROM", "pgscope@localhost")
	cfg.AIKey, cfg.AIModel, cfg.AIBaseURL = os.Getenv("PGSCOPE_AI_KEY"), os.Getenv("PGSCOPE_AI_MODEL"), os.Getenv("PGSCOPE_AI_BASE_URL")

	ctx := context.Background()
	var err error
	if db, err = pgxpool.New(ctx, cfg.DB); err != nil {
		log.Fatal(err)
	}
	if _, err = db.Exec(ctx, schema); err != nil {
		log.Fatal("schema setup: ", err)
	}
	go retentionLoop()

	mux := http.NewServeMux()
	routes(mux)
	dist, _ := fs.Sub(webDist, "web/dist")
	mux.Handle("/", http.FileServerFS(dist))
	log.Printf("pgscope listening on %s (public URL %s)", cfg.Listen, cfg.BaseURL)
	// ReadHeaderTimeout and IdleTimeout keep clients from holding connections open (slowloris).
	// ReadTimeout bounds reading a whole request with its body: 10 minutes let a 256 MiB report
	// (the default PGSCOPE_MAX_REPORT_MB) arrive at about 0.5 MB/s. WriteTimeout runs from the end
	// of the headers to the end of the response, so it must outlast an AI chat answer: the
	// Anthropic SDK waits up to 10 minutes per attempt and makes up to 3 attempts.
	hs := &http.Server{Addr: cfg.Listen, Handler: withLang(mux), ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 10 * time.Minute, WriteTimeout: 35 * time.Minute, IdleTimeout: 2 * time.Minute}
	log.Fatal(hs.ListenAndServe())
}

func routes(mux *http.ServeMux) {
	// ingestion API, compatible with `pgdash --base-url=<BASE>/api/v1`
	mux.HandleFunc("POST /api/v1/report", ingest("report"))
	mux.HandleFunc("POST /api/v1/reportpgbouncer", ingest("pgbouncer"))
	mux.HandleFunc("POST /api/v1/reportpgpool", ingest("pgpool"))
	mux.HandleFunc("POST /api/v1/agent", agentHeartbeat)

	// no session needed; jsonOnly guards them against cross-site forms (login CSRF, forced logout)
	mux.HandleFunc("GET /api/signup", getSignup)
	mux.Handle("POST /api/signup", jsonOnly(signup))
	mux.Handle("POST /api/login", jsonOnly(login))
	mux.Handle("POST /api/logout", jsonOnly(logout))
	mux.HandleFunc("GET /api/invite/{token}", getInvite)
	mux.Handle("POST /api/invite/{token}", jsonOnly(acceptInvite))

	mux.Handle("GET /api/me", authed(me))
	mux.Handle("POST /api/me/apikey", authed(regenAPIKey))
	mux.Handle("POST /api/me/password", authed(changePassword))
	mux.Handle("PUT /api/me/lang", authed(setLang))
	mux.Handle("DELETE /api/me", authed(deleteMe))
	mux.Handle("GET /api/servers", authed(listServers))
	mux.Handle("GET /api/agents", authed(listAgents))
	mux.Handle("DELETE /api/agents", authed(deleteAgent)) // ?id=, agent ids contain "/"

	mux.Handle("GET /api/servers/{id}/report", srv(getReport, false))
	mux.Handle("GET /api/servers/{id}/reports", srv(listReports, false))
	mux.Handle("GET /api/servers/{id}/series", srv(getSeries, false))
	mux.Handle("GET /api/servers/{id}/baseline", srv(getBaseline, false))
	mux.Handle("GET /api/servers/{id}/diagnostics", srv(getDiagnostics, false))
	mux.Handle("GET /api/servers/{id}/alerts", srv(getAlerts, false))
	mux.Handle("POST /api/servers/{id}/alerts/rules", srv(addRule, false))
	mux.Handle("DELETE /api/servers/{id}/alerts/rules/{rid}", srv(delRule, false))
	mux.Handle("PUT /api/servers/{id}/changes", srv(putChangeRules, false))
	mux.Handle("POST /api/servers/{id}/notifiers", srv(addNotifier, false))
	mux.Handle("DELETE /api/servers/{id}/notifiers/{nid}", srv(delNotifier, false))
	mux.Handle("POST /api/servers/{id}/notifiers/{nid}/test", srv(testNotifier, false))
	mux.Handle("GET /api/servers/{id}/shares", srv(getShares, false))
	mux.Handle("POST /api/servers/{id}/shares", srv(addShare, true))
	mux.Handle("DELETE /api/servers/{id}/shares/{uid}", srv(delShare, true))
	mux.Handle("DELETE /api/servers/{id}/invites/{token}", srv(delInvite, true))
	mux.Handle("DELETE /api/servers/{id}", srv(deleteServer, true))
	mux.Handle("POST /api/servers/{id}/chat", srv(chat, false))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// httpErr answers with a JSON error; msg is Russian source text, translated to the request language.
func httpErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": tr(writerLang(w), msg)})
}

// internalErr logs err for the operator and answers 500 without exposing database internals to the client.
func internalErr(w http.ResponseWriter, err error) {
	log.Print(err)
	httpErr(w, http.StatusInternalServerError, "Внутренняя ошибка сервера")
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
}

func qInt(r *http.Request, k string, def int64) int64 {
	if n, err := strconv.ParseInt(r.URL.Query().Get(k), 10, 64); err == nil {
		return n
	}
	return def
}
