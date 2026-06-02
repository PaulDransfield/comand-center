// run-noprice-auto-repoint.mjs
//
// For each recipe-referenced product with no_price (no linked supplier
// invoice line), find the candidate supplier line at this business that
// IS linked to a DIFFERENT product, ask Haiku whether the two products
// are the same real-world item, and — if yes AND the other product is
// recipe-orphan — repoint the alias.
//
// Safety gates:
//   - LLM confidence floor 0.90
//   - The OTHER product (currently linked) MUST have zero recipe references.
//     If it's also recipe-referenced, this is a merge problem; flag for owner.
//   - Salt M JOD vs U JOD class — LLM must understand the words, not just
//     trigram similarity. The prompt loads the "lexical similarity ≠
//     meaning" principle directly.
//
// Usage:
//   node scripts/diag/run-noprice-auto-repoint.mjs           # DRY
//   node scripts/diag/run-noprice-auto-repoint.mjs --apply

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY
if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1) }

const APPLY = process.argv.includes('--apply')
const MODEL = 'claude-haiku-4-5-20251001'

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

function tokens(s) {
  return new Set(String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{Letter}\s]/gu, ' ').split(/\s+/).filter(t => t.length >= 3))
}
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

// normalisedRoot — same shape as duplicate-products-step1.mjs. Strips
// pack tokens / supplier-code suffixes / parentheticals so two
// fragments of the same SKU collapse to one root. Preserves
// distinguishing tokens (FRYST = frozen, EKO = organic, PET = plastic
// container) because those are real product differences.
//
// 2026-06-02 extension — used as a SECOND candidate signal alongside
// Jaccard, so cases like "Crema al formaggio Pecorino 580 gr" vs
// "Crema al formaggio Pecorino 580g" cluster together (Jaccard would
// score them at 0.27 — below the floor — because '580' is short and
// 'gr'/'g' are stripped).
function normalisedRoot(name) {
  if (!name) return ''
  let s = String(name).toLowerCase().normalize('NFKD')
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\b(sc|rb|se|kl1|st|stk)\b/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr|gram|ml|cl|dl|l|liter|litre|eg|st|stk)?\b/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|hg|g|gr|gram|ml|cl|dl|l|liter|litre|lt|lf|eg|st|stk|burk|flaska|paket|pkt|frp|fp|pack)\b/g, ' ')
  s = s.replace(/[^\p{Letter}\s]/gu, ' ')
  const toks = s.split(/\s+/).filter(t => t.length >= 3)
  const dist = new Set()
  for (const t of toks) {
    if (t === 'frys' || t === 'fryst') dist.add('@frozen')
    if (t === 'eko' || t === 'ekologisk') dist.add('@organic')
    if (t === 'pet') dist.add('@pet')
  }
  const core = toks
    .filter(t => !['frys','fryst','eko','ekologisk','pet','varav','pant','per','enhet','sek','och','med','utan'].includes(t))
    .sort()
  return [...core, ...[...dist].sort()].join(' ')
}

const SYSTEM_PROMPT = `You're disambiguating duplicate restaurant supplier products. For each input PRODUCT, you receive 1-3 candidate supplier-invoice descriptions. Your job:

  STEP 1 — Scan the candidates. Find the ONE that best matches the input product (if any do). Note its index.
  STEP 2 — Judge whether THAT chosen candidate (and ONLY that one) refers to the same real-world item as the input product.

The other candidates are decoys — they're nearby but may be different products. Your verdict reflects the chosen-best candidate ONLY. The existence of a different-product candidate in the list does NOT make the overall verdict 'different'; it only matters if NO candidate matches.

Two products are THE SAME real-world item when they differ only by:
  - Letter case (DIJONSENAP vs Dijonsenap)
  - Word order (STRÖBRÖD PANKO vs Panko ströbröd)
  - Abbreviation (URKÄ vs Urkärna)
  - Trailing supplier codes (SC 4x500g RB (21451) SE — ignore them)
  - Deposit/pant suffixes ("Varav pant per enhet: 0,80" — ignore)

They are DIFFERENT when they differ in meaning:
  - "M Jod" (med jod = WITH iodine) vs "U Jod" (utan jod = WITHOUT iodine) → DIFFERENT
  - "EKO" / "Eko" / "ekologisk" (organic) vs plain → DIFFERENT
  - "FRYS" / "Fryst" (frozen) vs fresh → DIFFERENT
  - "1KG" vs "500g" or "720g" vs "2kg" → DIFFERENT (different pack sizes)

For each input product, output:
  match_index: 0, 1, 2 — the chosen-best candidate's index (or null if NONE match the input)
  verdict:     'same'      — chosen candidate is the same real-world item
               'different' — NO candidate matches the input
               'uncertain' — ambiguous; we'll leave it for the owner
  confidence:  0.0 to 1.0 (we only act on >= 0.90)
  reasoning:   ONE short sentence about the chosen candidate

EXAMPLES:
  Input: "Dijonsenap 720g"
  Candidates: [0]="DIJONSENAP 720G"  [1]="Dijon Senap EKO 2kg"  [2]="Dijon mustard 720g organic"
  Output: { "match_index": 0, "verdict": "same", "confidence": 0.99, "reasoning": "Candidate [0] is the same non-organic 720g Dijon mustard (case-only difference); [1] and [2] are different pack sizes / organic." }

  Input: "Salt Fint M Jod 12,5kg"
  Candidates: [0]="SALT FINT M JOD 12,5KG"  [1]="Falksalt 12,5kg fint u jod"
  Output: { "match_index": 0, "verdict": "same", "confidence": 0.99, "reasoning": "Candidate [0] same product (case-only); [1] is U JOD (without iodine) — different." }

  Input: "Spenat fryst 1kg"
  Candidates: [0]="Spenat färsk 1kg"  [1]="Spenat fryst hackad 500g"
  Output: { "match_index": null, "verdict": "different", "confidence": 0.92, "reasoning": "Neither candidate matches: [0] is fresh not frozen; [1] is half the pack size." }

OUTPUT: Return ONLY valid JSON (no markdown, no commentary):

{
  "items": [
    { "product_id": "<uuid>", "match_index": <0-based index, or null>, "verdict": "same|different|uncertain", "confidence": <0.0-1.0>, "reasoning": "<1 short sentence about the chosen candidate>" }
  ]
}

Include every product_id from the input.`

async function callHaiku(pairs) {
  // pairs: [{ product_id, name, candidates: [{ idx, raw_description, supplier_name }] }]
  const lines = pairs.map(p => {
    const cands = p.candidates.map((c, i) => `    [${i}] "${c.raw_description}" (${c.supplier_name ?? '?'})`).join('\n')
    return `product_id=${p.product_id}\n  product name: "${p.name}"\n  candidates:\n${cands}`
  }).join('\n\n')
  const userMsg = `For each product, pick the best matching candidate (if any) and rule whether they refer to the same real-world item:\n\n${lines}`

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }] }),
  })
  if (!r.ok) return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}` }
  const j = await r.json()
  const text = (j.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON', raw: text.slice(0, 500) }
  let parsed
  try { parsed = JSON.parse(text.slice(start, end + 1)) }
  catch (e) { return { ok: false, error: `JSON: ${e.message}`, raw: text.slice(0, 500) } }
  return { ok: true, items: parsed.items ?? [], tokensIn: j.usage?.input_tokens ?? 0, tokensOut: j.usage?.output_tokens ?? 0 }
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. recipe ids
  const recipeIds = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('recipes').select('id').eq('business_id', biz.id).order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) recipeIds.push(r.id)
    if (data.length < 1000) break
    from += 1000
  }

  // 2. recipe_ingredients
  const ingredients = []
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data } = await db.from('recipe_ingredients').select('product_id, recipe_id').in('recipe_id', slice).not('product_id', 'is', null)
    ingredients.push(...(data ?? []))
  }
  const productIds = [...new Set(ingredients.map(i => i.product_id))]

  // Build recipe-references-per-product map. We'll need it to verify
  // the safety condition (other product is recipe-orphan).
  const recipeRefsByProduct = new Map()
  for (const i of ingredients) {
    const arr = recipeRefsByProduct.get(i.product_id) ?? []
    arr.push(i.recipe_id)
    recipeRefsByProduct.set(i.product_id, arr)
  }

  // 3. products (recipe-referenced subset)
  const products = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data } = await db.from('products').select('id, name, price_override').in('id', slice)
    for (const p of data ?? []) products.set(p.id, p)
  }

  // 4. aliases per product → fast lookup of has-any-price?
  const aliasesByProduct = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data } = await db.from('product_aliases').select('id, product_id').in('product_id', slice)
    for (const a of data ?? []) {
      const arr = aliasesByProduct.get(a.product_id) ?? []
      arr.push(a.id); aliasesByProduct.set(a.product_id, arr)
    }
  }
  const allAliasIds = [...new Set([...aliasesByProduct.values()].flat())]
  const aliasHasLine = new Set()
  for (let i = 0; i < allAliasIds.length; i += 200) {
    const slice = allAliasIds.slice(i, i + 200)
    const { data } = await db.from('supplier_invoice_lines').select('product_alias_id').eq('business_id', biz.id).eq('match_status', 'matched').in('product_alias_id', slice).limit(2000)
    for (const l of data ?? []) aliasHasLine.add(l.product_alias_id)
  }

  // 5. no_price recipe-referenced products
  const noPrice = []
  for (const pid of productIds) {
    const p = products.get(pid)
    if (!p || p.price_override != null) continue
    const aliases = aliasesByProduct.get(pid) ?? []
    if (aliases.some(aid => aliasHasLine.has(aid))) continue
    noPrice.push(p)
  }
  console.log(`  no_price recipe-referenced products: ${noPrice.length}`)
  if (noPrice.length === 0) continue

  // 6. supplier lines (full pagination)
  const allLines = []
  let lfrom = 0
  while (lfrom < 50000) {
    const { data } = await db.from('supplier_invoice_lines')
      .select('id, raw_description, supplier_name_snapshot, product_alias_id, match_status')
      .eq('business_id', biz.id)
      .order('id').range(lfrom, lfrom + 999)
    if (!data || data.length === 0) break
    allLines.push(...data)
    if (data.length < 1000) break
    lfrom += 1000
  }
  console.log(`  supplier lines in scope: ${allLines.length}`)

  // 7. For each no_price product, gather top-3 matched-elsewhere
  // candidates. Combine TWO signals:
  //   (a) Jaccard >= 0.30 on raw_description (lexical similarity)
  //   (b) normalisedRoot equality on raw_description (catches space/case
  //       variants Jaccard misses — e.g. "580 gr" vs "580g")
  //
  // A line passing EITHER signal qualifies; the LLM still verifies.
  const noPriceRoot = new Map(noPrice.map(p => [p.id, normalisedRoot(p.name)]))
  const pairs = []
  for (const p of noPrice) {
    const root = noPriceRoot.get(p.id)
    const matched = []
    for (const l of allLines) {
      if (!l.product_alias_id) continue   // unmatched line — direct-link case, not repoint
      const sim     = jaccard(p.name, l.raw_description)
      const rootEq  = root && normalisedRoot(l.raw_description) === root
      if (sim >= 0.30 || rootEq) {
        // For ranking, prefer normalised-root hits (perfect signal) over
        // raw Jaccard. Boost rootEq candidates above 0.30 by encoding
        // them as sim=1.0.
        matched.push({ ...l, sim: rootEq ? Math.max(sim, 0.99) : sim })
      }
    }
    matched.sort((a, b) => b.sim - a.sim)
    const top3 = matched.slice(0, 3)
    if (top3.length === 0) continue
    pairs.push({
      product_id: p.id,
      name:       p.name,
      candidates: top3.map((c, idx) => ({ idx, raw_description: c.raw_description, supplier_name: c.supplier_name_snapshot, alias_id: c.product_alias_id })),
    })
  }
  console.log(`  no_price products with matched-elsewhere candidates: ${pairs.length}`)
  if (pairs.length === 0) continue

  // 8. Ask Haiku for verdicts.
  console.log(`  → calling Haiku`)
  const r = await callHaiku(pairs)
  if (!r.ok) { console.error(`    FAILED: ${r.error}`); if (r.raw) console.error(r.raw); continue }
  console.log(`  Tokens: in=${r.tokensIn} out=${r.tokensOut} (~$${(r.tokensIn * 0.000001 + r.tokensOut * 0.000005).toFixed(4)})`)

  // 9. For each verdict, check safety + queue repoint.
  const repoints = []   // safe → will apply
  const flagged  = []   // LLM verdict ok but other-product still recipe-referenced → owner merge decision
  const rejected = []   // LLM verdict different/uncertain
  for (const it of r.items) {
    const pid  = String(it.product_id ?? '')
    const mi   = it.match_index
    const conf = Number(it.confidence)
    const verdict = String(it.verdict ?? '')
    const rsn  = String(it.reasoning ?? '').slice(0, 200)
    const pair = pairs.find(p => p.product_id === pid)
    if (!pair) continue
    if (verdict !== 'same' || !Number.isFinite(conf) || conf < 0.90 || mi == null) {
      rejected.push({ pair, verdict, conf, rsn }); continue
    }
    const cand = pair.candidates[mi]
    if (!cand) { rejected.push({ pair, verdict, conf, rsn: 'invalid match_index' }); continue }
    // Find which OTHER product the alias currently points to.
    const { data: aliasRow } = await db.from('product_aliases').select('id, product_id').eq('id', cand.alias_id).maybeSingle()
    if (!aliasRow) { rejected.push({ pair, verdict, conf, rsn: 'alias not found' }); continue }
    const otherProductId = aliasRow.product_id
    if (otherProductId === pid) { rejected.push({ pair, verdict, conf, rsn: 'alias already points here' }); continue }
    // Is the OTHER product also recipe-referenced? If yes, this is a merge problem.
    const otherRefs = recipeRefsByProduct.get(otherProductId) ?? []
    if (otherRefs.length > 0) {
      flagged.push({ pair, cand, otherProductId, otherRefs: otherRefs.length, conf, rsn })
      continue
    }
    repoints.push({ pair, cand, aliasId: cand.alias_id, otherProductId, conf, rsn })
  }

  console.log(`\n  Safe to auto-repoint:           ${repoints.length}`)
  console.log(`  Flagged (other prod has recipes): ${flagged.length}`)
  console.log(`  Rejected (LLM not confident):   ${rejected.length}`)

  if (repoints.length > 0) {
    console.log(`\n  Auto-repoint queue:`)
    for (const r of repoints) {
      console.log(`    • "${r.pair.name}"`)
      console.log(`        ← alias ${r.aliasId} (currently points to other product ${r.otherProductId}; orphan)`)
      console.log(`        reasoning: ${r.rsn} (conf ${r.conf.toFixed(2)})`)
    }
  }
  if (flagged.length > 0) {
    console.log(`\n  FLAGGED (owner merge decision needed):`)
    for (const f of flagged) {
      console.log(`    • "${f.pair.name}"`)
      console.log(`        candidate: "${f.cand.raw_description}"`)
      console.log(`        currently linked to product ${f.otherProductId} which is in ${f.otherRefs} recipe(s)`)
      console.log(`        reasoning: ${f.rsn} (conf ${f.conf.toFixed(2)})`)
    }
  }
  if (rejected.length > 0) {
    console.log(`\n  Rejected:`)
    for (const r of rejected) {
      console.log(`    • "${r.pair.name}" — verdict=${r.verdict} conf=${r.conf} (${r.rsn})`)
    }
  }

  // 10. APPLY repoints via direct UPDATE on product_aliases.product_id.
  // (Mirrors what /api/inventory/product-aliases/[id]/repoint does — see
  // that route for the propagation design; the cost engine reads the
  // new pointer on next render, no cascade needed.)
  if (APPLY && repoints.length > 0) {
    console.log(`\n  APPLYING ${repoints.length} repoints…`)
    let applied = 0
    for (const r of repoints) {
      const { error } = await db.from('product_aliases')
        .update({ product_id: r.pair.product_id })
        .eq('id', r.aliasId)
      if (error) { console.error(`    ${r.aliasId} failed: ${error.message}`); continue }
      applied++
    }
    console.log(`  Applied: ${applied}`)
  } else if (repoints.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
  }
}

console.log('\ndone')
