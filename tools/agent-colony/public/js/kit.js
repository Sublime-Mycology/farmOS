// Shared materials, constants and small helpers for the low-poly kit.
import * as THREE from 'three'

export const HEX_R = 6.6          // tile circumradius
export const DECK_H = 0.45      // deck slab height; everything on a plot stands on this
export const DECK_TOP = DECK_H + 0.02
export const SLOT_RING = 3.75    // distance of the six outer building slots from a tile's centre
export const SLOTS_PER_TILE = 7

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true, ...extra })

export const M = {
  white: mat('#e9efff'),
  shell: mat('#cfdcff'),
  band: mat('#7f9cf5'),
  bandDark: mat('#4b64c9'),
  copper: mat('#c8744c', { roughness: 0.55 }),
  red: mat('#e0474c'),
  redDark: mat('#b8343a'),
  orange: mat('#e98a4a'),
  panel: mat('#1f33b8', { roughness: 0.3, metalness: 0.4, emissive: '#0a1466', emissiveIntensity: 0.4 }),
  glass: mat('#8fd8ff', { roughness: 0.2, emissive: '#2a6c9a', emissiveIntensity: 0.5 }),
  green: mat('#4cc98f'),
  teal: mat('#3fb8c9'),
  dark: mat('#383c4a'),
  metal: mat('#9aa3b8', { metalness: 0.5, roughness: 0.4 }),
  scaffold: mat('#f0b24a'),
  sandDark: mat('#b98a66'),
  rock: mat('#6b4a3a'),
  rockDark: mat('#4a3228'),
  deckSide: mat('#6e4a2c'),
  visor: mat('#141722', { roughness: 0.15, metalness: 0.6 }),
}

export function hexToWorld(q, r) {
  return new THREE.Vector3(HEX_R * Math.sqrt(3) * (q + r / 2), 0, HEX_R * 1.5 * r)
}

/** Local offset of a building slot inside a tile. Slot 0 is the middle. */
export function slotOffset(i) {
  if (i === 0) return new THREE.Vector3(0, 0, 0)
  const a = (Math.PI / 3) * (i - 1) + Math.PI / 6
  return new THREE.Vector3(Math.sin(a) * SLOT_RING, 0, Math.cos(a) * SLOT_RING)
}

/** Deterministic hash → [0,1) generator, so a thread always gets the same building. */
export function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function rng(seed) {
  let s = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function mesh(geo, material, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, material)
  m.castShadow = cast
  m.receiveShadow = receive
  return m
}

export function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = mesh(new THREE.BoxGeometry(w, h, d), material)
  m.position.set(x, y + h / 2, z)
  return m
}

export function cyl(rTop, rBot, h, seg, material, x = 0, y = 0, z = 0) {
  const m = mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), material)
  m.position.set(x, y + h / 2, z)
  return m
}

/** Point in the unit hex (pointy-top, circumradius 1) test. */
export function inHex(x, z, r) {
  const ax = Math.abs(x) / r
  const az = Math.abs(z) / r
  return az <= 1 && ax <= Math.sqrt(3) / 2 && az <= 1 - ax / Math.sqrt(3)
}

/** A canvas-drawn sprite: bubbles over bots. */
const spriteCache = new Map()
export function badgeTexture(symbol, color) {
  const k = symbol + color
  if (spriteCache.has(k)) return spriteCache.get(k)
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  g.fillStyle = 'rgba(0,0,0,0.18)'
  g.beginPath(); g.arc(64, 68, 50, 0, Math.PI * 2); g.fill()
  g.fillStyle = '#ffffff'
  g.beginPath(); g.arc(64, 62, 48, 0, Math.PI * 2); g.fill()
  g.beginPath(); g.moveTo(52, 104); g.lineTo(64, 122); g.lineTo(76, 104); g.fill()
  g.fillStyle = color
  g.font = 'bold 68px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(symbol, 64, 66)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  spriteCache.set(k, tex)
  return tex
}
