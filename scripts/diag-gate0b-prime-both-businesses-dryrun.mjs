#!/usr/bin/env node
// scripts/diag-gate0b-prime-both-businesses-dryrun.mjs
//
// Gate 0b-prime both-businesses dry-run (per Refinement 2 of
// apply-vero-queue-staging-prompt.md).
//
// New matcher rule: empty raw_description + source='fortnox_row' +
// positive BAS food/alcohol/cleaning/disposables account → not_inventory.
//
// Today's behaviour (lines 188-195 pre-patch): empty raw_description
// returns 'needs_review' unconditionally. The new rule inverts that for
// the source-blank + positive-BAS combination.
//
// This dry-run scans CURRENT supplier_invoice_lines at both businesses
// to enumerate what the new rule WOULD terminal-state if it ran today
// on the entire population — confirming Chicce has no class of source-
// blank-empty lines that are actually reviewable/recoverable.
//
// Read-only. Does not call matchInvoiceLine — just simulates the new
// rule's predicate.

import { readFileSync } from 'node:fs'

function parseEnv(p) {
  try {
    return Object.fromEntries(readFileSync(p, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function qPaged(path, ps = 1000) {
  const out = []
  let from = 0
  while (true) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await fetch(`${URL}/rest/v1/${path}${sep}limit=${ps}&offset=${from}`, { headers: H })
    if (!r.ok) throw new Error(`${path}: ${r.status}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < ps) break
    from += ps
  }
  return out
}

// Mirror categories.ts categoryForBasAccount
const SPECIFIC_OVERRIDES = {
  '4010':'food','4011':'alcohol','4012':'beverage','4013':'food','4014':'food',
  '4015':'disposables','4016':'food','4017':'takeaway_material','4018':'takeaway_material','4019':'food',
  '4020':'food','4030':'food','4040':'food','4050':'food','4060':'food','4070':'food','4080':'food','4090':'food',
  '4021':'beverage','4022':'beverage','4023':'beverage','4024':'beverage',
  '4025':'alcohol','4026':'alcohol','4027':'alcohol','4028':'alcohol',
  '4110':'food','4120':'food',
  '5410':'disposables','5411':'disposables','5420':'disposables',
  '5460':'cleaning','5461':'cleaning','5462':'cleaning','5470':'disposables',
}
function categoryForBasAccount(a) {
  if (!a) return null
  const t = String(a).trim()
  if (!t) return null
  if (SPECIFIC_OVERRIDES[t]) return SPECIFIC_OVERRIDES[t]
  if (/^4\d{3}$/.test(t)) return 'food'
  return null
}

function isEmpty(s) { return s == null || String(s).trim() === '' }

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

for (const [name, bid] of [['Chicce', CHICCE], ['Vero', VERO]]) {
  console.log(`\n${'═'.repeat(78)}\n  ${name}\n${'═'.repeat(78)}`)

  // Pull every line — we want to see what Gate 0b-prime would have done
  // historically AND what it would do now. Includes already-terminal lines
  // (matched, not_inventory) for completeness.
  const all = await qPaged(
    `supplier_invoice_lines?select=id,raw_description,account_number,source,match_status,supplier_name_snapshot,total_excl_vat&business_id=eq.${bid}`
  )
  console.log(`  Total lines: ${all.length}`)

  // Empty + source='fortnox_row' + positive-BAS = would be flipped by new rule
  const flipped = all.filter(r =>
    isEmpty(r.raw_description) &&
    r.source === 'fortnox_row' &&
    categoryForBasAccount(r.account_number) != null &&
    categoryForBasAccount(r.account_number) !== 'other'
  )
  console.log(`\n  Rule would FLIP (empty + source=fortnox_row + positive-BAS): ${flipped.length}`)

  // Split by current match_status
  const flipByStatus = {}
  for (const r of flipped) flipByStatus[r.match_status] = (flipByStatus[r.match_status] ?? 0) + 1
  console.log(`    by current match_status:`)
  for (const [k,v] of Object.entries(flipByStatus).sort((a,b)=>b[1]-a[1])) console.log(`      ${k.padEnd(20)} ${v}`)

  // Net new effect on each business: flips that are currently needs_review
  const nrFlips = flipped.filter(r => r.match_status === 'needs_review')
  console.log(`    of which currently needs_review (real effect post-deploy on existing data):  ${nrFlips.length}`)

  // CRITICAL — Refinement 1 guard: confirm zero pdf_extraction-source empties
  // would be flipped. The rule's source filter excludes them by construction,
  // but verify there are none in the population that match the other criteria
  // and would be missed if someone later removed the source guard.
  const pdfEmpties = all.filter(r =>
    isEmpty(r.raw_description) &&
    r.source === 'pdf_extraction' &&
    categoryForBasAccount(r.account_number) != null
  )
  console.log(`\n  REFINEMENT 1 GUARD — pdf_extraction empties with positive-BAS (these MUST NOT be flipped): ${pdfEmpties.length}`)
  if (pdfEmpties.length > 0) {
    console.log(`    These would be needs_review (correctly), per the source filter. Sample 5:`)
    for (const r of pdfEmpties.slice(0, 5)) {
      console.log(`      [${(r.supplier_name_snapshot ?? '?').slice(0,30).padEnd(30)}] acct=${r.account_number ?? '?'} status=${r.match_status} amount=${Number(r.total_excl_vat ?? 0).toFixed(0)}`)
    }
  } else {
    console.log(`    (none in current data — but the source filter protects future pdf_extraction lines)`)
  }

  // Account distribution among flipped (top 10)
  const acctDist = new Map()
  for (const r of flipped) acctDist.set(r.account_number, (acctDist.get(r.account_number) ?? 0) + 1)
  const acctSorted = [...acctDist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)
  console.log(`\n  Account distribution among flipped (top 10):`)
  for (const [a,n] of acctSorted) console.log(`    ${a}: ${n}`)

  // Supplier distribution among flipped (top 10)
  const supDist = new Map()
  for (const r of flipped) supDist.set(r.supplier_name_snapshot ?? '?', (supDist.get(r.supplier_name_snapshot ?? '?') ?? 0) + 1)
  const supSorted = [...supDist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)
  console.log(`\n  Supplier distribution among flipped (top 10):`)
  for (const [s,n] of supSorted) console.log(`    ${String(n).padStart(4)}× ${s}`)
}

console.log(`\nDone. Read-only — no writes.`)
