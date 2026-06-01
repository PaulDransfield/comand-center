#!/usr/bin/env node
// READ-ONLY pass: find near-duplicate product clusters across all
// products at Chicce + Vero. Uses lib/inventory/normalise.ts (the
// matcher's normaliser) for exact-match groups, then trigram cosine
// similarity for near-duplicates the normaliser doesn't catch (e.g.
// "Salt Fint M Jod" vs "Salt Fint med Jod").
//
// Pure read. No writes. Verdict for owner to triage.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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
const fileEnv = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
for (const [k, v] of Object.entries(fileEnv)) {
  if (!(k in process.env) || /^mock_|^https:\/\/mock-/.test(process.env[k] ?? '')) process.env[k] = v
}

const { normaliseDescription } = await import('../lib/inventory/normalise.ts')
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

// Trigram set + Jaccard similarity. Cheap to compute, robust on short
// product names.
function trigrams(s) {
  const t = `  ${s}  `
  const set = new Set()
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3))
  return set
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1
  let intersect = 0
  for (const x of a) if (b.has(x)) intersect++
  const union = a.size + b.size - intersect
  return union === 0 ? 0 : intersect / union
}

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

const verdicts = {}

for (const biz of BIZES) {
  console.log(`\n\n========== ${biz.name} ==========\n`)

  // Pull all active products with name + category + pack info.
  // 500 hard cap on returned rows per request — paginate via range.
  const all = []
  for (let from = 0; ; from += 1000) {
    const batch = await q(`products?business_id=eq.${biz.id}&archived_at=is.null&select=id,name,category,base_unit,pack_size,created_at,created_via&order=created_at.asc&offset=${from}&limit=1000`)
    all.push(...batch)
    if (batch.length < 1000) break
    if (all.length > 10000) break // safety
  }
  console.log(`Total active products: ${all.length}`)

  // Pass 1 — EXACT normalised matches within same business + category.
  // Multiple products with the same normalised name are unambiguous
  // duplicates from the matcher's POV.
  const byNorm = new Map()
  for (const p of all) {
    const key = `${p.category ?? ''}|${normaliseDescription(p.name)}`
    if (!byNorm.has(key)) byNorm.set(key, [])
    byNorm.get(key).push(p)
  }
  const exactDupes = []
  for (const [key, group] of byNorm) {
    if (group.length > 1) exactDupes.push({ key, group })
  }
  console.log(`\nPass 1 — exact-normalised duplicate clusters: ${exactDupes.length}`)
  for (const d of exactDupes.slice(0, 20)) {
    console.log(`  normalised: "${d.key.split('|')[1]}"`)
    for (const p of d.group) console.log(`    ${p.id.slice(0, 8)}  ${p.name.padEnd(60)} created=${p.created_at?.slice(0, 10)} via=${p.created_via ?? '?'}`)
  }
  if (exactDupes.length > 20) console.log(`  ... ${exactDupes.length - 20} more clusters`)

  // Pass 2 — TRIGRAM near-duplicates among products NOT in an exact
  // cluster. O(n^2) pairwise within same category. At ~1000 products
  // per category that's ~500k comparisons; cheap enough.
  console.log(`\nPass 2 — trigram-similar clusters (≥ 0.78 Jaccard, not in pass 1, same category)…`)
  const exactKeys = new Set(exactDupes.map(d => d.key))
  // Products NOT already flagged as exact-duplicates.
  const remaining = all.filter(p => {
    const key = `${p.category ?? ''}|${normaliseDescription(p.name)}`
    return !exactKeys.has(key)
  })
  // Group by category for cheaper pairwise.
  const byCat = new Map()
  for (const p of remaining) {
    const c = p.category ?? '(none)'
    if (!byCat.has(c)) byCat.set(c, [])
    byCat.get(c).push({ ...p, _tri: trigrams(normaliseDescription(p.name)) })
  }
  const fuzzyClusters = []
  for (const [cat, list] of byCat) {
    if (list.length < 2) continue
    // Union-find for cluster merging.
    const parent = list.map((_, i) => i)
    const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]))
    const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        // Cheap pre-filter: name length within 50%, share first 3 chars
        const ni = normaliseDescription(list[i].name)
        const nj = normaliseDescription(list[j].name)
        if (Math.abs(ni.length - nj.length) > Math.max(ni.length, nj.length) * 0.5) continue
        if (ni.slice(0, 3) !== nj.slice(0, 3)) continue
        const sim = jaccard(list[i]._tri, list[j]._tri)
        if (sim >= 0.78) union(i, j)
      }
    }
    const groups = new Map()
    for (let i = 0; i < list.length; i++) {
      const r = find(i)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r).push(list[i])
    }
    for (const g of groups.values()) {
      if (g.length > 1) fuzzyClusters.push({ category: cat, group: g })
    }
  }
  console.log(`Found ${fuzzyClusters.length} fuzzy clusters.`)
  for (const c of fuzzyClusters.slice(0, 20)) {
    console.log(`  [${c.category}]`)
    for (const p of c.group) console.log(`    ${p.id.slice(0, 8)}  ${p.name.padEnd(60)} created=${p.created_at?.slice(0, 10)} via=${p.created_via ?? '?'}`)
  }
  if (fuzzyClusters.length > 20) console.log(`  ... ${fuzzyClusters.length - 20} more clusters`)

  verdicts[biz.name] = {
    total_products:        all.length,
    exact_duplicate_clusters: exactDupes.length,
    exact_duplicate_products: exactDupes.reduce((s, d) => s + d.group.length, 0),
    fuzzy_clusters:        fuzzyClusters.length,
    fuzzy_cluster_products: fuzzyClusters.reduce((s, c) => s + c.group.length, 0),
  }
}

console.log('\n\n=== SUMMARY ===')
console.log(JSON.stringify(verdicts, null, 2))
if (!existsSync('tmp')) mkdirSync('tmp')
writeFileSync(`tmp/duplicate-clusters-${Date.now()}.json`, JSON.stringify(verdicts, null, 2))
