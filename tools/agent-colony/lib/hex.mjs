// Axial hex coordinates (pointy-top). Shared by the server layout and the browser renderer.

export const NEIGHBOURS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
]

export const key = (q, r) => `${q},${r}`

export function distance(q, r, q2 = 0, r2 = 0) {
  const dq = q - q2
  const dr = r - r2
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

export function neighbours(q, r) {
  return NEIGHBOURS.map(([dq, dr]) => [q + dq, r + dr])
}

/** Tiles a repo needs: one per seven threads, at least one. */
export function tilesNeeded(threadCount) {
  return Math.max(1, Math.ceil(threadCount / 7))
}

/**
 * Sticky layout. `saved` maps repo key -> [[q, r], ...] from the last run; `wants` maps repo key
 * -> tile count. A repo that still needs the same number keeps exactly its tiles; one that grew
 * keeps them and claims neighbours; one that shrank gives back the tiles it claimed last. Repos
 * that vanished keep their ground reserved so they return to the same place.
 * Tile (0,0) is the landing field and is never handed out.
 */
export function layout(saved, wants) {
  const taken = new Map()
  const reserved = new Set([key(0, 0)])
  const out = {}

  for (const [repo, tiles] of Object.entries(saved || {})) {
    const need = wants[repo]
    const keep = need === undefined ? tiles : tiles.slice(0, need)
    out[repo] = keep.filter(([q, r]) => !reserved.has(key(q, r)) && !taken.has(key(q, r)))
    for (const [q, r] of out[repo]) taken.set(key(q, r), repo)
  }

  const free = (q, r) => !reserved.has(key(q, r)) && !taken.has(key(q, r))

  // Existing repos first (they only grow), then new ones, biggest first so they get the middle.
  const order = Object.keys(wants).sort((a, b) => {
    const ea = out[a]?.length ? 0 : 1
    const eb = out[b]?.length ? 0 : 1
    return ea - eb || wants[b] - wants[a] || a.localeCompare(b)
  })

  for (const repo of order) {
    const tiles = out[repo] || (out[repo] = [])
    if (!tiles.length) {
      // Innermost free tile, preferring one that touches ground already in use.
      let best = null
      for (let radius = 1; radius < 40 && !best; radius++) {
        const ring = ringTiles(radius)
        const touching = ring.filter(([q, r]) => free(q, r) &&
          neighbours(q, r).some(([nq, nr]) => taken.has(key(nq, nr)) || reserved.has(key(nq, nr))))
        const candidates = touching.length ? touching : ring.filter(([q, r]) => free(q, r))
        best = candidates[0] || null
      }
      tiles.push(best)
      taken.set(key(...best), repo)
    }
    while (tiles.length < wants[repo]) {
      const [rq, rr] = tiles[0]
      let best = null
      let bestScore = Infinity
      for (const [tq, tr] of tiles) {
        for (const [q, r] of neighbours(tq, tr)) {
          if (!free(q, r)) continue
          const score = distance(q, r, rq, rr) * 10 + distance(q, r)
          if (score < bestScore) { bestScore = score; best = [q, r] }
        }
      }
      if (!best) break
      tiles.push(best)
      taken.set(key(...best), repo)
    }
  }
  return out
}

/** Tiles at exactly `radius` from the origin, in a stable order. */
export function ringTiles(radius) {
  if (radius === 0) return [[0, 0]]
  const out = []
  let q = -radius
  let r = radius
  const dirs = [[1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]]
  for (const [dq, dr] of dirs) {
    for (let i = 0; i < radius; i++) {
      out.push([q, r])
      q += dq
      r += dr
    }
  }
  return out
}
