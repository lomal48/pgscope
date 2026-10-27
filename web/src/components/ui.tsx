import { useState, type ReactNode } from 'react'
import { AlertOctagon, AlertTriangle, Check, CheckCircle2, ChevronRight, CircleHelp, Copy, Info, Loader2 } from 'lucide-react'
import { t } from '../lib/i18n'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

export function Card({ title, actions, children, className, pad = true, sub }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; sub?: ReactNode
}) {
  return (
    <section className={cx('card min-w-0', className)}>
      {(title || actions) && (
        <header className="flex items-center gap-3 px-4 pt-3.5 pb-1">
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold tracking-tight truncate">{title}</h3>
            {sub && <div className="text-xs text-faint mt-0.5">{sub}</div>}
          </div>
          {actions}
        </header>
      )}
      <div className={cx(pad && 'p-4', !pad && !!title && 'pt-2')}>{children}</div>
    </section>
  )
}

export type Tone = 'good' | 'warn' | 'crit' | 'info' | 'neutral' | 'accent'

const toneText: Record<Tone, string> = {
  good: 'text-good', warn: 'text-warn', crit: 'text-crit', info: 'text-info', neutral: 'text-muted', accent: 'text-accent',
}
const toneBg: Record<Tone, string> = {
  good: 'bg-good/10 text-good ring-good/20', warn: 'bg-warn/10 text-warn ring-warn/25', crit: 'bg-crit/10 text-crit ring-crit/25',
  info: 'bg-info/10 text-info ring-info/20', neutral: 'bg-panel-2 text-muted ring-line', accent: 'bg-accent/10 text-accent ring-accent/20',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap', toneBg[tone], className)}>
      {children}
    </span>
  )
}

export const sevTone = (s: string): Tone => (s === 'crit' ? 'crit' : s === 'warn' ? 'warn' : s === 'info' ? 'info' : 'neutral')

export function SevIcon({ sev, className = 'size-4' }: { sev: string; className?: string }) {
  if (sev === 'crit') return <AlertOctagon className={cx(className, 'text-crit shrink-0')} aria-label={t('критично')} />
  if (sev === 'warn') return <AlertTriangle className={cx(className, 'text-warn shrink-0')} aria-label={t('предупреждение')} />
  if (sev === 'good') return <CheckCircle2 className={cx(className, 'text-good shrink-0')} aria-label={t('норма')} />
  return <Info className={cx(className, 'text-info shrink-0')} aria-label={t('инфо')} />
}

export function SevBadge({ sev }: { sev: string }) {
  const label = sev === 'crit' ? t('Критично') : sev === 'warn' ? t('Предупреждение') : t('Инфо')
  return (
    <Badge tone={sevTone(sev)}>
      <SevIcon sev={sev} className="size-3" />
      {label}
    </Badge>
  )
}

export function Stat({ label, value, sub, tone, icon }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return (
    <div className="card px-4 py-3 min-w-0">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={cx('mt-1 text-xl font-semibold tracking-tight tabular-nums truncate', tone && toneText[tone])}>{value}</div>
      {sub && <div className="text-xs text-faint mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

export function Stats({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">{children}</div>
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-line overflow-x-auto">
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={cx('px-3 h-9 -mb-px border-b-2 text-[13px] whitespace-nowrap cursor-pointer transition-colors',
            value === t.id ? 'border-accent text-fg font-medium' : 'border-transparent text-muted hover:text-fg')}>
          {t.label}
          {t.count != null && <span className="ml-1.5 text-[11px] text-faint tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <div className="text-muted text-[13px] mt-1 max-w-lg">{children}</div>}
    </div>
  )
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <Loader2 className={cx(className, 'animate-spin text-faint')} />
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-20">
      <Spinner className="size-6" />
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="card border-crit/30 bg-crit/5 text-crit px-4 py-3 text-[13px] flex items-center gap-2">
      <AlertOctagon className="size-4" />
      {error instanceof Error ? error.message : String(error)}
    </div>
  )
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button className={cx('btn btn-sm btn-ghost', className)} title={t('Копировать')}
      onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200) })}>
      {ok ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}
    </button>
  )
}

export function Code({ children, copy = true, className }: { children: string; copy?: boolean; className?: string }) {
  return (
    <div className={cx('relative group rounded-lg bg-panel-2 border border-line', className)}>
      <pre className="mono p-3 pr-10 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed">{children}</pre>
      {copy && <CopyButton text={children} className="absolute top-1.5 right-1.5 opacity-60 group-hover:opacity-100" />}
    </div>
  )
}

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: number }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-2', cols === 1 ? 'grid-cols-1' : cols === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2')}>
      {items.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 min-w-0 border-b border-line/60 pb-1.5">
          <dt className="text-muted text-[12.5px] shrink-0">{k}</dt>
          <dd className="text-right tabular-nums truncate">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Bar({ value, tone = 'accent', className }: { value: number; tone?: Tone; className?: string }) {
  const v = Math.max(0, Math.min(100, isFinite(value) ? value : 0))
  const color = { good: 'bg-good', warn: 'bg-warn', crit: 'bg-crit', info: 'bg-info', neutral: 'bg-faint', accent: 'bg-accent' }[tone]
  return (
    <div className={cx('h-1.5 rounded-full bg-panel-2 overflow-hidden', className)}>
      <div className={cx('h-full rounded-full', color)} style={{ width: `${v}%` }} />
    </div>
  )
}

// help: documentation section for the page, e.g. 'fleet/servers'
export function PageHeader({ title, sub, actions, help }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; help?: string }) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-5">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-1.5">
          {title}
          {help && <a href={'#/docs/' + help} className="text-faint hover:text-accent" title={t('Справка')}><CircleHelp className="size-4" /></a>}
        </h1>
        {sub && <p className="text-muted text-[13px] mt-0.5">{sub}</p>}
      </div>
      {actions}
    </div>
  )
}

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mt-6">
      <div className="flex items-center mb-2.5">
        <h2 className="text-[13px] font-semibold text-muted uppercase tracking-wider flex-1">{title}</h2>
        {actions}
      </div>
      {children}
    </div>
  )
}

export function Crumbs({ items }: { items: [string, string?][] }) {
  return (
    <nav className="flex items-center gap-1 text-xs text-muted mb-2 flex-wrap">
      {items.map(([label, href], i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 text-faint" />}
          {href ? <a href={'#' + href} className="hover:text-fg">{label}</a> : <span className="text-fg">{label}</span>}
        </span>
      ))}
    </nav>
  )
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  )
}

export function Select({ value, onChange, options, className }: {
  value: string; onChange: (v: string) => void; options: ([string, string] | string)[]; className?: string
}) {
  return (
    <select className={cx('input pr-7', className)} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => {
        const [v, l] = typeof o === 'string' ? [o, o] : o
        return <option key={v} value={v}>{l}</option>
      })}
    </select>
  )
}
