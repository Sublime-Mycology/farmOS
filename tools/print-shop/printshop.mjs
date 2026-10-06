#!/usr/bin/env node
// Print Shop: print-on-demand merch run by agents. Designs are SVG files an agent writes; this tool
// renders them to print files and mockups, keeps a review queue, and lists approved designs on
// Printify, which prints and ships every order. Nothing is listed until it's approved.
//
//   node printshop.mjs <command> [args]      (node printshop.mjs help for the list)
//
// Everything you make lives in ~/PrintShop (PRINT_SHOP_HOME), never in git.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HOME = path.resolve((process.env.PRINT_SHOP_HOME || path.join(os.homedir(), 'PrintShop')).replace(/^~(?=$|[\\/])/, os.homedir()))
const BRANDS = path.join(HOME, 'brands')
const DESIGNS = path.join(HOME, 'designs')
const REPORTS = path.join(HOME, 'reports')
const FONTS = path.join(HOME, 'fonts')
const TOKEN_FILE = path.join(HOME, 'printify-token.txt')
const API = (process.env.PRINTIFY_API || 'https://api.printify.com/v1').replace(/\/$/, '')
const COLONY = (process.env.PRINT_SHOP_COLONY_URL || 'http://127.0.0.1:5274').replace(/\/$/, '')
export const MAX_AGENTS = Number(process.env.PRINT_SHOP_MAX_AGENTS || 4)

// ---------------------------------------------------------------------------------------------
// Products. Sizes are Printify's usual print areas; `product set` replaces them with the exact
// ones from the catalog once you pick a blueprint and print provider.

export const PRODUCT_PRESETS = {
  tee: { label: 'T-shirt', width: 4500, height: 5400, transparent: true, mockup: 'tee',
    colors: ['Black', 'White', 'Forest Green', 'Heather Grey'], sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 24.99 },
  hoodie: { label: 'Hoodie', width: 4500, height: 4800, transparent: true, mockup: 'tee',
    colors: ['Black', 'Forest Green', 'Sand'], sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 44.99 },
  mug: { label: 'Mug 11oz', width: 2700, height: 1050, transparent: false, mockup: 'mug', colors: ['White'], sizes: [], price: 16.99 },
  sticker: { label: 'Sticker', width: 1500, height: 1500, transparent: true, mockup: 'sticker', colors: ['White'], sizes: [], price: 4.99 },
  poster: { label: 'Poster', width: 5400, height: 7200, transparent: false, mockup: 'poster', colors: ['White'], sizes: [], price: 22.99 },
  tote: { label: 'Tote bag', width: 3600, height: 3600, transparent: true, mockup: 'tote', colors: ['Natural', 'Black'], sizes: [], price: 19.99 },
  // Embroidered: thread, not ink. Few flat colours, no fine detail (see CLAUDE.md).
  hat: { label: 'Embroidered hat', width: 1200, height: 525, transparent: true, embroidery: true, mockup: 'hat',
    colors: ['Black', 'Khaki', 'Navy'], sizes: [], price: 26.99 },
  // Home decor
  canvas: { label: 'Canvas print', width: 4800, height: 3600, transparent: false, mockup: 'canvas', colors: ['White'], sizes: [], price: 39.99 },
  pillow: { label: 'Throw pillow', width: 4050, height: 4050, transparent: false, mockup: 'pillow', colors: ['White'], sizes: [], price: 29.99 },
  blanket: { label: 'Throw blanket', width: 6000, height: 4800, transparent: false, mockup: 'blanket', colors: ['White'], sizes: [], price: 49.99 },
  // Not a product: a design for its own sake, kept in the sketchbook. `retarget` turns one into merch.
  art: { label: 'Artwork', width: 4000, height: 4000, transparent: false, mockup: 'art', colors: ['White'], sizes: [], price: 0, notForSale: true },
}

/** Where designs that aren't for any product live. Made the first time it's used. */
export const SKETCHBOOK = 'sketchbook'

const COLOR_HEX = {
  black: '#151515', white: '#f4f4f2', 'forest green': '#2f4a33', 'heather grey': '#9a9b9d', 'athletic heather': '#a7a8aa',
  navy: '#1f2a44', sand: '#d9c9a7', natural: '#efe6d2', maroon: '#5a1f2a', brown: '#4b3621', olive: '#5b5f3a',
  'military green': '#4b5320', red: '#b22222', 'true royal': '#2b4ea2', 'royal blue': '#2b4ea2', 'dark heather': '#3f4447',
  ash: '#d9d9d6', pink: '#f4b6c2', 'soft pink': '#f4c6cf', charcoal: '#36454f', 'dark grey': '#454545', mustard: '#d0a33a',
  'heather forest': '#3c5442', 'heather navy': '#3a4660', cream: '#f3ecd8', 'ice blue': '#cfe3ea', mauve: '#b38b91',
  khaki: '#c3b091', stone: '#bfb6a5', 'spruce': '#2e4a3f', 'dark grey heather': '#4a4d50',
}
export const colorHex = (name) => COLOR_HEX[String(name).toLowerCase()] || (/^#[0-9a-f]{6}$/i.test(name) ? name : '#888888')

export const DEFAULT_AUTOPILOT = {
  approve: false,        // may the manager approve designs that pass its checklist?
  publish: false,        // may it make approved designs live in the store (not just Printify drafts)?
  maxDesignsPerDay: 6,   // new designs the manager may start per day
}
export const autopilot = (brand) => ({ ...DEFAULT_AUTOPILOT, ...(brand.autopilot || {}) })

// Names that get listings pulled and accounts banned. A safety net, not legal advice: the manager
// also checks every design by eye, and you decide anything borderline.
const RISKY = [
  'disney', 'pixar', 'marvel', 'avengers', 'star wars', 'jedi', 'pokemon', 'pokémon', 'pikachu', 'nintendo', 'mario', 'zelda',
  'harry potter', 'hogwarts', 'hello kitty', 'sanrio', 'barbie', 'lego', 'nike', 'adidas', 'just do it', 'supreme', 'gucci',
  'louis vuitton', 'chanel', 'coca-cola', 'coke', 'pepsi', 'starbucks', 'mcdonald', 'nfl', 'nba', 'mlb', 'nhl', 'fifa', 'olympic',
  'super bowl', 'taylor swift', 'beyonce', 'grateful dead', 'metallica', 'the beatles', 'peanuts', 'snoopy', 'spongebob',
  'simpsons', 'scooby', 'looney tunes', 'bluey', 'minecraft', 'fortnite', 'jeep', 'harley', 'john deere', 'yeti', 'stanley',
  'friends tv', 'stranger things', 'game of thrones', 'lord of the rings', 'hobbit', 'tolkien', 'dr. seuss', 'grinch', 'mtv',
]

// ---------------------------------------------------------------------------------------------
// Small helpers

class Stop extends Error {}
export function die(msg) { throw new Stop(msg) }
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback } }
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, p)
}
const now = () => new Date().toISOString().slice(0, 19)
const today = () => new Date().toISOString().slice(0, 10)
export const slug = (s, n = 40) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, n).replace(/-$/, '') || 'design'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)

/** argv → { _: [positional], flag: value | true } */
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
// Brands (one per store or audience) and their idea lists

const brandFile = (name) => path.join(BRANDS, `${name}.json`)
const ideasFile = (name) => path.join(BRANDS, `${name}.ideas.json`)
export function myBrands() {
  try { return fs.readdirSync(BRANDS).filter((f) => f.endsWith('.json') && !f.endsWith('.ideas.json')).map((f) => f.slice(0, -5)).sort() } catch { return [] }
}
export function loadBrand(name) {
  if (name === SKETCHBOOK && !fs.existsSync(brandFile(SKETCHBOOK))) {
    writeJson(brandFile(SKETCHBOOK), {
      title: 'Sketchbook', niche: 'Cool designs and ideas for their own sake. Not for sale until one is turned into a product.',
      audience: '', style: 'Anything goes: experiment.', avoid: 'Other people\'s brands, characters and celebrities.',
      products: { art: { ...PRODUCT_PRESETS.art } }, printify: { shopId: null }, autopilot: { ...DEFAULT_AUTOPILOT }, created: now(),
    })
  }
  if (!name) {
    const all = myBrands().filter((b) => b !== SKETCHBOOK)
    if (all.length === 1) name = all[0]
    else die(all.length ? `Which brand? --brand ${all.join(' | ')}` : 'No brands yet: node printshop.mjs new-brand --name … (or ask an agent: /brand)')
  }
  const b = readJson(brandFile(name), null)
  if (!b) die(`No brand '${name}'. Brands: ${myBrands().join(', ') || 'none'}`)
  return { ...b, name }
}
const saveBrand = (b) => writeJson(brandFile(b.name), b)
export function productOf(brand, kind) {
  // Artwork needs no product, so every brand can have it.
  const p = brand.products?.[kind] || (kind === 'art' ? PRODUCT_PRESETS.art : null)
  if (!p) die(`Brand '${brand.name}' doesn't sell '${kind}'. It sells: ${Object.keys(brand.products || {}).join(', ')}`)
  return { ...(PRODUCT_PRESETS[kind] || {}), ...p, kind }
}

function cmdNewBrand(a) {
  const name = slug(a.name || '', 30)
  if (!a.name) die('usage: new-brand --name shroom-shirts --title "Shroom Shirts" --niche "…" [--audience "…"] [--style "…"] [--products tee,sticker,mug]')
  if (fs.existsSync(brandFile(name))) die(`Brand '${name}' already exists.`)
  const kinds = list(a.products || 'tee,sticker')
  for (const k of kinds) if (!PRODUCT_PRESETS[k]) die(`Unknown product '${k}'. Choose from: ${Object.keys(PRODUCT_PRESETS).join(', ')}`)
  const brand = {
    title: a.title || a.name,
    niche: a.niche || '',
    audience: a.audience || '',
    style: a.style || 'Bold, simple, readable from across a room. At most 3 colours.',
    avoid: a.avoid || 'Other people\'s brands, characters, celebrities, sports teams, lyrics and quotes; anything mean or political.',
    products: Object.fromEntries(kinds.map((k) => [k, { ...PRODUCT_PRESETS[k], blueprint: null, provider: null }])),
    printify: { shopId: null },
    autopilot: { ...DEFAULT_AUTOPILOT },
    created: now(),
  }
  writeJson(brandFile(name), brand)
  writeJson(ideasFile(name), [])
  console.log(`Made brand '${name}' selling ${kinds.join(', ')}.\nNext: ideas (/ideas), then connect Printify (node printshop.mjs connect --brand ${name}).`)
}

function cmdBrands() {
  const all = myBrands()
  if (!all.length) return console.log('No brands yet: node printshop.mjs new-brand --name …')
  for (const n of all) {
    const b = loadBrand(n)
    const ap = autopilot(b)
    // The whole brief, so agents never need to open the brand file.
    console.log(`${n}: ${b.title}\n  niche: ${b.niche}\n  audience: ${b.audience || '-'}\n  style: ${b.style}\n  avoid: ${b.avoid}` +
      `\n  sells: ${Object.entries(b.products).map(([k, p]) => `${k} $${p.price} in ${(p.colors || []).join('/') || 'one colour'}${p.blueprint ? '' : ' (no Printify product picked)'}`).join('; ')}` +
      `\n  printify: ${b.printify?.shopId ? `shop ${b.printify.shopTitle || b.printify.shopId}` : 'not connected'} · autopilot approve=${ap.approve ? 'on' : 'off'}, publish=${ap.publish ? 'on' : 'off'}, ${ap.maxDesignsPerDay} designs a day`)
  }
}

const loadIdeas = (b) => readJson(ideasFile(b), [])
const saveIdeas = (b, ideas) => writeJson(ideasFile(b), ideas)

function cmdIdea(a) {
  const sub = a._[1]
  const brand = loadBrand(a.brand)
  const ideas = loadIdeas(brand.name)
  if (sub === 'add') {
    if (!a.text) die('usage: idea add --text "the design idea" --why "who buys it and why" [--product tee] [--brand B]')
    const product = a.product || Object.keys(brand.products)[0]
    productOf(brand, product)
    const dup = ideas.find((i) => i.text.toLowerCase() === String(a.text).toLowerCase())
    if (dup) die(`Already have that idea: ${dup.id}`)
    const idea = { id: `i-${slug(a.text, 24)}-${crypto.randomBytes(2).toString('hex')}`, text: a.text, why: a.why || '', product, status: 'new', at: now() }
    ideas.push(idea)
    saveIdeas(brand.name, ideas)
    return console.log(`added ${idea.id}`)
  }
  if (sub === 'skip') {
    const idea = ideas.find((i) => i.id === a._[2])
    if (!idea) die(`No idea '${a._[2]}' in ${brand.name}`)
    Object.assign(idea, { status: 'skipped', reason: a.reason || '', at: now() })
    saveIdeas(brand.name, ideas)
    return console.log(`skipped ${idea.id}`)
  }
  die('usage: idea add … | idea skip <idea-id> --reason "…"')
}

function cmdIdeas(a) {
  const brand = loadBrand(a.brand)
  const want = a.status || 'new'
  const rows = loadIdeas(brand.name).filter((i) => want === 'all' || i.status === want)
  if (!rows.length) return console.log(`No ${want === 'all' ? '' : `${want} `}ideas for ${brand.name}.`)
  for (const i of rows) console.log(`${i.id}  [${i.status}] ${i.product}: ${i.text}${i.why ? `\n    why: ${i.why}` : ''}${i.reason ? `\n    skipped: ${i.reason}` : ''}`)
}

// ---------------------------------------------------------------------------------------------
// Designs: ~/PrintShop/designs/<brand>/<id>/ with design.svg, print.png, preview.png, mockups

const designDir = (brand, id) => path.join(DESIGNS, brand, id)
export function findDesign(id) {
  for (const b of myBrands()) {
    const dir = designDir(b, id)
    const meta = readJson(path.join(dir, 'meta.json'), null)
    if (meta) return { dir, meta, metaPath: path.join(dir, 'meta.json') }
  }
  die(`No design '${id}'. See: node printshop.mjs queue`)
}
export function allDesigns(brand) {
  const brands = brand ? [brand] : myBrands()
  const out = []
  for (const b of brands) {
    let ids = []
    try { ids = fs.readdirSync(path.join(DESIGNS, b)) } catch { continue }
    for (const id of ids) {
      const meta = readJson(path.join(DESIGNS, b, id, 'meta.json'), null)
      if (meta) out.push(meta)
    }
  }
  return out.sort((x, y) => String(y.created).localeCompare(String(x.created)))
}

export function starterSvg(p, title) {
  const { width: W, height: H } = p
  const bg = p.transparent ? '' : `\n  <rect width="${W}" height="${H}" fill="#f4f1ea"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- ${p.label}: print area ${W}×${H} px. ${p.transparent ? 'Leave the background transparent: the fabric shows through.' : 'Fill the whole area.'}
       Keep everything inside the safe area (5% in from each edge). Replace this starter. -->${bg}
  <text x="${W / 2}" y="${H / 2}" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial Black, Arial, sans-serif" font-size="${Math.round(W / 12)}" fill="#e8b04a">${esc(title)}</text>
</svg>
`
}

function cmdDesign(a) {
  if (a._[1] !== 'new') die('usage: design new --title "…" [--product tee] [--idea <idea-id>] [--brand B]')
  const brand = loadBrand(a.brand)
  let idea = null
  if (a.idea) {
    const ideas = loadIdeas(brand.name)
    idea = ideas.find((i) => i.id === a.idea)
    if (!idea) die(`No idea '${a.idea}' in ${brand.name}`)
    idea.status = 'designed'
    idea.at = now()
    saveIdeas(brand.name, ideas)
  }
  const kind = a.product || idea?.product || Object.keys(brand.products)[0]
  const p = productOf(brand, kind)
  const title = a.title || idea?.text
  if (!title) die('Give it a --title')
  const id = `${slug(title, 28)}-${kind}-${crypto.randomBytes(2).toString('hex')}`
  const dir = designDir(brand.name, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'design.svg'), starterSvg(p, title))
  writeJson(path.join(dir, 'meta.json'), {
    id, brand: brand.name, product: kind, title, idea: idea?.id || '', ideaText: idea?.text || '',
    description: '', tags: [], colors: p.colors.slice(0, 4), price: p.price, status: 'draft', created: now(), history: [],
  })
  console.log(`made ${id}\n  edit:   ${path.join(dir, 'design.svg')}\n  then:   node printshop.mjs render ${id}`)
}

/** Fonts the renderer may use: your ~/PrintShop/fonts folder, plus the computer's own. */
function fontOptions() {
  let files = []
  try { files = fs.readdirSync(FONTS).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => path.join(FONTS, f)) } catch { /* none */ }
  return { loadSystemFonts: true, fontFiles: files, defaultFontFamily: 'Arial' }
}

/**
 * The renderer. Agents work in git worktrees, which have no node_modules of their own, so fall
 * back to the main checkout's copy.
 */
async function resvg() {
  try { return (await import('@resvg/resvg-js')).Resvg } catch { /* try the main checkout */ }
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: HERE, encoding: 'utf8' }).trim()
    const require = createRequire(path.join(path.dirname(common), 'package.json'))
    return require('@resvg/resvg-js').Resvg
  } catch {
    die('The renderer is missing: run npm install in the print-shop folder.')
  }
}

/** Render SVG text to a PNG at an exact width. Returns { png, width, height, pixels }. */
export async function renderSvg(svg, width, { withPixels = false } = {}) {
  const Resvg = await resvg()
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(width) }, font: fontOptions(), background: 'rgba(0,0,0,0)' })
  const img = r.render()
  return { png: img.asPng(), width: img.width, height: img.height, pixels: withPixels ? img.pixels : null }
}

/** Print-file checks from the rendered pixels. */
export function checkPixels(pixels, W, H, p) {
  const warnings = []
  let minX = W, minY = H, maxX = -1, maxY = -1, painted = 0
  const step = Math.max(1, Math.floor(Math.min(W, H) / 600)) // sample: plenty for these checks
  let samples = 0
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      samples++
      if (pixels[(y * W + x) * 4 + 3] > 8) {
        painted++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { warnings: ['The print file is empty: nothing would print.'], coverage: 0 }
  if (p.embroidery) {
    // Thread colours: count the flat colours that cover a real share of the design.
    const counts = new Map()
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const i = (y * W + x) * 4
        if (pixels[i + 3] < 200) continue
        const key = ((pixels[i] >> 5) << 6) | ((pixels[i + 1] >> 5) << 3) | (pixels[i + 2] >> 5)
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    const solid = [...counts.values()].reduce((a, b) => a + b, 0)
    const threads = [...counts.values()].filter((n) => n > solid * 0.01).length
    if (threads > 6) warnings.push(`About ${threads} colours: embroidery works best with 6 thread colours or fewer, all flat (no gradients or shading).`)
  }
  const coverage = painted / samples
  const bw = (maxX - minX + 1) / W
  const bh = (maxY - minY + 1) / H
  if (!p.transparent && coverage < 0.97) warnings.push(`It doesn't fill the print area (${Math.round(coverage * 100)}% covered). ${p.label || 'This product'} prints edge to edge: fill the background.`)
  if (p.transparent && coverage > 0.97) warnings.push('The background is filled in. On apparel it prints as a solid box: make the background transparent.')
  const m = 0.02
  if (p.transparent && (minX < W * m || minY < H * m || maxX > W * (1 - m) || maxY > H * (1 - m))) {
    warnings.push('Art reaches the edge of the print area and may be cut off: keep it inside the safe area (5% in).')
  }
  if (Math.max(bw, bh) < 0.35) warnings.push(`The art is small (${Math.round(bw * 100)}% × ${Math.round(bh * 100)}% of the print area). Scale it up unless that's the look.`)
  return { warnings, coverage, box: [minX, minY, maxX, maxY].map((v) => Math.round(v)) }
}

const SHAPES = {
  tee: { shape: 'M300 120 L405 88 Q500 150 595 88 L700 120 L905 255 L825 410 L742 368 L742 925 L258 925 L258 368 L175 410 L95 255 Z', area: [340, 210, 320, 384] },
  tote: { shape: 'M230 300 L770 300 L790 930 L210 930 Z M360 300 Q360 120 500 120 Q640 120 640 300', area: [300, 380, 400, 400] },
  mug: { shape: 'M170 300 L740 300 L740 820 Q740 870 690 870 L220 870 Q170 870 170 820 Z M740 400 Q880 400 880 560 Q880 720 740 720', area: [200, 360, 510, 198] },
  poster: { shape: 'M200 70 L800 70 L800 930 L200 930 Z', area: [230, 100, 540, 720] },
  sticker: { shape: 'M500 120 A380 380 0 1 1 499 120 Z', area: [190, 190, 620, 620] },
  hat: { shape: 'M250 585 Q245 255 500 245 Q755 255 750 585 Z M235 585 Q500 545 790 585 Q845 650 715 668 L300 668 Q180 655 235 585 Z', area: [345, 360, 310, 136] },
  canvas: { shape: 'M140 230 L860 230 L860 770 L140 770 Z', area: [140, 230, 720, 540] },
  pillow: { shape: 'M175 175 Q500 135 825 175 Q865 500 825 825 Q500 865 175 825 Q135 500 175 175 Z', area: [190, 190, 620, 620] },
  blanket: { shape: 'M110 190 L890 190 L890 814 L110 814 Z', area: [110, 190, 780, 624] },
  art: { shape: 'M90 90 L910 90 L910 910 L90 910 Z', area: [100, 100, 800, 800] },
}

/** A flat mockup: the product's silhouette in `hex`, with the design placed on its print area. */
export function mockupSvg(kind, hex, previewPng, pw, ph) {
  const s = SHAPES[kind] || SHAPES.poster
  const [ax, ay, aw, ah] = s.area
  const scale = Math.min(aw / pw, ah / ph)
  const w = pw * scale, h = ph * scale
  const x = ax + (aw - w) / 2, y = ay + (ah - h) / 2
  const light = parseInt(hex.slice(1), 16) > 0xb0b0b0
  const fill = kind === 'sticker' ? '#ffffff' : hex
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="1000" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="${light ? '#d7d4cc' : '#efece4'}"/>
  <path d="${s.shape}" fill="${fill}" stroke="${light ? '#b7b2a6' : '#00000033'}" stroke-width="4" fill-rule="evenodd"/>
  <image x="${x}" y="${y}" width="${w}" height="${h}" xlink:href="data:image/png;base64,${previewPng.toString('base64')}"/>
</svg>`
}

async function cmdRender(a) {
  const { dir, meta, metaPath } = findDesign(a._[1] || die('usage: render <design-id> [--colors "Black,White"]'))
  const brand = loadBrand(meta.brand)
  const p = productOf(brand, meta.product)
  const svgPath = path.join(dir, 'design.svg')
  const svg = fs.readFileSync(svgPath, 'utf8')
  if (/(?:xlink:)?href\s*=\s*["']https?:/i.test(svg)) die('The SVG links to an image on the web. Embed it (data: URI) or draw it in SVG.')
  if (!/<svg[\s>]/i.test(svg)) die('design.svg is not an SVG file.')
  let print
  try { print = await renderSvg(svg, p.width, { withPixels: true }) } catch (err) { die(`The SVG didn't render: ${err.message}`) }
  const warnings = []
  if (Math.abs(print.height - p.height) > 2) warnings.push(`It renders ${print.width}×${print.height}, but the ${p.label} print area is ${p.width}×${p.height}. Set the SVG's viewBox to "0 0 ${p.width} ${p.height}".`)
  const pix = checkPixels(print.pixels, print.width, print.height, p)
  warnings.push(...pix.warnings)
  fs.writeFileSync(path.join(dir, 'print.png'), print.png)
  const preview = await renderSvg(svg, 900)
  fs.writeFileSync(path.join(dir, 'preview.png'), preview.png)
  if (a.colors) meta.colors = list(a.colors)
  const colors = (meta.colors?.length ? meta.colors : p.colors).slice(0, 4)
  for (const f of fs.readdirSync(dir)) if (/^mockup-.*\.png$/.test(f)) fs.rmSync(path.join(dir, f))
  const mockups = []
  for (const c of colors) {
    const m = await renderSvg(mockupSvg(p.mockup || 'poster', colorHex(c), preview.png, preview.width, preview.height), 1000)
    const file = `mockup-${slug(c, 20)}.png`
    fs.writeFileSync(path.join(dir, file), m.png)
    mockups.push({ color: c, file })
  }
  const risky = riskyWords(`${meta.title} ${(meta.tags || []).join(' ')} ${svgText(svg)}`)
  if (risky.length) warnings.push(`Possible trademark or famous name: ${risky.join(', ')}. Don't sell this unless it's clearly not theirs.`)
  const was = meta.status
  Object.assign(meta, {
    rendered: now(), width: print.width, height: print.height, warnings, mockups, coverage: Math.round(pix.coverage * 100),
    status: was === 'draft' || was === 'rejected' ? 'pending' : was,
  })
  if (was === 'rejected') meta.history.push({ at: now(), event: 'redone', note: a.reason || '' })
  writeJson(metaPath, meta)
  writeReviewPage(meta.brand)
  console.log(`rendered ${meta.id}: ${print.width}×${print.height} print file, ${mockups.length} mockup(s)`)
  console.log(`  look at:  ${path.join(dir, 'preview.png')}`)
  for (const m of mockups) console.log(`            ${path.join(dir, m.file)}`)
  console.log(warnings.length ? `  ⚠ ${warnings.join('\n  ⚠ ')}` : '  checks: OK')
  if (meta.status === 'pending') console.log('  status: ready for review')
}

const svgText = (svg) => [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)].map((m) => m[1].replace(/<[^>]+>/g, ' ')).join(' ')
export function riskyWords(text) {
  const t = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `
  return RISKY.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(t))
}

/**
 * A copy of a design made for another product: the old art, scaled into the new print area's safe
 * zone, as a fresh draft to adjust. How a sketchbook design becomes a shirt, hat or pillow.
 */
export function retargetSvg(svg, p) {
  const m = /<svg\b([^>]*)>/i.exec(svg) || die('design.svg has no <svg> tag.')
  const attrs = m[1]
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ||
    `0 0 ${/width\s*=\s*["']?([\d.]+)/i.exec(attrs)?.[1] || 1000} ${/height\s*=\s*["']?([\d.]+)/i.exec(attrs)?.[1] || 1000}`
  const inner = svg.slice(m.index + m[0].length, svg.lastIndexOf('</svg>'))
  const { width: W, height: H } = p
  // Apparel and hats: fit inside the safe area. Decor and mugs print edge to edge: fill it.
  const pad = p.transparent ? 0.06 : 0
  const fit = p.transparent ? 'xMidYMid meet' : 'xMidYMid slice'
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- ${p.label}: print area ${W}×${H}. Made from another design: adjust it for this product. -->
  <svg x="${Math.round(W * pad)}" y="${Math.round(H * pad)}" width="${Math.round(W * (1 - 2 * pad))}" height="${Math.round(H * (1 - 2 * pad))}" viewBox="${vb}" preserveAspectRatio="${fit}">${inner}</svg>
</svg>
`
}

function cmdRetarget(a) {
  const id = a._[1] || die('usage: retarget <design-id> --product tee|hat|pillow|… [--brand B]')
  const { dir, meta } = findDesign(id)
  const brand = loadBrand(a.brand || (meta.brand === SKETCHBOOK ? undefined : meta.brand))
  const kind = a.product || die('Which product? --product tee (or hat, mug, pillow, canvas…)')
  const p = productOf(brand, kind)
  const newId = `${slug(meta.title, 28)}-${kind}-${crypto.randomBytes(2).toString('hex')}`
  const out = designDir(brand.name, newId)
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'design.svg'), retargetSvg(fs.readFileSync(path.join(dir, 'design.svg'), 'utf8'), p))
  writeJson(path.join(out, 'meta.json'), {
    id: newId, brand: brand.name, product: kind, title: meta.title, idea: meta.idea || '', ideaText: meta.ideaText || '', from: id,
    description: '', tags: meta.tags || [], colors: p.colors.slice(0, 4), price: p.price, status: 'draft', created: now(), history: [],
  })
  console.log(`made ${newId} for ${brand.name} (${p.label}) from ${id}\n  edit:   ${path.join(out, 'design.svg')}\n  then:   node printshop.mjs render ${newId}` +
    (p.embroidery ? '\n  It\'s embroidered: simplify to 6 flat colours or fewer and thicken thin lines.' : ''))
}

function cmdMeta(a) {
  const { meta, metaPath } = findDesign(a._[1] || die('usage: meta <design-id> [--title …] [--description …] [--tags a,b] [--colors A,B] [--price 24.99]'))
  if (a.title) {
    if (String(a.title).length > 140) die('Titles: 140 characters at most.')
    meta.title = a.title
  }
  if (a.description) meta.description = a.description
  if (a.tags) {
    const tags = list(a.tags)
    if (tags.length > 13) die('13 tags at most (Etsy\'s limit).')
    meta.tags = tags
  }
  if (a.colors) meta.colors = list(a.colors)
  if (a.price) {
    const price = Number(a.price)
    if (!(price > 0 && price < 1000)) die('Price in dollars, like 24.99')
    meta.price = price
  }
  writeJson(metaPath, meta)
  writeReviewPage(meta.brand)
  console.log(`updated ${meta.id}`)
}

function cmdQueue(a) {
  const want = a.status || 'pending'
  const rows = allDesigns(a.brand).filter((m) => want === 'all' || m.status === want)
  if (!rows.length) return console.log(`No ${want === 'all' ? '' : `${want} `}designs.`)
  for (const m of rows) {
    console.log(`${m.id}  [${m.status}] ${m.brand} · ${m.product} · $${m.price}\n    ${m.title}${m.reason ? `\n    rejected: ${m.reason}` : ''}${m.warnings?.length ? `\n    ⚠ ${m.warnings.join(' / ')}` : ''}`)
  }
  const pages = [...new Set(rows.map((m) => m.brand))].map((b) => path.join(DESIGNS, b, 'index.html'))
  console.log(`\nReview page: ${pages.join(', ')}`)
}

export function setStatus(id, status, { reason = '', note = '', by = '' } = {}) {
  const { meta, metaPath } = findDesign(id)
  if (by === 'manager' && status === 'approved' && !autopilot(loadBrand(meta.brand)).approve) {
    die(`autopilot.approve is off for '${meta.brand}': only the user can approve. List it in your report instead.`)
  }
  if (status === 'approved' && meta.status !== 'pending') die(`${id} is ${meta.status}; only designs waiting for review can be approved.`)
  if (status === 'approved' && !meta.rendered) die('Render it first.')
  meta.status = status
  if (reason) meta.reason = reason
  if (note) meta.note = note
  if (status === 'approved') meta.approvedBy = by || 'user'
  meta.reviewed = now()
  meta.history.push({ at: now(), event: status, note: reason || note, by: by || 'user' })
  writeJson(metaPath, meta)
  writeReviewPage(meta.brand)
  console.log(`${status}: ${id}`)
}

function cmdFeedback(a) {
  const rows = allDesigns(a.brand).filter((m) => m.reviewed && ['approved', 'rejected', 'listed', 'published'].includes(m.status) || m.history?.some((h) => h.event === 'rejected'))
  if (!rows.length) return console.log('No reviewed designs yet. Nothing to learn from so far.')
  const ok = rows.filter((m) => m.status !== 'rejected')
  console.log(`# ${a.brand || 'all brands'}: ${ok.length} approved, ${rows.length - ok.length} rejected\n`)
  for (const m of rows.slice(0, 30)) {
    const rej = m.history.filter((h) => h.event === 'rejected').map((h) => h.note).filter(Boolean)
    console.log(`${m.status === 'rejected' ? '✗' : '✓'} ${m.product}: ${m.title}${m.note ? `\n    liked: ${m.note}` : ''}${rej.length ? `\n    rejected because: ${rej.join(' / ')}` : ''}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Review page per brand, browsable from the colony (and your phone)

export function writeReviewPage(brandName) {
  const rows = allDesigns(brandName)
  const order = { pending: 0, approved: 1, listed: 2, published: 3, rejected: 4, replaced: 5, draft: 6 }
  rows.sort((x, y) => (order[x.status] ?? 9) - (order[y.status] ?? 9) || String(y.created).localeCompare(String(x.created)))
  const card = (m) => `<article class="${esc(m.status)}">
  <div class="imgs">${(m.mockups || []).map((x) => `<a href="${esc(m.id)}/${esc(x.file)}"><img src="${esc(m.id)}/${esc(x.file)}" alt="${esc(x.color)}" loading="lazy"></a>`).join('') || '<p>Not rendered yet</p>'}</div>
  <h2>${esc(m.title)}</h2>
  <p class="st">${esc(m.status)} · ${esc(m.product)} · $${esc(m.price)} · ${esc((m.colors || []).join(', '))}</p>
  ${m.description ? `<p>${esc(m.description)}</p>` : ''}
  ${m.tags?.length ? `<p class="tags">${m.tags.map((t) => `<span>${esc(t)}</span>`).join(' ')}</p>` : ''}
  ${m.warnings?.length ? `<p class="warn">⚠ ${m.warnings.map(esc).join('<br>⚠ ')}</p>` : ''}
  ${m.reason ? `<p class="warn">Rejected: ${esc(m.reason)}</p>` : ''}
  ${m.printify?.productId ? `<p>On Printify: product ${esc(m.printify.productId)}${m.status === 'published' ? ' (live in the store)' : ' (draft)'}</p>` : ''}
  <p class="ask">Tell an agent: <code>approve ${esc(m.id)}</code> or <code>reject ${esc(m.id)} because …</code></p>
  <p><a href="${esc(m.id)}/print.png" download>Print file</a> · <a href="${esc(m.id)}/design.svg">SVG</a></p>
</article>`
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(brandName)}: designs</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#1d2420;color:#e9eee7}
h1{font-size:20px}article{background:#28312b;border-radius:12px;padding:12px;margin:0 0 14px}
.imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}.imgs img{width:100%;border-radius:8px;display:block}
h2{font-size:17px;margin:10px 0 2px}.st{color:#a9b8a6;margin:0}.warn{color:#f2c94c}.tags span{background:#3a463d;border-radius:6px;padding:1px 6px;font-size:12px}
.ask{font-size:13px;color:#a9b8a6}code{background:#111;padding:1px 4px;border-radius:4px}a{color:#9fd18b}
.rejected,.replaced{opacity:.6}
</style>
<h1>${esc(brandName)} <small>(${rows.filter((m) => m.status === 'pending').length} to review)</small></h1>
${rows.map(card).join('\n') || '<p>No designs yet.</p>'}`
  fs.mkdirSync(path.join(DESIGNS, brandName), { recursive: true })
  fs.writeFileSync(path.join(DESIGNS, brandName, 'index.html'), html)
  const brands = myBrands()
  fs.writeFileSync(path.join(DESIGNS, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Designs</title><style>body{font:16px system-ui;background:#1d2420;color:#e9eee7;padding:16px}a{color:#9fd18b}</style>
<h1>Designs</h1><ul>${brands.map((b) => `<li><a href="${esc(b)}/index.html">${esc(b)}</a> (${allDesigns(b).filter((m) => m.status === 'pending').length} to review)</li>`).join('')}</ul>`)
}

// ---------------------------------------------------------------------------------------------
// Printify: catalog, connect, publish, orders

function token() {
  const t = process.env.PRINTIFY_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '')
  if (!t) die('Printify isn\'t connected. The user runs: node printshop.mjs connect (it asks for their Printify API token).')
  return t
}

export async function printify(method, p, body, { tok = token(), fetchImpl = fetch } = {}) {
  let res
  try {
    res = await fetchImpl(API + p, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'PrintShop/1.0', 'Content-Type': 'application/json;charset=utf-8' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    die(`Couldn't reach Printify: ${err.message}`)
  }
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!res.ok) {
    const why = data?.message || data?.error || data?.errors?.reason || text.slice(0, 300)
    die(res.status === 401 ? 'Printify refused the token: the user should run connect again with a new one.' : `Printify said ${res.status}: ${typeof why === 'string' ? why : JSON.stringify(why)}`)
  }
  return data
}

async function cmdConnect(a) {
  fs.mkdirSync(HOME, { recursive: true })
  let tok = process.env.PRINTIFY_TOKEN || ''
  if (!tok) {
    console.log('1. Open https://printify.com/app/account/api (sign in to Printify).\n2. Click "Generate", name it Print Shop, tick every box, then Generate token.\n3. Copy the token and paste it here.')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    tok = (await rl.question('Token: ')).trim()
    rl.close()
  }
  if (tok.length < 20) die('That doesn\'t look like a Printify token.')
  const shops = await printify('GET', '/shops.json', null, { tok })
  fs.writeFileSync(TOKEN_FILE, tok + '\n', { mode: 0o600 })
  if (!Array.isArray(shops) || !shops.length) die('Connected, but this Printify account has no store yet. In Printify: Manage stores → Add new store (Shopify, Etsy, or the Printify Pop-Up Store), then run connect again.')
  for (const s of shops) console.log(`shop ${s.id}: ${s.title} (${s.sales_channel})`)
  const brands = a.brand ? [a.brand] : myBrands().filter((b) => b !== SKETCHBOOK)
  const shop = a.shop ? shops.find((s) => String(s.id) === String(a.shop)) : shops.length === 1 ? shops[0] : null
  if (!shop) return console.log('Several stores: run again with --shop <id> --brand <brand> to pick one.')
  for (const n of brands) {
    const b = loadBrand(n)
    b.printify = { ...(b.printify || {}), shopId: shop.id, shopTitle: shop.title, channel: shop.sales_channel }
    saveBrand(b)
    console.log(`${n} → ${shop.title}`)
  }
}

async function cmdCatalog(a) {
  const sub = a._[1]
  if (sub === 'search') {
    const words = a._.slice(2).join(' ').toLowerCase().split(/\s+/).filter(Boolean)
    const all = await printify('GET', '/catalog/blueprints.json')
    const hits = all.filter((b) => words.every((w) => `${b.title} ${b.brand} ${b.model}`.toLowerCase().includes(w))).slice(0, 25)
    for (const b of hits) console.log(`blueprint ${b.id}: ${b.title} (${b.brand} ${b.model})`)
    return console.log(hits.length ? '\nNext: catalog providers <blueprint>' : 'Nothing matched. Try fewer words.')
  }
  if (sub === 'providers') {
    const bp = a._[2] || die('usage: catalog providers <blueprint>')
    const ps = await printify('GET', `/catalog/blueprints/${bp}/print_providers.json`)
    for (const p of ps) console.log(`provider ${p.id}: ${p.title}${p.location?.country ? ` (${p.location.country})` : ''}`)
    return console.log('\nNext: catalog variants <blueprint> <provider>. Pick a provider in the same country as most buyers.')
  }
  if (sub === 'variants') {
    const [bp, pp] = [a._[2], a._[3]]
    if (!bp || !pp) die('usage: catalog variants <blueprint> <provider>')
    const { variants = [] } = await printify('GET', `/catalog/blueprints/${bp}/print_providers/${pp}/variants.json`)
    const opts = {}
    for (const v of variants) for (const [k, val] of Object.entries(v.options || {})) (opts[k] ||= new Set()).add(val)
    for (const [k, vals] of Object.entries(opts)) console.log(`${k}: ${[...vals].join(', ')}`)
    const ph = variants[0]?.placeholders || []
    console.log(`print areas: ${ph.map((x) => `${x.position} ${x.width}×${x.height}`).join(', ') || 'unknown'}\n${variants.length} variants`)
    return
  }
  die('usage: catalog search <words> | catalog providers <blueprint> | catalog variants <blueprint> <provider>')
}

async function cmdProduct(a) {
  if (a._[1] !== 'set') die('usage: product set <tee|mug|…> --blueprint N --provider N [--colors "Black,White"] [--sizes "S,M,L"] [--price 24.99] [--brand B]')
  const brand = loadBrand(a.brand)
  const kind = a._[2] || die('Which product? e.g. product set tee …')
  const cur = { ...(PRODUCT_PRESETS[kind] || { label: kind, width: 4500, height: 5400, transparent: true, mockup: 'poster', colors: [], sizes: [], price: 20 }), ...(brand.products[kind] || {}) }
  if (a.blueprint) cur.blueprint = Number(a.blueprint)
  if (a.provider) cur.provider = Number(a.provider)
  if (a.colors) cur.colors = list(a.colors)
  if (a.sizes) cur.sizes = list(a.sizes)
  if (a.price) cur.price = Number(a.price)
  if (cur.blueprint && cur.provider && (a.blueprint || a.provider)) {
    const { variants = [] } = await printify('GET', `/catalog/blueprints/${cur.blueprint}/print_providers/${cur.provider}/variants.json`)
    const front = variants[0]?.placeholders?.find((x) => x.position === 'front') || variants[0]?.placeholders?.[0]
    if (front) Object.assign(cur, { width: front.width, height: front.height, position: front.position })
    const picked = pickVariants(variants, cur)
    if (!picked.length) die(`None of that provider's variants match colors ${cur.colors.join('/')} and sizes ${cur.sizes.join('/')}. See: catalog variants ${cur.blueprint} ${cur.provider}`)
    console.log(`${picked.length} variants will be offered; print area ${cur.width}×${cur.height}`)
  }
  brand.products[kind] = cur
  saveBrand(brand)
  console.log(`${brand.name} ${kind}: blueprint ${cur.blueprint ?? '-'}, provider ${cur.provider ?? '-'}, $${cur.price}, colors ${cur.colors.join(', ') || '-'}, sizes ${cur.sizes.join(', ') || '-'}`)
}

/** The catalog variants matching the product's colours and sizes (where the variant has those options). */
export function pickVariants(variants, p, colors = p.colors) {
  const has = (vals, v) => !vals?.length || vals.some((x) => x.toLowerCase() === String(v).toLowerCase())
  return variants.filter((v) => {
    const o = v.options || {}
    return (o.color === undefined || has(colors, o.color)) && (o.size === undefined || has(p.sizes, o.size))
  })
}

export function productBody(meta, p, variants, imageId) {
  const ids = variants.map((v) => v.id)
  return {
    title: meta.title,
    description: meta.description || meta.title,
    tags: meta.tags || [],
    blueprint_id: p.blueprint,
    print_provider_id: p.provider,
    variants: ids.map((id) => ({ id, price: Math.round(Number(meta.price || p.price) * 100), is_enabled: true })),
    print_areas: [{ variant_ids: ids, placeholders: [{ position: p.position || 'front', images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] }],
  }
}

async function cmdPublish(a) {
  const id = a._[1] || die('usage: publish <design-id> [--live] [--by manager]')
  const { dir, meta, metaPath } = findDesign(id)
  const brand = loadBrand(meta.brand)
  const p = productOf(brand, meta.product)
  if (p.notForSale) die(`${id} is artwork, not a product. Make a product version first: retarget ${id} --product tee --brand <brand>`)
  if (!['approved', 'listed'].includes(meta.status)) die(`${id} is ${meta.status}. Only approved designs go to Printify.`)
  if (a.live && a.by === 'manager' && !autopilot(brand).publish) die(`autopilot.publish is off for '${brand.name}': the manager may only make Printify drafts.`)
  const shop = brand.printify?.shopId || die(`'${brand.name}' has no Printify store yet. The user runs: node printshop.mjs connect`)
  if (!p.blueprint || !p.provider) die(`Pick the Printify product for ${meta.product} first: catalog search …, then product set ${meta.product} --blueprint N --provider N`)
  if (meta.warnings?.some((w) => /empty|trademark/i.test(w))) die(`Fix the warnings first: ${meta.warnings.join(' / ')}`)
  if (!meta.printify?.productId) {
    const { variants = [] } = await printify('GET', `/catalog/blueprints/${p.blueprint}/print_providers/${p.provider}/variants.json`)
    const picked = pickVariants(variants, p, meta.colors?.length ? meta.colors : p.colors)
    if (!picked.length) die('No variants match the design\'s colours and the product\'s sizes.')
    const contents = fs.readFileSync(path.join(dir, 'print.png')).toString('base64')
    const img = await printify('POST', '/uploads/images.json', { file_name: `${meta.id}.png`, contents })
    const prod = await printify('POST', `/shops/${shop}/products.json`, productBody(meta, p, picked, img.id))
    meta.printify = { productId: prod.id, shopId: shop, imageId: img.id, variants: picked.length, at: now() }
    meta.status = 'listed'
    meta.history.push({ at: now(), event: 'listed', by: a.by || 'user' })
    writeJson(metaPath, meta)
    console.log(`Printify draft made: product ${prod.id} with ${picked.length} variants. Printify makes the product photos.`)
  }
  if (a.live) {
    await printify('POST', `/shops/${shop}/products/${meta.printify.productId}/publish.json`,
      { title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true })
    meta.status = 'published'
    meta.history.push({ at: now(), event: 'published', by: a.by || 'user' })
    writeJson(metaPath, meta)
    console.log(`Sent to the store (${brand.printify.shopTitle || shop}). It appears there in a minute or two.`)
  } else {
    console.log('It is a draft in Printify, not in the store yet. Add --live to put it in the store.')
  }
  writeReviewPage(meta.brand)
}

async function cmdOrders(a) {
  const brand = loadBrand(a.brand)
  const shop = brand.printify?.shopId || die(`'${brand.name}' has no Printify store yet.`)
  const res = await printify('GET', `/shops/${shop}/orders.json?limit=${Number(a.limit) || 20}`)
  const rows = res.data || res || []
  if (!rows.length) return console.log('No orders yet.')
  const trouble = /hold|cancel|fail|error|unfulfill/i
  for (const o of rows) {
    const total = (Number(o.total_price || 0) / 100).toFixed(2)
    console.log(`${trouble.test(o.status) ? '⚠' : ' '} ${String(o.created_at).slice(0, 10)}  ${o.status}  $${total}  ${o.line_items?.length || 0} item(s)  order ${o.id}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Status, reports, and handing designs to new agents in Agent Colony

function brandStatus(name) {
  const b = loadBrand(name)
  const ds = allDesigns(name)
  const by = (s) => ds.filter((m) => m.status === s).length
  return {
    brand: name, title: b.title, autopilot: autopilot(b), connected: !!b.printify?.shopId && (fs.existsSync(TOKEN_FILE) || !!process.env.PRINTIFY_TOKEN),
    pickedProducts: Object.entries(b.products).filter(([, p]) => p.blueprint && p.provider).map(([k]) => k),
    newIdeas: loadIdeas(name).filter((i) => i.status === 'new').length,
    pending: by('pending'), approved: by('approved'), listed: by('listed'), published: by('published'), rejected: by('rejected'),
    startedToday: ds.filter((m) => String(m.created).startsWith(today())).length,
  }
}

function cmdStatus(a) {
  const names = a.brand ? [a.brand] : myBrands()
  if (!names.length) return console.log('No brands yet: node printshop.mjs new-brand … (or /brand)')
  for (const n of names) {
    const s = brandStatus(n)
    console.log(`\n## ${n} (${s.title})\n  designs: ${s.pending} to review, ${s.approved} approved, ${s.listed} Printify drafts, ${s.published} live, ${s.rejected} rejected` +
      `\n  ideas waiting: ${s.newIdeas} · started today: ${s.startedToday} of ${s.autopilot.maxDesignsPerDay}` +
      `\n  autopilot: approve=${s.autopilot.approve ? 'on' : 'off'}, publish=${s.autopilot.publish ? 'on' : 'off'}` +
      `\n  printify: ${s.connected ? 'connected' : 'NOT connected (the user runs: node printshop.mjs connect)'}; products picked: ${s.pickedProducts.join(', ') || 'none yet'}`)
  }
}

function cmdReport(a) {
  const days = Number(a.days) || 1
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19)
  const lines = [`# Print Shop: last ${days === 1 ? 'day' : `${days} days`} (${today()})`, '']
  const needs = []
  for (const n of myBrands()) {
    const s = brandStatus(n)
    const recent = allDesigns(n).filter((m) => String(m.created) >= since)
    const events = allDesigns(n).flatMap((m) => (m.history || []).filter((h) => h.at >= since).map((h) => ({ ...h, m })))
    const count = (e) => events.filter((x) => x.event === e).length
    lines.push(`## ${n}`, `- New designs: ${recent.length}. Approved: ${count('approved')}. Rejected: ${count('rejected')}. To Printify: ${count('listed')}. Live: ${count('published')}.`,
      `- Now: ${s.pending} to review, ${s.approved} approved waiting, ${s.newIdeas} ideas waiting.`, '')
    if (s.pending && !s.autopilot.approve) needs.push(`${n}: ${s.pending} design(s) to review (Review designs page)`)
    if (n === SKETCHBOOK) continue
    if (!s.connected) needs.push(`${n}: connect Printify (node printshop.mjs connect)`)
    else if (!s.pickedProducts.length) needs.push(`${n}: no Printify product picked yet (ask an agent: /brand pick products for ${n})`)
  }
  lines.push('## Needs you', ...(needs.length ? needs.map((x) => `- ${x}`) : ['- Nothing.']))
  const text = lines.join('\n') + '\n'
  console.log(text)
  if (a.save) {
    fs.mkdirSync(REPORTS, { recursive: true })
    const file = path.join(REPORTS, `${today()}-${days}d.md`)
    fs.writeFileSync(file, text)
    console.log(`saved ${file}`)
  }
}

async function colony(method, p, body) {
  let res
  try {
    res = await fetch(COLONY + p, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-colony': '1' }, body: body ? JSON.stringify(body) : undefined })
  } catch {
    die(`Agent Colony isn't running at ${COLONY}. Start it, or do the design yourself.`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) die(`Agent Colony refused: ${data.error || res.status}`)
  return data
}

const samePath = (x, y) => {
  const norm = (s) => (process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s))
  return norm(x) === norm(y)
}
export function designAgents(state, repoDir = HERE) {
  const repo = (state.repos || []).find((r) => samePath(r.path, repoDir))
  return (repo?.threads || []).filter((t) => t.status === 'running' && /^\s*\/design\b/.test(t.title || ''))
}

async function cmdDispatch(a) {
  const id = a._[1] || die('usage: dispatch <idea-id> [--brand B]')
  const brand = loadBrand(a.brand)
  const ideas = loadIdeas(brand.name)
  const idea = ideas.find((i) => i.id === id) || die(`No idea '${id}' in ${brand.name}`)
  if (idea.status !== 'new') die(`${id} is already ${idea.status}.`)
  const busy = designAgents(await colony('GET', '/api/state')).length
  if (busy >= MAX_AGENTS) die(`All ${MAX_AGENTS} design agents are busy. Leave it for the next round.`)
  const res = await colony('POST', '/api/tasks', { repo: HERE, prompt: `/design ${id} ${brand.name}`, tool: 'claude-code', permissionMode: 'acceptEdits', worktree: true })
  idea.status = 'dispatched'
  idea.at = now()
  saveIdeas(brand.name, ideas)
  console.log(`dispatched: a new agent is designing ${id}${res.worktree?.branch ? ` (branch ${res.worktree.branch})` : ''}. ${busy + 1} of ${MAX_AGENTS} design agents working.`)
}

async function cmdDoctor() {
  console.log(`Print Shop home: ${HOME}`)
  let ok = true
  try {
    const r = await renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text x="5" y="30" font-size="24" font-family="Arial">Aa</text></svg>', 100, { withPixels: true })
    const inked = r.pixels.some((v, i) => i % 4 === 3 && v > 0)
    console.log(`renderer: OK${inked ? '' : ' (but no fonts found: text will not show. Put .ttf files in ' + FONTS + ')'}`)
  } catch (err) {
    ok = false
    console.log(`renderer: MISSING (${err.message}). Run npm install in ${HERE}`)
  }
  console.log(`brands: ${myBrands().join(', ') || 'none yet'}`)
  console.log(`printify: ${fs.existsSync(TOKEN_FILE) || process.env.PRINTIFY_TOKEN ? 'token saved' : 'not connected (node printshop.mjs connect)'}`)
  for (const d of [BRANDS, DESIGNS, REPORTS, FONTS]) fs.mkdirSync(d, { recursive: true })
  if (!ok) process.exitCode = 1
}

// ---------------------------------------------------------------------------------------------

const HELP = `Print Shop: node printshop.mjs <command>

  doctor                                 check the renderer, folders and Printify
  new-brand --name N --title T --niche … [--audience …] [--style …] [--products tee,hat,sticker,mug,pillow,canvas,…]
  brands                                 list brands and what they sell
  idea add --text "…" --why "…" [--product tee] [--brand B]
  ideas [--status new|all] [--brand B]   ·  idea skip <idea-id> --reason "…"
  dispatch <idea-id> [--brand B]         start a design agent for it in Agent Colony (max ${MAX_AGENTS} at once)
  design new --title "…" [--product tee|hat|pillow|canvas|art…] [--idea <idea-id>]   make design.svg to edit
  retarget <design-id> --product hat [--brand B]   a copy of a design for another product (sketchbook → merch)
  render <design-id> [--colors "Black,White"] [--reason "what changed"]   print file, mockups, checks
  meta <design-id> [--title] [--description] [--tags a,b] [--colors] [--price]
  queue [--status pending|approved|rejected|all] [--brand B]
  approve <design-id> [--note "why"] [--by manager]  ·  reject <design-id> --reason "…"
  feedback [--brand B]                   what the user liked and rejected, and why
  connect [--shop ID] [--brand B]        (the user) save a Printify API token and pick the store
  catalog search <words> | catalog providers <blueprint> | catalog variants <blueprint> <provider>
  product set <kind> --blueprint N --provider N [--colors] [--sizes] [--price]
  publish <design-id> [--live] [--by manager]   approved design → Printify draft (→ store with --live)
  orders [--brand B]                     recent orders and any with problems
  status [--brand B]  ·  report [--days 7] [--save]`

export async function main(argv) {
  const a = parseArgs(argv)
  const cmd = a._[0]
  const table = {
    doctor: cmdDoctor, 'new-brand': cmdNewBrand, brands: cmdBrands, idea: cmdIdea, ideas: cmdIdeas, dispatch: cmdDispatch,
    design: cmdDesign, render: cmdRender, meta: cmdMeta, queue: cmdQueue, feedback: cmdFeedback,
    approve: (x) => setStatus(x._[1] || die('usage: approve <design-id>'), 'approved', { note: x.note || '', by: x.by || '' }),
    reject: (x) => setStatus(x._[1] || die('usage: reject <design-id> --reason "…"'), 'rejected', { reason: x.reason || die('Say why: --reason "…" (the agents learn from it)') }),
    retarget: cmdRetarget, connect: cmdConnect, catalog: cmdCatalog, product: cmdProduct, publish: cmdPublish, orders: cmdOrders,
    status: cmdStatus, report: cmdReport,
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
