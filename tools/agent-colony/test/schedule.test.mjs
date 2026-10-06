import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSchedule, dueTime, parseEvery, describeSchedule } from '../lib/schedule.mjs'

const day = (h, m = 0) => new Date(2026, 9, 6, h, m) // a Tuesday
const sched = (x) => normalizeSchedule({ id: 's', prompt: '/x', ...x })

test('parses intervals, and refuses silly ones', () => {
  assert.equal(parseEvery('2h'), 2 * 3600000)
  assert.equal(parseEvery('90m'), 90 * 60000)
  assert.equal(parseEvery('5m'), 0)
  assert.equal(parseEvery('soon'), 0)
  assert.equal(sched({ every: '5m' }), null)
  assert.equal(sched({}), null)
})

test('daily schedules are due from their time on', () => {
  const s = sched({ at: '09:00' })
  assert.equal(dueTime(s, day(8, 59)), 0)
  assert.equal(dueTime(s, day(9, 0)), day(9).getTime())
  assert.equal(dueTime(s, day(17)), day(9).getTime())
  assert.equal(dueTime(sched({ at: '09:00', days: 'mon' }), day(10)), 0)
})

test('interval schedules fall on their slots inside the window', () => {
  const s = sched({ every: '2h', from: '07:00', to: '23:00' })
  assert.equal(dueTime(s, day(6, 59)), 0)
  assert.equal(dueTime(s, day(7, 0)), day(7).getTime())
  assert.equal(dueTime(s, day(8, 59)), day(7).getTime())
  assert.equal(dueTime(s, day(9, 1)), day(9).getTime())
  // After the window closes, the last slot stays the latest one.
  assert.equal(dueTime(s, day(23, 30)), day(21).getTime())
})

test('all-day intervals start at midnight', () => {
  const s = sched({ every: '1h' })
  assert.equal(dueTime(s, day(0, 10)), day(0).getTime())
  assert.equal(dueTime(s, day(13, 59)), day(13).getTime())
  assert.equal(dueTime(s, day(23, 59)), day(23).getTime())
})

test('describes schedules for the panel', () => {
  assert.equal(describeSchedule(sched({ at: '09:00' })), 'Daily 09:00')
  assert.equal(describeSchedule(sched({ at: '08:30', days: 'mon' })), 'Mon 08:30')
  assert.equal(describeSchedule(sched({ every: '2h', from: '07:00', to: '23:00' })), 'Every 2h, 07:00–23:00')
  assert.equal(describeSchedule(sched({ every: '1h' })), 'Every 1h')
  assert.equal(sched({ every: '1h', onlyIf: 'attention' }).onlyIf, 'attention')
})
