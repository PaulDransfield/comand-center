// app/api/inventory/recategorise-other/route.ts
//
// POST { business_id, use_web_search?: boolean }
//
// Sweeps every product in category='other' for the given business and
// reclassifies via Haiku 4.5 batch classifier. Products where Haiku's
// confidence drops below 0.70 get escalated to Sonnet 4.6 with the
// web_search tool enabled — picks up obscure Swedish supplier codes,
// branded mineral waters, regional wine producers etc. that Haiku
// recognises poorly from the name alone.
//
// Pattern is the same as `scripts/recategorise-other-products.mjs` but
// owner-triggerable from the UI instead of a one-off CLI invocation.
// Returns a summary the UI can render: per-category counts + cost.
//
// Web-search escalation is gated by `use_web_search` (default true).
// Approx cost at 80 products with 20% escalating to Sonnet+search:
//   Haiku batch (1 call):     ~$0.005
//   Sonnet+search × 16:       ~$1.30
// Total ~$1.30 per business per sweep.

import { NextRequest, NextResponse }   from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess }       from '@/lib/auth/require-role'
import { AI_MODELS }                   from '@/lib/ai/models'
import { anthropicFetch }              from '@/lib/ai/anthropic-fetch'
import { checkAndIncrementAiLimit, logAiRequest } from '@/lib/ai/usage'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300   // Sonnet+search per ambiguous item can take 10-30s

const HAIKU_BATCH_SIZE       = 100
const HAIKU_CONFIDENCE_FLOOR = 0.70  // below this, escalate to Sonnet+search
const CATEGORIES = ['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other'] as const

const HAIKU_INPUT  = 1  / 1_000_000
const HAIKU_OUTPUT = 5  / 1_000_000
const SONNET_INPUT  = 3  / 1_000_000
const SONNET_OUTPUT = 15 / 1_000_000

const HAIKU_SYSTEM = `You are an expert at categorising Swedish restaurant supplier products. Given a list of product names (mostly in Swedish, some abbreviations), classify each into ONE category with a confidence score 0-1.

Categories:
  food              — raw food ingredients (meat, fish, dairy, produce, dry goods, spices, sauces, oils)
  beverage          — non-alcoholic drinks (soda, juice, sparkling water, energy drinks, oat milk, tonic mixers)
  alcohol           — wine, beer, spirits, liqueurs, cider
  cleaning          — cleaning chemicals, soaps, detergents, sanitisers
  takeaway_material — takeaway containers, bags, cutlery for serving to customers
  disposables       — kitchen disposables (gloves, foil, parchment, gas cylinders, candles, paper goods not customer-facing)
  other             — only when truly ambiguous (rare — prefer a best-guess at lower confidence)

Calibration:
- Swedish food words: kött, fisk, lax, kyckling, fläsk, kalv, ägg, ost, mjölk, gräddi, grönsak, frukt, bär, mjöl, ris, pasta, krydda, sallad, lök, potatis, broccoli, tomat, paprika, persilja, etc.
- Wine producers + grape varieties (Barolo, Chianti, Brunello, Nebbiolo, Pinot, Chardonnay, Verdicchio, Casascarpa, etc.) → alcohol
- Spirits brand names (Tanqueray, Jameson, Ketel One, Aperol, Campari, Fernet, Galliano, Calvados, Cragganmore, Martell, Olmeca, Don Julio, etc.) → alcohol
- Soft drinks / mixers (Coca Cola, Fanta, Sprite, Pommac, Festis, Ramlösa, San Pellegrino, Aranciata, Limonata, Thomas Henry, Three Cents) → beverage
- Vegetables / fruit / herbs (Shisokrasse, Krasse, Sallad, Sparris, Nektarin, Hallon, Granatäpple, Maché, Sakura mix) → food
- Cleaning chemicals: Klorin, Ajax, Diskmedel, Sopsäck → cleaning OR disposables (disposables for plastic bags)
- Gloves / paper / napkins / Returback (transport crate) → disposables
- "Returback" specifically is a deposit pallet — disposables.

Return JSON only — one entry per product in input order:
[{"id":"abc123def456...","category":"food","confidence":0.92},{"id":"...","category":"alcohol","confidence":0.65},...]

Confidence guide:
  ≥0.85 = obviously this category
  0.70-0.85 = clear enough to apply
  <0.70 = uncertain — this row will be re-checked with web search`

// Web-search-enabled Sonnet prompt for ambiguous items
function buildSonnetSearchUserMessage(name: string): string {
  return `Classify this Swedish restaurant supplier product into ONE category: food, beverage, alcohol, cleaning, takeaway_material, disposables, or other.

Product name: "${name}"

If the name is unfamiliar or ambiguous, use the web_search tool to look it up. The product is from a Swedish restaurant supplier, so search in Swedish if helpful.

After researching, respond with JSON only:
{"category": "food", "confidence": 0.85, "reasoning": "1 sentence explaining"}`
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId   = String(body.business_id ?? '').trim()
  const useWebSearch = body.use_web_search !== false   // default true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Quota gate — burst protection
  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  // ── Load products ────────────────────────────────────────────────
  const { data: products, error: loadErr } = await db
    .from('products')
    .select('id, name')
    .eq('business_id', businessId)
    .eq('category', 'other')
    .is('archived_at', null)
    .order('name')
    .limit(1000)
  if (loadErr) return NextResponse.json({ error: `load: ${loadErr.message}` }, { status: 500 })
  if (!products || products.length === 0) {
    return NextResponse.json({ ok: true, recategorised: 0, message: 'No products in "other"', summary: {} })
  }

  let recategorised = 0
  let escalated     = 0
  let totalCostUsd  = 0
  const newCounts: Record<string, number> = {}
  const stillOther: Array<{ id: string; name: string; reason: string }> = []

  // ── Pass 1: Haiku batch ──────────────────────────────────────────
  for (let i = 0; i < products.length; i += HAIKU_BATCH_SIZE) {
    const slice = products.slice(i, i + HAIKU_BATCH_SIZE)
    const listing = slice.map(p => JSON.stringify({ id: p.id.slice(0, 16), name: p.name })).join('\n')

    const result = await anthropicFetch({
      body: {
        model:      AI_MODELS.AGENT,
        max_tokens: 8192,
        system:     [{ type: 'text', text: HAIKU_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: `Classify these ${slice.length} products:\n\n${listing}\n\nReturn JSON array only.` }],
      },
    })
    if (!result.ok) {
      return NextResponse.json({
        error: `Haiku batch failed: ${result.errorText}`,
        recategorised, escalated, total_cost_usd: totalCostUsd,
      }, { status: 502 })
    }
    totalCostUsd += result.tokensIn * HAIKU_INPUT + result.tokensOut * HAIKU_OUTPUT
    await logAiRequest(db, {
      org_id: auth.orgId,
      request_type: 'inventory_recategorise_haiku',
      model: AI_MODELS.AGENT,
      input_tokens: result.tokensIn, output_tokens: result.tokensOut,
      duration_ms: result.durationMs,
    }).catch(() => {})

    const rawText = result.json?.content?.[0]?.text ?? ''
    const start = rawText.indexOf('['), end = rawText.lastIndexOf(']') + 1
    let parsed: any[]
    try { parsed = JSON.parse(rawText.slice(start, end)) }
    catch { continue }

    const idByPrefix = new Map(slice.map(p => [p.id.slice(0, 16), { id: p.id, name: p.name }]))

    for (const entry of parsed) {
      const product = idByPrefix.get(entry.id)
      if (!product) continue
      const cat  = String(entry.category ?? '').toLowerCase()
      const conf = Number(entry.confidence ?? 0)
      if (!CATEGORIES.includes(cat as any)) continue

      // High-confidence non-other: apply immediately
      if (conf >= HAIKU_CONFIDENCE_FLOOR && cat !== 'other') {
        const { error: upErr } = await db.from('products')
          .update({ category: cat, category_overridden: true })
          .eq('id', product.id)
        if (!upErr) {
          recategorised++
          newCounts[cat] = (newCounts[cat] ?? 0) + 1
        }
        continue
      }

      // Low confidence OR Haiku said 'other' — queue for Sonnet+search
      if (useWebSearch) {
        const sonnetResult = await classifyWithWebSearch(product.name)
        totalCostUsd += sonnetResult.costUsd
        await logAiRequest(db, {
          org_id: auth.orgId,
          request_type: 'inventory_recategorise_sonnet_search',
          model: AI_MODELS.ANALYSIS,
          input_tokens: sonnetResult.tokensIn, output_tokens: sonnetResult.tokensOut,
          duration_ms: sonnetResult.durationMs,
        }).catch(() => {})
        escalated++

        if (sonnetResult.category && sonnetResult.category !== 'other' && CATEGORIES.includes(sonnetResult.category as any)) {
          const { error: upErr } = await db.from('products')
            .update({ category: sonnetResult.category, category_overridden: true })
            .eq('id', product.id)
          if (!upErr) {
            recategorised++
            newCounts[sonnetResult.category] = (newCounts[sonnetResult.category] ?? 0) + 1
          }
        } else {
          stillOther.push({
            id: product.id, name: product.name,
            reason: sonnetResult.category === 'other'
              ? `web search inconclusive: ${sonnetResult.reasoning ?? 'no detail'}`
              : `low confidence even after search`,
          })
        }
      } else {
        stillOther.push({
          id: product.id, name: product.name,
          reason: `Haiku confidence ${conf.toFixed(2)} < ${HAIKU_CONFIDENCE_FLOOR}; web search disabled`,
        })
      }
    }
  }

  return NextResponse.json({
    ok: true,
    total_products:  products.length,
    recategorised,
    escalated_to_sonnet: escalated,
    still_other:     stillOther.length,
    summary:         newCounts,
    cost_usd:        Math.round(totalCostUsd * 10000) / 10000,
    still_other_sample: stillOther.slice(0, 20),   // first 20 only — UI shows them
  })
}

// ─────────────────────────────────────────────────────────────────────
// Sonnet 4.6 + web_search single-product fallback

async function classifyWithWebSearch(name: string): Promise<{
  category:    string | null
  confidence:  number
  reasoning:   string | null
  tokensIn:    number
  tokensOut:   number
  costUsd:     number
  durationMs:  number
}> {
  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.ANALYSIS,
      max_tokens: 1500,
      messages:   [{ role: 'user', content: buildSonnetSearchUserMessage(name) }],
      tools:      [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    },
  })
  if (!result.ok) {
    return { category: null, confidence: 0, reasoning: `Sonnet error: ${result.errorText}`, tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0 }
  }

  // Find the last text block (after any tool use)
  let textOut = ''
  for (const block of result.json?.content ?? []) {
    if (block.type === 'text' && block.text) textOut = block.text
  }
  const start = textOut.indexOf('{'), end = textOut.lastIndexOf('}') + 1
  let parsed: any = null
  try { parsed = JSON.parse(textOut.slice(start, end)) } catch {}

  const cat        = String(parsed?.category   ?? '').toLowerCase() || null
  const confidence = Number(parsed?.confidence ?? 0)
  const reasoning  = parsed?.reasoning ? String(parsed.reasoning).slice(0, 200) : null
  const costUsd    = result.tokensIn * SONNET_INPUT + result.tokensOut * SONNET_OUTPUT

  return {
    category:   cat && CATEGORIES.includes(cat as any) ? cat : null,
    confidence,
    reasoning,
    tokensIn:   result.tokensIn,
    tokensOut:  result.tokensOut,
    costUsd,
    durationMs: result.durationMs,
  }
}
