// wall-clock time of ts in time zone tz, 'YYYY-MM-DDTHH:mm:ss'
const wall = (ts: number, tz: string) => {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ts * 1000)) p[x.type] = x.value
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

// value of <input type="datetime-local"> showing ts in tz (minute precision)
export const toInputTime = (ts: number, tz: string) => wall(ts, tz).slice(0, 16)

// the reverse: unix seconds of a datetime-local value read in tz; NaN if invalid. A repeated autumn
// hour gives its first occurrence, a skipped spring hour an hour earlier (two-pass offset)
export function fromInputTime(v: string, tz: string): number {
  const asUTC = Date.parse(v.slice(0, 16) + 'Z') / 1000
  if (isNaN(asUTC)) return NaN
  const off = (ts: number) => Date.parse(wall(ts, tz) + 'Z') / 1000 - ts
  return asUTC - off(asUTC - off(asUTC))
}
