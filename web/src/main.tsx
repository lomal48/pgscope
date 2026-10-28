import { lazy, StrictMode, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { api } from './lib/api'
import { setTZ, useTZ } from './lib/format'
import { setLang, t, useLang } from './lib/i18n'
import { match, usePath } from './lib/router'
import { App, loadServers, ServerProvider, type Me, type ServerRow } from './lib/server'
import { ServerBar, Shell } from './components/Layout'
import { Empty, ErrorBox, Loading } from './components/ui'
import { Agents } from './pages/Agents'
import { AcceptInvite, Login, Signup } from './pages/Auth'
import { Home } from './pages/Home'
import { Inspector } from './pages/Inspector'
import { Profile } from './pages/Profile'
import { serverRoutes } from './pages/server/routes'

// the docs (markdown + renderer) load only when opened
const Docs = lazy(() => import('./pages/Docs').then(m => ({ default: m.Docs })))

function Root() {
  const path = usePath()
  // re-render the whole tree on a language switch
  const l = useLang()
  useTZ() // and on a time zone switch
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [servers, setServers] = useState<ServerRow[]>([])
  const [listErr, setListErr] = useState<unknown>(undefined) // undefined: the server list has not loaded yet

  // signed out, dates are shown in the browser's time zone
  const signedOut = useCallback(() => {
    setTZ(null)
    setMe(null)
  }, [])
  const reloadMe = useCallback(() => {
    api<Me>('/me').then(m => {
      if (m?.lang) setLang(m.lang) // the saved language wins over the browser's
      setTZ(m?.tz)
      setMe(m)
    }, signedOut)
  }, [signedOut])
  const reloadServers = useCallback(() => {
    loadServers().then(s => {
      setServers(s)
      setListErr(null)
    }, setListErr)
  }, [])
  useEffect(reloadMe, [reloadMe])
  // alert texts in the list are localized: reload on a language switch too
  useEffect(() => {
    if (me) reloadServers()
  }, [me, reloadServers, l])
  useEffect(() => {
    addEventListener('unauthorized', signedOut)
    return () => removeEventListener('unauthorized', signedOut)
  }, [signedOut])
  useEffect(() => {
    if (!me) return
    const iv = setInterval(reloadServers, 60_000)
    return () => clearInterval(iv)
  }, [me, reloadServers])

  // docs are public: readable before signing in
  if (path === '/docs' || path.startsWith('/docs/')) return <Suspense fallback={<Loading />}><Docs path={path} signedIn={!!me} /></Suspense>
  const invite = match('/invite/:token', path)
  if (invite) return <AcceptInvite token={invite.token} onDone={reloadMe} />
  if (me === undefined) return <Loading />
  if (me === null) return path.startsWith('/signup') ? <Signup onDone={reloadMe} /> : <Login onDone={reloadMe} />

  const ctx = { me, servers, reloadServers, reloadMe }
  const s = match('/s/:id/*', path) ?? match('/s/:id', path)
  let page: ReactNode
  if (s) {
    const srv = servers.find(x => x.id === Number(s.id))
    if (!srv) {
      page = listErr === undefined ? <Loading />
        : listErr && !servers.length ? <div className="px-6 py-5"><ErrorBox error={listErr} /></div>
        : <Empty title={t('Сервер не найден')} />
    } else {
      const sub = '/' + (s['*'] ?? '')
      page = (
        <ServerProvider key={srv.id} srv={srv}>
          <ServerBar />
          <div className="px-6 py-5 max-w-[1600px]">{serverRoutes(srv, sub.replace(/\/$/, '') || '/')}</div>
        </ServerProvider>
      )
    }
    return <App.Provider value={ctx}><Shell serverId={srv?.id}>{page}</Shell></App.Provider>
  }
  page = path === '/inspector' ? <Inspector /> : path === '/agents' ? <Agents /> : path === '/profile' ? <Profile /> : <Home />
  return (
    <App.Provider value={ctx}>
      <Shell><div className="px-6 py-6 max-w-[1600px]">{page}</div></Shell>
    </App.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
