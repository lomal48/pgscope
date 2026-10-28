package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// collect runs one collection for t and returns its status and error detail.
func (a *agent) collect(ctx context.Context, t *target) (status, msg string) {
	s := t.spec
	user, sslmode, pw := s.User, s.SSLMode, a.cfg.password
	if user == "" {
		user = a.cfg.user
	}
	if sslmode == "" {
		sslmode = a.cfg.sslmode
	}
	if s.PasswordFile != "" {
		b, err := os.ReadFile(s.PasswordFile)
		if err != nil {
			return "error", detail("pgscope.password-file: "+err.Error(), "")
		}
		pw = strings.TrimRight(string(b), "\r\n")
		// a label must not make the agent hand its API key to the labelled container as a password
		if strings.TrimSpace(pw) == a.cfg.apiKey {
			return "error", "the label pgscope.password-file names the agent's API key"
		}
	}
	fail := func(status string, err error) (string, string) {
		if status == "" {
			status = classify(err.Error())
		}
		return status, detail(err.Error(), pw)
	}

	dbs, err := precheck(ctx, t.ip, s, user, pw, sslmode)
	if err != nil {
		return fail("", err)
	}
	data, err := a.pgmetrics(ctx, t.ip, s.Port, user, pw, sslmode, dbs)
	if err != nil {
		return fail("", err)
	}
	if err := a.upload(ctx, t, data); err != nil {
		return fail("error", err)
	}
	return "ok", ""
}

// precheck connects like pgmetrics will, so that unreachable and auth problems
// are told apart, and lists the databases the role may connect to: pgmetrics
// --all-dbs aborts the whole report on the first database it cannot open.
func precheck(ctx context.Context, host string, s spec, user, pw, sslmode string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	db := "postgres"
	if s.Kind == "pgbouncer" {
		db = "pgbouncer"
	} else if len(s.DBs) > 0 {
		db = s.DBs[0]
	}
	cs := kv("host", host) + kv("port", strconv.Itoa(s.Port)) + kv("user", user) + kv("dbname", db) +
		kv("sslmode", sslmode) + kv("connect_timeout", "10") + kv("application_name", "pgscope-agent")
	if s.Kind == "pgbouncer" {
		cs += kv("default_query_exec_mode", "simple_protocol") // the admin console speaks only the simple protocol
	}
	cfg, err := pgx.ParseConfig(cs)
	if err != nil {
		return nil, err
	}
	cfg.Password = pw
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer conn.Close(ctx)
	if s.Kind == "pgbouncer" {
		return []string{"pgbouncer"}, nil
	}
	if len(s.DBs) > 0 {
		return s.DBs, nil
	}
	rows, _ := conn.Query(ctx, `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate
		AND has_database_privilege(datname, 'CONNECT') ORDER BY 1`)
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	// any user with CREATEDB names databases: skip names that would rewrite pgmetrics' connection string
	dbs := names[:0]
	for _, n := range names {
		if connSafe(n) {
			dbs = append(dbs, n)
		}
	}
	if len(dbs) == 0 {
		return nil, fmt.Errorf("role %s may not connect to any database", user)
	}
	return dbs, nil
}

// kv quotes one keyword/value pair of a libpq-style connection string.
func kv(k, v string) string {
	return k + "='" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(v) + "' "
}

// pgmetrics runs the pgmetrics binary with keyword flags (URL-form connection
// strings break it) and the password in the environment only.
func (a *agent) pgmetrics(ctx context.Context, host string, port int, user, pw, sslmode string, dbs []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, a.cfg.timeout)
	defer cancel()
	args := []string{"-h", host, "-p", strconv.Itoa(port), "-U", user, "-w", "-f", "json", "-t", strconv.Itoa(a.cfg.queryTimeout)}
	args = append(append(append(args, a.cfg.pgmetricsArgs...), "--"), dbs...)
	cmd := exec.CommandContext(ctx, a.cfg.pgmetrics, args...)
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "PGSCOPE_") { // keep the agent's own secrets out of the child
			cmd.Env = append(cmd.Env, e)
		}
	}
	// pgmetrics defaults to sslmode=disable in flag mode, so always set PGSSLMODE
	// (PGAPPNAME would not help: pgmetrics always connects as application_name=pgmetrics)
	cmd.Env = append(cmd.Env, "PGPASSWORD="+pw, "PGSSLMODE="+sslmode, "PGCONNECT_TIMEOUT=10")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return nil, fmt.Errorf("pgmetrics did not finish within %s (PGSCOPE_AGENT_TIMEOUT)", a.cfg.timeout)
	case err != nil:
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("pgmetrics: %v", err)
	case !json.Valid(out):
		return nil, errors.New("pgmetrics output is not valid JSON")
	}
	return out, nil
}

//------------------------------------------------------------------------------
// talking to pgscope

func (a *agent) upload(ctx context.Context, t *target, data []byte) error {
	path, req := "/api/v1/report", map[string]any{"apikey": a.cfg.apiKey, "server": t.Name, "data": json.RawMessage(data)}
	if t.Kind == "pgbouncer" {
		path, req["server"], req["pgbouncer"] = "/api/v1/reportpgbouncer", t.spec.Server, t.Name
	}
	body, err := gz(req)
	if err != nil {
		return err
	}
	for try := 1; ; try++ {
		code, msg, err := a.post(ctx, path, body)
		switch {
		case err == nil && code == 200:
			return nil
		case try == 1 && (err != nil || code >= 500): // pgscope restarting or its storage briefly down
			select {
			case <-time.After(5 * time.Second):
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		case err != nil:
			return fmt.Errorf("sending the report: %v", err)
		case code == 403:
			log.Printf("ERROR: pgscope rejected the API key (HTTP 403: %s); check PGSCOPE_API_KEY", msg)
		}
		// 429 (too often) and 409 (previous report still being stored) are not
		// retried: the next interval sends a fresh report.
		return fmt.Errorf("pgscope answered HTTP %d: %s", code, msg)
	}
}

var hc = &http.Client{Timeout: 2 * time.Minute}

// post sends a gzipped JSON body and returns the status code and pgscope's error message.
func (a *agent) post(ctx context.Context, path string, body []byte) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", a.cfg.url+path, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Accept-Language", "en")
	req.Header.Set("User-Agent", "pgscope-agent/"+version)
	resp, err := hc.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var e struct{ Error string }
	if json.Unmarshal(b, &e) != nil || e.Error == "" {
		e.Error = strings.TrimSpace(string(b))
	}
	return resp.StatusCode, e.Error, nil
}

func gz(v any) ([]byte, error) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		return nil, err
	}
	err := w.Close()
	return buf.Bytes(), err
}
