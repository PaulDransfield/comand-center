// lib/inventory/ai-suggest-core.ts
//
// Core of the AI-assisted bulk-review classifier, extracted from
// app/api/inventory/review/ai-suggest/route.ts so it can be reused by the
// concierge onboarding catalogue auto-build worker without duplicating the
// Haiku prompt / grouping / caching logic.
//
// The route keeps its own auth + quota gate + 24h cache-check and delegates
// the grouping + Claude call here. Behaviour is identical to the pre-extract
// route — this is a straight move, not a rewrite.

import { AI_MODELS }          from '@/lib/ai/models'
import { anthropicFetch }     from '@/lib/ai/anthropic-fetch'
import { logAiRequest }       from '@/lib/ai/usage'
import { normaliseDescription } from '@/lib/inventory/normalise'

export const MAX_GROUPS_PER_RUN = 120   // cap so Haiku's JSON response fits in max_tokens

const HAIKU_INPUT_USD_PER_TOKEN  = 1  / 1_000_000
const HAIKU_OUTPUT_USD_PER_TOKEN = 5  / 1_000_000

export interface Group {
  group_key:                string
  supplier_fortnox_number:  string
  supplier_name:            string | null
  sample_raw_description:   string
  normalised_desc:          string
  unit:                     string | null
  line_count:               number
  total_kr:                 number
  median_price:             number | null
  most_common_account:      string | null
  latest_invoice_date:      string | null
}

export function buildGroups(lines: any[]): Group[] {
  const byKey = new Map<string, Group>()
  const pricesByKey = new Map<string, number[]>()
  const accountTallyByKey = new Map<string, Map<string, number>>()
  for (const l of lines) {
    const norm = normaliseDescription(l.raw_description ?? '')
    if (!norm) continue   // GET endpoint skips empty-normalised lines
    // MUST match app/api/inventory/needs-review/route.ts EXACTLY so the
    // group_keys returned here pair to the ones the UI uses:
    //   internal: `${supplier_fortnox_number}\x1f${normalised}\x1f${(unit ?? '').trim().toLowerCase()}`
    //   exposed:  base64url(internal, 'utf-8')
    const unit = (l.unit ?? '').trim().toLowerCase()
    const internal = `${l.supplier_fortnox_number}\x1f${norm}\x1f${unit}`
    const key = Buffer.from(internal, 'utf-8').toString('base64url')
    if (!byKey.has(key)) {
      byKey.set(key, {
        group_key:                key,
        supplier_fortnox_number:  String(l.supplier_fortnox_number ?? ''),
        supplier_name:            l.supplier_name_snapshot ?? null,
        sample_raw_description:   String(l.raw_description ?? '').slice(0, 200),
        normalised_desc:          norm,
        unit:                     l.unit,
        line_count:               0,
        total_kr:                 0,
        median_price:             null,
        most_common_account:      null,
        latest_invoice_date:      null,
      })
      pricesByKey.set(key, [])
      accountTallyByKey.set(key, new Map())
    }
    const g = byKey.get(key)!
    g.line_count++
    g.total_kr += Number(l.total_excl_vat ?? 0)
    if (l.price_per_unit != null) pricesByKey.get(key)!.push(Number(l.price_per_unit))
    if (l.account_number) {
      const t = accountTallyByKey.get(key)!
      t.set(l.account_number, (t.get(l.account_number) ?? 0) + 1)
    }
    if (l.invoice_date && (!g.latest_invoice_date || l.invoice_date > g.latest_invoice_date)) {
      g.latest_invoice_date = l.invoice_date
    }
  }
  for (const [k, g] of byKey) {
    const prices = pricesByKey.get(k) ?? []
    if (prices.length > 0) {
      const sorted = [...prices].sort((a, b) => a - b)
      g.median_price = sorted[Math.floor(sorted.length / 2)]
    }
    const accountTally = accountTallyByKey.get(k)
    if (accountTally && accountTally.size > 0) {
      g.most_common_account = Array.from(accountTally.entries()).sort((a, b) => b[1] - a[1])[0][0]
    }
  }
  return Array.from(byKey.values())
}

// One Claude call for up to MAX_GROUPS_PER_RUN groups. Persists results to
// inventory_review_suggestions (unique on business_id,group_key) and returns
// the deduped rows.
export async function runClaudeBatch(
  db:         any,
  orgId:      string,
  businessId: string,
  groups:     Group[],
): Promise<any[]> {
  if (groups.length === 0) return []

  const { data: products } = await db
    .from('products')
    .select('id, name, category, invoice_unit')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
  const { data: aliases } = await db
    .from('product_aliases')
    .select('product_id, raw_description, supplier_name_snapshot, seen_count')
    .eq('business_id', businessId)
    .order('seen_count', { ascending: false })
    .limit(500)

  const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString()
  const { data: disagreements } = await db
    .from('inventory_review_outcomes')
    .select('group_key, ai_action, ai_suggested_name, owner_action, owner_chosen_name')
    .eq('business_id', businessId)
    .eq('agreed', false)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(40)
  const { data: agreements } = await db
    .from('inventory_review_outcomes')
    .select('group_key, ai_action, ai_suggested_name, owner_action')
    .eq('business_id', businessId)
    .eq('agreed', true)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(20)

  const catalogueText = (products ?? []).map((p: any) =>
    `  [${p.id.slice(0, 8)}] ${p.name}  (cat:${p.category ?? '?'}, unit:${p.invoice_unit ?? '?'})`
  ).join('\n')

  const aliasText = (aliases ?? []).slice(0, 200).map((a: any) =>
    `  ${a.product_id.slice(0, 8)} ← ${(a.raw_description ?? '').slice(0, 50)} (×${a.seen_count})`
  ).join('\n')

  const learningText = [
    ...(disagreements ?? []).map((o: any) =>
      `  AI said "${o.ai_action}/${o.ai_suggested_name ?? '—'}" but owner did "${o.owner_action}/${o.owner_chosen_name ?? '—'}" — LEARN: trust this owner pattern`
    ),
    ...(agreements ?? []).slice(0, 10).map((o: any) =>
      `  AI said "${o.ai_action}/${o.ai_suggested_name ?? '—'}" → owner agreed`
    ),
  ].join('\n')

  const groupsText = groups.map(g => JSON.stringify({
    key:      g.group_key.slice(0, 16),
    supplier: g.supplier_name ?? g.supplier_fortnox_number,
    desc:     g.sample_raw_description,
    unit:     g.unit,
    n:        g.line_count,
    med_price: g.median_price,
    acct:     g.most_common_account,
  })).join('\n')

  const SYSTEM_PROMPT = `You are an expert at categorising restaurant supplier invoice lines for a Swedish hospitality business. Your job is to classify each "group" (a set of identical raw descriptions from the same supplier) into ONE of four actions, with a confidence score 0-1.

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
  {
    "key": "abc12345...",          // 16-char prefix of group_key
    "action": "approve_existing" | "create_new" | "skip_non_inventory" | "review",
    "confidence": 0.92,
    "product_id_prefix": "...",     // only when action=approve_existing
    "suggested_name": "Gurka 6.5kg NL",   // only when action=create_new
    "suggested_category": "food",          // only when action=create_new
    "reasoning": "..."              // 1 short sentence, owner-facing
  },
  ...
]

Be conservative on approve_existing — better to mark as review than wrongly link two products. Be aggressive on skip_non_inventory — owners hate clicking through obvious junk (returbacks, frakt, etc).`

  const userMessage = `EXISTING PRODUCTS (you can return their 8-char id prefix in product_id_prefix):
${catalogueText || '  (no products yet)'}

EXISTING ALIASES (raw description → product 8-char prefix, with seen_count):
${aliasText || '  (no aliases yet)'}

${learningText ? `RECENT OWNER OUTCOMES (last 60 days — LEARN from corrections):
${learningText}

` : ''}GROUPS TO CLASSIFY (${groups.length} total):
${groupsText}

Return JSON array only.`

  const result = await anthropicFetch({
    body: {
      model:       AI_MODELS.AGENT,             // Haiku 4.5
      max_tokens:  16384,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: userMessage },
      ],
    },
  })
  if (!result.ok) {
    throw new Error(`Anthropic HTTP ${result.status}: ${result.errorText}`)
  }
  const json = result.json
  const tokensIn  = result.tokensIn
  const tokensOut = result.tokensOut
  const cost = (tokensIn * HAIKU_INPUT_USD_PER_TOKEN) + (tokensOut * HAIKU_OUTPUT_USD_PER_TOKEN)
  console.log(`[ai-suggest] business=${businessId.slice(0,8)} groups=${groups.length} tokens=${tokensIn}/${tokensOut} cache_read=${result.cacheRead} cost=$${cost.toFixed(4)}`)

  await logAiRequest(db, {
    org_id:        orgId,
    request_type:  'inventory_ai_suggest',
    model:         AI_MODELS.AGENT,
    input_tokens:  tokensIn,
    output_tokens: tokensOut,
    duration_ms:   result.durationMs,
  }).catch(() => { /* non-fatal */ })

  const rawText = json?.content?.[0]?.text ?? ''
  let parsed: any[]
  try {
    const jsonStart = rawText.indexOf('[')
    const jsonEnd   = rawText.lastIndexOf(']') + 1
    parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd))
  } catch (e: any) {
    throw new Error(`Failed to parse Claude response: ${e?.message ?? e}. Response preview: ${rawText.slice(0, 300)}`)
  }

  const prodById = new Map<string, string>()  // prefix → full id
  for (const p of (products ?? [])) prodById.set(p.id.slice(0, 8), p.id)

  const keyByPrefix = new Map<string, string>()
  for (const g of groups) keyByPrefix.set(g.group_key.slice(0, 16), g.group_key)

  const rows: any[] = []
  for (const entry of parsed) {
    const fullKey = keyByPrefix.get(entry.key)
    if (!fullKey) continue   // hallucinated key — drop silently
    const productId = entry.action === 'approve_existing' && entry.product_id_prefix
      ? prodById.get(String(entry.product_id_prefix).slice(0, 8)) ?? null
      : null
    rows.push({
      org_id:             orgId,
      business_id:        businessId,
      group_key:          fullKey,
      action:             entry.action,
      confidence:         Math.max(0, Math.min(1, Number(entry.confidence ?? 0))),
      product_id:         productId,
      suggested_name:     entry.suggested_name ?? null,
      suggested_category: entry.suggested_category ?? null,
      reasoning:          String(entry.reasoning ?? '').slice(0, 500),
      ai_model:           AI_MODELS.AGENT,
      tokens_input:       Math.round(tokensIn / parsed.length),     // amortised per row
      tokens_output:      Math.round(tokensOut / parsed.length),
    })
  }

  const dedupMap = new Map<string, any>()
  for (const r of rows) dedupMap.set(r.group_key, r)
  const dedupedRows = Array.from(dedupMap.values())

  if (dedupedRows.length > 0) {
    // Persist via delete-then-insert, NOT .upsert({ onConflict }). The
    // (business_id, group_key) unique index is partial/missing in prod, and
    // PostgREST rejects partial indexes as ON CONFLICT targets ("no unique
    // or exclusion constraint matching the ON CONFLICT specification") — the
    // same trap insertAlias() documents a few lines over. The upsert was
    // failing SILENTLY (error swallowed), so suggestions never persisted:
    // the review page didn't notice (it returns the in-memory rows) but the
    // onboarding auto-build's cache read was always empty → it re-classified
    // in a loop and applied nothing. Delete-then-insert is constraint-shape
    // independent.
    const keys = dedupedRows.map(r => r.group_key)
    for (let i = 0; i < keys.length; i += 200) {
      const { error: delErr } = await db
        .from('inventory_review_suggestions')
        .delete()
        .eq('business_id', businessId)
        .in('group_key', keys.slice(i, i + 200))
      if (delErr) console.error('[ai-suggest] suggestions delete failed:', delErr.message)
    }
    const { error: insErr } = await db
      .from('inventory_review_suggestions')
      .insert(dedupedRows)
    if (insErr) console.error('[ai-suggest] suggestions insert failed:', insErr.message)
  }

  return dedupedRows
}
