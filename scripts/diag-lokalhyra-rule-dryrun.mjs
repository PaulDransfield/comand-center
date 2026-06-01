#!/usr/bin/env node
// Both-directions dry-run for the proposed lokalhyra not_inventory rule.
// Per CLAUDE.md description-rules.ts discipline:
//   A) catches the noise it's meant to (real rent lines)
//   B) does NOT catch real products whose description merely contains
//      the token (false positives)
//
// Proposed regex: ^(lokalhyra|lokal\s+hyra|hyra\s+lokal)\b
//   - lokalhyra        most common compound form
//   - lokal hyra       split form (common in Swedish accounting)
//   - hyra lokal       reversed (less common but seen)
// All ^-anchored + \b — start of description + word boundary. No
// trailing wildcards needed; the matcher only needs to see "this line
// is a rent line" to set not_inventory.

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

// Unanchored compound match — same discipline as the existing
// pantersättning / öresavrundning / inkassoarvode arms. "hyra lokal"
// and "lokalhyra" don't appear inside real product names; safe as
// substring matches.
const PROPOSED = /\b(lokalhyra|hyra\s+lokal|lokal\s+hyra)\b/i

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BIZES) {
  console.log(`\n========== ${biz.name} ==========\n`)

  // Direction A — every line where "hyra" / "lokal" / "lokalhyra" appears
  // anywhere. Wider net so we see what the proposed regex catches AND
  // what's left over (i.e. rent-like lines the anchored rule misses).
  const anyHyra = await q(`supplier_invoice_lines?business_id=eq.${biz.id}&or=(raw_description.ilike.*lokalhyra*,raw_description.ilike.*lokal hyra*,raw_description.ilike.*hyra lokal*,raw_description.ilike.*hyresavg*)&select=*&limit=200`)
  console.log(`Lines with hyra/lokal text: ${anyHyra.length}`)

  const matchedByRule  = anyHyra.filter(l => PROPOSED.test(l.raw_description ?? ''))
  const missedByRule   = anyHyra.filter(l => !PROPOSED.test(l.raw_description ?? ''))

  console.log(`\nA. Lines the proposed rule CATCHES (should be all rent): ${matchedByRule.length}`)
  for (const l of matchedByRule.slice(0, 15)) {
    console.log(`  ${l.raw_description?.slice(0, 70).padEnd(70)}  ${l.total_excl_vat ?? '?'} SEK  inv=${l.is_inventory ?? '?'} status=${l.review_status ?? '?'}  ${l.supplier_name_snapshot?.slice(0, 30)}`)
  }
  if (matchedByRule.length > 15) console.log(`  ... ${matchedByRule.length - 15} more`)

  console.log(`\nLines with hyra/lokal text that the rule DOESN'T catch: ${missedByRule.length}`)
  for (const l of missedByRule.slice(0, 10)) {
    console.log(`  ${l.raw_description?.slice(0, 70).padEnd(70)}  ${l.total_excl_vat ?? '?'} SEK  ${l.supplier_name_snapshot?.slice(0, 30)}`)
  }
  if (missedByRule.length > 10) console.log(`  ... ${missedByRule.length - 10} more`)

  // Direction B — real products that incidentally contain the trigger
  // tokens but aren't rent. The token is highly specific so this should
  // be empty, but check.
  console.log(`\nB. False-positive check — products with "lokal" / "hyra" / "lokalhyra" in name:`)
  const productsHit = await q(`products?business_id=eq.${biz.id}&or=(name.ilike.*lokalhyra*,name.ilike.*lokal hyra*,name.ilike.*hyra lokal*)&select=id,name,category`)
  console.log(`  ${productsHit.length} products hit the substring search`)
  for (const p of productsHit) {
    const wouldCatch = PROPOSED.test(p.name ?? '')
    console.log(`    ${p.id.slice(0, 8)}  ${p.name.padEnd(50)} [${p.category ?? '?'}]  rule_catches=${wouldCatch}`)
  }

  // Direction B2 — products with just "lokal" or "hyra" alone (NOT
  // compound). These should NOT be caught by the anchored rule, but
  // worth confirming.
  console.log(`\n  Products containing standalone "lokal" or "hyra" (sanity check):`)
  const looseProducts = await q(`products?business_id=eq.${biz.id}&or=(name.ilike.*lokal*,name.ilike.*hyra*)&select=id,name&limit=20`)
  for (const p of looseProducts.slice(0, 10)) {
    const wouldCatch = PROPOSED.test(p.name ?? '')
    console.log(`    ${p.id.slice(0, 8)}  ${p.name.padEnd(50)} rule_catches=${wouldCatch ? '!!!' : 'no (safe)'}`)
  }
  if (looseProducts.length > 10) console.log(`    ... ${looseProducts.length - 10} more`)

  // What's currently classified as those caught lines? If they're
  // already not_inventory, the rule is just defensive. If they're in
  // needs_review or matched, the rule would CHANGE state.
  if (matchedByRule.length > 0) {
    console.log(`\nCurrent classification of the caught lines:`)
    const byMethod = {}
    for (const l of matchedByRule) {
      const k = `is_inv=${l.is_inventory ?? 'null'}/status=${l.review_status ?? 'null'}`
      byMethod[k] = (byMethod[k] ?? 0) + 1
    }
    console.log(`  ${JSON.stringify(byMethod)}`)
  }
}
