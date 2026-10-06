// When a repo's scheduled runs are due. A schedule runs either once a day at a time
// ({ at: "09:00" }) or on an interval within a daily window ({ every: "2h", from: "07:00", to: "23:00" }),
// on the given days ("daily", "weekdays" or "mon,thu").

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const TIME = /^\d{1,2}:\d{2}$/
const EVERY = /^(\d{1,3})\s*(m|min|h)$/i

/** "90m" / "2h" → milliseconds, at least 15 minutes, or 0 if it isn't one. */
export function parseEvery(s) {
  const m = EVERY.exec(String(s || '').trim())
  if (!m) return 0
  const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3600000 : 60000)
  return ms >= 15 * 60000 && ms <= 24 * 3600000 ? ms : 0
}

/** A schedule from .colony/schedule.json, cleaned up, or null if it can't run. */
export function normalizeSchedule(x) {
  if (!x || !/^[\w-]{1,40}$/.test(x.id || '') || typeof x.prompt !== 'string') return null
  const out = {
    id: x.id, label: String(x.label || x.id).slice(0, 60), prompt: x.prompt.slice(0, 2000),
    days: String(x.days || 'daily').toLowerCase(),
    // "attention": only start a run when some agent needs looking at (see needsAttention).
    onlyIf: x.onlyIf === 'attention' ? 'attention' : '',
    // On the first time the colony sees it; after that, your tick in the panel decides.
    defaultOn: x.defaultOn === true,
  }
  if (x.every !== undefined) {
    if (!parseEvery(x.every)) return null
    out.every = String(x.every).trim()
    out.from = TIME.test(x.from || '') ? x.from : '00:00'
    out.to = TIME.test(x.to || '') ? x.to : '24:00'
    return out
  }
  if (!TIME.test(x.at || '')) return null
  out.at = x.at
  return out
}

export function runsOn(days, date) {
  const d = DAY_NAMES[date.getDay()]
  if (days === 'daily') return true
  if (days === 'weekdays') return d !== 'sat' && d !== 'sun'
  return days.split(/[\s,]+/).includes(d)
}

function at(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const t = new Date(date)
  t.setHours(h, m, 0, 0) // 24:00 rolls over to midnight, the end of the day
  return t.getTime()
}

/** The most recent time this schedule should have run, or 0 if none yet today. */
export function dueTime(entry, now = new Date()) {
  if (!runsOn(entry.days, now)) return 0
  if (!entry.every) {
    const t = at(now, entry.at)
    return t <= now.getTime() ? t : 0
  }
  const step = parseEvery(entry.every)
  const start = at(now, entry.from)
  const end = at(now, entry.to)
  const t = Math.min(now.getTime(), end - 1)
  if (t < start) return 0
  return start + Math.floor((t - start) / step) * step
}

/** How a schedule reads in the panel: "Daily 09:00" or "Every 2h, 07:00–23:00". */
export function describeSchedule(x) {
  const days = x.days === 'daily' ? 'Daily' : x.days === 'weekdays' ? 'Weekdays'
    : x.days.split(/[\s,]+/).map((d) => d[0].toUpperCase() + d.slice(1)).join(', ')
  if (!x.every) return `${days} ${x.at}`
  const window = x.from === '00:00' && x.to === '24:00' ? '' : `, ${x.from}–${x.to}`
  return `${x.days === 'daily' ? '' : `${days}, `}Every ${x.every}${window}`
}
