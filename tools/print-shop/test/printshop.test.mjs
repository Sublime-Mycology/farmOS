import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.PRINT_SHOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'printshop-'))
const ps = await import('../printshop.mjs')
const quiet = async (argv) => {
  const log = console.log
  console.log = () => {}
  try { await ps.main(argv) } finally { console.log = log }
}

test('parses flags and positionals', () => {
  assert.deepEqual(ps.parseArgs(['render', 'x', '--colors', 'Black,White', '--live', '--price=9.5']),
    { _: ['render', 'x'], colors: 'Black,White', live: true, price: '9.5' })
})

test('flags famous names but not ordinary words', () => {
  assert.deepEqual(ps.riskyWords('Fun Guy mushroom tee for foragers'), [])
  assert.deepEqual(ps.riskyWords('May the spores be with you, Star Wars style'), ['star wars'])
  assert.deepEqual(ps.riskyWords('cokeberry'), []) // whole words only
})

test('picks the variants matching colours and sizes', () => {
  const vs = [
    { id: 1, options: { color: 'Black', size: 'M' } }, { id: 2, options: { color: 'Black', size: '5XL' } },
    { id: 3, options: { color: 'Pink', size: 'M' } }, { id: 4, options: { size: '11oz' } },
  ]
  const p = { colors: ['black'], sizes: ['M', 'L'] }
  assert.deepEqual(ps.pickVariants(vs, p).map((v) => v.id), [1])
  assert.deepEqual(ps.pickVariants([vs[3]], { colors: ['White'], sizes: [] }).map((v) => v.id), [4])
})

test('builds the Printify product body with prices in cents', () => {
  const body = ps.productBody({ title: 'T', tags: ['a'], price: 24.99 }, { blueprint: 12, provider: 29 }, [{ id: 1 }, { id: 2 }], 'img')
  assert.equal(body.variants[0].price, 2499)
  assert.deepEqual(body.print_areas[0].variant_ids, [1, 2])
  assert.equal(body.print_areas[0].placeholders[0].position, 'front')
  assert.equal(body.print_areas[0].placeholders[0].images[0].id, 'img')
})

test('pixel checks catch filled backgrounds, edges and empty files', () => {
  const W = 100, H = 120
  const px = (fill) => { const a = new Uint8Array(W * H * 4); fill(a); return a }
  const full = px((a) => { for (let i = 3; i < a.length; i += 4) a[i] = 255 })
  assert.match(ps.checkPixels(full, W, H, { transparent: true }).warnings.join(), /background is filled/)
  assert.equal(ps.checkPixels(full, W, H, { transparent: false }).warnings.length, 0)
  const empty = px(() => {})
  assert.match(ps.checkPixels(empty, W, H, { transparent: true }).warnings.join(), /empty/)
  const centred = px((a) => { for (let y = 20; y < 100; y++) for (let x = 15; x < 85; x++) a[(y * W + x) * 4 + 3] = 255 })
  assert.deepEqual(ps.checkPixels(centred, W, H, { transparent: true }).warnings, [])
})

test('a design goes from draft to review, and only the right people approve it', async () => {
  await quiet(['new-brand', '--name', 'Test Shop', '--niche', 'mushrooms', '--products', 'tee'])
  await quiet(['idea', 'add', '--brand', 'test-shop', '--text', 'Fun Guy', '--why', 'pun'])
  const [idea] = JSON.parse(fs.readFileSync(path.join(ps.HOME, 'brands', 'test-shop.ideas.json'), 'utf8'))
  await quiet(['design', 'new', '--brand', 'test-shop', '--idea', idea.id])
  const [d] = ps.allDesigns('test-shop')
  assert.equal(d.status, 'draft')
  assert.throws(() => ps.setStatus(d.id, 'approved'), /only designs waiting/)
  await quiet(['render', d.id])
  const r = ps.allDesigns('test-shop')[0]
  assert.equal(r.status, 'pending')
  assert.equal(r.width, 4500)
  assert.equal(r.height, 5400)
  assert.equal(r.mockups.length, 4)
  assert.ok(fs.existsSync(path.join(ps.HOME, 'designs', 'test-shop', d.id, 'print.png')))
  assert.ok(fs.readFileSync(path.join(ps.HOME, 'designs', 'test-shop', 'index.html'), 'utf8').includes(d.id))
  assert.throws(() => ps.setStatus(d.id, 'approved', { by: 'manager' }), /autopilot.approve is off/)
  ps.setStatus(d.id, 'rejected', { reason: 'too small' })
  await quiet(['render', d.id, '--reason', 'bigger'])
  assert.equal(ps.allDesigns('test-shop')[0].status, 'pending')
  const log = console.log
  console.log = () => {}
  try { ps.setStatus(d.id, 'approved', { note: 'nice' }) } finally { console.log = log }
  assert.equal(ps.allDesigns('test-shop')[0].approvedBy, 'user')
  const ideas = JSON.parse(fs.readFileSync(path.join(ps.HOME, 'brands', 'test-shop.ideas.json'), 'utf8'))
  assert.equal(ideas[0].status, 'designed')
})

test('talks to Printify with the token and explains failures', async () => {
  const calls = []
  const ok = async (url, init) => { calls.push([url, init]); return new Response('[{"id":7}]', { status: 200 }) }
  const data = await ps.printify('GET', '/shops.json', null, { tok: 't0k', fetchImpl: ok })
  assert.deepEqual(data, [{ id: 7 }])
  assert.match(calls[0][0], /\/v1\/shops\.json$/)
  assert.equal(calls[0][1].headers.Authorization, 'Bearer t0k')
  const denied = async () => new Response('{"message":"nope"}', { status: 401 })
  await assert.rejects(ps.printify('GET', '/shops.json', null, { tok: 'x', fetchImpl: denied }), /refused the token/)
})

test('counts only working design agents', () => {
  const state = { repos: [{ path: '/r', threads: [
    { status: 'running', title: '/design i-1 b' }, { status: 'waiting', title: '/design i-2 b' }, { status: 'running', title: '/manage' },
  ] }] }
  assert.equal(ps.designAgents(state, '/r').length, 1)
  assert.equal(ps.MAX_AGENTS, 4)
})

test('retargets a design into another print area: fitted for apparel, filled for decor', () => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000" viewBox="0 0 4000 4000"><circle cx="2000" cy="2000" r="900"/></svg>'
  const hat = ps.retargetSvg(src, ps.PRODUCT_PRESETS.hat)
  assert.match(hat, /viewBox="0 0 1200 525"/)
  assert.match(hat, /<svg x="72" y="32" width="1056" height="462" viewBox="0 0 4000 4000" preserveAspectRatio="xMidYMid meet"><circle/)
  const pillow = ps.retargetSvg(src, ps.PRODUCT_PRESETS.pillow)
  assert.match(pillow, /<svg x="0" y="0" width="4050" height="4050" viewBox="0 0 4000 4000" preserveAspectRatio="xMidYMid slice">/)
  const noViewBox = ps.retargetSvg('<svg width="300" height="200"><rect/></svg>', ps.PRODUCT_PRESETS.tee)
  assert.match(noViewBox, /viewBox="0 0 300 200"/)
})

test('embroidery: warns about too many thread colours, and decor must fill the area', () => {
  const W = 120, H = 60
  const a = new Uint8Array(W * H * 4)
  for (let y = 5; y < 55; y++) for (let x = 5; x < 115; x++) {
    const c = Math.floor((x - 5) / 14) // 8 bands of clearly different colours
    a.set([(c * 37) % 256, (c * 91) % 256, (c * 151) % 256, 255], (y * W + x) * 4)
  }
  assert.match(ps.checkPixels(a, W, H, ps.PRODUCT_PRESETS.hat).warnings.join(), /6 thread colours/)
  assert.match(ps.checkPixels(a, W, H, ps.PRODUCT_PRESETS.pillow).warnings.join(), /prints edge to edge/)
})

test('the sketchbook makes itself, and artwork is never published', async () => {
  await quiet(['design', 'new', '--brand', 'sketchbook', '--product', 'art', '--title', 'Moon'])
  const [d] = ps.allDesigns('sketchbook')
  assert.equal(d.product, 'art')
  await quiet(['render', d.id])
  const log = console.log
  console.log = () => {}
  try { ps.setStatus(d.id, 'approved') } finally { console.log = log }
  await assert.rejects(quiet(['publish', d.id]), /artwork, not a product/)
  // With one real brand and the sketchbook, the real one is still the default.
  assert.equal(ps.loadBrand().name, 'test-shop')
})
