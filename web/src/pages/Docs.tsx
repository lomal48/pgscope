import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Menu, Moon, Search, Sun, X } from 'lucide-react'
import { Marked } from 'marked'
import { DOC_GROUPS } from '../docs'
import { LangSwitch, Logo, useTheme } from '../components/Layout'
import { cx } from '../components/ui'
import { lang, t, tk, useLang } from '../lib/i18n'
import { go, match } from '../lib/router'

const files = import.meta.glob<string>('../docs/*/*.md', { query: '?raw', import: 'default', eager: true })
const SLUGS = DOC_GROUPS.flatMap(([, s]) => s)

type Doc = { slug: string; title: string; md: string; heads: { depth: number; text: string; id: string }[] }
type Hit = { slug: string; page: string; id?: string; title: string; text: string }

// inline markdown -> plain text for titles, the table of contents and search
const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '')
const HEAD = /^(#{2,3}) (.+?) \{#([\w-]+)\}\s*$/

function load(slug: string): Doc {
  const md = files[`../docs/${lang}/${slug}.md`] ?? files[`../docs/ru/${slug}.md`] ?? ''
  const heads = md.split('\n').flatMap(l => {
    const m = l.match(HEAD)
    return m ? [{ depth: m[1].length, text: plain(m[2]), id: m[3] }] : []
  })
  return { slug, title: plain(md.match(/^# (.+)$/m)?.[1] ?? slug), md, heads }
}

const marked = new Marked({ gfm: true })
const CALLOUTS: Record<string, string> = {
  NOTE: tk('Примечание'), TIP: tk('Совет'), IMPORTANT: tk('Важно'), WARNING: tk('Внимание'), CAUTION: tk('Осторожно'),
}

// the markdown is our own, bundled at build time; links become hash routes
function render(d: Doc): string {
  const to = (s: string, a?: string) => `#/docs/${s}${a ? '/' + a : ''}`
  return (marked.parse(d.md.replace(/^# .+\n/m, ''), { async: false }) as string)
    .replace(/<h([234])>(.*?)\s*\{#([\w-]+)\}<\/h\1>/g, (_, n, text, id) => `<h${n} id="${id}">${text}<a class="doc-anchor" href="${to(d.slug, id)}" aria-hidden="true">#</a></h${n}>`)
    .replace(/href="([\w-]+)\.md(?:#([\w-]+))?"/g, (_, s, a) => `href="${to(s, a)}"`)
    .replace(/href="#([\w-]+)"/g, (_, a) => `href="${to(d.slug, a)}"`)
    .replace(/<a href="(https?:[^"]+)"/g, '<a href="$1" target="_blank" rel="noreferrer"')
    .replace(/<blockquote>\s*<p>\[!(\w+)\]\s*/g, (_, k) => `<blockquote class="callout callout-${k.toLowerCase()}"><p class="callout-title">${t(CALLOUTS[k] ?? k)}</p><p>`)
    .replace(/<table>/g, '<div class="doc-table"><table>').replace(/<\/table>/g, '</table></div>')
    .replace(/<pre>/g, `<pre><button type="button" class="doc-copy" data-copy>${t('Копировать')}</button>`)
}

function sections(d: Doc): Hit[] {
  const out: Hit[] = []
  let cur: Hit = { slug: d.slug, page: d.title, title: d.title, text: '' }
  for (const l of d.md.split('\n').slice(1)) {
    const m = l.match(HEAD)
    if (m) {
      out.push(cur)
      cur = { slug: d.slug, page: d.title, id: m[3], title: plain(m[2]), text: '' }
    } else cur.text += ' ' + plain(l).replace(/[|>#]|\[!\w+\]/g, ' ')
  }
  out.push(cur)
  return out.map(h => ({ ...h, text: h.text.replace(/\s+/g, ' ').trim() }))
}

// case- and diaeresis-insensitive (ё = е); keeps the string length, so offsets match the original
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\u0308/g, '').normalize('NFC')

function search(q: string, all: Hit[]): [Hit, string[]][] {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return all
    .map(h => {
      const ti = fold(h.title), tx = fold(h.text)
      return words.every(w => ti.includes(w) || tx.includes(w)) ? [words.filter(w => ti.includes(w)).length, h] as const : null
    })
    .filter(x => x !== null)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 12)
    .map(([, h]) => [h, words])
}

// a piece of text around the first match, with matches highlighted
function snippet(text: string, words: string[]): ReactNode[] {
  const f = fold(text)
  const at = Math.min(...words.map(w => f.indexOf(w)).filter(i => i >= 0), text.length)
  const from = Math.max(0, at - 50), to = from + 150
  const re = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  const out: ReactNode[] = [from ? '…' : '']
  let i = from
  for (const m of f.slice(from, to).matchAll(re)) {
    const a = from + m.index
    out.push(text.slice(i, a), <mark key={a} className="bg-accent/20 text-fg rounded-sm">{text.slice(a, a + m[0].length)}</mark>)
    i = a + m[0].length
  }
  out.push(text.slice(i, to), to < text.length ? '…' : '')
  return out
}

export function Docs({ path, signedIn }: { path: string; signedIn: boolean }) {
  const l = useLang()
  const [dark, toggleTheme] = useTheme()
  const m = match('/docs/:page/:anchor', path) ?? match('/docs/:page', path)
  const slug = m && SLUGS.includes(m.page) ? m.page : SLUGS[0]
  const anchor = m?.anchor
  const docs = useMemo(() => SLUGS.map(load), [l])
  const all = useMemo(() => docs.flatMap(sections), [docs])
  const i = SLUGS.indexOf(slug)
  const doc = docs[i]
  const html = useMemo(() => render(doc), [doc])
  const group = DOC_GROUPS.find(([, s]) => s.includes(slug))![0]
  const [q, setQ] = useState('')
  const hits = useMemo(() => search(q, all), [q, all])
  const [menu, setMenu] = useState(false)
  const main = useRef<HTMLElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMenu(false)
    setQ('')
    const el = anchor && document.getElementById(anchor)
    if (el) el.scrollIntoView()
    else main.current?.scrollTo(0, 0)
  }, [slug, anchor, l])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [])

  const copy = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]')
    const code = b?.parentElement?.querySelector('code')?.textContent
    if (!b || code == null) return
    navigator.clipboard.writeText(code).then(() => {
      b.textContent = t('Скопировано')
      setTimeout(() => (b.textContent = t('Копировать')), 1200)
    })
  }

  const nav = (
    <nav className="px-3 py-4 space-y-5">
      {DOC_GROUPS.map(([g, slugs]) => (
        <div key={g}>
          <div className="px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{t(g)}</div>
          {slugs.map(s => (
            <a key={s} href={'#/docs/' + s} className={cx('nav-item h-auto py-1.5 leading-snug', s === slug && 'active')}>
              {docs[SLUGS.indexOf(s)].title}
            </a>
          ))}
        </div>
      ))}
    </nav>
  )
  const prev = docs[i - 1], next = docs[i + 1]

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 shrink-0 flex items-center gap-3 px-3 sm:px-4 border-b border-line bg-panel">
        <button className="btn btn-ghost btn-sm lg:hidden" onClick={() => setMenu(!menu)} aria-label={t('Меню')}>
          {menu ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
        <Logo />
        <span className="hidden sm:inline-flex items-center gap-1.5 text-[13px] text-muted"><BookOpen className="size-4" />{t('Документация')}</span>
        <div className="relative flex-1 max-w-md mx-auto">
          <Search className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input ref={input} className="input w-full pl-8" value={q} placeholder={t('Поиск по документации')} aria-label={t('Поиск по документации')}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') setQ('')
              if (e.key === 'Enter' && hits[0]) go(`/docs/${hits[0][0].slug}${hits[0][0].id ? '/' + hits[0][0].id : ''}`)
            }} />
          {q.trim() && (
            <div className="absolute z-50 top-10 left-0 right-0 min-w-72 card shadow-xl max-h-[70vh] overflow-y-auto p-1.5">
              {hits.length === 0 && <div className="px-3 py-6 text-center text-muted text-[13px]">{t('Ничего не найдено')}</div>}
              {hits.map(([h, words]) => (
                <a key={h.slug + (h.id ?? '')} href={`#/docs/${h.slug}${h.id ? '/' + h.id : ''}`} className="block rounded-lg px-3 py-2 hover:bg-panel-2">
                  <div className="text-[11px] text-faint">{h.page}</div>
                  <div className="font-medium text-[13px]">{h.title}</div>
                  {h.text && <div className="text-xs text-muted mt-0.5 line-clamp-2">{snippet(h.text, words)}</div>}
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="hidden md:block"><LangSwitch persist={signedIn} /></div>
        <button className="btn btn-ghost btn-sm" onClick={toggleTheme} title={dark ? t('Светлая тема') : t('Тёмная тема')}>
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
        <a className="btn btn-sm hidden sm:inline-flex" href="#/">{signedIn ? t('К приложению') : t('Войти')}</a>
      </header>

      <div className="flex-1 min-h-0 flex relative">
        <aside className="hidden lg:block w-64 shrink-0 border-r border-line bg-panel overflow-y-auto">{nav}</aside>
        {menu && (
          <div className="fixed inset-0 top-14 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setMenu(false)} />
            <aside className="absolute inset-y-0 left-0 w-72 bg-panel border-r border-line overflow-y-auto">
              <div className="px-5 pt-4 md:hidden"><LangSwitch persist={signedIn} /></div>
              {nav}
            </aside>
          </div>
        )}
        <main ref={main} className="flex-1 min-w-0 overflow-y-auto" onClick={copy}>
          <div className="flex gap-10 px-4 sm:px-8 lg:px-12 py-8 max-w-[1180px]">
            <article className="min-w-0 flex-1 max-w-3xl">
              <div className="text-xs font-medium text-accent mb-2">{t(group)}</div>
              <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{doc.title}</h1>
              <div className="doc mt-5" dangerouslySetInnerHTML={{ __html: html }} />
              <div className="grid sm:grid-cols-2 gap-3 mt-12 pt-6 border-t border-line">
                {prev ? (
                  <a href={'#/docs/' + prev.slug} className="card px-4 py-3 hover:border-accent/50 transition-colors">
                    <div className="text-xs text-faint flex items-center gap-1"><ArrowLeft className="size-3" />{t('Предыдущая')}</div>
                    <div className="font-medium mt-0.5">{prev.title}</div>
                  </a>
                ) : <div />}
                {next && (
                  <a href={'#/docs/' + next.slug} className="card px-4 py-3 text-right hover:border-accent/50 transition-colors">
                    <div className="text-xs text-faint flex items-center justify-end gap-1">{t('Следующая')}<ArrowRight className="size-3" /></div>
                    <div className="font-medium mt-0.5">{next.title}</div>
                  </a>
                )}
              </div>
            </article>
            {doc.heads.length > 1 && (
              <aside className="hidden xl:block w-56 shrink-0">
                <div className="sticky top-0">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-faint mb-2">{t('На этой странице')}</div>
                  <ul className="space-y-1 text-[12.5px] border-l border-line">
                    {doc.heads.map(h => (
                      <li key={h.id}>
                        <a href={`#/docs/${slug}/${h.id}`}
                          className={cx('block -ml-px border-l py-0.5 leading-snug hover:text-fg', h.depth === 3 ? 'pl-6' : 'pl-3',
                            h.id === anchor ? 'border-accent text-accent' : 'border-transparent text-muted')}>
                          {h.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
