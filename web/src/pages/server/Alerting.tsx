import { useState, type FormEvent } from 'react'
import { BellOff, CheckCircle2, Mail, Plus, Send, Trash2, UserPlus } from 'lucide-react'
import { api, useApi } from '../../lib/api'
import { go } from '../../lib/router'
import { useApp, useSrv } from '../../lib/server'
import { fmtBytes, fmtDec, fmtDur, fmtMs, fmtTime } from '../../lib/format'
import { DataTable } from '../../components/Table'
import { Badge, Card, Code, CopyButton, Empty, ErrorBox, Field, Loading, PageHeader, Section, Select, SevBadge, Tabs } from '../../components/ui'
import { setupCommands } from '../Home'
import { LANGS, lang, t, tk } from '../../lib/i18n'

type MetricDef = { id: string; level: string; label: string; unit: string; param?: string }
type Rule = { id: number; metric: string; op: string; threshold: number; param: number; severity: string; match: string; match_text: string; db_name: string }
type Notifier = { id: number; scope: string; kind: string; target: string; lang: string }
type AlertItem = { type: string; text: string; value: string; objname: string; objlink: string; query?: string }
type AlertsResp = {
  catalog: MetricDef[]; change_kinds: { id: string; label: string }[]; notifier_kinds: string[]; rules: Rule[]
  status: AlertItem[]; status_at: string | null; changes: { kinds: string[]; size_pct: number }; notifiers: Notifier[]
  events: { at: string; kind: string; body: any }[]
}

const UNITS: Record<string, [string, number][]> = {
  bytes: [[tk('МиБ'), 1 << 20], [tk('ГиБ'), 1 << 30], [tk('КиБ'), 1024], [tk('ТиБ'), 2 ** 40]],
  secs: [[tk('минуты'), 60], [tk('секунды'), 1], [tk('часы'), 3600], [tk('дни'), 86400]],
  ms: [[tk('секунды'), 1000], [tk('миллисекунды'), 1], [tk('минуты'), 60000]],
  pct: [['%', 1]],
  count: [['', 1]],
}

const fmtThreshold = (unit: string, v: number) => unit === 'bytes' ? fmtBytes(v) : unit === 'secs' ? fmtDur(v) : unit === 'ms' ? fmtMs(v) : unit === 'pct' ? `${fmtDec(v, 6)}%` : fmtDec(v, 6)

const MATCH: [string, string][] = [['all', tk('все объекты')], ['contains', tk('имя содержит')], ['notcontains', tk('имя не содержит')], ['startswith', tk('имя начинается с')], ['endswith', tk('имя заканчивается на')], ['exact', tk('имя равно')]]

const LEVELS: [string, string][] = [['server', tk('Сервер')], ['database', tk('База данных')], ['table', tk('Таблица')], ['tablespace', tk('Табличное пространство')], ['query', tk('Запрос')]]

const APPLY_TO: Record<string, string> = { database: tk('Применять к базам данных'), table: tk('Применять к таблицам'), tablespace: tk('Применять к табличным пространствам'), query: tk('Применять к запросам') }

// translate the label column of [value, label] options at render time
const opts = (o: [string, string][]) => o.map(([v, l]) => [v, t(l)] as [string, string])

function ruleText(r: Rule, d?: MetricDef) {
  if (!d) return r.metric
  const label = d.param ? `${d.label} ${fmtDur(r.param)}` : d.label
  const value = fmtThreshold(d.unit, r.threshold)
  let s = r.op === 'gt' ? t('{label} больше {value}', { label, value }) : t('{label} меньше {value}', { label, value })
  const m = MATCH.find(m => m[0] === r.match)
  if (r.match !== 'all' && m) s += ' · ' + t('{match} «{text}»', { match: t(m[1]), text: r.match_text })
  if (r.db_name) s += ' · ' + t('в базе «{db}»', { db: r.db_name })
  return s
}

function RuleForm({ catalog, onAdd }: { catalog: MetricDef[]; onAdd: (r: Partial<Rule>) => Promise<unknown> }) {
  const [level, setLevel] = useState('server')
  const metrics = catalog.filter(m => m.level === level)
  const [metric, setMetric] = useState(metrics[0]?.id ?? '')
  const def = catalog.find(m => m.id === metric) ?? metrics[0]
  const [op, setOp] = useState('gt')
  const [value, setValue] = useState('')
  const [unitIdx, setUnitIdx] = useState('0')
  const [param, setParam] = useState('5')
  const [sev, setSev] = useState('warn')
  const [match, setMatch] = useState('all')
  const [text, setText] = useState('')
  const [db, setDb] = useState('')
  const [err, setErr] = useState<unknown>()
  const units = UNITS[def?.unit ?? 'count']
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setErr(undefined)
    onAdd({
      metric: def.id, op, severity: sev, threshold: Number(value) * units[Number(unitIdx)][1], param: Number(param) * 60,
      match: level === 'server' ? 'all' : match, match_text: text, db_name: level === 'table' || level === 'query' ? db : '',
    }).then(() => setValue(''), setErr)
  }
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid sm:grid-cols-[10rem_minmax(0,1fr)] gap-3">
        <Field label={t('Уровень')}><Select value={level} onChange={v => { setLevel(v); setMetric(catalog.find(m => m.level === v)?.id ?? '') }} options={opts(LEVELS)} /></Field>
        <Field label={t('Метрика')}><Select value={def?.id ?? ''} onChange={setMetric} options={metrics.map(m => [m.id, m.unit === 'bytes' ? t('{label} (байты)', { label: m.label }) : m.unit === 'secs' && !m.param ? t('{label} (время)', { label: m.label }) : m.label] as [string, string])} /></Field>
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        {def?.param && <Field label={t('Возраст транзакции (минуты)')}><input className="input w-28" type="number" min="0" step="any" value={param} onChange={e => setParam(e.target.value)} /></Field>}
        <Field label={t('Условие')}><Select className="w-36" value={op} onChange={setOp} options={[['gt', t('больше')], ['lt', t('меньше')]]} /></Field>
        <Field label={t('Порог')}><input className="input w-32" type="number" step="any" required value={value} onChange={e => setValue(e.target.value)} /></Field>
        {units.length > 1 ? <Field label={t('Единица')}><Select className="w-36" value={unitIdx} onChange={setUnitIdx} options={units.map((u, i) => [String(i), t(u[0])] as [string, string])} /></Field>
          : units[0][0] && <span className="pb-2 text-muted">{units[0][0]}</span>}
        <Field label={t('Важность')}><Select className="w-44" value={sev} onChange={setSev} options={[['warn', t('Предупреждение')], ['crit', t('Критично')]]} /></Field>
      </div>
      {level !== 'server' && (
        <div className="flex flex-wrap gap-3 items-end">
          <Field label={t(APPLY_TO[level])}><Select className="w-52" value={match} onChange={setMatch} options={opts(MATCH)} /></Field>
          {match !== 'all' && <Field label={t('Текст')}><input className="input w-48" required value={text} onChange={e => setText(e.target.value)} /></Field>}
          {(level === 'table' || level === 'query') && <Field label={t('Только в базе (необязательно)')}><input className="input w-48" value={db} onChange={e => setDb(e.target.value)} placeholder={t('любая база')} /></Field>}
        </div>
      )}
      {err != null && <ErrorBox error={err} />}
      <div><button className="btn btn-primary"><Plus className="size-3.5" />{t('Добавить правило')}</button></div>
    </form>
  )
}

// evaluated at render so the Russian entries follow the current language
const placeholder = (k: string) => ({
  email: 'ops@example.com, dba@example.com', slack: 'https://hooks.slack.com/services/…', pagerduty: t('Ключ интеграции Events API v2'),
  victorops: t('URL REST-эндпоинта с ключом маршрутизации'), xmatters: t('URL входящей интеграции'), webhook: 'https://example.com/pgscope-hook',
} as Record<string, string>)[k]
const kindLabel = (k: string) => ({ email: 'Email', slack: 'Slack', pagerduty: 'PagerDuty', victorops: 'VictorOps', xmatters: 'xMatters', webhook: t('Вебхук') } as Record<string, string>)[k]

function Notifiers({ scope, data, reload }: { scope: string; data: AlertsResp; reload: () => void }) {
  const { id } = useSrv()
  const { me } = useApp()
  const [kind, setKind] = useState('email')
  const [target, setTarget] = useState('')
  const [nlang, setNlang] = useState<string | null>(null) // follows the UI language until picked
  const [err, setErr] = useState<unknown>()
  const [sent, setSent] = useState('') // kind of the last test notification
  const list = data.notifiers.filter(n => n.scope === scope)
  const add = (e: FormEvent) => {
    e.preventDefault()
    setErr(undefined)
    api(`/servers/${id}/notifiers`, 'POST', { scope, kind, target, lang: nlang ?? lang }).then(() => { setTarget(''); reload() }, setErr)
  }
  const test = (n: Notifier) => {
    setSent(''); setErr(undefined)
    api(`/servers/${id}/notifiers/${n.id}/test`, 'POST', {}).then(() => setSent(n.kind), setErr)
  }
  return (
    <Card title={t('Уведомления')} sub={scope === 'alerts' ? t('Отправляются только при изменении набора сработавших оповещений, в том числе когда все оповещения сняты') : t('Отправляются при обнаружении изменений между последовательными отчётами')}>
      {list.length > 0 && (
        <ul className="divide-y divide-line mb-4">
          {list.map(n => (
            <li key={n.id} className="flex items-center gap-3 py-2">
              <Badge tone="accent">{kindLabel(n.kind)}</Badge>
              <span className="mono truncate flex-1">{n.target}</span>
              {n.lang && <span title={LANGS.find(l => l[0] === n.lang)?.[1]}><Badge>{n.lang.toUpperCase()}</Badge></span>}
              <button className="btn btn-sm" onClick={() => test(n)}><Send className="size-3.5" />{t('Проверить')}</button>
              <button className="btn btn-sm btn-danger" onClick={() => api(`/servers/${id}/notifiers/${n.id}`, 'DELETE', {}).then(reload)}><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap gap-2 items-end">
        <Field label={t('Канал')}><Select className="w-36" value={kind} onChange={setKind} options={data.notifier_kinds.map(k => [k, kindLabel(k)] as [string, string])} /></Field>
        <Field label={t('Адрес')}><input className="input w-96 max-w-full" required value={target} placeholder={placeholder(kind)} onChange={e => setTarget(e.target.value)} /></Field>
        <Field label={t('Язык уведомлений')}><Select className="w-32" value={nlang ?? lang} onChange={setNlang} options={LANGS} /></Field>
        <button className="btn"><Plus className="size-3.5" />{t('Добавить')}</button>
      </form>
      {kind === 'email' && !me.smtp && <p className="text-xs text-warn mt-2"><Mail className="size-3 inline mr-1" />{t('SMTP не настроен на этом сервере pgscope (PGSCOPE_SMTP_ADDR), поэтому письма не будут доставлены.')}</p>}
      {sent && <p className="text-xs text-good mt-2">{t('Тестовое уведомление отправлено ({kind}).', { kind: kindLabel(sent) })}</p>}
      {err != null && <div className="mt-2"><ErrorBox error={err} /></div>}
    </Card>
  )
}

export function Alerts() {
  const { id } = useSrv()
  const { reloadServers } = useApp()
  const { data, error, reload } = useApi<AlertsResp>(`/servers/${id}/alerts`)
  const [tab, setTab] = useState<'status' | 'rules' | 'notify' | 'history'>('status')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const def = (m: string) => data.catalog.find(c => c.id === m)
  const refresh = () => { reload(); reloadServers() }
  const addRule = (r: Partial<Rule>) => api(`/servers/${id}/alerts/rules`, 'POST', r).then(refresh)
  const events = data.events.filter(e => e.kind === 'alerts')
  return (
    <>
      <PageHeader title={t('Оповещения')} sub={data.status_at ? t('Проверено по отчёту от {time}', { time: fmtTime(new Date(data.status_at).getTime() / 1000) }) : t('Правила проверяются при поступлении каждого отчёта')} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'status', label: t('Сработавшие'), count: data.status.length }, { id: 'rules', label: t('Правила'), count: data.rules.length },
        { id: 'notify', label: t('Уведомления'), count: data.notifiers.filter(n => n.scope === 'alerts').length }, { id: 'history', label: t('История'), count: events.length },
      ]} />
      <div className="mt-4 grid gap-3">
        {tab === 'status' && (data.status.length === 0 ? (
          <Card><Empty icon={<CheckCircle2 className="size-8 text-good" />} title={t('Нет сработавших оповещений')}>
            {data.rules.length === 0 ? <>{t('Правил пока нет.')} <button className="link" onClick={() => setTab('rules')}>{t('Добавить правило')}</button>.</> : t('Все значения в пределах порогов.')}
          </Empty></Card>
        ) : (
          <DataTable rows={data.status} sort={['type', false]} onRow={a => { const h = a.objlink.split('#')[1]; if (h) go(h) }} cols={[
            { key: 'type', label: t('Важность'), value: a => (a.type === 'crit' ? 0 : 1), render: a => <SevBadge sev={a.type} /> },
            { key: 'text', label: t('Правило') },
            { key: 'objname', label: t('Объект'), render: a => <span className="font-medium">{a.objname}</span> },
            { key: 'value', label: t('Значение'), right: true },
            { key: 'query', label: t('Запрос'), className: 'mono text-muted max-w-sm', render: a => <span className="line-clamp-2 break-all">{a.query}</span> },
          ]} />
        ))}
        {tab === 'rules' && (
          <>
            <Card title={t('Новое правило')}><RuleForm catalog={data.catalog} onAdd={addRule} /></Card>
            {LEVELS.map(([lvl, label]) => {
              const rules = data.rules.filter(r => def(r.metric)?.level === lvl)
              return rules.length > 0 && (
                <Card key={lvl} title={t('Правила · {level}', { level: t(label) })}>
                  <ul className="divide-y divide-line">
                    {rules.map(r => (
                      <li key={r.id} className="flex items-center gap-3 py-2">
                        <SevBadge sev={r.severity} />
                        <span className="flex-1">{ruleText(r, def(r.metric))}</span>
                        <button className="btn btn-sm btn-danger" onClick={() => api(`/servers/${id}/alerts/rules/${r.id}`, 'DELETE', {}).then(refresh)}><Trash2 className="size-3.5" /></button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )
            })}
          </>
        )}
        {tab === 'notify' && <Notifiers scope="alerts" data={data} reload={reload} />}
        {tab === 'history' && (events.length === 0 ? <Card><Empty icon={<BellOff className="size-8" />} title={t('Уведомлений об оповещениях пока не было')} /></Card> : events.map((e, i) => (
          <Card key={i} title={fmtTime(new Date(e.at).getTime() / 1000)} sub={e.body.alerts.length ? t('Сработало оповещений: {n}', { n: e.body.alerts.length }) : t('Все оповещения сняты')}>
            {e.body.alerts.length === 0 ? <div className="flex items-center gap-2 text-good"><CheckCircle2 className="size-4" />{t('Оповещения сняты')}</div> : (
              <ul className="space-y-1">{e.body.alerts.map((a: AlertItem, k: number) => (
                <li key={k} className="flex items-center gap-2"><SevBadge sev={a.type} />{a.text} — <b>{a.objname}</b>: {a.value}</li>
              ))}</ul>
            )}
          </Card>
        )))}
      </div>
    </>
  )
}

export function ChangeAlerts() {
  const { id } = useSrv()
  const { data, error, reload } = useApi<AlertsResp>(`/servers/${id}/alerts`)
  const [kinds, setKinds] = useState<string[] | null>(null)
  const [pctv, setPct] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<unknown>()
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const sel = kinds ?? data.changes.kinds
  const sizePct = pctv ?? String(data.changes.size_pct)
  const toggle = (k: string) => { setSaved(false); setKinds(sel.includes(k) ? sel.filter(x => x !== k) : [...sel, k]) }
  const save = () => {
    setErr(undefined)
    api(`/servers/${id}/changes`, 'PUT', { kinds: sel, size_pct: Number(sizePct) }).then(() => { setSaved(true); reload() }, setErr)
  }
  const events = data.events.filter(e => e.kind === 'changes')
  return (
    <>
      <PageHeader title={t('Оповещения об изменениях')} sub={t('Каждый поступающий отчёт сравнивается с предыдущим, о важных изменениях отправляется уведомление')} />
      <div className="grid gap-3">
        <Card title={t('Отслеживаемые изменения')} actions={<div className="flex gap-2">
          <button className="btn btn-sm" onClick={() => { setSaved(false); setKinds(sel.length === data.change_kinds.length ? [] : data.change_kinds.map(k => k.id)) }}>
            {sel.length === data.change_kinds.length ? t('Снять все') : t('Выбрать все')}
          </button>
        </div>}>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
            {data.change_kinds.map(k => (
              <label key={k.id} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={sel.includes(k.id)} onChange={() => toggle(k.id)} />{k.label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3 mt-4">
            <Field label={t('«Резким» считается изменение более чем на (%)')}><input className="input w-28" type="number" min="1" value={sizePct} onChange={e => { setSaved(false); setPct(e.target.value) }} /></Field>
            <button className="btn btn-primary" onClick={save}>{t('Сохранить')}</button>
            {saved && <span className="text-good text-xs">{t('Сохранено')}</span>}
          </div>
          {err != null && <div className="mt-2"><ErrorBox error={err} /></div>}
        </Card>
        <Notifiers scope="changes" data={data} reload={reload} />
        <Section title={t('Обнаруженные изменения ({n})', { n: events.length })}>
          {events.length === 0 ? <Card><Empty icon={<BellOff className="size-8" />} title={t('Изменений пока не обнаружено')} /></Card> : events.map((e, i) => (
            <Card key={i} className="mb-2" title={fmtTime(e.body.currreport)} sub={t('по сравнению с отчётом от {time}', { time: fmtTime(e.body.prevreport) })}>
              <DataTable rows={e.body.changes} dense cols={[
                { key: 'item', label: t('Изменение'), render: (c: any) => <span className="font-medium">{c.item}</span> },
                { key: 'prev', label: t('Было'), className: 'mono text-muted break-all' },
                { key: 'curr', label: t('Стало'), className: 'mono break-all' },
              ]} />
            </Card>
          ))}
        </Section>
      </div>
    </>
  )
}

export function ServerSettings() {
  const { id, srv } = useSrv()
  const { me, reloadServers } = useApp()
  const { data, error, reload } = useApi<{ owner: string; is_owner: boolean; members: { id: number; email: string }[]; invites: { token: string; email: string; link: string }[] }>(`/servers/${id}/shares`)
  const [email, setEmail] = useState('')
  const [err, setErr] = useState<unknown>()
  const [confirmName, setConfirmName] = useState('')
  const invite = (e: FormEvent) => {
    e.preventDefault()
    setErr(undefined)
    api(`/servers/${id}/shares`, 'POST', { email }).then(() => { setEmail(''); reload() }, setErr)
  }
  const del = () => api(`/servers/${id}`, 'DELETE', {}).then(() => { reloadServers(); go('/') }, setErr)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <>
      <PageHeader title={t('Команда и настройки')} sub={srv.name} />
      <div className="grid gap-3 max-w-4xl">
        {err != null && <ErrorBox error={err} />}
        <Card title={t('Совместный доступ')} sub={t('Участники команды могут просматривать все данные, метрики и графики, а также изменять правила оповещений и уведомления. Удалять данные сервера и делиться ими дальше они не могут.')}>
          <ul className="divide-y divide-line">
            <li className="flex items-center gap-3 py-2"><span className="flex-1">{data.owner}</span><Badge tone="accent">{t('владелец')}</Badge></li>
            {data.members.map(m => (
              <li key={m.id} className="flex items-center gap-3 py-2">
                <span className="flex-1">{m.email}</span><Badge>{t('участник')}</Badge>
                {data.is_owner && <button className="btn btn-sm btn-danger" title={t('Отозвать доступ')} onClick={() => api(`/servers/${id}/shares/${m.id}`, 'DELETE', {}).then(reload)}><Trash2 className="size-3.5" /></button>}
              </li>
            ))}
            {data.invites.map(i => (
              <li key={i.token} className="flex items-center gap-3 py-2">
                <span className="flex-1">{i.email}</span><Badge tone="warn">{t('приглашён')}</Badge>
                <CopyButton text={i.link} />
                <button className="btn btn-sm btn-danger" title={t('Отменить приглашение')} onClick={() => api(`/servers/${id}/invites/${i.token}`, 'DELETE', {}).then(reload)}><Trash2 className="size-3.5" /></button>
              </li>
            ))}
          </ul>
          {data.is_owner ? (
            <form onSubmit={invite} className="flex flex-wrap gap-2 items-end mt-4">
              <Field label={t('Пригласить по email')}><input className="input w-80 max-w-full" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="colleague@example.com" /></Field>
              <button className="btn btn-primary"><UserPlus className="size-3.5" />{t('Пригласить')}</button>
              {!me.smtp && <span className="text-xs text-faint basis-full">{t('SMTP не настроен: скопируйте ссылку-приглашение из списка и отправьте её самостоятельно.')}</span>}
            </form>
          ) : <p className="text-xs text-muted mt-3">{t('Доступ предоставлен пользователем {owner}.', { owner: data.owner })}</p>}
        </Card>
        {me.apikey && data.is_owner && (
          <Card title={t('Команда отправки отчётов для этого сервера')}><Code>{setupCommands(me.apikey, me.base_url, srv.name)}</Code></Card>
        )}
        {data.is_owner && (
          <Card title={t('Удаление данных сервера')}>
            <p className="text-muted mb-3">{t('Безвозвратно удалить «{name}» со всеми отчётами, метриками, правилами оповещений и настройками доступа. Новые отчёты под этим именем создадут сервер заново.', { name: srv.name })}</p>
            <div className="flex gap-2 flex-wrap">
              <input className="input w-64" placeholder={t('введите {name} для подтверждения', { name: srv.name })} value={confirmName} onChange={e => setConfirmName(e.target.value)} />
              <button className="btn btn-danger" disabled={confirmName !== srv.name} onClick={del}><Trash2 className="size-3.5" />{t('Удалить сервер')}</button>
            </div>
          </Card>
        )}
      </div>
    </>
  )
}
