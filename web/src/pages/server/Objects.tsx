import { useMemo, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { useApi } from '../../lib/api'
import { go } from '../../lib/router'
import { arr, settingNum, tableKey, useSrv } from '../../lib/server'
import { fmtAgo, fmtBytes, fmtInt, fmtMs, fmtNum, fmtPct, fmtTime, now, pct, plural, truncate } from '../../lib/format'
import { t } from '../../lib/i18n'
import { Chart, Charts } from '../../components/Chart'
import { DataTable } from '../../components/Table'
import { Badge, Bar, Card, Code, Crumbs, Empty, KV, PageHeader, Section, Select, Stat, Stats, Tabs, cx } from '../../components/ui'

const enc = encodeURIComponent
const dbOpts = (rows: any[]) => [['', t('Все базы')] as [string, string], ...[...new Set(rows.map(r => r.db_name))].sort().map(d => [d, d] as [string, string])]
const qid = (s: string) => `"${s.replace(/"/g, '""')}"`
const qname = (schema: string, name: string) => `${qid(schema)}.${qid(name)}`
const lastOf = (...t: number[]) => Math.max(0, ...t.filter(Boolean))
const tblHit = (t: any) => pct(t.heap_blks_hit, t.heap_blks_hit + t.heap_blks_read)
const idxHit = (i: any) => pct(i.idx_blks_hit, i.idx_blks_hit + i.idx_blks_read)
const deadPct = (t: any) => pct(t.n_dead_tup, t.n_live_tup + t.n_dead_tup)
const isUnique = (i: any) => /^CREATE UNIQUE /.test(i.def ?? '')
// pgmetrics reports no constraints: guess by PostgreSQL's default index names, <table>_pkey and
// <table>_<cols>_key for a primary key or unique constraint (UNIQUE indexes), <table>_<cols>_excl for an exclusion constraint
const backsConstraint = (i: any) => (isUnique(i) ? /_(pkey|key)$/ : /_excl$/).test(i.name)
// which index of a duplicate group to keep: the primary key, then other unique ones, then a constraint's, then plain ones
const keepRank = (i: any) => (isUnique(i) ? (/_pkey$/.test(i.name) ? 0 : 1) : backsConstraint(i) ? 2 : 3)
const nIdx = (n: number) => `${n} ${plural(n, ['индекс', 'индекса', 'индексов'])}`

//------------------------------------------------------------------------------
// databases

export function Databases() {
  const { report, id } = useSrv()
  const R = report!
  const freeze = settingNum(R, 'autovacuum_freeze_max_age')
  const n = arr(R.databases).length
  return (
    <>
      <PageHeader title={t('Базы данных')} sub={`${n} ${plural(n, ['база', 'базы', 'баз'])}`} />
      <DataTable rows={arr(R.databases)} sort={['size', true]} search={d => d.name} onRow={d => go(`/s/${id}/databases/${enc(d.name)}`)} cols={[
        { key: 'name', label: t('База данных'), render: d => <span className="font-medium">{d.name}</span> },
        { key: 'size', label: t('Размер'), right: true, render: d => fmtBytes(d.size) },
        { key: 'numbackends', label: t('Бэкенды'), right: true },
        { key: 'commit', label: t('Доля фиксаций'), right: true, value: d => pct(d.xact_commit, d.xact_commit + d.xact_rollback), render: d => fmtPct(pct(d.xact_commit, d.xact_commit + d.xact_rollback)) },
        { key: 'hit', label: t('Попадания в кеш'), right: true, value: d => pct(d.blks_hit, d.blks_hit + d.blks_read), render: d => <span className={cx(pct(d.blks_hit, d.blks_hit + d.blks_read) < 90 && 'text-warn')}>{fmtPct(pct(d.blks_hit, d.blks_hit + d.blks_read))}</span> },
        { key: 'age', label: t('Возраст XID / лимит заморозки'), right: true, value: d => pct(d.age_datfrozenxid, freeze), render: d => fmtPct(pct(d.age_datfrozenxid, freeze), 0) },
        { key: 'xact_commit', label: t('Транзакции'), right: true, value: d => d.xact_commit + d.xact_rollback, render: d => fmtNum(d.xact_commit + d.xact_rollback) },
        { key: 'temp_bytes', label: t('Временные файлы'), right: true, render: d => fmtBytes(d.temp_bytes) },
        { key: 'deadlocks', label: t('Взаимоблокировки'), right: true, render: d => fmtInt(d.deadlocks) },
        { key: 'conflicts', label: t('Конфликты'), right: true, render: d => fmtInt(d.conflicts) },
      ]} />
    </>
  )
}

export function DatabaseDetail({ db }: { db: string }) {
  const { report, id } = useSrv()
  const R = report!
  const d = arr(R.databases).find(x => x.name === db)
  const obj = `db:${db}`
  const tables = arr(R.tables).filter(t => t.db_name === db)
  const exts = arr(R.extensions).filter(e => e.db_name === db)
  const trig = arr(R.disabled_triggers).filter(t => t.db_name === db)
  const freeze = settingNum(R, 'autovacuum_freeze_max_age')
  return (
    <>
      <Crumbs items={[[t('Базы данных'), `/s/${id}/databases`], [db]]} />
      <PageHeader title={db} sub={t('База данных')} />
      {d && (
        <>
          <Stats>
            <Stat label={t('Размер')} value={fmtBytes(d.size)} />
            <Stat label={t('Бэкенды')} value={d.numbackends} sub={d.datconnlimit > 0 ? t('лимит {n}', { n: d.datconnlimit }) : t('без лимита подключений')} />
            <Stat label={t('Доля фиксаций')} value={fmtPct(pct(d.xact_commit, d.xact_commit + d.xact_rollback))} />
            <Stat label={t('Попадания в кеш')} value={fmtPct(pct(d.blks_hit, d.blks_hit + d.blks_read))} tone={pct(d.blks_hit, d.blks_hit + d.blks_read) < 90 ? 'warn' : 'good'} />
            <Stat label={t('Возраст замороженного XID')} value={fmtInt(d.age_datfrozenxid)} sub={t('{pct} от autovacuum_freeze_max_age', { pct: fmtPct(pct(d.age_datfrozenxid, freeze), 0) })} />
            <Stat label={t('Таблицы')} value={tables.length} sub={nIdx(arr(R.indexes).filter(i => i.db_name === db).length)} />
          </Stats>
          <Card className="mt-3"><KV cols={3} items={[
            [t('Строк выбрано'), fmtNum(d.tup_fetched)], [t('Строк вставлено'), fmtNum(d.tup_inserted)], [t('Строк обновлено'), fmtNum(d.tup_updated)],
            [t('Строк удалено'), fmtNum(d.tup_deleted)], [t('Временные файлы'), `${fmtInt(d.temp_files)} (${fmtBytes(d.temp_bytes)})`], [t('Взаимоблокировки'), fmtInt(d.deadlocks)],
            [t('Конфликты'), fmtInt(d.conflicts)], [t('Время чтения блоков'), fmtMs(d.blk_read_time)], [t('Время записи блоков'), fmtMs(d.blk_write_time)],
            [t('Сеансы'), fmtInt(d.sessions)], [t('Сеансы: оборванные / прерванные'), `${fmtInt(d.sessions_abandoned)} / ${fmtInt(d.sessions_killed)}`], [t('Ошибки контрольных сумм'), fmtInt(d.checksum_failures)],
            [t('Сброс статистики'), d.stats_reset ? fmtTime(d.stats_reset) : t('никогда')],
          ]} /></Card>
        </>
      )}
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Транзакции')} obj={obj} unit="ops" fields={[{ key: 'xact_commit', label: t('Фиксации'), kind: 'rate' }, { key: 'xact_rollback', label: t('Откаты'), kind: 'rate' }]} />
          <Chart title={t('Строки')} obj={obj} unit="ops" fields={[{ key: 'tup_fetched', label: t('Выбрано'), kind: 'rate' }, { key: 'tup_inserted', label: t('Вставлено'), kind: 'rate' }, { key: 'tup_updated', label: t('Обновлено'), kind: 'rate' }, { key: 'tup_deleted', label: t('Удалено'), kind: 'rate' }]} />
          <Chart title={t('Попадания в кеш')} obj={obj} unit="pct" fields={[{ key: 'hit', label: t('Доля попаданий'), kind: 'hit', of: ['blks_hit', 'blks_read'] }]} />
          <Chart title={t('Размер')} obj={obj} unit="bytes" fields={[{ key: 'size', label: t('Размер') }]} />
          <Chart title={t('Бэкенды')} obj={obj} unit="count" fields={[{ key: 'numbackends', label: t('Бэкенды') }]} />
          <Chart title={t('Временные файлы')} obj={obj} unit="Bps" fields={[{ key: 'temp_bytes', label: t('Объём временных файлов'), kind: 'rate' }]} />
          <Chart title={t('Возраст замороженного XID')} obj={obj} unit="count" fields={[{ key: 'age_datfrozenxid', label: t('Возраст') }]} />
          <Chart title={t('Взаимоблокировки и конфликты')} obj={obj} unit="opm" fields={[{ key: 'deadlocks', label: t('Взаимоблокировки'), kind: 'rate', scale: 60 }, { key: 'conflicts', label: t('Конфликты'), kind: 'rate', scale: 60 }]} />
        </Charts>
      </Section>
      <Section title={t('Крупнейшие таблицы')}>
        <DataTable rows={tables} sort={['size', true]} pageSize={10} onRow={t => go(`/s/${id}/tables/${enc(t.db_name)}/${enc(t.schema_name)}/${enc(t.name)}`)} cols={[
          { key: 'name', label: t('Таблица'), value: t => `${t.schema_name}.${t.name}` },
          { key: 'size', label: t('Размер'), right: true, render: t => fmtBytes(t.size) },
          { key: 'n_live_tup', label: t('Строки'), right: true, render: t => fmtInt(t.n_live_tup) },
          { key: 'dead', label: t('Мёртвые'), right: true, value: deadPct, render: t => fmtPct(deadPct(t)) },
        ]} />
      </Section>
      <Section title={t('Расширения')}>
        <DataTable rows={exts} sort={['name', false]} empty={t('Нет расширений')} cols={[
          { key: 'name', label: t('Расширение'), render: e => <span className="font-medium">{e.name}</span> },
          { key: 'schema_name', label: t('Схема') },
          { key: 'installed_version', label: t('Установлена'), render: e => <span>{e.installed_version} {e.default_version && e.default_version !== e.installed_version && <Badge tone="warn">{t('доступна {version}', { version: e.default_version })}</Badge>}</span> },
          { key: 'comment', label: t('Описание'), className: 'text-muted' },
        ]} />
      </Section>
      {trig.length > 0 && (
        <Section title={t('Отключённые триггеры')}>
          <DataTable rows={trig} cols={[{ key: 'table', label: t('Таблица'), value: t => `${t.schema_name}.${t.table_name}` }, { key: 'name', label: t('Триггер') }, { key: 'proc_name', label: t('Функция') }]} />
        </Section>
      )}
    </>
  )
}

//------------------------------------------------------------------------------
// tables

export function Tables() {
  const { report, id } = useSrv()
  const R = report!
  const [db, setDb] = useState('')
  const at = R.meta.at
  const rows = arr(R.tables).filter(t => !db || t.db_name === db)
  const n = arr(R.tables).length
  return (
    <>
      <PageHeader title={t('Таблицы')} sub={`${n} ${plural(n, ['таблица', 'таблицы', 'таблиц'])}`} />
      <DataTable rows={rows} sort={['size', true]} search={tableKey} onRow={t => go(`/s/${id}/tables/${enc(t.db_name)}/${enc(t.schema_name)}/${enc(t.name)}`)}
        toolbar={<Select className="w-48" value={db} onChange={setDb} options={dbOpts(arr(R.tables))} />}
        cols={[
          { key: 'name', label: t('Таблица'), value: t => `${t.schema_name}.${t.name}`, render: x => <span className="font-medium">{x.schema_name}.{x.name}{x.relispartition && <Badge className="ml-1.5">{t('секция')}</Badge>}</span> },
          { key: 'db_name', label: t('База данных') },
          { key: 'size', label: t('Размер'), right: true, render: t => fmtBytes(t.size) },
          { key: 'bloat', label: t('Раздувание'), right: true, value: t => t.bloat, render: t => t.bloat > 0 ? <span className={cx(pct(t.bloat, t.size) > 30 && 'text-warn')}>{fmtBytes(t.bloat)} ({fmtPct(pct(t.bloat, t.size), 0)})</span> : <span className="text-faint">—</span> },
          { key: 'n_live_tup', label: t('Живые строки'), right: true, render: t => fmtInt(t.n_live_tup) },
          { key: 'dead', label: t('Мёртвые строки'), right: true, value: deadPct, render: t => <span className={cx(deadPct(t) > 20 && t.n_dead_tup > 1000 && 'text-warn')}>{fmtInt(t.n_dead_tup)}</span> },
          { key: 'seq_scan', label: t('Посл. сканирования'), right: true, render: t => fmtNum(t.seq_scan) },
          { key: 'idx_scan', label: t('Индексные сканирования'), right: true, render: t => fmtNum(t.idx_scan) },
          { key: 'hit', label: t('Попадания в кеш'), right: true, value: tblHit, render: t => fmtPct(tblHit(t)) },
          { key: 'vac', label: t('Последняя очистка'), right: true, value: t => lastOf(t.last_vacuum, t.last_autovacuum), render: t => fmtAgo(lastOf(t.last_vacuum, t.last_autovacuum), at) },
          { key: 'an', label: t('Последний анализ'), right: true, value: t => lastOf(t.last_analyze, t.last_autoanalyze), render: t => fmtAgo(lastOf(t.last_analyze, t.last_autoanalyze), at) },
        ]} />
    </>
  )
}

export function TableDetail({ db, schema, name }: { db: string; schema: string; name: string }) {
  const { report, id } = useSrv()
  const R = report!
  const at = R.meta.at
  const tb = arr(R.tables).find(x => x.db_name === db && x.schema_name === schema && x.name === name)
  const idx = arr(R.indexes).filter(i => i.db_name === db && i.schema_name === schema && i.table_name === name)
  const obj = `tbl:${db}.${schema}.${name}`
  const partitions = arr(R.tables).filter(x => x.db_name === db && x.parent_name === `${schema}.${name}`)
  const relkind = tb && ({ r: t('таблица'), p: t('секционированная таблица'), m: t('материализованное представление'), f: t('внешняя таблица') }[tb.relkind as string] ?? tb.relkind)
  return (
    <>
      <Crumbs items={[[t('Таблицы'), `/s/${id}/tables`], [db, `/s/${id}/databases/${enc(db)}`], [`${schema}.${name}`]]} />
      <PageHeader title={`${schema}.${name}`} sub={t('Таблица в базе {db}', { db })} />
      {tb && (
        <>
          <Stats>
            <Stat label={t('Размер')} value={fmtBytes(tb.size)} sub={tb.tablespace_name ? t('табличное пространство {name}', { name: tb.tablespace_name }) : undefined} />
            <Stat label={t('Раздувание')} value={tb.bloat > 0 ? fmtBytes(tb.bloat) : '—'} sub={tb.bloat > 0 ? t('{pct} от размера', { pct: fmtPct(pct(tb.bloat, tb.size)) }) : t('не оценено')} tone={pct(tb.bloat, tb.size) > 30 ? 'warn' : undefined} />
            <Stat label={t('Живые строки')} value={fmtInt(tb.n_live_tup)} />
            <Stat label={t('Мёртвые строки')} value={fmtInt(tb.n_dead_tup)} sub={t('{pct} от всех строк', { pct: fmtPct(deadPct(tb)) })} tone={deadPct(tb) > 20 ? 'warn' : undefined} />
            <Stat label={t('Попадания в кеш')} value={fmtPct(tblHit(tb))} />
            <Stat label={t('HOT-обновления')} value={fmtPct(pct(tb.n_tup_hot_upd, tb.n_tup_upd))} sub={t('от всех обновлений')} />
          </Stats>
          <div className="grid lg:grid-cols-2 gap-3 mt-3">
            <Card title={t('Очистка и анализ')}>
              <KV cols={1} items={[
                [t('Последняя ручная очистка'), fmtAgo(tb.last_vacuum, at)], [t('Последний autovacuum'), fmtAgo(tb.last_autovacuum, at)],
                [t('Последний ручной анализ'), fmtAgo(tb.last_analyze, at)], [t('Последний autoanalyze'), fmtAgo(tb.last_autoanalyze, at)],
                [t('Очистки (вручную / авто)'), `${fmtInt(tb.vacuum_count)} / ${fmtInt(tb.autovacuum_count)}`],
                [t('Анализы (вручную / авто)'), `${fmtInt(tb.analyze_count)} / ${fmtInt(tb.autoanalyze_count)}`],
                [t('Изменено после анализа'), fmtInt(tb.n_mod_since_analyze)], [t('Вставлено после очистки'), fmtInt(tb.n_ins_since_vacuum)],
                [t('Возраст замороженного XID'), fmtInt(tb.age_relfrozenxid)],
              ]} />
            </Card>
            <Card title={t('Активность')}>
              <KV cols={1} items={[
                [t('Последовательные сканирования'), t('{scans} (прочитано строк: {rows})', { scans: fmtInt(tb.seq_scan), rows: fmtNum(tb.seq_tup_read) })], [t('Индексные сканирования'), t('{scans} (выбрано строк: {rows})', { scans: fmtInt(tb.idx_scan), rows: fmtNum(tb.idx_tup_fetch) })],
                [t('Последнее посл. / индексное сканирование'), `${fmtAgo(tb.last_seq_scan, at)} / ${fmtAgo(tb.last_idx_scan, at)}`],
                [t('Строк вставлено / обновлено / удалено'), `${fmtNum(tb.n_tup_ins)} / ${fmtNum(tb.n_tup_upd)} / ${fmtNum(tb.n_tup_del)}`],
                [t('Блоки кучи: попадания / чтения'), `${fmtNum(tb.heap_blks_hit)} / ${fmtNum(tb.heap_blks_read)}`],
                [t('Блоки индексов: попадания / чтения'), `${fmtNum(tb.idx_blks_hit)} / ${fmtNum(tb.idx_blks_read)}`],
                [t('Блоки TOAST: попадания / чтения'), `${fmtNum(tb.toast_blks_hit)} / ${fmtNum(tb.toast_blks_read)}`],
                [t('Столбцы'), tb.relnatts], [t('Тип'), tb.relpersistence === 'u' ? t('{kind}, нежурналируемая', { kind: relkind }) : relkind],
                ...(tb.relispartition ? [[t('Секция таблицы'), `${tb.parent_name} ${tb.partition_cv ?? ''}`] as [string, string]] : []),
              ]} />
            </Card>
          </div>
        </>
      )}
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Размер')} obj={obj} unit="bytes" fields={[{ key: 'size', label: t('Размер') }, { key: 'bloat', label: t('Раздувание') }]} />
          <Chart title={t('Строки')} obj={obj} unit="count" fields={[{ key: 'n_live_tup', label: t('Живые') }, { key: 'n_dead_tup', label: t('Мёртвые') }]} />
          <Chart title={t('Изменения строк')} obj={obj} unit="ops" fields={[{ key: 'n_tup_ins', label: t('Вставки'), kind: 'rate' }, { key: 'n_tup_upd', label: t('Обновления'), kind: 'rate' }, { key: 'n_tup_del', label: t('Удаления'), kind: 'rate' }]} />
          <Chart title={t('Сканирования')} obj={obj} unit="ops" fields={[{ key: 'seq_scan', label: t('Последовательные'), kind: 'rate' }, { key: 'idx_scan', label: t('Индексные'), kind: 'rate' }]} />
          <Chart title={t('Попадания в кеш')} obj={obj} unit="pct" fields={[{ key: 'hit', label: t('Доля попаданий (куча)'), kind: 'hit', of: ['heap_blks_hit', 'heap_blks_read'] }]} />
          <Chart title={t('Запуски очистки и анализа')} obj={obj} unit="oph" fields={[{ key: 'autovacuum_count', label: 'autovacuum', kind: 'rate', scale: 3600 }, { key: 'autoanalyze_count', label: 'autoanalyze', kind: 'rate', scale: 3600 }]} sub={t('в час')} />
        </Charts>
      </Section>
      <Section title={t('Индексы ({n})', { n: idx.length })}>
        <IndexTable rows={idx} />
      </Section>
      {partitions.length > 0 && (
        <Section title={t('Секции ({n})', { n: partitions.length })}>
          <DataTable rows={partitions} sort={['size', true]} onRow={p => go(`/s/${id}/tables/${enc(p.db_name)}/${enc(p.schema_name)}/${enc(p.name)}`)} cols={[
            { key: 'name', label: t('Секция'), value: p => `${p.schema_name}.${p.name}` },
            { key: 'partition_cv', label: t('Границы'), className: 'mono' },
            { key: 'size', label: t('Размер'), right: true, render: p => fmtBytes(p.size) },
            { key: 'n_live_tup', label: t('Строки'), right: true, render: p => fmtInt(p.n_live_tup) },
          ]} />
        </Section>
      )}
    </>
  )
}

//------------------------------------------------------------------------------
// indexes

function IndexTable({ rows, search, toolbar }: { rows: any[]; search?: boolean; toolbar?: React.ReactNode }) {
  const { id, report } = useSrv()
  const at = report!.meta.at
  return (
    <DataTable rows={rows} sort={['size', true]} search={search ? i => `${i.db_name}.${i.schema_name}.${i.name} ${i.table_name}` : undefined} toolbar={toolbar}
      onRow={i => go(`/s/${id}/indexes/${enc(i.db_name)}/${enc(i.schema_name)}/${enc(i.name)}`)} empty={t('Нет индексов')} cols={[
        { key: 'name', label: t('Индекс'), render: i => <span className="font-medium">{i.name}{isUnique(i) && <Badge className="ml-1.5">{t('уникальный')}</Badge>}</span> },
        { key: 'table_name', label: t('Таблица'), value: i => `${i.schema_name}.${i.table_name}` },
        { key: 'db_name', label: t('База данных') },
        { key: 'amname', label: t('Тип') },
        { key: 'size', label: t('Размер'), right: true, render: i => fmtBytes(i.size) },
        { key: 'bloat', label: t('Раздувание'), right: true, render: i => (i.bloat > 0 ? `${fmtBytes(i.bloat)} (${fmtPct(pct(i.bloat, i.size), 0)})` : <span className="text-faint">—</span>) },
        { key: 'idx_scan', label: t('Сканирования'), right: true, render: i => <span className={cx(i.idx_scan === 0 && 'text-warn')}>{fmtNum(i.idx_scan)}</span> },
        { key: 'hit', label: t('Попадания в кеш'), right: true, value: idxHit, render: i => fmtPct(idxHit(i)) },
        { key: 'last_idx_scan', label: t('Последнее использование'), right: true, render: i => (i.last_idx_scan ? fmtAgo(i.last_idx_scan, at) : <span className="text-faint">{t('н/д')}</span>) },
      ]} />
  )
}

export function Indexes() {
  const { report } = useSrv()
  const [db, setDb] = useState('')
  const all = arr(report!.indexes)
  return (
    <>
      <PageHeader title={t('Индексы')} sub={t('{indexes}, всего {size}', { indexes: nIdx(all.length), size: fmtBytes(all.reduce((a, i) => a + i.size, 0)) })} />
      <IndexTable rows={all.filter(i => !db || i.db_name === db)} search toolbar={<Select className="w-48" value={db} onChange={setDb} options={dbOpts(all)} />} />
    </>
  )
}

export function IndexDetail({ db, schema, name }: { db: string; schema: string; name: string }) {
  const { report, id } = useSrv()
  const at = report!.meta.at
  const i = arr(report!.indexes).find(x => x.db_name === db && x.schema_name === schema && x.name === name)
  const obj = `idx:${db}.${schema}.${name}`
  return (
    <>
      <Crumbs items={[[t('Индексы'), `/s/${id}/indexes`], [db], [`${schema}.${name}`]]} />
      <PageHeader title={name} sub={i ? <>{t('Индекс таблицы')} <a className="link" href={`#/s/${id}/tables/${enc(db)}/${enc(schema)}/${enc(i.table_name)}`}>{schema}.{i.table_name}</a></> : t('Отсутствует в выбранном отчёте')} />
      {i && (
        <>
          <Code>{i.def}</Code>
          <div className="mt-3"><Stats>
            <Stat label={t('Размер')} value={fmtBytes(i.size)} />
            <Stat label={t('Раздувание')} value={i.bloat > 0 ? fmtBytes(i.bloat) : '—'} sub={i.bloat > 0 ? fmtPct(pct(i.bloat, i.size)) : t('не оценено')} />
            <Stat label={t('Сканирования')} value={fmtInt(i.idx_scan)} tone={i.idx_scan === 0 ? 'warn' : undefined} sub={i.last_idx_scan ? t('последнее {ago}', { ago: fmtAgo(i.last_idx_scan, at) }) : undefined} />
            <Stat label={t('Прочитано кортежей')} value={fmtNum(i.idx_tup_read)} />
            <Stat label={t('Выбрано кортежей')} value={fmtNum(i.idx_tup_fetch)} />
            <Stat label={t('Попадания в кеш')} value={fmtPct(idxHit(i))} />
          </Stats></div>
          <Card title={t('SQL для обслуживания')} className="mt-3">
            <Code>{[t('-- подключитесь к базе {db}', { db }), `REINDEX INDEX CONCURRENTLY ${qname(schema, name)};`, t('-- или, если индекс не нужен:'), `DROP INDEX CONCURRENTLY ${qname(schema, name)};`].join('\n')}</Code>
          </Card>
        </>
      )}
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Сканирования')} obj={obj} unit="ops" fields={[{ key: 'idx_scan', label: t('Сканирования'), kind: 'rate' }]} />
          <Chart title={t('Размер')} obj={obj} unit="bytes" fields={[{ key: 'size', label: t('Размер') }, { key: 'bloat', label: t('Раздувание') }]} />
          <Chart title={t('Кортежи')} obj={obj} unit="ops" fields={[{ key: 'idx_tup_read', label: t('Прочитано'), kind: 'rate' }, { key: 'idx_tup_fetch', label: t('Выбрано'), kind: 'rate' }]} />
          <Chart title={t('Попадания в кеш')} obj={obj} unit="pct" fields={[{ key: 'hit', label: t('Доля попаданий'), kind: 'hit', of: ['idx_blks_hit', 'idx_blks_read'] }]} />
        </Charts>
      </Section>
    </>
  )
}

function SqlSelection({ rows, make, cols, rowKey, empty }: {
  rows: any[]; make: (sel: any[]) => string; cols: any[]; rowKey: (r: any) => string; empty: string
}) {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setSel(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const chosen = rows.filter(r => sel.has(rowKey(r)))
  return (
    <>
      <DataTable rows={rows} sort={['size', true]} empty={empty} cols={[
        { key: 'sel', label: <input type="checkbox" checked={rows.length > 0 && chosen.length === rows.length} onChange={e => setSel(new Set(e.target.checked ? rows.map(rowKey) : []))} />,
          value: r => (sel.has(rowKey(r)) ? 1 : 0), render: r => <input type="checkbox" checked={sel.has(rowKey(r))} onChange={() => toggle(rowKey(r))} onClick={e => e.stopPropagation()} /> },
        ...cols,
      ]} />
      {chosen.length > 0 && <div className="mt-3"><Code>{make(chosen)}</Code></div>}
    </>
  )
}

const byDb = (rows: any[], line: (r: any) => string) => {
  const groups = new Map<string, any[]>()
  for (const r of rows) groups.set(r.db_name, [...(groups.get(r.db_name) ?? []), r])
  return [...groups].map(([db, rs]) => `\\c ${qid(db)}\n${rs.map(line).join('\n')}`).join('\n\n')
}

export function IndexManagement() {
  const { report, id } = useSrv()
  const R = report!
  const at = R.meta.at
  const [tab, setTab] = useState<'unused' | 'bloated' | 'duplicate'>('unused')
  const [days, setDays] = useState('stats')
  const base = useApi<{ at: number; vals: Record<string, number> }>(days === 'stats' ? null : `/servers/${id}/baseline?prefix=idx:&field=idx_scan&at=${now() - Number(days) * 86400}`)
  const all = arr(R.indexes)

  const unused = all.filter(i => {
    if (isUnique(i)) return false
    if (days === 'stats') return i.idx_scan === 0
    const b = base.data?.vals[`idx:${i.db_name}.${i.schema_name}.${i.name}`]
    return b != null && i.idx_scan === b
  })
  const bloated = all.filter(i => i.bloat > 0 && i.size > 0).sort((a, b) => b.bloat - a.bloat)
  const dups = useMemo(() => {
    const g = new Map<string, any[]>()
    for (const i of all) {
      if (!i.def) continue
      const k = i.db_name + '|' + i.def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, '')
      g.set(k, [...(g.get(k) ?? []), i])
    }
    return [...g.values()].filter(x => x.length > 1).flatMap(x => {
      const [keep, ...rest] = [...x].sort((a, b) => keepRank(a) - keepRank(b))
      const nonUnique = x.some(i => !isUnique(i))
      // never a constraint's index (DROP INDEX fails on it), never a unique one while a non-unique equivalent exists
      return rest.filter(i => !backsConstraint(i) && !(nonUnique && isUnique(i))).map(i => ({ ...i, dupOf: keep.name }))
    })
  }, [all])
  const key = (i: any) => `${i.db_name}.${i.schema_name}.${i.name}`
  const common = [
    { key: 'name', label: t('Индекс'), value: (i: any) => `${i.schema_name}.${i.name}` },
    { key: 'table', label: t('Таблица'), value: (i: any) => `${i.db_name}.${i.schema_name}.${i.table_name}` },
    { key: 'size', label: t('Размер'), right: true, render: (i: any) => fmtBytes(i.size) },
  ]
  return (
    <>
      <PageHeader title={t('Управление индексами')} sub={t('Поиск индексов для удаления или перестроения и генерация SQL')} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'unused', label: t('Неиспользуемые'), count: unused.length }, { id: 'bloated', label: t('Раздутые'), count: bloated.length }, { id: 'duplicate', label: t('Дубликаты'), count: dups.length },
      ]} />
      <div className="mt-4">
        {tab === 'unused' && (
          <>
            <div className="flex items-center gap-2 mb-3 text-[13px]">
              <span className="text-muted">{t('Не сканировались')}</span>
              <Select className="w-56" value={days} onChange={setDays} options={[['stats', t('с момента сброса статистики')], ['1', t('за последний день')], ['7', t('за последние 7 дней')], ['30', t('за последние 30 дней')], ['90', t('за последние 90 дней')]]} />
              {days !== 'stats' && base.data && <span className="text-xs text-faint">{t('по сравнению с отчётом от {time}', { time: fmtTime(base.data.at) })}</span>}
            </div>
            <SqlSelection rows={unused} rowKey={key} empty={t('Нет неиспользуемых индексов')} make={sel => byDb(sel, i => `DROP INDEX CONCURRENTLY ${qname(i.schema_name, i.name)};`)}
              cols={[...common, { key: 'idx_scan', label: t('Всего сканирований'), right: true, render: (i: any) => fmtInt(i.idx_scan) },
                { key: 'last', label: t('Последнее использование'), right: true, value: (i: any) => i.last_idx_scan, render: (i: any) => (i.last_idx_scan ? fmtAgo(i.last_idx_scan, at) : t('н/д')) }]} />
          </>
        )}
        {tab === 'bloated' && (
          <SqlSelection rows={bloated} rowKey={key} empty={t('Нет оценок раздувания индексов')} make={sel => byDb(sel, i => `REINDEX INDEX CONCURRENTLY ${qname(i.schema_name, i.name)};`)}
            cols={[...common, { key: 'bloat', label: t('Раздувание'), right: true, render: (i: any) => `${fmtBytes(i.bloat)} (${fmtPct(pct(i.bloat, i.size), 0)})` }]} />
        )}
        {tab === 'duplicate' && (
          <SqlSelection rows={dups} rowKey={key} empty={t('Нет дублирующихся индексов')} make={sel => byDb(sel, i => `DROP INDEX CONCURRENTLY ${qname(i.schema_name, i.name)};  ${t('-- дубликат {idx}', { idx: i.dupOf })}`)}
            cols={[...common, { key: 'dupOf', label: t('Дубликат индекса') }, { key: 'def', label: t('Определение'), className: 'mono text-muted max-w-md', render: (i: any) => truncate(i.def, 120) }]} />
        )}
      </div>
    </>
  )
}

//------------------------------------------------------------------------------
// top-k

type Crit = [id: string, label: string, value: (x: any) => number, fmt: (n: number) => string]

export function TopK() {
  const { report, id } = useSrv()
  const R = report!
  const [kind, setKind] = useState<'tables' | 'indexes' | 'schemas'>('tables')
  const [crit, setCrit] = useState('size')
  const [k, setK] = useState('10')
  const [period, setPeriod] = useState('7')
  const growthPrefix = kind === 'indexes' ? 'idx:' : 'tbl:'
  const growth = crit.startsWith('growth')
  const base = useApi<{ at: number; vals: Record<string, number> }>(growth ? `/servers/${id}/baseline?prefix=${growthPrefix}&field=${crit === 'growth_rows' ? 'n_live_tup' : 'size'}&at=${now() - Number(period) * 86400}` : null)
  const objKey = (x: any) => `${growthPrefix}${x.db_name}.${x.schema_name}.${x.name}`
  const delta = (x: any, field: string) => {
    const b = base.data?.vals[objKey(x)]
    return b == null ? NaN : x[field] - b
  }

  const schemas = useMemo(() => {
    const m = new Map<string, any>()
    for (const t of arr(R.tables)) {
      const key = `${t.db_name}.${t.schema_name}`
      const s = m.get(key) ?? { name: key, size: 0, rows: 0, tables: 0, indexes: 0, index_size: 0 }
      s.size += Math.max(0, t.size); s.rows += t.n_live_tup; s.tables++
      m.set(key, s)
    }
    for (const i of arr(R.indexes)) {
      const s = m.get(`${i.db_name}.${i.schema_name}`)
      if (s) { s.indexes++; s.index_size += Math.max(0, i.size) }
    }
    return [...m.values()]
  }, [R])

  const crits: Record<string, Crit[]> = {
    tables: [
      ['size', t('Размер'), t => t.size, fmtBytes], ['rows', t('Живые строки'), t => t.n_live_tup, fmtInt], ['dead', t('Мёртвые строки'), t => t.n_dead_tup, fmtInt],
      ['bloat', t('Раздувание'), t => t.bloat, fmtBytes], ['seq', t('Последовательные сканирования'), t => t.seq_scan, fmtNum], ['writes', t('Записи (вст. + обн. + уд.)'), t => t.n_tup_ins + t.n_tup_upd + t.n_tup_del, fmtNum],
      ['growth', t('Рост размера'), t => delta(t, 'size'), n => (n >= 0 ? '+' : '−') + fmtBytes(Math.abs(n))],
      ['growth_rows', t('Рост числа строк'), t => delta(t, 'n_live_tup'), n => (n >= 0 ? '+' : '') + fmtInt(n)],
    ],
    indexes: [
      ['size', t('Размер'), i => i.size, fmtBytes], ['bloat', t('Раздувание'), i => i.bloat, fmtBytes], ['scans', t('Сканирования'), i => i.idx_scan, fmtNum],
      ['growth', t('Рост размера'), i => delta(i, 'size'), n => (n >= 0 ? '+' : '−') + fmtBytes(Math.abs(n))],
    ],
    schemas: [
      ['size', t('Размер таблиц'), s => s.size, fmtBytes], ['index_size', t('Размер индексов'), s => s.index_size, fmtBytes], ['rows', t('Строки'), s => s.rows, fmtInt],
      ['tables', t('Число таблиц'), s => s.tables, fmtInt], ['indexes', t('Число индексов'), s => s.indexes, fmtInt],
    ],
  }
  const c = crits[kind].find(x => x[0] === crit) ?? crits[kind][0]
  const src = kind === 'tables' ? arr(R.tables) : kind === 'indexes' ? arr(R.indexes) : schemas
  const top = src.map(x => ({ x, v: c[2](x) })).filter(e => isFinite(e.v) && e.v !== 0).sort((a, b) => b.v - a.v).slice(0, Number(k))
  const max = Math.max(...top.map(e => Math.abs(e.v)), 1)
  const label = (x: any) => (kind === 'schemas' ? x.name : `${x.db_name}.${x.schema_name}.${x.name}`)
  const link = (x: any) => kind === 'tables' ? `/s/${id}/tables/${enc(x.db_name)}/${enc(x.schema_name)}/${enc(x.name)}`
    : kind === 'indexes' ? `/s/${id}/indexes/${enc(x.db_name)}/${enc(x.schema_name)}/${enc(x.name)}` : undefined

  return (
    <>
      <PageHeader title={t('Топ-k')} sub={t('Самые большие, нагруженные и быстрорастущие объекты')} />
      <div className="flex flex-wrap gap-2 mb-4">
        <Select className="w-36" value={kind} onChange={v => { setKind(v as any); setCrit('size') }} options={[['tables', t('Таблицы')], ['indexes', t('Индексы')], ['schemas', t('Схемы')]]} />
        <Select className="w-52" value={c[0]} onChange={setCrit} options={crits[kind].map(x => [x[0], x[1]] as [string, string])} />
        {growth && <Select className="w-40" value={period} onChange={setPeriod} options={[['1', t('за 1 день')], ['7', t('за 7 дней')], ['30', t('за 30 дней')]]} />}
        <Select className="w-28" value={k} onChange={setK} options={[['10', t('Топ-10')], ['25', t('Топ-25')], ['50', t('Топ-50')]]} />
      </div>
      <Card>
        {growth && base.data && <div className="text-xs text-faint mb-3">{t('По сравнению с отчётом от {time}', { time: fmtTime(base.data.at) })}</div>}
        {top.length === 0 ? <Empty title={t('Нет данных для рейтинга')}>{growth ? t('Пока недостаточно истории за этот период.') : undefined}</Empty> : (
          <ol className="space-y-2.5">
            {top.map(({ x, v }, i) => (
              <li key={i} className="grid grid-cols-[2rem_minmax(0,1fr)_7rem] items-center gap-3">
                <span className="text-faint tabular-nums text-right">{i + 1}</span>
                <div className="min-w-0">
                  {link(x) ? <a className="hover:text-accent truncate block" href={'#' + link(x)}>{label(x)}</a> : <span className="truncate block">{label(x)}</span>}
                  <Bar className="mt-1" value={(100 * Math.abs(v)) / max} tone={v < 0 ? 'warn' : 'accent'} />
                </div>
                <span className="text-right tabular-nums font-medium">{c[3](v)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  )
}

//------------------------------------------------------------------------------
// tablespaces

export function Tablespaces() {
  const { report } = useSrv()
  const R = report!
  const tss = arr(R.tablespaces)
  const [ts, setTs] = useState(tss[0]?.name ?? '')
  const [target, setTarget] = useState(tss.find(t => t.name !== ts)?.name ?? 'pg_default')
  const [action, setAction] = useState('move')
  // tables/indexes report "" for the database's default tablespace
  const objects = [...arr(R.tables).map(t => ({ ...t, kind: 'table' })), ...arr(R.indexes).map(i => ({ ...i, kind: 'index' }))]
    .filter(o => (o.tablespace_name || 'pg_default') === ts)
  return (
    <>
      <PageHeader title={t('Табличные пространства')} sub={`${tss.length} ${plural(tss.length, ['табличное пространство', 'табличных пространства', 'табличных пространств'])}`} />
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {tss.map(sp => {
          const used = pct(sp.disk_used, sp.disk_total), ino = pct(sp.inodes_used, sp.inodes_total)
          return (
            <button key={sp.name} onClick={() => setTs(sp.name)} className={cx('card p-4 text-left cursor-pointer transition-colors', ts === sp.name ? 'border-accent ring-2 ring-accent/20' : 'hover:border-accent/40')}>
              <div className="flex items-center gap-2"><HardDrive className="size-4 text-accent" /><span className="font-semibold">{sp.name}</span><span className="text-xs text-faint ml-auto">{t('владелец {owner}', { owner: sp.owner })}</span></div>
              <div className="mono text-faint mt-1 truncate">{sp.location || t('(каталог данных)')}</div>
              <div className="text-2xl font-semibold mt-3 tabular-nums">{fmtBytes(sp.size)}</div>
              {sp.disk_total > 0 ? (
                <div className="mt-3 space-y-2 text-xs">
                  <div><div className="flex justify-between text-muted mb-1"><span>{t('Диск')}</span><span>{t('{used} из {total}', { used: fmtBytes(sp.disk_used), total: fmtBytes(sp.disk_total) })}</span></div><Bar value={used} tone={used > 90 ? 'crit' : used > 80 ? 'warn' : 'good'} /></div>
                  {sp.inodes_total > 0 && <div><div className="flex justify-between text-muted mb-1"><span>{t('Иноды')}</span><span>{fmtPct(ino)}</span></div><Bar value={ino} tone={ino > 90 ? 'crit' : ino > 80 ? 'warn' : 'good'} /></div>}
                </div>
              ) : <div className="text-xs text-faint mt-3">{t('Использование диска собирается, когда pgmetrics запущен на хосте базы данных')}</div>}
            </button>
          )
        })}
      </div>
      {ts && (
        <>
          <Section title={t('Использование диска: {ts}', { ts })}>
            <Charts>
              <Chart title={t('Размер табличного пространства')} obj={`ts:${ts}`} unit="bytes" fields={[{ key: 'size', label: t('Размер') }]} />
              <Chart title={t('Диск')} obj={`ts:${ts}`} unit="bytes" fields={[{ key: 'disk_used', label: t('Занято') }, { key: 'disk_total', label: t('Всего') }]} />
            </Charts>
          </Section>
          <Section title={t('Объекты в {ts}', { ts })}>
            <div className="flex flex-wrap items-center gap-2 mb-3 text-[13px]">
              <span className="text-muted">{t('Сгенерировать SQL, чтобы')}</span>
              <Select className="w-32" value={action} onChange={setAction} options={[['move', t('перенести в')], ['drop', t('удалить')]]} />
              {action === 'move' && <Select className="w-44" value={target} onChange={setTarget} options={tss.map(t => t.name)} />}
              <span className="text-xs text-faint">{t('выбранные объекты')}</span>
            </div>
            <SqlSelection rows={objects} rowKey={o => `${o.kind}:${o.db_name}.${o.schema_name}.${o.name}`} empty={t('Здесь нет таблиц и индексов')}
              make={sel => byDb(sel, o => action === 'drop'
                ? `DROP ${o.kind === 'table' ? 'TABLE' : 'INDEX'} ${qname(o.schema_name, o.name)};`
                : `ALTER ${o.kind === 'table' ? 'TABLE' : 'INDEX'} ${qname(o.schema_name, o.name)} SET TABLESPACE ${qid(target)};`)}
              cols={[
                { key: 'name', label: t('Объект'), value: (o: any) => `${o.db_name}.${o.schema_name}.${o.name}` },
                { key: 'kind', label: t('Тип'), render: (o: any) => <Badge tone={o.kind === 'table' ? 'accent' : 'neutral'}>{o.kind === 'table' ? t('таблица') : t('индекс')}</Badge> },
                { key: 'size', label: t('Размер'), right: true, render: (o: any) => fmtBytes(o.size) },
              ]} />
          </Section>
        </>
      )}
    </>
  )
}

//------------------------------------------------------------------------------
// extensions, functions, sequences, triggers

export function ObjectsPage() {
  const { report } = useSrv()
  const R = report!
  const [tab, setTab] = useState<'ext' | 'fn' | 'seq' | 'trig'>('ext')
  const exts = arr(R.extensions)
  return (
    <>
      <PageHeader title={t('Расширения и прочее')} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'ext', label: t('Расширения'), count: exts.length }, { id: 'fn', label: t('Функции'), count: arr(R.user_functions).length },
        { id: 'seq', label: t('Последовательности'), count: arr(R.sequences).length }, { id: 'trig', label: t('Отключённые триггеры'), count: arr(R.disabled_triggers).length },
      ]} />
      <div className="mt-4">
        {tab === 'ext' && (
          <DataTable rows={exts} sort={['upgrade', true]} search={e => e.db_name + ' ' + e.name} cols={[
            { key: 'name', label: t('Расширение'), render: e => <span className="font-medium">{e.name}</span> },
            { key: 'db_name', label: t('База данных') },
            { key: 'schema_name', label: t('Схема') },
            { key: 'installed_version', label: t('Установлена') },
            { key: 'default_version', label: t('Доступна') },
            { key: 'upgrade', label: t('Статус'), value: e => (e.default_version && e.default_version !== e.installed_version ? 1 : 0),
              render: e => e.default_version && e.default_version !== e.installed_version ? <Badge tone="warn">{t('доступно обновление')}</Badge> : <Badge tone="good">{t('актуальна')}</Badge> },
            { key: 'comment', label: t('Описание'), className: 'text-muted max-w-sm' },
          ]} />
        )}
        {tab === 'fn' && (
          <DataTable rows={arr(R.user_functions)} sort={['total_time', true]} search={f => `${f.db_name}.${f.schema_name}.${f.name}`}
            empty={t('Нет статистики функций (установите track_functions = pl или all)')} cols={[
              { key: 'name', label: t('Функция'), value: f => `${f.schema_name}.${f.name}` },
              { key: 'db_name', label: t('База данных') },
              { key: 'calls', label: t('Вызовы'), right: true, render: f => fmtInt(f.calls) },
              { key: 'total_time', label: t('Общее время'), right: true, render: f => fmtMs(f.total_time) },
              { key: 'self_time', label: t('Собственное время'), right: true, render: f => fmtMs(f.self_time) },
              { key: 'mean', label: t('Среднее'), right: true, value: f => (f.calls ? f.total_time / f.calls : 0), render: f => fmtMs(f.calls ? f.total_time / f.calls : 0) },
            ]} />
        )}
        {tab === 'seq' && (
          <DataTable rows={arr(R.sequences)} sort={['blks', true]} search={s => `${s.db_name}.${s.schema_name}.${s.name}`} cols={[
            { key: 'name', label: t('Последовательность'), value: s => `${s.schema_name}.${s.name}` },
            { key: 'db_name', label: t('База данных') },
            { key: 'blks', label: t('Блоки: попадания'), right: true, value: s => s.blks_hit, render: s => fmtInt(s.blks_hit) },
            { key: 'blks_read', label: t('Блоки: чтения'), right: true, render: s => fmtInt(s.blks_read) },
          ]} />
        )}
        {tab === 'trig' && (
          <DataTable rows={arr(R.disabled_triggers)} empty={t('Нет отключённых триггеров')} cols={[
            { key: 'name', label: t('Триггер') },
            { key: 'table', label: t('Таблица'), value: t => `${t.db_name}.${t.schema_name}.${t.table_name}` },
            { key: 'proc_name', label: t('Функция') },
          ]} />
        )}
      </div>
    </>
  )
}

export function Roles() {
  const { report } = useSrv()
  const R = report!
  const yes = (b: boolean) => (b ? <Badge tone="accent">{t('да')}</Badge> : <span className="text-faint">—</span>)
  const n = arr(R.roles).length
  return (
    <>
      <PageHeader title={t('Роли')} sub={`${n} ${plural(n, ['роль', 'роли', 'ролей'])}`} />
      <DataTable rows={arr(R.roles)} sort={['name', false]} search={r => r.name} cols={[
        { key: 'name', label: t('Роль'), render: r => <span className="font-medium">{r.name}</span> },
        { key: 'rolcanlogin', label: t('Может входить'), value: r => +r.rolcanlogin, render: r => yes(r.rolcanlogin) },
        { key: 'rolsuper', label: t('Суперпользователь'), value: r => +r.rolsuper, render: r => (r.rolsuper ? <Badge tone="warn">{t('суперпользователь')}</Badge> : <span className="text-faint">—</span>) },
        { key: 'rolcreatedb', label: t('Создание БД'), value: r => +r.rolcreatedb, render: r => yes(r.rolcreatedb) },
        { key: 'rolcreaterole', label: t('Создание ролей'), value: r => +r.rolcreaterole, render: r => yes(r.rolcreaterole) },
        { key: 'rolreplication', label: t('Репликация'), value: r => +r.rolreplication, render: r => yes(r.rolreplication) },
        { key: 'rolbypassrls', label: t('Обход RLS'), value: r => +r.rolbypassrls, render: r => yes(r.rolbypassrls) },
        { key: 'rolconnlimit', label: t('Лимит подкл.'), right: true, render: r => (r.rolconnlimit < 0 ? '∞' : r.rolconnlimit) },
        { key: 'rolvaliduntil', label: t('Действует до'), render: r => (r.rolvaliduntil > 0 ? fmtTime(r.rolvaliduntil) : <span className="text-faint">{t('бессрочно')}</span>) },
        { key: 'memberof', label: t('Входит в роли'), render: r => <div className="flex flex-wrap gap-1">{arr(r.memberof).map((m: string) => <Badge key={m}>{m}</Badge>)}</div> },
      ]} />
    </>
  )
}
