// A made-up colony, for trying the thing out before any real sessions exist (`npm run demo`).
// Statuses drift over time so there is always somebody working, waiting or asleep.

const REPOS = [
  ['/home/you/farmOS', ['Add mushroom grow-room log type', 'Fix harvest quantity rounding', 'Substrate batch tracking', 'Humidity sensor import', 'Map layer for fruiting rooms', 'Update planting quick form', 'Refactor asset inventory API', 'Write tests for spawn logs', 'Add CSV export for yields', 'Docs: greenhouse setup']],
  ['/home/you/shop-site', ['Add product labels page', 'Stripe checkout webhook', 'Fix mobile nav overflow', 'Image lazy loading', 'SEO meta tags']],
  ['/home/you/sensor-hub', ['MQTT reconnect backoff', 'Add CO2 sensor driver', 'Battery telemetry graph', 'OTA update flow']],
  ['/home/you/recipes-app', ['Recipe import from URL', 'Offline mode', 'Dark theme']],
  ['/home/you/dotfiles', ['Tidy zsh aliases']],
]

const ACTIVITIES = [
  'Edit: src/Plugin/Log/LogType/GrowRoom.php', 'Bash: vendor/bin/phpunit --filter Harvest',
  'Read: modules/core/quantity/src/Quantity.php', 'Grep: hook_farm_entity_bundle_field_info',
  'Write: tests/src/Kernel/SpawnLogTest.php', 'Bash: npm run build', 'Edit: README.md',
  'WebFetch: https://farmos.org/development/api/', 'Task: Explore the asset module',
]

let seeded = null

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function seed() {
  const rand = rng(42)
  const now = Date.now()
  const threads = []
  let n = 0
  for (const [repo, titles] of REPOS) {
    for (const title of titles) {
      n++
      const hex = (n * 2654435761 >>> 0).toString(16).padStart(8, '0')
      const ageDays = rand() < 0.2 ? 4 + rand() * 20 : rand() * 2
      const size = Math.round(4000 * Math.pow(1000, rand()))
      threads.push({
        id: `${hex}-0000-4000-8000-${String(n).padStart(12, '0')}`,
        repo,
        cwd: repo,
        worktree: '',
        title,
        branch: rand() < 0.5 ? 'main' : `claude/${title.toLowerCase().replace(/[^a-z]+/g, '-').slice(0, 24)}`,
        model: 'claude-sonnet-5',
        activity: ACTIVITIES[Math.floor(rand() * ACTIVITIES.length)],
        status: 'idle',
        live: false,
        startedAt: now - ageDays * 86400000 - 3600000,
        updatedAt: now - ageDays * 86400000,
        size,
        pct: 0,
        errands: [],
        source: 'demo',
        _phase: rand() * 1000,
      })
    }
  }
  return threads
}

export function demoThreads({ viewed = {}, completion }) {
  if (!seeded) seeded = seed()
  const now = Date.now()
  const slot = Math.floor(now / 20000)
  return seeded.map((t, i) => {
    const out = { ...t }
    delete out._phase
    const age = now - t.updatedAt
    const roll = (Math.sin(slot * 12.9898 + t._phase) * 43758.5453) % 1
    const r = Math.abs(roll)
    if (age > 3 * 86400000) out.status = r < 0.1 ? 'running' : 'sleeping'
    else if (i === 3) out.status = 'error'
    else if (r < 0.4) out.status = 'running'
    else if (r < 0.55 && now > (viewed[t.id] || 0) + 30000) out.status = 'waiting'
    else out.status = 'idle'
    if (out.status === 'running') {
      t.size += 2000 + Math.floor(r * 8000)
      out.updatedAt = now
      out.activity = ACTIVITIES[(slot + i) % ACTIVITIES.length]
      if (r < 0.15) out.errands = [{ id: `agent-${i}`, title: 'Explore the codebase for related code', updatedAt: now }]
    }
    out.size = t.size
    out.pct = completion(t.size)
    return out
  })
}
