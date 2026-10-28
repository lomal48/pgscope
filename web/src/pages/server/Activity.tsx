import { useState } from 'react'
import { Lightbulb, Lock as LockIcon, Zap } from 'lucide-react'
import { go } from '../../lib/router'
import { arr, useSrv } from '../../lib/server'
import { fmtBytes, fmtDur, fmtInt, fmtMs, fmtNum, fmtPct, fmtTime, pct, plural, truncate } from '../../lib/format'
import { Chart, Charts } from '../../components/Chart'
import { DataTable } from '../../components/Table'
import { collectWarnings, parsePlan, PlanView } from '../../components/PlanView'
import { Badge, Bar, Card, Code, Crumbs, Empty, KV, PageHeader, Section, Select, Stat, Stats, cx, type Tone } from '../../components/ui'
import { t } from '../../lib/i18n'

const dbOptions = (rows: any[]) => [['', t('Все базы')] as [string, string], ...[...new Set(rows.map(r => r.db_name))].sort().map(d => [d, d] as [string, string])]

// renders a translated text whose {placeholders} are code snippets
const withCode = (s: string, code: Record<string, string>) =>
  s.split(/\{(\w+)\}/).map((p, i) => (i % 2 ? <code key={i} className="mono">{code[p]}</code> : p))

//------------------------------------------------------------------------------
// queries

const mean = (q: any) => (q.calls ? q.total_time / q.calls : 0)
const hitPct = (q: any) => pct(q.shared_blks_hit, q.shared_blks_hit + q.shared_blks_read)

// merges pg_stat_statements rows of one database + queryid (one per user): counters are summed,
// min/max taken over the rows that ran, stddev pooled; means stay total/count
function mergeStatements(rows: any[]): any {
  if (rows.length === 1) return rows[0]
  const out: any = { ...rows[0], user: [...new Set(rows.map(r => r.user).filter(Boolean))].join(', ') } // user may be empty (dropped role)
  for (const k of new Set(rows.flatMap(Object.keys))) { // zero counters may be omitted from a row
    if (rows.some(r => typeof r[k] === 'number') && !/oid$|^(min|max|stddev)_|_since$/.test(k)) out[k] = rows.reduce((a, r) => a + (r[k] ?? 0), 0)
  }
  for (const [n, x] of [['calls', 'time'], ['plans', 'plan_time']]) {
    const rs = rows.filter(r => r[n] > 0)
    if (!rs.length) continue
    out[`min_${x}`] = Math.min(...rs.map(r => r[`min_${x}`]))
    out[`max_${x}`] = Math.max(...rs.map(r => r[`max_${x}`]))
    // population stddev of the union: E[t²] − mean², where a row's E[t²] = stddev² + mean²
    const m = out[`total_${x}`] / out[n]
    const sq = rs.reduce((a, r) => a + r[n] * (r[`stddev_${x}`] ** 2 + (r[`total_${x}`] / r[n]) ** 2), 0) / out[n]
    out[`stddev_${x}`] = Math.sqrt(Math.max(0, sq - m * m))
  }
  return out
}

// one row per database + queryid, the same aggregation as the q:<db>:<queryid> charts
function queryStats(report: any): any[] {
  const g = new Map<string, any[]>()
  for (const q of arr(report.statements)) {
    const k = `${q.db_name}\u0000${q.queryid}`
    g.set(k, [...(g.get(k) ?? []), q])
  }
  return [...g.values()].map(mergeStatements)
}

export function Queries() {
  const { report, id } = useSrv()
  const stmts = queryStats(report)
  const [db, setDb] = useState('')
  const rows = stmts.filter(q => !db || q.db_name === db)
  const total = stmts.reduce((a, q) => a + q.total_time, 0)
  if (stmts.length === 0) {
    return (
      <>
        <PageHeader title={t('Запросы')} />
        <Card>
          <Empty icon={<Zap className="size-8" />} title={t('Нет статистики запросов')}>
            {withCode(t('Добавьте {ext} в {libs}, перезапустите PostgreSQL и выполните {create} в каждой базе. По умолчанию pgmetrics собирает 100 самых медленных запросов ({limit}).'),
              { ext: 'pg_stat_statements', libs: 'shared_preload_libraries', create: 'CREATE EXTENSION pg_stat_statements', limit: '--statements-limit' })}
          </Empty>
        </Card>
      </>
    )
  }
  return (
    <>
      <PageHeader title={t('Запросы')} sub={t('{n} {queries} из pg_stat_statements · общее время выполнения {time}', { n: stmts.length, queries: plural(stmts.length, ['запрос', 'запроса', 'запросов']), time: fmtMs(total) })} />
      <DataTable rows={rows} sort={['total_time', true]} search={q => q.query + ' ' + q.user + ' ' + q.db_name}
        onRow={q => go(`/s/${id}/queries/${encodeURIComponent(q.db_name)}/${q.queryid}`)}
        toolbar={<Select className="w-48" value={db} onChange={setDb} options={dbOptions(stmts)} />}
        cols={[
          { key: 'query', label: t('Запрос'), className: 'max-w-[520px]', render: q => <span className="mono line-clamp-2 break-all">{q.query}</span> },
          { key: 'db_name', label: t('База данных') },
          { key: 'user', label: t('Пользователь') },
          { key: 'calls', label: t('Вызовы'), right: true, render: q => fmtInt(q.calls) },
          { key: 'total_time', label: t('Общее время'), right: true, render: q => (
            <div className="flex items-center gap-2 justify-end"><Bar className="w-14" value={pct(q.total_time, total)} />{fmtMs(q.total_time)}</div>
          ) },
          { key: 'mean', label: t('Среднее'), right: true, value: mean, render: q => fmtMs(mean(q)) },
          { key: 'max_time', label: t('Макс.'), right: true, render: q => fmtMs(q.max_time) },
          { key: 'rows', label: t('Строк за вызов'), right: true, value: q => (q.calls ? q.rows / q.calls : 0), render: q => fmtNum(q.calls ? q.rows / q.calls : 0) },
          { key: 'hit', label: t('Попадания в кеш'), right: true, value: hitPct, render: q => <span className={cx(hitPct(q) < 90 && 'text-warn')}>{fmtPct(hitPct(q))}</span> },
          { key: 'temp', label: t('Временные файлы'), right: true, value: q => q.temp_blks_written, render: q => (q.temp_blks_written ? fmtBytes(q.temp_blks_written * 8192) : '—') },
        ]} />
    </>
  )
}

function suggestions(q: any, plans: any[]): string[] {
  const s: string[] = []
  const m = mean(q)
  const blocks = q.shared_blks_hit + q.shared_blks_read
  if (blocks > 10000 && hitPct(q) < 90)
    s.push(t('Только {pct} блоков читается из разделяемых буферов. Индекс, сокращающий число просматриваемых строк, или увеличение shared_buffers/RAM уменьшат чтение с диска.', { pct: fmtPct(hitPct(q)) }))
  if (q.temp_blks_written > 0)
    s.push(t('Запрос записал {size} во временные файлы: сортировки или хеширование не помещаются в память и уходят на диск. Увеличьте work_mem для этой нагрузки или добавьте индекс, обеспечивающий нужный порядок.', { size: fmtBytes(q.temp_blks_written * 8192) }))
  if (q.calls > 0 && q.rows / q.calls > 1000)
    s.push(t('Среднее число строк за вызов — {rows}. Если клиенту нужны не все строки, используйте LIMIT или keyset-пагинацию либо агрегируйте данные в SQL.', { rows: fmtNum(q.rows / q.calls) }))
  if (q.calls > 10 && q.stddev_time > 2 * m && q.max_time > 10 * m)
    s.push(t('Время выполнения сильно колеблется (среднее {mean}, макс. {max}, стандартное отклонение {stddev}). Проверьте планы, зависящие от параметров, ожидания блокировок и холодный кеш.', { mean: fmtMs(m), max: fmtMs(q.max_time), stddev: fmtMs(q.stddev_time) }))
  if (q.blk_read_time + q.blk_write_time > 0.3 * q.total_time && q.total_time > 1000)
    s.push(t('{pct} времени уходит на дисковый ввод-вывод.', { pct: fmtPct(pct(q.blk_read_time + q.blk_write_time, q.total_time)) }))
  if (q.total_plan_time > 0.5 * q.total_time && q.total_plan_time > 100)
    s.push(t('Планирование занимает в сумме {time} — сопоставимо с выполнением. Используйте подготовленные операторы, чтобы планировать запрос один раз.', { time: fmtMs(q.total_plan_time) }))
  const jit = (q.jit_generation_time ?? 0) + (q.jit_inlining_time ?? 0) + (q.jit_optimization_time ?? 0) + (q.jit_emission_time ?? 0)
  if (jit > 0.1 * q.total_time && jit > 100)
    s.push(t('JIT-компиляция занимает {time} ({pct} времени). Рассмотрите jit = off или более высокое значение jit_above_cost.', { time: fmtMs(jit), pct: fmtPct(pct(jit, q.total_time)) }))
  if (q.calls > 100000 && m < 0.5)
    s.push(t('Очень частый (вызовов: {calls}) и быстрый запрос. Кеширование результатов в приложении или пакетная обработка сократят число обращений к серверу.', { calls: fmtInt(q.calls) }))
  if (q.wal_bytes > 1 << 30) s.push(t('Запрос сгенерировал {size} WAL; массовые изменения стоит объединять в пакеты или выполнять через COPY.', { size: fmtBytes(q.wal_bytes) }))
  for (const p of plans) {
    const parsed = p.format === 'json' ? parsePlan(p.plan) : null
    if (parsed) s.push(...collectWarnings(parsed.root).map(w => t('План: {warning}', { warning: w })))
  }
  return [...new Set(s)]
}

// auto_explain logs literal SQL while pg_stat_statements shows $n placeholders:
// compare both with literals and placeholders replaced by "?"
const normSQL = (s: string) => s.toLowerCase().replace(/'(?:[^']|'')*'/g, '?').replace(/\$\d+/g, '?')
  .replace(/\b\d+(\.\d+)?\b/g, '?').replace(/\s+/g, ' ').replace(/[\s;]+$/, '').trim()

export function QueryDetail({ db, qid }: { db: string; qid: string }) {
  const { report, id } = useSrv()
  const q = queryStats(report).find(x => x.db_name === db && String(x.queryid) === qid)
  const norm = q ? normSQL(q.query) : ''
  const plans = !q ? [] : arr(report!.plans).filter(p => (p.queryid && String(p.queryid) === qid)
    || ((!p.db_name || p.db_name === db) && p.query && normSQL(p.query) === norm))
  // computed every render: the texts follow the current language
  const sugg = q ? suggestions(q, plans) : []
  const [allPlans, setAllPlans] = useState(false)
  const obj = `q:${db}:${qid}`
  return (
    <>
      <Crumbs items={[[t('Запросы'), `/s/${id}/queries`], [`${db} · ${qid}`]]} />
      <PageHeader title={t('Запрос')} sub={q ? `${q.user}@${q.db_name}` : t('Отсутствует в выбранном отчёте')} />
      {q && (
        <>
          <Code>{q.query}</Code>
          <div className="mt-3"><Stats>
            <Stat label={t('Вызовы')} value={fmtInt(q.calls)} />
            <Stat label={t('Общее время')} value={fmtMs(q.total_time)} />
            <Stat label={t('Среднее время')} value={fmtMs(mean(q))} />
            <Stat label={t('Макс. время')} value={fmtMs(q.max_time)} sub={t('мин. {time}', { time: fmtMs(q.min_time) })} />
            <Stat label={t('Строки')} value={fmtInt(q.rows)} sub={t('{n} за вызов', { n: fmtNum(q.calls ? q.rows / q.calls : 0) })} />
            <Stat label={t('Попадания в кеш')} value={fmtPct(hitPct(q))} tone={hitPct(q) < 90 ? 'warn' : 'good'} />
          </Stats></div>
        </>
      )}
      {sugg.length > 0 && (
        <Card title={<span className="flex items-center gap-1.5"><Lightbulb className="size-4 text-warn" />{t('Советы')}</span>} className="mt-3">
          <ul className="space-y-2 list-disc pl-5 marker:text-faint">{sugg.map(s => <li key={s}>{s}</li>)}</ul>
        </Card>
      )}
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Вызовы')} obj={obj} unit="ops" fields={[{ key: 'calls', label: t('Вызовы'), kind: 'rate' }]} />
          <Chart title={t('Среднее время выполнения')} obj={obj} unit="ms" sub={t('за интервал между отчётами')} fields={[{ key: 'mean', label: t('Среднее'), kind: 'ratio', of: ['total_time', 'calls'] }]} />
          <Chart title={t('Строки')} obj={obj} unit="ops" fields={[{ key: 'rows', label: t('Строки'), kind: 'rate' }]} />
          <Chart title={t('Разделяемые блоки')} obj={obj} unit="ops" fields={[{ key: 'shared_blks_hit', label: t('Попадания'), kind: 'rate' }, { key: 'shared_blks_read', label: t('Чтения'), kind: 'rate' }]} />
          <Chart title={t('Общее затраченное время')} obj={obj} unit="ms" sub={t('миллисекунд в секунду')} fields={[{ key: 'total_time', label: t('Время'), kind: 'rate' }]} />
          <Chart title={t('Записанные временные блоки')} obj={obj} unit="ops" fields={[{ key: 'temp_blks_written', label: t('Временные блоки'), kind: 'rate' }]} />
        </Charts>
      </Section>
      {q && (
        <Section title={t('Статистика')}>
          <Card><KV cols={3} items={[
            [t('Стандартное отклонение времени'), fmtMs(q.stddev_time)], [t('Разделяемые блоки: попадания'), fmtInt(q.shared_blks_hit)], [t('Разделяемые блоки: прочитано'), fmtInt(q.shared_blks_read)],
            [t('Разделяемые блоки: загрязнено'), fmtInt(q.shared_blks_dirtied)], [t('Разделяемые блоки: записано'), fmtInt(q.shared_blks_written)], [t('Локальные блоки: попадания / чтения'), `${fmtInt(q.local_blks_hit)} / ${fmtInt(q.local_blks_read)}`],
            [t('Временные блоки: чтение / запись'), `${fmtInt(q.temp_blks_read)} / ${fmtInt(q.temp_blks_written)}`], [t('Время чтения блоков'), fmtMs(q.blk_read_time)], [t('Время записи блоков'), fmtMs(q.blk_write_time)],
            [t('Планирований'), fmtInt(q.plans)], [t('Общее время планирования'), fmtMs(q.total_plan_time)], [t('Среднее время планирования'), fmtMs(q.plans ? q.total_plan_time / q.plans : 0)],
            [t('Записи WAL'), fmtInt(q.wal_records)], [t('Полные образы страниц в WAL'), fmtInt(q.wal_fpi)], [t('Объём WAL'), fmtBytes(q.wal_bytes)],
            [t('JIT-функции'), fmtInt(q.jit_functions)], [t('Время генерации JIT'), fmtMs(q.jit_generation_time)], [t('Идентификатор запроса'), <span className="mono">{q.queryid}</span>],
          ]} /></Card>
        </Section>
      )}
      <Section title={t('Планы выполнения ({n})', { n: plans.length })}>
        {plans.length === 0 ? (
          <Card><Empty title={t('Планы выполнения не собраны')}>
            {withCode(t('Планы берутся из вывода {ae} в журнале PostgreSQL (задайте {format}). pgmetrics читает журнал, только если запущен на хосте базы данных и подключается локально (через сокет или 127.0.0.1); {logfile} лишь указывает путь к файлу. Для AWS RDS / Aurora добавьте {rds}. Формат журнала — stderr ({dest}) с меткой времени в {prefix} или csvlog; csvlog PostgreSQL 13+ читает только pgmetrics, собранный pgscope ({build}), официальные выпуски его пропускают.'),
              { ae: 'auto_explain', format: 'auto_explain.log_format = json', logfile: '--log-file', build: 'tools/build-pgmetrics.sh', rds: '--aws-rds-dbid', dest: "log_destination = 'stderr'", prefix: "log_line_prefix = '%m [%p] %q%u@%d '" })}
          </Empty></Card>
        ) : (
          <>
            {[...plans].sort((a, b) => b.at - a.at).slice(0, allPlans ? undefined : 3).map((p, i) => (
              <Card key={i} title={t('План от {time}', { time: fmtTime(p.at) })} sub={p.user ? `${p.user}@${p.db_name || db}` : undefined} className="mb-3"><PlanView plan={p.plan} format={p.format} /></Card>
            ))}
            {plans.length > 3 && !allPlans && <button className="btn" onClick={() => setAllPlans(true)}>{t('Показать все планы ({n})', { n: plans.length })}</button>}
          </>
        )}
      </Section>
    </>
  )
}

//------------------------------------------------------------------------------
// backends

const stateTone = (s: string): Tone => (s === 'active' ? 'good' : s?.startsWith('idle in transaction') ? 'warn' : s === 'idle' ? 'neutral' : 'info')

export function Backends() {
  const { report } = useSrv()
  const R = report!
  const at = R.meta.at
  const all = arr(R.backends)
  const [f, setF] = useState({ db: '', user: '', app: '', state: '', wait: false })
  const rows = all.filter(b => (!f.db || b.db_name === f.db) && (!f.user || b.role_name === f.user) && (!f.app || b.application_name === f.app)
    && (!f.state || b.state === f.state) && (!f.wait || b.wait_event_type === 'Lock'))
  const opts = (k: string, label: string) => [['', label] as [string, string], ...[...new Set(all.map(b => b[k]).filter(Boolean))].sort().map(v => [v, v] as [string, string])]
  const count = (p: (b: any) => boolean) => all.filter(p).length
  const longX = count(b => b.xact_start && at - b.xact_start > 300)
  return (
    <>
      <PageHeader title={t('Бэкенды')} sub={t('{n} {connections} на {time}', { n: all.length, connections: plural(all.length, ['подключение', 'подключения', 'подключений']), time: fmtTime(at) })} />
      <Stats>
        <Stat label={t('Всего')} value={all.length} />
        <Stat label={t('Активные')} value={count(b => b.state === 'active')} tone="good" />
        <Stat label={t('Простаивают')} value={count(b => b.state === 'idle')} />
        <Stat label={t('Простой в транзакции')} value={count(b => b.state?.startsWith('idle in transaction'))} tone={count(b => b.state?.startsWith('idle in transaction')) ? 'warn' : undefined} />
        <Stat label={t('Ждут блокировок')} value={count(b => b.wait_event_type === 'Lock')} tone={count(b => b.wait_event_type === 'Lock') ? 'crit' : undefined} />
        <Stat label={t('Транзакции > 5 мин')} value={longX} tone={longX ? 'warn' : undefined} />
      </Stats>
      <div className="mt-4">
        <DataTable rows={rows} sort={['xact', true]} search={b => `${b.pid} ${b.query} ${b.client_addr}`} dense
          rowClass={b => (b.wait_event_type === 'Lock' ? 'bg-crit/5' : b.state?.startsWith('idle in transaction') ? 'bg-warn/5' : undefined)}
          toolbar={<>
            <Select className="w-40" value={f.db} onChange={v => setF({ ...f, db: v })} options={opts('db_name', t('Все базы'))} />
            <Select className="w-36" value={f.user} onChange={v => setF({ ...f, user: v })} options={opts('role_name', t('Все пользователи'))} />
            <Select className="w-40" value={f.app} onChange={v => setF({ ...f, app: v })} options={opts('application_name', t('Все приложения'))} />
            <Select className="w-44" value={f.state} onChange={v => setF({ ...f, state: v })} options={opts('state', t('Все состояния'))} />
            <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={f.wait} onChange={e => setF({ ...f, wait: e.target.checked })} />{t('Только ожидающие')}</label>
          </>}
          cols={[
            { key: 'pid', label: 'PID', right: true },
            { key: 'db_name', label: t('База данных') },
            { key: 'role_name', label: t('Пользователь') },
            { key: 'application_name', label: t('Приложение'), render: b => truncate(b.application_name, 24) },
            { key: 'client_addr', label: t('Клиент'), render: b => <span className="mono">{b.client_addr || t('локально')}</span> },
            { key: 'state', label: t('Состояние'), render: b => b.state ? <Badge tone={stateTone(b.state)}>{b.state}</Badge> : <span className="text-faint">—</span> },
            { key: 'wait', label: t('Ожидание'), value: b => b.wait_event_type, render: b => b.wait_event ? <span className={cx(b.wait_event_type === 'Lock' && 'text-crit')}>{b.wait_event_type}: {b.wait_event}</span> : '' },
            { key: 'xact', label: t('Возраст транзакции'), right: true, value: b => (b.xact_start ? at - b.xact_start : -1), render: b => b.xact_start ? <span className={cx(at - b.xact_start > 300 && 'text-warn font-medium')}>{fmtDur(at - b.xact_start)}</span> : '' },
            { key: 'qage', label: t('Возраст запроса'), right: true, value: b => (b.query_start ? at - b.query_start : -1), render: b => (b.query_start ? fmtDur(at - b.query_start) : '') },
            { key: 'bage', label: t('Подключён'), right: true, value: b => at - b.backend_start, render: b => fmtDur(at - b.backend_start) },
            { key: 'query', label: t('Запрос'), className: 'max-w-[420px]', render: b => <span className="mono line-clamp-2 break-all text-muted">{b.query}</span> },
          ]} />
      </div>
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Бэкенды по состояниям')} obj="" unit="count" fields={[{ key: 'active', label: t('Активные') }, { key: 'idle', label: t('Простаивают') }, { key: 'idle_in_xact', label: t('Простой в транзакции') }, { key: 'waiting', label: t('Ожидают') }]} />
          <Chart title={t('Долгие транзакции (> 5 мин)')} obj="" unit="count" fields={[{ key: 'long_xact', label: t('Долгие транзакции') }]} />
        </Charts>
      </Section>
      {R.betypecounts && (
        <Section title={t('Типы бэкендов')}>
          <div className="flex flex-wrap gap-2">
            {Object.entries(R.betypecounts as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, v]) => <Badge key={k}>{k}: {v}</Badge>)}
          </div>
        </Section>
      )}
    </>
  )
}

//------------------------------------------------------------------------------
// locks

export function Locks() {
  const { report } = useSrv()
  const R = report!
  const at = R.meta.at
  const backends = new Map(arr(R.backends).map(b => [b.pid, b]))
  const blocking: Record<string, number[]> = R.blocking_pids ?? {}
  const waiting = new Set(Object.keys(blocking).map(Number).filter(p => blocking[p]?.length))
  const blockers = new Set(Object.values(blocking).flat())
  const roots = [...blockers].filter(p => !waiting.has(p))
  if (roots.length === 0 && waiting.size) roots.push(...blockers) // cycle: show everyone involved
  const children = (pid: number) => [...waiting].filter(w => blocking[w].includes(pid))
  const tables = new Map(arr(R.tables).map(t => [`${t.db_name}/${t.oid}`, `${t.schema_name}.${t.name}`]))
  const indexes = new Map(arr(R.indexes).map(t => [`${t.db_name}/${t.oid}`, `${t.schema_name}.${t.name}`]))
  const relName = (l: any) => (l.relation_oid ? tables.get(`${l.db_name}/${l.relation_oid}`) ?? indexes.get(`${l.db_name}/${l.relation_oid}`) ?? `oid ${l.relation_oid}` : '')

  const Node = ({ pid, depth, seen }: { pid: number; depth: number; seen: Set<number> }) => {
    const b = backends.get(pid)
    const kids = seen.has(pid) ? [] : children(pid)
    const next = new Set(seen).add(pid)
    return (
      <div className={cx(depth > 0 && 'ml-6 border-l-2 border-crit/30 pl-4')}>
        <div className="py-2 flex gap-3 items-start">
          <Badge tone={depth === 0 ? 'crit' : 'warn'}>{depth === 0 ? t('блокирует') : t('ждёт')}</Badge>
          <div className="min-w-0 flex-1">
            <div className="text-[13px]"><b>pid {pid}</b> <span className="text-muted">{b ? `${b.role_name}@${b.db_name} · ${b.state}` : ''}</span>
              {b?.xact_start ? <span className="text-muted"> · {t('транзакция открыта {dur}', { dur: fmtDur(at - b.xact_start) })}</span> : null}</div>
            {b?.query && <div className="mono text-muted truncate">{b.query}</div>}
          </div>
        </div>
        {kids.map(k => <Node key={k} pid={k} depth={depth + 1} seen={next} />)}
      </div>
    )
  }

  const locks = arr(R.locks)
  return (
    <>
      <PageHeader title={t('Блокировки')} sub={t('Блокировок: {n}, не выдано: {waiting}', { n: locks.length, waiting: locks.filter(l => !l.granted).length })} />
      <Card title={t('Цепочки блокировок')} sub={t('Какие запросы ждут завершения других')}>
        {roots.length === 0 ? (
          <Empty icon={<LockIcon className="size-7" />} title={t('Нет заблокированных бэкендов')}>{t('Никто не ждёт блокировку, удерживаемую другим бэкендом.')}</Empty>
        ) : roots.map(r => <Node key={r} pid={r} depth={0} seen={new Set()} />)}
      </Card>
      <Section title={t('Все блокировки')}>
        <DataTable rows={locks} sort={['granted', false]} search={l => `${l.pid} ${l.mode} ${l.locktype} ${relName(l)}`} dense
          rowClass={l => (!l.granted ? 'bg-crit/5' : undefined)}
          cols={[
            { key: 'pid', label: 'PID', right: true },
            { key: 'db_name', label: t('База данных') },
            { key: 'locktype', label: t('Тип') },
            { key: 'mode', label: t('Режим') },
            { key: 'rel', label: t('Отношение'), value: relName },
            { key: 'granted', label: t('Выдана'), value: l => (l.granted ? 1 : 0), render: l => l.granted ? <Badge tone="good">{t('выдана')}</Badge> : <Badge tone="crit">{t('ждёт')}</Badge> },
            { key: 'waitstart', label: t('Ждёт'), right: true, value: l => l.waitstart || 0, render: l => (l.waitstart ? fmtDur(at - l.waitstart) : '') },
          ]} />
      </Section>
      {arr(R.stat_locks).length > 0 && (
        <Section title={t('Статистика ожиданий блокировок')}>
          <DataTable rows={arr(R.stat_locks)} sort={['wait_time', true]} cols={[
            { key: 'locktype', label: t('Тип блокировки') },
            { key: 'waits', label: t('Ожидания'), right: true, render: s => fmtInt(s.waits) },
            { key: 'wait_time', label: t('Время ожидания'), right: true, render: s => fmtMs(s.wait_time) },
            { key: 'fastpath_exceeded', label: t('Превышений fast-path'), right: true, render: s => fmtInt(s.fastpath_exceeded) },
          ]} />
        </Section>
      )}
      <Section title={t('Динамика')}>
        <Charts>
          <Chart title={t('Блокировки')} obj="" unit="count" fields={[{ key: 'locks', label: t('Удерживаются') }, { key: 'locks_waiting', label: t('Не выданы') }]} />
          <Chart title={t('Взаимоблокировки')} obj="" unit="opm" fields={[{ key: 'deadlocks', label: t('Взаимоблокировки'), kind: 'rate', scale: 60 }]} />
        </Charts>
      </Section>
      {arr(R.deadlocks).length > 0 && (
        <Section title={t('Взаимоблокировки в журнале')}>
          {arr(R.deadlocks).map((d, i) => <Card key={i} title={fmtTime(d.at)} className="mb-2"><Code copy={false}>{d.detail}</Code></Card>)}
        </Section>
      )}
    </>
  )
}

