import { useEffect, useState } from 'react'
import { en } from '../i18n/en'

// Russian is the source language: UI strings are written in Russian and double as
// keys of the English dictionary (src/i18n/en/*.json). Add a language by adding a
// dictionary and an entry to LANGS.
export type Lang = 'ru' | 'en'
export const LANGS: [Lang, string][] = [['ru', 'Русский'], ['en', 'English']]

const isLang = (s: unknown): s is Lang => s === 'ru' || s === 'en'

function initial(): Lang {
  try {
    const s = localStorage.getItem('lang')
    if (isLang(s)) return s
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

export let lang: Lang = initial()
document.documentElement.lang = lang

const listeners = new Set<() => void>()

export function setLang(l: string) {
  if (!isLang(l) || l === lang) return
  lang = l
  document.documentElement.lang = l
  try {
    localStorage.setItem('lang', l)
  } catch {
    /* storage unavailable */
  }
  listeners.forEach(f => f())
}

export function onLangChange(f: () => void) {
  listeners.add(f)
  return () => {
    listeners.delete(f)
  }
}

const warned = new Set<string>()

// t('Отчёт {ago}', { ago }) — translate and fill {placeholders}
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = s
  if (lang === 'en') {
    const v = en[s]
    if (v != null) out = v
    else if (import.meta.env.DEV && !warned.has(s)) {
      warned.add(s)
      console.warn('i18n: no English for', JSON.stringify(s))
    }
  }
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : out
}

// tk marks a string for translation where t() is applied later, at render time
export const tk = (s: string) => s

// plural(5, ['строка', 'строки', 'строк']) -> 'строк' (English: 'row|rows' in the dictionary)
export function plural(n: number, forms: [string, string, string]): string {
  if (lang === 'en') {
    const e = en[forms.join('|')]
    if (e) {
      const [one, other] = e.split('|')
      return Math.abs(n) === 1 ? one : other
    }
  }
  const a = Math.abs(n) % 100, b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

// re-render the calling component (use it at the root) when the language changes
export function useLang(): Lang {
  const [, force] = useState(0)
  useEffect(() => onLangChange(() => force(x => x + 1)), [])
  return lang
}
