// The ground, the scattered rocks, and the landing ship in the middle.
import * as THREE from 'three'
import { M, mesh, cyl, box, rng, hexToWorld, inHex, HEX_R } from './kit.js'

export const SAND = new THREE.Color('#e9c7a2')

function noise(x, z) {
  return (
    Math.sin(x * 0.045) * Math.cos(z * 0.05) * 0.9 +
    Math.sin(x * 0.13 + 1.7) * Math.sin(z * 0.11 + 0.3) * 0.35 +
    Math.sin(x * 0.31 + z * 0.27) * 0.12
  )
}

export function createGround(scene) {
  const size = 900
  const geo = new THREE.PlaneGeometry(size, size, 180, 180)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors = []
  const a = new THREE.Color('#f0d2b0')
  const b = new THREE.Color('#d9a881')
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const d = Math.hypot(x, z)
    // Flat in the middle where the colony is, rolling dunes further out.
    const amp = THREE.MathUtils.smoothstep(d, 40, 160)
    const y = noise(x, z) * (0.25 + amp * 3.5) - 0.15
    pos.setY(i, y)
    c.copy(a).lerp(b, THREE.MathUtils.clamp(0.5 + noise(x * 2.3, z * 2.1) * 0.35, 0, 1))
    colors.push(c.r, c.g, c.b)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  const ground = mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: false }), { cast: false })
  ground.name = 'ground'
  scene.add(ground)
  return ground
}

/** Boulders and pebbles, kept off the plots. Rebuilt when the colony's footprint changes. */
export class Rocks {
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
    this.group.clear()
    const centres = [[0, 0], ...tiles].map(([q, r]) => hexToWorld(q, r))
    const blocked = (x, z, pad) => centres.some((p) => inHex(x - p.x, z - p.z, HEX_R + pad)) || Math.hypot(x, z) < 9
    const rand = rng(7)
    const geo = new THREE.IcosahedronGeometry(1, 0)
    const make = (count, minR, maxR, scaleMin, scaleMax, material, pad) => {
      const inst = new THREE.InstancedMesh(geo, material, count)
      inst.castShadow = true
      inst.receiveShadow = true
      const m = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const e = new THREE.Euler()
      let n = 0
      for (let tries = 0; n < count && tries < count * 20; tries++) {
        const ang = rand() * Math.PI * 2
        const rad = minR + Math.sqrt(rand()) * (maxR - minR)
        const x = Math.cos(ang) * rad
        const z = Math.sin(ang) * rad
        if (blocked(x, z, pad)) continue
        const s = scaleMin + Math.pow(rand(), 2.5) * (scaleMax - scaleMin)
        e.set(rand() * 3, rand() * 3, rand() * 3)
        q.setFromEuler(e)
        m.compose(new THREE.Vector3(x, s * 0.35 + noise(x, z) * 0.3 - 0.1, z), q, new THREE.Vector3(s, s * (0.6 + rand() * 0.5), s * (0.8 + rand() * 0.4)))
        inst.setMatrixAt(n++, m)
      }
      inst.count = n
      this.group.add(inst)
    }
    make(420, 10, 260, 0.5, 3.4, M.rock, 2.5)
    make(140, 10, 60, 0.4, 1.4, M.rock, 1.5)
    make(1100, 8, 170, 0.1, 0.45, M.rockDark, 0.8)
  }
}

/** The ship: where new threads walk out from and archived ones walk back into. */
export function createShip(scene) {
  const g = new THREE.Group()
  // Landing pad
  const pad = mesh(new THREE.CylinderGeometry(5.9, 6.2, 0.25, 40), new THREE.MeshStandardMaterial({ color: '#d9b18e', roughness: 1 }), { cast: false })
  pad.position.y = 0.05
  g.add(pad)
  const ring = mesh(new THREE.TorusGeometry(5.2, 0.08, 6, 60), M.white, { cast: false })
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.2
  g.add(ring)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const light = mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshStandardMaterial({ color: '#ffb35c', emissive: '#ff8a2a', emissiveIntensity: 1.2 }))
    light.position.set(Math.cos(a) * 5.65, 0.22, Math.sin(a) * 5.65)
    g.add(light)
  }

  // Hull: a fat white egg with a red nose, on four legs
  const hull = mesh(new THREE.SphereGeometry(2.6, 20, 14), M.white)
  hull.scale.set(1, 1.08, 1)
  hull.position.y = 4.1
  g.add(hull)
  const nose = mesh(new THREE.SphereGeometry(1.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.red)
  nose.position.y = 6.45
  nose.scale.set(1, 0.7, 1)
  g.add(nose)
  const belt = mesh(new THREE.CylinderGeometry(2.62, 2.62, 0.35, 24, 1, true), M.band)
  belt.position.y = 3.9
  g.add(belt)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3
    const win = mesh(new THREE.SphereGeometry(0.26, 10, 8), M.glass)
    win.position.set(Math.cos(a) * 2.5, 4.9, Math.sin(a) * 2.5)
    g.add(win)
  }
  const skirt = cyl(1.8, 2.3, 1.2, 16, M.shell, 0, 1.7)
  g.add(skirt)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const leg = mesh(new THREE.CylinderGeometry(0.13, 0.13, 3.6, 6), M.metal)
    leg.position.set(Math.cos(a) * 2.5, 1.7, Math.sin(a) * 2.5)
    leg.rotation.z = Math.cos(a) * 0.35
    leg.rotation.x = -Math.sin(a) * 0.35
    g.add(leg)
    const foot = cyl(0.55, 0.65, 0.18, 12, M.white, Math.cos(a) * 3.1, 0.15, Math.sin(a) * 3.1)
    g.add(foot)
  }
  // Ramp down towards +z, where the bots come and go
  const ramp = box(1.4, 0.12, 3.6, M.shell)
  ramp.position.set(0, 1.05, 3.3)
  ramp.rotation.x = 0.5
  g.add(ramp)
  const door = mesh(new THREE.CircleGeometry(0.75, 20), M.dark)
  door.position.set(0, 2.15, 2.02)
  g.add(door)
  // Antenna
  g.add(cyl(0.05, 0.05, 1.4, 6, M.metal, 1.2, 6.2, 0))
  const tip = mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshStandardMaterial({ color: '#ff5b5b', emissive: '#ff2a2a', emissiveIntensity: 2 }))
  tip.position.set(1.2, 7.65, 0)
  g.add(tip)
  g.userData.beacon = tip
  scene.add(g)
  return g
}

/** Where a bot steps off the ramp. */
export const SHIP_DOOR = new THREE.Vector3(0, 0, 5.2)
