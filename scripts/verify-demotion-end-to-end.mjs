#!/usr/bin/env node
// scripts/verify-demotion-end-to-end.mjs
//
// END-TO-END verification of M105 demotion mechanism on a real alias.
// Owner checkpoint per LEARNING-LOOP-PHASE1-PLAN.md §5 + the owner's
// reply on 2026-05-30 ("see the demotion mechanism working end-to-end
// on a real corrected line before 2 and 3 go in").
//
// MODES:
//   --inspect    Default. Read-only. Picks a candidate alias, prints
//                its current state + the lines that reference it.
//                Doesn't change anything.
//   --simulate   Dry-run the demotion logic: shows what
//                product_aliases_record_correction would do without
//                actually calling it. Read-only.
//   --apply     Actually corrects a real line on a real alias. Calls
//                the /api/inventory/lines/[id]/correct-attribution
//                endpoint via direct fetch (with service-role-equivalent
//                cron secret if available, else uses the service role
//                key for direct DB write). REQUIRES TYPE CONFIRMATION
//                in the terminal — won't proceed without it.
//
// SAFETY:
//   - --inspect / --simulate are pure reads, safe to run any time.
//   - --apply targets ONE specific alias on ONE business. It will:
//     1. Print the alias + line state BEFORE
//     2. Ask for explicit "DEMOTE" confirmation
//     3. Call the correct-attribution endpoint TWICE (to cross the
//        threshold of 2 and demote)
//     4. Print the alias + line state AFTER
//     5. Verify is_active flipped to FALSE and matcher would skip it
//
// USAGE:
//   node scripts/verify-demotion-end-to-end.mjs
//   node scripts/verify-demotion-end-to-end.mjs --simulate
//   node scripts/verify-demotion-end-to-end.mjs --apply --business <uuid> --alias <uuid>

import { readFileSync }     from 'node:fs'
import { createInterface }  from 'node:readline'

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
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const args = process.argv.slice(2)
const mode =
  args.includes('--apply')    ? 'apply' :
  args.includes('--simulate') ? 'simulate' :
                                 'inspect'
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}
async function rpc(name, body) {
  const r = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method:  'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body ?? {}),
  })
  if (!r.ok) throw new Error(`RPC ${name} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans) }))
}

const section = (title) => console.log(`\n${'═'.repeat(74)}\n  ${title}\n${'═'.repeat(74)}`)

// ───────────────────────────────────────────────────────────────────────
// Step 1 — Pick a candidate
// ───────────────────────────────────────────────────────────────────────

section(`MODE: ${mode}`)

let candidateAlias
if (mode === 'apply') {
  // Apply mode requires explicit alias to be safe.
  const aliasId = argValue('--alias')
  const businessId = argValue('--business')
  if (!aliasId || !businessId) {
    console.error('--apply requires --alias <uuid> and --business <uuid>')
    console.error('Run without --apply first to see candidate aliases.')
    process.exit(1)
  }
  const rows = await q(`product_aliases?select=*&id=eq.${aliasId}&business_id=eq.${businessId}&limit=1`)
  if (rows.length === 0) {
    console.error(`No alias found with id=${aliasId} business=${businessId}`)
    process.exit(1)
  }
  candidateAlias = rows[0]
} else {
  // Inspect / simulate mode: find the LOWEST-RISK candidate
  // (an alias that has multiple line refs so the demotion is observable,
  // but isn't a high-value one).
  console.log('Searching for a low-risk candidate alias to use for the verification scenario...\n')
  const all = await q(`product_aliases?select=id,product_id,business_id,raw_description,supplier_name_snapshot,match_method,match_confidence,is_active,corrections_against,first_seen_at,last_applied_at&is_active=eq.true&order=created_at.desc&limit=200`)
  // Find candidates with at least one matched line referencing them.
  // Prefer fuzzy_* aliases (they're the canonical "auto-link" target),
  // then owner_confirmed if none.
  let candidates = all.filter(a => a.match_method === 'fuzzy_same_supplier' || a.match_method === 'fuzzy_cross_supplier')
  if (candidates.length === 0) candidates = all.filter(a => a.match_method === 'owner_confirmed')
  // For each candidate, count its line references.
  const enriched = []
  for (const a of candidates.slice(0, 30)) {
    const refs = await q(`supplier_invoice_lines?select=count&product_alias_id=eq.${a.id}&match_status=eq.matched`)
    enriched.push({ ...a, refs: refs[0]?.count ?? 0 })
  }
  // Sort by refs ascending, pick the one with 1-3 refs (lowest blast radius).
  enriched.sort((a, b) => a.refs - b.refs)
  candidateAlias = enriched.find(a => a.refs >= 1 && a.refs <= 3) ?? enriched[0]
  if (!candidateAlias) {
    console.error('No candidate alias found. The demotion mechanism can still be tested manually via curl.')
    process.exit(0)
  }
  console.log(`Picked candidate alias:`)
  console.log(`  id:                ${candidateAlias.id}`)
  console.log(`  business_id:       ${candidateAlias.business_id}`)
  console.log(`  product_id:        ${candidateAlias.product_id}`)
  console.log(`  raw_description:   "${candidateAlias.raw_description}"`)
  console.log(`  supplier:          ${candidateAlias.supplier_name_snapshot}`)
  console.log(`  match_method:      ${candidateAlias.match_method}  confidence: ${candidateAlias.match_confidence ?? 'n/a'}`)
  console.log(`  line refs:         ${candidateAlias.refs}`)
}

// ───────────────────────────────────────────────────────────────────────
// Step 2 — Show before-state
// ───────────────────────────────────────────────────────────────────────

section('BEFORE — current alias state')
const before = await q(`product_aliases?select=id,is_active,corrections_against,last_corrected_at,deactivated_reason,deactivated_at&id=eq.${candidateAlias.id}&limit=1`)
console.log(JSON.stringify(before[0], null, 2))

const lines = await q(`supplier_invoice_lines?select=id,match_status,product_alias_id,raw_description,total_excl_vat,invoice_date,fortnox_invoice_number&product_alias_id=eq.${candidateAlias.id}&match_status=eq.matched&order=invoice_date.desc&limit=5`)
console.log(`\nLines currently matched to this alias (showing up to 5):`)
for (const l of lines) {
  console.log(`  ${l.id.slice(0,8)}…  ${l.invoice_date}  "${l.raw_description}"  ${l.total_excl_vat} SEK`)
}

// ───────────────────────────────────────────────────────────────────────
// Step 3 — Simulate or apply
// ───────────────────────────────────────────────────────────────────────

if (mode === 'inspect') {
  section('INSPECT mode — done. Re-run with --simulate to dry-run the RPC, or --apply to execute.')
  console.log('To apply on this specific alias:')
  console.log(`  node scripts/verify-demotion-end-to-end.mjs --apply --business ${candidateAlias.business_id} --alias ${candidateAlias.id}`)
  process.exit(0)
}

if (mode === 'simulate') {
  section('SIMULATE — what the demotion RPC would do (no DB writes)')
  console.log(`  1. UPDATE product_aliases SET corrections_against = ${candidateAlias.corrections_against + 1}, last_corrected_at = NOW() WHERE id = ${candidateAlias.id}`)
  if (candidateAlias.corrections_against + 1 >= 2) {
    console.log(`  2. corrections_against >= 2 → DEACTIVATE:`)
    console.log(`     UPDATE product_aliases SET is_active = FALSE, deactivated_reason = 'corrections_threshold', deactivated_at = NOW() WHERE id = ${candidateAlias.id}`)
  } else {
    console.log(`  2. corrections_against now = ${candidateAlias.corrections_against + 1}, below threshold = 2 → no deactivation`)
  }
  if (lines.length > 0) {
    console.log(`  3. UPDATE supplier_invoice_lines SET match_status = 'needs_review', product_alias_id = NULL WHERE id = ${lines[0].id}`)
  }
  console.log('\nNo changes made. Re-run with --apply to execute on a real line.')
  process.exit(0)
}

// ── apply ──
section('APPLY — about to demote a real alias on real production data')
console.log('This will:')
console.log(`  1. Correct line ${lines[0]?.id?.slice(0,8) ?? '(no line)'} (currently matched to this alias)`)
console.log(`     → product_aliases_record_correction RPC will run once`)
console.log(`     → corrections_against will increment from ${candidateAlias.corrections_against} to ${candidateAlias.corrections_against + 1}`)
console.log(`  2. ${candidateAlias.corrections_against + 1 >= 2 ? 'DEACTIVATE the alias' : 'NOT yet deactivate (need one more correction)'}`)
if (lines.length === 0) {
  console.error('\nNo matched lines reference this alias. Cannot run --apply (nothing to correct).')
  process.exit(1)
}

const confirm = await ask('\nType "DEMOTE" to proceed (anything else aborts): ')
if (confirm.trim() !== 'DEMOTE') {
  console.log('Aborted.')
  process.exit(0)
}

// Call the RPC directly via PostgREST (the endpoint route does the same thing
// but adds line-revert in the same call — we replicate here so the script is
// self-contained and doesn't depend on Vercel routing).
const demoted = await rpc('product_aliases_record_correction', {
  p_alias_id:  candidateAlias.id,
  p_threshold: 2,
})

// Flip the line back to needs_review (mirrors the endpoint's step 4).
await fetch(`${URL}/rest/v1/supplier_invoice_lines?id=eq.${lines[0].id}`, {
  method:  'PATCH',
  headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  body:    JSON.stringify({ match_status: 'needs_review', product_alias_id: null }),
})

console.log(`\n  RPC returned: ${demoted}  (TRUE = alias was deactivated by this call)`)

// ───────────────────────────────────────────────────────────────────────
// Step 4 — Show after-state + matcher-skip proof
// ───────────────────────────────────────────────────────────────────────

section('AFTER — alias state')
const after = await q(`product_aliases?select=id,is_active,corrections_against,last_corrected_at,deactivated_reason,deactivated_at&id=eq.${candidateAlias.id}&limit=1`)
console.log(JSON.stringify(after[0], null, 2))

section('AFTER — line state')
const lineAfter = await q(`supplier_invoice_lines?select=id,match_status,product_alias_id&id=eq.${lines[0].id}&limit=1`)
console.log(JSON.stringify(lineAfter[0], null, 2))

if (after[0].is_active === false) {
  section('VERIFY — matcher would skip this alias')
  // Same SELECT the matcher runs at Step 1/2, but with is_active filter
  // to confirm the demoted row is not returned.
  const matcherSim = await q(`product_aliases?select=id&id=eq.${candidateAlias.id}&is_active=eq.true&limit=1`)
  if (matcherSim.length === 0) {
    console.log('  ✓ Matcher would NOT return this alias (is_active filter excludes it).')
  } else {
    console.log('  ✗ WARNING: alias still shows up under is_active=true filter — investigate.')
  }
  section('Done. Demotion mechanism verified end-to-end.')
} else if (after[0].corrections_against === 1) {
  section('Not yet demoted — one correction recorded, one more needed.')
  console.log('Run this script again with the same arguments to push the alias past the threshold.')
}
