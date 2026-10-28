import { useState } from 'react'
import { Cable } from 'lucide-react'
import { useApi } from '../../lib/api'
import { arr, useSrv } from '../../lib/server'
import { fmtAgo, fmtBytes, fmtDec, fmtInt, fmtMs, fmtNum, fmtPct, fmtTime, pct } from '../../lib/format'
import { Chart, Charts } from '../../components/Chart'
import { DataTable } from '../../components/Table'
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader, Section, Select, Stat, Stats } from '../../components/ui'
import { t } from '../../lib/i18n'

export function PgBouncer() {
  const { srv, id, tick, pinnedAt } = useSrv()
  const [picked, setName] = useState('')
  const name = srv.pgbouncers.includes(picked) ? picked : srv.pgbouncers[0] ?? ''
  const { data, error } = useApi<any>(name ? `/servers/${id}/report?source=${encodeURIComponent(name)}&at=${pinnedAt ?? ''}&t=${tick}` : null)
  const [db, setDb] = useState('')
  const [pool, setPool] = useState('')
  if (!name) {
    return <><PageHeader title="PgBouncer" /><Card><Empty icon={<Cable className="size-8" />} title={t('Нет отчётов PgBouncer')}>{t('Чтобы отправлять метрики PgBouncer для этого сервера, используйте')} <code className="mono">pgdash report-pgbouncer {srv.name} {t('ИМЯ')}</code>.</Empty></Card></>
  }
  const p = data?.pgbouncer
  const prefix = `pgb:${name}`
  const stats = arr(p?.stats)
  const pools = arr(p?.pools)
  const selDb = db || stats[0]?.db_name || ''
  const poolKey = (x: any) => `${x.db_name}/${x.user}`
  const selPool = pool || (pools[0] ? poolKey(pools[0]) : '')
  return (
    <>
      <PageHeader title="PgBouncer" sub={data ? t('Отчёт от {time}', { time: fmtTime(data.meta?.at) }) : undefined}
        actions={srv.pgbouncers.length > 1 ? <Select className="w-48" value={name} onChange={setName} options={srv.pgbouncers} /> : <Badge tone="accent">{name}</Badge>} />
      {error?.status === 404 && pinnedAt ? <Card><Empty icon={<Cable className="size-8" />} title={t('Нет отчёта PgBouncer на этот момент')} /></Card>
        : error ? <ErrorBox error={error} /> : !p ? <Loading /> : (
        <>
          <Stats>
            <Stat label={t('Активные клиентские соединения')} value={p.cc_active} />
            <Stat label={t('Ожидающие клиенты')} value={p.cc_waiting} tone={p.cc_waiting > 0 ? 'warn' : 'good'} />
            <Stat label={t('Макс. ожидание клиентов')} value={fmtMs(p.cc_maxwait * 1000)} tone={p.cc_maxwait > 1 ? 'warn' : undefined} sub={t('среднее {v}', { v: fmtMs(p.cc_avgwait * 1000) })} />
            <Stat label={t('Активные серверные соединения')} value={p.sc_active} />
            <Stat label={t('Простаивающие серверные соединения')} value={p.sc_idle} />
            <Stat label={t('Использованные серверные соединения')} value={p.sc_used} />
          </Stats>
          <Section title={t('Динамика соединений')}>
            <Charts>
              <Chart title={t('Клиентские соединения')} obj={prefix} unit="count" fields={[{ key: 'cc_active', label: t('Активные') }, { key: 'cc_waiting', label: t('Ожидающие') }, { key: 'cc_idle', label: t('Простаивающие') }]} />
              <Chart title={t('Серверные соединения')} obj={prefix} unit="count" fields={[{ key: 'sc_active', label: t('Активные') }, { key: 'sc_idle', label: t('Простаивающие') }, { key: 'sc_used', label: t('Использованные') }]} />
              <Chart title={t('Время ожидания клиентов')} obj={prefix} unit="secs" fields={[{ key: 'cc_maxwait', label: t('Макс.') }, { key: 'cc_avgwait', label: t('Среднее') }]} />
            </Charts>
          </Section>
          <Section title={t('Базы данных')}>
            <DataTable rows={arr(p.dbs)} cols={[
              { key: 'db_name', label: t('Имя'), render: d => <span className="font-medium">{d.db_name}</span> },
              { key: 'host', label: t('Целевой сервер'), value: d => `${d.host || 'local'}:${d.port}/${d.srcdb_name}` },
              { key: 'force_user', label: t('Пользователь (force_user)') },
              { key: 'current_connections', label: t('Соединения'), right: true, value: d => d.current_connections, render: d => `${d.current_connections}${d.max_connections ? ' / ' + d.max_connections : ''}` },
              { key: 'state', label: t('Состояние'), value: d => (d.disabled ? 'disabled' : d.paused ? 'paused' : 'ok'), render: d => d.disabled ? <Badge tone="crit">{t('отключена')}</Badge> : d.paused ? <Badge tone="warn">{t('приостановлена')}</Badge> : <Badge tone="good">{t('работает')}</Badge> },
            ]} />
          </Section>
          <Section title={t('Трафик по базам')} actions={stats.length > 0 && <Select className="w-48" value={selDb} onChange={setDb} options={stats.map(s => s.db_name)} />}>
            <DataTable rows={stats} sort={['total_query_count', true]} cols={[
              { key: 'db_name', label: t('База') },
              { key: 'total_xact_count', label: t('Транзакции'), right: true, render: s => fmtNum(s.total_xact_count) },
              { key: 'total_query_count', label: t('Запросы'), right: true, render: s => fmtNum(s.total_query_count) },
              { key: 'avg_query_time', label: t('Ср. время запроса'), right: true, render: s => fmtMs(s.avg_query_time * 1000) },
              { key: 'avg_wait_time', label: t('Ср. ожидание'), right: true, render: s => fmtMs(s.avg_wait_time * 1000) },
              { key: 'total_received', label: t('Получено'), right: true, render: s => fmtBytes(s.total_received) },
              { key: 'total_sent', label: t('Отправлено'), right: true, render: s => fmtBytes(s.total_sent) },
            ]} />
            {selDb && (
              <div className="mt-3"><Charts>
                <Chart title={t('Транзакции и запросы · {db}', { db: selDb })} obj={`${prefix}:db:${selDb}`} unit="oph" sub={t('в час')} fields={[{ key: 'xacts', label: t('Транзакции'), kind: 'rate', scale: 3600 }, { key: 'queries', label: t('Запросы'), kind: 'rate', scale: 3600 }]} />
                <Chart title={t('Сеть · {db}', { db: selDb })} obj={`${prefix}:db:${selDb}`} unit="Bps" fields={[{ key: 'received', label: t('Получено'), kind: 'rate' }, { key: 'sent', label: t('Отправлено'), kind: 'rate' }]} />
              </Charts></div>
            )}
          </Section>
          <Section title={t('Пулы')} actions={pools.length > 0 && <Select className="w-56" value={selPool} onChange={setPool} options={pools.map(poolKey)} />}>
            <DataTable rows={pools} cols={[
              { key: 'pool', label: t('Пул'), value: poolKey },
              { key: 'pool_mode', label: t('Режим') },
              { key: 'cl_active', label: t('Активные клиенты'), right: true },
              { key: 'cl_waiting', label: t('Ожидающие клиенты'), right: true, render: x => <span className={x.cl_waiting ? 'text-warn font-medium' : ''}>{x.cl_waiting}</span> },
              { key: 'sv_active', label: t('Активные серверы'), right: true },
              { key: 'sv_idle', label: t('Простаивающие серверы'), right: true },
              { key: 'sv_used', label: t('Использованные серверы'), right: true },
              { key: 'maxwait', label: t('Макс. ожидание'), right: true, render: x => fmtMs(x.maxwait * 1000) },
            ]} />
            {selPool && (
              <div className="mt-3"><Charts>
                <Chart title={t('Соединения · {pool}', { pool: selPool })} obj={`${prefix}:pool:${selPool}`} unit="count" fields={[{ key: 'cl_active', label: t('Активные клиенты') }, { key: 'cl_waiting', label: t('Ожидающие клиенты') }, { key: 'sv_active', label: t('Активные серверы') }, { key: 'sv_idle', label: t('Простаивающие серверы') }]} />
                <Chart title={t('Ожидание клиентов · {pool}', { pool: selPool })} obj={`${prefix}:pool:${selPool}`} unit="secs" fields={[{ key: 'maxwait', label: t('Макс. ожидание') }]} />
              </Charts></div>
            )}
          </Section>
        </>
      )}
    </>
  )
}

const statusTone = (s: string) => (s === 'up' || s === 'waiting' ? 'good' : s === 'down' ? 'crit' : 'warn') as any

export function Pgpool() {
  const { report } = useSrv()
  const R = report!
  const p = R.pgpool
  const at = R.meta.at
  const backends = arr(p?.backends)
  const [node, setNode] = useState(String(backends[0]?.node_id ?? '0'))
  if (!p) return <Empty title={t('Это не отчёт Pgpool')} />
  const q = p.query_cache ?? {}
  const up = backends.filter(b => b.status === 'up' || b.status === 'waiting').length
  return (
    <>
      <PageHeader title="Pgpool" sub={t('Pgpool-II {version} · отчёт {ago}', { version: p.version, ago: fmtAgo(at) })} />
      <Stats>
        <Stat label={t('Бэкенды в работе')} value={`${up} / ${backends.length}`} tone={up < backends.length ? 'warn' : 'good'} />
        <Stat label={t('Попадания в кеш запросов')} value={fmtPct(q.cache_hit_ratio * 100)} />
        <Stat label={t('Попаданий в кеш')} value={fmtNum(q.num_cache_hits)} sub={t('из {n} SELECT', { n: fmtNum(q.num_selects) })} />
        <Stat label={t('Записи кеша')} value={fmtInt(q.num_cache_entries)} sub={t('хеш-записей: {used} / {total}', { used: fmtInt(q.used_hash_entries), total: fmtInt(q.num_hash_entries) })} />
        <Stat label={t('Занято в кеше')} value={fmtBytes(q.used_cache_entries_size)} sub={t('свободно {free}', { free: fmtBytes(q.free_cache_entries_size) })} />
        <Stat label={t('Фрагментировано')} value={fmtBytes(q.fragment_cache_entries_size)} />
      </Stats>
      <Section title={t('Бэкенды')}>
        <DataTable rows={backends} cols={[
          { key: 'node_id', label: t('Узел'), right: true },
          { key: 'host', label: t('Хост'), value: b => `${b.hostname}:${b.port}` },
          { key: 'status', label: t('Статус'), render: b => <Badge tone={statusTone(b.status)}>{b.status}</Badge> },
          { key: 'role', label: t('Роль'), value: b => b.role || b.pg_role },
          { key: 'lb_weight', label: t('Вес балансировки'), right: true },
          { key: 'load_balance_node', label: t('Узел балансировки'), render: b => (b.load_balance_node ? t('да') : '') },
          { key: 'select_cnt', label: 'SELECT', right: true, render: b => fmtNum(b.select_cnt) },
          { key: 'writes', label: t('Запись'), right: true, value: b => b.insert_cnt + b.update_cnt + b.delete_cnt, render: b => fmtNum(b.insert_cnt + b.update_cnt + b.delete_cnt) },
          { key: 'errors', label: t('Ошибки'), right: true, value: b => b.error_cnt + b.fatal_cnt + b.panic_cnt, render: b => <span className={b.error_cnt + b.fatal_cnt + b.panic_cnt ? 'text-crit' : ''}>{fmtInt(b.error_cnt + b.fatal_cnt + b.panic_cnt)}</span> },
          { key: 'repl', label: t('Отставание репликации'), right: true, value: b => b.replication_delay, render: b => (b.replication_delay_secs ? `${fmtDec(b.replication_delay_secs, 1)} ${t('с')}` : fmtBytes(b.replication_delay)) },
          { key: 'replication_state', label: t('Состояние репл.'), value: b => [b.replication_state, b.replication_sync_state].filter(Boolean).join(' / ') },
        ]} />
      </Section>
      <Section title={t('Проверки состояния')}>
        <DataTable rows={backends} cols={[
          { key: 'node_id', label: t('Узел'), right: true },
          { key: 'total_count', label: t('Всего'), right: true, render: b => fmtInt(b.total_count) },
          { key: 'success', label: t('Доля успешных'), right: true, value: b => pct(b.success_count, b.total_count), render: b => fmtPct(pct(b.success_count, b.total_count)) },
          { key: 'fail_count', label: t('Неудачные'), right: true, render: b => <span className={b.fail_count ? 'text-crit' : ''}>{fmtInt(b.fail_count)}</span> },
          { key: 'skip_count', label: t('Пропущенные'), right: true },
          { key: 'retry_count', label: t('Повторы'), right: true },
          { key: 'average_duration', label: t('Ср. длительность'), right: true, render: b => fmtMs(b.average_duration) },
          { key: 'max_duration', label: t('Макс. длительность'), right: true, render: b => fmtMs(b.max_duration) },
          { key: 'last_health_check', label: t('Последняя проверка'), right: true, render: b => fmtAgo(b.last_health_check, at) },
          { key: 'last_failed_health_check', label: t('Последний сбой'), right: true, render: b => fmtAgo(b.last_failed_health_check, at) },
        ]} />
      </Section>
      <Section title={t('Динамика')} actions={<Select className="w-40" value={node} onChange={setNode} options={backends.map(b => [String(b.node_id), t('Узел {id}', { id: b.node_id })] as [string, string])} />}>
        <Charts>
          <Chart title={t('Кеш запросов')} obj="" unit="ops" fields={[{ key: 'selects', label: 'SELECT', kind: 'rate' }, { key: 'cache_hits', label: t('Попаданий в кеш'), kind: 'rate' }]} />
          <Chart title={t('Бэкенды в работе')} obj="" unit="count" fields={[{ key: 'backends_up', label: t('В работе') }, { key: 'backends', label: t('Всего') }]} />
          <Chart title={t('Операторы · узел {node}', { node })} obj={`be:${node}`} unit="ops" fields={[{ key: 'select', label: 'SELECT', kind: 'rate' }, { key: 'insert', label: 'INSERT', kind: 'rate' }, { key: 'update', label: 'UPDATE', kind: 'rate' }, { key: 'delete', label: 'DELETE', kind: 'rate' }]} />
          <Chart title={t('Отставание репликации · узел {node}', { node })} obj={`be:${node}`} unit="secs" fields={[{ key: 'repl_delay_secs', label: t('Отставание') }]} />
        </Charts>
      </Section>
    </>
  )
}
