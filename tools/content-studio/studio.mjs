#!/usr/bin/env node
// Content Studio: an Instagram content system run by agents. Research finds what's working in a
// niche, agents write hooks and scripts and draw the visuals (SVG, in each account's consistent
// look, or your own photos and clips), and this tool renders Reels and carousels, writes the review
// page, and plans posts into each day's slots. Nothing is posted until it's approved.
//
//   node studio.mjs <command> [args]       (node studio.mjs help for the list)
//
// Everything you make lives in ~/ContentStudio (CONTENT_STUDIO_HOME), never in git.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tilde = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir())
export const HOME = path.resolve(tilde(process.env.CONTENT_STUDIO_HOME || path.join(os.homedir(), 'ContentStudio')))
const ACCOUNTS = path.join(HOME, 'accounts')
const POSTS = path.join(HOME, 'posts')
const MEDIA = path.join(HOME, 'media')
const MUSIC = path.join(HOME, 'music')
const FONTS = path.join(HOME, 'fonts')
const REPORTS = path.join(HOME, 'reports')
const COLONY = (process.env.CONTENT_STUDIO_COLONY_URL || 'http://127.0.0.1:5274').replace(/\/$/, '')
export const MAX_AGENTS = Number(process.env.CONTENT_STUDIO_MAX_AGENTS || 4)

export const FORMATS = {
  reel: { label: 'Reel', width: 1080, height: 1920 },
  carousel: { label: 'Carousel', width: 1080, height: 1350 },
  image: { label: 'Image post', width: 1080, height: 1350 },
}
// Parts of a Reel that Instagram's buttons and caption cover (on 1080×1920).
export const REEL_UI = { top: 220, bottom: 440, right: 150 }
export const LIMITS = { captionChars: 2200, hashtagsMax: 30, hashtagsAdvised: 8, carouselMax: 20 }

export const DEFAULT_AUTOPILOT = {
  approve: false,     // may the manager approve posts that pass its checklist?
  makePerDay: 3,      // new posts the manager may start per day
}
const DEFAULT_TIMES = { 1: ['12:00'], 2: ['11:30', '19:00'], 3: ['08:00', '12:30', '19:00'], 4: ['08:00', '12:00', '17:00', '20:30'] }

// Claims that get people hurt or accounts restricted. A safety net; the manager reads every post.
const RISKY_CLAIMS = [
  'safe to eat', 'edible if', 'you can eat any', 'cures', 'cure for', 'treats cancer', 'heals', 'detox', 'miracle',
  'doctors hate', 'guaranteed', 'get rich', 'no risk', 'lose weight fast', 'boosts immunity', 'proven to',
]

// ---------------------------------------------------------------------------------------------
// Helpers

class Stop extends Error {}
export function die(msg) { throw new Stop(msg) }
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback } }
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(`${p}.tmp`, p)
}
const now = () => new Date().toISOString().slice(0, 19)
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const slug = (s, n = 40) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, n).replace(/-$/, '') || 'post'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
const rid = () => crypto.randomBytes(2).toString('hex')

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s)
      if (v !== undefined) out[k] = v
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
      else out[k] = true
    } else out._.push(a)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Accounts, and their research (angles) and hook bank

const accountFile = (n) => path.join(ACCOUNTS, `${n}.json`)
const anglesFile = (n) => path.join(ACCOUNTS, `${n}.angles.json`)
const hooksFile = (n) => path.join(ACCOUNTS, `${n}.hooks.json`)
const lookSvg = (n) => path.join(ACCOUNTS, `${n}.look.svg`)
export function myAccounts() {
  try { return fs.readdirSync(ACCOUNTS).filter((f) => /^[\w-]+\.json$/.test(f) && f.split('.').length === 2).map((f) => f.slice(0, -5)).sort() } catch { return [] }
}
export function loadAccount(name) {
  if (!name) {
    const all = myAccounts()
    if (all.length === 1) name = all[0]
    else die(all.length ? `Which account? --account ${all.join(' | ')}` : 'No accounts yet: node studio.mjs new-account … (or ask an agent: /account)')
  }
  const acc = readJson(accountFile(name), null)
  if (!acc) die(`No account '${name}'. Accounts: ${myAccounts().join(', ') || 'none'}`)
  return { ...acc, name }
}
const saveAccount = (a) => { const { name, ...rest } = a; writeJson(accountFile(name), rest) }
export const autopilot = (acc) => ({ ...DEFAULT_AUTOPILOT, ...(acc.autopilot || {}) })
export const postTimes = (acc) => (acc.times?.length ? acc.times : DEFAULT_TIMES[Math.min(4, Math.max(1, acc.postsPerDay || 2))])

function cmdNewAccount(a) {
  if (!a.name || !a.niche) die('usage: new-account --name spore-talk --niche "…" [--handle @…] [--audience "…"] [--voice "…"] [--palette "#hex,#hex,#hex"] [--fonts "Arial Black,Georgia"] [--posts-per-day 2]')
  const name = slug(a.name, 30)
  if (fs.existsSync(accountFile(name))) die(`Account '${name}' already exists.`)
  const perDay = Math.min(4, Math.max(1, Number(a['posts-per-day']) || 2))
  saveAccount({
    name, title: a.title || a.name, handle: a.handle || '', niche: a.niche, audience: a.audience || '',
    voice: a.voice || 'Friendly, curious and plain-spoken. Short sentences. No hype words.',
    look: {
      palette: list(a.palette || '#1f2b22,#f3ecd8,#e8b04a,#c4532f'),
      fonts: list(a.fonts || 'Arial Black,Georgia'),
      notes: a.look || 'Flat illustration, bold shapes, big readable text. Same colours and character every post.',
    },
    postsPerDay: perDay, times: DEFAULT_TIMES[perDay], autopilot: { ...DEFAULT_AUTOPILOT, makePerDay: perDay }, created: now(),
  })
  writeJson(anglesFile(name), [])
  writeJson(hooksFile(name), [])
  for (const d of [path.join(MEDIA, name), MUSIC, FONTS]) fs.mkdirSync(d, { recursive: true })
  console.log(`Made account '${name}' (${perDay} posts a day at ${DEFAULT_TIMES[perDay].join(', ')}).\n` +
    `Next: /look to draw its style sheet, then /research. Put your own photos and clips in ${path.join(MEDIA, name)}.`)
}

function cmdAccounts() {
  const all = myAccounts()
  if (!all.length) return console.log('No accounts yet: node studio.mjs new-account … (or /account)')
  for (const n of all) {
    const acc = loadAccount(n)
    const ap = autopilot(acc)
    const media = mediaFiles(n)
    console.log(`${n}: ${acc.title}${acc.handle ? ` (${acc.handle})` : ''}\n  niche: ${acc.niche}\n  audience: ${acc.audience || '-'}\n  voice: ${acc.voice}` +
      `\n  look: palette ${acc.look.palette.join(' ')}, fonts ${acc.look.fonts.join(' / ')}. ${acc.look.notes}` +
      `\n  style sheet: ${fs.existsSync(lookSvg(n)) ? lookSvg(n) : 'none yet (/look makes one)'}` +
      `\n  posting: ${acc.postsPerDay} a day at ${postTimes(acc).join(', ')} · autopilot approve=${ap.approve ? 'on' : 'off'}, makes ${ap.makePerDay} a day` +
      `\n  your media: ${media.length ? `${media.length} file(s) in ${path.join(MEDIA, n)}` : `none (add photos/clips to ${path.join(MEDIA, n)})`}`)
  }
}

function cmdAngle(a) {
  const sub = a._[1]
  const acc = loadAccount(a.account)
  const angles = readJson(anglesFile(acc.name), [])
  if (sub === 'add') {
    if (!a.angle || !a.why) die('usage: angle add --angle "…" --why "the evidence it works" [--evidence "url,url"] [--format reel|carousel] [--styles "…"] [--account A]')
    const x = { id: `a-${slug(a.angle, 24)}-${rid()}`, angle: a.angle, why: a.why, evidence: list(a.evidence), format: a.format || 'reel',
      styles: a.styles || '', status: 'new', at: now() }
    angles.push(x)
    writeJson(anglesFile(acc.name), angles)
    return console.log(`added ${x.id}`)
  }
  if (sub === 'skip' || sub === 'done') {
    const x = angles.find((v) => v.id === a._[2]) || die(`No angle '${a._[2]}' in ${acc.name}`)
    Object.assign(x, { status: sub === 'skip' ? 'skipped' : 'used', reason: a.reason || '', at: now() })
    writeJson(anglesFile(acc.name), angles)
    return console.log(`${x.status}: ${x.id}`)
  }
  die('usage: angle add … | angle skip <id> --reason "…" | angle done <id>')
}

function cmdAngles(a) {
  const acc = loadAccount(a.account)
  const want = a.status || 'new'
  const rows = readJson(anglesFile(acc.name), []).filter((x) => want === 'all' || x.status === want)
  if (!rows.length) return console.log(`No ${want === 'all' ? '' : `${want} `}angles for ${acc.name}. Run /research.`)
  for (const x of rows) {
    console.log(`${x.id}  [${x.status}] ${x.format}: ${x.angle}\n    why: ${x.why}${x.styles ? `\n    styles: ${x.styles}` : ''}${x.evidence.length ? `\n    seen: ${x.evidence.join(' ')}` : ''}`)
  }
}

function cmdHook(a) {
  const acc = loadAccount(a.account)
  if (a._[1] !== 'add' || !a.text) die('usage: hook add --text "…" --pattern "question|contrarian|mistake|reveal|…" [--topic "…"] [--account A]')
  const hooks = readJson(hooksFile(acc.name), [])
  const h = { id: `h-${rid()}${rid()}`, text: a.text, pattern: a.pattern || '', topic: a.topic || '', at: now(), used: 0 }
  hooks.push(h)
  writeJson(hooksFile(acc.name), hooks)
  console.log(`added ${h.id}`)
}

function cmdHooks(a) {
  const acc = loadAccount(a.account)
  const rows = readJson(hooksFile(acc.name), []).filter((h) => !a.topic || h.topic.toLowerCase().includes(String(a.topic).toLowerCase()))
  if (!rows.length) return console.log(`No hooks for ${acc.name} yet. Run /hooks.`)
  for (const h of rows.slice(-40)) console.log(`${h.id}  ${h.pattern ? `[${h.pattern}] ` : ''}${h.text}${h.topic ? `  (${h.topic})` : ''}${h.used ? `  used ${h.used}×` : ''}`)
}

// ---------------------------------------------------------------------------------------------
// Your own photos, clips and music

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i
const PHOTO = /\.(jpe?g|png|webp)$/i
export function mediaFiles(account) {
  const out = []
  for (const dir of [path.join(MEDIA, account), MEDIA]) {
    try { for (const f of fs.readdirSync(dir)) if (VIDEO.test(f) || PHOTO.test(f)) out.push(path.join(dir, f)) } catch { /* none */ }
  }
  return out
}
function findMedia(account, name) {
  const hit = mediaFiles(account).find((f) => path.basename(f) === name)
  return hit || die(`No media file '${name}'. Put it in ${path.join(MEDIA, account)} (node studio.mjs media lists what's there).`)
}

function mediaDuration(file) {
  const r = spawnSync(ffmpeg(), ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr || '')
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
}

function cmdMedia(a) {
  const acc = loadAccount(a.account)
  const files = mediaFiles(acc.name)
  if (!files.length) return console.log(`No media yet. Put photos and clips in ${path.join(MEDIA, acc.name)} (from the farm, the kitchen, wherever).`)
  for (const f of files) console.log(`${path.basename(f)}${VIDEO.test(f) ? `  video ${mediaDuration(f)?.toFixed(1) ?? '?'}s` : '  photo'}`)
  let music = []
  try { music = fs.readdirSync(MUSIC).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f)) } catch { /* none */ }
  console.log(`\nmusic (${MUSIC}): ${music.join(', ') || 'none. Only add music you have the rights to.'}`)
}

function cmdFrame(a) {
  const acc = loadAccount(a.account)
  const file = findMedia(acc.name, a._[1] || die('usage: frame <media-file> --at 3.5 [--account A]'))
  const out = path.join(POSTS, acc.name, '_frames', `${slug(path.basename(file))}-${String(a.at || 0).replace('.', '_')}.png`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  ff(PHOTO.test(file) ? ['-i', file, '-frames:v', '1', '-vf', 'scale=540:-2', out]
    : ['-ss', String(Number(a.at) || 0), '-i', file, '-frames:v', '1', '-vf', 'scale=540:-2', out])
  console.log(`look at: ${out}`)
}

// ---------------------------------------------------------------------------------------------
// Research helper: Reddit's public top posts (Instagram and TikTok have no open search; use
// WebSearch for those)

async function cmdReddit(a) {
  const sub = (a._[1] || die('usage: reddit <subreddit> [--t week|month|year] [--limit 15]')).replace(/^r\//, '')
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=${a.t || 'month'}&limit=${Math.min(Number(a.limit) || 15, 50)}`
  let res
  try { res = await fetch(url, { headers: { 'User-Agent': 'ContentStudio/1.0 (research)' } }) } catch (err) { die(`Couldn't reach Reddit: ${err.message}. Use WebSearch instead.`) }
  if (!res.ok) die(`Reddit said ${res.status}. Use WebSearch instead (e.g. "site:reddit.com/r/${sub} top").`)
  const data = await res.json()
  for (const c of data?.data?.children || []) {
    const p = c.data
    console.log(`${String(p.score).padStart(6)} ▲ ${String(p.num_comments).padStart(4)} 💬  ${p.title}\n        https://reddit.com${p.permalink}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Posts: ~/ContentStudio/posts/<account>/<id>/post.json, scene/slide SVGs, renders

const postDir = (account, id) => path.join(POSTS, account, id)
export function findPost(id) {
  for (const acc of myAccounts()) {
    const p = path.join(postDir(acc, id), 'post.json')
    const post = readJson(p, null)
    if (post) return { dir: path.dirname(p), post, postPath: p }
  }
  die(`No post '${id}'. See: node studio.mjs queue`)
}
export function allPosts(account) {
  const out = []
  for (const acc of account ? [account] : myAccounts()) {
    let ids = []
    try { ids = fs.readdirSync(path.join(POSTS, acc)) } catch { continue }
    for (const id of ids) {
      const post = readJson(path.join(POSTS, acc, id, 'post.json'), null)
      if (post) out.push(post)
    }
  }
  return out.sort((x, y) => String(y.created).localeCompare(String(x.created)))
}

export function starterSvg(fmt, acc, text, n) {
  const { width: W, height: H } = FORMATS[fmt]
  const [bg = '#1f2b22', ink = '#f3ecd8', accent = '#e8b04a'] = acc.look.palette
  const font = acc.look.fonts[0] || 'Arial Black'
  const safe = fmt === 'reel' ? `Reel: ${W}×${H}. Keep text out of the top ${REEL_UI.top}px, bottom ${REEL_UI.bottom}px and right ${REEL_UI.right}px: Instagram's buttons cover them.`
    : `${FORMATS[fmt].label}: ${W}×${H} (4:5). Keep text 60px in from every edge.`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- ${safe}
       Use the account's look (node studio.mjs accounts, and its style sheet). Replace this starter. -->
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <text x="${(W - (fmt === 'reel' ? REEL_UI.right : 0)) / 2}" y="${H / 2}" text-anchor="middle" font-family="${esc(font)}" font-size="76" fill="${ink}">${esc(text)}</text>
  <rect x="${W / 2 - 120}" y="${H / 2 + 60}" width="240" height="14" rx="7" fill="${accent}"/>
  <!-- ${n} -->
</svg>
`
}

function cmdPost(a) {
  if (a._[1] !== 'new') die('usage: post new --topic "…" [--type reel|carousel|image] [--angle <angle-id>] [--scenes 5] [--account A]')
  const acc = loadAccount(a.account)
  let angle = null
  if (a.angle) {
    const angles = readJson(anglesFile(acc.name), [])
    angle = angles.find((x) => x.id === a.angle) || die(`No angle '${a.angle}' in ${acc.name}`)
    angle.status = 'used'
    angle.at = now()
    writeJson(anglesFile(acc.name), angles)
  }
  const type = a.type || angle?.format || 'reel'
  if (!FORMATS[type]) die(`--type must be ${Object.keys(FORMATS).join(', ')}`)
  const topic = a.topic || angle?.angle || die('Give it a --topic')
  const id = `${slug(topic, 28)}-${type}-${rid()}`
  const dir = postDir(acc.name, id)
  fs.mkdirSync(dir, { recursive: true })
  const n = type === 'image' ? 1 : Math.min(Math.max(Number(a.scenes) || (type === 'reel' ? 5 : 6), 1), type === 'reel' ? 15 : LIMITS.carouselMax)
  const parts = []
  for (let i = 1; i <= n; i++) {
    const file = `${type === 'reel' ? 'scene' : 'slide'}-${i}.svg`
    fs.writeFileSync(path.join(dir, file), starterSvg(type, acc, i === 1 ? 'HOOK GOES HERE' : `Part ${i}`, file))
    parts.push(type === 'reel' ? { text: '', file, seconds: i === 1 ? 2 : 4, motion: 'zoom' } : { text: '', file })
  }
  writeJson(path.join(dir, 'post.json'), {
    id, account: acc.name, type, topic, angle: angle?.id || '', angleText: angle?.angle || '',
    hook: '', [type === 'reel' ? 'scenes' : 'slides']: parts, caption: '', hashtags: [], cta: '', music: '',
    status: 'draft', created: now(), history: [],
  })
  console.log(`made ${id} (${FORMATS[type].label}, ${n} ${type === 'reel' ? 'scenes' : 'slides'})\n  folder: ${dir}\n  edit post.json (script, caption, hashtags) and the SVGs, then: node studio.mjs render ${id}`)
}

// ---------------------------------------------------------------------------------------------
// Rendering: SVG → PNG with resvg, scenes → Reel with ffmpeg

async function resvg() {
  try { return (await import('@resvg/resvg-js')).Resvg } catch { /* agents work in worktrees: try the main checkout */ }
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: HERE, encoding: 'utf8' }).trim()
    return createRequire(path.join(path.dirname(common), 'package.json'))('@resvg/resvg-js').Resvg
  } catch {
    die('The renderer is missing: run npm install in the content-studio folder.')
  }
}
function fontOptions() {
  let files = []
  try { files = fs.readdirSync(FONTS).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => path.join(FONTS, f)) } catch { /* none */ }
  return { loadSystemFonts: true, fontFiles: files, defaultFontFamily: 'Arial' }
}
export async function renderSvg(svg, width, { withPixels = false } = {}) {
  const Resvg = await resvg()
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(width) }, font: fontOptions(), background: 'rgba(0,0,0,0)' }).render()
  return { png: img.asPng(), width: img.width, height: img.height, pixels: withPixels ? img.pixels : null }
}

/** ffmpeg: FFMPEG_PATH, then the one Clip Factory installed, then whatever is on PATH. */
let FF = null
export function ffmpeg() {
  if (FF) return FF
  const tries = [process.env.FFMPEG_PATH]
  const venv = path.join(os.homedir(), 'ClipFactory', '.venv')
  for (const lib of [path.join(venv, 'Lib', 'site-packages'), ...(() => { try { return fs.readdirSync(path.join(venv, 'lib')).map((p) => path.join(venv, 'lib', p, 'site-packages')) } catch { return [] } })()]) {
    const bin = path.join(lib, 'imageio_ffmpeg', 'binaries')
    try { for (const f of fs.readdirSync(bin)) if (/^ffmpeg/.test(f)) tries.push(path.join(bin, f)) } catch { /* none */ }
  }
  tries.push('ffmpeg')
  for (const t of tries.filter(Boolean)) {
    const r = spawnSync(t, ['-hide_banner', '-version'], { encoding: 'utf8' })
    if (r.status === 0) return (FF = t)
  }
  die('ffmpeg not found. It comes with Clip Factory; or install it and set FFMPEG_PATH.')
}
function ff(args) {
  const r = spawnSync(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) die(`ffmpeg failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`)
}

const V_OUT = ['-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
const A_OUT = ['-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2']
const ZOOM = (d) => `zoompan=z='min(1+0.0007*on,1.07)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`

/** ffmpeg arguments for one scene's segment: 1080×1920, 30 fps, with an audio track (silent unless kept). */
export function segmentArgs(scene, { png, media, overlay, out }) {
  const d = Number(scene.seconds)
  const frames = Math.round(d * 30)
  const zoom = scene.motion !== 'none'
  const silent = ['-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=44100:cl=stereo']
  if (png) {
    const vf = zoom ? `scale=2160:3840,${ZOOM(d)},format=yuv420p` : 'scale=1080:1920,format=yuv420p'
    return ['-loop', '1', '-framerate', '30', '-t', String(d), '-i', png, ...silent, '-vf', vf, '-map', '0:v', '-map', '1:a',
      '-frames:v', String(frames), ...V_OUT, ...A_OUT, '-t', String(d), out]
  }
  const isVideo = VIDEO.test(media)
  const input = isVideo ? ['-ss', String(Number(scene.start) || 0), '-t', String(d), '-i', media] : ['-loop', '1', '-framerate', '30', '-t', String(d), '-i', media]
  const cover = isVideo
    ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1'
    : zoom ? `scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,${ZOOM(d)},setsar=1` : 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1'
  const inputs = [...input]
  let graph = `[0:v]${cover}[bg]`
  let v = '[bg]'
  if (overlay) {
    inputs.push('-i', overlay)
    graph += `;[bg][1:v]overlay=0:0[ov]`
    v = '[ov]'
  }
  graph += `;${v}format=yuv420p[v]`
  const keepAudio = isVideo && scene.audio === true
  const audioIndex = overlay ? 2 : 1
  if (!keepAudio) inputs.push(...silent)
  return [...inputs, '-filter_complex', graph, '-map', '[v]', '-map', keepAudio ? '0:a' : `${audioIndex}:a`,
    '-frames:v', String(frames), ...V_OUT, ...A_OUT, '-t', String(d), out]
}

/** Text and copy checks shared by every format. */
export function checkCopy(post) {
  const w = []
  const caption = String(post.caption || '')
  const tags = post.hashtags || []
  if (!caption.trim()) w.push('No caption yet.')
  if (caption.length > LIMITS.captionChars) w.push(`Caption is ${caption.length} characters; Instagram's limit is ${LIMITS.captionChars}.`)
  if (tags.length > LIMITS.hashtagsMax) w.push(`${tags.length} hashtags; Instagram allows ${LIMITS.hashtagsMax}.`)
  else if (tags.length > LIMITS.hashtagsAdvised) w.push(`${tags.length} hashtags. 3–8 specific ones work better than many.`)
  if (tags.some((t) => /\s/.test(t))) w.push('A hashtag has a space in it.')
  if (!post.hook?.trim()) w.push('No hook written (post.json "hook").')
  const text = `${post.hook} ${caption} ${(post.scenes || post.slides || []).map((s) => s.text).join(' ')}`.toLowerCase()
  const claims = RISKY_CLAIMS.filter((c) => text.includes(c))
  if (claims.length) w.push(`Possible health, safety or money claim: "${claims.join('", "')}". Rewrite unless it's clearly true and safe.`)
  return w
}

export function checkReel(scenes) {
  const w = []
  const total = scenes.reduce((s, x) => s + (Number(x.seconds) || 0), 0)
  if (total < 7 || total > 90) w.push(`It's ${total.toFixed(1)}s long. Reels here should be 7–90s.`)
  else if (total < 15 || total > 35) w.push(`It's ${total.toFixed(1)}s. Aim for 20–30s unless the topic needs it.`)
  if (Number(scenes[0]?.seconds) > 3) w.push('The first scene is over 3 seconds: the hook should land in the first 2.')
  if (scenes.some((s) => Number(s.seconds) < 0.8)) w.push('A scene is under 0.8s: too fast to read.')
  return { warnings: w, total }
}

/** Where a transparent overlay puts ink inside the parts Instagram covers. */
export function uiOverlap(pixels, W, H) {
  const hit = { top: false, bottom: false, right: false }
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      if (pixels[(y * W + x) * 4 + 3] < 40) continue
      if (y < REEL_UI.top) hit.top = true
      if (y > H - REEL_UI.bottom) hit.bottom = true
      if (x > W - REEL_UI.right) hit.right = true
    }
  }
  return Object.keys(hit).filter((k) => hit[k])
}

/** One image with a still of every scene, with the parts Instagram covers shaded, to check. */
function contactSheet(stills, fmt) {
  const tw = 270, th = fmt === 'reel' ? 480 : 338, cols = Math.min(stills.length, 4)
  const rows = Math.ceil(stills.length / cols)
  const s = tw / 1080
  const cells = stills.map((png, i) => {
    const x = (i % cols) * (tw + 12) + 12, y = Math.floor(i / cols) * (th + 40) + 12
    const zones = fmt === 'reel' ? `<g fill="#ff3b30" fill-opacity="0.28"><rect x="${x}" y="${y}" width="${tw}" height="${REEL_UI.top * s}"/>` +
      `<rect x="${x}" y="${y + th - REEL_UI.bottom * s}" width="${tw}" height="${REEL_UI.bottom * s}"/>` +
      `<rect x="${x + tw - REEL_UI.right * s}" y="${y + REEL_UI.top * s}" width="${REEL_UI.right * s}" height="${th - (REEL_UI.top + REEL_UI.bottom) * s}"/></g>` : ''
    return `<image x="${x}" y="${y}" width="${tw}" height="${th}" href="data:image/png;base64,${png.toString('base64')}"/>${zones}` +
      `<text x="${x + tw / 2}" y="${y + th + 28}" text-anchor="middle" font-family="Arial" font-size="20" fill="#ddd">${i + 1}</text>`
  })
  const W = cols * (tw + 12) + 12, H = rows * (th + 40) + 12
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#222"/>${cells.join('')}</svg>`
}

async function cmdRender(a) {
  const { dir, post, postPath } = findPost(a._[1] || die('usage: render <post-id> [--reason "what changed"]'))
  const acc = loadAccount(post.account)
  const fmt = FORMATS[post.type]
  const parts = post.type === 'reel' ? post.scenes : post.slides
  if (!parts?.length) die(`post.json has no ${post.type === 'reel' ? 'scenes' : 'slides'}.`)
  if (post.type === 'carousel' && (parts.length < 2 || parts.length > LIMITS.carouselMax)) die(`Carousels need 2–${LIMITS.carouselMax} slides.`)
  const warnings = [...checkCopy(post)]
  const work = path.join(dir, '_work')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  for (const f of fs.readdirSync(dir)) if (/^(scene|slide)-\d+\.png$|^video\.mp4$/.test(f)) fs.rmSync(path.join(dir, f))
  const stills = []
  let i = 0
  for (const part of parts) {
    i++
    if (part.file) {
      const svgPath = path.join(dir, part.file)
      if (!fs.existsSync(svgPath)) die(`${part.file} is missing.`)
      const svg = fs.readFileSync(svgPath, 'utf8')
      if (/(?:xlink:)?href\s*=\s*["']https?:/i.test(svg)) die(`${part.file} links to an image on the web. Draw it, or use your own media.`)
      let r
      try { r = await renderSvg(svg, fmt.width) } catch (err) { die(`${part.file} didn't render: ${err.message}`) }
      if (Math.abs(r.height - fmt.height) > 2) warnings.push(`${part.file} is ${r.width}×${r.height}; it must be ${fmt.width}×${fmt.height}.`)
      const png = path.join(dir, part.file.replace(/\.svg$/, '.png'))
      fs.writeFileSync(png, r.png)
      part._png = png
      stills.push((await renderSvg(svg, 540)).png)
    } else if (part.media) {
      if (post.type !== 'reel') die('Carousel slides are SVGs (draw your photo in with <image href="data:…">, or ask for a Reel).')
      part._media = findMedia(post.account, part.media)
      if (part.overlay) {
        const ovSvg = fs.readFileSync(path.join(dir, part.overlay), 'utf8')
        const ov = await renderSvg(ovSvg, 1080, { withPixels: true })
        part._overlay = path.join(work, `overlay-${i}.png`)
        fs.writeFileSync(part._overlay, ov.png)
        const covered = uiOverlap(ov.pixels, ov.width, ov.height)
        if (covered.length) warnings.push(`Scene ${i}'s text reaches the ${covered.join(', ')} of the screen, where Instagram's buttons and caption cover it.`)
      }
      const still = path.join(work, `still-${i}.png`)
      const vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
      ff([...(VIDEO.test(part._media) ? ['-ss', String(Number(part.start) || 0)] : []), '-i', part._media,
        ...(part._overlay ? ['-i', part._overlay, '-filter_complex', `[0:v]${vf}[b];[b][1:v]overlay=0:0,scale=540:-2`] : ['-vf', `${vf},scale=540:-2`]),
        '-frames:v', '1', still])
      stills.push(fs.readFileSync(still))
    } else die(`Scene ${i} needs "file" (an SVG) or "media" (one of your photos or clips).`)
  }
  let total = 0
  if (post.type === 'reel') {
    const r = checkReel(parts)
    warnings.push(...r.warnings)
    total = r.total
    const segs = []
    parts.forEach((part, k) => {
      const out = path.join(work, `seg-${k + 1}.mp4`)
      ff(segmentArgs(part, { png: part._png, media: part._media, overlay: part._overlay, out }))
      segs.push(out)
    })
    const listFile = path.join(work, 'list.txt')
    fs.writeFileSync(listFile, segs.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'))
    const joined = path.join(work, 'joined.mp4')
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined])
    const video = path.join(dir, 'video.mp4')
    if (post.music) {
      const music = path.join(MUSIC, post.music)
      if (!fs.existsSync(music)) die(`No music file '${post.music}' in ${MUSIC}.`)
      const fadeAt = Math.max(0, total - 1.5).toFixed(2)
      ff(['-i', joined, '-stream_loop', '-1', '-i', music, '-filter_complex',
        `[1:a]volume=0.6,afade=t=in:d=0.3,afade=t=out:st=${fadeAt}:d=1.5[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...A_OUT, '-t', String(total), '-movflags', '+faststart', video])
    } else {
      ff(['-i', joined, '-c', 'copy', '-movflags', '+faststart', video])
    }
  }
  // Cover: cover.svg if the agent drew one, else the first scene or slide.
  const coverSvg = path.join(dir, 'cover.svg')
  fs.writeFileSync(path.join(dir, 'cover.png'), fs.existsSync(coverSvg) ? (await renderSvg(fs.readFileSync(coverSvg, 'utf8'), fmt.width)).png : stills[0])
  const sheet = await renderSvg(contactSheet(stills, post.type), 1200)
  fs.writeFileSync(path.join(dir, 'check.png'), sheet.png)
  fs.rmSync(work, { recursive: true, force: true })
  for (const part of parts) for (const k of Object.keys(part)) if (k.startsWith('_')) delete part[k]
  const was = post.status
  Object.assign(post, { rendered: now(), seconds: total || undefined, warnings, status: ['draft', 'rejected'].includes(was) ? 'pending' : was })
  if (was === 'rejected') post.history.push({ at: now(), event: 'redone', note: a.reason || '' })
  writeJson(postPath, post)
  writePages(post.account)
  console.log(`rendered ${post.id}: ${post.type === 'reel' ? `video.mp4, ${total.toFixed(1)}s` : `${parts.length} slide(s)`}`)
  console.log(`  look at:  ${path.join(dir, 'check.png')}  (every ${post.type === 'reel' ? 'scene; red = covered by Instagram' : 'slide'})`)
  console.log(warnings.length ? `  ⚠ ${warnings.join('\n  ⚠ ')}` : '  checks: OK')
  if (post.status === 'pending') console.log('  status: ready for review')
}

// ---------------------------------------------------------------------------------------------
// Review, plan, posted

function cmdQueue(a) {
  const want = a.status || 'pending'
  const rows = allPosts(a.account).filter((p) => want === 'all' || p.status === want)
  if (!rows.length) return console.log(`No ${want === 'all' ? '' : `${want} `}posts.`)
  for (const p of rows) {
    console.log(`${p.id}  [${p.status}] ${p.account} · ${p.type}${p.seconds ? ` ${p.seconds.toFixed(0)}s` : ''}${p.slot ? ` · slot ${p.slot}` : ''}\n    ${p.hook || p.topic}` +
      `${p.reason ? `\n    rejected: ${p.reason}` : ''}${p.warnings?.length ? `\n    ⚠ ${p.warnings.join(' / ')}` : ''}`)
  }
}

export function setStatus(id, status, { reason = '', note = '', by = '', url = '' } = {}) {
  const { post, postPath } = findPost(id)
  if (by === 'manager' && status === 'approved' && !autopilot(loadAccount(post.account)).approve) {
    die(`autopilot.approve is off for '${post.account}': only the user can approve. List it in your report instead.`)
  }
  if (status === 'approved' && post.status !== 'pending') die(`${id} is ${post.status}; only posts waiting for review can be approved.`)
  if (status === 'posted' && !['approved', 'pending'].includes(post.status)) die(`${id} is ${post.status}.`)
  post.status = status
  if (reason) post.reason = reason
  if (note) post.note = note
  if (url) post.url = url
  if (status === 'approved') post.approvedBy = by || 'user'
  if (status === 'posted') post.postedAt = now()
  post.history.push({ at: now(), event: status, note: reason || note || url, by: by || 'user' })
  writeJson(postPath, post)
  writePages(post.account)
  console.log(`${status}: ${id}`)
}

/** The next posting slots, and which approved posts go in them (oldest approved first). */
export function planSlots(acc, posts, { days = 2, from = new Date() } = {}) {
  const slots = []
  for (let d = 0; d < days; d++) {
    const day = new Date(from)
    day.setDate(day.getDate() + d)
    for (const t of postTimes(acc)) {
      const [h, m] = t.split(':').map(Number)
      const at = new Date(day)
      at.setHours(h, m, 0, 0)
      if (at > from) slots.push(`${localDate(at)} ${t}`)
    }
  }
  const waiting = posts.filter((p) => p.status === 'approved').sort((x, y) => String(x.reviewed || x.created).localeCompare(String(y.reviewed || y.created)))
  const kept = new Map(waiting.filter((p) => slots.includes(p.slot)).map((p) => [p.slot, p]))
  const free = waiting.filter((p) => !slots.includes(p.slot))
  return slots.map((slot) => ({ slot, post: kept.get(slot) || free.shift() || null }))
}

function cmdPlan(a) {
  const names = a.account ? [a.account] : myAccounts()
  for (const n of names) {
    const acc = loadAccount(n)
    const plan = planSlots(acc, allPosts(n), { days: Number(a.days) || 2 })
    console.log(`\n## ${n}: ${acc.postsPerDay} a day`)
    for (const { slot, post } of plan) {
      console.log(`  ${slot}  ${post ? `${post.id} (${post.type})` : '— empty —'}`)
      if (post && post.slot !== slot) {
        const { post: p, postPath } = findPost(post.id)
        p.slot = slot
        writeJson(postPath, p)
      }
    }
    const empty = plan.filter((x) => !x.post).length
    if (empty) console.log(`  ${empty} empty slot(s): needs ${empty} more approved post(s).`)
    writePages(n)
  }
}

function cmdFeedback(a) {
  const rows = allPosts(a.account).filter((p) => p.history?.some((h) => ['approved', 'rejected', 'posted'].includes(h.event)))
  if (!rows.length) return console.log('No reviewed posts yet. Nothing to learn from so far.')
  for (const p of rows.slice(0, 30)) {
    const rej = p.history.filter((h) => h.event === 'rejected').map((h) => h.note).filter(Boolean)
    console.log(`${p.status === 'rejected' ? '✗' : '✓'} ${p.type}: ${p.hook || p.topic}${p.note ? `\n    liked: ${p.note}` : ''}${rej.length ? `\n    rejected because: ${rej.join(' / ')}` : ''}${p.url ? `\n    live: ${p.url}` : ''}`)
  }
}

// ---------------------------------------------------------------------------------------------
// The "Ready to post" pages (browsable from the colony, and your phone)

export function writePages(account) {
  const acc = loadAccount(account)
  const posts = allPosts(account)
  const plan = planSlots(acc, posts)
  const order = { approved: 0, pending: 1, posted: 2, rejected: 3, draft: 4 }
  posts.sort((x, y) => (order[x.status] ?? 9) - (order[y.status] ?? 9) || String(y.created).localeCompare(String(x.created)))
  const media = (p) => p.type === 'reel'
    ? (fs.existsSync(path.join(POSTS, account, p.id, 'video.mp4')) ? `<video src="${esc(p.id)}/video.mp4" poster="${esc(p.id)}/cover.png" controls playsinline preload="none"></video>` : '<p>Not rendered yet</p>')
    : `<div class="slides">${(p.slides || []).map((s) => s.file.replace(/\.svg$/, '.png')).filter((f) => fs.existsSync(path.join(POSTS, account, p.id, f))).map((f) => `<a href="${esc(p.id)}/${esc(f)}" download><img src="${esc(p.id)}/${esc(f)}" loading="lazy"></a>`).join('')}</div>`
  const full = (p) => `${p.caption || ''}${p.hashtags?.length ? `\n\n${p.hashtags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ')}` : ''}`
  const card = (p) => `<article class="${esc(p.status)}" id="${esc(p.id)}">
  ${media(p)}
  <h2>${esc(p.hook || p.topic)}</h2>
  <p class="st">${esc(p.status)} · ${esc(p.type)}${p.seconds ? ` · ${p.seconds.toFixed(0)}s` : ''}${p.slot && p.status === 'approved' ? ` · post at <b>${esc(p.slot)}</b>` : ''}</p>
  ${(p.scenes || p.slides || []).some((s) => s.text) ? `<ol class="script">${(p.scenes || p.slides).map((s) => `<li>${esc(s.text)}</li>`).join('')}</ol>` : ''}
  <textarea readonly rows="5">${esc(full(p))}</textarea>
  <p class="row"><button onclick="copyCap(this)">Copy caption</button>
    ${p.type === 'reel' ? `<a class="btn" href="${esc(p.id)}/video.mp4" download>Download video</a>` : '<span class="muted">Tap a slide to save it</span>'}</p>
  ${p.warnings?.length ? `<p class="warn">⚠ ${p.warnings.map(esc).join('<br>⚠ ')}</p>` : ''}
  ${p.reason ? `<p class="warn">Rejected: ${esc(p.reason)}</p>` : ''}
  <p class="ask">Tell an agent: <code>approve ${esc(p.id)}</code> · <code>reject ${esc(p.id)} because …</code> · after posting: <code>posted ${esc(p.id)}</code></p>
</article>`
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(acc.title)}: ready to post</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#1b1f24;color:#e8ecef}h1{font-size:20px}
article{background:#262c33;border-radius:12px;padding:12px;margin:0 0 14px}video{width:100%;max-height:70vh;border-radius:8px;background:#000}
.slides{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px}.slides img{width:100%;border-radius:6px}
h2{font-size:17px;margin:10px 0 2px}.st,.muted,.ask{color:#a7b0b8}.ask{font-size:13px}.warn{color:#f2c94c}
textarea{width:100%;box-sizing:border-box;background:#14181c;color:#e8ecef;border:1px solid #3a424b;border-radius:8px;padding:8px;font:14px system-ui}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button,.btn{background:#3d7bf2;color:#fff;border:0;border-radius:8px;padding:9px 14px;font:600 14px system-ui;text-decoration:none}
code{background:#111;padding:1px 4px;border-radius:4px}.plan li{margin:2px 0}.rejected,.posted{opacity:.6}a{color:#8ab4ff}
</style>
<h1>${esc(acc.title)}${acc.handle ? ` <small>${esc(acc.handle)}</small>` : ''}</h1>
<h3>Posting plan</h3><ul class="plan">${plan.map(({ slot, post }) => `<li>${esc(slot)}: ${post ? `<a href="#${esc(post.id)}">${esc(post.hook || post.topic)}</a>` : '<span class="muted">empty</span>'}</li>`).join('')}</ul>
${posts.map(card).join('\n') || '<p>No posts yet.</p>'}
<script>
function copyCap(b){const t=b.closest('article').querySelector('textarea');t.select();t.setSelectionRange(0,99999);
let ok=false;try{ok=document.execCommand('copy')}catch(e){}if(!ok&&navigator.clipboard)navigator.clipboard.writeText(t.value);b.textContent='Copied ✓';setTimeout(()=>b.textContent='Copy caption',1500)}
</script>`
  fs.mkdirSync(path.join(POSTS, account), { recursive: true })
  fs.writeFileSync(path.join(POSTS, account, 'index.html'), html)
  fs.writeFileSync(path.join(POSTS, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ready to post</title><style>body{font:16px system-ui;background:#1b1f24;color:#e8ecef;padding:16px}a{color:#8ab4ff}</style>
<h1>Ready to post</h1><ul>${myAccounts().map((n) => { const ps = allPosts(n); return `<li><a href="${esc(n)}/index.html">${esc(n)}</a>: ${ps.filter((p) => p.status === 'approved').length} ready, ${ps.filter((p) => p.status === 'pending').length} to review</li>` }).join('')}</ul>`)
}

// ---------------------------------------------------------------------------------------------
// Style sheet, status, report, dispatch, doctor

async function cmdLook(a) {
  const acc = loadAccount(a.account)
  const svgPath = lookSvg(acc.name)
  if (!fs.existsSync(svgPath)) die(`No style sheet yet. Draw it at ${svgPath} (1080 wide, any height): palette swatches, type samples, the recurring character or motif, and reusable pieces as <symbol id="…">. Then run look again.`)
  const r = await renderSvg(fs.readFileSync(svgPath, 'utf8'), 1080)
  const png = svgPath.replace(/\.svg$/, '.png')
  fs.writeFileSync(png, r.png)
  console.log(`style sheet: ${svgPath}\n  look at:   ${png}\n  Reuse its <symbol>s in posts by copying them into each SVG, so every post looks like the same account.`)
}

function accountStatus(n) {
  const acc = loadAccount(n)
  const ps = allPosts(n)
  const by = (s) => ps.filter((p) => p.status === s).length
  const plan = planSlots(acc, ps)
  return {
    account: n, title: acc.title, autopilot: autopilot(acc), postsPerDay: acc.postsPerDay,
    newAngles: readJson(anglesFile(n), []).filter((x) => x.status === 'new').length,
    pending: by('pending'), approved: by('approved'), posted: by('posted'), rejected: by('rejected'),
    madeToday: ps.filter((p) => String(p.created).startsWith(new Date().toISOString().slice(0, 10))).length,
    emptySlots: plan.filter((x) => !x.post).length, hasLook: fs.existsSync(lookSvg(n)),
  }
}

function cmdStatus(a) {
  const names = a.account ? [a.account] : myAccounts()
  if (!names.length) return console.log('No accounts yet: /account')
  for (const n of names) {
    const s = accountStatus(n)
    console.log(`\n## ${n} (${s.title})\n  posts: ${s.pending} to review, ${s.approved} approved and waiting, ${s.posted} posted, ${s.rejected} rejected` +
      `\n  next 2 days: ${s.emptySlots} empty slot(s) of ${s.postsPerDay * 2} · made today: ${s.madeToday} of ${s.autopilot.makePerDay}` +
      `\n  research: ${s.newAngles} fresh angle(s) · style sheet: ${s.hasLook ? 'yes' : 'NO (run /look)'} · autopilot approve=${s.autopilot.approve ? 'on' : 'off'}`)
  }
}

function cmdReport(a) {
  const days = Number(a.days) || 1
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19)
  const lines = [`# Content Studio: last ${days === 1 ? 'day' : `${days} days`} (${localDate()})`, '']
  const needs = []
  for (const n of myAccounts()) {
    const s = accountStatus(n)
    const events = allPosts(n).flatMap((p) => (p.history || []).filter((h) => h.at >= since))
    const count = (e) => events.filter((x) => x.event === e).length
    lines.push(`## ${n}`, `- Made: ${allPosts(n).filter((p) => String(p.created) >= since).length}. Approved: ${count('approved')}. Rejected: ${count('rejected')}. Posted: ${count('posted')}.`,
      `- Now: ${s.pending} to review, ${s.approved} ready to post, ${s.emptySlots} empty slot(s) in the next 2 days, ${s.newAngles} fresh angle(s).`, '')
    if (s.pending && !s.autopilot.approve) needs.push(`${n}: ${s.pending} post(s) to review (Ready to post page)`)
    if (s.approved) needs.push(`${n}: ${s.approved} approved post(s) to put on Instagram (Ready to post page has the times)`)
  }
  lines.push('## Needs you', ...(needs.length ? needs.map((x) => `- ${x}`) : ['- Nothing.']))
  const text = lines.join('\n') + '\n'
  console.log(text)
  if (a.save) {
    fs.mkdirSync(REPORTS, { recursive: true })
    const file = path.join(REPORTS, `${localDate()}-${days}d.md`)
    fs.writeFileSync(file, text)
    console.log(`saved ${file}`)
  }
}

const samePath = (x, y) => {
  const norm = (s) => (process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s))
  return norm(x) === norm(y)
}
export function makerAgents(state, repoDir = HERE) {
  const repo = (state.repos || []).find((r) => samePath(r.path, repoDir))
  return (repo?.threads || []).filter((t) => t.status === 'running' && /^\s*\/make\b/.test(t.title || ''))
}
async function colony(method, p, body) {
  let res
  try {
    res = await fetch(COLONY + p, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-colony': '1' }, body: body ? JSON.stringify(body) : undefined })
  } catch {
    die(`Agent Colony isn't running at ${COLONY}. Make the post yourself instead.`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) die(`Agent Colony refused: ${data.error || res.status}`)
  return data
}
async function cmdDispatch(a) {
  const id = a._[1] || die('usage: dispatch <angle-id> [--account A]')
  const acc = loadAccount(a.account)
  const angle = readJson(anglesFile(acc.name), []).find((x) => x.id === id) || die(`No angle '${id}' in ${acc.name}`)
  if (angle.status !== 'new') die(`${id} is already ${angle.status}.`)
  const busy = makerAgents(await colony('GET', '/api/state')).length
  if (busy >= MAX_AGENTS) die(`All ${MAX_AGENTS} maker agents are busy. Leave it for the next round.`)
  const res = await colony('POST', '/api/tasks', { repo: HERE, prompt: `/make ${id} ${acc.name}`, tool: 'claude-code', permissionMode: 'acceptEdits', worktree: true })
  console.log(`dispatched: a new agent is making a post from ${id}${res.worktree?.branch ? ` (branch ${res.worktree.branch})` : ''}. ${busy + 1} of ${MAX_AGENTS} makers working.`)
}

async function cmdDoctor() {
  console.log(`Content Studio home: ${HOME}`)
  for (const d of [ACCOUNTS, POSTS, MEDIA, MUSIC, FONTS, REPORTS]) fs.mkdirSync(d, { recursive: true })
  let ok = true
  try {
    await renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', 10)
    console.log('renderer: OK')
  } catch (err) { ok = false; console.log(`renderer: MISSING (${err.message})`) }
  try { console.log(`ffmpeg: ${ffmpeg()}`) } catch (err) { ok = false; console.log(`ffmpeg: ${err.message}`) }
  console.log(`accounts: ${myAccounts().join(', ') || 'none yet'}`)
  if (!ok) process.exitCode = 1
}

// ---------------------------------------------------------------------------------------------

const HELP = `Content Studio: node studio.mjs <command>

  doctor                                  check the renderer, ffmpeg and folders
  new-account --name N --niche "…" [--handle @…] [--audience …] [--voice …] [--palette "#hex,…"] [--fonts "…"] [--posts-per-day 2]
  accounts                                every account's full brief: niche, voice, look, schedule, media
  look [--account A]                      render the account's style sheet (accounts/<name>.look.svg)
  reddit <subreddit> [--t month]          top posts, for research (use WebSearch for Instagram and TikTok)
  angle add --angle "…" --why "…" [--evidence urls] [--format reel|carousel]  ·  angles [--status new|all]
  angle skip <id> --reason "…"  ·  angle done <id>
  hook add --text "…" --pattern "…" [--topic …]  ·  hooks [--topic …]
  media  ·  frame <your-file> --at 3.5    your photos/clips/music, and a still to look at
  dispatch <angle-id>                     start a maker agent for it in Agent Colony (max ${MAX_AGENTS} at once)
  post new --topic "…" [--type reel|carousel|image] [--angle <id>] [--scenes 5]
  render <post-id> [--reason "…"]         video.mp4 or slide PNGs, cover, check.png, checks
  queue [--status pending|approved|posted|rejected|all]
  approve <post-id> [--note …] [--by manager]  ·  reject <post-id> --reason "…"  ·  posted <post-id> [--url …]
  plan [--days 2]                         put approved posts into each day's posting slots
  feedback  ·  status  ·  report [--days 7] [--save]
  (add --account A to any command when you have more than one account)`

export async function main(argv) {
  const a = parseArgs(argv)
  const cmd = a._[0]
  const table = {
    doctor: cmdDoctor, 'new-account': cmdNewAccount, accounts: cmdAccounts, look: cmdLook, reddit: cmdReddit,
    angle: cmdAngle, angles: cmdAngles, hook: cmdHook, hooks: cmdHooks, media: cmdMedia, frame: cmdFrame,
    dispatch: cmdDispatch, post: cmdPost, render: cmdRender, queue: cmdQueue, plan: cmdPlan, feedback: cmdFeedback,
    status: cmdStatus, report: cmdReport,
    approve: (x) => setStatus(x._[1] || die('usage: approve <post-id>'), 'approved', { note: x.note || '', by: x.by || '' }),
    reject: (x) => setStatus(x._[1] || die('usage: reject <post-id> --reason "…"'), 'rejected', { reason: x.reason || die('Say why: --reason "…" (the agents learn from it)') }),
    posted: (x) => setStatus(x._[1] || die('usage: posted <post-id> [--url …]'), 'posted', { url: x.url || '' }),
  }
  if (!cmd || cmd === 'help' || a.help) return console.log(HELP)
  const fn = table[cmd] || die(`Unknown command '${cmd}'.\n\n${HELP}`)
  await fn(a)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof Stop) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  })
}
