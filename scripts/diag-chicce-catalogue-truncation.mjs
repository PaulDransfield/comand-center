#!/usr/bin/env node
// Verify the catalogue-truncation hypothesis for the bulk importer.
// At MAX_CATALOGUE=400 sorted alphabetically, does the 400th product
// land before or after Mozzarella / Parmigiano / Ruccola at Chicce?

import { readFileSync } from 'node:fs'
function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Pull all active products at Chicce, sorted by name (matches the
// import-parse endpoint's order).
const all = []
for (let from = 0; ; from += 1000) {
  const batch = await q(`products?business_id=eq.${CHICCE}&archived_at=is.null&select=name,category&order=name.asc&offset=${from}&limit=1000`)
  all.push(...batch)
  if (batch.length < 1000) break
  if (all.length > 5000) break
}
console.log(`Chicce total active products: ${all.length}`)

// What sits at position 400 (the current truncation point)?
console.log(`\n--- around the 400-mark cutoff ---`)
for (let i = 395; i <= 405 && i < all.length; i++) {
  console.log(`  ${i.toString().padStart(4)}: ${all[i].name} [${all[i].category ?? '?'}]`)
}

// Where do the missed ingredients sit?
const targets = ['mozzarella', 'parma', 'parmigiano', 'ruccola', 'olivolja', 'tomat', 'pomodoro']
console.log(`\n--- positions of expected matches ---`)
for (const tok of targets) {
  const matches = all.filter(p => p.name.toLowerCase().includes(tok)).slice(0, 3)
  for (const m of matches) {
    const idx = all.findIndex(p => p.name === m.name)
    const truncated = idx >= 400 ? ' ⚠ EXCLUDED' : ''
    console.log(`  "${tok}" → [${idx.toString().padStart(4)}] ${m.name}${truncated}`)
  }
}

// By category breakdown — what would 400 food-only products look like?
const byCat = {}
for (const p of all) {
  byCat[p.category ?? 'null'] = (byCat[p.category ?? 'null'] ?? 0) + 1
}
console.log(`\n--- by category ---`)
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(20)} ${n}`)
}

// Could we fit all food products?
const foodOnly = all.filter(p => p.category === 'food')
console.log(`\nfood-only count: ${foodOnly.length}`)
console.log(`food + beverage + alcohol: ${all.filter(p => ['food', 'beverage', 'alcohol'].includes(p.category)).length}`)
