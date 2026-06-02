// lib/inventory/llm-density-suggest.ts
//
// Phase A2 / B-extension — LLM density classifier for products that
// need mass↔volume conversion in the cost engine. Mirrors
// llm-pack-suggest.ts: Haiku + confidence gate + honest-incomplete.
//
// Job: pick a class label for each product (oil/vinegar/honey/etc.)
// and emit the well-documented convention density. Owner can override
// in the items UI. Confidence floor 0.85.

import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { AI_MODELS } from '@/lib/ai/models'

export interface ProductForDensityLLM {
  product_id:   string
  name:         string
  category:     string | null
  invoice_unit: string | null
  base_unit:    string | null   // 'g' | 'ml' | 'st'
  pack_size:    number | null
}

export interface DensitySuggestion {
  product_id:     string
  density_g_per_ml: number
  classification: string         // oil | vinegar | …
  confidence:     number
  reasoning:      string
}

export interface DensitySuggestBatchResult {
  ok:           boolean
  suggestions:  DensitySuggestion[]  // confidence >= 0.85 only
  skipped:      Array<{ product_id: string; reason: string; confidence?: number }>
  tokensIn:     number
  tokensOut:    number
  raw?:         any
  error?:       string
}

// Convention densities — single source of truth so the prompt and the
// post-validation can use the same numbers. The LLM CAN return its own
// density, but values outside (0.5, 1.5) get rejected.
export const DENSITY_BY_CLASS: Record<string, number> = {
  oil:          0.91,   // olive/rapeseed/sunflower all ~0.91-0.92
  vinegar:      1.01,
  syrup:        1.30,
  honey:        1.42,
  milk:         1.03,
  cream:        1.00,
  water_based:  1.00,   // stock, broth, juice, water itself
  butter:       0.86,   // melted (chefs measure butter by volume after melting)
  alcohol:      0.95,
  sauce:        1.05,   // tomato, gravy
  other:        1.00,   // last-resort default
}

const SYSTEM_PROMPT = `You classify cooking/food products and pick a density in g/ml so a recipe asking "30 g of olive oil" can be costed by a supplier line priced per ml.

CLASSES + CONVENTION DENSITIES:
  - oil         (olive, rapeseed, sunflower, sesame, ...)          → 0.91
  - vinegar     (wine, balsamic, apple cider, rice, ...)            → 1.01
  - syrup       (sugar syrup, agave, maple, simple syrup, ...)      → 1.30
  - honey                                                           → 1.42
  - milk        (whole, skimmed, oat, soy, almond, ...)             → 1.03
  - cream       (heavy, light, sour, crème fraîche, double, ...)    → 1.00
  - water_based (stock, broth, juice, water, lemonade, ...)         → 1.00
  - butter      (always melted in volumetric cooking)               → 0.86
  - alcohol     (wine, spirits, beer used as ingredient)            → 0.95
  - sauce       (tomato, gravy, soy, fish, ...)                     → 1.05
  - other       (anything that doesn't fit above)                   → 1.00

NAME RECOGNITION — Swedish + Italian common:
  - "olja", "olio", "oil", "EVO", "rapsolja", "olivolja"            → oil
  - "vinäger", "aceto", "vinegar", "balsamico"                      → vinegar
  - "honung", "miele", "honey"                                      → honey
  - "sirap", "syrup", "agave", "lönnsirap"                          → syrup
  - "mjölk", "latte", "milk", "havremjölk"                          → milk
  - "grädde", "panna", "cream", "fraiche"                           → cream
  - "buljong", "fond", "stock", "broth", "juice", "saft"            → water_based
  - "smör", "butter"                                                → butter
  - "vin", "wine", "brännvin", "öl", "beer", "sprit"                → alcohol
  - "sås", "salsa", "ketchup", "soja", "fisksås"                    → sauce

HONEST-INCOMPLETE — set confidence < 0.85 when:
  - Product class is ambiguous (e.g. "Castorino Cream" — dairy or skincare?)
  - Not actually a cooking ingredient (packaging, cleaning, fee lines)
  - You'd need to guess between two very different densities (e.g. concentrated syrup vs water-based juice)

The OWNER can override any value — don't agonise on close calls in the OIL family (0.91 vs 0.92 is irrelevant for kitchen cost). Just pick the class confidently and emit the convention density.

OUTPUT: Return ONLY valid JSON (no markdown, no commentary):

{
  "items": [
    { "product_id": "<uuid>", "density_g_per_ml": <number>, "classification": "oil|vinegar|syrup|honey|milk|cream|water_based|butter|alcohol|sauce|other", "confidence": <0.0-1.0>, "reasoning": "<1 short sentence>" }
  ]
}

Include every product_id from the input.`

export async function llmDensitySuggestBatch(
  products: ProductForDensityLLM[],
): Promise<DensitySuggestBatchResult> {
  if (products.length === 0) {
    return { ok: true, suggestions: [], skipped: [], tokensIn: 0, tokensOut: 0 }
  }

  const lines = products.map(p => {
    const parts = [`id=${p.product_id}`, `name="${p.name}"`]
    if (p.category) parts.push(`category=${p.category}`)
    if (p.invoice_unit) parts.push(`invoice_unit=${p.invoice_unit}`)
    if (p.base_unit) parts.push(`base_unit=${p.base_unit}`)
    if (p.pack_size != null) parts.push(`pack_size=${p.pack_size}`)
    return parts.join(' | ')
  }).join('\n')

  const userMsg = `Classify these cooking products and return density_g_per_ml for each:\n\n${lines}`

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
      ok: false, suggestions: [], skipped: [],
      tokensIn: 0, tokensOut: 0,
      error: `Anthropic ${result.status}: ${result.errorText.slice(0, 200)}`,
    }
  }

  const blocks = (result.json?.content ?? []) as Array<{ type: string; text?: string }>
  const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
  let parsed: any
  try {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('no JSON object')
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (e: any) {
    return {
      ok: false, suggestions: [], skipped: [],
      tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      raw: text.slice(0, 500),
      error: `JSON parse: ${e.message}`,
    }
  }

  const items: any[] = Array.isArray(parsed.items) ? parsed.items : []
  const suggestions: DensitySuggestion[] = []
  const skipped: Array<{ product_id: string; reason: string; confidence?: number }> = []

  for (const item of items) {
    const pid  = String(item.product_id ?? '').trim()
    const dens = Number(item.density_g_per_ml)
    const conf = Number(item.confidence)
    const cls  = String(item.classification ?? '').trim()
    const rsn  = String(item.reasoning ?? '').slice(0, 200)
    if (!pid) continue
    // Sanity bounds — cooking ingredients 0.5..1.5; CHECK in M120 is 0..5
    // but we narrow here to catch model hallucinations.
    if (!Number.isFinite(dens) || dens < 0.5 || dens > 1.5) {
      skipped.push({ product_id: pid, reason: `out-of-range density: ${item.density_g_per_ml}`, confidence: conf })
      continue
    }
    if (!Number.isFinite(conf) || conf < 0.85) {
      skipped.push({ product_id: pid, reason: `confidence ${conf} below 0.85 (${rsn})`, confidence: conf })
      continue
    }
    suggestions.push({
      product_id:       pid,
      density_g_per_ml: Math.round(dens * 100) / 100,   // 2 decimals — convention densities don't need more
      classification:   cls,
      confidence:       conf,
      reasoning:        rsn,
    })
  }

  const returnedIds = new Set(items.map(i => String(i.product_id ?? '')))
  for (const p of products) {
    if (!returnedIds.has(p.product_id) &&
        !suggestions.find(s => s.product_id === p.product_id) &&
        !skipped.find(s => s.product_id === p.product_id)) {
      skipped.push({ product_id: p.product_id, reason: 'not returned by LLM' })
    }
  }

  return {
    ok: true,
    suggestions,
    skipped,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  }
}
