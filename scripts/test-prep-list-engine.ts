// End-to-end engine test against real Chicce data.
//
//   npx tsx scripts/test-prep-list-engine.ts
//
// Picks Margherita + Pinsa Parma (both use Pinsa Red Sauce, which has
// yield 4175 g/portion set), enters 20 covers + 15 covers, and verifies
// the prep list aggregates the sauce correctly across both dishes into
// ONE component line, plus rolls the sauce's raw ingredients into the
// products list together with sibling dish ingredients. This is the
// core v1 test promised in the prompt's 3-line summary.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { loadRecipeIndex } from '../lib/inventory/recipe-cost'
import { aggregatePrepRequirements, formatPrepQty } from '../lib/inventory/prep-list'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('=')
      return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

async function main() {
  console.log('Loading Chicce recipe index…')
  const recipeIndex = await loadRecipeIndex(db, CHICCE)
  const { data: nameRows } = await db
    .from('recipes')
    .select('id, name')
    .eq('business_id', CHICCE)
    .is('archived_at', null)
  const recipeNames = new Map<string, string | null>()
  for (const r of nameRows ?? []) recipeNames.set(r.id, r.name ?? null)

  const margherita = (nameRows ?? []).find(r => r.name.toLowerCase() === 'margherita')
  const pinsaParma = (nameRows ?? []).find(r => r.name.toLowerCase() === 'pinsa parma')
  if (!margherita || !pinsaParma) {
    console.error('FAIL — missing Margherita or Pinsa Parma in the recipe set')
    process.exit(1)
  }
  console.log(`  found Margherita (id=${margherita.id.slice(0, 8)}) + Pinsa Parma (id=${pinsaParma.id.slice(0, 8)})`)

  // 20 Margheritas + 15 Pinsa Parmas — same scenario as the data findings.
  const items = [
    { recipe_id: margherita.id, qty: 20 },
    { recipe_id: pinsaParma.id, qty: 15 },
  ]

  console.log('\nRunning aggregatePrepRequirements…')
  const result = aggregatePrepRequirements(items, recipeIndex, recipeNames)

  console.log('\n── COMPONENTS to prep ─────────────────────────────────────────')
  for (const c of result.components) {
    const f = formatPrepQty(c.total_qty, c.unit)
    const tag = c.uncertain ? `  [${c.uncertain.toUpperCase()}]` : (c.source_recipes.length >= 2 ? '  [SHARED]' : '')
    const sources = c.source_recipes.map(rid => recipeNames.get(rid) ?? rid.slice(0, 8)).join(', ')
    console.log(`  ${(c.name ?? '—').padEnd(40)}  ${String(f.qty).padStart(8)} ${f.unit.padEnd(4)}  used by ${c.source_recipes.length}${tag}`)
    if (c.uncertain) console.log(`     reason: ${c.uncertain_reason}`)
    else             console.log(`     sources: ${sources}`)
  }

  console.log('\n── PRODUCTS to pull (raw ingredients) ─────────────────────────')
  for (const p of result.products.slice(0, 30)) {
    const f = formatPrepQty(p.total_qty, p.unit)
    const sources = p.source_recipes.map(rid => recipeNames.get(rid) ?? rid.slice(0, 8)).join(', ')
    console.log(`  ${(p.name ?? p.product_id.slice(0, 8)).padEnd(50)}  ${String(f.qty).padStart(8)} ${f.unit.padEnd(4)}  used by ${p.source_recipes.length}`)
    console.log(`     sources: ${sources}`)
  }
  if (result.products.length > 30) console.log(`  …and ${result.products.length - 30} more`)

  console.log('\n── FLAGS (if any) ─────────────────────────────────────────────')
  if (result.flags.length === 0) console.log('  none')
  else for (const f of result.flags) console.log(`  ! ${f.reason}`)

  // ── ASSERT: the core v1 test ──────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  CORE TEST: Pinsa Red Sauce shared across Margherita + Parma')
  console.log('══════════════════════════════════════════════════════════════')
  const redSauce = result.components.find(c => (c.name ?? '').toLowerCase().includes('pinsa red sauce'))
  if (!redSauce) {
    console.log('  FAIL — Pinsa Red Sauce not in components')
    process.exit(1)
  }
  if (redSauce.source_recipes.length !== 2) {
    console.log(`  FAIL — Pinsa Red Sauce only references ${redSauce.source_recipes.length} dish(es), expected 2`)
    process.exit(1)
  }
  if (redSauce.uncertain) {
    console.log(`  FAIL — Pinsa Red Sauce flagged uncertain (${redSauce.uncertain}: ${redSauce.uncertain_reason})`)
    process.exit(1)
  }
  if (!redSauce.total_qty || redSauce.total_qty <= 0) {
    console.log(`  FAIL — Pinsa Red Sauce total_qty is ${redSauce.total_qty}`)
    process.exit(1)
  }
  const f = formatPrepQty(redSauce.total_qty, redSauce.unit)
  console.log(`  PASS — Pinsa Red Sauce aggregates to ${f.qty} ${f.unit}, sourced from both Margherita + Pinsa Parma in a single line.`)

  // ── SECOND TEST: honest-incomplete on yield-less subs ───────────
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  HONEST-INCOMPLETE TEST: yield-less sub flagged uncertain')
  console.log('══════════════════════════════════════════════════════════════')
  const carpaccio = (nameRows ?? []).find(r => r.name.toLowerCase() === 'carpaccio')
  if (!carpaccio) { console.log('  SKIP — Carpaccio not found'); return }
  const result2 = aggregatePrepRequirements([{ recipe_id: carpaccio.id, qty: 10 }], recipeIndex, recipeNames)
  console.log('\n  components from 10 Carpaccios:')
  for (const c of result2.components) {
    const tag = c.uncertain ? `  [${c.uncertain.toUpperCase()}]` : '  [OK]'
    console.log(`    ${(c.name ?? '—').padEnd(35)} ${tag}`)
    if (c.uncertain) console.log(`       reason: ${c.uncertain_reason}`)
  }
  const friedBasil = result2.components.find(c => (c.name ?? '').toLowerCase().includes('fried basil'))
  const pineNuts   = result2.components.find(c => (c.name ?? '').toLowerCase().includes('roasted pine'))
  const ok =
    friedBasil?.uncertain === 'sub_no_yield' &&
    pineNuts  ?.uncertain === 'sub_no_yield'
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — yield-less subs surface as uncertain rather than producing wrong totals.`)
}

main().catch(e => { console.error(e); process.exit(1) })
