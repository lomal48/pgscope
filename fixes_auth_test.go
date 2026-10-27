package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// authDB points db at the scratch database in PGSCOPE_TEST_DB (skips without it), with the
// schema set up and no accounts.
func authDB(t *testing.T) context.Context {
	url := os.Getenv("PGSCOPE_TEST_DB")
	if url == "" {
		t.Skip("set PGSCOPE_TEST_DB to a scratch database to run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, schema+`truncate users cascade`); err != nil {
		t.Fatal(err)
	}
	db = pool
	t.Cleanup(func() { pool.Close(); db = nil })
	return ctx
}

func testMux() http.Handler {
	mux := http.NewServeMux()
	routes(mux)
	return withLang(mux)
}

func call(h http.Handler, method, path, body string, c *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func sessionOf(t *testing.T, w *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			return c
		}
	}
	t.Fatalf("no session cookie: %d %s", w.Code, w.Body)
	return nil
}

// A1: PGSCOPE_SIGNUP; "first" lets exactly one of concurrent signups on an empty database through
func TestSignupModes(t *testing.T) {
	authDB(t)
	h := testMux()
	defer func(s string) { cfg.Signup = s }(cfg.Signup)
	cfg.Signup = "first"
	if w := call(h, "GET", "/api/signup", "", nil); w.Body.String() != "{\"open\":true}\n" {
		t.Fatalf("GET /api/signup on an empty database = %s", w.Body)
	}
	codes := make(chan int, 8)
	var wg sync.WaitGroup
	for i := range cap(codes) {
		wg.Go(func() {
			codes <- call(h, "POST", "/api/signup", fmt.Sprintf(`{"email":"u%d@x","password":"password1"}`, i), nil).Code
		})
	}
	wg.Wait()
	close(codes)
	n := map[int]int{}
	for c := range codes {
		n[c]++
	}
	if n[200] != 1 || n[403] != cap(codes)-1 {
		t.Fatalf("concurrent first signups: status counts %v", n)
	}
	if w := call(h, "GET", "/api/signup", "", nil); w.Body.String() != "{\"open\":false}\n" {
		t.Fatalf("GET /api/signup with an account = %s", w.Body)
	}
	cfg.Signup = "open"
	if w := call(h, "POST", "/api/signup", `{"email":"open@x","password":"password1"}`, nil); w.Code != 200 {
		t.Fatalf("open signup: %d %s", w.Code, w.Body)
	}
	cfg.Signup = "closed"
	w := call(h, "POST", "/api/signup", `{"email":"closed@x","password":"password1"}`, nil)
	if w.Code != 403 || !strings.Contains(w.Body.String(), "Регистрация новых аккаунтов отключена") {
		t.Fatalf("closed signup: %d %s", w.Code, w.Body)
	}
}

// A2: the public state-changing endpoints have the JSON-only CSRF guard; the CLI ingestion API does not
func TestPublicCSRF(t *testing.T) {
	h := testMux()
	for _, p := range []string{"/api/signup", "/api/login", "/api/logout", "/api/invite/x"} {
		r := httptest.NewRequest("POST", p, strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "text/plain")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnsupportedMediaType {
			t.Errorf("text/plain POST %s = %d, want 415", p, w.Code)
		}
	}
	defer func(n int64) { cfg.MaxReport = n }(cfg.MaxReport)
	cfg.MaxReport = 1 << 20
	for _, p := range []string{"/api/v1/report", "/api/v1/agent"} {
		r := httptest.NewRequest("POST", p, strings.NewReader(`{"apikey":"bad"}`))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 { // reaches the API key check
			t.Errorf("POST %s without Content-Type = %d %s, want 401", p, w.Code, w.Body)
		}
	}
}

// A3: an unknown email is compared against a hash as costly as a real one
func TestLoginDummyHash(t *testing.T) {
	if c, err := bcrypt.Cost([]byte(dummyHash)); err != nil || c != bcrypt.DefaultCost {
		t.Fatalf("dummyHash cost = %d, %v", c, err)
	}
}

// A4: changing the password ends the user's other sessions and keeps the current one
func TestChangePasswordRevokes(t *testing.T) {
	authDB(t)
	h := testMux()
	defer func(s string) { cfg.Signup = s }(cfg.Signup)
	cfg.Signup, cfg.MinInterval = "open", time.Minute
	s1 := sessionOf(t, call(h, "POST", "/api/signup", `{"email":"a@x","password":"password1"}`, nil))
	s2 := sessionOf(t, call(h, "POST", "/api/login", `{"email":"a@x","password":"password1"}`, nil))
	if w := call(h, "POST", "/api/me/password", `{"old":"password1","new":"password2"}`, s1); w.Code != 200 {
		t.Fatalf("change password: %d %s", w.Code, w.Body)
	}
	if w := call(h, "GET", "/api/me", "", s2); w.Code != 401 {
		t.Fatalf("other session after the change: %d", w.Code)
	}
	w := call(h, "GET", "/api/me", "", s1)
	var me struct {
		MinReportInterval int `json:"min_report_interval"`
	}
	if json.Unmarshal(w.Body.Bytes(), &me); w.Code != 200 || me.MinReportInterval != 60 {
		t.Fatalf("current session after the change: %d %s", w.Code, w.Body)
	}
	if w := call(h, "POST", "/api/login", `{"email":"a@x","password":"password2"}`, nil); w.Code != 200 {
		t.Fatalf("login with the new password: %d", w.Code)
	}
}

// A5: 8+ characters (not bytes), at most 72 bytes
func TestPasswordRule(t *testing.T) {
	for p, ok := range map[string]bool{
		"абвг":                  false, // 8 bytes, 4 characters
		"пароль1":               false, // 7 characters
		"пароль12":              true,
		strings.Repeat("я", 36): true, // 72 bytes
		strings.Repeat("я", 37): false,
		strings.Repeat("a", 72): true,
		strings.Repeat("a", 73): false,
	} {
		c := credentials{Email: "a@x", Password: p}
		if err := c.clean(); (err == nil) != ok {
			t.Errorf("password %q (%d bytes): err = %v", p, len(p), err)
		}
	}
}

// owner signs up an owner account with one server and returns its session and server id.
func owner(t *testing.T, ctx context.Context, h http.Handler) (*http.Cookie, int64) {
	t.Helper()
	cfg.Signup = "open"
	s := sessionOf(t, call(h, "POST", "/api/signup", `{"email":"owner@x","password":"password1"}`, nil))
	var sid int64
	if err := db.QueryRow(ctx, `insert into servers(owner_id, name) select id, 'srv' from users where email = 'owner@x' returning id`).Scan(&sid); err != nil {
		t.Fatal(err)
	}
	return s, sid
}

func invites(t *testing.T, ctx context.Context, email string) int {
	var n int
	if err := db.QueryRow(ctx, `select count(*) from invites where email = $1`, email).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A6: a failed acceptance keeps the invite; an existing account gets 409
func TestAcceptInvite(t *testing.T) {
	ctx := authDB(t)
	h := testMux()
	defer func(s string) { cfg.Signup = s }(cfg.Signup)
	s, sid := owner(t, ctx, h)
	var res struct{ Link string }
	json.Unmarshal(call(h, "POST", fmt.Sprintf("/api/servers/%d/shares", sid), `{"email":"m@x"}`, s).Body.Bytes(), &res)
	accept := "/api/invite/" + res.Link[strings.LastIndex(res.Link, "/")+1:]
	if w := call(h, "POST", accept, `{"password":"short"}`, nil); w.Code != 400 || invites(t, ctx, "m@x") != 1 {
		t.Fatalf("short password: %d, invite kept: %d", w.Code, invites(t, ctx, "m@x"))
	}
	call(h, "POST", "/api/signup", `{"email":"m@x","password":"password1"}`, nil) // the account appears meanwhile
	w := call(h, "POST", accept, `{"password":"password1"}`, nil)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "Войдите в неё") || invites(t, ctx, "m@x") != 1 {
		t.Fatalf("existing account: %d %s, invites %d", w.Code, w.Body, invites(t, ctx, "m@x"))
	}
	if _, err := db.Exec(ctx, `delete from users where email = 'm@x'`); err != nil {
		t.Fatal(err)
	}
	m := sessionOf(t, call(h, "POST", accept, `{"password":"password1"}`, nil))
	if w := call(h, "GET", fmt.Sprintf("/api/servers/%d/shares", sid), "", m); w.Code != 200 || invites(t, ctx, "m@x") != 0 {
		t.Fatalf("after acceptance: %d, invites %d", w.Code, invites(t, ctx, "m@x"))
	}
}

// A7: inviting the same email again reuses the pending invite; sharing with an account drops it
func TestInviteReused(t *testing.T) {
	ctx := authDB(t)
	h := testMux()
	defer func(s string) { cfg.Signup = s }(cfg.Signup)
	s, sid := owner(t, ctx, h)
	share := fmt.Sprintf("/api/servers/%d/shares", sid)
	a, b := call(h, "POST", share, `{"email":"m@x"}`, s).Body.String(), call(h, "POST", share, `{"email":" M@x "}`, s).Body.String()
	if a != b || !strings.Contains(a, `"invited":true`) || invites(t, ctx, "m@x") != 1 {
		t.Fatalf("second invite: %s vs %s, rows %d", a, b, invites(t, ctx, "m@x"))
	}
	call(h, "POST", "/api/signup", `{"email":"m@x","password":"password1"}`, nil)
	if w := call(h, "POST", share, `{"email":"m@x"}`, s); !strings.Contains(w.Body.String(), `"invited":false`) || invites(t, ctx, "m@x") != 0 {
		t.Fatalf("share with the account: %s, invites %d", w.Body, invites(t, ctx, "m@x"))
	}
}

type logSink struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *logSink) Write(p []byte) (int, error) { l.mu.Lock(); defer l.mu.Unlock(); return l.b.Write(p) }
func (l *logSink) String() string              { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

// A8: team emails that cannot be sent are logged; missing SMTP is logged once
func TestMailShareLogs(t *testing.T) {
	var out logSink
	log.SetOutput(&out)
	defer log.SetOutput(os.Stderr)
	defer func(a string) { cfg.SMTPAddr = a }(cfg.SMTPAddr)
	smtpOffLogged = sync.Once{}
	cfg.SMTPAddr = ""
	mailShare([]string{"m@x"}, "s", "b")
	mailShare([]string{"m@x"}, "s", "b")
	if n := strings.Count(out.String(), "SMTP is not configured"); n != 1 {
		t.Fatalf("SMTP not configured logged %d times: %s", n, out.String())
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	cfg.SMTPAddr = ln.Addr().String()
	ln.Close() // nothing listens: the delivery fails
	mailShare([]string{"m@x"}, "invite", "b")
	for end := time.Now().Add(5 * time.Second); !strings.Contains(out.String(), `team email "invite" to m@x not sent`); {
		if time.Now().After(end) {
			t.Fatalf("failed delivery not logged: %s", out.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
