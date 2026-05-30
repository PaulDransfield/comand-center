#!/usr/bin/env node
// scripts/diag-p20-precommit-snapshot.mjs
//
// Pre-commit snapshot for P2.0 voucher back-fill. Two read-only checks
// before drafting the M108 migration:
//
//   1. inventory_review_outcomes.context distribution — confirm only
//      'needs_review' and 'audit_sample' exist, so widening the CHECK
//      to add 'rebate_guard_backfill' doesn't strand existing rows.
//
//   2. Eyeball list of the matched-with-alias rebate lines Op 2 would
//      clear. Per alias (raw_description + product name + supplier +
//      match method/confidence), so the owner confirms none of them is
//      a surprise real product caught by the rebate guard.
//
// No writes. No side effects.

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
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Same revised pattern as the dry-run script.
const REBATE_PATTERN = /(avtalsrabatt|^rabatt|^pant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

async function qPaged(path, pageSize = 1000) {
  const out = []
  let from = 0
  while (true) {
    const sep = path.includes('?') ? '&' : '?'
    const url = `${URL}/rest/v1/${path}${sep}limit=${pageSize}&offset=${from}`
    const r = await fetch(url, { headers: { ...H, 'Prefer': 'count=exact' } })
    if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return out
}

// ──────────────────────────────────────────────────────────────────
// Check 1 — context distribution
// ──────────────────────────────────────────────────────────────────

console.log('═'.repeat(78))
console.log('  CHECK 1 — inventory_review_outcomes.context distribution')
console.log('═'.repeat(78))

const outcomes = await qPaged('inventory_review_outcomes?select=context')
const distrib = new Map()
for (const r of outcomes) {
  const k = r.context ?? '(null)'
  distrib.set(k, (distrib.get(k) ?? 0) + 1)
}

console.log(`  Total rows scanned: ${outcomes.length}`)
console.log(`  Distinct context values:`)
for (const [k, n] of [...distrib.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(28)} ${n}`)
}

const M108_VALUES = new Set(['needs_review', 'audit_sample', 'rebate_guard_backfill'])
const stranded = [...distrib.keys()].filter(k => k !== '(null)' && !M108_VALUES.has(k))
if (stranded.length > 0) {
  console.log(`\n  ⚠️ STRAND ALERT: ${stranded.length} value(s) NOT covered by M108 CHECK:`)
  for (const v of stranded) console.log(`     "${v}"`)
  console.log(`     M108 must include these or it will fail to apply.`)
} else {
  console.log(`\n  CLEAN: all existing context values covered by M108 CHECK widening.`)
}

// ──────────────────────────────────────────────────────────────────
// Check 2 — eyeball list of aliases Op 2 would clear
// ──────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(78))
console.log('  CHECK 2 — Aliases that Op 2 would clear (per business)')
console.log('═'.repeat(78))

async function reportBusiness(label, businessId) {
  console.log(`\n  ── ${label} ──`)
  const lines = await qPaged(
    `supplier_invoice_lines?` +
    `select=id,raw_description,match_status,product_alias_id,supplier_name_snapshot` +
    `&business_id=eq.${businessId}` +
    `&product_alias_id=not.is.null` +
    `&match_status=eq.matched`
  )
  const rebateLines = lines.filter(l => l.raw_description && REBATE_PATTERN.test(l.raw_description))
  console.log(`  Total matched-with-alias lines:           ${lines.length}`)
  console.log(`  Of which rebate-guard catches:            ${rebateLines.length}`)

  if (rebateLines.length === 0) {
    console.log(`  → 0 alias clears for ${label}.`)
    return { aliasCount: 0, lineCount: 0 }
  }

  const byAlias = new Map()
  for (const l of rebateLines) {
    const a = byAlias.get(l.product_alias_id) ?? { lines: 0, sampleDesc: l.raw_description }
    a.lines += 1
    byAlias.set(l.product_alias_id, a)
  }
  console.log(`  Distinct alias_ids cleared:               ${byAlias.size}`)

  const aliasIds = [...byAlias.keys()]
  const aliasList = aliasIds.map(id => `"${id}"`).join(',')
  const aliases = await q(`product_aliases?select=id,raw_description,supplier_name_snapshot,supplier_fortnox_number,match_method,match_confidence,seen_count,product_id,first_seen_at&id=in.(${aliasList})`)
  const aliasById = new Map(aliases.map(a => [a.id, a]))

  const productIds = [...new Set(aliases.map(a => a.product_id).filter(Boolean))]
  const products = productIds.length === 0 ? [] : await q(`products?select=id,name,category,base_unit&id=in.(${productIds.map(id => `"${id}"`).join(',')})`)
  const productById = new Map(products.map(p => [p.id, p]))

  const rows = []
  for (const [aliasId, info] of byAlias.entries()) {
    const alias = aliasById.get(aliasId) ?? null
    const product = alias?.product_id ? (productById.get(alias.product_id) ?? null) : null
    rows.push({ aliasId, info, alias, product })
  }
  rows.sort((a, b) => b.info.lines - a.info.lines)

  console.log(`\n  EYEBALL — aliases that would be unlinked (sorted by lines affected desc):`)
  console.log(`  ${'─'.repeat(74)}`)
  for (const r of rows) {
    const a = r.alias
    const p = r.product
    if (!a) {
      console.log(`  [alias ${r.aliasId.slice(0, 8)}… NOT FOUND] lines=${r.info.lines}`)
      console.log(`    sample line desc: "${r.info.sampleDesc}"`)
      continue
    }
    console.log(`  alias=${a.id.slice(0, 8)}…  lines=${r.info.lines}  seen=${a.seen_count}  first=${(a.first_seen_at ?? '').slice(0, 10)}`)
    console.log(`    alias raw_description: "${a.raw_description}"`)
    console.log(`    product:               "${p?.name ?? '(deleted)'}"  category=${p?.category ?? '?'}`)
    console.log(`    supplier:              "${a.supplier_name_snapshot ?? '?'}"  (#${a.supplier_fortnox_number})`)
    console.log(`    match_method:          ${a.match_method}  confidence=${a.match_confidence ?? 'n/a'}`)
    console.log(`    sample line desc:      "${r.info.sampleDesc}"`)
    console.log()
  }

  return { aliasCount: byAlias.size, lineCount: rebateLines.length }
}

const chiccte = await reportBusiness('Chicce Slotsgatan', CHICCE)
const vero    = await reportBusiness('Vero Italiano', VERO)

console.log('═'.repeat(78))
console.log('  SUMMARY')
console.log('═'.repeat(78))
console.log(`  Chicce: ${chiccte.aliasCount} aliases / ${chiccte.lineCount} lines would be cleared`)
console.log(`  Vero:   ${vero.aliasCount} aliases / ${vero.lineCount} lines would be cleared`)
console.log(`  TOTAL outcome rows the transaction would insert: ${chiccte.aliasCount + vero.aliasCount}`)
console.log('\nDone. Read-only — no rows changed.')
