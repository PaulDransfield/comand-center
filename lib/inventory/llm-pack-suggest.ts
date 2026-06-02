// lib/inventory/llm-pack-suggest.ts
//
// Phase B — LLM mop-up for alcohol products where the deterministic
// parser (name regex + invoice_unit fallback) can't infer pack info.
//
// What it does:
//   - Takes a batch of alcohol products with pack_size IS NULL
//   - Sends name + invoice_unit + sample invoice line shape to Haiku
//   - Haiku classifies (wine_still / wine_sparkling / wine_fortified /
//     spirits / liqueur / beer / cider / other_alcohol) and applies the
//     industry convention:
//        wine still / sparkling / fortified : 750 ml/bottle
//        spirits / liqueur                  : 700 ml/bottle (EU 70cl)
//        beer single / cider                : 330 ml/bottle
//   - Handles invoice-unit shape: BOT / fl / flaska = single bottle;
//     C6 / C12 / C24 / KRT = case (multiply convention by case count);
//     ltr = liter-bottle (1000 ml or 1500 ml — Haiku picks plausibly).
//   - Honest-incomplete: returns null suggestion when confidence < 0.85
//     (ambiguous case sizes, unknown alcohol classes, deal lines like
//     "Avtalsrabatt JAMESON 40%" that aren't products at all).
//
// Output: { product_id, suggestion: { pack_size_ml, base_unit, source:
//          'llm_inferred', classification, confidence, reasoning } | null }
//
// Returns ONE per-batch Anthropic call's worth — caller batches.

import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { AI_MODELS } from '@/lib/ai/models'

export interface ProductForLLM {
  product_id:        string
  name:              string
  category:          string | null
  invoice_unit:      string | null
  supplier_name:     string | null
  // Sample of the most recent supplier_invoice_line for this product —
  // gives Haiku the case-vs-bottle anchor. Optional but helpful.
  latest_qty?:       number | null
  latest_total_sek?: number | null
  latest_unit?:      string | null
}

export interface PackSuggestion {
  product_id:      string
  pack_size_ml:    number
  base_unit:       'ml'
  classification:  string   // wine_still | spirits | beer | …
  confidence:      number   // 0..1
  reasoning:       string   // 1-line audit trail
}

export interface PackSuggestBatchResult {
  ok:           boolean
  suggestions:  PackSuggestion[]   // confidence >= 0.85 entries only
  skipped:      Array<{ product_id: string; reason: string; confidence?: number }>
  tokensIn:     number
  tokensOut:    number
  raw?:         any                // for diagnostics
  error?:       string
}

const SYSTEM_PROMPT = `You classify Swedish-restaurant alcohol products and pick the pack volume in ml.

INDUSTRY CONVENTIONS (apply unless the name explicitly states otherwise):
  - Still / sparkling / dessert / fortified wine    → 750 ml per bottle
  - Spirits (gin, vodka, whisky, rum, tequila, …)   → 700 ml per bottle  (EU 70cl standard)
  - Liqueur, schnapps, vermouth                      → 700 ml per bottle
  - Beer (single)                                    → 330 ml per bottle
  - Cider (single)                                   → 330 ml per bottle

INVOICE-UNIT INTERPRETATION:
  - BOT / bot / fl / flaska                          → 1 bottle
  - C6 / C12 / C24 / KRT / KART                      → CASE of N bottles (multiply convention)
  - ltr                                              → product is sold as a 1-liter or 1.5-liter bottle (pick the most plausible from the name; default 1000 ml when in doubt)
  - KLI / DEL / TFP / (anything you don't recognise) → AMBIGUOUS — set confidence < 0.85 and we'll skip it

THE NAME ALMOST ALWAYS DISCLOSES THE BOTTLE SIZE IMPLICITLY:
  - "Barolo … 2018", "Brunello di Montalcino", "Chardonnay 2022"   → wine_still, 750 ml
  - "Champagne", "Prosecco", "Cava", "Brut", "Spumante"             → wine_sparkling, 750 ml
  - "Jameson 40%", "Tanqueray Gin", "Beefeater Lond Dry Gin 40%"   → spirits, 700 ml
  - "Baileys", "St Germain Fläderlikör"                             → liqueur, 700 ml  (50cl also possible — use the per-bottle invoice price as a sanity check)
  - "Birra Poretti 5,0%", "IPA", "Lager", "Pilsner"                 → beer, 330 ml per bottle (multiply by case-size when invoice_unit is a case marker)

USE THE INVOICE-LINE PRICE AS A SANITY CHECK:
  - Typical wine cost to a restaurant: 80-1000 kr per BOTTLE. If per-line price is in this range and qty looks like a bottle count, it's per-bottle.
  - Typical spirits cost: 150-600 kr per BOTTLE. Same logic.
  - Typical beer cost: 8-30 kr per BOTTLE. If per-line price is ~500 kr with qty=4, those are clearly 4 CASES, not 4 bottles — derive case_size from supplier convention (Carlsberg usually 20 or 24 per case).

HONEST-INCOMPLETE — set confidence < 0.85 (and we'll skip the product) when:
  - Product name is a discount, rebate, or fee line (e.g. "Avtalsrabatt JAMESON 40%", "Pant", "Frakt")
  - Alcohol category is unclear (rare wine style, regional spirit you don't recognise)
  - invoice_unit suggests a case but you can't tell the case size from the name OR the per-line price
  - per-line price doesn't fit any reasonable single-bottle OR case interpretation

OUTPUT: Return ONLY valid JSON matching this shape (no markdown fences, no commentary):

{
  "items": [
    {
      "product_id":     "<uuid>",
      "pack_size_ml":   <integer>,
      "classification": "wine_still|wine_sparkling|wine_fortified|spirits|liqueur|beer|cider|other_alcohol",
      "confidence":     <0.0-1.0>,
      "reasoning":      "<1 short sentence>"
    },
    …
  ]
}

Include every product_id from the input — even when confidence is low (we filter on our side).`

export async function llmPackSuggestBatch(
  products: ProductForLLM[],
): Promise<PackSuggestBatchResult> {
  if (products.length === 0) {
    return { ok: true, suggestions: [], skipped: [], tokensIn: 0, tokensOut: 0 }
  }

  // Build a compact user message — one line per product.
  const lines = products.map(p => {
    const parts: string[] = [`id=${p.product_id}`, `name="${p.name}"`]
    if (p.invoice_unit) parts.push(`invoice_unit=${p.invoice_unit}`)
    if (p.supplier_name) parts.push(`supplier=${p.supplier_name}`)
    if (p.latest_qty != null && p.latest_total_sek != null) {
      const per = p.latest_total_sek / Math.max(1, p.latest_qty)
      parts.push(`last_line: qty=${p.latest_qty} total=${p.latest_total_sek.toFixed(2)} per-unit=${per.toFixed(2)} kr`)
    }
    return parts.join(' | ')
  }).join('\n')

  const userMsg = `Classify these alcohol products and return pack_size_ml for each:\n\n${lines}`

  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.AGENT,
      max_tokens: 4000,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    },
  })

  if (!result.ok) {
    return {
      ok:          false,
      suggestions: [],
      skipped:     [],
      tokensIn:    0,
      tokensOut:   0,
      error:       `Anthropic ${result.status}: ${result.errorText.slice(0, 200)}`,
    }
  }

  // Extract text content from the response.
  const blocks = (result.json?.content ?? []) as Array<{ type: string; text?: string }>
  const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()

  // Robust JSON extraction — Haiku occasionally wraps in fences despite the
  // prompt. Find the first '{' and last '}'.
  let parsed: any
  try {
    const start = text.indexOf('{')
    const end   = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('no JSON object in response')
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (e: any) {
    return {
      ok:          false,
      suggestions: [],
      skipped:     [],
      tokensIn:    result.tokensIn,
      tokensOut:   result.tokensOut,
      raw:         text.slice(0, 500),
      error:       `JSON parse: ${e.message}`,
    }
  }

  const items: any[] = Array.isArray(parsed.items) ? parsed.items : []
  const suggestions: PackSuggestion[] = []
  const skipped: Array<{ product_id: string; reason: string; confidence?: number }> = []

  for (const item of items) {
    const pid  = String(item.product_id ?? '').trim()
    const pack = Number(item.pack_size_ml)
    const conf = Number(item.confidence)
    const cls  = String(item.classification ?? '').trim()
    const rsn  = String(item.reasoning ?? '').slice(0, 200)
    if (!pid) continue
    // Honest-incomplete: confidence floor + sanity bounds on pack_size_ml.
    if (!Number.isFinite(pack) || pack <= 0 || pack > 50_000) {
      skipped.push({ product_id: pid, reason: `invalid pack_size_ml: ${item.pack_size_ml}`, confidence: conf })
      continue
    }
    if (!Number.isFinite(conf) || conf < 0.85) {
      skipped.push({ product_id: pid, reason: `confidence ${conf} below 0.85 (${rsn})`, confidence: conf })
      continue
    }
    suggestions.push({
      product_id:      pid,
      pack_size_ml:    Math.round(pack),
      base_unit:       'ml',
      classification:  cls,
      confidence:      conf,
      reasoning:       rsn,
    })
  }

  // Capture any input product_ids the LLM forgot to score.
  const returnedIds = new Set(items.map(i => String(i.product_id ?? '')))
  for (const p of products) {
    if (!returnedIds.has(p.product_id) &&
        !suggestions.find(s => s.product_id === p.product_id) &&
        !skipped.find(s => s.product_id === p.product_id)) {
      skipped.push({ product_id: p.product_id, reason: 'not returned by LLM' })
    }
  }

  return {
    ok:          true,
    suggestions,
    skipped,
    tokensIn:    result.tokensIn,
    tokensOut:   result.tokensOut,
  }
}
