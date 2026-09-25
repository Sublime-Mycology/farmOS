// The woods: a flat forest floor, trees and rocks kept off the plots, and the log cabin in the
// middle where new agents come out and archived ones go home.
import * as THREE from 'three'
import { M, mesh, cyl, box, rng, hexToWorld, inHex, HEX_R } from './kit.js'

export const FOG = new THREE.Color('#b9c9b0')

/** A plain disc of forest floor with a little colour variation. No terrain, no dunes. */
export function createGround(scene) {
  const geo = new THREE.CircleGeometry(600, 96, 0, Math.PI * 2)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors = []
  const a = new THREE.Color('#6f8f4e')
  const b = new THREE.Color('#556f3c')
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const n = Math.sin(x * 0.07) * Math.cos(z * 0.06) * 0.5 + Math.sin(x * 0.19 + z * 0.13) * 0.25 + 0.5
    c.copy(a).lerp(b, THREE.MathUtils.clamp(n, 0, 1))
    colors.push(c.r, c.g, c.b)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const ground = mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), { cast: false })
  ground.name = 'ground'
  scene.add(ground)

  // A worn dirt clearing round the cabin
  const clearing = mesh(new THREE.CircleGeometry(6.1, 40), new THREE.MeshStandardMaterial({ color: '#8a6a47', roughness: 1 }), { cast: false })
  clearing.rotation.x = -Math.PI / 2
  clearing.position.y = 0.02
  scene.add(clearing)
  return ground
}

// Shared tree parts, merged into instanced meshes so a whole forest is a handful of draw calls.
const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true })
const PINE_DARK = mat('#2f5a3a')
const PINE_LIGHT = mat('#3f7045')
const LEAF = mat('#5f8f3e')
const LEAF_AUTUMN = mat('#c98b3a')
const TRUNK = mat('#6b4a32')
const MOSS_ROCK = mat('#7d8479')
const CAP = mat('#c9503f')
const STEM = mat('#efe6d2')

/** Trees, rocks and mushrooms, kept off the plots. Rebuilt when the colony's footprint changes. */
export class Woods {
  constructor(scene) {
    this.scene = scene
    this.group = new THREE.Group()
    scene.add(this.group)
    this.signature = ''
  }

  update(tiles) {
    const sig = tiles.map((t) => t.join(',')).sort().join(';')
    if (sig === this.signature) return
    this.signature = sig
    for (const child of this.group.children) child.dispose?.()
    this.group.clear()

    const centres = [[0, 0], ...tiles].map(([q, r]) => hexToWorld(q, r))
    const blocked = (x, z, pad) => centres.some((p) => inHex(x - p.x, z - p.z, HEX_R + pad))
    let reach = HEX_R
    for (const p of centres) reach = Math.max(reach, p.length() + HEX_R)
    const rand = rng(11)

    // Scatter `count` things in a ring outside the colony, denser near its edge.
    const scatter = (count, pad, minR, maxR) => {
      const out = []
      for (let tries = 0; out.length < count && tries < count * 30; tries++) {
        const ang = rand() * Math.PI * 2
        const rad = minR + Math.pow(rand(), 1.6) * (maxR - minR)
        const x = Math.cos(ang) * rad
        const z = Math.sin(ang) * rad
        if (!blocked(x, z, pad)) out.push([x, z, 0.7 + rand() * 0.7, rand() * Math.PI * 2])
      }
      return out
    }

    const instanced = (geo, material, spots, place) => {
      const inst = new THREE.InstancedMesh(geo, material, spots.length)
      inst.castShadow = true
      inst.receiveShadow = true
      const m = new THREE.Matrix4()
      spots.forEach((s, i) => inst.setMatrixAt(i, place(m, ...s)))
      this.group.add(inst)
    }
    const at = (m, x, y, z, s, sy, rot) =>
      m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(s, sy, s))

    // Pines: trunk plus three stacked cones
    const pines = scatter(420, 3, reach * 0.6, reach + 110)
    const cone = new THREE.ConeGeometry(1.6, 2.6, 7)
    instanced(new THREE.CylinderGeometry(0.22, 0.3, 1.6, 6), TRUNK, pines, (m, x, z, s, r) => at(m, x, 0.8 * s, z, s, s, r))
    instanced(cone, PINE_DARK, pines, (m, x, z, s, r) => at(m, x, 2.4 * s, z, s, s, r))
    instanced(cone, PINE_LIGHT, pines, (m, x, z, s, r) => at(m, x, 3.6 * s, z, s * 0.78, s * 0.85, r + 0.4))
    instanced(cone, PINE_DARK, pines, (m, x, z, s, r) => at(m, x, 4.7 * s, z, s * 0.52, s * 0.7, r + 0.8))

    // Round leafy trees, a few turning
    const oaks = scatter(140, 3.4, reach * 0.6, reach + 70)
    const blob = new THREE.IcosahedronGeometry(1.5, 0)
    instanced(new THREE.CylinderGeometry(0.25, 0.32, 2, 6), TRUNK, oaks, (m, x, z, s, r) => at(m, x, 1 * s, z, s, s, r))
    const green = oaks.filter((_, i) => i % 5)
    const autumn = oaks.filter((_, i) => !(i % 5))
    instanced(blob, LEAF, green, (m, x, z, s, r) => at(m, x, 2.8 * s, z, s, s * 0.9, r))
    instanced(blob, LEAF_AUTUMN, autumn, (m, x, z, s, r) => at(m, x, 2.8 * s, z, s, s * 0.9, r))

    // Mossy rocks
    const rocks = scatter(90, 1, 8, reach + 60)
    instanced(new THREE.DodecahedronGeometry(0.7, 0), MOSS_ROCK, rocks, (m, x, z, s, r) => at(m, x, 0.2 * s, z, s, s * 0.6, r))

    // Red-capped mushrooms in little clumps near the plots
    const shrooms = scatter(160, 0.6, 6, reach + 14)
    instanced(new THREE.CylinderGeometry(0.06, 0.08, 0.3, 6), STEM, shrooms, (m, x, z, s, r) => at(m, x, 0.15 * s, z, s, s, r))
    instanced(new THREE.SphereGeometry(0.2, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), CAP, shrooms, (m, x, z, s, r) => at(m, x, 0.28 * s, z, s, s * 0.8, r))
  }
}

/** The log cabin: where new threads walk out from and archived ones walk back into. */
export function createCabin(scene) {
  const g = new THREE.Group()
  const log = mat('#8a5a36')
  const logDark = mat('#6e4527')
  const roof = mat('#4a3a33')
  const stone = mat('#8d8a82')

  // Walls of stacked logs
  const W = 5.2
  const D = 4.2
  for (let i = 0; i < 6; i++) {
    const y = 0.25 + i * 0.42
    const m = i % 2 ? log : logDark
    for (const s of [-1, 1]) {
      const front = mesh(new THREE.CylinderGeometry(0.22, 0.22, W + 0.5, 7), m)
      front.rotation.z = Math.PI / 2
      front.position.set(0, y, s * D / 2)
      g.add(front)
      const side = mesh(new THREE.CylinderGeometry(0.22, 0.22, D + 0.5, 7), m)
      side.rotation.x = Math.PI / 2
      side.position.set(s * W / 2, y + 0.21, 0)
      g.add(side)
    }
  }
  g.add(box(W - 0.2, 2.6, D - 0.2, logDark, 0, 0, 0))

  // A-frame roof: two slabs
  for (const s of [-1, 1]) {
    const slab = box(W + 1.2, 0.2, D / 2 + 1.1, roof)
    slab.position.set(0, 3.55, s * (D / 4 + 0.35))
    slab.rotation.x = s * 0.62
    g.add(slab)
  }
  // Gable ends
  const gable = new THREE.Shape()
  gable.moveTo(-D / 2 - 0.1, 0)
  gable.lineTo(D / 2 + 0.1, 0)
  gable.lineTo(0, 1.55)
  gable.lineTo(-D / 2 - 0.1, 0)
  const gGeo = new THREE.ExtrudeGeometry(gable, { depth: 0.2, bevelEnabled: false })
  for (const s of [-1, 1]) {
    const e = mesh(gGeo, log)
    e.rotation.y = Math.PI / 2
    e.position.set(s * (W / 2 - 0.1) - 0.1, 2.7, 0)
    g.add(e)
  }
  // Chimney
  g.add(box(0.8, 3.2, 0.8, stone, 1.6, 1.8, -0.9))

  // Door, windows, porch facing +z
  const door = box(1.1, 1.9, 0.1, mat('#5a3a22'), 0, 0.1, D / 2 + 0.25)
  g.add(door)
  for (const s of [-1, 1]) {
    const win = box(0.9, 0.8, 0.08, new THREE.MeshStandardMaterial({ color: '#ffd98a', emissive: '#ffb347', emissiveIntensity: 0.9 }), s * 1.6, 1.1, D / 2 + 0.24)
    g.add(win)
  }
  const porch = box(W, 0.18, 1.6, logDark, 0, 0, D / 2 + 0.9)
  g.add(porch)
  for (const s of [-1, 1]) g.add(cyl(0.12, 0.12, 2.4, 6, log, s * (W / 2 - 0.2), 0.1, D / 2 + 1.55))
  const awning = box(W + 0.2, 0.14, 1.9, roof, 0, 2.45, D / 2 + 0.9)
  awning.rotation.x = 0.15
  g.add(awning)

  // A lantern by the door: the thing that glows
  const lantern = mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshStandardMaterial({ color: '#ffe3a1', emissive: '#ffae3a', emissiveIntensity: 1.5 }))
  lantern.position.set(0.95, 2.0, D / 2 + 0.45)
  g.add(lantern)
  g.userData.beacon = lantern

  // Woodpile
  for (let i = 0; i < 5; i++) {
    const l = mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.2, 6), i % 2 ? log : logDark)
    l.rotation.x = Math.PI / 2
    l.position.set(-W / 2 - 0.6 + (i % 3) * 0.34, 0.18 + Math.floor(i / 3) * 0.3, -0.6)
    g.add(l)
  }
  scene.add(g)
  return g
}

/** Where a bot steps off the porch. */
export const SHIP_DOOR = new THREE.Vector3(0, 0, 4.4)
