// app/api/cron/recategorise-other/route.ts
//
// Nightly sweep: for every active business with N > 0 products stuck in
// category='other', invoke the recategorise-other logic. Owners no
// longer need to remember to click the button — new products created
// without a confident category get classified within 24 hours.
//
// Runs at 03:30 UTC daily (just before the ai-log-retention cron at
// 03:30 UTC; intentionally back-to-back so any new AI surface costs
// land in one place).
//
// Per-business: load products in 'other', run Haiku batch, escalate
// low-confidence rows to Sonnet+web_search (max 100 escalations per
// business per night so cost stays bounded; the rest carry over to
// the next night's run).
//
// Cost ceiling: 10 customers × ~50 products to classify/night × $0.005
// (Haiku) + ~10 escalations × $0.08 (Sonnet+search) = ~$8/night = $240/mo
// at 10 customers. Acceptable for keeping the catalogue clean.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { createAdminClient }            from '@/lib/supabase/server'
import { checkCronSecret }              from '@/lib/admin/check-secret'
import { log }                          from '@/lib/log/structured'
import { AI_MODELS }                    from '@/lib/ai/models'
import { anthropicFetch }               from '@/lib/ai/anthropic-fetch'
import { checkAiLimit, logAiRequest }   from '@/lib/ai/usage'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const HAIKU_BATCH_SIZE       = 100
const HAIKU_CONFIDENCE_FLOOR = 0.70
const MAX_ESCALATIONS_PER_BUSINESS = 100   // cost ceiling per night
const CATEGORIES = ['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other'] as const

const HAIKU_INPUT  = 1  / 1_000_000
const HAIKU_OUTPUT = 5  / 1_000_000
const SONNET_INPUT  = 3  / 1_000_000
const SONNET_OUTPUT = 15 / 1_000_000

const HAIKU_SYSTEM = `You are an expert at categorising Swedish restaurant supplier products. Given a list of product names (mostly Swedish, some abbreviations), classify each into ONE category with a confidence score 0-1.

Categories:
  food              — raw food ingredients (meat, fish, dairy, produce, dry goods, spices, sauces, oils)
  beverage          — non-alcoholic drinks (soda, juice, sparkling water, energy drinks, oat milk, tonic mixers)
  alcohol           — wine, beer, spirits, liqueurs, cider
  cleaning          — cleaning chemicals, soaps, detergents, sanitisers
  takeaway_material — takeaway containers, bags, cutlery for serving to customers
  disposables       — kitchen disposables (gloves, foil, parchment, gas cylinders, candles, paper goods not customer-facing)
  other             — only when truly ambiguous

Calibration:
- Swedish food words: kött, fisk, lax, kyckling, fläsk, kalv, ägg, ost, mjölk, gräddi, grönsak, frukt, bär, mjöl, ris, pasta, krydda, sallad, lök, potatis, broccoli, tomat, paprika, persilja
- Wine producers + grape varieties (Barolo, Chianti, Brunello, Nebbiolo, Pinot, Chardonnay, Verdicchio, Casascarpa) → alcohol
- Spirits brand names (Tanqueray, Jameson, Ketel One, Aperol, Campari, Fernet, Galliano, Calvados, Cragganmore, Martell, Olmeca, Don Julio) → alcohol
- Soft drinks / mixers (Coca Cola, Festis, Ramlösa, San Pellegrino, Aranciata, Thomas Henry) → beverage
- Vegetables / fruit / herbs (Shisokrasse, Krasse, Sallad, Sparris, Nektarin, Hallon, Granatäpple, Maché, Sakura mix) → food
- Cleaning chemicals: Klorin, Ajax, Diskmedel → cleaning
- Gloves / paper / napkins / Returback → disposables

Return JSON only:
[{"id":"abc...","category":"food","confidence":0.92},...]`

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}
export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}

async function run() {
  noStore()
  const started = Date.now()
  const db = createAdminClient()

  // Find every active business that has > 0 products in 'other'
  const { data: businesses, error: bizErr } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('is_active', true)
  if (bizErr) {
    log.error('recategorise-other biz load failed', { route: 'cron/recategorise-other', error: bizErr.message })
    return NextResponse.json({ error: bizErr.message }, { status: 500 })
  }
  if (!businesses?.length) return NextResponse.json({ ok: true, businesses: 0 })

  const results: Array<{ business_id: string; recategorised: number; escalated: number; cost_usd: number; still_other: number }> = []
  let totalCostUsd = 0

  for (const biz of businesses) {
    // Honour the global AI kill-switch — checkAiLimit returns 'global_kill_switch'
    // when over $/day cap; abort the loop in that case so we don't burn through.
    const gate = await checkAiLimit(db, biz.org_id)
    if (!gate.ok) {
      log.warn('recategorise-other kill-switch hit', {
        route: 'cron/recategorise-other', business_id: biz.id, reason: gate.body.reason,
      })
      break
    }

    const stats = await sweepBusiness(db, biz)
    results.push({ business_id: biz.id, ...stats })
    totalCostUsd += stats.cost_usd
  }

  log.info('recategorise-other complete', {
    route:        'cron/recategorise-other',
    duration_ms:  Date.now() - started,
    businesses:   results.length,
    total_recategorised: results.reduce((s, r) => s + r.recategorised, 0),
    total_escalated:     results.reduce((s, r) => s + r.escalated, 0),
    total_cost_usd:      Math.round(totalCostUsd * 10000) / 10000,
    status:       'success',
  })

  return NextResponse.json({
    ok: true,
    businesses: results.length,
    total_recategorised: results.reduce((s, r) => s + r.recategorised, 0),
    total_escalated:     results.reduce((s, r) => s + r.escalated, 0),
    total_cost_usd:      Math.round(totalCostUsd * 10000) / 10000,
    results,
  })
}

async function sweepBusiness(db: any, biz: { id: string; org_id: string; name: string | null }): Promise<{
  recategorised: number
  escalated:     number
  still_other:   number
  cost_usd:      number
}> {
  const { data: products } = await db
    .from('products')
    .select('id, name')
    .eq('business_id', biz.id)
    .eq('category', 'other')
    .is('archived_at', null)
    .order('updated_at', { ascending: false })   // newest first
    .limit(500)
  if (!products?.length) return { recategorised: 0, escalated: 0, still_other: 0, cost_usd: 0 }

  let recategorised = 0
  let escalated     = 0
  let costUsd       = 0

  // Pass 1: Haiku batch
  for (let i = 0; i < products.length; i += HAIKU_BATCH_SIZE) {
    const slice = products.slice(i, i + HAIKU_BATCH_SIZE)
    const listing = slice.map((p: any) => JSON.stringify({ id: p.id.slice(0, 16), name: p.name })).join('\n')

    const result = await anthropicFetch({
      body: {
        model:      AI_MODELS.AGENT,
        max_tokens: 8192,
        system:     [{ type: 'text', text: HAIKU_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: `Classify these ${slice.length} products:\n\n${listing}\n\nReturn JSON array only.` }],
      },
    })
    if (!result.ok) {
      log.warn('recategorise-other haiku failed', { business_id: biz.id, error: result.errorText })
      break
    }
    costUsd += result.tokensIn * HAIKU_INPUT + result.tokensOut * HAIKU_OUTPUT
    await logAiRequest(db, {
      org_id: biz.org_id,
      request_type: 'inventory_recategorise_haiku',
      model: AI_MODELS.AGENT,
      input_tokens: result.tokensIn, output_tokens: result.tokensOut,
      duration_ms: result.durationMs,
    }).catch(() => {})

    const rawText = result.json?.content?.[0]?.text ?? ''
    const start = rawText.indexOf('['), end = rawText.lastIndexOf(']') + 1
    let parsed: any[]
    try { parsed = JSON.parse(rawText.slice(start, end)) } catch { continue }

    const idByPrefix = new Map<string, { id: string; name: string }>(
      slice.map((p: any) => [String(p.id).slice(0, 16), { id: String(p.id), name: String(p.name ?? '') }] as [string, { id: string; name: string }]),
    )

    for (const entry of parsed) {
      const product = idByPrefix.get(entry.id)
      if (!product) continue
      const cat  = String(entry.category ?? '').toLowerCase()
      const conf = Number(entry.confidence ?? 0)
      if (!CATEGORIES.includes(cat as any)) continue

      if (conf >= HAIKU_CONFIDENCE_FLOOR && cat !== 'other') {
        const { error: upErr } = await db.from('products')
          .update({ category: cat, category_overridden: true })
          .eq('id', product.id)
        if (!upErr) recategorised++
        continue
      }

      // Low confidence — escalate to Sonnet+web_search (capped per night)
      if (escalated >= MAX_ESCALATIONS_PER_BUSINESS) continue

      const sonnet = await classifyWithWebSearch(product.name)
      costUsd += sonnet.costUsd
      escalated++
      if (sonnet.tokensIn > 0) {
        await logAiRequest(db, {
          org_id: biz.org_id,
          request_type: 'inventory_recategorise_sonnet_search',
          model: AI_MODELS.ANALYSIS,
          input_tokens: sonnet.tokensIn, output_tokens: sonnet.tokensOut,
          duration_ms: sonnet.durationMs,
        }).catch(() => {})
      }

      if (sonnet.category && sonnet.category !== 'other' && CATEGORIES.includes(sonnet.category as any)) {
        const { error: upErr } = await db.from('products')
          .update({ category: sonnet.category, category_overridden: true })
          .eq('id', product.id)
        if (!upErr) recategorised++
      }
    }
  }

  // Re-count what's still in 'other' after the sweep
  const { count: stillOther } = await db
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', biz.id)
    .eq('category', 'other')
    .is('archived_at', null)

  return { recategorised, escalated, still_other: stillOther ?? 0, cost_usd: costUsd }
}

async function classifyWithWebSearch(name: string): Promise<{
  category:   string | null
  confidence: number
  tokensIn:   number
  tokensOut:  number
  costUsd:    number
  durationMs: number
}> {
  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.ANALYSIS,
      max_tokens: 1500,
      messages:   [{ role: 'user', content: `Classify this Swedish restaurant supplier product into ONE category: food, beverage, alcohol, cleaning, takeaway_material, disposables, or other.\n\nProduct name: "${name}"\n\nIf the name is unfamiliar, use the web_search tool. The product is from a Swedish supplier; search in Swedish if helpful.\n\nRespond with JSON only: {"category": "food", "confidence": 0.85}` }],
      tools:      [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    },
  })
  if (!result.ok) {
    return { category: null, confidence: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0 }
  }
  let textOut = ''
  for (const block of result.json?.content ?? []) {
    if (block.type === 'text' && block.text) textOut = block.text
  }
  const start = textOut.indexOf('{'), end = textOut.lastIndexOf('}') + 1
  let parsed: any = null
  try { parsed = JSON.parse(textOut.slice(start, end)) } catch {}
  const cat        = String(parsed?.category ?? '').toLowerCase() || null
  const confidence = Number(parsed?.confidence ?? 0)
  const costUsd    = result.tokensIn * SONNET_INPUT + result.tokensOut * SONNET_OUTPUT
  return {
    category:   cat && CATEGORIES.includes(cat as any) ? cat : null,
    confidence,
    tokensIn:   result.tokensIn,
    tokensOut:  result.tokensOut,
    costUsd,
    durationMs: result.durationMs,
  }
}
