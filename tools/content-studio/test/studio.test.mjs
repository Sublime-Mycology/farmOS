import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.CONTENT_STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'))
const st = await import('../studio.mjs')
const quiet = async (argv) => {
  const log = console.log
  console.log = () => {}
  try { await st.main(argv) } finally { console.log = log }
}

test('copy checks: caption, hashtags, hook and risky claims', () => {
  const ok = { hook: 'You are watering them wrong', caption: 'Mist twice a day.', hashtags: ['mushrooms', 'growyourown'], scenes: [{ text: 'hi' }] }
  assert.deepEqual(st.checkCopy(ok), [])
  const bad = { hook: '', caption: 'x'.repeat(2300), hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`), scenes: [{ text: 'This mushroom cures everything and is safe to eat' }] }
  const w = st.checkCopy(bad).join(' | ')
  assert.match(w, /limit is 2200/)
  assert.match(w, /allows 30/)
  assert.match(w, /No hook/)
  assert.match(w, /safe to eat/)
  assert.match(st.checkCopy({ ...ok, hashtags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }).join(), /3–8 specific/)
})

test('reel checks: length, hook timing, readable scenes', () => {
  assert.deepEqual(st.checkReel([{ seconds: 2 }, { seconds: 8 }, { seconds: 8 }, { seconds: 7 }]).warnings, [])
  assert.match(st.checkReel([{ seconds: 5 }, { seconds: 20 }]).warnings.join(), /first scene is over 3/)
  assert.match(st.checkReel([{ seconds: 2 }, { seconds: 0.5 }, { seconds: 2 }]).warnings.join(), /7–90s/)
  assert.match(st.checkReel([{ seconds: 2 }, { seconds: 0.5 }, { seconds: 12 }]).warnings.join(), /too fast/)
  assert.equal(st.checkReel([{ seconds: 2 }, { seconds: 3 }]).total, 5)
})

test('flags overlay text where Instagram covers the screen', () => {
  const W = 1080, H = 1920
  const px = new Uint8Array(W * H * 4)
  const ink = (x, y) => { px[(y * W + x) * 4 + 3] = 255 }
  ink(500, 900)
  assert.deepEqual(st.uiOverlap(px, W, H), [])
  ink(500, 1800)
  ink(1000, 900)
  assert.deepEqual(st.uiOverlap(px, W, H).sort(), ['bottom', 'right'])
})

test('plans approved posts into the next slots, oldest first, keeping assigned ones', () => {
  const acc = { postsPerDay: 2, times: ['11:30', '19:00'] }
  const from = new Date(2026, 9, 8, 12, 0)
  const posts = [
    { id: 'b', status: 'approved', reviewed: '2026-10-08T09:00:00' },
    { id: 'a', status: 'approved', reviewed: '2026-10-07T09:00:00' },
    { id: 'c', status: 'pending' },
    { id: 'd', status: 'approved', reviewed: '2026-10-06T09:00:00', slot: '2026-10-09 19:00' },
  ]
  const plan = st.planSlots(acc, posts, { days: 2, from })
  assert.deepEqual(plan.map((x) => x.slot), ['2026-10-08 19:00', '2026-10-09 11:30', '2026-10-09 19:00'])
  assert.deepEqual(plan.map((x) => x.post?.id ?? null), ['a', 'b', 'd'])
})

test('builds ffmpeg args for drawn scenes and your own clips', () => {
  const drawn = st.segmentArgs({ seconds: 2, motion: 'zoom' }, { png: 's.png', out: 'o.mp4' })
  assert.ok(drawn.includes('anullsrc=r=44100:cl=stereo'))
  assert.match(drawn[drawn.indexOf('-vf') + 1], /zoompan/)
  assert.equal(drawn[drawn.indexOf('-frames:v') + 1], '60')
  const clip = st.segmentArgs({ seconds: 3, start: 4, audio: true }, { media: 'farm.mp4', overlay: 'ov.png', out: 'o.mp4' })
  assert.deepEqual(clip.slice(0, 6), ['-ss', '4', '-t', '3', '-i', 'farm.mp4'])
  assert.match(clip[clip.indexOf('-filter_complex') + 1], /overlay=0:0/)
  assert.equal(clip[clip.indexOf('-map', clip.indexOf('-map') + 1) + 1], '0:a')
  const quietClip = st.segmentArgs({ seconds: 3 }, { media: 'farm.mp4', overlay: 'ov.png', out: 'o.mp4' })
  assert.equal(quietClip[quietClip.indexOf('-map', quietClip.indexOf('-map') + 1) + 1], '2:a')
})

let haveFfmpeg = true
try { st.ffmpeg() } catch { haveFfmpeg = false }

test('makes a real Reel and a carousel end to end', { skip: !haveFfmpeg && 'no ffmpeg here' }, async () => {
  await quiet(['new-account', '--name', 'Spore Talk', '--niche', 'mushroom growing at home'])
  await quiet(['post', 'new', '--topic', 'Why your mushrooms stall', '--scenes', '3'])
  const [reel] = st.allPosts('spore-talk')
  const { postPath } = st.findPost(reel.id)
  const p = JSON.parse(fs.readFileSync(postPath, 'utf8'))
  Object.assign(p, { hook: 'Your mushrooms stalled?', caption: 'Fresh air fixes most stalls.', hashtags: ['mushrooms'] })
  p.scenes = p.scenes.map((s, i) => ({ ...s, seconds: i === 0 ? 2 : 1.5, text: `line ${i}` }))
  fs.writeFileSync(postPath, JSON.stringify(p))
  await quiet(['render', reel.id])
  const done = st.allPosts('spore-talk').find((x) => x.id === reel.id)
  assert.equal(done.status, 'pending')
  assert.equal(done.seconds, 5)
  const dir = path.dirname(postPath)
  for (const f of ['video.mp4', 'cover.png', 'check.png']) assert.ok(fs.existsSync(path.join(dir, f)), f)
  const probe = (await import('node:child_process')).spawnSync(st.ffmpeg(), ['-hide_banner', '-i', path.join(dir, 'video.mp4')], { encoding: 'utf8' }).stderr
  assert.match(probe, /1080x1920/)
  assert.match(probe, /Duration: 00:00:0(4\.9|5\.0)/)
  assert.match(probe, /Audio: aac/)

  await quiet(['post', 'new', '--topic', '5 mistakes', '--type', 'carousel', '--scenes', '3'])
  const car = st.allPosts('spore-talk').find((x) => x.type === 'carousel')
  await quiet(['render', car.id])
  assert.ok(fs.existsSync(path.join(st.HOME, 'posts', 'spore-talk', car.id, 'slide-3.png')))
  assert.throws(() => st.setStatus(car.id, 'approved', { by: 'manager' }), /autopilot.approve is off/)
  const log = console.log
  console.log = () => {}
  try { st.setStatus(reel.id, 'approved'); st.setStatus(reel.id, 'posted', { url: 'https://instagram.com/p/x' }) } finally { console.log = log }
  assert.equal(st.allPosts('spore-talk').find((x) => x.id === reel.id).status, 'posted')
  const page = fs.readFileSync(path.join(st.HOME, 'posts', 'spore-talk', 'index.html'), 'utf8')
  assert.match(page, /Posting plan/)
  assert.match(page, /Copy caption/)
})
