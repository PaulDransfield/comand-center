// scripts/seed-shares.ts
//
// One-shot mix-share seed for recipes.portions_per_cover.
//
// Run via:
//   npx tsx scripts/seed-shares.ts --business=<uuid>            # DRY-RUN (default)
//   npx tsx scripts/seed-shares.ts --business=<uuid> --commit   # actually write
//
// Optional:
//   --types=food   (default) — seeds starter/pasta/pizza/main/side/dessert only
//   --types=drink  — reserved for a future pass; not implemented here
//
// SAFETY (load-bearing):
//   - DRY-RUN by default. --commit is REQUIRED to write.
//   - Only ever writes rows where portions_per_cover IS NULL — enforced on the
//     UPDATE itself via `.is('portions_per_cover', null)` so we cannot
//     overwrite an owner value even by mistake. Belt-and-braces re-check is
//     also in the per-row write loop.
//   - All writes go through createClient(serviceRoleKey) with an explicit
//     business_id filter on every query (mirrors the AI bulk importer's
//     pattern). RLS is bypassed but cross-business leakage is prevented
//     by the business_id filter at every query site.
//   - Numbers stored as fractions (0.15 = 15%); CHECK constraint enforces
//     0 ≤ x ≤ 10 so the clamp [0.02, 0.70] in the heuristic is well inside.
//
// HEURISTIC (deterministic — Haiku is used for CLASSIFICATION only, never to
// pick percentages):
//   1. Bucket each dish by food type. NULL-type rows get one Haiku call that
//      classifies the full list into starter / pasta / pizza / main / side /
//      dessert / skip. The classification is in-memory; we do NOT persist
//      a derived type.
//   2. Per course bucket, a target uptake fraction (% of covers ordering the
//      course): starter 0.55, pasta 0.45, pizza 0.45, main 0.40, dessert 0.30,
//      side 0.20.
//   3. Distribute the uptake across each course's dishes by INVERSE-PRICE
//      weight (cheaper → higher share). Within-course shares sum to the
//      course uptake. Across courses they may sum > 1 — that's correct;
//      a cover orders starter + main + dessert.
//   4. Clamp each share to [0.02, 0.70] and round to 2 decimals.
//
// POS OVERRIDE: if a business has pos_menu_items wired to recipes (≥1) AND
// pos_sales rows in the last 90 days (≥50), the script computes the empirical
// share = SUM(qty)/SUM(covers) for each wired recipe and uses that instead of
// the heuristic for that recipe. Unwired recipes still fall through to the
// heuristic. (Expectation: zero wiring at Chicce / Vero today — but the
// detection is automatic.)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

import { AI_MODELS } from '../lib/ai/models'

// ── env loading ─────────────────────────────────────────────────────
function loadEnv(path: string) {
  try {
    const raw = readFileSync(path, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!m) continue
      const [, k, vRaw] = m
      if (process.env[k]) continue
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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// ── flag parsing ────────────────────────────────────────────────────
const args = new Map<string, string>()
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/)
  if (m) args.set(m[1], m[2] ?? 'true')
}

const BUSINESS_ID = args.get('business') ?? ''
const TYPES       = (args.get('types') ?? 'food').toLowerCase()
const COMMIT      = args.get('commit') === 'true'
const DRY_RUN     = !COMMIT     // dry-run is the default; --commit is the only way to flip it

if (!BUSINESS_ID) {
  console.error('Usage: tsx scripts/seed-shares.ts --business=<uuid> [--types=food|drink] [--commit]')
  process.exit(1)
}
if (TYPES !== 'food') {
  console.error(`--types=${TYPES} not implemented yet (this script seeds food only).`)
  process.exit(1)
}

// ── config constants (course-uptake distribution) ──────────────────
// Fractions: 0.55 = 55% of covers order a starter.
const COURSE_UPTAKE: Record<string, number> = {
  starter: 0.55,
  pasta:   0.45,
  pizza:   0.45,
  main:    0.40,
  dessert: 0.30,
  side:    0.20,
}
const FOOD_BUCKETS = Object.keys(COURSE_UPTAKE) as Array<keyof typeof COURSE_UPTAKE>

const CLAMP_MIN = 0.02
const CLAMP_MAX = 0.70

// POS detection thresholds
const POS_MIN_WIRED_RECIPES = 1
const POS_MIN_SALES_90D     = 50

// ── helpers ─────────────────────────────────────────────────────────
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

function round2(n: number): number { return Math.round(n * 100) / 100 }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%` }

// ── PHASE 1: load recipes for the business ─────────────────────────
interface RecipeRow {
  id:                 string
  name:               string
  type:               string | null
  selling_price_ex_vat: number | null
  menu_price:         number | null
  portions_per_cover: number | null
  archived_at:        string | null
  is_subrecipe:       boolean | null
}

async function loadDishes(): Promise<RecipeRow[]> {
  // Mirror isDish() / the prep-page filter exactly.
  const { data, error } = await db
    .from('recipes')
    .select('id, name, type, selling_price_ex_vat, menu_price, portions_per_cover, archived_at, is_subrecipe')
    .eq('business_id', BUSINESS_ID)
    .is('archived_at', null)
  if (error) throw new Error(`recipes fetch failed: ${error.message}`)
  return (data ?? []).filter(r =>
    r.is_subrecipe !== true
    && String(r.type ?? '').toLowerCase() !== 'sauce'
    && (
      (r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
      || (r.menu_price != null && Number(r.menu_price) > 0)
      || r.type != null
    ),
  ) as RecipeRow[]
}

function priceOf(r: RecipeRow): number | null {
  const p = r.selling_price_ex_vat ?? r.menu_price
  return p != null && Number(p) > 0 ? Number(p) : null
}

// ── PHASE 2: POS auto-detect ───────────────────────────────────────
interface PosOverride {
  recipe_id: string
  share:     number          // already a fraction in [CLAMP_MIN, CLAMP_MAX]
}

async function loadPosOverrides(): Promise<{ overrides: PosOverride[]; wired: number; rows90d: number }> {
  const { data: items, error: e1 } = await db
    .from('pos_menu_items')
    .select('id, recipe_id')
    .eq('business_id', BUSINESS_ID)
    .not('recipe_id', 'is', null)
  if (e1) throw new Error(`pos_menu_items fetch failed: ${e1.message}`)
  const wiredItems = items ?? []
  if (wiredItems.length < POS_MIN_WIRED_RECIPES) {
    return { overrides: [], wired: wiredItems.length, rows90d: 0 }
  }

  const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
  const { data: sales, error: e2 } = await db
    .from('pos_sales')
    .select('pos_item_id, quantity')
    .eq('business_id', BUSINESS_ID)
    .gte('sold_date', cutoff)
  if (e2) throw new Error(`pos_sales fetch failed: ${e2.message}`)
  const salesRows = sales ?? []
  if (salesRows.length < POS_MIN_SALES_90D) {
    return { overrides: [], wired: wiredItems.length, rows90d: salesRows.length }
  }

  // Total covers in the same window for the denominator.
  const { data: dm, error: e3 } = await db
    .from('daily_metrics')
    .select('covers')
    .eq('business_id', BUSINESS_ID)
    .gte('date', cutoff)
  if (e3) throw new Error(`daily_metrics fetch failed: ${e3.message}`)
  const coversTotal = (dm ?? []).reduce((s: number, r: any) => s + (Number(r.covers) || 0), 0)
  if (coversTotal <= 0) {
    return { overrides: [], wired: wiredItems.length, rows90d: salesRows.length }
  }

  // Aggregate per pos_item_id, then collapse to per recipe_id.
  const itemQty = new Map<string, number>()
  for (const s of salesRows) {
    const cur = itemQty.get(s.pos_item_id as string) ?? 0
    itemQty.set(s.pos_item_id as string, cur + (Number(s.quantity) || 0))
  }
  const recipeQty = new Map<string, number>()
  for (const it of wiredItems) {
    const q = itemQty.get(it.id) ?? 0
    if (q <= 0) continue
    const rid = it.recipe_id as string
    recipeQty.set(rid, (recipeQty.get(rid) ?? 0) + q)
  }

  const overrides: PosOverride[] = []
  for (const [rid, q] of recipeQty) {
    const raw   = q / coversTotal
    const share = clamp(round2(raw), CLAMP_MIN, CLAMP_MAX)
    overrides.push({ recipe_id: rid, share })
  }
  return { overrides, wired: wiredItems.length, rows90d: salesRows.length }
}

// ── PHASE 3: Haiku classification for NULL-type rows ────────────────
// IMPORTANT: Haiku is asked to classify ONLY. It does NOT pick percentages.
type FoodBucket = 'starter' | 'pasta' | 'pizza' | 'main' | 'side' | 'dessert' | 'skip'
interface HaikuClassifyResult { id: string; bucket: FoodBucket }

async function classifyWithHaiku(toClassify: Array<{ id: string; name: string; price: number | null }>): Promise<Map<string, FoodBucket>> {
  if (toClassify.length === 0) return new Map()
  if (!ANTHROPIC_KEY) {
    console.error('WARN: ANTHROPIC_API_KEY missing — skipping Haiku classification; NULL-type rows will be set to "skip".')
    return new Map(toClassify.map(r => [r.id, 'skip' as FoodBucket]))
  }

  const SYSTEM = `You are classifying dishes from a Stockholm Italian restaurant menu.
For each dish, return exactly one of: starter, pasta, pizza, main, side, dessert, skip.
- "starter" = antipasti / appetisers
- "pasta"   = pasta dishes
- "pizza"   = pizzas
- "main"    = main courses (meat/fish/non-pasta-non-pizza)
- "side"    = contorni / side dishes
- "dessert" = dolci
- "skip"    = if you genuinely cannot tell, or if the item is clearly a drink/cocktail/coffee
Return STRICT JSON only: {"results":[{"id":"<id>","bucket":"<bucket>"}, ...]}.`

  const userPayload = toClassify.map(r => ({
    id:    r.id,
    name:  r.name,
    price: r.price,
  }))
  const USER = `Classify these dishes:\n${JSON.stringify(userPayload, null, 2)}`

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      AI_MODELS.AGENT,
      max_tokens: 4000,
      system:     SYSTEM,
      messages: [{ role: 'user', content: USER }],
    }),
  })
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`Haiku classification failed (${r.status}): ${txt.slice(0, 300)}`)
  }
  const body = await r.json() as any
  const text: string = body?.content?.[0]?.text ?? ''
  // Tolerate the model wrapping in code fences or extra prose: extract the first {...} object.
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`Haiku returned no JSON object:\n${text.slice(0, 200)}`)
  let parsed: any
  try { parsed = JSON.parse(jsonMatch[0]) }
  catch (e: any) { throw new Error(`Haiku JSON parse failed: ${e.message}\nRaw: ${jsonMatch[0].slice(0, 300)}`) }
  const results: HaikuClassifyResult[] = Array.isArray(parsed?.results) ? parsed.results : []

  const validBuckets = new Set<FoodBucket>(['starter','pasta','pizza','main','side','dessert','skip'])
  const out = new Map<string, FoodBucket>()
  for (const r of results) {
    if (typeof r.id === 'string' && validBuckets.has(r.bucket as FoodBucket)) {
      out.set(r.id, r.bucket)
    }
  }
  // Any id not returned → 'skip' (defensive — never accept a missing answer as a positive).
  for (const t of toClassify) if (!out.has(t.id)) out.set(t.id, 'skip')
  return out
}

// ── PHASE 4: heuristic distribution ─────────────────────────────────
interface Proposal {
  recipe_id:     string
  name:          string
  declared_type: string | null
  bucket:        FoodBucket | null  // null = skipped
  classified:    boolean            // true = bucket came from Haiku, not declared type
  price:         number | null
  current_share: number | null
  proposed:      number | null
  source:        'pos' | 'heuristic' | 'skip'
  skip_reason?:  string
}

function distributeByInversePrice(dishes: Array<{ recipe_id: string; price: number | null }>, uptake: number): Map<string, number> {
  const out = new Map<string, number>()
  if (dishes.length === 0) return out
  // Inverse-price weights; zero/missing price → equal weight.
  const weights = dishes.map(d => (d.price != null && d.price > 0) ? 1 / d.price : 1)
  const sum     = weights.reduce((s, w) => s + w, 0)
  if (sum <= 0) {
    for (const d of dishes) out.set(d.recipe_id, uptake / dishes.length)
    return out
  }
  for (let i = 0; i < dishes.length; i++) {
    out.set(dishes[i].recipe_id, uptake * (weights[i] / sum))
  }
  return out
}

// ── PHASE 5: write (only on --commit) ───────────────────────────────
async function writeProposals(props: Proposal[]): Promise<{ written: number; skipped_owner_set: number; failures: number }> {
  let written = 0, skippedOwner = 0, failures = 0
  for (const p of props) {
    if (p.proposed == null) continue
    // Double-guard: filter `.is('portions_per_cover', null)` on the UPDATE so
    // the DB physically refuses to flip an owner-set row, even if our local
    // snapshot somehow drifted. Combined with the explicit business_id check
    // this is the actual safety net.
    const { data, error } = await db
      .from('recipes')
      .update({ portions_per_cover: p.proposed })
      .eq('id',          p.recipe_id)
      .eq('business_id', BUSINESS_ID)
      .is('portions_per_cover', null)
      .select('id, portions_per_cover')
    if (error) {
      console.error(`  ✗ ${p.name} → ${error.message}`)
      failures++
      continue
    }
    if (!data || data.length === 0) {
      // Row's portions_per_cover became non-null between SELECT and UPDATE.
      // This is the intended no-op for owner-set values.
      skippedOwner++
      console.log(`  • ${p.name} → skipped (owner value present)`)
      continue
    }
    written++
    console.log(`  ✓ ${p.name} → ${pct(p.proposed)}`)
  }
  return { written, skipped_owner_set: skippedOwner, failures }
}

// ── MAIN ────────────────────────────────────────────────────────────
async function main() {
  console.log(`mix-share seed — business=${BUSINESS_ID} types=${TYPES} mode=${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}\n`)

  const dishes = await loadDishes()
  console.log(`Loaded ${dishes.length} dish-shaped recipes.`)

  // For this pass we restrict the heuristic to food types + NULL-types. Drinks
  // are skipped entirely (separate pass; see report § design note).
  const DRINK_TYPES = new Set(['cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free'])
  const foodLike    = dishes.filter(r => {
    const t = String(r.type ?? '').toLowerCase()
    if (FOOD_BUCKETS.includes(t as any)) return true
    if (t === '') return true            // NULL-type — to be classified by Haiku
    return false                          // drink type or 'other' → skip this pass
  })
  const skippedDrinkOther = dishes.length - foodLike.length
  console.log(`Filtered to ${foodLike.length} food-shaped + null-type rows (skipped ${skippedDrinkOther} drinks/other this pass).`)

  // POS detection
  const pos = await loadPosOverrides()
  console.log(`POS check: ${pos.wired} wired pos_menu_items, ${pos.rows90d} sales rows 90d → ${pos.overrides.length} POS overrides`)
  const posByRecipe = new Map(pos.overrides.map(o => [o.recipe_id, o.share]))

  // Classify NULL-type rows via Haiku
  const nullTypeRows = foodLike.filter(r => !String(r.type ?? '').trim())
  if (nullTypeRows.length > 0) {
    console.log(`Calling Haiku to classify ${nullTypeRows.length} NULL-type rows…`)
  }
  const classified = await classifyWithHaiku(
    nullTypeRows.map(r => ({ id: r.id, name: r.name, price: priceOf(r) })),
  )

  // Build bucket → dishes mapping
  const bucketIndex = new Map<FoodBucket, RecipeRow[]>()
  for (const k of FOOD_BUCKETS) bucketIndex.set(k as FoodBucket, [])
  for (const r of foodLike) {
    let bucket: FoodBucket | 'skip' = 'skip'
    const declared = String(r.type ?? '').toLowerCase()
    if (FOOD_BUCKETS.includes(declared as any)) bucket = declared as FoodBucket
    else if (classified.has(r.id)) bucket = classified.get(r.id)!
    if (bucket === 'skip') continue
    bucketIndex.get(bucket)!.push(r)
  }

  // Heuristic distribution per bucket
  const proposed = new Map<string, number>()  // recipe_id → share
  for (const [bucket, rows] of bucketIndex) {
    const uptake = COURSE_UPTAKE[bucket]
    const shares = distributeByInversePrice(rows.map(r => ({ recipe_id: r.id, price: priceOf(r) })), uptake)
    for (const [rid, s] of shares) {
      proposed.set(rid, clamp(round2(s), CLAMP_MIN, CLAMP_MAX))
    }
  }

  // Build the per-row proposal list (covers every dish-shaped row, even
  // the ones we're skipping, so the dry-run is fully transparent).
  const props: Proposal[] = []
  for (const r of dishes) {
    const declared = String(r.type ?? '').toLowerCase()
    const isDrink  = DRINK_TYPES.has(declared)
    const isOther  = declared === 'other'

    // Skipped categories — record explicitly for the dry-run review.
    if (isDrink) {
      props.push({
        recipe_id: r.id, name: r.name, declared_type: r.type, bucket: null,
        classified: false, price: priceOf(r), current_share: r.portions_per_cover,
        proposed: null, source: 'skip', skip_reason: 'drink type (not in this pass)',
      })
      continue
    }
    if (isOther) {
      props.push({
        recipe_id: r.id, name: r.name, declared_type: r.type, bucket: null,
        classified: false, price: priceOf(r), current_share: r.portions_per_cover,
        proposed: null, source: 'skip', skip_reason: "type='other' — heterogeneous bucket",
      })
      continue
    }
    if (r.portions_per_cover != null) {
      // Already set — record but don't propose.
      props.push({
        recipe_id: r.id, name: r.name, declared_type: r.type,
        bucket: (declared || classified.get(r.id) || 'skip') as any,
        classified: !declared && classified.has(r.id),
        price: priceOf(r), current_share: r.portions_per_cover,
        proposed: null, source: 'skip', skip_reason: 'already set',
      })
      continue
    }

    // POS override wins if available.
    const posShare = posByRecipe.get(r.id)
    if (posShare != null) {
      props.push({
        recipe_id: r.id, name: r.name, declared_type: r.type,
        bucket: (declared || classified.get(r.id) || null) as any,
        classified: !declared && classified.has(r.id),
        price: priceOf(r), current_share: r.portions_per_cover,
        proposed: posShare, source: 'pos',
      })
      continue
    }

    const share = proposed.get(r.id)
    if (share == null) {
      const haikuBucket = classified.get(r.id)
      props.push({
        recipe_id: r.id, name: r.name, declared_type: r.type, bucket: null,
        classified: false, price: priceOf(r), current_share: r.portions_per_cover,
        proposed: null, source: 'skip',
        skip_reason: !declared
          ? `Haiku classified as "${haikuBucket ?? 'skip'}"`
          : 'no bucket match',
      })
      continue
    }

    props.push({
      recipe_id: r.id, name: r.name, declared_type: r.type,
      bucket: (declared || classified.get(r.id)) as FoodBucket,
      classified: !declared && classified.has(r.id),
      price: priceOf(r), current_share: r.portions_per_cover,
      proposed: share, source: 'heuristic',
    })
  }

  // ── Dry-run report ────────────────────────────────────────────────
  const writeable = props.filter(p => p.proposed != null && p.current_share == null)
  const skippedAlready = props.filter(p => p.skip_reason === 'already set').length
  const skippedNoBucket = props.filter(p => p.source === 'skip' && p.skip_reason !== 'already set').length

  // Per-course sanity totals (validates the within-course sum-to-uptake invariant).
  const perCourse = new Map<FoodBucket, { count: number; sum: number }>()
  for (const p of writeable) {
    const b = (p.bucket ?? 'skip') as FoodBucket
    if (!FOOD_BUCKETS.includes(b as any)) continue
    const slot = perCourse.get(b) ?? { count: 0, sum: 0 }
    slot.count++; slot.sum += p.proposed!
    perCourse.set(b, slot)
  }

  // ── Output ─────────────────────────────────────────────────────────
  const outLines: string[] = []
  outLines.push(`# Mix-share seed dry-run`)
  outLines.push(``)
  outLines.push(`- Business:   \`${BUSINESS_ID}\``)
  outLines.push(`- Types:      ${TYPES}`)
  outLines.push(`- Mode:       ${DRY_RUN ? 'DRY-RUN (default)' : 'COMMIT'}`)
  outLines.push(`- Generated:  ${new Date().toISOString()}`)
  outLines.push(``)
  outLines.push(`## Counts`)
  outLines.push(``)
  outLines.push(`- Loaded dishes total: ${dishes.length}`)
  outLines.push(`- Would write (proposed + currently NULL): **${writeable.length}**`)
  outLines.push(`- Skipped, already set: ${skippedAlready}`)
  outLines.push(`- Skipped, no bucket / drink / other: ${skippedNoBucket}`)
  outLines.push(`- POS override source: ${pos.overrides.length} (wired=${pos.wired}, sales-90d=${pos.rows90d})`)
  outLines.push(``)
  outLines.push(`## Per-course sums (within-course shares sum to the course uptake)`)
  outLines.push(``)
  outLines.push(`| Course | Dishes | Uptake target | Actual sum |`)
  outLines.push(`|--------|------:|--------------:|-----------:|`)
  for (const c of FOOD_BUCKETS) {
    const slot = perCourse.get(c as FoodBucket) ?? { count: 0, sum: 0 }
    outLines.push(`| ${c} | ${slot.count} | ${pct(COURSE_UPTAKE[c])} | ${pct(slot.sum)} |`)
  }
  outLines.push(``)
  outLines.push(`## Per-dish proposals`)
  outLines.push(``)
  outLines.push(`| Name | Type | Price | Source | Current | Proposed |`)
  outLines.push(`|------|------|-----:|--------|--------:|---------:|`)
  for (const p of props.sort((a, b) => (b.proposed ?? -1) - (a.proposed ?? -1))) {
    const typeCol = p.classified
      ? `→ classified: ${p.bucket}`
      : (p.declared_type ?? '—')
    const priceCol = p.price != null ? p.price.toFixed(0) : '—'
    const cur      = p.current_share != null ? pct(p.current_share) : '—'
    const propCol  = p.proposed != null
      ? pct(p.proposed)
      : (p.skip_reason ? `skip — ${p.skip_reason}` : '—')
    outLines.push(`| ${p.name.replace(/\|/g, '/')} | ${typeCol} | ${priceCol} | ${p.source} | ${cur} | ${propCol} |`)
  }
  const outText = outLines.join('\n') + '\n'
  console.log(outText)

  // Write to docs/investigation/ so it lands next to the investigation report.
  const outDir = resolve(process.cwd(), 'docs', 'investigation')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const outFile = resolve(outDir, `mix-share-seed-dry-run-${BUSINESS_ID.slice(0, 8)}.md`)
  writeFileSync(outFile, outText)
  console.log(`\nReport written to ${outFile}\n`)

  if (DRY_RUN) {
    console.log('DRY-RUN: nothing was written to the database. Re-run with --commit to apply.')
    return
  }

  // COMMIT path
  console.log(`Writing ${writeable.length} rows…`)
  const result = await writeProposals(writeable)
  console.log(`\nWrote: ${result.written}`)
  console.log(`Skipped (owner value present at write time): ${result.skipped_owner_set}`)
  console.log(`Failures: ${result.failures}`)
}

main().catch(e => { console.error(e); process.exit(1) })
