import type { ReactNode } from 'react'
import { Database } from 'lucide-react'
import { t } from '../../lib/i18n'
import { match } from '../../lib/router'
import { useSrv, type ServerRow } from '../../lib/server'
import { Card, Empty, ErrorBox, Loading } from '../../components/ui'
import { Diagnostics, Overview } from './Overview'
import { Backends, Locks, Queries, QueryDetail } from './Activity'
import { DatabaseDetail, Databases, IndexDetail, IndexManagement, Indexes, ObjectsPage, Roles, TableDetail, Tables, Tablespaces, TopK } from './Objects'
import { CloudMetrics, Config, Logs, Replication, System, Vacuum, WAL } from './ServerPages'
import { PgBouncer, Pgpool } from './Integrations'
import { Alerts, ChangeAlerts, ServerSettings } from './Alerting'
import { Chat } from './Chat'

// pages that render from the latest report need it loaded first
function NeedsReport({ children }: { children: ReactNode }) {
  const { report, error } = useSrv()
  if (error) {
    return error.status === 404 ? (
      <Card><Empty icon={<Database className="size-8" />} title={t('Отчёт ещё не получен')}>{t('Отправьте отчёт pgmetrics для этого сервера, чтобы увидеть его данные.')}</Empty></Card>
    ) : <ErrorBox error={error} />
  }
  return report ? <>{children}</> : <Loading />
}

const routes: [string, (p: Record<string, string>) => ReactNode, boolean?][] = [
  ['/', () => <Overview />],
  ['/diagnostics', () => <Diagnostics />, false],
  ['/chat', () => <Chat />, false],
  ['/queries', () => <Queries />],
  ['/queries/:db/:qid', p => <QueryDetail db={p.db} qid={p.qid} />],
  ['/backends', () => <Backends />],
  ['/locks', () => <Locks />],
  ['/databases', () => <Databases />],
  ['/databases/:db', p => <DatabaseDetail db={p.db} />],
  ['/tables', () => <Tables />],
  ['/tables/:db/:schema/:name', p => <TableDetail db={p.db} schema={p.schema} name={p.name} />],
  ['/indexes', () => <Indexes />],
  ['/indexes/:db/:schema/:name', p => <IndexDetail db={p.db} schema={p.schema} name={p.name} />],
  ['/index-management', () => <IndexManagement />],
  ['/topk', () => <TopK />],
  ['/tablespaces', () => <Tablespaces />],
  ['/objects', () => <ObjectsPage />],
  ['/roles', () => <Roles />],
  ['/replication', () => <Replication />],
  ['/wal', () => <WAL />],
  ['/vacuum', () => <Vacuum />],
  ['/config', () => <Config />],
  ['/system', () => <System />],
  ['/logs', () => <Logs />],
  ['/cloud', () => <CloudMetrics />],
  ['/pgbouncer', () => <PgBouncer />, false],
  ['/alerts', () => <Alerts />, false],
  ['/change-alerts', () => <ChangeAlerts />, false],
  ['/settings', () => <ServerSettings />, false],
]

export function serverRoutes(srv: ServerRow, sub: string): ReactNode {
  if (srv.kind === 'pgpool' && sub !== '/settings') return <NeedsReport><Pgpool /></NeedsReport>
  for (const [pattern, render, needsReport = true] of routes) {
    const p = match(pattern, sub)
    if (p) return needsReport ? <NeedsReport>{render(p)}</NeedsReport> : render(p)
  }
  return <Empty title={t('Страница не найдена')} />
}
