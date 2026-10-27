import { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import { api } from '../lib/api'
import { useSrv } from '../lib/server'
import { fmtBytes, fmtDate, fmtDec, fmtDur, fmtMs, fmtNum, TZ } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { Card, Spinner } from './ui'

export type Unit = 'bytes' | 'Bps' | 'ops' | 'opm' | 'oph' | 'count' | 'pct' | 'secs' | 'ms'

// raw: stored value; rate: per-second change; ratio: Δa/Δb; hit: 100·Δa/(Δa+Δb)
export type Field = { key: string; label: string; kind?: 'raw' | 'rate' | 'ratio' | 'hit'; of?: [string, string]; scale?: number }

const fmt: Record<Unit, (v: number) => string> = {
  bytes: v => fmtBytes(v),
  Bps: v => fmtBytes(v) + '/' + t('с'),
  ops: v => fmtNum(v) + '/' + t('с'),
  opm: v => fmtNum(v) + '/' + t('мин'),
  oph: v => fmtNum(v) + '/' + t('ч'),
  count: v => fmtNum(v),
  pct: v => fmtDec(v, 1) + '%',
  secs: v => fmtDur(v),
  ms: v => fmtMs(v),
}

export const fmtUnit = (u: Unit, v: number) => fmt[u](v)

type Series = { t: number[]; s: Record<string, (number | null)[]> }

function derive(data: Series, f: Field): (number | null)[] {
  const { t, s } = data
  const scale = f.scale ?? 1
  const kind = f.kind ?? 'raw'
  if (kind === 'raw') return (s[f.key] ?? []).map(v => (v == null ? null : v * scale))
  const [ka, kb] = f.of ?? [f.key, f.key]
  const a = s[ka] ?? [], b = s[kb] ?? []
  return t.map((_, i) => {
    if (i === 0 || a[i] == null || a[i - 1] == null) return null
    const da = a[i]! - a[i - 1]!
    if (da < 0) return null // counter reset
    if (kind === 'rate') {
      const dt = t[i] - t[i - 1]
      return dt > 0 ? (da / dt) * scale : null
    }
    if (b[i] == null || b[i - 1] == null) return null
    const db = b[i]! - b[i - 1]!
    if (db < 0) return null
    if (kind === 'ratio') return db > 0 ? (da / db) * scale : null
    return da + db > 0 ? (100 * da) / (da + db) : null
  })
}

// x axis ticks: time only within ~a day and a half, then date plus time while ticks are sub-daily, then the date
function xTicks(u: uPlot, vals: number[], incr: number) {
  const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0)
  const o: Intl.DateTimeFormatOptions = span < 36 * 3600 ? { hour: '2-digit', minute: '2-digit' }
    : incr < 86400 ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit' }
  return vals.map(v => fmtDate(v, o).replace(',', ''))
}

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

export function Chart({ title, obj, fields, unit, height = 190, sub }: {
  title: string; obj: string; fields: Field[]; unit: Unit; height?: number; sub?: string
}) {
  const { id, from, to, tick } = useSrv()
  const lang = useLang() // axis/legend text, LOCALE time formats and TZ are baked into the plot
  const [data, setData] = useState<Series | null>(null)
  const [err, setErr] = useState<string>()
  const box = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const raw = useMemo(() => [...new Set(fields.flatMap(f => (f.of ? f.of : [f.key])))].join(','), [fields])

  useEffect(() => {
    let live = true
    const q = new URLSearchParams({ obj, fields: raw, from: String(from), to: String(to) })
    api<Series>(`/servers/${id}/series?${q}`).then(d => live && setData(d), e => live && setErr(e.message))
    return () => {
      live = false
    }
    // `to` moves every render when following "now"; refetch only on explicit triggers
  }, [id, obj, raw, from - (from % 60), tick])

  const [theme, setTheme] = useState(document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const o = new MutationObserver(() => setTheme(document.documentElement.classList.contains('dark')))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])

  const hasData = !!data && data.t.length > 1

  useEffect(() => {
    if (!data || !box.current || !hasData) return
    const muted = css('--faint'), grid = css('--line')
    const colors = [1, 2, 3, 4, 5, 6, 7, 8].map(i => css(`--s${i}`))
    const ys = fields.map(f => derive(data, f))
    const opts: uPlot.Options = {
      width: box.current.clientWidth,
      height,
      padding: [8, 8, 0, 0],
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      legend: { show: true, live: true },
      // ticks fall on whole hours and days of TZ, not of the browser's zone; uPlot's shortcut for
      // UTC misplaces ticks on the days the browser's zone changes clocks, Etc/GMT takes its general path
      tzDate: ts => uPlot.tzDate(new Date(ts * 1000), TZ === 'UTC' || TZ === 'Etc/UTC' ? 'Etc/GMT' : TZ),
      scales: { x: { time: true }, y: { range: (_u, min, max) => [Math.min(0, min), max > 0 ? max * 1.08 : 1] } },
      axes: [
        {
          stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px Inter, system-ui', size: 28, space: 70,
          values: (u, vals, _ax, _space, incr) => xTicks(u, vals, incr),
        },
        {
          stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px Inter, system-ui', size: 64,
          values: (_u, vals) => vals.map(v => fmt[unit](v)),
        },
      ],
      series: [
        { label: t('Время'), value: (_u, v) => (v == null ? '—' : fmtDate(v, { dateStyle: 'short', timeStyle: 'short' })) },
        ...fields.map((f, i) => ({
          label: f.label,
          stroke: colors[i % 8],
          width: 2,
          fill: fields.length === 1 ? colors[0] + '1f' : undefined,
          points: { show: false },
          spanGaps: false,
          // without a hovered point the legend shows the latest value
          value: (_u: uPlot, v: number | null, _s: number, idx: number | null) => {
            if (v == null && idx == null) v = ys[i].findLast(x => x != null) ?? null
            return v == null ? '—' : fmt[unit](v)
          },
        })),
      ],
    }
    plot.current?.destroy()
    plot.current = new uPlot(opts, [data.t, ...ys] as uPlot.AlignedData, box.current)
    const ro = new ResizeObserver(() => box.current && plot.current?.setSize({ width: box.current.clientWidth, height }))
    ro.observe(box.current)
    return () => {
      ro.disconnect()
      plot.current?.destroy()
      plot.current = null
    }
  }, [data, fields, unit, height, theme, hasData, lang, TZ])

  return (
    <Card title={title} sub={sub} pad={false}>
      <div className="px-3 pb-2" style={{ minHeight: height + 30 }}>
        {err ? <div className="text-crit text-xs p-4">{err}</div>
          : !data ? <div className="flex items-center justify-center" style={{ height }}><Spinner /></div>
          : !hasData ? <div className="flex items-center justify-center text-faint text-xs" style={{ height }}>{t('В этом диапазоне пока недостаточно данных')}</div>
          : <div ref={box} />}
      </div>
    </Card>
  )
}

export function Charts({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{children}</div>
}
