// Checks UI localization: every Russian text in src must go through t()/tk()/plural()
// and have an English translation with the same {placeholders}.
// Usage: node scripts/i18n-check.mjs [file...]   (no args = whole src)
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')
const src = path.join(root, 'src')
const dictDir = path.join(src, 'i18n', 'en')
const CYR = /[А-Яа-яЁё]/
const errors = []
const err = (file, node, sf, msg) => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  errors.push(`${path.relative(root, file)}:${line + 1}: ${msg}`)
}

// merged dictionary + conflicts between files
const dict = {}
const from = {}
for (const f of fs.readdirSync(dictDir).filter(f => f.endsWith('.json'))) {
  let d
  try {
    d = JSON.parse(fs.readFileSync(path.join(dictDir, f), 'utf8'))
  } catch (e) {
    errors.push(`src/i18n/en/${f}: invalid JSON: ${e.message}`)
    continue
  }
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'string') errors.push(`src/i18n/en/${f}: value of ${JSON.stringify(k)} is not a string`)
    else if (k in dict && dict[k] !== v) errors.push(`src/i18n/en/${f}: ${JSON.stringify(k)} = ${JSON.stringify(v)} conflicts with ${from[k]} (${JSON.stringify(dict[k])})`)
    else if (CYR.test(v) && v !== k) errors.push(`src/i18n/en/${f}: English for ${JSON.stringify(k)} contains Cyrillic: ${JSON.stringify(v)}`)
    dict[k] = v
    from[k] ??= f
  }
}

const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
const used = new Set()

function checkKey(file, node, sf, key) {
  used.add(key)
  if (!(key in dict)) return err(file, node, sf, `no English translation for ${JSON.stringify(key)}`)
  if (placeholders(key) !== placeholders(dict[key])) err(file, node, sf, `placeholders differ: ${JSON.stringify(key)} vs ${JSON.stringify(dict[key])}`)
}

const calleeName = call => (ts.isIdentifier(call.expression) ? call.expression.text : '')

function visit(file, sf, node) {
  if (ts.isJsxText(node) && CYR.test(node.text)) {
    err(file, node, sf, `JSX text must use {t(...)}: ${JSON.stringify(node.text.trim())}`)
  } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CYR.test(node.text)) {
    const p = node.parent
    if (ts.isCallExpression(p) && ['t', 'tk'].includes(calleeName(p)) && p.arguments[0] === node) {
      checkKey(file, node, sf, node.text)
    } else if (ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && calleeName(p.parent) === 'plural' && p.parent.arguments[1] === p) {
      if (p.elements[0] === node) {
        const forms = p.elements.map(e => (ts.isStringLiteral(e) ? e.text : '?'))
        const key = forms.join('|')
        used.add(key)
        if (forms.length !== 3) err(file, node, sf, `plural() needs three Russian forms`)
        else if (!(key in dict)) err(file, node, sf, `no English plural for ${JSON.stringify(key)} (expected "one|other")`)
        else if (dict[key].split('|').length !== 2) err(file, node, sf, `English plural for ${JSON.stringify(key)} must be "one|other"`)
      }
    } else {
      err(file, node, sf, `Russian text outside t()/tk()/plural(): ${JSON.stringify(node.text)}`)
    }
  } else if (ts.isStringLiteral(node) && node.text in dict && ts.isCallExpression(node.parent) && ['t', 'tk'].includes(calleeName(node.parent)) && node.parent.arguments[0] === node) {
    checkKey(file, node, sf, node.text) // non-Cyrillic key with a dictionary entry, e.g. '{match} «{text}»'
  } else if (ts.isTemplateExpression(node) && [node.head, ...node.templateSpans.map(s => s.literal)].some(x => CYR.test(x.text))) {
    err(file, node, sf, `Russian text in a template literal; use t('... {x}', { x }) instead`)
  }
  ts.forEachChild(node, n => visit(file, sf, n))
}

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name)
  if (e.isDirectory()) return p === path.join(src, 'i18n') ? [] : walk(p)
  return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
})

const only = process.argv.slice(2).map(f => path.resolve(f))
const files = walk(src).filter(f => f !== path.join(src, 'lib', 'i18n.ts'))
for (const file of files) {
  if (only.length && !only.includes(file)) continue
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  visit(file, sf, sf)
}

if (!only.length) {
  const unused = Object.keys(dict).filter(k => !used.has(k) && !['Русский', 'English'].includes(k))
  if (unused.length) console.log(`note: ${unused.length} unused dictionary keys: ${unused.slice(0, 20).map(k => JSON.stringify(k)).join(', ')}${unused.length > 20 ? ' …' : ''}`)
}
// documentation: src/docs/<lang>/<slug>.md — one H1, every ##/### with an explicit {#anchor},
// the same pages and anchors in every language, links to existing pages and anchors only
const docsDir = path.join(src, 'docs')
const docs = {}
let docPages = 0
if (!only.length && fs.existsSync(docsDir)) {
  const indexSlugs = [...fs.readFileSync(path.join(docsDir, 'index.ts'), 'utf8').matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1])
  const langs = fs.readdirSync(docsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  for (const l of langs) {
    docs[l] = {}
    for (const f of fs.readdirSync(path.join(docsDir, l)).filter(f => f.endsWith('.md'))) {
      const rel = `src/docs/${l}/${f}`
      const page = { anchors: new Set(), links: [], rel }
      docs[l][f.slice(0, -3)] = page
      let fence = false
      let h1 = 0
      fs.readFileSync(path.join(docsDir, l, f), 'utf8').split('\n').forEach((line, i) => {
        const at = `${rel}:${i + 1}`
        if (/^\s*(```|~~~)/.test(line)) {
          if (!fence && /^\s*(```|~~~)\s*$/.test(line)) errors.push(`${at}: code block without a language`)
          fence = !fence
          return
        }
        if (fence) return
        const text = line.replace(/`[^`]*`/g, '')
        if (/^# /.test(line)) h1++
        const h = line.match(/^(#{2,3}) /)
        if (h) {
          const a = line.match(/ \{#([a-z0-9-]+)\}\s*$/)
          if (!a) errors.push(`${at}: heading without {#anchor}: ${line}`)
          else if (page.anchors.has(a[1])) errors.push(`${at}: duplicate anchor #${a[1]}`)
          else page.anchors.add(a[1])
        }
        if (/<[A-Za-zА-Яа-яЁё\/!]/.test(text)) errors.push(`${at}: raw HTML or <placeholder> outside backticks (it would be swallowed): ${line.trim()}`)
        for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) page.links.push([at, m[1]])
      })
      if (h1 !== 1) errors.push(`${rel}: needs exactly one "# Title", found ${h1}`)
      if (!indexSlugs.includes(f.slice(0, -3))) errors.push(`${rel}: page is not listed in src/docs/index.ts`)
      docPages++
    }
    for (const s of indexSlugs) if (!docs[l][s]) errors.push(`src/docs/${l}/${s}.md: missing (listed in src/docs/index.ts)`)
  }
  for (const [l, pages] of Object.entries(docs)) {
    for (const [slug, p] of Object.entries(pages)) {
      for (const [at, href] of p.links) {
        if (/^(https?:|mailto:)/.test(href)) continue
        const m = href.match(/^(?:([a-z0-9-]+)\.md)?(?:#([a-z0-9-]+))?$/)
        const target = m && pages[m[1] ?? slug]
        if (!m || !href || !target) errors.push(`${at}: broken link ${href}`)
        else if (m[2] && !target.anchors.has(m[2])) errors.push(`${at}: no anchor #${m[2]} in ${m[1] ?? slug}.md`)
      }
      for (const [l2, pages2] of Object.entries(docs)) {
        const o = pages2[slug]
        if (l2 === l || !o) continue
        const miss = [...p.anchors].filter(a => !o.anchors.has(a))
        if (miss.length) errors.push(`${o.rel}: anchors missing compared to ${p.rel}: ${miss.join(', ')}`)
      }
    }
  }
}

if (errors.length) {
  console.log(errors.join('\n'))
  console.log(`\n${errors.length} i18n problems`)
  process.exit(1)
}
console.log(`i18n OK: ${files.length} files, ${Object.keys(dict).length} English entries, ${docPages} documentation pages`)
