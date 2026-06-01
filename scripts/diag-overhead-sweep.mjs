#!/usr/bin/env node
// READ-ONLY discovery sweep — find overhead-cost lines hiding in the
// needs_review queue at Chicce + Vero. Same pattern as the lokalhyra
// dry-run: for each candidate token, count + sample lines, then
// cross-check product names for false-positive risk.
//
// Builds the data to decide which M113 arms to ship and which to skip.

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

// Candidate categories with the tokens to search for. Each entry says
// what the category IS (so we don't get false-positive flagged) and
// what tokens we look for. Tokens are SUBSTRINGS — we'll see what
// matches, then propose anchored / compound regex per category based
// on the real strings.
const CANDIDATES = [
  { cat: 'Electricity',  tokens: ['elnät', 'eldistribution', 'fjärrvärme', 'energiskatt', 'effektabonn'] },
  { cat: 'Water',        tokens: ['vatten och avlopp', 'va-avgift', 'va avgift', 'spillvatten'] },
  { cat: 'Internet/Phone', tokens: ['bredband', 'telefonabonn', 'mobilabonn'] },
  { cat: 'Insurance',    tokens: ['försäkringspremie', 'företagsförsäkring', 'företagspaket', 'sjukvårdsförsäkring'] },
  { cat: 'Cleaning',     tokens: ['städabonnemang', 'städavtal', 'hemfrid', 'mattabonn'] },
  { cat: 'Accounting/Audit', tokens: ['revisionsarvode', 'redovisningsarvode', 'bokföringsarvode', 'lönehantering'] },
  { cat: 'Bank fees',    tokens: ['bankavgift', 'kortinlösen', 'betalningsförmedling', 'månadsavgift swish'] },
  { cat: 'Pension',      tokens: ['tjänstepension', 'pensionsförsäkring', 'kollektivavtal'] },
  { cat: 'Software/IT',  tokens: ['programvarulicens', 'molntjänst', 'sas hosting', 'månadsabonnemang'] },
  { cat: 'Garbage',      tokens: ['sophämtning', 'avfallshantering', 'restavfall'] },
  { cat: 'Security',     tokens: ['larmtjänst', 'larmabonnemang', 'bevakningsavgift'] },
  { cat: 'Marketing',    tokens: ['annonsering', 'reklamavtal', 'sociala medier'] },
  { cat: 'Subscriptions (generic)', tokens: ['månadsabonnemang', 'årsavgift', 'medlemsavgift', 'serviceavtal'] },
]

console.log('Discovery sweep — needs_review overhead candidates\n')
console.log('Format: count [biz] — token  → sample raw_description')
console.log('=' .repeat(100))

const allHits = []

for (const cand of CANDIDATES) {
  for (const token of cand.tokens) {
    let totalForToken = 0
    const samples = []
    for (const biz of BIZES) {
      const rows = await q(`supplier_invoice_lines?business_id=eq.${biz.id}&match_status=eq.needs_review&product_alias_id=is.null&raw_description=ilike.*${encodeURIComponent(token)}*&select=raw_description,supplier_name_snapshot,total_excl_vat&limit=30`)
      if (rows.length === 0) continue
      totalForToken += rows.length
      for (const r of rows.slice(0, 3)) {
        samples.push({ biz: biz.name, ...r })
      }
      allHits.push({ category: cand.cat, token, biz: biz.name, count: rows.length, samples: rows.slice(0, 5) })
    }
    if (totalForToken > 0) {
      console.log(`\n[${cand.cat}] token "${token}" — ${totalForToken} lines total:`)
      for (const s of samples.slice(0, 6)) {
        console.log(`  [${s.biz.padEnd(7)}] ${(s.raw_description ?? '').slice(0, 70).padEnd(70)}  ${s.total_excl_vat ?? '?'} SEK  ← ${(s.supplier_name_snapshot ?? '?').slice(0, 30)}`)
      }
    }
  }
}

console.log('\n\n' + '='.repeat(100))
console.log('SUMMARY by category (only categories with hits):')
const byCategory = new Map()
for (const h of allHits) {
  const cur = byCategory.get(h.category) ?? { tokens: new Set(), totalLines: 0, bizSet: new Set() }
  cur.tokens.add(h.token)
  cur.totalLines += h.count
  cur.bizSet.add(h.biz)
  byCategory.set(h.category, cur)
}
for (const [cat, info] of [...byCategory.entries()].sort((a, b) => b[1].totalLines - a[1].totalLines)) {
  console.log(`  ${cat.padEnd(28)} ${info.totalLines.toString().padStart(5)} lines  · tokens: [${[...info.tokens].join(', ')}]  · biz: [${[...info.bizSet].join(', ')}]`)
}
