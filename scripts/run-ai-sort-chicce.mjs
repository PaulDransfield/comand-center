// scripts/run-ai-sort-chicce.mjs
// Runs the AI bulk-review classifier for Chicce ONCE, server-side.
// Mirrors the logic in app/api/inventory/review/ai-suggest/route.ts
// but uses the service-role client so it can run from a node script
// without an owner session.
//
// Usage: node --env-file=.env.production.local scripts/run-ai-sort-chicce.mjs

import { createClient } from '@supabase/supabase-js'

const BIZ_ID = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const ORG_ID = '22adf147-91c6-4e6a-840c-d1ab9a415d2f'
const HAIKU  = 'claude-haiku-4-5-20251001'
const MAX_GROUPS = 120   // cap so the JSON response fits in max_tokens

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function normaliseDescription(raw) {
  return String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// 1. Load needs_review lines + build groups
const lines = []
let from = 0
while (true) {
  const { data, error } = await db.from('supplier_invoice_lines')
    .select('supplier_fortnox_number, supplier_name_snapshot, raw_description, unit, price_per_unit, total_excl_vat, invoice_date, account_number')
    .eq('business_id', BIZ_ID).eq('match_status', 'needs_review').range(from, from + 999)
  if (error) throw error
  if (!data?.length) break
  lines.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log('Loaded', lines.length, 'needs_review lines')

const byKey = new Map(), pricesByKey = new Map(), accountsByKey = new Map()
for (const l of lines) {
  const supplierKey = l.supplier_fortnox_number ?? l.supplier_name_snapshot ?? 'unknown'
  const norm = normaliseDescription(l.raw_description)
  const key = Buffer.from(`${supplierKey}|${norm}|${l.unit ?? ''}`).toString('base64url')
  if (!byKey.has(key)) {
    byKey.set(key, {
      group_key: key, supplier_fortnox_number: String(supplierKey),
      supplier_name: l.supplier_name_snapshot ?? null,
      sample_raw_description: String(l.raw_description ?? '').slice(0, 200),
      unit: l.unit, line_count: 0, total_kr: 0,
      median_price: null, most_common_account: null, latest_invoice_date: null,
    })
    pricesByKey.set(key, []); accountsByKey.set(key, new Map())
  }
  const g = byKey.get(key)
  g.line_count++; g.total_kr += Number(l.total_excl_vat ?? 0)
  if (l.price_per_unit != null) pricesByKey.get(key).push(Number(l.price_per_unit))
  if (l.account_number) {
    const t = accountsByKey.get(key)
    t.set(l.account_number, (t.get(l.account_number) ?? 0) + 1)
  }
  if (l.invoice_date && (!g.latest_invoice_date || l.invoice_date > g.latest_invoice_date)) g.latest_invoice_date = l.invoice_date
}
for (const [k, g] of byKey) {
  const prices = pricesByKey.get(k)
  if (prices.length) { const s = [...prices].sort((a,b)=>a-b); g.median_price = s[Math.floor(s.length/2)] }
  const t = accountsByKey.get(k)
  if (t?.size) g.most_common_account = Array.from(t.entries()).sort((a,b)=>b[1]-a[1])[0][0]
}
const groups = Array.from(byKey.values()).sort((a,b)=>b.line_count-a.line_count).slice(0, MAX_GROUPS)
console.log('Built', byKey.size, 'groups (processing top', groups.length, ')')

// 2. Load catalogue + aliases + recent outcomes
const { data: products, error: prodErr } = await db.from('products').select('id, name, category, invoice_unit')
  .eq('business_id', BIZ_ID).is('archived_at', null).order('name')
if (prodErr) { console.error('products err:', prodErr.message); process.exit(1) }
const { data: aliases } = await db.from('product_aliases')
  .select('product_id, raw_description, supplier_name_snapshot, seen_count')
  .eq('business_id', BIZ_ID).order('seen_count', { ascending: false }).limit(500)
const cutoff = new Date(Date.now() - 60*86400000).toISOString()
const { data: disagreements } = await db.from('inventory_review_outcomes')
  .select('group_key, ai_action, ai_suggested_name, owner_action, owner_chosen_name')
  .eq('business_id', BIZ_ID).eq('agreed', false).gte('created_at', cutoff)
  .order('created_at', { ascending: false }).limit(40)
const { data: agreements } = await db.from('inventory_review_outcomes')
  .select('group_key, ai_action, ai_suggested_name, owner_action')
  .eq('business_id', BIZ_ID).eq('agreed', true).gte('created_at', cutoff)
  .order('created_at', { ascending: false }).limit(20)
console.log('Catalogue:', products?.length, 'products,', aliases?.length, 'aliases,', disagreements?.length, 'disagreements,', agreements?.length, 'agreements')

// 3. Build prompts
const catalogueText = (products ?? []).map(p => `  [${p.id.slice(0,8)}] ${p.name}  (cat:${p.category ?? '?'}, unit:${p.invoice_unit ?? '?'})`).join('\n')
const aliasText = (aliases ?? []).slice(0, 200).map(a => `  ${a.product_id.slice(0,8)} ← ${(a.raw_description ?? '').slice(0,50)} (×${a.seen_count})`).join('\n')
const learningText = [
  ...(disagreements ?? []).map(o => `  AI said "${o.ai_action}/${o.ai_suggested_name ?? '—'}" but owner did "${o.owner_action}/${o.owner_chosen_name ?? '—'}" — LEARN this pattern`),
  ...(agreements ?? []).slice(0, 10).map(o => `  AI said "${o.ai_action}/${o.ai_suggested_name ?? '—'}" → owner agreed`),
].join('\n')
const groupsText = groups.map(g => JSON.stringify({
  key: g.group_key.slice(0, 16), supplier: g.supplier_name ?? g.supplier_fortnox_number,
  desc: g.sample_raw_description, unit: g.unit, n: g.line_count, med_price: g.median_price, acct: g.most_common_account,
})).join('\n')

const SYSTEM = `You are an expert at categorising restaurant supplier invoice lines for a Swedish hospitality business. Your job is to classify each "group" (a set of identical raw descriptions from the same supplier) into ONE of four actions, with a confidence score 0-1.

ACTIONS:
1. approve_existing — the group's raw description clearly refers to an EXISTING product in the catalogue below. Return the product_id (use the [8-char-prefix]) and confidence ≥ 0.85.
2. create_new — the group is a genuine food/drink/cleaning/material product that doesn't exist in the catalogue yet. Suggest a clean Swedish name and category (food/beverage/alcohol/cleaning/takeaway_material/disposables/other).
3. skip_non_inventory — the group is NOT a product the restaurant uses. Examples: pant/deposit returnbacks, freight (frakt), discounts (rabatt), payment fees (faktureringsavgift), öresavrundning, empty/blank descriptions, returns/credits with no product context.
4. review — genuinely ambiguous. Could be a product but description too cryptic, OR could be a service/admin fee, OR fits multiple existing products. Confidence < 0.65.

CALIBRATION:
- ≥0.85 = "I'd bet money on this" — clear product match or unambiguous non-inventory
- 0.65-0.85 = "fairly sure but worth a glance"
- <0.65 = "review" action — defer to owner

Return JSON only, one object per group, in input order:
[
  {"key":"abc12345...","action":"approve_existing|create_new|skip_non_inventory|review","confidence":0.92,"product_id_prefix":"...","suggested_name":"Gurka 6.5kg NL","suggested_category":"food","reasoning":"..."},
  ...
]

Be conservative on approve_existing — better to mark as review than wrongly link two products. Be aggressive on skip_non_inventory — owners hate clicking through obvious junk (returbacks, frakt, etc).`

const userMsg = `EXISTING PRODUCTS:
${catalogueText || '  (no products yet)'}

EXISTING ALIASES:
${aliasText || '  (no aliases yet)'}

${learningText ? `RECENT OWNER OUTCOMES (LEARN from corrections):\n${learningText}\n\n` : ''}GROUPS TO CLASSIFY (${groups.length} total):
${groupsText}

Return JSON array only.`

// 4. Call Claude
console.log('Calling Haiku 4.5...')
const t0 = Date.now()
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({
    model: HAIKU, max_tokens: 16384,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  }),
})
if (!res.ok) { console.error('HTTP', res.status, await res.text()); process.exit(1) }
const json = await res.json()
const tIn = json.usage?.input_tokens ?? 0, tOut = json.usage?.output_tokens ?? 0
const cost = (tIn / 1e6) + (tOut * 5 / 1e6)
console.log(`Response in ${Date.now() - t0}ms — tokens in=${tIn} out=${tOut} cost ~$${cost.toFixed(4)}`)

// 5. Parse + upsert
const rawText = json.content?.[0]?.text ?? ''
const jsonStart = rawText.indexOf('['), jsonEnd = rawText.lastIndexOf(']') + 1
const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd))
console.log('Parsed', parsed.length, 'suggestions')

const prodById = new Map((products ?? []).map(p => [p.id.slice(0, 8), p.id]))
const keyByPrefix = new Map(groups.map(g => [g.group_key.slice(0, 16), g.group_key]))

const rows = []
for (const e of parsed) {
  const fullKey = keyByPrefix.get(e.key)
  if (!fullKey) continue
  const productId = e.action === 'approve_existing' && e.product_id_prefix
    ? prodById.get(String(e.product_id_prefix).slice(0, 8)) ?? null : null
  rows.push({
    org_id: ORG_ID, business_id: BIZ_ID, group_key: fullKey,
    action: e.action, confidence: Math.max(0, Math.min(1, Number(e.confidence ?? 0))),
    product_id: productId,
    suggested_name: e.suggested_name ?? null,
    suggested_category: e.suggested_category ?? null,
    reasoning: String(e.reasoning ?? '').slice(0, 500),
    ai_model: HAIKU,
    tokens_input: Math.round(tIn / parsed.length),
    tokens_output: Math.round(tOut / parsed.length),
  })
}
// Dedupe by group_key before upsert — Claude can hallucinate the same
// 16-char prefix twice. Last entry wins.
const dedupMap = new Map()
for (const r of rows) dedupMap.set(r.group_key, r)
const dedupedRows = Array.from(dedupMap.values())
if (dedupedRows.length !== rows.length) console.log('Deduped', rows.length, '→', dedupedRows.length, 'rows')
const { error: upErr } = await db.from('inventory_review_suggestions').upsert(dedupedRows, { onConflict: 'business_id,group_key' })
if (upErr) { console.error('Upsert failed:', upErr.message); process.exit(1) }

// 6. Summary
const byAction = {}
const byConf = { hi: 0, mid: 0, lo: 0 }
for (const r of dedupedRows) {
  byAction[r.action] = (byAction[r.action] ?? 0) + 1
  if (r.confidence >= 0.85) byConf.hi++
  else if (r.confidence >= 0.65) byConf.mid++
  else byConf.lo++
}
console.log('\n=== SUMMARY ===')
console.log('By action:', byAction)
console.log('By confidence: ≥85%:', byConf.hi, ' 65-85%:', byConf.mid, ' <65%:', byConf.lo)
console.log('High-confidence approve_existing:', dedupedRows.filter(r => r.action === 'approve_existing' && r.confidence >= 0.85).length)
console.log('High-confidence skip_non_inventory:', dedupedRows.filter(r => r.action === 'skip_non_inventory' && r.confidence >= 0.85).length)
console.log('High-confidence create_new:', dedupedRows.filter(r => r.action === 'create_new' && r.confidence >= 0.85).length)
console.log('Review (low-conf):', dedupedRows.filter(r => r.action === 'review').length)
