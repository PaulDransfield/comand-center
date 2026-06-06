#!/usr/bin/env node
// scripts/diag/mix-share-seed-shape.mjs
//
// READ-ONLY diagnostic for the mix-share AI seed.
// Replicates the three SQL queries in docs/investigation/mix-share-seed.md
// by fetching from Supabase REST and aggregating in JS — PostgREST doesn't
// support PERCENTILE_CONT so we do the median in Node.
//
// Pulls:
//   - recipes (per-type NULL/SET counts + price spread)
//   - pos_menu_items (wiring count: recipe_id IS NOT NULL)
//   - pos_sales joined to pos_menu_items (90-day signal)
//
// Prints a markdown table the report-author can paste into the deliverable.

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Load .env.production.local manually (dotenv default only reads .env).
function loadEnv(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!m) continue
      const [, k, vRaw] = m
      if (process.env[k]) continue       // don't overwrite shell exports
      let v = vRaw.trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      process.env[k] = v
    }
  } catch {}
}
loadEnv(resolve(process.cwd(), '.env.production.local'))
loadEnv(resolve(process.cwd(), '.env.local'))

const URL  = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}

async function rest(path, query = '') {
  const url = `${URL}/rest/v1/${path}${query ? '?' + query : ''}`
  const r = await fetch(url, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: 'count=exact',
    },
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`${r.status} ${path}: ${t.slice(0, 200)}`)
  }
  return r.json()
}

// Page through a table when row count > 1000 (Supabase default cap).
async function fetchAll(path, select, extraFilters = '') {
  const out = []
  let offset = 0
  const limit = 1000
  while (true) {
    const q = [`select=${encodeURIComponent(select)}`, extraFilters, `limit=${limit}`, `offset=${offset}`]
      .filter(Boolean).join('&')
    const batch = await rest(path, q)
    out.push(...batch)
    if (batch.length < limit) break
    offset += limit
  }
  return out
}

// Median over a numeric array, ignoring nullish.
function median(arr) {
  const xs = arr.filter(x => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

const isDishShapedType = new Set([
  'starter','main','pasta','pizza','dessert','side','other',
  'cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free',
])

async function main() {
  // ── Recipes (all businesses, archived + active, with the cols we need)
  console.log('Fetching recipes…')
  const recipes = await fetchAll(
    'recipes',
    'business_id,type,portions_per_cover,selling_price_ex_vat,menu_price,archived_at,is_subrecipe',
  )

  // Filter to dish-shaped active recipes (mirrors isDish() at app/inventory/recipes/prep/page.tsx:155)
  const dishes = recipes.filter(r =>
    r.archived_at == null
    && r.is_subrecipe !== true
    && (
      (r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
      || (r.menu_price != null && Number(r.menu_price) > 0)
      || (r.type != null && isDishShapedType.has(String(r.type).toLowerCase()))
    )
  )

  // ── Group by business + type
  const buckets = new Map() // bizId → Map(type → { total, nullCount, setCount, prices: [] })
  for (const r of dishes) {
    const biz = r.business_id
    const type = r.type ?? '(no type)'
    if (!buckets.has(biz)) buckets.set(biz, new Map())
    const byType = buckets.get(biz)
    if (!byType.has(type)) byType.set(type, { total: 0, nullCount: 0, setCount: 0, prices: [] })
    const slot = byType.get(type)
    slot.total++
    if (r.portions_per_cover == null) slot.nullCount++
    else slot.setCount++
    const price = r.selling_price_ex_vat ?? r.menu_price
    if (price != null && Number(price) > 0) slot.prices.push(Number(price))
  }

  // ── Per-business totals
  const totals = new Map() // bizId → { toSeed, alreadySet, total }
  for (const [biz, byType] of buckets) {
    let toSeed = 0, alreadySet = 0, total = 0
    for (const slot of byType.values()) {
      toSeed += slot.nullCount
      alreadySet += slot.setCount
      total += slot.total
    }
    totals.set(biz, { toSeed, alreadySet, total })
  }

  // ── Friendly business names
  console.log('Fetching business names…')
  const bizIds = [...totals.keys()]
  const bizRows = bizIds.length
    ? await rest('businesses', `select=id,name&id=in.(${bizIds.join(',')})`)
    : []
  const bizName = new Map(bizRows.map(b => [b.id, b.name]))

  // ── POS wiring
  console.log('Fetching pos_menu_items wiring…')
  const posItems = await fetchAll(
    'pos_menu_items',
    'business_id,recipe_id,archived_at',
  )
  const posWiring = new Map() // bizId → { total, wired, active }
  for (const p of posItems) {
    const biz = p.business_id
    if (!posWiring.has(biz)) posWiring.set(biz, { total: 0, wired: 0, active: 0 })
    const slot = posWiring.get(biz)
    slot.total++
    if (p.recipe_id != null) slot.wired++
    if (p.archived_at == null) slot.active++
  }

  // ── POS sales last 90d (count + distinct wired recipes)
  console.log('Fetching pos_sales (last 90d)…')
  const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
  const salesRows = await fetchAll(
    'pos_sales',
    'business_id,pos_item_id,quantity,sold_date',
    `sold_date=gte.${cutoff}`,
  )
  // Build pos_item_id → recipe_id lookup
  const itemRecipe = new Map(posItems.map(p => [p.id, p.recipe_id]))
  const posSignal = new Map() // bizId → { rows, distinctWiredRecipes: Set }
  for (const s of salesRows) {
    const biz = s.business_id
    if (!posSignal.has(biz)) posSignal.set(biz, { rows: 0, distinctWiredRecipes: new Set() })
    const slot = posSignal.get(biz)
    slot.rows++
    const rid = itemRecipe.get(s.pos_item_id)
    if (rid) slot.distinctWiredRecipes.add(rid)
  }

  // ── PRINT REPORT
  console.log('\n# Mix-share seed — observed shape (READ-ONLY)\n')
  console.log(`Generated: ${new Date().toISOString()}`)
  console.log(`Cutoff for POS sales: ${cutoff}\n`)

  console.log('## Per-business totals\n')
  console.log('| Business | Dishes to seed (NULL) | Already set | Total dish-shaped |')
  console.log('|----------|---------------------:|------------:|------------------:|')
  for (const [biz, t] of totals) {
    const name = bizName.get(biz) ?? biz.slice(0, 8)
    console.log(`| ${name} | ${t.toSeed} | ${t.alreadySet} | ${t.total} |`)
  }

  for (const [biz, byType] of buckets) {
    const name = bizName.get(biz) ?? biz.slice(0, 8)
    console.log(`\n## ${name} — per type\n`)
    console.log('| Type | Total | NULL | Set | Price min | Price median | Price max |')
    console.log('|------|------:|-----:|----:|----------:|-------------:|----------:|')
    const types = [...byType.entries()].sort((a, b) => b[1].total - a[1].total)
    for (const [type, slot] of types) {
      const min = slot.prices.length ? Math.min(...slot.prices) : null
      const med = median(slot.prices)
      const max = slot.prices.length ? Math.max(...slot.prices) : null
      console.log(`| ${type} | ${slot.total} | ${slot.nullCount} | ${slot.setCount} | ${fmt(min)} | ${fmt(med)} | ${fmt(max)} |`)
    }
  }

  console.log('\n## POS wiring (M097)\n')
  console.log('| Business | pos_menu_items total | Wired to recipe | Active | Sales rows 90d | Distinct wired recipes (90d) |')
  console.log('|----------|---------------------:|----------------:|-------:|---------------:|-----------------------------:|')
  const allBizIds = new Set([...buckets.keys(), ...posWiring.keys(), ...posSignal.keys()])
  for (const biz of allBizIds) {
    const name = bizName.get(biz) ?? biz.slice(0, 8)
    const w = posWiring.get(biz) ?? { total: 0, wired: 0, active: 0 }
    const s = posSignal.get(biz) ?? { rows: 0, distinctWiredRecipes: new Set() }
    console.log(`| ${name} | ${w.total} | ${w.wired} | ${w.active} | ${s.rows} | ${s.distinctWiredRecipes.size} |`)
  }

  console.log('\n_(Generated by scripts/diag/mix-share-seed-shape.mjs — READ-ONLY, no writes.)_')
}

function fmt(n) {
  if (n == null) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

main().catch(e => { console.error(e); process.exit(1) })
