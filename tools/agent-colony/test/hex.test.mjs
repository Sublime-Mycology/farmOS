import test from 'node:test'
import assert from 'node:assert/strict'
import { layout, tilesNeeded, distance } from '../lib/hex.mjs'

const tiles = (z) => Object.values(z).flat().map((t) => t.join(','))

test('one tile per seven threads', () => {
  assert.equal(tilesNeeded(1), 1)
  assert.equal(tilesNeeded(7), 1)
  assert.equal(tilesNeeded(8), 2)
})

test('never hands out the landing tile, never overlaps', () => {
  const z = layout({}, { a: 3, b: 1, c: 2 })
  const all = tiles(z)
  assert.ok(!all.includes('0,0'))
  assert.equal(new Set(all).size, all.length)
  assert.equal(z.a.length, 3)
})

test('zones are contiguous', () => {
  const z = layout({}, { a: 4 })
  for (const t of z.a.slice(1)) assert.ok(z.a.some((o) => distance(...t, ...o) === 1))
})

test('layout is sticky: existing zones keep their ground when others appear', () => {
  const first = layout({}, { a: 2, b: 1 })
  const second = layout(first, { a: 2, b: 1, c: 3 })
  assert.deepEqual(second.a, first.a)
  assert.deepEqual(second.b, first.b)
})

test('shrinking gives back the most recent tiles, regrowing returns the same shape', () => {
  const big = layout({}, { a: 3 })
  const small = layout(big, { a: 1 })
  assert.deepEqual(small.a, big.a.slice(0, 1))
  assert.deepEqual(layout(small, { a: 3 }).a, big.a)
})
