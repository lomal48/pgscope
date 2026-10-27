import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Activity, Bell, BookOpen, Bot, Stethoscope } from 'lucide-react'
import { api } from '../lib/api'
import { go } from '../lib/router'
import { LangSwitch, Logo } from '../components/Layout'
import { t, tk, useLang } from '../lib/i18n'
import { rich } from './Home'
import { ErrorBox, Field, Spinner } from '../components/ui'

function AuthLayout({ children }: { children: ReactNode }) {
  const feats: [ReactNode, string, string][] = [
    [<Activity className="size-4" />, t('Подробные метрики PostgreSQL'), t('Запросы, таблицы, индексы, блокировки, репликация, WAL и очистка — в одном месте.')],
    [<Stethoscope className="size-4" />, t('Автоматическая диагностика'), t('Находит раздувание, неиспользуемые индексы, риск переполнения счётчика транзакций (wraparound) и ошибки конфигурации.')],
    [<Bell className="size-4" />, t('Оповещения, в том числе об изменениях'), t('Email, Slack, PagerDuty, VictorOps, xMatters и вебхуки.')],
    [<Bot className="size-4" />, t('AI-чат'), t('Задавайте вопросы о сервере простым языком.')],
  ]
  return (
    <div className="min-h-full grid lg:grid-cols-2 relative">
      <div className="hidden lg:flex flex-col justify-between p-10 bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 text-white relative overflow-hidden">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute -left-10 bottom-0 size-80 rounded-full bg-indigo-300/20 blur-3xl" />
        <div className="relative font-semibold text-lg tracking-tight">pgscope</div>
        <div className="relative">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight max-w-md">{t('Глубокий мониторинг PostgreSQL на вашей собственной инфраструктуре.')}</h1>
          <div className="mt-8 grid gap-4 max-w-md">
            {feats.map(([icon, title, d]) => (
              <div key={title} className="flex gap-3">
                <div className="size-8 rounded-lg bg-white/15 grid place-items-center shrink-0">{icon}</div>
                <div>
                  <div className="font-medium">{title}</div>
                  <div className="text-white/75 text-[13px]">{d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-white/60 text-xs">{t('Работает с pgmetrics и pgdash CLI.')}</div>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          {children}
        </div>
      </div>
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <a className="btn btn-ghost btn-sm" href="#/docs"><BookOpen className="size-3.5" />{t('Документация')}</a>
        <LangSwitch persist={false} />
      </div>
    </div>
  )
}

// the server's password rule: 8+ characters, at most 72 bytes of UTF-8 (the bcrypt limit)
const PW_RULE = tk('Пароль должен содержать от 8 символов и не более 72 байт (символ кириллицы занимает 2 байта)')
const pwOk = (p: string) => [...p].length >= 8 && new TextEncoder().encode(p).length <= 72
export const pwHint = () => t('От 8 символов, не более 72 байт (символ кириллицы — 2 байта)')

export function NewPassword({ value, onChange, className = 'input h-10' }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <input className={className} type="password" autoComplete="new-password" required value={value}
      onChange={e => { e.target.setCustomValidity(pwOk(e.target.value) ? '' : t(PW_RULE)); onChange(e.target.value) }} />
  )
}

// may a new account sign up now (PGSCOPE_SIGNUP)? If the server cannot tell, offer it: POST /api/signup decides
function useSignupOpen() {
  const [open, setOpen] = useState<boolean>()
  useEffect(() => {
    api<{ open: boolean }>('/signup').then(r => setOpen(r?.open !== false), () => setOpen(true))
  }, [])
  return open
}

function useSubmit(fn: () => Promise<unknown>, onDone: () => void) {
  const [err, setErr] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(undefined)
    fn().then(onDone, setErr).finally(() => setBusy(false))
  }
  return { err, busy, submit }
}

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { err, busy, submit } = useSubmit(() => api('/login', 'POST', { email, password }), () => { go('/'); onDone() })
  const signupOpen = useSignupOpen()
  return (
    <AuthLayout>
      <h2 className="text-2xl font-semibold tracking-tight">{t('Вход')}</h2>
      <p className="text-muted mt-1">{t('С возвращением!')}</p>
      <form onSubmit={submit} className="mt-6 grid gap-4">
        <Field label="Email"><input className="input h-10" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label={t('Пароль')}><input className="input h-10" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>
        {err != null && <ErrorBox error={err} />}
        <button className="btn btn-primary h-10" disabled={busy}>{busy && <Spinner />}{t('Войти')}</button>
      </form>
      {signupOpen && <p className="text-muted mt-6 text-[13px]">{t('Ещё нет аккаунта?')} <a className="link" href="#/signup">{t('Регистрация')}</a></p>}
    </AuthLayout>
  )
}

export function Signup({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { err, busy, submit } = useSubmit(() => api('/signup', 'POST', { email, password }), () => { go('/'); onDone() })
  const open = useSignupOpen()
  return (
    <AuthLayout>
      <h2 className="text-2xl font-semibold tracking-tight">{t('Регистрация')}</h2>
      {open === undefined ? <div className="mt-6"><Spinner /></div> : !open ? (
        <p className="text-muted mt-1">{t('Регистрация новых аккаунтов отключена. Попросите администратора пригласить вас.')}</p>
      ) : (
        <>
          <p className="text-muted mt-1">{t('Вы получите API-ключ для отправки отчётов pgmetrics.')}</p>
          <form onSubmit={submit} className="mt-6 grid gap-4">
            <Field label="Email"><input className="input h-10" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
            <Field label={t('Пароль')} hint={pwHint()}><NewPassword value={password} onChange={setPassword} /></Field>
            {err != null && <ErrorBox error={err} />}
            <button className="btn btn-primary h-10" disabled={busy}>{busy && <Spinner />}{t('Зарегистрироваться')}</button>
          </form>
        </>
      )}
      <p className="text-muted mt-6 text-[13px]">{t('Уже есть аккаунт?')} <a className="link" href="#/">{t('Войти')}</a></p>
    </AuthLayout>
  )
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; server: string } | null>(null)
  const [loadErr, setLoadErr] = useState<unknown>()
  const [password, setPassword] = useState('')
  const l = useLang() // the load error comes localized from the backend: refetch on a language switch
  useEffect(() => {
    api(`/invite/${encodeURIComponent(token)}`).then(setInfo, setLoadErr)
  }, [token, l])
  const { err, busy, submit } = useSubmit(
    () => api<{ server_id: number }>(`/invite/${encodeURIComponent(token)}`, 'POST', { password }).then(r => go(`/s/${r.server_id}`)),
    onDone,
  )
  return (
    <AuthLayout>
      <h2 className="text-2xl font-semibold tracking-tight">{t('Присоединиться к команде')}</h2>
      {loadErr != null ? <div className="mt-6"><ErrorBox error={loadErr} /></div> : !info ? <div className="mt-6"><Spinner /></div> : (
        <>
          <p className="text-muted mt-1">{rich(t('Вас пригласили просматривать сервер «{server}». Задайте пароль для {email}.'), {
            server: <b className="text-fg">{info.server}</b>, email: <b className="text-fg">{info.email}</b>,
          })}</p>
          <form onSubmit={submit} className="mt-6 grid gap-4">
            <Field label={t('Пароль')} hint={pwHint()}><NewPassword value={password} onChange={setPassword} /></Field>
            {err != null && <ErrorBox error={err} />}
            <button className="btn btn-primary h-10" disabled={busy}>{busy && <Spinner />}{t('Принять приглашение')}</button>
          </form>
        </>
      )}
    </AuthLayout>
  )
}
