// app/api/inventory/review/ai-suggest/route.ts
//
// AI-assisted bulk review. Given the current needs_review groups for a
// business, asks Claude Haiku 4.5 to classify each group into:
//   - approve_existing: matches an existing product (high-confidence)
//   - create_new:       distinct product worth adding (food/drink/etc)
//   - skip_non_inventory: deposit, returnback, freight, discount, empty
//   - review:           ambiguous, owner must decide
//
// Returns a suggestion per group with confidence + reasoning. Caches
// 24h in inventory_review_suggestions so re-renders are free.
//
// Learning loop: prompt includes recent owner outcomes (last 60 days
// of disagreements + agreements) as in-context examples. Over time
// the model gets better at this business's specific catalogue.
//
// POST { business_id, force?: boolean } → { suggestions: [...] }

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess }        from '@/lib/auth/require-role'
import { AI_MODELS }                    from '@/lib/ai/models'
import { normaliseDescription }         from '@/lib/inventory/normalise'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300   // Haiku call takes ~90-100s on 120-group batches; 60s default 504s

const CACHE_TTL_HOURS = 24
const MAX_GROUPS_PER_RUN = 120   // cap so Haiku's JSON response fits in max_tokens

// Haiku 4.5 published pricing
const HAIKU_INPUT_USD_PER_TOKEN  = 1  / 1_000_000
const HAIKU_OUTPUT_USD_PER_TOKEN = 5  / 1_000_000

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const force      = body.force === true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // ── 1. Load current needs_review groups ──────────────────────────
  const { data: lines, error: linesErr } = await db
    .from('supplier_invoice_lines')
    .select('supplier_fortnox_number, supplier_name_snapshot, raw_description, unit, price_per_unit, total_excl_vat, invoice_date, account_number')
    .eq('business_id', businessId)
    .eq('match_status', 'needs_review')
    .limit(15_000)
  if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 })

  const groups = buildGroups(lines ?? [])
  if (groups.length === 0) {
    return NextResponse.json({ suggestions: [], message: 'No needs_review groups to classify.' })
  }

  // Cap to keep the prompt manageable; sort by line_count desc so the
  // biggest catalogue holes get attention first.
  groups.sort((a, b) => b.line_count - a.line_count)
  const groupsToProcess = groups.slice(0, MAX_GROUPS_PER_RUN)

  // ── 2. Cache check ───────────────────────────────────────────────
  if (!force) {
    const { data: cached } = await db
      .from('inventory_review_suggestions')
      .select('*')
      .eq('business_id', businessId)
      .gte('created_at', new Date(Date.now() - CACHE_TTL_HOURS * 3600_000).toISOString())
    if (cached && cached.length > 0) {
      // Return all current cached + flag stale-misses for the UI
      const cachedKeys = new Set(cached.map((c: any) => c.group_key))
      const stale = groupsToProcess.filter(g => !cachedKeys.has(g.group_key))
      if (stale.length === 0) {
        return NextResponse.json({
          suggestions: cached,
          cached:      true,
          groups_in_cache: cached.length,
          stale_groups: 0,
        })
      }
      // Some new groups since the last run — fall through to run AI on JUST those.
      const staleSet = new Set(stale.map(g => g.group_key))
      const groupsToRun = groupsToProcess.filter(g => staleSet.has(g.group_key))
      const newSuggestions = await runClaudeBatch(db, auth.orgId, businessId, groupsToRun)
      return NextResponse.json({
        suggestions: [...cached, ...newSuggestions],
        cached:      'partial',
        new_suggestions: newSuggestions.length,
        cached_kept:    cached.length,
      })
    }
  }

  // ── 3. Fresh run on all groups ───────────────────────────────────
  const suggestions = await runClaudeBatch(db, auth.orgId, businessId, groupsToProcess)
  return NextResponse.json({
    suggestions,
    cached:    false,
    new_suggestions: suggestions.length,
    total_groups:    groups.length,
    processed:       suggestions.length,
  })
}

// ─────────────────────────────────────────────────────────────────────
// Grouping (mirrors /api/inventory/needs-review)

interface Group {
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

function buildGroups(lines: any[]): Group[] {
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
  // Compute median price + most-common account per group
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

// ─────────────────────────────────────────────────────────────────────
// Claude batch — one API call for up to MAX_GROUPS_PER_RUN groups

async function runClaudeBatch(
  db:         any,
  orgId:      string,
  businessId: string,
  groups:     Group[],
): Promise<any[]> {
  if (groups.length === 0) return []
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  // Load the catalogue context (products + aliases) for matching
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

  // Learning loop: load recent owner outcomes — last 60 days.
  // Disagreements first (where AI was wrong), then a sample of
  // agreements (so Claude sees what 'right' looks like for this owner).
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

  // Build the catalogue text for Claude
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

  // Groups text (compact)
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

  // Anthropic call with prompt caching on the system+catalogue blob
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:       AI_MODELS.AGENT,             // Haiku 4.5
      max_tokens:  16384,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: userMessage },
      ],
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const json: any = await res.json()
  const tokensIn  = json?.usage?.input_tokens  ?? 0
  const tokensOut = json?.usage?.output_tokens ?? 0
  const cost = (tokensIn * HAIKU_INPUT_USD_PER_TOKEN) + (tokensOut * HAIKU_OUTPUT_USD_PER_TOKEN)
  console.log(`[ai-suggest] business=${businessId.slice(0,8)} groups=${groups.length} tokens=${tokensIn}/${tokensOut} cost=$${cost.toFixed(4)}`)

  // Parse the JSON response. Strip any prose before/after the array.
  const rawText = json?.content?.[0]?.text ?? ''
  let parsed: any[]
  try {
    const jsonStart = rawText.indexOf('[')
    const jsonEnd   = rawText.lastIndexOf(']') + 1
    parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd))
  } catch (e: any) {
    throw new Error(`Failed to parse Claude response: ${e?.message ?? e}. Response preview: ${rawText.slice(0, 300)}`)
  }

  // Resolve 8-char prefixes back to full product UUIDs
  const prodById = new Map<string, string>()  // prefix → full id
  for (const p of (products ?? [])) prodById.set(p.id.slice(0, 8), p.id)

  // Match parsed entries back to groups by key prefix
  const keyByPrefix = new Map<string, string>()
  for (const g of groups) keyByPrefix.set(g.group_key.slice(0, 16), g.group_key)

  // Build rows for inventory_review_suggestions + return shape
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

  // Dedupe by group_key — Claude can hallucinate the same 16-char prefix
  // twice, which would otherwise crash the upsert with "ON CONFLICT DO
  // UPDATE cannot affect row a second time". Last entry wins.
  const dedupMap = new Map<string, any>()
  for (const r of rows) dedupMap.set(r.group_key, r)
  const dedupedRows = Array.from(dedupMap.values())

  // Upsert into cache. Unique constraint is (business_id, group_key).
  if (dedupedRows.length > 0) {
    const { error: upErr } = await db
      .from('inventory_review_suggestions')
      .upsert(dedupedRows, { onConflict: 'business_id,group_key' })
    if (upErr) console.error('[ai-suggest] upsert failed:', upErr.message)
  }

  return dedupedRows
}
