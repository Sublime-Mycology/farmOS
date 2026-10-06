import test from 'node:test'
import assert from 'node:assert/strict'
import { managed, needsAttention, hungTasks, shouldRetry, recent, SETTLE_MS, HUNG_AFTER_MS } from '../lib/foreman.mjs'

const NOW = Date.UTC(2026, 9, 6, 12)
const MIN = 60000
const samePath = (a, b) => a === b
const ctx = (over = {}) => ({
  launched: { a: { at: NOW - 60 * MIN, origin: 'colony' }, s: { at: NOW - 60 * MIN, origin: 'schedule' }, f: { at: NOW, origin: 'colony' } },
  flags: {}, retries: {}, foremanDir: '/home/me/AgentColony/foreman', samePath, ...over,
})
const thread = (over = {}) => ({ id: 'a', repo: '/code/x', status: 'waiting', updatedAt: NOW - 20 * MIN, ...over })

test('only manages agents launched from the colony, not scheduled runs or the foreman', () => {
  assert.equal(managed(thread(), ctx()), true)
  assert.equal(managed(thread({ id: 'mine' }), ctx()), false)
  assert.equal(managed(thread({ id: 's' }), ctx()), false)
  assert.equal(managed(thread({ id: 'f', repo: '/home/me/AgentColony/foreman' }), ctx()), false)
})

test('a finished agent needs attention once it has settled', () => {
  assert.equal(needsAttention(thread(), ctx(), NOW), true)
  assert.equal(needsAttention(thread({ updatedAt: NOW - SETTLE_MS + MIN }), ctx(), NOW), false)
  assert.equal(needsAttention(thread({ status: 'error', updatedAt: NOW - MIN }), ctx(), NOW), true)
  assert.equal(needsAttention(thread({ status: 'running' }), ctx(), NOW), false)
  assert.equal(needsAttention(thread({ status: 'idle' }), ctx(), NOW), false)
  assert.equal(needsAttention(thread({ updatedAt: NOW - 25 * 60 * MIN }), ctx(), NOW), false)
})

test('a decision covers the thread until it does something new', () => {
  const t = thread()
  assert.equal(needsAttention(t, ctx({ flags: { a: { at: NOW - MIN } } }), NOW), false)
  assert.equal(needsAttention(t, ctx({ flags: { a: { at: t.updatedAt - MIN } } }), NOW), true)
})

test('hung runs are the silent ones', () => {
  const tasks = [
    { id: 1, alive: true, updatedAt: NOW - HUNG_AFTER_MS - MIN },
    { id: 2, alive: true, updatedAt: NOW - MIN },
    { id: 3, alive: false, updatedAt: NOW - 2 * HUNG_AFTER_MS },
    { id: 4, alive: true, origin: 'schedule', updatedAt: NOW - HUNG_AFTER_MS - MIN },
  ]
  assert.deepEqual(hungTasks(tasks, NOW).map((t) => t.id), [1, 4])
})

test('the watchdog retries a failure once', () => {
  const t = thread({ status: 'error', updatedAt: NOW - MIN })
  assert.equal(shouldRetry(t, ctx(), NOW), true)
  assert.equal(shouldRetry(t, ctx({ retries: { a: [NOW - 30 * 1000] } }), NOW), false)
  // A new failure after a retry earlier today goes to the foreman instead.
  assert.equal(shouldRetry(t, ctx({ retries: { a: [NOW - 60 * MIN] } }), NOW), false)
  assert.equal(shouldRetry(t, ctx({ retries: { a: [NOW - 13 * 60 * MIN] } }), NOW), true)
  assert.equal(shouldRetry(thread({ status: 'waiting' }), ctx(), NOW), false)
  assert.equal(shouldRetry(thread({ id: 'mine', status: 'error' }), ctx(), NOW), false)
})

test('counts recent stamps', () => {
  assert.equal(recent([NOW - MIN, NOW - 25 * 60 * MIN], 24 * 60 * MIN, NOW), 1)
  assert.equal(recent(undefined, MIN, NOW), 0)
})
