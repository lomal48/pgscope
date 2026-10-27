import { useState } from 'react'
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Clock, Database, Gauge, Server, Users } from 'lucide-react'
import { useApi } from '../../lib/api'
import { go } from '../../lib/router'
import { arr, setting, settingNum, useSrv } from '../../lib/server'
import { fmtAgo, fmtBytes, fmtDur, fmtInt, fmtPct, fmtTime, pct, plural } from '../../lib/format'
import { t, tk } from '../../lib/i18n'
import { Chart, Charts } from '../../components/Chart'
import { DataTable } from '../../components/Table'
import { Badge, Card, Empty, ErrorBox, KV, Loading, PageHeader, Section, SevBadge, SevIcon, Stat, Stats, Tabs, cx } from '../../components/ui'

export function Overview() {
  const { report: r, srv } = useSrv()
  const R = r!
  const dbs = arr(R.databases)
  const size = dbs.reduce((a, d) => a + (d.size > 0 ? d.size : 0), 0)
  const hit = dbs.reduce((a, d) => a + d.blks_hit, 0)
  const read = dbs.reduce((a, d) => a + d.blks_read, 0)
  const maxConn = settingNum(R, 'max_connections')
  const backends = arr(R.backends).length
  // XIDs are 32-bit and wrap around: count modulo 2^32, as PostgreSQL does (0 = oldest_xid not collected)
  const xidUsed = R.oldest_xid ? (R.next_xid - R.oldest_xid) >>> 0 : NaN
  const xidPct = pct(xidUsed, 2147483647)
  const at = R.meta.at
  const sys = R.system
  const alerts = srv.alerts
  // user_agent is "pgmetrics/1.19.1"; meta.version is only the report schema version
  const collector = R.meta.user_agent?.replace('/', ' ') || t('pgmetrics (схема отчёта {v})', { v: R.meta.version })

  return (
    <>
      <PageHeader title={t('Обзор')} sub={R.full_version || `PostgreSQL ${setting(R, 'server_version')}`}
        actions={<Badge tone={R.is_in_recovery ? 'info' : 'accent'}>{R.is_in_recovery ? t('Реплика') : t('Ведущий')}</Badge>} />
      <Stats>
        <Stat label={t('Версия')} icon={<Server className="size-3.5" />} value={setting(R, 'server_version')?.split(' ')[0]} sub={sys?.hostname} />
        <Stat label={t('Время работы')} icon={<Clock className="size-3.5" />} value={fmtDur(at - R.start_time)} sub={t('с {time}', { time: fmtTime(R.start_time) })} />
        <Stat label={t('Бэкенды')} icon={<Users className="size-3.5" />} value={`${backends} / ${maxConn}`}
          tone={backends > 0.9 * maxConn ? 'crit' : backends > 0.75 * maxConn ? 'warn' : undefined} sub={t('{pct} от max_connections', { pct: fmtPct(pct(backends, maxConn), 0) })} />
        <Stat label={t('Базы данных')} icon={<Database className="size-3.5" />} value={dbs.length} sub={t('всего {size}', { size: fmtBytes(size) })} />
        <Stat label={t('Попадания в кеш')} icon={<Gauge className="size-3.5" />} value={fmtPct(pct(hit, hit + read))} tone={pct(hit, hit + read) < 90 ? 'warn' : 'good'} sub={t('все базы, с момента сброса статистики')} />
        <Stat label={t('Оповещения')} value={alerts.length || t('Нет')} tone={alerts.some(a => a.type === 'crit') ? 'crit' : alerts.length ? 'warn' : 'good'}
          sub={<a className="link" href={`#/s/${srv.id}/alerts`}>{t('открыть оповещения')}</a>} />
      </Stats>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 mt-3">
        <Card title={t('Кластер')} className="xl:col-span-2">
          <KV items={[
            [t('Системный идентификатор'), <span className="mono">{R.system_identifier}</span>],
            [t('Линия времени'), R.timeline_id],
            [t('Последняя контрольная точка'), <span title={fmtTime(R.checkpoint_time)}>{fmtAgo(R.checkpoint_time, at)}</span>],
            [t('LSN контрольной точки / REDO'), <span className="mono">{R.checkpoint_lsn} / {R.redo_lsn}</span>],
            [R.is_in_recovery ? t('LSN воспроизведения') : t('Текущий LSN WAL'), <span className="mono">{(R.is_in_recovery ? R.last_wal_replay_lsn : R.wal_lsn) || '—'}</span>],
            [t('Идентификаторы транзакций'), <span title={t('самый старый {oldest}, следующий {next}', { oldest: R.oldest_xid, next: R.next_xid })}>{t('использовано {n} ({pct})', { n: fmtInt(xidUsed), pct: fmtPct(xidPct) })}</span>],
            [t('Очередь уведомлений'), fmtPct((R.notification_queue_usage ?? 0) * 100)],
            [t('Конфигурация перечитана'), R.conf_load_time ? fmtAgo(R.conf_load_time, at) : '—'],
            [t('Каталог данных'), <span className="mono">{setting(R, 'data_directory') || '—'}</span>],
            [t('Собрано'), R.meta.local ? t('{collector} (локально)', { collector }) : collector],
          ]} />
        </Card>
        <Card title={t('Активные оповещения')} actions={<a className="btn btn-sm btn-ghost" href={`#/s/${srv.id}/alerts`}>{t('Управление')}<ArrowRight className="size-3.5" /></a>}>
          {alerts.length === 0 ? (
            <div className="flex items-center gap-2 text-muted py-6 justify-center"><CheckCircle2 className="size-4 text-good" />{t('Нет сработавших оповещений')}</div>
          ) : (
            <ul className="space-y-2 max-h-64 overflow-y-auto">
              {alerts.slice(0, 20).map((a, i) => (
                <li key={i} className="flex gap-2 items-start">
                  <SevIcon sev={a.type} className="size-4 mt-0.5" />
                  <div className="min-w-0">
                    <div className="truncate">{a.text}</div>
                    <div className="text-xs text-muted truncate">{a.objname} · {a.value}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Section title={t('Активность')}>
        <Charts>
          <Chart title={t('Транзакции')} obj="" unit="ops" fields={[{ key: 'xact_commit', label: t('Фиксации'), kind: 'rate' }, { key: 'xact_rollback', label: t('Откаты'), kind: 'rate' }]} />
          <Chart title={t('Бэкенды')} obj="" unit="count" fields={[{ key: 'backends', label: t('Всего') }, { key: 'active', label: t('Активные') }, { key: 'idle_in_xact', label: t('Простой в транзакции') }, { key: 'waiting', label: t('Ждут блокировок') }]} />
          <Chart title={t('Строки')} obj="" unit="ops" fields={[{ key: 'tup_fetched', label: t('Выбрано'), kind: 'rate' }, { key: 'tup_inserted', label: t('Вставлено'), kind: 'rate' }, { key: 'tup_updated', label: t('Обновлено'), kind: 'rate' }, { key: 'tup_deleted', label: t('Удалено'), kind: 'rate' }]} />
          <Chart title={t('Попадания в кеш')} obj="" unit="pct" fields={[{ key: 'hit', label: t('Доля попаданий'), kind: 'hit', of: ['blks_hit', 'blks_read'] }]} />
          <Chart title={t('Генерация WAL')} obj="" unit="Bps" fields={[{ key: 'lsn', label: 'WAL', kind: 'rate' }]} />
          <Chart title={t('Общий размер баз данных')} obj="" unit="bytes" fields={[{ key: 'size', label: t('Размер') }]} />
          <Chart title={t('Запись временных файлов')} obj="" unit="Bps" fields={[{ key: 'temp_bytes', label: t('Временные файлы'), kind: 'rate' }]} />
          <Chart title={t('Диапазон идентификаторов транзакций')} obj="" unit="count" fields={[{ key: 'xid_range', label: t('Используемые XID') }]} />
          {sys && <Chart title={t('Средняя нагрузка')} obj="" unit="count" fields={[{ key: 'load', label: t('Нагрузка (1 мин)') }]} />}
          {sys && <Chart title={t('Память')} obj="" unit="bytes" fields={[{ key: 'mem_used', label: t('Занято') }, { key: 'mem_cached', label: t('Кеш') }, { key: 'mem_buffers', label: t('Буферы') }, { key: 'mem_free', label: t('Свободно') }]} />}
        </Charts>
      </Section>

      <Section title={t('Базы данных')} actions={<a className="btn btn-sm btn-ghost" href={`#/s/${srv.id}/databases`}>{t('Все базы')}<ArrowRight className="size-3.5" /></a>}>
        <DataTable rows={dbs} onRow={d => go(`/s/${srv.id}/databases/${encodeURIComponent(d.name)}`)} sort={['size', true]} pageSize={10} cols={[
          { key: 'name', label: t('База данных'), render: d => <span className="font-medium">{d.name}</span> },
          { key: 'size', label: t('Размер'), right: true, render: d => fmtBytes(d.size) },
          { key: 'numbackends', label: t('Бэкенды'), right: true },
          { key: 'commit', label: t('Доля фиксаций'), right: true, value: d => pct(d.xact_commit, d.xact_commit + d.xact_rollback), render: d => fmtPct(pct(d.xact_commit, d.xact_commit + d.xact_rollback)) },
          { key: 'hit', label: t('Попадания в кеш'), right: true, value: d => pct(d.blks_hit, d.blks_hit + d.blks_read), render: d => fmtPct(pct(d.blks_hit, d.blks_hit + d.blks_read)) },
          { key: 'age_datfrozenxid', label: t('Возраст XID'), right: true, render: d => fmtInt(d.age_datfrozenxid) },
        ]} />
      </Section>
    </>
  )
}

type Issue = { severity: string; category: string; title: string; detail: string; items?: string[]; link?: string }
type Rec = { category: string; category_id: string; severity: string; setting: string; current: string; advice: string }

const CONFIG_CATS = [
  ['security', tk('Безопасность')],
  ['data_safety', tk('Сохранность данных')],
  ['performance', tk('Производительность')],
  ['reliability', tk('Надёжность')],
]

function IssueCard({ i, id }: { i: Issue; id: number }) {
  const [open, setOpen] = useState(i.severity === 'crit')
  const n = i.items?.length ?? 0
  return (
    <div className={cx('card p-4 border-l-4', i.severity === 'crit' ? 'border-l-crit' : i.severity === 'warn' ? 'border-l-warn' : 'border-l-info')}>
      <div className="flex items-start gap-3">
        <SevIcon sev={i.severity} className="size-5 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{i.title}</span>
            <Badge>{i.category}</Badge>
            {n > 0 && <span className="text-xs text-faint">{n} {plural(n, ['объект', 'объекта', 'объектов'])}</span>}
          </div>
          <p className="text-muted mt-1">{i.detail}</p>
          {n > 0 && (
            <button className="text-xs text-accent mt-2 inline-flex items-center gap-1 cursor-pointer" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{open ? t('Скрыть') : t('Подробнее')}
            </button>
          )}
          {open && n > 0 && (
            <ul className="mt-2 space-y-1 mono text-muted bg-panel-2 rounded-lg p-3 max-h-72 overflow-y-auto">
              {i.items!.map((x, k) => <li key={k} className="break-all">{x}</li>)}
            </ul>
          )}
        </div>
        {i.link && <a className="btn btn-sm" href={`#/s/${id}${i.link}`}>{t('Открыть')}<ArrowRight className="size-3.5" /></a>}
      </div>
    </div>
  )
}

export function Diagnostics() {
  const { id, pinnedAt, tick } = useSrv()
  const { data, error } = useApi<{ at: number; issues: Issue[]; config: Rec[] }>(`/servers/${id}/diagnostics?at=${pinnedAt ?? ''}&t=${tick}`)
  const [tab, setTab] = useState<'issues' | 'config'>('issues')
  if (error) return error.status === 404 ? <Empty title={t('Отчёт ещё не получен')} /> : <ErrorBox error={error} />
  if (!data) return <Loading />
  const count = (s: string) => data.issues.filter(i => i.severity === s).length
  return (
    <>
      <PageHeader title={t('Диагностика')} sub={t('Автоматические проверки отчёта от {time}', { time: fmtTime(data.at) })} />
      <div className="grid grid-cols-3 gap-3 max-w-xl">
        <Stat label={t('Критично')} value={count('crit')} tone={count('crit') ? 'crit' : 'good'} />
        <Stat label={t('Предупреждения')} value={count('warn')} tone={count('warn') ? 'warn' : 'good'} />
        <Stat label={t('Советы')} value={count('info')} tone="info" />
      </div>
      <div className="mt-5">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'issues', label: t('Проблемы'), count: data.issues.length }, { id: 'config', label: t('Проверка конфигурации'), count: data.config.length }]} />
      </div>
      <div className="mt-4 grid gap-3">
        {tab === 'issues' && (data.issues.length === 0
          ? <Card><Empty icon={<CheckCircle2 className="size-8 text-good" />} title={t('Проблем не найдено')}>{t('Сервер в порядке.')}</Empty></Card>
          : data.issues.map((i, k) => <IssueCard key={k} i={i} id={id} />))}
        {tab === 'config' && CONFIG_CATS.map(([cat, label]) => {
          const recs = data.config.filter(c => c.category_id === cat)
          return (
            <Card key={cat} title={t(label)} sub={recs.length ? `${recs.length} ${plural(recs.length, ['рекомендация', 'рекомендации', 'рекомендаций'])}` : t('Рекомендаций нет')}>
              {recs.length === 0 ? <div className="flex items-center gap-2 text-muted"><CheckCircle2 className="size-4 text-good" />{t('Всё в порядке')}</div> : (
                <ul className="divide-y divide-line">
                  {recs.map(c => (
                    <li key={c.setting} className="py-2.5 flex gap-3 items-start">
                      <SevBadge sev={c.severity} />
                      <div className="min-w-0 flex-1">
                        <div><span className="mono font-medium">{c.setting}</span> <span className="text-faint">=</span> <span className="mono">{c.current}</span></div>
                        <div className="text-muted">{c.advice}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )
        })}
      </div>
    </>
  )
}

