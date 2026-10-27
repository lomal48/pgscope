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
