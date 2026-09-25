// The crew. One bot per thread, plus a smaller one per subagent errand.
// Behaviour is a strict precedence on the thread's status, so a bot only ever does one thing.
import * as THREE from 'three'
import { M, mesh, rng, badgeTexture, inHex, HEX_R, DECK_TOP } from './kit.js'
import { SHIP_DOOR } from './world.js'

const EYE = {
  running: '#7dffb2',
  waiting: '#ffd35c',
  error: '#ff4d4d',
  idle: '#8fe8ff',
  sleeping: '#8fe8ff',
}
const WALK_SPEED = 2.2
const BOT_RADIUS = 0.3

const eyeMats = new Map()
function eyeMat(color) {
  if (!eyeMats.has(color)) eyeMats.set(color, new THREE.MeshBasicMaterial({ color }))
  return eyeMats.get(color)
}
const packMats = {}
function packMat(color) {
  if (!packMats[color]) packMats[color] = new THREE.MeshStandardMaterial({ color, roughness: 0.6, flatShading: true })
  return packMats[color]
}

function makeRig(accent, small) {
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)

  const legGeo = new THREE.CylinderGeometry(0.085, 0.075, 0.32, 6)
  legGeo.translate(0, -0.16, 0)
  const legL = mesh(legGeo, M.white)
  const legR = mesh(legGeo, M.white)
  legL.position.set(-0.11, 0.33, 0)
  legR.position.set(0.11, 0.33, 0)
  body.add(legL, legR)

  const torso = mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.4, 8), M.white)
  torso.position.y = 0.52
  body.add(torso)
  const belt = mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.06, 8), M.band)
  belt.position.y = 0.38
  body.add(belt)
  const pack = mesh(new THREE.BoxGeometry(0.34, 0.36, 0.16), packMat(accent))
  pack.position.set(0, 0.56, -0.24)
  body.add(pack)

  const armGeo = new THREE.CylinderGeometry(0.06, 0.055, 0.32, 6)
  armGeo.translate(0, -0.16, 0)
  const armL = mesh(armGeo, M.white)
  const armR = mesh(armGeo, M.white)
  armL.position.set(-0.27, 0.68, 0)
  armR.position.set(0.27, 0.68, 0)
  armL.rotation.z = 0.2
  armR.rotation.z = -0.2
  body.add(armL, armR)
  // A little hammer in the right hand, shown while working
  const hammer = new THREE.Group()
  const handle = mesh(new THREE.BoxGeometry(0.04, 0.26, 0.04), M.sandDark)
  handle.position.y = -0.3
  const headH = mesh(new THREE.BoxGeometry(0.16, 0.08, 0.08), M.metal)
  headH.position.y = -0.42
  hammer.add(handle, headH)
  hammer.rotation.x = Math.PI / 2
  armR.add(hammer)

  const head = new THREE.Group()
  head.position.y = 0.98
  body.add(head)
  const helmet = mesh(new THREE.SphereGeometry(0.3, 14, 10), M.white)
  head.add(helmet)
  const visor = mesh(new THREE.SphereGeometry(0.24, 14, 10, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.22, Math.PI * 0.5), M.visor, { cast: false })
  visor.position.z = 0.1
  head.add(visor)
  const eyeGeo = new THREE.BoxGeometry(0.06, 0.08, 0.02)
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat(EYE.idle))
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat(EYE.idle))
  eyeL.position.set(-0.07, 0.02, 0.33)
  eyeR.position.set(0.07, 0.02, 0.33)
  head.add(eyeL, eyeR)
  const antenna = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 4), M.metal)
  antenna.position.set(0.14, 0.32, 0)
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), eyeMat(accent))
  bulb.position.set(0.14, 0.44, 0)
  head.add(antenna, bulb)

  const s = small ? 0.68 : 0.95
  root.scale.set(s, s, s)
  return { root, body, legL, legR, armL, armR, head, eyeL, eyeR, hammer }
}

// ---------------------------------------------------------------------------------------------
// Sparks, shared by every hammering bot

export class Sparks {
  constructor(scene, max = 400) {
    this.max = max
    this.pos = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3)
    this.life = new Float32Array(max)
    this.next = 0
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#ffcf6b', size: 0.14, transparent: true, depthWrite: false }))
    this.points.frustumCulled = false
    scene.add(this.points)
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -100
  }

  burst(p, n = 6) {
    for (let k = 0; k < n; k++) {
      const i = this.next
      this.next = (this.next + 1) % this.max
      this.pos.set([p.x, p.y, p.z], i * 3)
      this.vel.set([(Math.random() - 0.5) * 3, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 3], i * 3)
      this.life[i] = 0.4 + Math.random() * 0.35
    }
  }

  tick(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -100; continue }
      this.vel[i * 3 + 1] -= 9 * dt
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
    }
    this.points.geometry.attributes.position.needsUpdate = true
  }
}

// ---------------------------------------------------------------------------------------------

const BADGES = {
  waiting: ['?', '#d49b12'],
  error: ['!', '#e03b3b'],
  sleeping: ['z', '#6a7390'],
}

export class Bot {
  /**
   * @param opts.id        thread id (or errand id)
   * @param opts.accent    zone colour, used on the backpack
   * @param opts.errand    true for a subagent
   * @param opts.fromShip  walk out of the cabin rather than appearing in place
   */
  constructor({ id, accent, errand = false, fromShip = true, at = null }) {
    this.id = id
    this.errand = errand
    this.rand = rng(id)
    this.rig = makeRig(accent, errand)
    this.group = this.rig.root
    this.group.traverse((o) => { o.userData.threadId = id; o.userData.pickable = 'bot' })
    this.pos = at ? at.clone() : SHIP_DOOR.clone().add(new THREE.Vector3((this.rand() - 0.5) * 2, 0, this.rand()))
    this.pos.y = 0
    this.heading = Math.PI * this.rand() * 2
    this.goal = null
    this.pause = 0
    this.phase = this.rand() * 10
    this.walkT = 0
    this.leaving = false
    this.gone = false
    this.status = 'idle'
    this.home = null   // { pos, radius, facing }
    this.zone = null
    this.stuck = 0
    this.hammerT = 0
    this.boarding = 0

    this.badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }))
    this.badge.scale.set(0.7, 0.7, 0.7)
    this.badge.position.y = 1.9
    this.badge.renderOrder = 10
    this.badge.visible = false
    this.group.add(this.badge)

    if (!fromShip) this.pos.y = DECK_TOP
    this.group.position.copy(this.pos)
  }

  setStatus(status) {
    if (status === this.status) return
    this.status = status
    this.goal = null
    this.pause = 0
    const m = eyeMat(EYE[status] || EYE.idle)
    this.rig.eyeL.material = m
    this.rig.eyeR.material = m
    const sy = status === 'sleeping' ? 0.25 : 1
    this.rig.eyeL.scale.y = sy
    this.rig.eyeR.scale.y = sy
    const b = BADGES[status]
    if (b && !this.errand) {
      this.badge.material.map = badgeTexture(b[0], b[1])
      this.badge.material.needsUpdate = true
      this.badge.visible = true
    } else {
      this.badge.visible = false
    }
    this.rig.hammer.visible = status === 'running'
  }

  /** Where this bot stands to do its current job. */
  jobSpot(offsetAngle = 0) {
    const h = this.home
    const a = h.facing + offsetAngle
    const d = h.radius + 0.6
    return new THREE.Vector3(h.pos.x + Math.sin(a) * d, 0, h.pos.z + Math.cos(a) * d)
  }

  pickGoal() {
    if (!this.home) return null
    const s = this.status
    if (this.errand) return this.jobSpot(this.rand() * Math.PI * 2)
    if (s === 'running') return this.jobSpot((this.rand() - 0.5) * 1.6)
    if (s === 'waiting') return this.jobSpot(0)
    if (s === 'error' || s === 'sleeping') return this.jobSpot(0.6)
    // idle: potter about the zone
    for (let i = 0; i < 20; i++) {
      const t = this.zone.tiles[Math.floor(this.rand() * this.zone.tiles.length)]
      if (!t) break
      const x = (this.rand() - 0.5) * 2 * HEX_R * 0.85
      const z = (this.rand() - 0.5) * 2 * HEX_R * 0.85
      if (!inHex(x, z, HEX_R - 1.2)) continue
      return new THREE.Vector3(t.pos.x + x, 0, t.pos.z + z)
    }
    return this.jobSpot(this.rand() * Math.PI * 2)
  }

  /** Ground height under a point: on a deck, the deck top; elsewhere the sand. */
  groundAt(x, z) {
    for (const t of this.world.allTiles) {
      if (inHex(x - t.pos.x, z - t.pos.z, HEX_R)) return DECK_TOP
    }
    if (Math.hypot(x, z) < 6.1) return 0.02
    return 0
  }

  tick(dt, t, obstacles, bots, sparks) {
    const rig = this.rig
    let moving = false

    if (this.leaving) {
      // Walk to the porch, then in through the door
      const target = SHIP_DOOR
      if (this.boarding === 0 && this.moveTowards(target, dt, obstacles, bots, 0.6)) this.boarding = 0.001
      else moving = this.boarding === 0
      if (this.boarding > 0) {
        this.boarding += dt * 0.6
        this.pos.z = SHIP_DOOR.z - this.boarding * 2.2 // in through the cabin door
        this.pos.x *= 0.9
        this.pos.y = 0
        this.heading = Math.PI
        moving = true
        if (this.boarding >= 1) this.gone = true
      }
    } else if (this.home) {
      if (!this.goal) {
        if (this.pause > 0) this.pause -= dt
        else this.goal = this.pickGoal()
      }
      if (this.goal) {
        const arrived = this.moveTowards(this.goal, dt, obstacles, bots, 0.35)
        moving = !arrived
        if (arrived) {
          this.goal = null
          this.stuck = 0
          if (this.status === 'idle') this.pause = 2 + this.rand() * 5
          else if (this.errand) this.pause = 3 + this.rand() * 4
          else this.pause = 1e9 // stay at the job until status changes
          if (this.status !== 'idle' && !this.errand) this.faceBuilding = true
        }
      }
    }

    // Face the building while working/waiting, otherwise face the way we're going
    if (!moving && this.home && this.status !== 'idle' && !this.leaving) {
      const dx = this.home.pos.x - this.pos.x
      const dz = this.home.pos.z - this.pos.z
      let want = Math.atan2(dx, dz)
      if (this.status === 'waiting') want += Math.PI // turn round to face you
      this.heading = lerpAngle(this.heading, want, Math.min(1, dt * 5))
    }

    const groundY = this.boarding > 0 ? 0.2 : this.groundAt(this.pos.x, this.pos.z)
    if (this.boarding === 0) this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 12)
    this.group.position.set(this.pos.x, this.boarding > 0 ? groundY : this.pos.y, this.pos.z)
    this.group.rotation.y = this.heading

    // Animation
    const p = t + this.phase
    rig.body.rotation.set(0, 0, 0)
    rig.body.position.y = 0
    rig.head.rotation.set(0, 0, 0)
    if (moving) {
      this.walkT += dt * 9
      const sw = Math.sin(this.walkT)
      rig.legL.rotation.x = sw * 0.6
      rig.legR.rotation.x = -sw * 0.6
      rig.armL.rotation.x = -sw * 0.5
      rig.armR.rotation.x = sw * 0.5
      rig.body.position.y = Math.abs(Math.cos(this.walkT)) * 0.05
    } else {
      rig.legL.rotation.x *= 0.8
      rig.legR.rotation.x *= 0.8
      rig.armL.rotation.x = 0
      rig.armR.rotation.x = 0
      const s = this.errand ? 'running' : this.status
      if (s === 'running' && this.home) {
        this.hammerT += dt * 7
        const swing = Math.sin(this.hammerT)
        rig.armR.rotation.x = -1.2 - swing * 0.9
        rig.body.rotation.x = 0.08 + swing * 0.04
        if (swing < -0.97 && !this.hitThisSwing) {
          this.hitThisSwing = true
          const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
          sparks.burst(this.group.position.clone().add(fwd.multiplyScalar(0.55)).setY(this.group.position.y + 0.7), 5)
        }
        if (swing > 0) this.hitThisSwing = false
      } else if (s === 'waiting') {
        rig.armR.rotation.x = -2.6
        rig.armR.rotation.z = -0.3 + Math.sin(p * 6) * 0.35
        rig.body.position.y = Math.max(0, Math.sin(p * 3)) * 0.06
      } else if (s === 'error') {
        rig.body.rotation.x = 0.45
        rig.head.rotation.x = 0.4
        rig.armL.rotation.z = 0.05
        rig.armR.rotation.z = -0.05
        const flick = Math.sin(p * 23) > 0.6 ? 1 : 0.2
        rig.eyeL.visible = rig.eyeR.visible = flick > 0.5
      } else if (s === 'sleeping') {
        rig.body.position.y = -0.3
        rig.legL.rotation.x = rig.legR.rotation.x = -1.4
        rig.head.rotation.x = 0.35 + Math.sin(p * 1.2) * 0.05
      } else {
        rig.head.rotation.y = Math.sin(p * 0.7) * 0.5
        rig.body.position.y = Math.sin(p * 2) * 0.01
      }
      if (s !== 'waiting') rig.armR.rotation.z = -0.2
    }
    if (this.status !== 'error') rig.eyeL.visible = rig.eyeR.visible = true
    if (this.badge.visible) this.badge.position.y = 1.9 + Math.sin(p * 2.5) * 0.08
  }

  /** Step towards a point, sliding round buildings and nudging other bots. Returns true on arrival. */
  moveTowards(target, dt, obstacles, bots, arriveDist) {
    const dx = target.x - this.pos.x
    const dz = target.z - this.pos.z
    const dist = Math.hypot(dx, dz)
    if (dist < arriveDist) return true
    let vx = dx / dist
    let vz = dz / dist

    // Steer round obstacles ahead: if the straight line clips a circle, bend tangentially.
    for (const o of obstacles) {
      if (o === this.homeObstacle && this.status !== 'idle') continue
      const ox = o.x - this.pos.x
      const oz = o.z - this.pos.z
      const along = ox * vx + oz * vz
      if (along < 0 || along > Math.min(dist, 4)) continue
      const perp = ox * vz - oz * vx
      const clear = o.r + BOT_RADIUS + 0.1
      if (Math.abs(perp) < clear) {
        const side = perp > 0 ? -1 : 1
        const w = (clear - Math.abs(perp)) / clear
        const tx = -vz * side
        const tz = vx * side
        vx = vx * (1 - w) + tx * w * 1.5
        vz = vz * (1 - w) + tz * w * 1.5
        const n = Math.hypot(vx, vz) || 1
        vx /= n
        vz /= n
      }
    }
    // Separation from other bots
    for (const b of bots) {
      if (b === this || b.gone) continue
      const sx = this.pos.x - b.pos.x
      const sz = this.pos.z - b.pos.z
      const d2 = sx * sx + sz * sz
      if (d2 > 0.0001 && d2 < 0.8) {
        const d = Math.sqrt(d2)
        vx += (sx / d) * (0.9 - d) * 1.2
        vz += (sz / d) * (0.9 - d) * 1.2
      }
    }
    const n = Math.hypot(vx, vz) || 1
    const speed = WALK_SPEED * (this.errand ? 1.15 : 1)
    const step = Math.min(dist, speed * dt)
    const nx = this.pos.x + (vx / n) * step
    const nz = this.pos.z + (vz / n) * step
    const before = Math.hypot(this.pos.x - target.x, this.pos.z - target.z)
    this.pos.x = nx
    this.pos.z = nz
    // Hard collision: never end a step inside a building.
    for (const o of obstacles) {
      const ox = this.pos.x - o.x
      const oz = this.pos.z - o.z
      const d = Math.hypot(ox, oz)
      const min = o.r + BOT_RADIUS
      if (d < min && d > 0.0001) {
        this.pos.x = o.x + (ox / d) * min
        this.pos.z = o.z + (oz / d) * min
      }
    }
    this.heading = lerpAngle(this.heading, Math.atan2(vx, vz), Math.min(1, dt * 10))
    // Give up on a goal we cannot reach after a while, rather than pushing at a wall forever.
    const after = Math.hypot(this.pos.x - target.x, this.pos.z - target.z)
    this.stuck = after >= before - 0.001 ? this.stuck + dt : Math.max(0, this.stuck - dt)
    if (this.stuck > 4) {
      this.stuck = 0
      return true
    }
    return false
  }
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
