import { Fragment, useState, type ReactNode } from 'react'
import { Cloud, Cpu, FileText, GitBranch } from 'lucide-react'
import { useApi } from '../../lib/api'
import { arr, setting, settingNum, useSrv } from '../../lib/server'
import { fmtAgo, fmtBytes, fmtDec, fmtDur, fmtInt, fmtMs, fmtNum, fmtPct, fmtSetting, fmtTime, lsn, pct, plural } from '../../lib/format'
import { t } from '../../lib/i18n'
import { Chart, Charts, fmtUnit, type Unit } from '../../components/Chart'
import { DataTable } from '../../components/Table'
import { Badge, Bar, Card, Empty, ErrorBox, KV, PageHeader, Section, Select, SevBadge, Stat, Stats, Tabs, cx } from '../../components/ui'

const curLSN = (R: any) => lsn(R.is_in_recovery ? R.last_wal_replay_lsn : R.wal_lsn)

// fill {placeholders} of an already translated string with elements
const rich = (s: string, vars: Record<string, ReactNode>) =>
  s.split(/\{(\w+)\}/).map((p, i) => (i % 2 ? <Fragment key={i}>{vars[p]}</Fragment> : p))

//------------------------------------------------------------------------------
// replication

export function Replication() {
  const { report } = useSrv()
  const R = report!
  const at = R.meta.at
  const cur = curLSN(R)
  const out = arr(R.replication_outgoing)
  const slots = arr(R.replication_slots)
  const inc = R.replication_incoming
  const [standby, setStandby] = useState('')
  const name = (r: any) => r.application_name || r.client_addr || String(r.pid)
  const sel = standby || (out[0] ? name(out[0]) : '')
  const [slot, setSlot] = useState('')
  const selSlot = slot || slots[0]?.slot_name || ''
  return (
    <>
      <PageHeader title={t('Репликация')} actions={<Badge tone={R.is_in_recovery ? 'info' : 'accent'}>{R.is_in_recovery ? t('Реплика') : t('Ведущий')}</Badge>} />
      {R.is_in_recovery && (
        <>
          <Stats>
            <Stat label={t('LSN приёма')} value={<span className="mono text-base">{R.last_wal_receive_lsn || '—'}</span>} />
            <Stat label={t('LSN воспроизведения')} value={<span className="mono text-base">{R.last_wal_replay_lsn || '—'}</span>} />
            <Stat label={t('Не воспроизведено')} value={fmtBytes(Math.max(0, lsn(R.last_wal_receive_lsn) - lsn(R.last_wal_replay_lsn)))} />
            <Stat label={t('Последняя транзакция')} value={R.last_xact_replay_timestamp ? fmtAgo(R.last_xact_replay_timestamp, at) : '—'} />
            <Stat label={t('Воспроизведение')} value={R.is_wal_replay_paused ? t('Приостановлено') : t('Выполняется')} tone={R.is_wal_replay_paused ? 'warn' : 'good'} />
            <Stat label={t('Приёмник WAL')} value={inc?.status ?? t('не запущен')} tone={inc?.status === 'streaming' ? 'good' : 'warn'} />
          </Stats>
          {inc && (
            <Card title={t('Приёмник WAL')} className="mt-3"><KV items={[
              [t('Хост ведущего'), inc.sender_host || '—'], [t('Слот'), inc.slot_name || '—'], [t('Полученный LSN'), <span className="mono">{inc.received_lsn}</span>],
              [t('LSN сброса на диск'), <span className="mono">{inc.flushed_lsn}</span>], [t('Линия времени'), inc.received_tli], [t('Задержка'), fmtMs((inc.latency_micros ?? 0) / 1000)],
              [t('Последнее сообщение отправлено'), fmtAgo(inc.last_msg_send_time, at)], [t('Последнее сообщение получено'), fmtAgo(inc.last_msg_receipt_time, at)],
              [t('Подключение'), <span className="mono">{inc.conninfo}</span>],
            ]} /></Card>
          )}
          <Section title={t('Динамика')}>
            <Charts>
              <Chart title={t('Отставание воспроизведения')} obj="" unit="bytes" fields={[{ key: 'standby_lag_bytes', label: t('Отставание') }]} />
              <Chart title={t('Время с последней воспроизведённой транзакции')} obj="" unit="secs" fields={[{ key: 'standby_lag_secs', label: t('Отставание') }]} />
            </Charts>
          </Section>
        </>
      )}
      {!R.is_in_recovery && (
        <Card title={t('Реплики ({n})', { n: out.length })} pad={out.length === 0}>
          {out.length === 0 ? <Empty icon={<GitBranch className="size-7" />} title={t('Нет подключённых реплик')} /> : (
            <div className="p-3"><DataTable rows={out} cols={[
              { key: 'name', label: t('Реплика'), value: name, render: r => <span className="font-medium">{name(r)}</span> },
              { key: 'client_addr', label: t('Клиент'), className: 'mono' },
              { key: 'state', label: t('Состояние'), render: r => <Badge tone={r.state === 'streaming' ? 'good' : 'warn'}>{r.state}</Badge> },
              { key: 'sync_state', label: t('Синхронность') },
              { key: 'w', label: t('Отставание записи'), right: true, value: r => cur - lsn(r.write_lsn), render: r => fmtBytes(Math.max(0, cur - lsn(r.write_lsn))) },
              { key: 'f', label: t('Отставание сброса'), right: true, value: r => cur - lsn(r.flush_lsn), render: r => fmtBytes(Math.max(0, cur - lsn(r.flush_lsn))) },
              { key: 'r', label: t('Отставание воспроизведения'), right: true, value: r => cur - lsn(r.replay_lsn), render: r => fmtBytes(Math.max(0, cur - lsn(r.replay_lsn))) },
              { key: 'replay_lag', label: t('Время отставания воспроизведения'), right: true, render: r => fmtDur(r.replay_lag) },
              { key: 'reply_time', label: t('Последний ответ'), right: true, render: r => fmtAgo(r.reply_time, at) },
            ]} /></div>
          )}
        </Card>
      )}
      {out.length > 0 && (
        <Section title={t('Динамика отставания реплик')} actions={<Select className="w-48" value={sel} onChange={setStandby} options={out.map(name)} />}>
          <Charts>
            <Chart title={t('Отставание реплики {name}', { name: sel })} obj={`repl:${sel}`} unit="bytes" fields={[{ key: 'write_lag_bytes', label: t('Запись') }, { key: 'flush_lag_bytes', label: t('Сброс') }, { key: 'replay_lag_bytes', label: t('Воспроизведение') }]} />
            <Chart title={t('Время отставания реплики {name}', { name: sel })} obj={`repl:${sel}`} unit="secs" fields={[{ key: 'write_lag', label: t('Запись') }, { key: 'flush_lag', label: t('Сброс') }, { key: 'replay_lag', label: t('Воспроизведение') }]} />
          </Charts>
        </Section>
      )}
      <Section title={t('Слоты репликации ({n})', { n: slots.length })}>
        <DataTable rows={slots} empty={t('Нет слотов репликации')} cols={[
          { key: 'slot_name', label: t('Слот'), render: s => <span className="font-medium">{s.slot_name}</span> },
          { key: 'slot_type', label: t('Тип') },
          { key: 'plugin', label: t('Плагин') },
          { key: 'db_name', label: t('База данных') },
          { key: 'active', label: t('Активен'), value: s => +s.active, render: s => (s.active ? <Badge tone="good">{t('активен')}</Badge> : <Badge tone="warn">{t('неактивен')}</Badge>) },
          { key: 'wal_status', label: t('Статус WAL') },
          { key: 'ret', label: t('Удерживаемый WAL'), right: true, value: s => cur - lsn(s.restart_lsn), render: s => fmtBytes(Math.max(0, cur - lsn(s.restart_lsn))) },
          { key: 'safe_wal_size', label: t('Безопасный размер WAL'), right: true, render: s => (s.safe_wal_size ? fmtBytes(s.safe_wal_size) : '—') },
          { key: 'xmin', label: 'xmin', right: true, render: s => s.xmin || s.catalog_xmin || '—' },
        ]} />
        {slots.length > 0 && (
          <div className="mt-3 grid lg:grid-cols-2 gap-3">
            <div>
              <Select className="w-56 mb-2" value={selSlot} onChange={setSlot} options={slots.map(s => s.slot_name)} />
              <Chart title={t('WAL, удерживаемый слотом {slot}', { slot: selSlot })} obj={`slot:${selSlot}`} unit="bytes" fields={[{ key: 'retained_bytes', label: t('Удерживается') }]} />
            </div>
          </div>
        )}
      </Section>
      {arr(R.publications).length > 0 && (
        <Section title={t('Публикации')}>
          <DataTable rows={arr(R.publications)} cols={[
            { key: 'name', label: t('Публикация') }, { key: 'db_name', label: t('База данных') },
            { key: 'alltables', label: t('Все таблицы'), render: p => (p.alltables ? t('да') : t('нет')) }, { key: 'table_count', label: t('Таблицы'), right: true },
            { key: 'ops', label: t('Операции'), value: p => ['insert', 'update', 'delete'].filter(o => p[o]).join(', ') },
          ]} />
        </Section>
      )}
      {arr(R.subscriptions).length > 0 && (
        <Section title={t('Подписки')}>
          <DataTable rows={arr(R.subscriptions)} cols={[
            { key: 'name', label: t('Подписка') }, { key: 'db_name', label: t('База данных') },
            { key: 'enabled', label: t('Включена'), render: s => (s.enabled ? <Badge tone="good">{t('включена')}</Badge> : <Badge tone="warn">{t('отключена')}</Badge>) },
            { key: 'table_count', label: t('Таблицы'), right: true }, { key: 'worker_count', label: t('Рабочие процессы'), right: true },
            { key: 'received_lsn', label: t('Полученный LSN'), className: 'mono' },
            { key: 'lat', label: t('Задержка'), right: true, value: s => s.latency_micros, render: s => fmtMs((s.latency_micros ?? 0) / 1000) },
            { key: 'err', label: t('Ошибки (применение / синхр.)'), right: true, value: s => s.apply_error_count + s.sync_error_count,
              render: s => <span className={cx(s.apply_error_count + s.sync_error_count > 0 && 'text-crit')}>{s.apply_error_count} / {s.sync_error_count}</span> },
          ]} />
        </Section>
      )}
    </>
  )
}

//------------------------------------------------------------------------------
// WAL & checkpoints

export function WAL() {
  const { report } = useSrv()
  const R = report!
  const at = R.meta.at
  const a = R.wal_archiving ?? {}
  const bg = R.bg_writer ?? {}
  const ck = R.checkpointer
  const w = R.wal
  const failing = a.failed_count > 0 && a.last_failed_time > a.last_archived_time
  return (
    <>
      <PageHeader title={t('WAL и контрольные точки')} />
      <Stats>
        <Stat label={t('Файлы WAL')} value={fmtInt(R.wal_count)} sub={`≈ ${fmtBytes(R.wal_count * 16 * 1024 * 1024)} (max_wal_size ${fmtSetting('max_wal_size', setting(R, 'max_wal_size') ?? '')})`} />
        <Stat label={t('Готовы к архивации')} value={fmtInt(R.wal_ready_count)} tone={R.wal_ready_count > 10 ? 'warn' : undefined} />
        <Stat label={t('Архивация')} value={setting(R, 'archive_mode') === 'off' ? t('Выкл.') : failing ? t('Сбои') : t('В норме')} tone={failing ? 'crit' : setting(R, 'archive_mode') === 'off' ? undefined : 'good'}
          sub={a.last_archived_time ? t('последняя: {ago}', { ago: fmtAgo(a.last_archived_time, at) }) : undefined} />
        <Stat label={t('Контрольная точка')} value={fmtAgo(R.checkpoint_time, at)} />
        <Stat label="wal_level" value={setting(R, 'wal_level')} />
        <Stat label={t('Текущий LSN')} value={<span className="mono text-base">{(R.is_in_recovery ? R.last_wal_replay_lsn : R.wal_lsn) || '—'}</span>} />
      </Stats>
      <div className="grid lg:grid-cols-2 gap-3 mt-3">
        <Card title={t('Архиватор')}>
          <KV cols={1} items={[
            [t('Заархивировано'), fmtInt(a.archived_count)], [t('Последний заархивированный WAL'), <span className="mono">{a.last_archived_wal || '—'}</span>], [t('Последняя архивация'), fmtTime(a.last_archived_time)],
            [t('Сбоев'), <span className={cx(a.failed_count > 0 && 'text-crit')}>{fmtInt(a.failed_count)}</span>], [t('Последний WAL со сбоем'), <span className="mono">{a.last_failed_wal || '—'}</span>],
            [t('Последний сбой'), fmtTime(a.last_failed_time)], ['archive_command', <span className="mono">{setting(R, 'archive_command') || '—'}</span>],
          ]} />
        </Card>
        <Card title={ck ? t('Контрольные точки и фоновая запись') : t('Фоновая запись')}>
          <KV cols={1} items={[
            [t('Контрольные точки по расписанию / по запросу'), `${fmtInt(ck?.num_timed ?? bg.checkpoints_timed)} / ${fmtInt(ck?.num_requested ?? bg.checkpoints_req)}`],
            [t('Время записи / синхронизации контрольных точек'), `${fmtMs(ck?.write_time ?? bg.checkpoint_write_time)} / ${fmtMs(ck?.sync_time ?? bg.checkpoint_sync_time)}`],
            [t('Буферов записано контрольными точками'), fmtNum(ck?.buffers_written ?? bg.buffers_checkpoint)],
            [t('Буферов записано фоновой записью'), fmtNum(bg.buffers_clean)], [t('Остановок фоновой записи (maxwritten)'), fmtNum(bg.maxwritten_clean)],
            ...(bg.buffers_backend != null ? [[t('Буферов записано бэкендами'), fmtNum(bg.buffers_backend)] as [string, string]] : []),
            [t('Буферов выделено'), fmtNum(bg.buffers_alloc)], ['checkpoint_timeout', fmtSetting('checkpoint_timeout', setting(R, 'checkpoint_timeout') ?? '')],
          ]} />
        </Card>
        {w && (
          <Card title={t('Статистика WAL')} className="lg:col-span-2">
            <KV cols={3} items={[
              [t('Записей'), fmtNum(w.records)], [t('Полностраничных образов'), fmtNum(w.fpi)], [t('Объём'), fmtBytes(w.bytes)],
              [t('Переполнений буфера'), fmtNum(w.buffers_full)], [t('Операций записи'), fmtNum(w.write)], [t('Синхронизаций'), fmtNum(w.sync)],
              [t('Время записи'), fmtMs(w.write_time)], [t('Время синхронизации'), fmtMs(w.sync_time)], [t('Сброс статистики'), fmtTime(w.stats_reset)],
            ]} />
          </Card>
        )}
      </div>
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Генерация WAL')} obj="" unit="Bps" fields={[{ key: 'lsn', label: 'WAL', kind: 'rate' }]} />
          <Chart title={t('Файлы WAL')} obj="" unit="count" fields={[{ key: 'wal_count', label: t('В pg_wal') }, { key: 'wal_ready', label: t('Готовы к архивации') }]} />
          <Chart title={t('Контрольные точки')} obj="" unit="oph" sub={t('в час')} fields={[{ key: 'ckpt_timed', label: t('По расписанию'), kind: 'rate', scale: 3600 }, { key: 'ckpt_req', label: t('По запросу'), kind: 'rate', scale: 3600 }]} />
          <Chart title={t('Записанные буферы')} obj="" unit="ops" fields={[{ key: 'buffers_checkpoint', label: t('Контрольные точки'), kind: 'rate' }, { key: 'buffers_clean', label: t('Фоновая запись'), kind: 'rate' }, { key: 'buffers_backend', label: t('Бэкенды'), kind: 'rate' }]} />
          <Chart title={t('Архивация WAL')} obj="" unit="opm" fields={[{ key: 'archived', label: t('Заархивировано'), kind: 'rate', scale: 60 }, { key: 'archive_failed', label: t('Сбои'), kind: 'rate', scale: 60 }]} />
          {w && <Chart title={t('Записи WAL')} obj="" unit="ops" fields={[{ key: 'wal_records', label: t('Записи WAL'), kind: 'rate' }, { key: 'wal_fpi', label: t('Полностраничные образы'), kind: 'rate' }]} />}
        </Charts>
      </Section>
      {arr(R.stat_ios).length > 0 && (
        <Section title={t('Статистика ввода-вывода (pg_stat_io)')}>
          <DataTable rows={arr(R.stat_ios).filter(s => s.reads || s.writes || s.hits || s.extends)} sort={['reads', true]} dense cols={[
            { key: 'backend_type', label: t('Тип бэкенда') }, { key: 'object', label: t('Объект') }, { key: 'context', label: t('Контекст') },
            { key: 'reads', label: t('Чтения'), right: true, render: s => fmtNum(s.reads) }, { key: 'read_time', label: t('Время чтения'), right: true, render: s => fmtMs(s.read_time) },
            { key: 'writes', label: t('Записи'), right: true, render: s => fmtNum(s.writes) }, { key: 'write_time', label: t('Время записи'), right: true, render: s => fmtMs(s.write_time) },
            { key: 'extends', label: t('Расширения отношений'), right: true, render: s => fmtNum(s.extends) }, { key: 'hits', label: t('Попадания'), right: true, render: s => fmtNum(s.hits) },
            { key: 'evictions', label: t('Вытеснения'), right: true, render: s => fmtNum(s.evictions) }, { key: 'fsyncs', label: t('Вызовы fsync'), right: true, render: s => fmtNum(s.fsyncs) },
          ]} />
        </Section>
      )}
    </>
  )
}

//------------------------------------------------------------------------------
// vacuum

const progressCols = (extra: any[]) => [
  { key: 'pid', label: 'PID', right: true },
  { key: 'db_name', label: t('База данных') },
  ...extra,
]

export function Vacuum() {
  const { report } = useSrv()
  const R = report!
  const at = R.meta.at
  const tables = new Map(arr(R.tables).map(t => [`${t.db_name}/${t.oid}`, `${t.schema_name}.${t.name}`]))
  const rel = (p: any) => p.table_name || tables.get(`${p.db_name}/${p.table_oid}`) || `oid ${p.table_oid}`
  const freeze = settingNum(R, 'autovacuum_freeze_max_age')
  const avSettings = Object.keys(R.settings ?? {}).filter(k => k.startsWith('autovacuum') || k.startsWith('vacuum_') || k === 'maintenance_work_mem' || k === 'track_counts').sort()
  const deadTables = arr(R.tables).filter(t => t.n_dead_tup > 0).sort((a, b) => b.n_dead_tup - a.n_dead_tup).slice(0, 100)
  const oldTables = arr(R.tables).filter(t => t.age_relfrozenxid > 0).sort((a, b) => b.age_relfrozenxid - a.age_relfrozenxid).slice(0, 50)
  const ops: [string, any[], any[]][] = [
    [t('Очистка (VACUUM)'), arr(R.vacuum_progress), [
      { key: 'table', label: t('Таблица'), value: rel }, { key: 'phase', label: t('Фаза') },
      { key: 'prog', label: t('Прогресс'), value: (p: any) => pct(p.heap_blks_scanned, p.heap_blks_total), render: (p: any) => <div className="flex items-center gap-2 w-48"><Bar value={pct(p.heap_blks_scanned, p.heap_blks_total)} className="flex-1" /><span className="tabular-nums text-xs">{fmtPct(pct(p.heap_blks_scanned, p.heap_blks_total), 0)}</span></div> },
      { key: 'index_vacuum_count', label: t('Проходов по индексам'), right: true },
      { key: 'dead', label: t('Мёртвые строки'), right: true, value: (p: any) => p.num_dead_item_ids || p.num_dead_tuples, render: (p: any) => fmtNum(p.num_dead_item_ids || p.num_dead_tuples) },
    ]],
    [t('Сбор статистики (ANALYZE)'), arr(R.analyze_progress), [{ key: 'table', label: t('Таблица'), value: rel }, { key: 'phase', label: t('Фаза') },
      { key: 'prog', label: t('Выборка'), right: true, value: (p: any) => pct(p.sample_blks_scanned, p.sample_blks_total), render: (p: any) => fmtPct(pct(p.sample_blks_scanned, p.sample_blks_total), 0) }]],
    [t('Создание индекса'), arr(R.create_index_progress), [{ key: 'table', label: t('Таблица'), value: rel }, { key: 'command', label: t('Команда') }, { key: 'phase', label: t('Фаза') },
      { key: 'prog', label: t('Блоки'), right: true, value: (p: any) => pct(p.blocks_done, p.blocks_total), render: (p: any) => fmtPct(pct(p.blocks_done, p.blocks_total), 0) }]],
    ['CLUSTER / VACUUM FULL', arr(R.cluster_progress), [{ key: 'table', label: t('Таблица'), value: rel }, { key: 'command', label: t('Команда') }, { key: 'phase', label: t('Фаза') },
      { key: 'prog', label: t('Просканировано'), right: true, value: (p: any) => pct(p.heap_blks_scanned, p.heap_blks_total), render: (p: any) => fmtPct(pct(p.heap_blks_scanned, p.heap_blks_total), 0) }]],
    [t('Перепаковка (REPACK)'), arr(R.repack_progress), [{ key: 'table', label: t('Таблица'), value: rel }, { key: 'phase', label: t('Фаза') }]],
    ['COPY', arr(R.copy_progress), [{ key: 'table', label: t('Таблица'), value: rel }, { key: 'command', label: t('Команда') }, { key: 'type', label: t('Тип') },
      { key: 'tuples_processed', label: t('Строки'), right: true, render: (p: any) => fmtNum(p.tuples_processed) }]],
    [t('Базовая копия (pg_basebackup)'), arr(R.basebackup_progress), [{ key: 'phase', label: t('Фаза') },
      { key: 'prog', label: t('Передано'), right: true, value: (p: any) => pct(p.backup_streamed, p.backup_total), render: (p: any) => t('{done} из {total}', { done: fmtBytes(p.backup_streamed), total: fmtBytes(p.backup_total) }) }]],
  ]
  const running = ops.filter(o => o[1].length > 0)
  return (
    <>
      <PageHeader title={t('Очистка (vacuum)')} sub={t('Обслуживание, мёртвые строки и возраст XID')} />
      <Card title={t('Выполняется сейчас')} pad={running.length === 0}>
        {running.length === 0 ? <div className="text-muted">{t('Сейчас не выполняются VACUUM, ANALYZE, построение индексов, CLUSTER, COPY и базовое копирование.')}</div>
          : <div className="p-3 space-y-4">{running.map(([title, rows, cols]) => (
            <div key={title}><div className="font-medium mb-2">{title}</div><DataTable rows={rows} cols={progressCols(cols)} /></div>
          ))}</div>}
      </Card>
      <Section title={t('Возраст XID по базам данных')}>
        <Card>
          <div className="space-y-3">
            {arr(R.databases).sort((a, b) => b.age_datfrozenxid - a.age_datfrozenxid).map(d => {
              const p = pct(d.age_datfrozenxid, 2147483647)
              return (
                <div key={d.name} className="grid grid-cols-[10rem_minmax(0,1fr)_14rem] gap-3 items-center">
                  <span className="truncate">{d.name}</span>
                  <Bar value={p} tone={p > 75 ? 'crit' : p > 40 ? 'warn' : 'good'} />
                  <span className="text-right text-xs tabular-nums text-muted">{t('{age} · {pct} от лимита заморозки', { age: fmtInt(d.age_datfrozenxid), pct: fmtPct(pct(d.age_datfrozenxid, freeze), 0) })}</span>
                </div>
              )
            })}
          </div>
        </Card>
      </Section>
      <Section title={t('Таблицы с наибольшим числом мёртвых строк')}>
        <DataTable rows={deadTables} sort={['n_dead_tup', true]} pageSize={15} cols={[
          { key: 'name', label: t('Таблица'), value: t => `${t.db_name}.${t.schema_name}.${t.name}` },
          { key: 'n_dead_tup', label: t('Мёртвые строки'), right: true, render: t => fmtInt(t.n_dead_tup) },
          { key: 'dp', label: t('Мёртвых, %'), right: true, value: t => pct(t.n_dead_tup, t.n_live_tup + t.n_dead_tup), render: t => fmtPct(pct(t.n_dead_tup, t.n_live_tup + t.n_dead_tup)) },
          { key: 'n_mod_since_analyze', label: t('Изменено после ANALYZE'), right: true, render: t => fmtInt(t.n_mod_since_analyze) },
          { key: 'last_autovacuum', label: t('Последний autovacuum'), right: true, render: t => fmtAgo(t.last_autovacuum, at) },
          { key: 'last_autoanalyze', label: t('Последний autoanalyze'), right: true, render: t => fmtAgo(t.last_autoanalyze, at) },
          { key: 'autovacuum_count', label: t('Запусков autovacuum'), right: true },
        ]} />
      </Section>
      <Section title={t('Самые старые таблицы (возраст замороженного XID)')}>
        <DataTable rows={oldTables} sort={['age_relfrozenxid', true]} pageSize={10} cols={[
          { key: 'name', label: t('Таблица'), value: t => `${t.db_name}.${t.schema_name}.${t.name}` },
          { key: 'age_relfrozenxid', label: t('Возраст'), right: true, render: t => fmtInt(t.age_relfrozenxid) },
          { key: 'p', label: t('От лимита заморозки'), right: true, value: t => pct(t.age_relfrozenxid, freeze), render: t => <span className={cx(t.age_relfrozenxid > freeze && 'text-warn')}>{fmtPct(pct(t.age_relfrozenxid, freeze), 0)}</span> },
          { key: 'size', label: t('Размер'), right: true, render: t => fmtBytes(t.size) },
        ]} />
      </Section>
      <Section title={t('История autovacuum (из журнала)')}>
        <DataTable rows={arr(R.autovacuums)} sort={['at', true]} empty={t('Нет записей autovacuum — задайте log_autovacuum_min_duration и дайте pgmetrics доступ к журналу')} cols={[
          { key: 'at', label: t('Время'), render: v => fmtTime(v.at) },
          { key: 'table_name', label: t('Таблица') },
          { key: 'elapsed', label: t('Длительность'), right: true, render: v => fmtDur(v.elapsed) },
        ]} />
      </Section>
      <Section title={t('Настройки')}>
        <Card><KV cols={2} items={avSettings.map(k => [<span className="mono">{k}</span>, <span className="mono">{fmtSetting(k, setting(R, k) ?? '')}</span>])} /></Card>
      </Section>
    </>
  )
}

//------------------------------------------------------------------------------
// configuration

export function Config() {
  const { report, id, pinnedAt } = useSrv()
  const R = report!
  const [tab, setTab] = useState<'settings' | 'check'>('settings')
  const [changed, setChanged] = useState(false)
  const diag = useApi<{ config: { category: string; category_id: string; severity: string; setting: string; current: string; advice: string }[] }>(tab === 'check' ? `/servers/${id}/diagnostics?at=${pinnedAt ?? ''}` : null)
  const rows = Object.entries(R.settings ?? {}).map(([name, s]: [string, any]) => ({ name, ...s })).filter(s => !changed || (s.source !== 'default' && s.source !== 'override'))
  const pending = rows.filter(s => s.pending).length
  return (
    <>
      <PageHeader title={t('Конфигурация')} sub={pending ? `${pending} ${plural(pending, ['параметр ожидает перезапуска', 'параметра ожидают перезапуска', 'параметров ожидают перезапуска'])}` : undefined} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'settings', label: t('Настройки'), count: Object.keys(R.settings ?? {}).length }, { id: 'check', label: t('Проверка конфигурации') }]} />
      <div className="mt-4">
        {tab === 'settings' && (
          <DataTable rows={rows} sort={['name', false]} search={s => s.name + ' ' + s.setting} pageSize={100} dense
            toolbar={<label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={changed} onChange={e => setChanged(e.target.checked)} />{t('Только изменённые')}</label>}
            cols={[
              { key: 'name', label: t('Параметр'), render: s => <span className="mono font-medium">{s.name}</span> },
              { key: 'setting', label: t('Значение'), render: s => <span className="mono break-all">{fmtSetting(s.name, s.setting)}{s.pending && <Badge tone="warn" className="ml-2">{t('нужен перезапуск')}</Badge>}</span> },
              { key: 'bootval', label: t('По умолчанию'), render: s => <span className={cx('mono break-all', s.bootval === s.setting ? 'text-faint' : 'text-muted')}>{fmtSetting(s.name, s.bootval ?? '')}</span> },
              { key: 'source', label: t('Источник'), render: s => <Badge tone={s.source === 'default' ? 'neutral' : 'accent'}>{s.source}</Badge> },
            ]} />
        )}
        {tab === 'check' && (diag.data ? (
          <DataTable rows={diag.data.config} sort={['sev', false]} empty={t('Нет рекомендаций')} cols={[
            { key: 'sev', label: t('Важность'), value: c => ({ crit: 0, warn: 1, info: 2 } as any)[c.severity], render: c => <SevBadge sev={c.severity} /> },
            { key: 'category', label: t('Область'), value: c => c.category_id, render: c => c.category },
            { key: 'setting', label: t('Параметр'), render: c => <span className="mono">{c.setting}</span> },
            { key: 'current', label: t('Текущее'), render: c => <span className="mono">{c.current}</span> },
            { key: 'advice', label: t('Рекомендация'), className: 'text-muted' },
          ]} />
        ) : diag.error ? <ErrorBox error={diag.error} /> : <div className="text-muted">{t('Загрузка…')}</div>)}
      </div>
    </>
  )
}

//------------------------------------------------------------------------------
// system

export function System() {
  const { report } = useSrv()
  const R = report!
  const s = R.system
  if (!s) {
    return (
      <>
        <PageHeader title={t('Система')} />
        <Card><Empty icon={<Cpu className="size-8" />} title={t('В этом отчёте нет системных метрик')}>
          {t('pgmetrics собирает нагрузку, использование памяти и дисков, если запущен на одном хосте с PostgreSQL. Для AWS RDS / Aurora см. раздел «Облачные метрики».')}
        </Empty></Card>
      </>
    )
  }
  const total = s.memused + s.memfree + s.membuffers + s.memcached
  const seg = (v: number, c: string, l: string) => ({ v, c, l })
  const segs = [seg(s.memused, 'bg-[var(--s1)]', t('Занято')), seg(s.membuffers, 'bg-[var(--s3)]', t('Буферы')), seg(s.memcached, 'bg-[var(--s4)]', t('Кеш')), seg(s.memfree, 'bg-panel-2', t('Свободно'))]
  return (
    <>
      <PageHeader title={t('Система')} sub={`${s.hostname} · ${s.cpu_model}`} />
      <Stats>
        <Stat label={t('Ядра CPU')} value={s.num_cores} />
        <Stat label={t('Средняя нагрузка')} value={fmtDec(s.loadavg, 2, true)} sub={t('{n} на ядро', { n: fmtDec(s.loadavg / (s.num_cores || 1), 2, true) })} tone={s.loadavg > s.num_cores ? 'warn' : undefined} />
        <Stat label={t('Занято памяти')} value={fmtBytes(s.memused)} sub={t('из {total}', { total: fmtBytes(total) })} />
        <Stat label={t('Кеш + буферы')} value={fmtBytes(s.memcached + s.membuffers)} />
        <Stat label={t('Занято swap')} value={fmtBytes(s.swapused)} sub={t('из {total}', { total: fmtBytes(s.swapused + s.swapfree) })} tone={s.swapused > 0.5 * (s.swapused + s.swapfree) ? 'warn' : undefined} />
        <Stat label="Slab" value={fmtBytes(s.memslab)} />
      </Stats>
      <Card title={t('Память')} className="mt-3">
        <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
          {segs.map(x => <div key={x.l} className={x.c} style={{ width: `${pct(x.v, total)}%` }} title={`${x.l}: ${fmtBytes(x.v)}`} />)}
        </div>
        <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted">
          {segs.map(x => <span key={x.l} className="flex items-center gap-1.5"><span className={cx('size-2.5 rounded-sm', x.c)} />{x.l} {fmtBytes(x.v)} ({fmtPct(pct(x.v, total), 0)})</span>)}
        </div>
      </Card>
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Средняя нагрузка')} obj="" unit="count" fields={[{ key: 'load', label: t('Нагрузка') }, { key: 'cores', label: t('Ядра') }]} />
          <Chart title={t('Память')} obj="" unit="bytes" fields={[{ key: 'mem_used', label: t('Занято') }, { key: 'mem_buffers', label: t('Буферы') }, { key: 'mem_cached', label: t('Кеш') }, { key: 'mem_free', label: t('Свободно') }]} />
          <Chart title={t('Подкачка (swap)')} obj="" unit="bytes" fields={[{ key: 'swap_used', label: t('Занято') }, { key: 'swap_free', label: t('Свободно') }]} />
        </Charts>
      </Section>
      <Section title={t('Использование диска по табличным пространствам')}>
        <Card>
          <div className="space-y-3">
            {arr(R.tablespaces).filter(t => t.disk_total > 0).map(t => (
              <div key={t.name} className="grid grid-cols-[10rem_minmax(0,1fr)_12rem] gap-3 items-center">
                <span className="truncate">{t.name}</span>
                <Bar value={pct(t.disk_used, t.disk_total)} tone={pct(t.disk_used, t.disk_total) > 90 ? 'crit' : pct(t.disk_used, t.disk_total) > 80 ? 'warn' : 'good'} />
                <span className="text-right text-xs tabular-nums text-muted">{fmtBytes(t.disk_used)} / {fmtBytes(t.disk_total)}</span>
              </div>
            ))}
          </div>
        </Card>
      </Section>
    </>
  )
}

//------------------------------------------------------------------------------
// logs

export function Logs() {
  const { report } = useSrv()
  const R = report!
  const [level, setLevel] = useState('')
  const entries = arr(R.log_entries)
  const levels = [...new Set(entries.map(e => e.level))].sort()
  const tone = (l: string) => (/PANIC|FATAL|ERROR/.test(l) ? 'crit' : l === 'WARNING' ? 'warn' : l === 'LOG' ? 'neutral' : 'info') as any
  return (
    <>
      <PageHeader title={t('Журнал')} sub={t('Записи журнала PostgreSQL, разобранные pgmetrics за период этого отчёта')} />
      {entries.length === 0 ? (
        <Card><Empty icon={<FileText className="size-8" />} title={t('Нет записей журнала')}>
          {rich(t('pgmetrics читает журнал PostgreSQL, только если запущен на хосте базы данных и подключается локально (через сокет или 127.0.0.1); {logFile} лишь указывает путь к файлу. Для AWS RDS / Aurora журнал загружается через API RDS с {rdsId}. Формат журнала — stderr ({dest}) с меткой времени в {prefix}: файлы csvlog PostgreSQL 13+ pgmetrics пропускает.'), {
            logFile: <code className="mono">--log-file</code>, rdsId: <code className="mono">--aws-rds-dbid</code>,
            dest: <code className="mono">{"log_destination = 'stderr'"}</code>, prefix: <code className="mono">{"log_line_prefix = '%m [%p] %q%u@%d '"}</code>,
          })}
        </Empty></Card>
      ) : (
        <DataTable rows={entries.filter(e => !level || e.level === level)} sort={['at', true]} search={e => e.line + ' ' + e.user + ' ' + e.db_name} dense pageSize={100}
          toolbar={<Select className="w-40" value={level} onChange={setLevel} options={[['', t('Все уровни')], ...levels.map(l => [l, l] as [string, string])]} />}
          cols={[
            { key: 'at', label: t('Время'), render: e => <span className="whitespace-nowrap">{fmtTime(e.at)}</span> },
            { key: 'level', label: t('Уровень'), render: e => <Badge tone={tone(e.level)}>{e.level}</Badge> },
            { key: 'who', label: t('Пользователь@база'), value: e => (e.user ? `${e.user}@${e.db_name}` : '') },
            { key: 'line', label: t('Сообщение'), className: 'mono break-all', render: e => (
              <div>{e.line}{arr(e.extra).map((x: any, i: number) => <div key={i} className="text-muted">{x.level}: {x.line}</div>)}</div>
            ) },
          ]} />
      )}
    </>
  )
}

//------------------------------------------------------------------------------
// cloud (AWS RDS / Aurora CloudWatch, Azure Monitor)

// unit of an AWS/RDS CloudWatch or Azure Monitor metric pgmetrics reports, by name; the first match wins
// (storage_percent is a percentage, TempStorageIOPS a count, CommitThroughput a rate of commits, AuroraReplicaLag is in ms)
const cloudUnit = (k: string): Unit =>
  /percent|Utilization|HitRatio|%|^BurstBalance$/i.test(k) ? 'pct'
  : /^Aurora.*Lag|^CommitLatency$/.test(k) ? 'ms'
  : /Latency|ReplicaLag|CheckpointLag|_in_seconds|Uptime/i.test(k) ? 'secs'
  : /^CommitThroughput$/.test(k) ? 'ops'
  : /Throughput|LogsGeneration/i.test(k) ? 'Bps'
  : /IOPS/i.test(k) ? 'count'
  : /Bytes|Memory|Storage|Space|Swap|DiskUsage|SlotLag/i.test(k) ? 'bytes'
  : 'count'

export function CloudMetrics() {
  const { report } = useSrv()
  const R = report!
  const basic: Record<string, number> = R.rds?.basic ?? {}
  const az: Record<string, number> = R.azure?.metrics ?? {}
  const enhanced = R.rds?.enhanced
  if (!R.rds && !R.azure) {
    return (
      <>
        <PageHeader title={t('Облачные метрики')} />
        <Card><Empty icon={<Cloud className="size-8" />} title={t('Нет облачных метрик')}>
          {rich(t('Чтобы собирать метрики CloudWatch / Azure Monitor, запускайте pgmetrics с параметром {flag} (AWS RDS / Aurora) или с параметрами Azure.'), {
            flag: <code className="mono">--aws-rds-dbid=ID</code>,
          })}
        </Empty></Card>
      </>
    )
  }
  return (
    <>
      <PageHeader title={t('Облачные метрики')} sub={R.rds ? 'AWS CloudWatch' : `Azure Monitor · ${R.azure.resource_name} (${R.azure.resource_region})`} />
      <Stats>
        {Object.entries({ ...basic, ...az }).slice(0, 12).map(([k, v]) => <Stat key={k} label={k} value={fmtUnit(cloudUnit(k), v)} />)}
      </Stats>
      <Section title={t('Динамика')}>
        <Charts>
          {Object.keys(basic).sort().map(k => <Chart key={k} title={k} obj="" unit={cloudUnit(k)} fields={[{ key: 'rds.' + k, label: k }]} />)}
          {Object.keys(az).sort().map(k => <Chart key={k} title={k} obj="" unit={cloudUnit(k)} fields={[{ key: 'azure.' + k, label: k }]} />)}
        </Charts>
      </Section>
      {enhanced && (
        <Section title={t('Расширенный мониторинг (Enhanced Monitoring)')}>
          <Card><pre className="mono overflow-x-auto max-h-[480px]">{JSON.stringify(enhanced, null, 2)}</pre></Card>
        </Section>
      )}
    </>
  )
}
