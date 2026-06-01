#!/usr/bin/env node
// Both-directions dry-run for the M113 overhead sweep arms.
//
// For each candidate arm:
//   A. catches the noise it's meant to (count + sample at Chicce + Vero)
//   B. does NOT catch real products whose name happens to contain the
//      token (cross-check against products table)
//
// Bundle a regex per arm and verify before shipping. Pattern is the
// same discipline as the lokalhyra dry-run.

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
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

// Each arm: name, regex (JS form, will be mirrored to Postgres ARE in
// M113 SQL), substring tokens to search the DB with (ilike).
const ARMS = [
  {
    name:   'förseningsersättning',
    js:     /förseningsersättning/i,
    pg:     'försenings(ersättning|avgift)',
    tokens: ['förseningsersätt', 'försenings'],
    note:   'Late delivery / faktura compensation (refund). Unanchored compound.',
  },
  {
    name:   'öres-och-kron utjämning',
    js:     /öres.{0,3}och\s+kron/i,
    pg:     'öres.{0,3}och\\s+kron',
    tokens: ['öres- och kron', 'öres och kron'],
    note:   'Rounding adjustment variant. Existing öresavrundning arm misses "Öres- och kronutjämning".',
  },
  {
    name:   'brandsläckar / brand ansulex service',
    js:     /brand(släckar|\s+ansulex)/i,
    pg:     'brand(släckar|\\s+ansulex)',
    tokens: ['brandsläckar', 'brand ansulex', 'brandansulex'],
    note:   'Fire-extinguisher annual service. Compound or anchored prefix.',
  },
  {
    name:   '^engångsemballage',
    js:     /^engångsemballage/i,
    pg:     '^eng[åa]ngsemballage',
    tokens: ['engångsemballage'],
    note:   'Single-use packaging units. Anchored ^ — could clash with real "engångs-glas" products?',
  },
  {
    name:   'förpackningsavgift',
    js:     /förpackningsavgift/i,
    pg:     'förpackningsavgift',
    tokens: ['förpackningsavgift'],
    note:   'Packaging fee on the invoice. Unanchored compound — unlikely to appear in product names.',
  },
  {
    name:   '^europapall(e)? (widen existing ^eur-pall arm)',
    js:     /^europapall(e)?\b/i,
    pg:     '^europapall(e)?\\M',
    tokens: ['europapall', 'europapalle'],
    note:   'Carlsberg sends "EUROPAPALLE 4 VEJS" — "europa" + "palle", not "europall". Current ^eur[-\\s]?pall misses this compound form.',
  },
]

for (const arm of ARMS) {
  console.log(`\n========== Arm: ${arm.name} ==========`)
  console.log(`  ${arm.note}`)
  console.log(`  JS regex: ${arm.js}`)
  console.log(`  PG ARE:   ${arm.pg}`)

  // Direction A — what does the proposed regex catch in needs_review
  // (no alias) lines? Union of substring searches over each token.
  console.log(`\n  A. CATCHES (needs_review + no alias):`)
  for (const biz of BIZES) {
    let allMatches = []
    for (const tok of arm.tokens) {
      const rows = await q(`supplier_invoice_lines?business_id=eq.${biz.id}&match_status=eq.needs_review&product_alias_id=is.null&raw_description=ilike.*${tok}*&select=raw_description,supplier_name_snapshot,total_excl_vat&limit=300`)
      for (const r of rows) allMatches.push(r)
    }
    // Dedup by description (in case multiple tokens hit the same row).
    const uniqByDesc = new Map()
    for (const r of allMatches) uniqByDesc.set(`${r.raw_description}|${r.total_excl_vat}|${r.supplier_name_snapshot}`, r)
    const rows = [...uniqByDesc.values()]
    const matched = rows.filter(r => arm.js.test(r.raw_description ?? ''))
    const unmatched = rows.filter(r => !arm.js.test(r.raw_description ?? ''))
    console.log(`    [${biz.name.padEnd(7)}] regex catches ${matched.length} of ${rows.length} substring hits`)
    for (const r of matched.slice(0, 5)) {
      console.log(`       "${(r.raw_description ?? '').slice(0, 70)}"  ${r.total_excl_vat ?? '?'} SEK  ${(r.supplier_name_snapshot ?? '?').slice(0, 28)}`)
    }
    if (unmatched.length > 0) {
      console.log(`    [${biz.name.padEnd(7)}] substring matched but regex did NOT (worth inspecting):`)
      for (const r of unmatched.slice(0, 3)) {
        console.log(`       "${(r.raw_description ?? '').slice(0, 70)}"`)
      }
    }
  }

  // Direction B — any products whose name contains a token? If yes,
  // does the regex catch the product name (= false positive)?
  console.log(`\n  B. FALSE-POSITIVE CHECK (products with token in name):`)
  for (const biz of BIZES) {
    let allProducts = []
    for (const tok of arm.tokens) {
      const ps = await q(`products?business_id=eq.${biz.id}&name=ilike.*${tok}*&select=id,name,category&limit=100`)
      for (const p of ps) allProducts.push(p)
    }
    const uniq = new Map()
    for (const p of allProducts) uniq.set(p.id, p)
    const products = [...uniq.values()]
    if (products.length === 0) {
      console.log(`    [${biz.name.padEnd(7)}] no products hit substring search — clear`)
    } else {
      console.log(`    [${biz.name.padEnd(7)}] ${products.length} product(s) hit substring:`)
      for (const p of products.slice(0, 10)) {
        const catches = arm.js.test(p.name ?? '')
        console.log(`       ${catches ? '!!!' : 'safe'}  ${p.id.slice(0, 8)}  "${p.name}"  [${p.category ?? '?'}]`)
      }
    }
  }
}
