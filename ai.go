package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/shared/constant"
	"github.com/rapidloop/pgmetrics"
)

// chatSystem is the system prompt, Russian source; chatPrompt gives it in the UI
// language, whose last line makes the model answer in that language unless the
// user writes in another one.
var chatSystem = []string{
	"Ты — эксперт по PostgreSQL, встроенный в pgscope (инструмент мониторинга PostgreSQL).",
	"Отвечай на вопросы о наблюдаемом сервере, опираясь на данные отчёта ниже, собранные pgmetrics.",
	"Будь конкретен: приводи числа и имена объектов из данных. Предлагая изменения SQL или конфигурации, объясняй их плюсы и минусы.",
	"Если в данных нет ответа, прямо скажи об этом.",
	"Отвечай на русском языке; если пользователь пишет на другом языке, отвечай на его языке.",
}

func chatPrompt(lang string) string {
	lines := make([]string, len(chatSystem))
	for i, s := range chatSystem {
		lines[i] = tr(lang, s)
	}
	return strings.Join(lines, "\n")
}

// chat answers a question about the server using its latest report.
// The browser keeps the conversation and sends the whole history each time.
func chat(w http.ResponseWriter, r *http.Request, s *server) {
	if cfg.AIKey == "" {
		httpErr(w, 501, "AI-чат не настроен: укажите API-ключ Anthropic в PGSCOPE_AI_KEY")
		return
	}
	var req struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := readJSON(r, &req); err != nil || len(req.Messages) == 0 || len(req.Messages) > 50 {
		httpErr(w, 400, "Некорректный запрос")
		return
	}
	msgs := make([]anthropic.BetaMessageParam, 0, len(req.Messages))
	for i, m := range req.Messages {
		role := anthropic.BetaMessageParamRoleUser
		if i%2 == 1 {
			role = anthropic.BetaMessageParamRoleAssistant
		}
		if string(role) != m.Role || strings.TrimSpace(m.Content) == "" {
			httpErr(w, 400, "Сообщения пользователя и ассистента должны чередоваться, начиная с сообщения пользователя")
			return
		}
		msgs = append(msgs, anthropic.BetaMessageParam{Role: role, Content: []anthropic.BetaContentBlockParamUnion{anthropic.NewBetaTextBlock(m.Content)}})
	}
	if len(msgs)%2 == 0 {
		httpErr(w, 400, "Последнее сообщение должно быть от пользователя")
		return
	}
	m, err := loadModel(r.Context(), s.ID, "", 0)
	if err != nil {
		httpErr(w, 404, "Отчётов пока нет")
		return
	}
	reply, err := askClaude(r, aiContext(s.Name, m, reqLang(r)), msgs)
	if err != nil {
		log.Print("ai chat: ", err)
		httpErr(w, 502, err.Error())
		return
	}
	writeJSON(w, map[string]string{"reply": reply})
}

// askClaude's errors and notes are in the request language.
func askClaude(r *http.Request, context string, msgs []anthropic.BetaMessageParam) (string, error) {
	lang := reqLang(r)
	opts := []option.RequestOption{option.WithAPIKey(cfg.AIKey)}
	if cfg.AIBaseURL != "" {
		opts = append(opts, option.WithBaseURL(cfg.AIBaseURL))
	}
	client := anthropic.NewClient(opts...)
	model := cfg.AIModel
	if model == "" {
		model = "claude-opus-5-5"
	}
	resp, err := client.Beta.Messages.New(r.Context(), anthropic.BetaMessageNewParams{
		Model:     model,
		MaxTokens: 16000,
		// the report context is identical for every turn of a conversation: cache it
		System: []anthropic.BetaTextBlockParam{{Text: chatPrompt(lang) + "\n\n<report>\n" + context + "\n</report>",
			CacheControl: anthropic.NewBetaCacheControlEphemeralParam()}},
		Messages:     msgs,
		OutputConfig: anthropic.BetaOutputConfigParam{Effort: anthropic.BetaOutputConfigEffortMedium},
		// if a safety classifier declines, let the API re-serve the request on a fallback model
		Fallbacks: anthropic.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()},
		Betas:     []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
	})
	if err != nil {
		var apierr *anthropic.Error
		if errors.As(err, &apierr) {
			return "", errors.New(trf(lang, "AI-провайдер вернул HTTP %d", apierr.StatusCode))
		}
		log.Print("ai request: ", err)
		return "", errors.New(tr(lang, "Не удалось связаться с AI-провайдером"))
	}
	if resp.StopReason == anthropic.BetaStopReasonRefusal {
		return "", errors.New(tr(lang, "AI-модель отказалась отвечать на этот вопрос"))
	}
	var out strings.Builder
	for _, b := range resp.Content {
		if t, ok := b.AsAny().(anthropic.BetaTextBlock); ok {
			out.WriteString(t.Text)
		}
	}
	if resp.StopReason == anthropic.BetaStopReasonMaxTokens {
		out.WriteString("\n\n" + tr(lang, "(ответ обрезан)"))
	}
	return out.String(), nil
}

// aiContext condenses a report into the facts most questions need; texts are in lang.
func aiContext(name string, m *pgmetrics.Model, lang string) string {
	top := func(n int, less func(i, j int) bool, size int) []int {
		idx := make([]int, size)
		for i := range idx {
			idx[i] = i
		}
		sort.Slice(idx, func(a, b int) bool { return less(idx[a], idx[b]) })
		if len(idx) > n {
			idx = idx[:n]
		}
		return idx
	}
	ctx := map[string]any{
		"server": name, "collected_at": time.Unix(m.Metadata.At, 0).UTC().Format(time.RFC3339),
		"version": m.FullVersion, "started": time.Unix(m.StartTime, 0).UTC().Format(time.RFC3339),
		"in_recovery": m.IsInRecovery, "system_identifier": m.SystemIdentifier, "timeline": m.TimelineID,
		"wal_files": m.WALCount, "wal_ready_for_archive": m.WALReadyCount, "wal_archiving": m.WALArchiving,
		"bgwriter": m.BGWriter, "checkpointer": m.Checkpointer, "wal_stats": m.WAL, "system": m.System,
		"tablespaces": m.Tablespaces, "databases": m.Databases, "replication_outgoing": m.ReplicationOutgoing,
		"replication_incoming": m.ReplicationIncoming, "replication_slots": m.ReplicationSlots,
		"backend_type_counts": m.BackendTypeCounts, "diagnostics": diagnose(m, lang), "config_check": configCheck(m, lang),
		"extensions": m.Extensions, "roles": m.Roles, "vacuum_in_progress": m.VacuumProgress, "rds": m.RDS,
	}
	set := map[string]string{}
	for k, v := range m.Settings {
		if v.Source != "default" {
			set[k] = settingStr(m, k, lang)
		}
	}
	ctx["non_default_settings"] = set

	var tables []pgmetrics.Table
	for _, i := range top(40, func(a, b int) bool { return m.Tables[a].Size > m.Tables[b].Size }, len(m.Tables)) {
		tables = append(tables, m.Tables[i])
	}
	ctx["largest_tables"] = tables
	var idx []pgmetrics.Index
	for _, i := range top(40, func(a, b int) bool { return m.Indexes[a].Size > m.Indexes[b].Size }, len(m.Indexes)) {
		idx = append(idx, m.Indexes[i])
	}
	ctx["largest_indexes"] = idx
	var stmts []map[string]any
	for _, i := range top(25, func(a, b int) bool { return m.Statements[a].TotalTime > m.Statements[b].TotalTime }, len(m.Statements)) {
		q := m.Statements[i]
		stmts = append(stmts, map[string]any{"db": q.DBName, "user": q.UserName, "query": q.Query, "calls": q.Calls,
			"total_ms": q.TotalTime, "mean_ms": ratio(q.TotalTime, f(q.Calls)), "max_ms": q.MaxTime, "rows": q.Rows,
			"shared_hit": q.SharedBlksHit, "shared_read": q.SharedBlksRead, "temp_written": q.TempBlksWritten})
	}
	ctx["top_queries_by_total_time"] = stmts
	var backends []pgmetrics.Backend
	for _, b := range m.Backends {
		if b.State != "idle" && b.State != "" {
			backends = append(backends, b)
		}
	}
	if len(backends) > 60 {
		backends = backends[:60]
	}
	ctx["non_idle_backends"], ctx["total_backends"] = backends, len(m.Backends)
	var waiting []pgmetrics.Lock
	for _, l := range m.Locks {
		if !l.Granted {
			waiting = append(waiting, l)
		}
	}
	ctx["ungranted_locks"], ctx["blocking_pids"] = waiting, m.BlockingPIDs
	b, _ := json.Marshal(ctx)
	return string(b)
}
