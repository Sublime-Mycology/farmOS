// One zone per repo: dark tiled hex decks with a coloured kerb round the outside, a little clutter.
import * as THREE from 'three'
import { M, mesh, box, cyl, rng, hexToWorld, HEX_R, DECK_H, DECK_TOP, slotOffset, SLOTS_PER_TILE } from './kit.js'

let deckTexture = null
/** Wooden decking: staggered planks with dark seams and a little grain. */
function gridTexture() {
  if (deckTexture) return deckTexture
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  const rand = rng(3)
  const rows = 8
  const h = 256 / rows
  for (let row = 0; row < rows; row++) {
    let x = -rand() * 128
    while (x < 256) {
      const w = 90 + rand() * 80
      const v = rand()
      g.fillStyle = `rgb(${Math.round(128 + v * 26)},${Math.round(90 + v * 18)},${Math.round(58 + v * 12)})`
      g.fillRect(x, row * h, w, h)
      g.strokeStyle = 'rgba(60,38,20,0.18)'
      g.lineWidth = 1
      for (let k = 0; k < 3; k++) {
        const y = row * h + 5 + rand() * (h - 10)
        g.beginPath(); g.moveTo(x + 4, y); g.bezierCurveTo(x + w * 0.3, y + 2, x + w * 0.6, y - 2, x + w - 4, y); g.stroke()
      }
      g.fillStyle = 'rgba(45,28,14,0.85)'
      g.fillRect(x + w - 2, row * h, 2, h)
      x += w
    }
    g.fillStyle = 'rgba(45,28,14,0.9)'
    g.fillRect(0, row * h + h - 2, 256, 2)
  }
  deckTexture = new THREE.CanvasTexture(c)
  deckTexture.colorSpace = THREE.SRGBColorSpace
  deckTexture.wrapS = deckTexture.wrapT = THREE.RepeatWrapping
  deckTexture.repeat.set(2.4, 2.4)
  deckTexture.anisotropy = 8
  return deckTexture
}

const deckTopMat = () => new THREE.MeshStandardMaterial({ map: gridTexture(), roughness: 0.9, metalness: 0.05 })
let sharedTop = null

function hexCorner(i, r) {
  const a = (Math.PI / 3) * i
  return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
}
// Corner i and i+1 bound the edge facing neighbour EDGE_DIR[i] (axial offsets, pointy-top).
const EDGE_DIR = [[0, 1], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1]]

export class Zone {
  constructor(repo) {
    this.key = repo.key
    this.group = new THREE.Group()
    this.group.userData.repoKey = repo.key
    this.signature = ''
    this.color = repo.color
    this.tiles = []
    this.center = new THREE.Vector3()
  }

  /** Rebuild the decks if the zone's tiles or colour changed. */
  update(repo) {
    const sig = JSON.stringify(repo.tiles) + repo.color
    if (sig === this.signature) return false
    this.signature = sig
    this.color = repo.color
    this.tiles = repo.tiles.map(([q, r]) => ({ q, r, pos: hexToWorld(q, r) }))
    this.group.clear()
    if (!sharedTop) sharedTop = deckTopMat()

    const own = new Set(repo.tiles.map(([q, r]) => `${q},${r}`))
    const kerb = new THREE.MeshStandardMaterial({ color: repo.color, roughness: 0.6, emissive: repo.color, emissiveIntensity: 0.15, flatShading: true })
    const deckGeo = new THREE.CylinderGeometry(HEX_R - 0.06, HEX_R + 0.05, DECK_H + 0.4, 6)

    for (const t of this.tiles) {
      const deck = mesh(deckGeo, [M.deckSide, sharedTop, M.deckSide], { cast: false })
      deck.position.set(t.pos.x, (DECK_H - 0.4) / 2, t.pos.z)
      deck.userData.repoKey = repo.key
      deck.userData.pickable = 'zone'
      this.group.add(deck)

      // Kerb along every edge that does not border a tile of the same zone.
      for (let i = 0; i < 6; i++) {
        const [dq, dr] = EDGE_DIR[i]
        if (own.has(`${t.q + dq},${t.r + dr}`)) continue
        const a = hexCorner(i, HEX_R - 0.35)
        const b = hexCorner(i + 1, HEX_R - 0.35)
        const len = a.distanceTo(b) + 0.36
        const strip = mesh(new THREE.BoxGeometry(0.42, 0.14, len), kerb, { cast: false })
        strip.position.set(t.pos.x + (a.x + b.x) / 2, DECK_TOP + 0.05, t.pos.z + (a.z + b.z) / 2)
        strip.rotation.y = Math.atan2(b.x - a.x, b.z - a.z)
        this.group.add(strip)
      }
      this.addClutter(t, repo.key)
    }
    const c = new THREE.Vector3()
    for (const t of this.tiles) c.add(t.pos)
    this.center.copy(c.divideScalar(Math.max(1, this.tiles.length)))
    return true
  }

  /** Crates, barrels and little teal shrubs, placed between the building slots. */
  addClutter(t, seed) {
    const rand = rng(`${seed}:${t.q},${t.r}`)
    const spots = []
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i
      spots.push(new THREE.Vector3(Math.sin(a) * 4.9, 0, Math.cos(a) * 4.9))
      spots.push(new THREE.Vector3(Math.sin(a) * 2.15, 0, Math.cos(a) * 2.15))
    }
    for (const s of spots) {
      if (rand() < 0.45) continue
      const x = t.pos.x + s.x + (rand() - 0.5) * 0.6
      const z = t.pos.z + s.z + (rand() - 0.5) * 0.6
      const kind = rand()
      let prop
      if (kind < 0.35) {
        prop = new THREE.Group()
        const n = 1 + Math.floor(rand() * 3)
        for (let i = 0; i < n; i++) prop.add(box(0.45, 0.4, 0.45, i % 2 ? M.white : M.red, (i - 1) * 0.5, 0, rand() * 0.2))
      } else if (kind < 0.6) {
        prop = new THREE.Group()
        for (let i = 0; i < 4; i++) {
          const leaf = mesh(new THREE.IcosahedronGeometry(0.22, 0), i % 2 ? M.teal : M.green)
          leaf.position.set(Math.cos(i * 1.6) * 0.22, 0.2 + (i % 2) * 0.12, Math.sin(i * 1.6) * 0.22)
          prop.add(leaf)
        }
      } else if (kind < 0.8) {
        prop = cyl(0.2, 0.2, 0.5, 8, rand() < 0.5 ? M.band : M.white)
      } else {
        prop = new THREE.Group()
        prop.add(cyl(0.04, 0.04, 1.1, 5, M.metal))
        const lamp = mesh(new THREE.SphereGeometry(0.1, 6, 5), new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#ffd27a', emissiveIntensity: 1.4 }))
        lamp.position.y = 1.15
        prop.add(lamp)
      }
      prop.position.set(x, DECK_TOP, z)
      prop.rotation.y = rand() * Math.PI
      this.group.add(prop)
    }
  }

  /** World position of building slot `i` (tiles are filled in order, seven to a tile). */
  slotPosition(i) {
    const tile = this.tiles[Math.floor(i / SLOTS_PER_TILE)] || this.tiles[this.tiles.length - 1]
    if (!tile) return new THREE.Vector3()
    return tile.pos.clone().add(slotOffset(i % SLOTS_PER_TILE)).setY(DECK_TOP)
  }

  labelAnchor() {
    // Over the zone's first (root) tile, so it does not slide about as tiles are added.
    const t = this.tiles[0]
    return t ? new THREE.Vector3(t.pos.x, 3.2, t.pos.z) : this.center
  }
}
