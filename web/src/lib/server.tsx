import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from './api'
import { now } from './format'
import { lang, t, tk } from './i18n'
import { atOf, setHash, usePath, withAt } from './router'

export type Report = Record<string, any>

export type ServerRow = {
  id: number
  name: string
  kind: 'postgres' | 'pgpool'
  owner: string
  is_owner: boolean
  last_report: string | null
  summary: Record<string, any> | null
  alerts: { type: string; text: string; value: string; objname: string; objlink: string }[]
  pgbouncers: string[]
}

export type Me = { id: number; email: string; apikey: string | null; team_member: boolean; base_url: string; ai: boolean; smtp: boolean; lang: 'ru' | 'en' | null
  tz: string | null // IANA time zone of the UI, null = the browser's
  min_report_interval?: number // seconds between reports of one server (PGSCOPE_MIN_REPORT_INTERVAL)
}

type AppCtx = { me: Me; servers: ServerRow[]; reloadServers: () => void; reloadMe: () => void }
export const App = createContext<AppCtx>(null!)
export const useApp = () => useContext(App)

// labels are translated where rendered: t(label)
export const RANGES: [number, string][] = [[3600, tk('1ч')], [6 * 3600, tk('6ч')], [86400, tk('24ч')], [7 * 86400, tk('7д')], [30 * 86400, tk('30д')]]

type SrvCtx = {
  id: number
  srv: ServerRow
  report: Report | null
  reportAt: number | null // timestamp of the report shown
  prevAt: number | null // neighbouring reports of the shown one (nextAt: the oldest one when the moment is before it)
  nextAt: number | null
  firstAt: number | null // the oldest stored report, null = no reports at all
  loading: boolean // a report request is in flight
  pinnedAt: number | null // the moment (?at= in the URL), null = follow latest
  // setPinnedAt opens the report at or before t (null or the future = the latest); a step while pinned
  // replaces the history entry, anything else adds a Back step
  setPinnedAt: (t: number | null, step?: boolean) => void
  range: number
  setRange: (r: number) => void
  from: number
  to: number
  tick: number // bumps on refresh
  refresh: () => void
  error?: ApiError
}
const Srv = createContext<SrvCtx>(null!)
export const useSrv = () => useContext(Srv)

const savedRange = () => {
  try {
    return Number(localStorage.getItem('range')) || 6 * 3600
  } catch {
    return 6 * 3600
  }
}

export function ServerProvider({ srv, children }: { srv: ServerRow; children: ReactNode }) {
  const [report, setReport] = useState<Report | null>(null)
  const [reportAt, setReportAt] = useState<number | null>(null)
  const [prevAt, setPrevAt] = useState<number | null>(null)
  const [nextAt, setNextAt] = useState<number | null>(null)
  const [firstAt, setFirstAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true) // the first fetch starts on mount: no "no reports" flash
  const [range, setRangeState] = useState(savedRange)
  const [tick, setTick] = useState(0)
  const [error, setError] = useState<ApiError>()

  const path = usePath()
  const urlAt = atOf(path)
  const [pinnedAt, setPin] = useState(urlAt)
  // ?at= sets the moment; a seen entry without it is live mode; a fresh entry (an in-app link) keeps the
  // moment. The entry is marked, and a carried moment is written into it (an invalid ?at= is dropped).
  useEffect(() => {
    const seen = history.state?.seen
    const at = urlAt ?? (seen ? null : pinnedAt)
    setPin(at)
    if (!seen || withAt(path, at) !== path) setHash(withAt(path, at))
  }, [path])

  const setPinnedAt = (t: number | null, step = false) => {
    const v = t && t <= now() ? Math.floor(t) : null // a time in the future = follow the latest
    setPin(v)
    setHash(withAt(location.hash.slice(1), v), !(step && pinnedAt)) // read the hash at call time
  }

  useEffect(() => {
    let live = true
    setLoading(true)
    fetch(`/api/servers/${srv.id}/report${pinnedAt ? `?at=${pinnedAt}` : ''}`, { headers: { 'Accept-Language': lang } }).then(async r => {
      if (!live) return
      const h = (k: string) => Number(r.headers.get(k)) || null
      const first = h('X-Report-First')
      setFirstAt(first)
      if (!r.ok) {
        const msg = r.status === 404 ? t('Отчёт ещё не получен') : (await r.json().catch(() => null))?.error || t('Ошибка HTTP {status}', { status: r.status })
        if (!live) return
        if (r.status === 404) {
          setReportAt(null)
          setPrevAt(null)
          setNextAt(pinnedAt && first && first > pinnedAt ? first : null)
        }
        setError(new ApiError(r.status, msg))
        setReport(null)
        return
      }
      // before parsing: a broken report can be stepped past
      setReportAt(h('X-Report-At'))
      setPrevAt(h('X-Report-Prev'))
      setNextAt(h('X-Report-Next'))
      // query IDs are 64-bit and lose precision as JS numbers: keep them as strings
      const rep = JSON.parse((await r.text()).replace(/"(queryid|query_id)":(-?\d+)/g, '"$1":"$2"'))
      if (!live) return
      setReport(rep)
      setError(undefined)
    }).catch(() => live && setError(new ApiError(0, t('Не удалось загрузить отчёт')))).finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [srv.id, pinnedAt, tick])

  // follow new reports while not pinned to a past one
  useEffect(() => {
    if (pinnedAt) return
    const iv = setInterval(() => setTick(x => x + 1), 60_000)
    return () => clearInterval(iv)
  }, [pinnedAt])

  const setRange = (r: number) => {
    setRangeState(r)
    try {
      localStorage.setItem('range', String(r))
    } catch {
      /* storage unavailable */
    }
  }
  // pinned: the chart window holds the moment at 5/12..6/12 of it and moves in buckets of range/12, so steps
  // inside one bucket do not refetch the series
  const q = range / 12
  const to = pinnedAt ? Math.min(now(), Math.ceil((pinnedAt + range / 2) / q) * q) : now()
  const value: SrvCtx = {
    id: srv.id, srv, report, reportAt, prevAt, nextAt, firstAt, loading, pinnedAt, setPinnedAt, range, setRange,
    from: to - range, to, tick, refresh: () => setTick(x => x + 1), error,
  }
  return <Srv.Provider value={value}>{children}</Srv.Provider>
}

export async function loadServers() {
  return api<ServerRow[]>('/servers')
}

// helpers over the raw pgmetrics report
export const setting = (r: Report, k: string) => r?.settings?.[k]?.setting as string | undefined
export const settingNum = (r: Report, k: string) => Number(setting(r, k) ?? NaN)
export const arr = <T = any,>(x: T[] | null | undefined): T[] => x ?? []
export const tableKey = (t: any) => `${t.db_name}.${t.schema_name}.${t.name}`
