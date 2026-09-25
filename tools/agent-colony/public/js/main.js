import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createGround, createShip, Rocks, SAND } from './world.js'
import { Zone } from './zones.js'
import { Building } from './buildings.js'
import { Bot, Sparks } from './bots.js'
import { Hud } from './hud.js'
import { api } from './api.js'
import { HEX_R, DECK_TOP } from './kit.js'

// ---------------------------------------------------------------------------------------------
// Engine

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.fog = new THREE.Fog(SAND.clone().lerp(new THREE.Color('#f6e2cb'), 0.4), 140, 380)

const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.5, 1200)
camera.position.set(38, 62, 78)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.maxPolarAngle = 1.25
controls.minDistance = 8
controls.maxDistance = 320
controls.screenSpacePanning = false
controls.target.set(0, 0, 0)

scene.add(new THREE.HemisphereLight('#fff3e2', '#c99a74', 1.1))
const sun = new THREE.DirectionalLight('#fff0dc', 2.3)
sun.position.set(-40, 70, 30)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
sun.shadow.bias = -0.0004
sun.shadow.normalBias = 0.04
scene.add(sun, sun.target)
const fill = new THREE.DirectionalLight('#9fb8ff', 0.9)
fill.position.set(50, 30, -40)
scene.add(fill)

createGround(scene)
const rocks = new Rocks(scene)
const ship = createShip(scene)
const sparks = new Sparks(scene)

const selRing = new THREE.Mesh(
  new THREE.RingGeometry(0.62, 0.8, 32),
  new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
)
selRing.rotation.x = -Math.PI / 2
selRing.visible = false
scene.add(selRing)

// ---------------------------------------------------------------------------------------------
// Colony state

const world = {
  zones: new Map(),      // repo key -> Zone
  buildings: new Map(),  // thread id -> Building
  bots: new Map(),       // thread id (or thread:errand) -> Bot
  threads: new Map(),    // thread id -> thread
  allTiles: [],
  obstacles: [],
  state: null,
}
let firstSync = true

function fitShadows() {
  let r = HEX_R * 2
  for (const t of world.allTiles) r = Math.max(r, t.pos.length() + HEX_R)
  const cam = sun.shadow.camera
  cam.left = cam.bottom = -r - 4
  cam.right = cam.top = r + 4
  cam.near = 1
  cam.far = 300
  cam.updateProjectionMatrix()
  sun.position.set(-0.5, 1, 0.4).normalize().multiplyScalar(140)
  sun.target.position.set(0, 0, 0)
  world.radius = r
}

function sync(state) {
  world.state = state
  const seenZones = new Set()
  const seenThreads = new Set()

  for (const repo of state.repos) {
    seenZones.add(repo.key)
    let zone = world.zones.get(repo.key)
    if (!zone) {
      zone = new Zone(repo)
      world.zones.set(repo.key, zone)
      scene.add(zone.group)
    }
    zone.update(repo)
    zone.repo = repo
  }
  for (const [key, zone] of world.zones) {
    if (!seenZones.has(key)) {
      scene.remove(zone.group)
      world.zones.delete(key)
    }
  }
  world.allTiles = [...world.zones.values()].flatMap((z) => z.tiles)
  rocks.update(state.repos.flatMap((r) => r.tiles))
  fitShadows()

  for (const repo of state.repos) {
    const zone = world.zones.get(repo.key)
    const bySlot = new Map(repo.slots.map((id, i) => [id, i]))
    for (const thread of repo.threads) {
      seenThreads.add(thread.id)
      world.threads.set(thread.id, { ...thread, repoName: repo.name, repoKey: repo.key, color: repo.color })
      let b = world.buildings.get(thread.id)
      if (!b) {
        b = new Building(thread)
        if (firstSync) { b.shown = thread.pct; b.spawn = 1 }
        world.buildings.set(thread.id, b)
        scene.add(b.group)
      }
      b.group.position.copy(zone.slotPosition(bySlot.get(thread.id) ?? 0))
      b.update(thread)
      b.zoneKey = repo.key
    }
  }
  for (const [id, b] of world.buildings) {
    if (!seenThreads.has(id)) {
      scene.remove(b.group)
      world.buildings.delete(id)
      world.threads.delete(id)
    }
  }
  world.obstacles = [...world.buildings.values()].map((b) => ({ x: b.group.position.x, z: b.group.position.z, r: b.radius }))
  world.obstacles.push({ x: 0, z: 0, r: 3.3 })

  // Bots: one per thread, one per live errand
  const seenBots = new Set()
  for (const repo of state.repos) {
    const zone = world.zones.get(repo.key)
    for (const thread of repo.threads) {
      const b = world.buildings.get(thread.id)
      const home = { pos: b.group.position, radius: b.radius, facing: b.group.rotation.y }
      const want = [[thread.id, false, thread.status], ...thread.errands.map((e) => [`${thread.id}:${e.id}`, true, 'running'])]
      for (const [id, errand, status] of want) {
        seenBots.add(id)
        let bot = world.bots.get(id)
        if (!bot) {
          let at = null
          if (firstSync) {
            const a = home.facing + (Math.random() - 0.5) * 2
            at = new THREE.Vector3(home.pos.x + Math.sin(a) * (home.radius + 0.8), DECK_TOP, home.pos.z + Math.cos(a) * (home.radius + 0.8))
          } else if (errand) {
            const parent = world.bots.get(thread.id)
            at = parent ? parent.pos.clone() : null
          }
          bot = new Bot({ id, accent: repo.color, errand, fromShip: !at, at })
          bot.world = world
          bot.threadId = thread.id
          world.bots.set(id, bot)
          scene.add(bot.group)
        }
        bot.leaving = false
        bot.home = home
        bot.zone = zone
        bot.setStatus(status)
      }
    }
  }
  for (const [id, bot] of world.bots) {
    if (!seenBots.has(id)) bot.leaving = true
  }

  if (firstSync) {
    firstSync = false
    home(true)
    document.getElementById('loading').classList.add('done')
  }
}

// ---------------------------------------------------------------------------------------------
// Camera moves

const fly = { active: false, t: 0, fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(), toTarget: new THREE.Vector3() }

function flyTo(target, distance, instant = false, direction = null) {
  const dir = direction ? direction.clone() : camera.position.clone().sub(controls.target).normalize()
  if (dir.y < 0.35) dir.set(dir.x, 0.55, dir.z).normalize()
  fly.fromPos.copy(camera.position)
  fly.fromTarget.copy(controls.target)
  fly.toTarget.copy(target)
  fly.toPos.copy(target).add(dir.multiplyScalar(distance))
  fly.t = 0
  fly.active = true
  if (instant) {
    camera.position.copy(fly.toPos)
    controls.target.copy(fly.toTarget)
    fly.active = false
  }
}

function home(instant = false) {
  // Frame every tile plus the ship, and shift right so the side panel does not cover the colony.
  const box = new THREE.Box3().expandByPoint(new THREE.Vector3(-HEX_R, 0, -HEX_R)).expandByPoint(new THREE.Vector3(HEX_R, 0, HEX_R))
  for (const t of world.allTiles) {
    box.expandByPoint(t.pos.clone().addScalar(HEX_R))
    box.expandByPoint(t.pos.clone().addScalar(-HEX_R))
  }
  const centre = box.getCenter(new THREE.Vector3()).setY(0)
  const size = box.getSize(new THREE.Vector3())
  const extent = Math.max(size.x, size.z * 1.3)
  const panelShift = window.innerWidth > 760 ? extent * 0.12 : 0
  centre.x += panelShift
  const distance = extent * 1.05 + 12
  const dir = new THREE.Vector3(0.25, 0.78, 0.58).normalize()
  if (instant) {
    controls.target.copy(centre)
    camera.position.copy(centre).add(dir.multiplyScalar(distance))
  } else {
    flyTo(centre, distance, false, dir)
  }
}

// ---------------------------------------------------------------------------------------------
// Selection and picking

const app = {
  world,
  camera,
  controls,
  selection: { repo: null, thread: null },
  follow: true,
  showAllLabels: false,
  spin: false,
  hoverZone: null,
  selectThread(id, { fly: doFly = true } = {}) {
    const t = world.threads.get(id)
    if (!t) return
    this.selection = { repo: t.repoKey, thread: id }
    const bot = world.bots.get(id)
    if (doFly && bot) flyTo(bot.pos.clone().setY(1), 26)
    hud.refresh()
  },
  selectRepo(key, { fly: doFly = true } = {}) {
    this.selection = { repo: key, thread: null }
    const zone = world.zones.get(key)
    if (doFly && zone) flyTo(zone.center.clone(), 30 + zone.tiles.length * 8)
    hud.refresh()
  },
  clear() {
    this.selection = { repo: null, thread: null }
    hud.refresh()
  },
  home: () => home(),
  refreshSoon: () => setTimeout(poll, 250),
}

const hud = new Hud(app)
window.colony = app // handy from the devtools console
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let downAt = null

function pick(ev) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const targets = [
    ...[...world.bots.values()].map((b) => b.group),
    ...[...world.buildings.values()].map((b) => b.group),
    ...[...world.zones.values()].map((z) => z.group),
  ]
  const hits = raycaster.intersectObjects(targets, true)
  for (const h of hits) {
    let o = h.object
    if (o.isSprite) o = o.parent
    const u = o.userData
    if (u.pickable === 'bot' || u.pickable === 'building') return { thread: u.threadId }
    if (u.pickable === 'zone') return { repo: u.repoKey }
  }
  return null
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  downAt = [ev.clientX, ev.clientY]
  fly.active = false
})
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return
  downAt = null
  const hit = pick(ev)
  if (hit?.thread) app.selectThread(hit.thread.split(':')[0], { fly: false })
  else if (hit?.repo) app.selectRepo(hit.repo, { fly: false })
  else app.clear()
})
let hoverFrame = 0
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (++hoverFrame % 3) return
  const hit = pick(ev)
  renderer.domElement.style.cursor = hit ? 'pointer' : ''
  const t = hit?.thread && world.threads.get(hit.thread.split(':')[0])
  app.hoverZone = hit?.repo || t?.repoKey || null
})

window.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, textarea, select')) return
  if (ev.key === 'Escape') app.clear()
  else if (ev.key === 'h' || ev.key === 'H') home()
  else if (ev.key === 'f' || ev.key === 'F') hud.toggle('follow')
  else if (ev.key === 'l' || ev.key === 'L') hud.toggle('labels')
  else if ((ev.key === 'c' || ev.key === 'C') && app.selection.repo) { ev.preventDefault(); hud.openComposer() }
  else if ((ev.key === 'v' || ev.key === 'V') && app.selection.thread) hud.markViewed(app.selection.thread)
})

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

app.setShadows = (on) => {
  renderer.shadowMap.enabled = on
  sun.castShadow = on
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true })
}

// ---------------------------------------------------------------------------------------------
// Loop

const clock = new THREE.Clock()
const lastTarget = new THREE.Vector3()
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  const bots = [...world.bots.values()]
  for (const bot of bots) {
    bot.tick(dt, t, world.obstacles, bots, sparks)
    if (bot.gone) {
      scene.remove(bot.group)
      world.bots.delete(bot.id)
    }
  }
  for (const b of world.buildings.values()) b.tick(dt)
  sparks.tick(dt)
  ship.userData.beacon.material.emissiveIntensity = 1 + Math.sin(t * 4) * 1

  if (fly.active) {
    fly.t = Math.min(1, fly.t + dt / 0.9)
    const k = 1 - Math.pow(1 - fly.t, 3)
    camera.position.lerpVectors(fly.fromPos, fly.toPos, k)
    controls.target.lerpVectors(fly.fromTarget, fly.toTarget, k)
    if (fly.t >= 1) fly.active = false
  }

  // Follow the selected bot: move target and camera together so orbiting still works.
  const sel = app.selection.thread && world.bots.get(app.selection.thread)
  if (sel && app.follow && !fly.active) {
    const want = sel.group.position.clone().setY(1)
    const delta = want.sub(controls.target).multiplyScalar(Math.min(1, dt * 3))
    controls.target.add(delta)
    camera.position.add(delta)
  }
  if (sel) {
    selRing.visible = true
    selRing.position.set(sel.group.position.x, sel.group.position.y + 0.04, sel.group.position.z)
    selRing.scale.setScalar(1 + Math.sin(t * 4) * 0.06)
  } else {
    selRing.visible = false
  }

  if (app.spin && !sel) {
    const off = camera.position.clone().sub(controls.target)
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.05)
    camera.position.copy(controls.target).add(off)
  }

  controls.update()
  lastTarget.copy(controls.target)
  renderer.render(scene, camera)
  hud.frame()
  requestAnimationFrame(frame)
}

// ---------------------------------------------------------------------------------------------
// Polling

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    const state = await api.state()
    sync(state)
    hud.update(state)
  } catch (err) {
    hud.toast(`Can't reach the colony server: ${err.message}`)
  } finally {
    polling = false
  }
}

await poll()
setInterval(poll, 2500)
requestAnimationFrame(frame)
