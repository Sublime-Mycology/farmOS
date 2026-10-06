// The foreman: keeps the colony's agents working.
//
// Two layers:
//   - The watchdog (no AI, runs every minute): a run that hangs with no output for HUNG_AFTER_MS is
//     stopped, and an agent that stops on an error is resumed once with a "carry on" message.
//   - Foreman rounds (an AI agent in its own plot, see foreman/CLAUDE.md): look at every agent
//     that finished or failed and decide: tell it to carry on, call it done, or flag it for you.
// Only agents launched from the colony are touched. Your own terminal sessions never are, and
// neither are scheduled runs (like a manager shift), which end with a report on purpose.

export const HUNG_AFTER_MS = 30 * 60 * 1000          // no output at all for this long = hung
// A finished agent waits this long for you before the foreman steps in (COLONY_SETTLE_MINUTES).
export const SETTLE_MS = Number(process.env.COLONY_SETTLE_MINUTES ?? 10) * 60 * 1000
export const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000
export const RETRY_WINDOW_MS = 12 * 60 * 60 * 1000
export const MAX_RETRIES = 1                          // watchdog restarts per thread per window
export const MAX_FOREMAN_REPLIES = 2                  // foreman follow-ups per thread per day

/** Is this a thread the foreman may manage? */
export function managed(thread, { launched, foremanDir, samePath }) {
  const info = launched[thread.id]
  if (!info || info.origin === 'schedule') return false
  return !(foremanDir && samePath(thread.repo, foremanDir))
}

/**
 * Does this thread need the foreman? It stopped (finished its turn or failed), you haven't
 * looked at it in SETTLE_MS, and the foreman hasn't already dealt with this state of it.
 */
export function needsAttention(thread, ctx, now = Date.now()) {
  if (!managed(thread, ctx)) return false
  if (thread.status !== 'waiting' && thread.status !== 'error') return false
  const age = now - thread.updatedAt
  if (age > ATTENTION_WINDOW_MS) return false
  if (thread.status === 'waiting' && age < SETTLE_MS) return false
  const flag = ctx.flags[thread.id]
  return !(flag && flag.at >= thread.updatedAt)
}

/** How many of `stamps` (times) fall within `windowMs` of now. */
export function recent(stamps = [], windowMs, now = Date.now()) {
  return stamps.filter((t) => now - t < windowMs).length
}

/**
 * Runs that have been silent too long and should be stopped. Scheduled runs too: a hung manager
 * shift would otherwise block every later one. (Only managed threads are resumed afterwards.)
 */
export function hungTasks(tasks, now = Date.now()) {
  return tasks.filter((t) => t.alive && now - t.updatedAt > HUNG_AFTER_MS)
}

/** Should the watchdog resume this failed thread? Once per RETRY_WINDOW_MS. */
export function shouldRetry(thread, ctx, now = Date.now()) {
  if (thread.status !== 'error' || !managed(thread, ctx)) return false
  if (now - thread.updatedAt > ATTENTION_WINDOW_MS) return false
  const tries = ctx.retries[thread.id] || []
  if (tries.some((t) => t >= thread.updatedAt)) return false // already retried this failure
  return recent(tries, RETRY_WINDOW_MS, now) < MAX_RETRIES
}

export function retryPrompt(reason) {
  return `Your last run stopped before it finished (${reason}). Check where you got to, then carry on with ` +
    'your task. If you are blocked on something only the user can do, say exactly what it is and stop.'
}
