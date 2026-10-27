// i18ncheck verifies the Go localization: every Russian string literal in the
// main package needs an English entry (registered via registerEN) with the same
// fmt verbs in the same order. Run from the repository root: go run ./tools/i18ncheck
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	cyr   = regexp.MustCompile(`[А-Яа-яЁё]`)
	verbs = regexp.MustCompile(`%[-+# 0]*(\*|\d+)?(\.(\*|\d+))?[a-zA-Z%]`)
)

func verbSeq(s string) string {
	var out []string
	for _, v := range verbs.FindAllString(s, -1) {
		if v != "%%" {
			out = append(out, v[len(v)-1:])
		}
	}
	return strings.Join(out, ",")
}

func main() {
	fset := token.NewFileSet()
	files, _ := filepath.Glob("*.go")
	dict := map[string]string{}
	where := map[string]string{}
	var problems []string
	parsed := map[string]*ast.File{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		af, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		parsed[f] = af
		// dictionary entries: map literals passed to registerEN(...)
		ast.Inspect(af, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) != 1 {
				return true
			}
			if id, ok := call.Fun.(*ast.Ident); !ok || id.Name != "registerEN" {
				return true
			}
			lit, ok := call.Args[0].(*ast.CompositeLit)
			if !ok {
				return true
			}
			for _, e := range lit.Elts {
				kv, ok := e.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				k, kerr := strconv.Unquote(kv.Key.(*ast.BasicLit).Value)
				v, verr := strconv.Unquote(kv.Value.(*ast.BasicLit).Value)
				pos := fset.Position(kv.Pos()).String()
				if kerr != nil || verr != nil {
					problems = append(problems, pos+": dictionary entries must be plain string literals")
					continue
				}
				if old, dup := dict[k]; dup && old != v {
					problems = append(problems, fmt.Sprintf("%s: %q translated differently at %s", pos, k, where[k]))
				}
				if cyr.MatchString(v) {
					problems = append(problems, fmt.Sprintf("%s: English for %q contains Cyrillic", pos, k))
				}
				if verbSeq(k) != verbSeq(v) {
					problems = append(problems, fmt.Sprintf("%s: fmt verbs differ: %q vs %q", pos, k, v))
				}
				dict[k], where[k] = v, pos
			}
			return false
		})
	}
	used := map[string]bool{}
	for _, af := range parsed {
		ast.Inspect(af, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "registerEN" {
					return false // dictionary itself
				}
			}
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			s, err := strconv.Unquote(lit.Value)
			if err != nil || !cyr.MatchString(s) {
				return true
			}
			used[s] = true
			if _, ok := dict[s]; !ok {
				problems = append(problems, fmt.Sprintf("%s: no English translation for %q", fset.Position(lit.Pos()), s))
			}

			return true
		})
	}
	var unused []string
	for k := range dict {
		if !used[k] {
			unused = append(unused, k)
		}
	}
	sort.Strings(unused)
	sort.Strings(problems)
	if len(unused) > 0 {
		fmt.Printf("note: %d dictionary keys are not used as literals (fine if built dynamically): %q\n", len(unused), unused[:min(len(unused), 15)])
	}
	if len(problems) > 0 {
		fmt.Println(strings.Join(problems, "\n"))
		fmt.Printf("\n%d i18n problems\n", len(problems))
		os.Exit(1)
	}
	fmt.Printf("i18n OK: %d English entries\n", len(dict))
}
