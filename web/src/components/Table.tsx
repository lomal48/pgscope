import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { fmtInt, plural } from '../lib/format'
import { t } from '../lib/i18n'
import { cx } from './ui'

export type Col<T> = {
  key: string
  label: ReactNode
  value?: (r: T) => any // used for sorting and as default cell content
  render?: (r: T) => ReactNode
  right?: boolean
  className?: string
  title?: string
}

export function DataTable<T>({ rows, cols, sort: initSort, search, onRow, pageSize = 50, empty, toolbar, rowClass, dense }: {
  rows: T[]
  cols: Col<T>[]
  sort?: [string, boolean] // key, descending
  search?: (r: T) => string
  onRow?: (r: T) => void
  pageSize?: number
  empty?: ReactNode
  toolbar?: ReactNode
  rowClass?: (r: T) => string | undefined
  dense?: boolean
}) {
  const [sort, setSort] = useState(initSort)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)

  const view = useMemo(() => {
    let out = rows
    if (q && search) {
      const s = q.toLowerCase()
      out = out.filter(r => search(r).toLowerCase().includes(s))
    }
    if (sort) {
      const col = cols.find(c => c.key === sort[0])
      const get = col?.value ?? ((r: any) => r[sort[0]])
      out = [...out].sort((a, b) => {
        const x = get(a), y = get(b)
        // unknown values (null, undefined, NaN) sort last in either direction
        const ux = x == null || Number.isNaN(x), uy = y == null || Number.isNaN(y)
        if (ux || uy) return Number(ux) - Number(uy)
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
        return sort[1] ? -c : c
      })
    }
    return out
  }, [rows, q, sort, cols, search])

  const pages = Math.max(1, Math.ceil(view.length / pageSize))
  const p = Math.min(page, pages - 1)
  const shown = view.slice(p * pageSize, (p + 1) * pageSize)

  return (
    <div className="min-w-0">
      {(search || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {search && (
            <div className="relative">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input className="input pl-8 w-64" placeholder={t('Фильтр…')} value={q} onChange={e => { setQ(e.target.value); setPage(0) }} />
            </div>
          )}
          {toolbar}
          <span className="ml-auto text-xs text-faint tabular-nums">{fmtInt(view.length)} {plural(view.length, ['строка', 'строки', 'строк'])}</span>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full text-[12.5px] border-collapse">
          <thead>
            <tr className="border-b border-line">
              {cols.map(c => (
                <th key={c.key} title={c.title}
                  onClick={() => setSort(s => (s && s[0] === c.key ? [c.key, !s[1]] : [c.key, true]))}
                  className={cx('px-3 h-9 font-medium text-muted whitespace-nowrap cursor-pointer select-none hover:text-fg sticky top-0 bg-panel',
                    c.right ? 'text-right' : 'text-left')}>
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {sort?.[0] === c.key && (sort[1] ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} onClick={onRow && (() => onRow(r))}
                className={cx('border-b border-line/60 last:border-0', onRow && 'cursor-pointer hover:bg-panel-2', rowClass?.(r))}>
                {cols.map(c => (
                  <td key={c.key} className={cx('px-3 align-top', dense ? 'py-1.5' : 'py-2', c.right && 'text-right tabular-nums whitespace-nowrap', c.className)}>
                    {c.render ? c.render(r) : String(c.value ? c.value(r) ?? '' : (r as any)[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {view.length === 0 && <div className="py-10 text-center text-muted text-[13px]">{empty ?? t('Нет данных')}</div>}
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 mt-2 text-xs text-muted">
          <button className="btn btn-sm" disabled={p === 0} onClick={() => setPage(p - 1)}><ChevronLeft className="size-3.5" /></button>
          <span className="tabular-nums">{t('Стр. {page} из {pages}', { page: p + 1, pages })}</span>
          <button className="btn btn-sm" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}><ChevronRight className="size-3.5" /></button>
        </div>
      )}
    </div>
  )
}
