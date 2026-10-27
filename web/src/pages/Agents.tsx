import { useEffect, useState } from 'react'
import { Container, Trash2 } from 'lucide-react'
import { api, useApi } from '../lib/api'
import { t, tk } from '../lib/i18n'
import { useApp } from '../lib/server'
import { fmtAgo, fmtDur, fmtTime } from '../lib/format'
import { DataTable } from '../components/Table'
import { Badge, Card, Code, Empty, ErrorBox, KV, Loading, PageHeader, type Tone } from '../components/ui'
import { rich } from './Home'

type Target = {
  name: string; kind: string; container: string; container_id: string; image: string; network: string; address: string
  status: string; error: string; last_ok: number; last_attempt: number; server_id?: number
}
type Agent = {
  agent_id: string
  info: { cluster: string; host: string; mode: string; version: string; docker_version: string; autoconnect: boolean; interval: number }
  targets: Target[]
  last_seen: string
  stale: boolean
}

const STATUS: Record<string, [string, Tone]> = {
  ok: [tk('Работает'), 'good'],
  pending: [tk('Ожидает первого сбора'), 'info'],
  unreachable: [tk('Недоступна'), 'crit'],
  auth_failed: [tk('Ошибка аутентификации'), 'crit'],
  error: [tk('Ошибка'), 'crit'],
}

function agentCompose(apikey: string, base: string) {
  return `# ${t('секреты агента: API-ключ pgscope и пароль роли pgscope_monitor')}
printf '%s' '${apikey}' > pgscope_api_key
printf '%s' 'MONITOR-PASSWORD' > pgscope_monitor_password
chmod 600 pgscope_api_key pgscope_monitor_password

# docker-compose.yml
services:
  pgscope-agent:
    image: pgscope-agent:latest
    restart: unless-stopped
    environment:
      PGSCOPE_URL: ${base}
    secrets: [pgscope_api_key, pgscope_monitor_password]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
secrets:
  pgscope_api_key:
    file: ./pgscope_api_key
  pgscope_monitor_password:
    file: ./pgscope_monitor_password`
}

function Setup() {
  const { me } = useApp()
  const code = (s: string) => <code className="mono">{s}</code>
  return (
    <div className="grid gap-4 text-[13px] max-w-3xl mx-auto pb-2">
      <ol className="list-decimal pl-5 space-y-1.5 text-muted">
        <li>{rich(t('Создайте во всех базах роль {role} с правами {grant}; для всех размеченных контейнеров хоста это делает скрипт {script}.'), {
          role: code('pgscope_monitor'), grant: code('pg_monitor'), script: code('deploy/agent/bootstrap-monitor-role.sh'),
        })}</li>
        <li>{rich(t('Добавьте контейнерам PostgreSQL метку {label} (в Swarm — в {labels} сервиса, не в {deploy}).'), {
          label: code('pgscope.enable=true'), labels: code('labels'), deploy: code('deploy.labels'),
        })}</li>
        <li>{rich(t('Запустите агента на каждом Docker-хосте (пример ниже) или глобальным сервисом в Swarm ({stack}; оверлейные сети баз объявите в стеке как {external}). Агент сам найдёт базы и начнёт отправлять отчёты.'), {
          stack: code('deploy/agent/docker-stack.yml'), external: code('external: true'),
        })}</li>
      </ol>
      {me.apikey && <Code>{agentCompose(me.apikey, me.base_url)}</Code>}
      <p className="text-xs text-muted">
        {rich(t('Подробности — в разделе документации {link}.'), { link: <a className="link" href="#/docs/docker">{t('Docker и Docker Swarm')}</a> })}
      </p>
    </div>
  )
}

function AgentCard({ a, onRemove }: { a: Agent; onRemove: () => void }) {
  const i = a.info
  const seen = Math.floor(new Date(a.last_seen).getTime() / 1000)
  return (
    <Card title={<span className="mono text-[13px]">{a.agent_id}</span>} actions={a.stale && (
      <>
        <Badge tone="warn">{t('Нет связи с агентом')}</Badge>
        <button className="btn btn-sm btn-danger" onClick={onRemove}><Trash2 className="size-3.5" />{t('Удалить')}</button>
      </>
    )}>
      <KV cols={3} items={[
        [t('Кластер'), i.cluster || '—'],
        [t('Хост'), i.host || '—'],
        [t('Режим'), i.mode === 'swarm' ? 'Swarm' : t('отдельный хост')],
        [t('Версия агента'), i.version || '—'],
        [t('Версия Docker'), i.docker_version || '—'],
        [t('Последний сигнал'), <span className={a.stale ? 'text-warn font-medium' : ''} title={fmtTime(seen)}>{fmtAgo(seen)}</span>],
        [t('Интервал сбора'), fmtDur(i.interval)],
        [t('Подключение к сетям баз'), i.autoconnect ? t('автоматически') : t('вручную')],
      ]} />
      <div className="mt-4">
        <DataTable rows={a.targets} dense sort={['name', false]} empty={t('Агент не нашёл контейнеров с меткой pgscope.enable=true')} cols={[
          { key: 'name', label: t('Имя'), render: x => (
            <span className="inline-flex items-center gap-1.5">
              {x.server_id
                ? <a className="link font-medium" href={`#/s/${x.server_id}${x.kind === 'pgbouncer' ? '/pgbouncer' : ''}`}>{x.name}</a>
                : <span className="font-medium">{x.name}</span>}
              {x.kind === 'pgbouncer' && <Badge tone="accent">PgBouncer</Badge>}
            </span>
          ) },
          { key: 'container', label: t('Контейнер'), render: x => <span title={x.container_id}>{x.container}</span> },
          { key: 'image', label: t('Образ') },
          { key: 'network', label: t('Сеть') },
          { key: 'address', label: t('Адрес подключения'), render: x => <span className="mono">{x.address}</span> },
          { key: 'status', label: t('Статус'), render: x => STATUS[x.status] ? <Badge tone={STATUS[x.status][1]}>{t(STATUS[x.status][0])}</Badge> : <Badge>{x.status}</Badge> },
          { key: 'error', label: t('Подробности'), className: 'max-w-md', render: x => <span className="mono text-muted break-words">{x.error}</span> },
          { key: 'last_ok', label: t('Последний успешный сбор'), right: true, render: x => <span title={x.last_attempt ? t('последняя попытка: {time}', { time: fmtTime(x.last_attempt) }) : undefined}>{fmtAgo(x.last_ok)}</span> },
        ]} />
      </div>
    </Card>
  )
}

// Docker agents: what each of them discovered and whether collection works
export function Agents() {
  const { data, error, reload } = useApi<Agent[]>('/agents')
  const [err, setErr] = useState<unknown>()
  useEffect(() => {
    const iv = setInterval(reload, 30_000)
    return () => clearInterval(iv)
  }, [reload])
  const remove = (a: Agent) => {
    if (!confirm(t('Удалить агента «{id}» из списка? Если он снова выйдет на связь, то появится здесь опять.', { id: a.agent_id }))) return
    api('/agents?id=' + encodeURIComponent(a.agent_id), 'DELETE', {}).then(reload, setErr)
  }
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <>
      <PageHeader title={t('Агенты')} help="docker/agents-page" sub={t('Агенты находят базы PostgreSQL в Docker и Docker Swarm и отправляют их отчёты в pgscope')} />
      <div className="grid gap-4">
        {err != null && <ErrorBox error={err} />}
        {data.length === 0 ? (
          <Card>
            <Empty icon={<Container className="size-8" />} title={t('Агентов пока нет')} />
            <Setup />
          </Card>
        ) : data.map(a => <AgentCard key={a.agent_id} a={a} onRemove={() => remove(a)} />)}
      </div>
    </>
  )
}
