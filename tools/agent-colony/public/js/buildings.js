// One building per thread. How finished it looks follows the size of the transcript.
import * as THREE from 'three'
import { M, mesh, box, cyl, rng, hashString } from './kit.js'

const KINDS = ['hab', 'dome', 'tower', 'depot', 'solar', 'lab', 'hab', 'dome']

export function kindFor(id) {
  return KINDS[hashString(id) % KINDS.length]
}

/** Add `obj` so it appears once completion passes `at`. */
function stage(group, obj, at) {
  obj.userData.at = at
  group.add(obj)
  return obj
}

function roofKit(g, y, rand, at) {
  const pick = rand()
  if (pick < 0.4) {
    // Two blue solar panels
    for (const s of [-1, 1]) {
      const p = box(0.9, 0.08, 0.7, M.panel, s * 0.5, y + 0.25, 0)
      p.rotation.z = s * 0.35
      stage(g, p, at)
      stage(g, box(0.1, 0.25, 0.1, M.metal, s * 0.5, y, 0), at)
    }
  } else if (pick < 0.7) {
    // Stacked coloured modules
    stage(g, box(0.55, 0.45, 0.55, M.green, -0.3, y, 0.1), at)
    stage(g, box(0.5, 0.4, 0.5, M.red, 0.35, y, -0.15), at)
    stage(g, box(0.4, 0.35, 0.4, M.teal, 0.05, y + 0.45, 0), at + 0.1)
  } else {
    // Dish
    stage(g, cyl(0.06, 0.06, 0.6, 6, M.metal, 0, y), at)
    const dish = mesh(new THREE.SphereGeometry(0.55, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), M.white)
    dish.rotation.x = Math.PI * 0.85
    dish.position.set(0, y + 0.85, 0)
    stage(g, dish, at + 0.05)
  }
}

function build(kind, rand) {
  const g = new THREE.Group()
  let radius = 1.45
  let height = 2

  if (kind === 'hab') {
    stage(g, cyl(1.45, 1.5, 0.3, 8, M.shell), 0)
    stage(g, cyl(1.3, 1.35, 1.2, 8, M.white, 0, 0.3), 0.15)
    stage(g, cyl(1.34, 1.34, 0.22, 8, M.band, 0, 0.75), 0.3)
    stage(g, cyl(1.1, 1.3, 0.35, 8, M.shell, 0, 1.5), 0.45)
    stage(g, box(0.5, 0.7, 0.2, M.dark, 0, 0.3, 1.25), 0.3)
    roofKit(g, 1.85, rand, 0.65)
    height = 2.6
  } else if (kind === 'dome') {
    stage(g, cyl(1.5, 1.55, 0.3, 8, M.shell), 0)
    stage(g, cyl(1.35, 1.4, 0.9, 8, M.white, 0, 0.3), 0.15)
    stage(g, cyl(1.38, 1.38, 0.2, 8, M.band, 0, 0.7), 0.35)
    const dome = mesh(new THREE.SphereGeometry(1.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.copper)
    dome.position.y = 1.2
    stage(g, dome, 0.5)
    stage(g, cyl(0.25, 0.3, 0.25, 8, M.white, 0, 2.35), 0.8)
    stage(g, box(0.5, 0.65, 0.2, M.dark, 0, 0.3, 1.3), 0.3)
    height = 2.7
  } else if (kind === 'tower') {
    // The red-legged water tower
    stage(g, cyl(1.2, 1.3, 0.2, 6, M.shell), 0)
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const leg = box(0.18, 2.2, 0.18, M.red, Math.cos(a) * 0.85, 0.2, Math.sin(a) * 0.85)
      stage(g, leg, 0.1 + i * 0.05)
    }
    stage(g, box(1.9, 0.12, 0.12, M.redDark, 0, 1.1, 0.85), 0.35)
    stage(g, box(1.9, 0.12, 0.12, M.redDark, 0, 1.1, -0.85), 0.35)
    stage(g, cyl(1.05, 1.05, 1.1, 6, M.shell, 0, 2.3), 0.5)
    stage(g, cyl(1.08, 1.08, 0.18, 6, M.band, 0, 2.75), 0.6)
    stage(g, cyl(0.6, 1.05, 0.35, 6, M.white, 0, 3.4), 0.7)
    roofKit(g, 3.75, rand, 0.85)
    radius = 1.3
    height = 4.4
  } else if (kind === 'depot') {
    stage(g, box(2.7, 0.2, 2.2, M.shell), 0)
    const rows = 3
    for (let i = 0; i < rows * 3; i++) {
      const x = (i % 3 - 1) * 0.72
      const z = (Math.floor(i / 3) - 1) * 0.62
      stage(g, box(0.62, 0.5, 0.52, rand() < 0.75 ? M.red : M.white, x, 0.2, z), 0.1 + i * 0.05)
      if (rand() < 0.55) stage(g, box(0.62, 0.5, 0.52, rand() < 0.6 ? M.red : M.white, x, 0.7, z), 0.55 + i * 0.04)
    }
    stage(g, box(0.25, 1.9, 0.25, M.metal, 1.25, 0.2, -1), 0.3)
    stage(g, box(1.4, 0.15, 0.15, M.orange, 0.7, 2.0, -1), 0.6)
    radius = 1.6
    height = 2.2
  } else if (kind === 'solar') {
    stage(g, box(2.8, 0.15, 2.4, M.shell), 0)
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 2; col++) {
        const at = 0.1 + (row * 2 + col) * 0.13
        stage(g, box(0.1, 0.55, 0.1, M.metal, (col - 0.5) * 1.3, 0.15, (row - 1) * 0.75), at)
        const p = box(1.2, 0.06, 0.6, M.panel, (col - 0.5) * 1.3, 0.7, (row - 1) * 0.75)
        p.rotation.x = -0.45
        stage(g, p, at + 0.05)
      }
    }
    radius = 1.6
    height = 1.4
  } else {
    // Lab: two stacked octagons with a glass band and an antenna
    stage(g, cyl(1.5, 1.55, 0.3, 8, M.shell), 0)
    stage(g, cyl(1.3, 1.35, 1.0, 8, M.white, 0, 0.3), 0.15)
    stage(g, cyl(1.32, 1.32, 0.25, 8, M.glass, 0, 0.95), 0.3)
    stage(g, cyl(1.0, 1.25, 0.9, 8, M.white, 0, 1.3), 0.45)
    stage(g, cyl(1.02, 1.02, 0.16, 8, M.bandDark, 0, 1.75), 0.55)
    stage(g, cyl(0.05, 0.05, 1.4, 5, M.metal, 0.5, 2.2), 0.75)
    const tip = mesh(new THREE.SphereGeometry(0.1, 6, 5), new THREE.MeshStandardMaterial({ color: '#ff6b6b', emissive: '#ff3030', emissiveIntensity: 1.5 }))
    tip.position.set(0.5, 3.65, 0)
    stage(g, tip, 0.85)
    stage(g, box(0.5, 0.65, 0.2, M.dark, 0, 0.3, 1.28), 0.3)
    roofKit(g, 2.2, rand, 0.7)
    height = 3.4
  }
  return { group: g, radius, height }
}

function scaffolding(radius, height) {
  const g = new THREE.Group()
  const r = radius + 0.25
  const h = height + 0.3
  const poles = 6
  for (let i = 0; i < poles; i++) {
    const a = (i / poles) * Math.PI * 2
    g.add(cyl(0.05, 0.05, h, 4, M.scaffold, Math.cos(a) * r, 0, Math.sin(a) * r))
  }
  for (let y = 0.8; y < h; y += 0.9) {
    const ring = mesh(new THREE.TorusGeometry(r, 0.04, 4, poles), M.scaffold, { receive: false })
    ring.rotation.x = Math.PI / 2
    ring.rotation.z = Math.PI / poles
    ring.position.y = y
    g.add(ring)
  }
  const plank = box(r * 1.4, 0.06, 0.4, M.sandDark, 0, h * 0.55, r - 0.1)
  g.add(plank)
  return g
}

export class Building {
  constructor(thread) {
    this.id = thread.id
    this.kind = kindFor(thread.id)
    const { group, radius, height } = build(this.kind, rng(thread.id))
    this.group = new THREE.Group()
    this.body = group
    this.group.add(group)
    this.radius = radius
    this.height = height
    this.scaffold = scaffolding(radius, height)
    this.scaffold.visible = false
    this.group.add(this.scaffold)
    this.group.rotation.y = (hashString(thread.id) % 6) * (Math.PI / 3)
    this.pct = -1
    this.shown = 0
    this.group.traverse((o) => { o.userData.threadId = thread.id; o.userData.pickable = 'building' })
    this.spawn = 0 // grows in on arrival
  }

  update(thread) {
    this.pct = thread.pct
    this.scaffold.visible = thread.status === 'running'
  }

  tick(dt) {
    // Ease towards the target completion so growth is visible rather than a jump.
    this.shown += (this.pct - this.shown) * Math.min(1, dt * 1.5)
    this.spawn = Math.min(1, this.spawn + dt * 1.2)
    for (const part of this.body.children) {
      const at = part.userData.at || 0
      const on = this.shown >= at
      part.visible = on
      if (on) {
        const grow = THREE.MathUtils.clamp((this.shown - at) / 0.08, 0.05, 1)
        part.scale.y = grow
      }
    }
    const s = 0.4 + 0.6 * easeOutBack(this.spawn)
    this.body.scale.set(s, s, s)
  }
}

function easeOutBack(t) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}
