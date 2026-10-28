// Checks src/lib/timeinput.ts (the dialog's datetime-local value in the profile time zone).
// Usage: node scripts/time-check.ts
import { fromInputTime, toInputTime } from '../src/lib/timeinput.ts'

let bad = 0
const eq = (what: string, got: unknown, want: unknown) => {
  if (got !== want && bad++ < 20) console.error(`${what}: got ${got}, want ${want}`)
}

for (const tz of ['UTC', 'Europe/Moscow', 'Asia/Kolkata', 'America/New_York', 'Europe/Berlin']) {
  for (let ts = Date.UTC(2026, 0, 1) / 1000 + 7; ts < Date.UTC(2027, 0, 1) / 1000; ts += 1800) {
    const v = toInputTime(ts, tz)
    eq(`${tz} ${v}`, toInputTime(fromInputTime(v, tz), tz), v)
  }
}
eq('Moscow 03:12', fromInputTime('2026-10-27T03:12', 'Europe/Moscow'), Date.UTC(2026, 9, 27, 0, 12) / 1000)
eq('New York fold 01:30', fromInputTime('2026-11-01T01:30', 'America/New_York'), Date.UTC(2026, 10, 1, 5, 30) / 1000)
eq('invalid', Number.isNaN(fromInputTime('', 'UTC')), true)

if (bad) process.exitCode = 1
else console.log('ok')
