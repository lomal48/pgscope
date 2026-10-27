import { useCallback, useEffect, useState } from 'react'
import { lang, t, useLang } from './i18n'

export class ApiError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept-Language': lang },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new ApiError(0, t('Не удалось связаться с сервером pgscope'))
  })
  const text = await r.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event('unauthorized'))
    throw new ApiError(r.status, data?.error || t('Ошибка HTTP {status}', { status: r.status }))
  }
  return data as T
}

export function useApi<T = any>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: !!path })
  const [n, setN] = useState(0)
  // backend texts are localized: refetch when the language changes
  const l = useLang()
  useEffect(() => {
    if (!path) return
    let live = true
    setState(s => ({ ...s, loading: true }))
    api<T>(path).then(
      data => live && setState({ data, loading: false }),
      error => live && setState({ error, loading: false }),
    )
    return () => {
      live = false
    }
  }, [path, n, l])
  const reload = useCallback(() => setN(x => x + 1), [])
  return { ...state, reload }
}
