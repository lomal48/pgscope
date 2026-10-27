package main

import (
	"context"
	"crypto/rand"
	"errors"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

const sessionCookie = "pgscope_session"

type user struct {
	ID     int64
	Email  string
	APIKey *string // nil for team-member accounts
	Lang   *string // saved UI language, nil = not chosen yet
}

type server struct {
	ID, OwnerID int64
	Name, Kind  string
	IsOwner     bool
	User        *user
}

// API keys follow the format the pgdash CLI validates: 22 alphanumerics.
func newAPIKey() string { return rand.Text()[:22] }

func validEmail(e string) bool { return strings.Contains(e, "@") && len(e) <= 254 && !strings.ContainsAny(e, " \r\n") }

// isHTTPS reports whether the browser talks to us over TLS, also when a reverse
// proxy terminates TLS in front of pgscope.
func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" || strings.HasPrefix(cfg.BaseURL, "https://")
}

func sessionCookieFor(r *http.Request, value string, exp time.Time) *http.Cookie {
	c := &http.Cookie{Name: sessionCookie, Value: value, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r)}
	if exp.IsZero() {
		c.MaxAge = -1
	} else {
		c.Expires = exp
	}
	return c
}

func startSession(w http.ResponseWriter, r *http.Request, uid int64) error {
	tok := rand.Text() + rand.Text()
	exp := time.Now().Add(30 * 24 * time.Hour)
	if _, err := db.Exec(r.Context(), `insert into sessions(token, user_id, expires) values ($1,$2,$3)`, tok, uid, exp); err != nil {
		return err
	}
	http.SetCookie(w, sessionCookieFor(r, tok, exp))
	return nil
}

func currentUser(r *http.Request) *user {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil
	}
	var u user
	err = db.QueryRow(r.Context(), `select u.id, u.email, u.apikey, u.lang from sessions s join users u on u.id = s.user_id
		where s.token = $1 and s.expires > now()`, c.Value).Scan(&u.ID, &u.Email, &u.APIKey, &u.Lang)
	if err != nil {
		return nil
	}
	return &u
}

type authedHandler func(w http.ResponseWriter, r *http.Request, u *user)

// jsonOnly is the CSRF guard of the web UI's API: state-changing requests must be JSON,
// which a cross-site form cannot send without a CORS preflight. The ingestion API
// (/api/v1/...) does not use it: its clients send an API key, not a session cookie.
func jsonOnly(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			httpErr(w, http.StatusUnsupportedMediaType, "Тело запроса должно быть в формате JSON")
			return
		}
		h(w, r)
	})
}

// authed requires a session, behind jsonOnly.
func authed(h authedHandler) http.Handler {
	return jsonOnly(func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		if u == nil {
			httpErr(w, http.StatusUnauthorized, "Вход не выполнен")
			return
		}
		h(w, r, u)
	})
}

type srvHandler func(w http.ResponseWriter, r *http.Request, s *server)

// srv resolves {id} to a server the user owns or that was shared with them.
func srv(h srvHandler, ownerOnly bool) http.Handler {
	return authed(func(w http.ResponseWriter, r *http.Request, u *user) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		s := server{User: u}
		err := db.QueryRow(r.Context(), `select id, owner_id, name, kind from servers s where id = $1
			and (owner_id = $2 or exists (select 1 from shares where server_id = s.id and user_id = $2))`, id, u.ID).
			Scan(&s.ID, &s.OwnerID, &s.Name, &s.Kind)
		if err != nil {
			httpErr(w, http.StatusNotFound, "Сервер не найден")
			return
		}
		s.IsOwner = s.OwnerID == u.ID
		if ownerOnly && !s.IsOwner {
			httpErr(w, http.StatusForbidden, "Это действие доступно только владельцу сервера")
			return
		}
		h(w, r, &s)
	})
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (c *credentials) clean() error {
	c.Email = strings.ToLower(strings.TrimSpace(c.Email))
	if !validEmail(c.Email) {
		return errors.New("Некорректный адрес электронной почты")
	}
	// bcrypt uses only the first 72 bytes; a Cyrillic character takes 2 of them
	if utf8.RuneCountInString(c.Password) < 8 || len(c.Password) > 72 {
		return errors.New("Пароль должен содержать от 8 символов и не более 72 байт (символ кириллицы занимает 2 байта)")
	}
	return nil
}

var errUserExists = errors.New("Учётная запись с таким адресом электронной почты уже существует")

// createUser inserts the account in tx; errors are Russian text for httpErr.
func createUser(ctx context.Context, tx pgx.Tx, c credentials, withKey bool) (int64, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	if err != nil {
		return 0, err
	}
	var key *string
	if withKey {
		k := newAPIKey()
		key = &k
	}
	var id int64
	err = tx.QueryRow(ctx, `insert into users(email, pwhash, apikey) values ($1,$2,$3) on conflict (email) do nothing returning id`,
		c.Email, string(hash), key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, errUserExists
	}
	if err != nil {
		log.Print("create user: ", err)
		return 0, errors.New("Не удалось создать учётную запись")
	}
	return id, nil
}

// signupOpen reports whether POST /api/signup may create an account now (PGSCOPE_SIGNUP).
func signupOpen(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (bool, error) {
	if cfg.Signup != "first" {
		return cfg.Signup == "open", nil
	}
	var none bool
	err := q.QueryRow(ctx, `select not exists (select 1 from users)`).Scan(&none)
	return none, err
}

func getSignup(w http.ResponseWriter, r *http.Request) {
	open, err := signupOpen(r.Context(), db)
	if err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"open": open})
}

func signup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var c credentials
	if err := readJSON(r, &c); err != nil {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	open, err := signupOpen(ctx, db) // looked up without a lock first: refusals take none
	if err != nil {
		internalErr(w, err)
		return
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		internalErr(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if open && cfg.Signup == "first" {
		// concurrent signups on an empty database queue here and look again, so only the first one sees no account
		if _, err := tx.Exec(ctx, `lock table users in share row exclusive mode`); err != nil {
			internalErr(w, err)
			return
		}
		if open, err = signupOpen(ctx, tx); err != nil {
			internalErr(w, err)
			return
		}
	}
	if !open {
		httpErr(w, http.StatusForbidden, "Регистрация новых аккаунтов отключена. Попросите администратора пригласить вас.")
		return
	}
	if err := c.clean(); err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	id, err := createUser(ctx, tx, c, true)
	if err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internalErr(w, err)
		return
	}
	if err := startSession(w, r, id); err != nil {
		httpErr(w, 500, "Не удалось начать сеанс")
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// dummyHash (bcrypt.DefaultCost, like real ones) is compared when the email is unknown, so
// the answer takes as long as for a wrong password and does not reveal whether an account exists.
const dummyHash = "$2a$10$zsaGQQxt3yySOWfUWCUIeudjmHzNYlZyjqgRf1c7gsajCIX1czCfq"

func login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := readJSON(r, &c); err != nil {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	var id int64
	var hash string
	err := db.QueryRow(r.Context(), `select id, pwhash from users where email = $1`, strings.ToLower(strings.TrimSpace(c.Email))).Scan(&id, &hash)
	if err != nil {
		hash = dummyHash
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(c.Password)) != nil || err != nil {
		httpErr(w, 401, "Неверный адрес электронной почты или пароль")
		return
	}
	if err := startSession(w, r, id); err != nil {
		httpErr(w, 500, "Не удалось начать сеанс")
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		db.Exec(r.Context(), `delete from sessions where token = $1`, c.Value)
	}
	http.SetCookie(w, sessionCookieFor(r, "", time.Time{}))
	writeJSON(w, map[string]any{"ok": true})
}

func me(w http.ResponseWriter, r *http.Request, u *user) {
	writeJSON(w, map[string]any{"id": u.ID, "email": u.Email, "apikey": u.APIKey, "team_member": u.APIKey == nil,
		"base_url": cfg.BaseURL, "ai": cfg.AIKey != "", "smtp": cfg.SMTPAddr != "", "lang": u.Lang,
		"min_report_interval": int(cfg.MinInterval / time.Second)})
}

// setLang saves the user's UI language.
func setLang(w http.ResponseWriter, r *http.Request, u *user) {
	var req struct {
		Lang string `json:"lang"`
	}
	if err := readJSON(r, &req); err != nil || !slices.Contains(langs, req.Lang) {
		httpErr(w, 400, "Неподдерживаемый язык")
		return
	}
	if _, err := db.Exec(r.Context(), `update users set lang = $2 where id = $1`, u.ID, req.Lang); err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func regenAPIKey(w http.ResponseWriter, r *http.Request, u *user) {
	if u.APIKey == nil {
		httpErr(w, 403, "У учётных записей участников команды нет API-ключа")
		return
	}
	k := newAPIKey()
	if _, err := db.Exec(r.Context(), `update users set apikey = $2 where id = $1`, u.ID, k); err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"apikey": k})
}

func changePassword(w http.ResponseWriter, r *http.Request, u *user) {
	var req struct{ Old, New string }
	if err := readJSON(r, &req); err != nil {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	var hash string
	if err := db.QueryRow(r.Context(), `select pwhash from users where id = $1`, u.ID).Scan(&hash); err != nil {
		internalErr(w, err)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Old)) != nil {
		httpErr(w, 400, "Текущий пароль указан неверно")
		return
	}
	c := credentials{Email: u.Email, Password: req.New}
	if err := c.clean(); err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	nh, err := bcrypt.GenerateFromPassword([]byte(req.New), bcrypt.DefaultCost)
	if err != nil {
		internalErr(w, err)
		return
	}
	// other sessions may be someone who knew the old password: end them, keep this one (authed checked the cookie)
	sc, _ := r.Cookie(sessionCookie)
	if _, err := db.Exec(r.Context(), `with p as (update users set pwhash = $2 where id = $1)
		delete from sessions where user_id = $1 and token <> $3`, u.ID, string(nh), sc.Value); err != nil {
		internalErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// deleteMe removes the account; for owners this also removes their servers' data.
func deleteMe(w http.ResponseWriter, r *http.Request, u *user) {
	if _, err := db.Exec(r.Context(), `delete from users where id = $1`, u.ID); err != nil {
		internalErr(w, err)
		return
	}
	http.SetCookie(w, sessionCookieFor(r, "", time.Time{}))
	writeJSON(w, map[string]any{"ok": true})
}

//------------------------------------------------------------------------------
// team sharing

func getShares(w http.ResponseWriter, r *http.Request, s *server) {
	type member struct {
		ID    int64  `json:"id"`
		Email string `json:"email"`
	}
	type invite struct {
		Token string `json:"token"`
		Email string `json:"email"`
		Link  string `json:"link"`
	}
	resp := struct {
		Owner   string   `json:"owner"`
		IsOwner bool     `json:"is_owner"`
		Members []member `json:"members"`
		Invites []invite `json:"invites"`
	}{IsOwner: s.IsOwner, Members: []member{}, Invites: []invite{}}
	ctx := r.Context()
	db.QueryRow(ctx, `select email from users where id = $1`, s.OwnerID).Scan(&resp.Owner)
	rows, _ := db.Query(ctx, `select u.id, u.email from shares sh join users u on u.id = sh.user_id where sh.server_id = $1 order by u.email`, s.ID)
	for rows.Next() {
		var m member
		rows.Scan(&m.ID, &m.Email)
		resp.Members = append(resp.Members, m)
	}
	rows.Close()
	if s.IsOwner { // invite links grant access, only the owner sees them
		rows, _ = db.Query(ctx, `select token, email from invites where server_id = $1 order by created_at`, s.ID)
		for rows.Next() {
			var i invite
			rows.Scan(&i.Token, &i.Email)
			i.Link = cfg.BaseURL + "/#/invite/" + i.Token
			resp.Invites = append(resp.Invites, i)
		}
		rows.Close()
	}
	writeJSON(w, resp)
}

func addShare(w http.ResponseWriter, r *http.Request, s *server) {
	var req struct{ Email string }
	if err := readJSON(r, &req); err != nil {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !validEmail(email) || email == s.User.Email {
		httpErr(w, 400, "Некорректный адрес электронной почты")
		return
	}
	ctx, lang := r.Context(), reqLang(r) // emails are written in the inviter's language
	var uid int64
	if db.QueryRow(ctx, `select id from users where email = $1`, email).Scan(&uid) == nil {
		// existing account: access is granted immediately and a pending invite for it is dropped
		if _, err := db.Exec(ctx, `with d as (delete from invites where server_id = $1 and email = $3)
			insert into shares values ($1,$2) on conflict do nothing`, s.ID, uid, email); err != nil {
			internalErr(w, err)
			return
		}
		mailShare([]string{email, s.User.Email}, trf(lang, "pgscope: вам открыт доступ к серверу «%s»", s.Name),
			trf(lang, "Пользователь %s открыл вам доступ к серверу PostgreSQL «%s» в pgscope.\n\n%s/#/s/%d\n", s.User.Email, s.Name, cfg.BaseURL, s.ID))
		writeJSON(w, map[string]any{"ok": true, "invited": false})
		return
	}
	// one pending invite per email and server: inviting again refreshes it and resends the same link
	var tok string
	if err := db.QueryRow(ctx, `insert into invites(token, server_id, email) values ($1,$2,$3)
		on conflict (server_id, email) do update set created_at = now() returning token`, rand.Text(), s.ID, email).Scan(&tok); err != nil {
		internalErr(w, err)
		return
	}
	link := cfg.BaseURL + "/#/invite/" + tok
	mailShare([]string{email, s.User.Email}, trf(lang, "pgscope: приглашение к серверу «%s»", s.Name),
		trf(lang, "Пользователь %s приглашает вас просматривать сервер PostgreSQL «%s» в pgscope.\n\nПримите приглашение и создайте учётную запись по ссылке:\n%s\n", s.User.Email, s.Name, link))
	writeJSON(w, map[string]any{"ok": true, "invited": true, "link": link})
}

var smtpOffLogged sync.Once

// mailShare sends an access or invitation email in the background. The owner sees the
// result in the UI anyway (member list, invitation link), so failures are only logged.
func mailShare(to []string, subject, body string) {
	if cfg.SMTPAddr == "" {
		smtpOffLogged.Do(func() {
			log.Print("team emails are not sent: SMTP is not configured (PGSCOPE_SMTP_ADDR); pass invitation links on yourself")
		})
		return
	}
	go func() {
		if err := sendMail("en", to, subject, body); err != nil { // "en": the error is for the log
			log.Printf("team email %q to %s not sent: %v", subject, strings.Join(to, ", "), err)
		}
	}()
}

func delShare(w http.ResponseWriter, r *http.Request, s *server) {
	uid, _ := strconv.ParseInt(r.PathValue("uid"), 10, 64)
	db.Exec(r.Context(), `delete from shares where server_id = $1 and user_id = $2`, s.ID, uid)
	writeJSON(w, map[string]any{"ok": true})
}

func delInvite(w http.ResponseWriter, r *http.Request, s *server) {
	db.Exec(r.Context(), `delete from invites where server_id = $1 and token = $2`, s.ID, r.PathValue("token"))
	writeJSON(w, map[string]any{"ok": true})
}

func getInvite(w http.ResponseWriter, r *http.Request) {
	var email, name string
	err := db.QueryRow(r.Context(), `select i.email, s.name from invites i join servers s on s.id = i.server_id where token = $1`,
		r.PathValue("token")).Scan(&email, &name)
	if err != nil {
		httpErr(w, 404, "Приглашение не найдено или уже использовано")
		return
	}
	writeJSON(w, map[string]any{"email": email, "server": name})
}

// acceptInvite creates a team-member account (no API key) and grants access, in one
// transaction: the invite is used up only when the account is created.
func acceptInvite(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req struct{ Password string }
	if err := readJSON(r, &req); err != nil {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		internalErr(w, err)
		return
	}
	defer tx.Rollback(ctx)
	var email string
	var sid int64
	if err := tx.QueryRow(ctx, `delete from invites where token = $1 returning email, server_id`, r.PathValue("token")).Scan(&email, &sid); err != nil {
		httpErr(w, 404, "Приглашение не найдено или уже использовано")
		return
	}
	c := credentials{Email: email, Password: req.Password}
	if err := c.clean(); err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	uid, err := createUser(ctx, tx, c, false)
	if errors.Is(err, errUserExists) {
		httpErr(w, http.StatusConflict, "Учётная запись с этим адресом электронной почты уже существует. Войдите в неё и попросите владельца сервера открыть доступ этой учётной записи.")
		return
	}
	if err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	if _, err := tx.Exec(ctx, `insert into shares values ($1,$2) on conflict do nothing`, sid, uid); err != nil {
		internalErr(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internalErr(w, err)
		return
	}
	if err := startSession(w, r, uid); err != nil {
		log.Print(err)
	}
	writeJSON(w, map[string]any{"ok": true, "server_id": sid})
}
