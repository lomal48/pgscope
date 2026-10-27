import { useMemo, useState, type FormEvent } from 'react'
import { KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useApp } from '../lib/server'
import { Badge, Card, Code, CopyButton, ErrorBox, Field, PageHeader, Select } from '../components/ui'
import { LangSwitch } from '../components/Layout'
import { t, tk } from '../lib/i18n'
import { BROWSER_TZ, fmtDur, knownTZ, setTZ } from '../lib/format'
import { rich, setupCommands } from './Home'
import { NewPassword, pwHint } from './Auth'

// "UTC+03:00": the zone's offset now
const utcOffset = (zone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts()
    .find(p => p.type === 'timeZoneName')!.value.replace(/^GMT$/, 'GMT+00:00').replace('GMT', 'UTC')

// TZSelect applies the chosen zone at once and saves it to the profile; '' = the browser's zone
function TZSelect({ onError }: { onError: (e: unknown) => void }) {
  const { me, reloadMe } = useApp()
  // a saved zone this browser cannot show is not applied (setTZ), so it shows as the browser's
  const [cur, setCur] = useState(me.tz && knownTZ(me.tz) ? me.tz : '')
  // built once; browsers do not list UTC, and cur adds a saved zone this browser names differently
  const zones = useMemo(() => [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone'), cur].filter(Boolean))]
    .map(z => [z, `${z} (${utcOffset(z)})`] as [string, string]), [])
  const pick = (z: string) => {
    setCur(z)
    setTZ(z)
    api('/me/tz', 'PUT', { tz: z }).then(reloadMe, onError)
  }
  return <Select className="w-full sm:w-96" value={cur} onChange={pick} options={[['', t('Как в браузере ({zone})', { zone: BROWSER_TZ })], ...zones]} />
}

export function Profile() {
  const { me, reloadMe } = useApp()
  const [err, setErr] = useState<unknown>()
  const [msg, setMsg] = useState('')
  const [pw, setPw] = useState({ old: '', new: '' })
  const base = me.base_url
  const minGap = me.min_report_interval ?? 60 // PGSCOPE_MIN_REPORT_INTERVAL, seconds; 0 = no limit

  const regen = () => {
    if (!confirm(t('Сгенерировать новый API-ключ? Текущий ключ сразу перестанет работать.'))) return
    api('/me/apikey', 'POST', {}).then(reloadMe, setErr)
  }
  const changePw = (e: FormEvent) => {
    e.preventDefault()
    setErr(undefined)
    api('/me/password', 'POST', { Old: pw.old, New: pw.new }).then(() => { setMsg(tk('Пароль изменён.')); setPw({ old: '', new: '' }) }, setErr)
  }
  const del = () => {
    if (!confirm(me.team_member ? t('Удалить аккаунт?') : t('Удалить ваш аккаунт и ВСЕ данные серверов, владельцем которых вы являетесь? Это действие нельзя отменить.'))) return
    api('/me', 'DELETE', {}).then(() => location.reload(), setErr)
  }

  return (
    <>
      <PageHeader title={t('Профиль')} help="teams/profile" sub={me.email} actions={me.team_member ? <Badge tone="info">{t('Аккаунт участника команды')}</Badge> : undefined} />
      <div className="grid gap-4 max-w-4xl">
        {err != null && <ErrorBox error={err} />}
        {me.apikey && (
          <Card title={t('API-ключ')} sub={t('Используется pgdash CLI для отправки отчётов на этот сервер')}>
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-faint" />
              <code className="mono text-[13px] bg-panel-2 border border-line rounded-md px-2 py-1">{me.apikey}</code>
              <CopyButton text={me.apikey} />
              <button className="btn btn-sm ml-auto" onClick={regen}><RefreshCw className="size-3.5" />{t('Сгенерировать заново')}</button>
            </div>
          </Card>
        )}
        {me.apikey && (
          <Card title={t('Отправка отчётов')}>
            <div className="grid gap-4 text-[13px]">
              <p className="text-muted">
                {rich(t('Установите {pgmetrics} и {pgdash} с открытым исходным кодом, затем запускайте эту команду каждые 5 минут (через cron или в цикле).'), {
                  pgmetrics: <a className="link" href="https://pgmetrics.io" target="_blank" rel="noreferrer">pgmetrics</a>,
                  pgdash: <a className="link" href="https://github.com/rapidloop/pgdash" target="_blank" rel="noreferrer">pgdash CLI</a>,
                })}
                {minGap > 0 && ' ' + t('Интервал между отчётами одного сервера — не менее {interval}.', { interval: fmtDur(minGap) })}
              </p>
              <Code>{setupCommands(me.apikey, base, 'prod-db-1')}</Code>
              <div className="font-medium">PgBouncer</div>
              <Code>{`pgmetrics -h PGBOUNCER-HOST -p 6432 -U ADMIN -wfjson pgbouncer \\
  | pgdash -a ${me.apikey} --base-url=${base}/api/v1 report-pgbouncer prod-db-1 PGBOUNCER-NAME`}</Code>
              <div className="font-medium">Pgpool</div>
              <Code>{`pgmetrics -h PGPOOL-HOST -p 9999 -U USER -wfjson --pgpool postgres \\
  | pgdash -a ${me.apikey} --base-url=${base}/api/v1 report-pgpool PGPOOL-NAME`}</Code>
              <div className="font-medium">{t('Планы запросов и AWS RDS / Aurora')}</div>
              <p className="text-muted">
                {rich(t('Включите {pgss} для статистики запросов и {autoexplain} (формат JSON) для планов выполнения. Планы, взаимоблокировки и автоочистку pgmetrics берёт из журнала, который читает, только если запущен на хосте базы данных с локальным подключением; {logfile} лишь указывает путь к файлу. Журнал подходит в формате stderr или csvlog, но csvlog PostgreSQL 13+ читает только pgmetrics, собранный pgscope ({build} или из образа агента): официальные выпуски pgmetrics такие файлы пропускают. Для RDS и Aurora добавьте {rds}, чтобы собирать метрики CloudWatch и журнал через API RDS.'), {
                  pgss: <code className="mono">pg_stat_statements</code>,
                  autoexplain: <code className="mono">auto_explain</code>,
                  logfile: <code className="mono">--log-file</code>,
                  build: <code className="mono">tools/build-pgmetrics.sh</code>,
                  rds: <code className="mono">--aws-rds-dbid=ID</code>,
                })}
              </p>
            </div>
          </Card>
        )}
        <Card title={t('Язык')} sub={t('Язык сохраняется в вашем профиле.')}>
          <LangSwitch persist />
        </Card>
        <Card title={t('Часовой пояс')} sub={t('Даты и время в интерфейсе показываются в этом часовом поясе. Он сохраняется в вашем профиле.')}>
          <TZSelect onError={setErr} />
        </Card>
        <Card title={t('Смена пароля')}>
          <form onSubmit={changePw} className="grid sm:grid-cols-3 gap-3 items-end">
            <Field label={t('Текущий пароль')}><input className="input" type="password" required value={pw.old} onChange={e => setPw({ ...pw, old: e.target.value })} /></Field>
            <Field label={t('Новый пароль')}><NewPassword className="input" value={pw.new} onChange={v => setPw({ ...pw, new: v })} /></Field>
            <button className="btn btn-primary">{t('Сменить пароль')}</button>
          </form>
          <p className="text-[11px] text-faint mt-1">{pwHint()}</p>
          {msg && <p className="text-good text-xs mt-2">{t(msg)}</p>}
        </Card>
        <Card title={t('Опасная зона')}>
          <div className="flex items-center gap-3">
            <p className="text-muted text-[13px] flex-1">
              {me.team_member ? t('Удаление аккаунта не затронет серверы, к которым вам открыли доступ.') : t('Вместе с аккаунтом будут удалены все ваши серверы и все их данные.')}
            </p>
            <button className="btn btn-danger" onClick={del}><Trash2 className="size-3.5" />{t('Удалить аккаунт')}</button>
          </div>
        </Card>
      </div>
    </>
  )
}
