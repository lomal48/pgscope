import { useEffect, useId, useRef, useState } from 'react'
import { CalendarClock, ChevronLast, ChevronLeft, ChevronRight, History, X } from 'lucide-react'
import { useSrv } from '../lib/server'
import { withAt } from '../lib/router'
import { fmtDate, fmtDur, fmtShort, fmtTime, now, TZ } from '../lib/format'
import { fromInputTime, toInputTime } from '../lib/timeinput'
import { t } from '../lib/i18n'
import { CopyButton, Spinner, cx } from './ui'

// single-key shortcuts can be turned off (WCAG 2.1.4); stored per browser
const keysSaved = () => {
  try {
    return localStorage.getItem('reportKeys') !== '0'
  } catch {
    return true
  }
}

// ReportNav: previous / next report, the moment picker dialog and the [ ] keys of the server bar
export function ReportNav() {
  const { reportAt, pinnedAt, prevAt, nextAt, firstAt, loading, error, setPinnedAt } = useSrv()
  const [keys, setKeysState] = useState(keysSaved)
  const dlg = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const ids = useId()
  const shown = reportAt ?? pinnedAt
  const retention = !!(error?.status === 404 && pinnedAt && firstAt && firstAt > pinnedAt)

  const setKeys = (on: boolean) => {
    setKeysState(on)
    try {
      localStorage.setItem('reportKeys', on ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }

  // [ ] previous / next report, Shift+[ Shift+] an hour earlier / later; by physical key, so the Russian
  // layout (х ъ) works; not while typing and not with Ctrl/⌘/Alt (⌘[ is the browser's Back on macOS)
  useEffect(() => {
    if (!keys) return
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || el.isContentEditable || el.closest?.('input,textarea,select,dialog')) return
      const back = e.code === 'BracketLeft'
      if (!back && e.code !== 'BracketRight') return
      e.preventDefault()
      if (e.shiftKey) {
        if (reportAt) setPinnedAt(reportAt + (back ? -3600 : 3600), true)
      } else {
        const to = back ? prevAt : nextAt
        if (to) setPinnedAt(to, true)
      }
    }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [keys, prevAt, nextAt, reportAt, pinnedAt])

  const open = () => {
    const el = input.current
    if (el) {
      el.max = toInputTime(now(), TZ) // set on open: a value rendered earlier would go stale
      el.value = toInputTime(shown ?? now(), TZ)
    }
    dlg.current?.showModal()
    el?.focus()
  }
  const close = () => dlg.current?.close()
  const dist = (x: number) => fmtDur(Math.abs(x - (shown ?? x))) // from the shown report to a neighbour
  const keyHint = (k: string) => (keys ? ` (${k})` : '')
  const link = shown ? location.href.split('#')[0] + '#' + withAt(location.hash.slice(1), shown) : ''
  const shifts: [number, string, string][] = [
    [-86400, '−' + t('24ч'), t('На {dur} раньше', { dur: fmtDur(86400) })],
    [-3600, '−' + t('1ч'), t('На {dur} раньше', { dur: fmtDur(3600) })],
    [3600, '+' + t('1ч'), t('На {dur} позже', { dur: fmtDur(3600) })],
    [86400, '+' + t('24ч'), t('На {dur} позже', { dur: fmtDur(86400) })],
  ]

  return (
    <div role="group" aria-label={t('Навигация по отчётам')} className="flex items-center gap-1 max-sm:basis-full">
      <button type="button" className="btn btn-sm h-8 w-8 px-0" disabled={!prevAt} onClick={() => setPinnedAt(prevAt, true)}
        aria-label={t('Предыдущий отчёт')} aria-keyshortcuts={keys ? '[' : undefined}
        title={prevAt ? t('Предыдущий отчёт: {time}, на {dur} раньше', { time: fmtTime(prevAt), dur: dist(prevAt) }) + keyHint('[') : t('Более ранних отчётов нет')}>
        <ChevronLeft className="size-4" />
      </button>
      <button type="button" aria-haspopup="dialog" onClick={open} disabled={!reportAt && !pinnedAt && !firstAt && !loading}
        className={cx('btn btn-sm h-8 gap-1.5 tabular-nums justify-start min-w-0 max-sm:flex-1 sm:w-48',
          !!pinnedAt && (retention ? 'text-warn' : 'bg-accent/10 text-accent border-accent/40'))}
        title={shown ? fmtDate(shown, { dateStyle: 'medium', timeStyle: 'medium' }) : undefined}
        aria-label={!shown ? undefined : pinnedAt ? t('Прошлый отчёт: {time}. Выбрать другой момент', { time: fmtTime(shown) })
          : t('Последний отчёт: {time}. Выбрать другой момент', { time: fmtTime(shown) })}>
        {loading ? <span role="status" aria-label={t('Загрузка отчёта')}><Spinner className="size-3.5" /></span>
          : pinnedAt ? <History className="size-3.5 shrink-0" /> : <CalendarClock className="size-3.5 shrink-0 text-muted" />}
        <span className="truncate">{shown ? fmtShort(shown) : loading ? '—' : t('Нет отчётов')}</span>
      </button>
      <button type="button" className="btn btn-sm h-8 w-8 px-0" disabled={!nextAt} onClick={() => setPinnedAt(nextAt, true)}
        aria-label={t('Следующий отчёт')} aria-keyshortcuts={keys ? ']' : undefined}
        title={nextAt ? t('Следующий отчёт: {time}, на {dur} позже', { time: fmtTime(nextAt), dur: dist(nextAt) }) + keyHint(']') : t('Более поздних отчётов нет')}>
        <ChevronRight className="size-4" />
      </button>
      {pinnedAt && (
        <button type="button" className="btn btn-primary btn-sm h-8" onClick={() => setPinnedAt(null)}
          title={t('Вернуться к последнему отчёту и автообновлению')} aria-label={t('Вернуться к последнему отчёту и автообновлению')}>
          <ChevronLast className="size-4" /><span className="hidden sm:inline">{t('К последнему')}</span>
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {pinnedAt ? (reportAt ? t('Показан отчёт от {time}', { time: fmtTime(reportAt) }) : '') : t('Показан последний отчёт')}
      </span>

      <dialog ref={dlg} aria-labelledby={ids + 'title'} onClick={e => e.target === e.currentTarget && close()}
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel text-fg p-0 shadow-xl backdrop:bg-black/40">
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <h2 id={ids + 'title'} className="flex-1 font-semibold tracking-tight">{t('Перейти к моменту')}</h2>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={t('Закрыть')} onClick={close}><X className="size-4" /></button>
          </div>
          <form method="dialog" className="space-y-1.5" onSubmit={() => {
            const ts = fromInputTime(input.current?.value ?? '', TZ)
            if (!isNaN(ts)) setPinnedAt(ts + 59) // reports carry seconds: the report from that minute
          }}>
            <label htmlFor={ids + 'at'} className="label">{t('Дата и время ({tz})', { tz: TZ })}</label>
            <div className="flex gap-2">
              <input ref={input} id={ids + 'at'} type="datetime-local" step={60} required className="input flex-1"
                min={firstAt ? toInputTime(firstAt, TZ) : undefined} aria-describedby={ids + 'hint'} />
              <button className="btn btn-primary">{t('Перейти')}</button>
            </div>
            <p id={ids + 'hint'} className="text-xs text-faint">
              {t('Откроется ближайший отчёт не позже этого времени.')}
              {firstAt ? ' ' + t('Самый ранний сохранённый отчёт — от {time}.', { time: fmtTime(firstAt) }) : ''}
            </p>
          </form>
          <div role="group" aria-label={t('Сдвиг от показанного отчёта')} className="flex gap-1">
            {shifts.map(([d, label, aria]) => (
              <button key={d} type="button" className="btn btn-sm flex-1 tabular-nums" disabled={!shown} aria-label={aria}
                onClick={() => { close(); setPinnedAt(shown! + d) }}>
                {label}
              </button>
            ))}
          </div>
          {shown && (
            <div className="space-y-1.5">
              <label htmlFor={ids + 'link'} className="label">{t('Ссылка на этот отчёт')}</label>
              <div className="flex gap-1">
                <input id={ids + 'link'} readOnly className="input flex-1 mono" value={link} onFocus={e => e.target.select()} />
                {window.isSecureContext && navigator.clipboard && <CopyButton text={link} className="h-8" />}
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" className="accent-accent" checked={keys} onChange={e => setKeys(e.target.checked)} />
            {t('Клавиши [ и ] для перехода между отчётами')}
          </label>
          <p className="text-xs text-faint">
            {t('Клавиши: [ и ] — предыдущий и следующий отчёт (в русской раскладке — х и ъ), Shift+[ и Shift+] — на час раньше и позже. Щелчок по графику открывает отчёт этого момента.')}
          </p>
        </div>
      </dialog>
    </div>
  )
}
