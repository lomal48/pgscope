import { useEffect, useState } from 'react'

// hash routing: #/s/1/tables?db=shop
const current = () => location.hash.slice(1) || '/'

export function usePath() {
  const [p, setP] = useState(current)
  useEffect(() => {
    const h = () => setP(current())
    addEventListener('hashchange', h)
    return () => removeEventListener('hashchange', h)
  }, [])
  return p
}

export const go = (path: string) => {
  location.hash = path
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/')
  const b = path.split('?')[0].split('/')
  const out: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '*') {
      out['*'] = b.slice(i).join('/')
      return out
    }
    if (i >= b.length) return null
    if (a[i].startsWith(':')) out[a[i].slice(1)] = decodeURIComponent(b[i])
    else if (a[i] !== b[i]) return null
  }
  return a.length === b.length ? out : null
}

export const enc = encodeURIComponent

export function useQuery(): URLSearchParams {
  const p = usePath()
  return new URLSearchParams(p.split('?')[1] || '')
}

// ?at= of a hash path (UTC ISO 8601 or unix seconds) in unix seconds; null when absent, invalid or in the future
export function atOf(path: string): number | null {
  const v = new URLSearchParams(path.split('?')[1] ?? '').get('at')
  const n = v ? Math.floor(/^\d+$/.test(v) ? Number(v) : Date.parse(v) / 1000) : NaN
  return n > 0 && n <= Date.now() / 1000 ? n : null
}

// path with ?at= set to ts as UTC ISO with seconds (2026-10-27T00:12:57Z), or removed when ts is null
export function withAt(path: string, ts: number | null): string {
  const [p, q] = path.split('?')
  const u = new URLSearchParams(q)
  if (ts) u.set('at', new Date(ts * 1000).toISOString().slice(0, 19) + 'Z')
  else u.delete('at')
  const s = u.toString().replace(/%3A/gi, ':')
  return s ? `${p}?${s}` : p
}

// setHash changes the hash in place (push: as a new Back step), marks the entry as seen by the app
// (ServerProvider tells Back/Forward from a fresh link click by it) and notifies usePath
export function setHash(path: string, push = false) {
  try {
    history[push && '#' + path !== location.hash ? 'pushState' : 'replaceState']({ seen: 1 }, '', '#' + path)
  } catch {
    /* Safari throttles frequent history calls; the moment in memory still applies */
  }
  dispatchEvent(new HashChangeEvent('hashchange'))
}
