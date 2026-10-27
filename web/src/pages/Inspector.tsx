import { useState } from 'react'
import { go } from '../lib/router'
import { useApp, type ServerRow } from '../lib/server'
import { fmtAgo, fmtBytes, fmtDec, fmtDur, fmtInt, fmtPct, now } from '../lib/format'
import { DataTable, type Col } from '../components/Table'
import { Badge, Bar, PageHeader, Tabs } from '../components/ui'
import { t } from '../lib/i18n'

type Tab = 'servers' | 'databases' | 'replication' | 'vacuum' | 'disk'

const lastTs = (s: ServerRow) => (s.last_report ? Math.floor(new Date(s.last_report).getTime() / 1000) : 0)
const tone = (bad: boolean, warn = false) => (bad ? 'text-crit font-medium' : warn ? 'text-warn font-medium' : '')
// load and memory come from host metrics, which pgmetrics collects (with the hostname) only on Linux over a local connection
const hostKnown = (s: ServerRow) => !!s.summary!.hostname
const na = () => <span className="text-faint">{t('н/д')}</span>

// fleet-wide dashboards across every server the user can see
export function Inspector() {
  const { servers } = useApp()
  const [tab, setTab] = useState<Tab>('servers')
  const pg = servers.filter(s => s.kind === 'postgres' && s.summary)
  const S = (s: ServerRow) => s.summary!
  const name: Col<ServerRow> = { key: 'name', label: t('Сервер'), value: s => s.name, render: s => <span className="font-medium">{s.name}</span> }

  const dbs = pg.flatMap(s => (S(s).dbs ?? []).map((d: any) => ({ ...d, server: s })))

  return (
    <>
      <PageHeader title={t('Инспектор')} help="fleet/inspector" sub={t('Ключевые показатели состояния всех ваших серверов')} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'servers', label: t('Серверы'), count: pg.length }, { id: 'databases', label: t('Базы данных'), count: dbs.length },
        { id: 'replication', label: t('Репликация') }, { id: 'vacuum', label: t('Идентификаторы транзакций') }, { id: 'disk', label: t('Диск и WAL') },
      ]} />
      <div className="mt-4">
        {tab === 'servers' && (
          <DataTable rows={pg} onRow={s => go(`/s/${s.id}`)} search={s => s.name} sort={['name', false]} cols={[
            name,
            { key: 'version', label: t('Версия'), value: s => S(s).version },
            { key: 'role', label: t('Роль'), value: s => (S(s).recovery ? t('реплика') : t('ведущий')), render: s => <Badge tone={S(s).recovery ? 'info' : 'accent'}>{S(s).recovery ? t('реплика') : t('ведущий')}</Badge> },
            { key: 'uptime', label: t('Время работы'), right: true, value: s => now() - S(s).start, render: s => fmtDur(now() - S(s).start) },
            { key: 'backends', label: t('Бэкенды'), right: true, value: s => S(s).backends / (S(s).max_conn || 1), render: s => <span className={tone(S(s).backends > 0.9 * S(s).max_conn, S(s).backends > 0.75 * S(s).max_conn)}>{S(s).backends}/{S(s).max_conn}</span> },
            { key: 'waiting', label: t('Ожидают'), right: true, value: s => S(s).waiting, render: s => <span className={tone(false, S(s).waiting > 0)}>{S(s).waiting}</span> },
            { key: 'idlex', label: t('Простой в транзакции'), right: true, value: s => S(s).idle_in_xact, render: s => <span className={tone(false, S(s).idle_in_xact > 0)}>{S(s).idle_in_xact}</span> },
            { key: 'size', label: t('Размер'), right: true, value: s => S(s).size, render: s => fmtBytes(S(s).size) },
            { key: 'hit', label: t('Попадания в кеш'), right: true, value: s => S(s).cache_hit, render: s => <span className={tone(S(s).cache_hit < 80, S(s).cache_hit < 95)}>{fmtPct(S(s).cache_hit)}</span> },
            { key: 'commit', label: t('Доля фиксаций'), right: true, value: s => S(s).commit_ratio, render: s => fmtPct(S(s).commit_ratio) },
            { key: 'alerts', label: t('Оповещения'), right: true, value: s => s.alerts.length, render: s => s.alerts.length ? <Badge tone={s.alerts.some(a => a.type === 'crit') ? 'crit' : 'warn'}>{s.alerts.length}</Badge> : <span className="text-faint">0</span> },
            { key: 'report', label: t('Последний отчёт'), right: true, value: lastTs, render: s => <span className={tone(false, now() - lastTs(s) > 900)}>{fmtAgo(lastTs(s))}</span> },
          ]} />
        )}
        {tab === 'databases' && (
          <DataTable rows={dbs} onRow={d => go(`/s/${d.server.id}/databases/${encodeURIComponent(d.name)}`)} search={d => d.server.name + ' ' + d.name} sort={['size', true]} cols={[
            { key: 'server', label: t('Сервер'), value: d => d.server.name },
            { key: 'name', label: t('База данных'), render: d => <span className="font-medium">{d.name}</span> },
            { key: 'size', label: t('Размер'), right: true, render: d => fmtBytes(d.size) },
            { key: 'backends', label: t('Бэкенды'), right: true },
            { key: 'cache_hit', label: t('Попадания в кеш'), right: true, render: d => <span className={tone(d.cache_hit < 80, d.cache_hit < 95)}>{fmtPct(d.cache_hit)}</span> },
            { key: 'commit_ratio', label: t('Доля фиксаций'), right: true, render: d => <span className={tone(false, d.commit_ratio < 90)}>{fmtPct(d.commit_ratio)}</span> },
            { key: 'xid_age_pct', label: t('Возраст XID / лимит заморозки'), right: true, render: d => <span className={tone(d.xid_age_pct > 150, d.xid_age_pct > 100)}>{fmtPct(d.xid_age_pct, 0)}</span> },
            { key: 'deadlocks', label: t('Взаимоблокировки'), right: true, render: d => fmtInt(d.deadlocks) },
            { key: 'temp_bytes', label: t('Временные файлы'), right: true, render: d => fmtBytes(d.temp_bytes) },
          ]} />
        )}
        {tab === 'replication' && (
          <DataTable rows={pg} onRow={s => go(`/s/${s.id}/replication`)} sort={['lag', true]} cols={[
            name,
            { key: 'role', label: t('Роль'), value: s => (S(s).recovery ? t('реплика') : t('ведущий')) },
            { key: 'replicas', label: t('Реплики'), right: true, value: s => S(s).replicas },
            { key: 'lag', label: t('Макс. отставание'), right: true, value: s => S(s).repl_lag_bytes, render: s => <span className={tone(S(s).repl_lag_bytes > 1 << 30, S(s).repl_lag_bytes > 64 << 20)}>{fmtBytes(S(s).repl_lag_bytes)}</span> },
            { key: 'lagsecs', label: t('Макс. отставание по времени'), right: true, value: s => S(s).repl_lag_secs, render: s => fmtDur(S(s).repl_lag_secs) },
            { key: 'slots', label: t('Неактивные слоты'), right: true, value: s => S(s).inactive_slots, render: s => <span className={tone(false, S(s).inactive_slots > 0)}>{S(s).inactive_slots}</span> },
          ]} />
        )}
        {tab === 'vacuum' && (
          <DataTable rows={pg} onRow={s => go(`/s/${s.id}/vacuum`)} sort={['xid', true]} cols={[
            name,
            { key: 'xid', label: t('Использовано диапазона XID'), value: s => S(s).xid_range_pct, render: s => (
              <div className="flex items-center gap-3 justify-end">
                <Bar className="w-40" value={S(s).xid_range_pct} tone={S(s).xid_range_pct > 75 ? 'crit' : S(s).xid_range_pct > 40 ? 'warn' : 'good'} />
                <span className="tabular-nums w-14 text-right">{fmtPct(S(s).xid_range_pct)}</span>
              </div>
            ), right: true },
            { key: 'maxdb', label: t('Самая старая база (% от freeze_max_age)'), right: true, value: s => Math.max(0, ...(S(s).dbs ?? []).map((d: any) => d.xid_age_pct)),
              render: s => fmtPct(Math.max(0, ...(S(s).dbs ?? []).map((d: any) => d.xid_age_pct)), 0) },
            { key: 'long', label: t('Долгие транзакции'), right: true, value: s => S(s).long_xact, render: s => <span className={tone(false, S(s).long_xact > 0)}>{S(s).long_xact}</span> },
          ]} />
        )}
        {tab === 'disk' && (
          <DataTable rows={pg} onRow={s => go(`/s/${s.id}/wal`)} sort={['free', false]} cols={[
            name,
            { key: 'free', label: t('Мин. свободно на диске'), right: true, value: s => (S(s).disk_free_pct < 0 ? null : S(s).disk_free_pct), render: s => S(s).disk_free_pct < 0 ? na() : <span className={tone(S(s).disk_free_pct < 10, S(s).disk_free_pct < 20)}>{fmtPct(S(s).disk_free_pct)}</span> },
            { key: 'wal', label: t('Файлы WAL'), right: true, value: s => S(s).wal_count },
            { key: 'ready', label: t('Готовы к архивации'), right: true, value: s => S(s).wal_ready, render: s => <span className={tone(false, S(s).wal_ready > 10)}>{S(s).wal_ready}</span> },
            { key: 'arch', label: t('Архивация'), value: s => (S(s).archive_failed ? 1 : 0), render: s => S(s).archive_failed ? <Badge tone="crit">{t('сбой')}</Badge> : <Badge tone="good">{t('норма')}</Badge> },
            { key: 'load', label: t('Средняя нагрузка'), right: true, value: s => (hostKnown(s) ? S(s).load : null), render: s => hostKnown(s) ? fmtDec(S(s).load, 2, true) : na() },
            { key: 'mem', label: t('Использовано памяти'), right: true, value: s => (hostKnown(s) ? S(s).mem_used_pct : null), render: s => hostKnown(s) ? fmtPct(S(s).mem_used_pct) : na() },
          ]} />
        )}
      </div>
    </>
  )
}
