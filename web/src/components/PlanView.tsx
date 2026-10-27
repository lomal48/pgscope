import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { fmtBytes, fmtDec, fmtInt, fmtMs, plural } from '../lib/format'
import { t } from '../lib/i18n'
import { Badge, Code, cx } from './ui'

type Node = Record<string, any> & { Plans?: Node[] }

export function parsePlan(text: string): { root: Node; queryText?: string } | null {
  try {
    let j = JSON.parse(text)
    if (Array.isArray(j)) j = j[0]
    const root = j.Plan ?? (j['Node Type'] ? j : null)
    return root ? { root, queryText: j['Query Text'] } : null
  } catch {
    return null
  }
}

// problems worth pointing at in a plan node
export function nodeWarnings(n: Node): string[] {
  const w: string[] = []
  const rows = n['Actual Rows'], est = n['Plan Rows'], loops = n['Actual Loops'] ?? 1
  if (rows != null && est != null && Math.max(rows, est) > 100) {
    // only underestimates: overestimates are normal below a LIMIT that stops early
    const f = Math.max(rows, 1) / Math.max(est, 1)
    if (f > 10) w.push(t('Планировщик ожидал {est} {estRows}, а получил {rows} (в {factor} {times} больше) — выполните ANALYZE или добавьте расширенную статистику', {
      est: fmtInt(est), estRows: plural(Math.round(est), ['строку', 'строки', 'строк']), rows: fmtInt(rows),
      factor: fmtDec(f, 0), times: plural(Math.round(f), ['раз', 'раза', 'раз']),
    }))
  }
  const removed = n['Rows Removed by Filter']
  if (n['Node Type'] === 'Seq Scan' && removed > 1000 && removed > (rows ?? 0) * 10)
    w.push(t('Seq Scan отбрасывает {n} {rows} — может помочь индекс по столбцам фильтра', {
      n: fmtInt(removed * loops), rows: plural(Math.round(removed * loops), ['строку', 'строки', 'строк']),
    }))
  if (String(n['Sort Method'] ?? '').includes('external')) w.push(t('Сортировка вышла на диск ({size}) — увеличьте work_mem', { size: fmtBytes(n['Sort Space Used'] * 1024) }))
  if ((n['Hash Batches'] ?? 1) > 1) w.push(t('Hash разбит на {n} {batches} — увеличьте work_mem', { n: n['Hash Batches'], batches: plural(n['Hash Batches'], ['пакет', 'пакета', 'пакетов']) }))
  if (n['Node Type'] === 'Nested Loop' && loops > 1000) w.push(t('Nested Loop выполнен {n} {times}', { n: fmtInt(loops), times: plural(Math.round(loops), ['раз', 'раза', 'раз']) }))
  if ((n['Heap Fetches'] ?? 0) > 10000) w.push(t('Index Only Scan выполнил {n} {fetches} к куче (heap fetches) — выполните VACUUM, чтобы обновить карту видимости', {
      n: fmtInt(n['Heap Fetches']), fetches: plural(n['Heap Fetches'], ['обращение', 'обращения', 'обращений']),
    }))
  return w
}

export function collectWarnings(n: Node): string[] {
  return [...nodeWarnings(n), ...(n.Plans ?? []).flatMap(collectWarnings)]
}

function exclusive(n: Node): number {
  const total = (n['Actual Total Time'] ?? 0) * (n['Actual Loops'] ?? 1)
  const kids = (n.Plans ?? []).reduce((a, c) => a + (c['Actual Total Time'] ?? 0) * (c['Actual Loops'] ?? 1), 0)
  return Math.max(0, total - kids)
}

function PlanNode({ n, total, timed, depth }: { n: Node; total: number; timed: boolean; depth: number }) {
  const [open, setOpen] = useState(true)
  const share = timed ? (100 * exclusive(n)) / (total || 1) : (100 * (n['Total Cost'] ?? 0)) / (total || 1)
  const warns = nodeWarnings(n)
  const target = n['Relation Name'] ? `on ${n['Schema'] ? n['Schema'] + '.' : ''}${n['Relation Name']}${n['Alias'] && n['Alias'] !== n['Relation Name'] ? ' ' + n['Alias'] : ''}`
    : n['Index Name'] ? `using ${n['Index Name']}` : n['CTE Name'] ? `CTE ${n['CTE Name']}` : ''
  const conds = ['Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Filter', 'Sort Key', 'Group Key']
    .filter(k => n[k]).map(k => [k, Array.isArray(n[k]) ? n[k].join(', ') : n[k]])
  const kids = n.Plans ?? []
  return (
    <div className={cx(depth > 0 && 'ml-5 border-l border-line pl-3')}>
      <div className="py-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {kids.length > 0 ? (
            <button className="text-faint cursor-pointer" onClick={() => setOpen(!open)}>{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button>
          ) : <span className="w-3.5" />}
          <span className="font-semibold">{n['Node Type']}{n['Join Type'] ? ` (${n['Join Type']})` : ''}</span>
          <span className="text-muted">{target}</span>
          {n['Index Name'] && n['Relation Name'] && <span className="text-muted">using {n['Index Name']}</span>}
          <div className="ml-auto flex items-center gap-2 text-xs text-muted tabular-nums">
            {n['Actual Rows'] != null && <span title={t('фактические строки × циклы')}>{fmtInt(n['Actual Rows'])} {plural(Math.round(n['Actual Rows']), ['строка', 'строки', 'строк'])}{(n['Actual Loops'] ?? 1) > 1 ? ` × ${fmtInt(n['Actual Loops'])}` : ''}</span>}
            <span className="text-faint" title={t('оценка числа строк планировщиком')}>{t('оценка {n}', { n: fmtInt(n['Plan Rows']) })}</span>
            {timed && <span>{fmtMs(exclusive(n))}</span>}
            <span className="text-faint">{t('стоимость {n}', { n: fmtInt(Number(n['Total Cost'])) })}</span>
          </div>
        </div>
        <div className="ml-5 mt-1 h-1 rounded bg-panel-2 overflow-hidden">
          <div className={cx('h-full rounded', share > 50 ? 'bg-crit' : share > 20 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, share)}%` }} />
        </div>
        {conds.length > 0 && (
          <div className="ml-5 mt-1 space-y-0.5">
            {conds.map(([k, v]) => <div key={k} className="mono text-muted break-all"><span className="text-faint">{k}:</span> {v}</div>)}
          </div>
        )}
        {warns.map(w => <div key={w} className="ml-5 mt-1 text-xs text-warn flex items-center gap-1"><AlertTriangle className="size-3" />{w}</div>)}
      </div>
      {open && kids.map((c, i) => <PlanNode key={i} n={c} total={total} timed={timed} depth={depth + 1} />)}
    </div>
  )
}

export function PlanView({ plan, format }: { plan: string; format: string }) {
  const p = format === 'json' ? parsePlan(plan) : null
  if (!p) return <Code>{plan}</Code>
  const timed = p.root['Actual Total Time'] != null
  const total = timed ? p.root['Actual Total Time'] * (p.root['Actual Loops'] ?? 1) : p.root['Total Cost']
  return (
    <div>
      <div className="flex gap-2 mb-2">
        {timed ? <Badge tone="accent">{t('всего {time}', { time: fmtMs(total) })}</Badge> : <Badge>{t('полосы показывают долю стоимости (нет данных о времени)')}</Badge>}
        {p.root['Actual Rows'] != null && <Badge>{fmtInt(p.root['Actual Rows'])} {plural(Math.round(p.root['Actual Rows']), ['строка', 'строки', 'строк'])}</Badge>}
      </div>
      <div className="text-[12.5px]"><PlanNode n={p.root} total={total} timed={timed} depth={0} /></div>
    </div>
  )
}
