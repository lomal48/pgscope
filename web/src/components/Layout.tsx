import { useEffect, useState, type ReactNode } from 'react'
import {
  Activity, Archive, Bell, BellRing, BookOpen, Bot, Boxes, CircleHelp, Cable, ChevronDown, Cloud, Container, Cpu, Database, FileText, Gauge, GitBranch,
  HardDrive, Layers, ListTree, LogOut, Lock, Menu, Moon, RefreshCw, ScanSearch, Server, Settings2,
  SlidersHorizontal, Stethoscope, Sun, Table2, Trophy, User, Users, Wrench, X, Zap,
} from 'lucide-react'
import { api } from '../lib/api'
import { atOf, go, usePath, withAt } from '../lib/router'
import { RANGES, useApp, useSrv } from '../lib/server'
import { fmtAgo, fmtDur, fmtTime, now } from '../lib/format'
import { LANGS, setLang, t, useLang } from '../lib/i18n'
import { ReportNav } from './ReportNav'
import { cx } from './ui'

type NavItem = [path: string, label: string, icon: ReactNode]

function serverNav(id: number, kind: string, hasRDS: boolean, pgbouncers: string[]): [string, NavItem[]][] {
  const p = (s: string) => `/s/${id}${s}`
  const ic = 'size-4 shrink-0'
  if (kind === 'pgpool') {
    return [['Pgpool', [[p(''), t('Обзор'), <Gauge className={ic} />], [p('/settings'), t('Команда и настройки'), <Settings2 className={ic} />]]]]
  }
  const integrations: NavItem[] = []
  if (hasRDS) integrations.push([p('/cloud'), t('Облачные метрики'), <Cloud className={ic} />])
  if (pgbouncers.length) integrations.push([p('/pgbouncer'), 'PgBouncer', <Cable className={ic} />])
  return [
    [t('Мониторинг'), [
      [p(''), t('Обзор'), <Gauge className={ic} />],
      [p('/diagnostics'), t('Диагностика'), <Stethoscope className={ic} />],
      [p('/chat'), t('AI-чат'), <Bot className={ic} />],
    ]],
    [t('Активность'), [
      [p('/queries'), t('Запросы'), <Zap className={ic} />],
      [p('/backends'), t('Бэкенды'), <Activity className={ic} />],
      [p('/locks'), t('Блокировки'), <Lock className={ic} />],
    ]],
    [t('Объекты'), [
      [p('/databases'), t('Базы данных'), <Database className={ic} />],
      [p('/tables'), t('Таблицы'), <Table2 className={ic} />],
      [p('/indexes'), t('Индексы'), <ListTree className={ic} />],
      [p('/index-management'), t('Управление индексами'), <Wrench className={ic} />],
      [p('/topk'), t('Топ-k'), <Trophy className={ic} />],
      [p('/tablespaces'), t('Табличные пространства'), <HardDrive className={ic} />],
      [p('/objects'), t('Расширения и прочее'), <Boxes className={ic} />],
      [p('/roles'), t('Роли'), <Users className={ic} />],
    ]],
    [t('Сервер'), [
      [p('/replication'), t('Репликация'), <GitBranch className={ic} />],
      [p('/wal'), t('WAL и контрольные точки'), <Archive className={ic} />],
      [p('/vacuum'), t('Очистка (vacuum)'), <Layers className={ic} />],
      [p('/config'), t('Конфигурация'), <SlidersHorizontal className={ic} />],
      [p('/system'), t('Система'), <Cpu className={ic} />],
      [p('/logs'), t('Журнал'), <FileText className={ic} />],
    ]],
    ...(integrations.length ? [[t('Интеграции'), integrations] as [string, NavItem[]]] : []),
    [t('Оповещения и команда'), [
      [p('/alerts'), t('Оповещения'), <Bell className={ic} />],
      [p('/change-alerts'), t('Оповещения об изменениях'), <BellRing className={ic} />],
      [p('/settings'), t('Команда и настройки'), <Settings2 className={ic} />],
    ]],
  ]
}

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))
  return [dark, () => {
    const d = !dark
    document.documentElement.classList.toggle('dark', d)
    try {
      localStorage.setItem('theme', d ? 'dark' : 'light')
    } catch {
      /* storage unavailable */
    }
    setDark(d)
  }]
}

// language picker; persist saves the choice to the signed-in user's profile
export function LangSwitch({ persist }: { persist: boolean }) {
  const cur = useLang()
  const pick = (l: string) => {
    setLang(l)
    if (persist) api('/me/lang', 'PUT', { lang: l }).catch(() => {})
  }
  return (
    <div className="inline-flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label={t('Язык')}>
      {LANGS.map(([l, name]) => (
        <button key={l} lang={l} onClick={() => pick(l)} aria-pressed={l === cur}
          className={cx('px-2.5 h-7 rounded-md text-xs font-medium cursor-pointer', l === cur ? 'bg-accent text-white' : 'text-muted hover:text-fg')}>
          {name}
        </button>
      ))}
    </div>
  )
}

export function Logo() {
  return (
    <a href="#/" className="flex items-center gap-2 px-2 font-semibold tracking-tight text-[15px]">
      <span className="size-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 grid place-items-center shadow-sm shadow-indigo-500/30">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 15l4.5-5 3.5 3.5L20 6" />
        </svg>
      </span>
      pgscope
    </a>
  )
}

export function Shell({ children, serverId }: { children: ReactNode; serverId?: number }) {
  const full = usePath()
  const path = full.split('?')[0]
  const { me, servers } = useApp()
  const [dark, toggle] = useTheme()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [path])
  const srv = servers.find(s => s.id === serverId)

  const isActive = (p: string) => (p.split('/').length <= 3 ? path === p : path === p || path.startsWith(p + '/'))
  const link = ([p, label, icon]: NavItem) => (
    <a key={p} href={'#' + p} className={cx('nav-item', isActive(p) && 'active')}>{icon}{label}</a>
  )

  const sidebar = (
    <aside className="flex flex-col h-full w-60 shrink-0 border-r border-line bg-panel">
      <div className="h-14 flex items-center px-3 border-b border-line">
        <Logo />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        {link(['/', t('Серверы'), <Server className="size-4" />])}
        {link(['/inspector', t('Инспектор'), <ScanSearch className="size-4" />])}
        {link(['/agents', t('Агенты'), <Container className="size-4" />])}
        {srv && (
          <>
            <div className="pt-4 pb-1 px-1">
              <div className="relative">
                <select className="input w-full pr-8 appearance-none font-medium" value={srv.id} onChange={e => go(withAt(`/s/${e.target.value}`, atOf(full)))}>
                  {servers.map(s => <option key={s.id} value={s.id}>{s.name}{s.kind === 'pgpool' ? ' (pgpool)' : ''}</option>)}
                </select>
                <ChevronDown className="size-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-faint" />
              </div>
            </div>
            {serverNav(srv.id, srv.kind, !!srv.summary?.cloud, srv.pgbouncers).map(([group, items]) => (
              <div key={group} className="pt-3">
                <div className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{group}</div>
                {items.map(link)}
              </div>
            ))}
          </>
        )}
      </nav>
      <div className="border-t border-line p-2 space-y-0.5">
        {link(['/docs', t('Документация'), <BookOpen className="size-4" />])}
        {link(['/profile', me.email, <User className="size-4" />])}
        <button className="nav-item w-full cursor-pointer" onClick={toggle}>
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}{dark ? t('Светлая тема') : t('Тёмная тема')}
        </button>
        <div className="px-1 py-1"><LangSwitch persist /></div>
        <button className="nav-item w-full cursor-pointer" onClick={() => api('/logout', 'POST').finally(() => location.reload())}>
          <LogOut className="size-4" />{t('Выйти')}
        </button>
      </div>
    </aside>
  )

  return (
    <div className="flex h-full">
      <div className="hidden lg:block">{sidebar}</div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 z-50">{sidebar}</div>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="lg:hidden h-12 flex items-center gap-2 px-3 border-b border-line bg-panel">
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)} aria-label={t('Меню')}>
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
          <Logo />
        </div>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}

// documentation section for each server page (#/docs/<slug>/<anchor>)
const HELP: Record<string, string> = {
  '': 'monitoring/overview', diagnostics: 'monitoring/diagnostics', chat: 'monitoring/ai-chat',
  queries: 'activity/queries', backends: 'activity/backends', locks: 'activity/locks',
  databases: 'objects/databases', tables: 'objects/tables', indexes: 'objects/indexes', 'index-management': 'objects/index-management',
  topk: 'objects/topk', tablespaces: 'objects/tablespaces', objects: 'objects/extensions', roles: 'objects/roles',
  replication: 'server/replication', wal: 'server/wal', vacuum: 'server/vacuum', config: 'server/config', system: 'server/system', logs: 'server/logs',
  cloud: 'integrations/cloud', pgbouncer: 'integrations/pgbouncer',
  alerts: 'alerts', 'change-alerts': 'change-alerts', settings: 'teams/server-settings',
}

export function ServerBar() {
  const sub = usePath().split('?')[0].split('/')[3] ?? ''
  const { srv, reportAt, pinnedAt, loading, range, setRange, refresh } = useSrv()
  // freshness is the server's liveness (its latest report), not the age of the report shown
  const last = Math.max(srv.last_report ? Date.parse(srv.last_report) / 1000 : 0, pinnedAt ? 0 : reportAt ?? 0) || null
  const stale = !!last && now() - last > 15 * 60
  return (
    <div className={cx('sticky top-0 z-30 bg-bg/85 backdrop-blur border-b border-line', !!pinnedAt && 'shadow-[inset_0_2px_0_var(--accent)]')}>
      <div className="flex flex-wrap items-center gap-2 px-6 min-h-14 py-2">
        <div className="flex items-center gap-2 min-w-40 flex-1">
          <span className={cx('size-2 rounded-full shrink-0', !last ? 'bg-faint' : stale ? 'bg-warn' : 'bg-good')} />
          <span className="font-semibold truncate">{srv.name}</span>
          {last && (
            <span className={cx('text-xs truncate', stale ? 'text-warn' : 'text-faint')} title={fmtTime(last)}>
              {pinnedAt ? t('последний отчёт {ago}', { ago: fmtAgo(last) }) : t('отчёт {ago}', { ago: fmtAgo(last) })}
            </span>
          )}
        </div>
        <ReportNav />
        <div className="flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label={t('Диапазон времени графиков')}>
          {RANGES.map(([r, l]) => (
            <button key={r} onClick={() => setRange(r)}
              className={cx('px-2.5 h-7 rounded-md text-xs font-medium cursor-pointer', r === range ? 'bg-accent text-white' : 'text-muted hover:text-fg')}>
              {t(l)}
            </button>
          ))}
        </div>
        <button className="btn btn-sm h-8" onClick={refresh} title={t('Обновить')}><RefreshCw className="size-3.5" /></button>
        <a className="btn btn-sm h-8" href={`#/s/${srv.id}/chat`} title={t('Спросить AI')}><Bot className="size-3.5" /></a>
        <a className="btn btn-sm h-8" href={'#/docs/' + (srv.kind === 'pgpool' && sub !== 'settings' ? 'integrations/pgpool' : HELP[sub] ?? 'ui')} title={t('Справка')}>
          <CircleHelp className="size-3.5" />
        </a>
      </div>
      {pinnedAt && reportAt && !loading && pinnedAt - reportAt > 15 * 60 && (
        <div role="status" className="px-6 py-1.5 text-xs text-warn bg-warn/10 border-t border-line">
          {t('Отчёта на {asked} нет. Показан ближайший более ранний — от {time}, на {dur} раньше.', { asked: fmtTime(pinnedAt), time: fmtTime(reportAt), dur: fmtDur(pinnedAt - reportAt) })}
        </div>
      )}
    </div>
  )
}
