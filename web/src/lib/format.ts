import { useEffect, useState } from 'react'
import { lang, onLangChange, t } from './i18n'

export { plural } from './i18n'

const localeFor = () => (lang === 'en' ? 'en-US' : 'ru-RU')
// live binding: importers always see the locale of the current language
export let LOCALE = localeFor()
let nf = new Intl.NumberFormat(LOCALE)
onLangChange(() => {
  LOCALE = localeFor()
  nf = new Intl.NumberFormat(LOCALE)
})

// time zone of every shown date and time (live binding): the one saved in the profile, else the browser's
export const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
export let TZ = BROWSER_TZ
const tzListeners = new Set<() => void>()

// knownTZ: whether this browser can show times in zone z (the server accepts names some browsers do not know)
export function knownTZ(z: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: z })
    return true
  } catch {
    return false
  }
}

// setTZ switches the zone; null, '' or a name this browser does not know = the browser's zone
export function setTZ(z: string | null | undefined) {
  const next = z && knownTZ(z) ? z : BROWSER_TZ
  if (next === TZ) return
  TZ = next
  tzListeners.forEach(f => f())
}

// re-render the calling component (use it at the root) when the time zone changes
export function useTZ(): string {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force(x => x + 1)
    tzListeners.add(f)
    return () => {
      tzListeners.delete(f)
    }
  }, [])
  return TZ
}

const units = () => [t('Б'), t('КиБ'), t('МиБ'), t('ГиБ'), t('ТиБ'), t('ПиБ')]

// fmtDec formats with the locale's decimal separator; trailing zeros are dropped unless fixed is set
export function fmtDec(n: number, digits = 1, fixed = false): string {
  return n.toLocaleString(LOCALE, { minimumFractionDigits: fixed ? digits : 0, maximumFractionDigits: digits })
}

export function fmtBytes(b: number | null | undefined, digits = 1): string {
  if (b == null || isNaN(b)) return '—'
  if (b < 0) return '—'
  const u = units()
  let i = 0
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024
    i++
  }
  return i === 0 ? `${Math.round(b)} ${u[0]}` : `${fmtDec(b, b >= 100 ? 0 : digits)} ${u[i]}`
}

export const fmtInt = (n: number | null | undefined) => (n == null || isNaN(n) ? '—' : nf.format(Math.round(n)))

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n == null || isNaN(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return fmtDec(n / 1e9, digits) + ' ' + t('млрд')
  if (a >= 1e6) return fmtDec(n / 1e6, digits) + ' ' + t('млн')
  if (a >= 1e4) return fmtDec(n / 1e3, digits) + ' ' + t('тыс.')
  if (a >= 100 || Number.isInteger(n)) return nf.format(Math.round(n))
  return fmtDec(n, a < 1 ? 3 : 2)
}

export const fmtPct = (n: number | null | undefined, digits = 1) => (n == null || isNaN(n) || !isFinite(n) ? '—' : `${fmtDec(n, digits)}%`)

export const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : NaN)

// the largest one or two units of a duration, e.g. ['5 min', '3 s']
function durParts(secs: number): string[] {
  if (secs < 1) return [`${Math.round(secs * 1000)} ${t('мс')}`]
  if (secs < 60) return [`${Math.round(secs)} ${t('с')}`]
  const two = (a: number, ua: string, b: number, ub: string) => (b ? [`${a} ${ua}`, `${b} ${ub}`] : [`${a} ${ua}`])
  if (secs < 3600) return two(Math.floor(secs / 60), t('мин'), Math.round(secs % 60), t('с'))
  if (secs < 86400) return two(Math.floor(secs / 3600), t('ч'), Math.floor((secs % 3600) / 60), t('мин'))
  return two(Math.floor(secs / 86400), t('д'), Math.floor((secs % 86400) / 3600), t('ч'))
}

export function fmtDur(secs: number | null | undefined): string {
  if (secs == null || isNaN(secs) || secs < 0) return '—'
  if (!isFinite(secs)) return t('никогда')
  return durParts(secs).join(' ')
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || isNaN(ms)) return '—'
  if (ms < 1) return `${fmtDec(ms, 3)} ${t('мс')}`
  if (ms < 1000) return `${fmtDec(ms, ms < 10 ? 2 : 1)} ${t('мс')}`
  return fmtDur(ms / 1000)
}

export const now = () => Math.floor(Date.now() / 1000)

export function fmtAgo(ts: number | null | undefined, ref = now()): string {
  if (!ts) return t('никогда')
  const d = ref - ts
  if (d < 5) return t('только что')
  return t('{ago} назад', { ago: durParts(d)[0] })
}

// fmtDate formats a unix time in TZ; every date and time in the UI goes through it
export const fmtDate = (ts: number, o: Intl.DateTimeFormatOptions) => new Date(ts * 1000).toLocaleString(LOCALE, { ...o, timeZone: TZ })

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return fmtDate(ts, { dateStyle: 'medium', timeStyle: 'short' })
}

// memory settings are reported in units of 8kB pages, kB, or MB
const SETTING_UNIT: Record<string, number> = {
  shared_buffers: 8192, effective_cache_size: 8192, wal_buffers: 8192, temp_buffers: 8192,
  work_mem: 1024, maintenance_work_mem: 1024, autovacuum_work_mem: 1024, logical_decoding_work_mem: 1024,
  max_wal_size: 1 << 20, min_wal_size: 1 << 20, wal_keep_size: 1 << 20, max_slot_wal_keep_size: 1 << 20,
  max_stack_depth: 1024, temp_file_limit: 1024,
}
const SETTING_MS = new Set(['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'deadlock_timeout',
  'log_min_duration_statement', 'log_autovacuum_min_duration', 'autovacuum_vacuum_cost_delay', 'wal_writer_delay',
  'bgwriter_delay', 'vacuum_cost_delay', 'idle_session_timeout', 'wal_receiver_timeout', 'wal_sender_timeout'])
const SETTING_S = new Set(['checkpoint_timeout', 'autovacuum_naptime', 'archive_timeout', 'tcp_keepalives_idle'])

export function fmtSetting(name: string, v: string): string {
  const n = Number(v)
  if (v === '' || isNaN(n) || n < 0) return v
  if (SETTING_UNIT[name]) return fmtBytes(n * SETTING_UNIT[name])
  if (SETTING_MS.has(name)) return n === 0 ? t('0 (выкл.)') : fmtMs(n)
  if (SETTING_S.has(name)) return fmtDur(n)
  return v
}

// "16/B374D848" -> byte position
export function lsn(s: string | undefined): number {
  if (!s || !s.includes('/')) return NaN
  const [h, l] = s.split('/')
  return parseInt(h, 16) * 4294967296 + parseInt(l, 16)
}

export const truncate = (s: string, n: number) => (s && s.length > n ? s.slice(0, n) + '…' : s || '')
