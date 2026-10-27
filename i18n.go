package main

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Russian is the source language: user-facing strings in the Go code are Russian
// and double as keys of the English dictionaries registered by i18n_en_*.go.
// tools/i18ncheck verifies that every Russian literal has a translation.

var enDict = map[string]string{}

// registerEN is called from init() of the i18n_en_*.go files.
func registerEN(m map[string]string) {
	for k, v := range m {
		enDict[k] = v
	}
}

var langs = []string{"ru", "en"}

func normLang(s string) string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(s)), "en") {
		return "en"
	}
	return "ru"
}

// reqLang is the language of a request; the web UI sends Accept-Language: ru|en.
func reqLang(r *http.Request) string { return normLang(r.Header.Get("Accept-Language")) }

func tr(lang, s string) string {
	if lang == "en" {
		if v, ok := enDict[s]; ok {
			return v
		}
	}
	return s
}

func trf(lang, format string, args ...any) string { return fmt.Sprintf(tr(lang, format), args...) }

// langWriter carries the request language, so httpErr translates its message.
type langWriter struct {
	http.ResponseWriter
	lang string
}

func withLang(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(&langWriter{w, reqLang(r)}, r)
	})
}

func writerLang(w http.ResponseWriter) string {
	if lw, ok := w.(*langWriter); ok {
		return lw.lang
	}
	return "ru"
}

//------------------------------------------------------------------------------
// formatting of values inside user-facing texts

// dec formats v with the language's decimal separator and no trailing zeros.
func dec(lang string, v float64, digits int) string {
	s := strconv.FormatFloat(v, 'f', digits, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if lang == "en" {
		return s
	}
	return strings.Replace(s, ".", ",", 1)
}

func fmtBytes(lang string, b float64) string {
	units := []string{"Б", "КиБ", "МиБ", "ГиБ", "ТиБ", "ПиБ"}
	i := 0
	for math.Abs(b) >= 1024 && i < len(units)-1 {
		b /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%.0f %s", b, tr(lang, units[0]))
	}
	return dec(lang, b, 1) + " " + tr(lang, units[i])
}

func fmtSecs(lang string, s float64) string {
	if math.IsInf(s, 1) {
		return tr(lang, "никогда")
	}
	d := time.Duration(s) * time.Second
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%.0f %s", s, tr(lang, "с"))
	case d < time.Hour:
		return fmt.Sprintf("%d %s", int(d.Minutes()), tr(lang, "мин"))
	case d < 48*time.Hour:
		return dec(lang, d.Hours(), 1) + " " + tr(lang, "ч")
	}
	return dec(lang, d.Hours()/24, 1) + " " + tr(lang, "д")
}

func fmtUnit(lang, unit string, v float64) string {
	switch unit {
	case "bytes":
		return fmtBytes(lang, v)
	case "secs":
		return fmtSecs(lang, v)
	case "ms":
		if v >= 1000 {
			return fmtSecs(lang, v/1000)
		}
		return dec(lang, v, 1) + " " + tr(lang, "мс")
	case "pct":
		return dec(lang, v, 1) + "%"
	}
	return dec(lang, v, 3)
}

func init() {
	registerEN(map[string]string{
		"Б": "B", "КиБ": "KiB", "МиБ": "MiB", "ГиБ": "GiB", "ТиБ": "TiB", "ПиБ": "PiB",
		"мс": "ms", "с": "s", "мин": "min", "ч": "h", "д": "d", "никогда": "never",
	})
}
