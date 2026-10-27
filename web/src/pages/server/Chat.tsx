import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Bot, Send, Sparkles, Trash2, User } from 'lucide-react'
import { api } from '../../lib/api'
import { useApp, useSrv } from '../../lib/server'
import { Card, Empty, ErrorBox, PageHeader, Spinner, cx } from '../../components/ui'
import { t, tk } from '../../lib/i18n'

type Msg = { role: 'user' | 'assistant'; content: string }

const SUGGESTED = [
  tk('Кратко оцени состояние этого сервера.'),
  tk('Какие запросы оптимизировать в первую очередь и как?'),
  tk('Какие индексы стоит удалить или добавить?'),
  tk('Справляется ли autovacuum? Есть ли риск переполнения счётчика транзакций?'),
  tk('Проверь конфигурацию под текущую нагрузку.'),
]

// tiny markdown subset: fenced code, headings, lists, **bold**, `code`
function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('`') && p.endsWith('`') ? <code key={i} className="mono bg-panel-2 rounded px-1">{p.slice(1, -1)}</code>
      : p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p)
}

function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = []
  const blocks = text.split(/```/)
  blocks.forEach((b, i) => {
    if (i % 2 === 1) {
      out.push(<pre key={i} className="mono bg-panel-2 border border-line rounded-lg p-3 overflow-x-auto my-2">{b.replace(/^\w*\n/, '')}</pre>)
      return
    }
    let list: ReactNode[] = []
    const flush = (k: string) => {
      if (list.length) out.push(<ul key={k} className="list-disc pl-5 my-1.5 space-y-0.5">{list}</ul>)
      list = []
    }
    b.split('\n').forEach((line, j) => {
      const k = `${i}-${j}`
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/)
      if (li) return void list.push(<li key={k}>{inline(li[1])}</li>)
      flush(k + 'l')
      const h = line.match(/^#{1,4}\s+(.*)/)
      if (h) out.push(<div key={k} className="font-semibold mt-3 mb-1">{inline(h[1])}</div>)
      else if (line.trim()) out.push(<p key={k} className="my-1">{inline(line)}</p>)
    })
    flush(`${i}-end`)
  })
  return <div className="leading-relaxed">{out}</div>
}

export function Chat() {
  const { id, srv } = useSrv()
  const { me } = useApp()
  const key = `chat:${id}`
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || '[]')
    } catch {
      return []
    }
  })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>()
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(msgs))
    } catch {
      /* storage unavailable */
    }
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, key])

  const send = (text: string) => {
    if (!text.trim() || busy) return
    const next: Msg[] = [...msgs, { role: 'user', content: text.trim() }]
    setMsgs(next)
    setInput('')
    setBusy(true)
    setErr(undefined)
    api<{ reply: string }>(`/servers/${id}/chat`, 'POST', { messages: next })
      .then(r => setMsgs([...next, { role: 'assistant', content: r.reply }]), e => { setErr(e); setMsgs(msgs) ; setInput(text) })
      .finally(() => setBusy(false))
  }
  const submit = (e: FormEvent) => { e.preventDefault(); send(input) }

  return (
    <>
      <PageHeader title={t('AI-чат')} sub={t('Спрашивайте о сервере «{name}» на любом языке. Ответы основаны на последнем отчёте — проверяйте их перед тем, как действовать.', { name: srv.name })}
        actions={msgs.length > 0 && <button className="btn btn-sm" onClick={() => setMsgs([])}><Trash2 className="size-3.5" />{t('Новый диалог')}</button>} />
      {!me.ai && <div className="mb-3"><ErrorBox error={t('AI-чат не настроен. Задайте PGSCOPE_AI_KEY (API-ключ Anthropic) и перезапустите pgscope.')} /></div>}
      <Card pad={false} className="flex flex-col h-[calc(100vh-15rem)] min-h-[420px]">
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {msgs.length === 0 && (
            <Empty icon={<Sparkles className="size-8 text-accent" />} title={t('Что вы хотите узнать?')}>
              <div className="flex flex-wrap gap-2 justify-center mt-3">
                {SUGGESTED.map(s => <button key={s} className="btn btn-sm" onClick={() => send(t(s))} disabled={!me.ai}>{t(s)}</button>)}
              </div>
            </Empty>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={cx('flex gap-3', m.role === 'user' && 'flex-row-reverse')}>
              <div className={cx('size-7 rounded-full grid place-items-center shrink-0', m.role === 'user' ? 'bg-panel-2' : 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white')}>
                {m.role === 'user' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
              </div>
              <div className={cx('rounded-2xl px-4 py-2.5 max-w-[80%] min-w-0', m.role === 'user' ? 'bg-accent text-white' : 'bg-panel-2')}>
                {m.role === 'user' ? <div className="whitespace-pre-wrap">{m.content}</div> : <Markdown text={m.content} />}
              </div>
            </div>
          ))}
          {busy && <div className="flex gap-3 items-center text-muted"><Spinner />{t('Думаю…')}</div>}
          {err != null && <ErrorBox error={err} />}
          <div ref={end} />
        </div>
        <form onSubmit={submit} className="border-t border-line p-3 flex gap-2">
          <textarea className="input flex-1 h-auto py-2 resize-none" rows={2} placeholder={t('Задайте вопрос…')} value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }} disabled={!me.ai} />
          <button className="btn btn-primary self-end h-10 w-10 p-0" disabled={busy || !input.trim()} aria-label={t('Отправить')}><Send className="size-4" /></button>
        </form>
      </Card>
    </>
  )
}
