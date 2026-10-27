import { Fragment, type ReactNode } from 'react'
import { Cable, Database, Server } from 'lucide-react'
import { t } from '../lib/i18n'
import { useApp, type ServerRow } from '../lib/server'
import { fmtAgo, fmtBytes, fmtPct, now, plural } from '../lib/format'
import { Badge, Card, Code, Empty, PageHeader, SevIcon, cx } from '../components/ui'

// rich(t('Нажмите {link}.'), { link: <a>…</a> }) fills {placeholders} of a translated string with React nodes
export function rich(s: string, parts: Record<string, ReactNode>): ReactNode[] {
  return s.split(/\{(\w+)\}/).map((p, i) => (i % 2 ? <Fragment key={i}>{parts[p]}</Fragment> : p))
}

export function setupCommands(apikey: string, base: string, name = 'my-server') {
  return `# ${t('соберите метрики с помощью pgmetrics и отправьте их через pgdash CLI')}
pgmetrics --no-password -f json -h DBHOST -U DBUSER db1 db2 \\
  | pgdash -a ${apikey} --base-url=${base}/api/v1 report ${name}`
}

function ServerCard({ s }: { s: ServerRow }) {
  const sum = s.summary ?? {}
  const last = s.last_report ? Math.floor(new Date(s.last_report).getTime() / 1000) : 0
  const stale = !last || now() - last > 15 * 60
  const crit = s.alerts.filter(a => a.type === 'crit').length
  const warn = s.alerts.length - crit
  const stat = (label: string, v: string, tone?: string) => (
    <div className="min-w-0">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={cx('font-semibold tabular-nums truncate', tone)}>{v}</div>
    </div>
  )
  return (
    <a href={`#/s/${s.id}`} className="card p-4 hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5 transition-all group block">
      <div className="flex items-start gap-3">
        <div className={cx('size-9 rounded-lg grid place-items-center shrink-0', s.kind === 'pgpool' ? 'bg-amber-500/10 text-amber-500' : 'bg-accent/10 text-accent')}>
          {s.kind === 'pgpool' ? <Cable className="size-4.5" /> : <Database className="size-4.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate group-hover:text-accent">{s.name}</span>
            {!s.is_owner && <Badge>{t('общий')}</Badge>}
          </div>
          <div className="text-xs text-muted truncate">
            {s.kind === 'pgpool' ? `Pgpool ${sum.version ?? ''}` : `PostgreSQL ${sum.version ?? '—'}`}
            {sum.recovery && ' · ' + t('реплика')}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {crit > 0 && <Badge tone="crit"><SevIcon sev="crit" className="size-3" />{crit}</Badge>}
          {warn > 0 && <Badge tone="warn"><SevIcon sev="warn" className="size-3" />{warn}</Badge>}
          {crit + warn === 0 && <Badge tone="good"><SevIcon sev="good" className="size-3" />{t('Норма')}</Badge>}
        </div>
      </div>
      {s.kind === 'pgpool' ? (
        <div className="grid grid-cols-3 gap-3 mt-4">
          {stat(t('Бэкенды в работе'), `${sum.backends_up ?? 0}/${sum.backends ?? 0}`, sum.backends_up < sum.backends ? 'text-warn' : '')}
          {stat(t('Попадания в кеш'), fmtPct((sum.cache_hit_ratio ?? 0) * 100))}
          {stat(t('Отчёт'), fmtAgo(last))}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3 mt-4">
          {stat(t('Бэкенды'), `${sum.backends ?? 0}/${sum.max_conn ?? 0}`)}
          {stat(t('Размер'), fmtBytes(sum.size))}
          {stat(t('Попадания в кеш'), fmtPct(sum.cache_hit), sum.cache_hit < 90 ? 'text-warn' : '')}
          {stat(t('Отчёт'), fmtAgo(last), stale ? 'text-warn' : '')}
        </div>
      )}
      {s.pgbouncers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {s.pgbouncers.map(p => <Badge key={p} tone="accent"><Cable className="size-3" />{p}</Badge>)}
        </div>
      )}
    </a>
  )
}

export function Home() {
  const { servers, me } = useApp()
  return (
    <>
      <PageHeader title={t('Серверы')} help="fleet/servers" sub={t('{n} {servers} под мониторингом', { n: servers.length, servers: plural(servers.length, ['сервер', 'сервера', 'серверов']) })} />
      {servers.length === 0 ? (
        <Card>
          <Empty icon={<Server className="size-8" />} title={t('Серверов пока нет')}>
            {t('Отправьте первый отчёт pgmetrics, и сервер появится здесь.')}
          </Empty>
          {me.apikey && <div className="max-w-3xl mx-auto pb-4"><Code>{setupCommands(me.apikey, me.base_url)}</Code></div>}
          <p className="text-center text-xs text-muted pb-2">
            {rich(t('Другие варианты подключения — на {link}.'), { link: <a className="link" href="#/profile">{t('странице профиля')}</a> })}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
          {servers.map(s => <ServerCard key={s.id} s={s} />)}
        </div>
      )}
    </>
  )
}
