import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from './api'
import { now } from './format'
import { lang, t, tk } from './i18n'

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
  pinnedAt: number | null // null = follow latest
  setPinnedAt: (t: number | null) => void
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
  const [pinnedAt, setPinnedAt] = useState<number | null>(null)
  const [range, setRangeState] = useState(savedRange)
  const [tick, setTick] = useState(0)
  const [error, setError] = useState<ApiError>()

  useEffect(() => {
    setReport(null)
    setPinnedAt(null)
  }, [srv.id])

  useEffect(() => {
    let live = true
    const q = pinnedAt ? `?at=${pinnedAt}` : ''
    fetch(`/api/servers/${srv.id}/report${q}`, { headers: { 'Accept-Language': lang } }).then(async r => {
      if (!live) return
      if (!r.ok) {
        const msg = r.status === 404 ? t('Отчёт ещё не получен') : (await r.json().catch(() => null))?.error || t('Ошибка HTTP {status}', { status: r.status })
        if (!live) return
        setError(new ApiError(r.status, msg))
        setReport(null)
        return
      }
      setReportAt(Number(r.headers.get('X-Report-At')))
      // query IDs are 64-bit and lose precision as JS numbers: keep them as strings
      setReport(JSON.parse((await r.text()).replace(/"(queryid|query_id)":(-?\d+)/g, '"$1":"$2"')))
      setError(undefined)
    }).catch(() => live && setError(new ApiError(0, t('Не удалось загрузить отчёт'))))
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
  const to = pinnedAt ?? now()
  const value: SrvCtx = {
    id: srv.id, srv, report, reportAt, pinnedAt, setPinnedAt, range, setRange,
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
