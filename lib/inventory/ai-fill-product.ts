// lib/inventory/ai-fill-product.ts
//
// Shared AI-fill core. The single-product route (/api/inventory/items/[id]/ai-fill)
// and the bulk route (/api/inventory/items/ai-fill-bulk) both call through this
// so the prompt + validation + apply logic stays in one place.
//
// The single route returns the suggestion; the bulk route auto-applies when
// confidence >= threshold. Both write the SAME values to the SAME columns.

import { AI_MODELS } from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'

export interface AiFillSuggestion {
  category?:           string
  pack_size?:          number
  base_unit?:          'g' | 'ml' | 'st'
  weight_per_piece_g?: number | null
  density_g_per_ml?:   number | null
  reasoning?:          string
  confidence?:         number  // 0..1, model-reported
}

export interface AiFillResult {
  ok:              boolean
  error?:          string
  suggestion?:     AiFillSuggestion
  source_article?: { supplier_fortnox_number: string; official_name: string | null; source: string }
}

// Pull the supplier_articles row(s) most relevant to this product, then ask
// Haiku to derive the chef-correct pack_size / base_unit / weight / density /
// category. Returns the suggestion WITHOUT writing anything.
export async function aiFillProduct(db: any, productId: string): Promise<AiFillResult> {
  const { data: product, error: pErr } = await db
    .from('products')
    .select('id, business_id, name, category, invoice_unit, pack_size, base_unit, weight_per_piece_g, density_g_per_ml, default_supplier_name')
    .eq('id', productId)
    .maybeSingle()
  if (pErr)      return { ok: false, error: pErr.message }
  if (!product)  return { ok: false, error: 'product not found' }

  // Find supplier_articles via owner-confirmed aliases + external_catalogue sentinel.
  const { data: aliases } = await db.from('product_aliases')
    .select('id').eq('product_id', productId).eq('is_active', true)
  const aliasIds = (aliases ?? []).map((a: any) => a.id)

  const combos: Array<{ sup: string; art: string; last_seen: string }> = []
  for (let i = 0; i < aliasIds.length; i += 100) {
    const slice = aliasIds.slice(i, i + 100)
    const { data: lines } = await db.from('supplier_invoice_lines')
      .select('supplier_fortnox_number, article_number, invoice_date')
      .eq('business_id', product.business_id)
      .in('product_alias_id', slice)
      .not('article_number', 'is', null)
      .not('supplier_fortnox_number', 'is', null)
      .order('invoice_date', { ascending: false })
      .limit(20)
    for (const l of lines ?? []) {
      combos.push({ sup: l.supplier_fortnox_number, art: l.article_number, last_seen: l.invoice_date })
    }
  }
  const { data: ec } = await db.from('products')
    .select('external_catalogue_source, external_catalogue_article')
    .eq('id', productId).maybeSingle()
  if (ec?.external_catalogue_source && ec?.external_catalogue_article) {
    combos.push({ sup: ec.external_catalogue_source, art: ec.external_catalogue_article, last_seen: '1970-01-01' })
  }
  if (combos.length === 0) {
    return { ok: false, error: 'No linked supplier articles to learn from' }
  }

  const orParts = combos.map(c => `and(supplier_fortnox_number.eq.${c.sup},article_number.eq.${c.art})`)
  const { data: articles } = await db.from('supplier_articles')
    .select('*').or(orParts.join(',')).eq('fetch_status', 'ok').order('updated_at', { ascending: false })
  if (!articles || articles.length === 0) {
    return { ok: false, error: 'No supplier article data found' }
  }

  const summarised = articles.slice(0, 2).map((a: any, i: number) => ({
    idx:                  i + 1,
    supplier_fortnox_number: a.supplier_fortnox_number,
    source:               a.source,
    official_name:        a.official_name,
    brand:                a.brand,
    category_path:        a.category_path,
    gtin:                 a.gtin,
    units_per_pack:       a.units_per_pack,
    units_per_pack_label: a.units_per_pack_label,
    packs_per_master:     a.packs_per_master,
    net_weight_g:         a.net_weight_g,
    brutto_weight_g:      a.brutto_weight_g,
    storage_type:         a.storage_type,
    country_origin:       a.country_origin,
    unit:                 a.unit,
    properties:           a.properties ?? null,
  }))

  const SYSTEM = `You are filling restaurant inventory metadata for a Swedish chef. Read the supplier catalogue data and decide the CORRECT pack_size, base_unit, weight_per_piece_g, density_g_per_ml, and category. Return ONLY strict JSON with these keys:

{
  "category": "food" | "beverage" | "alcohol" | "cleaning" | "disposables" | "other",
  "pack_size": <number>,
  "base_unit": "g" | "ml" | "st",
  "weight_per_piece_g": <number or null>,
  "density_g_per_ml": <number or null>,
  "confidence": <number between 0 and 1>,
  "reasoning": "<one short sentence>"
}

CONFIDENCE rubric — be honest, this drives whether the value auto-applies:
  • 0.95+ : catalogue data is structured and unambiguous (units_per_pack_label + packs_per_master both present and consistent with the product name)
  • 0.85–0.94 : one strong signal (e.g. product name carries "25cl" or "750ml") and density is a textbook value (water, beer, wine, oil)
  • 0.65–0.84 : weight_per_piece_g had to be estimated from typical species values (eggs, fruit) or units_per_pack_label was missing
  • below 0.65 : catalogue data was sparse, suggestion is a best-guess

THE KEY DISTINCTION — countable pieces vs bulk:

A chef's recipe references either "N bottles/cans/pieces of X" OR "N grams/ml of X". The supplier catalogue + product name tells you which model applies.

Rule of thumb: if the product comes from the supplier as DISCRETE INDIVIDUAL UNITS that a chef pulls one at a time (bottles of mineral water, cans of beer, eggs, glasses, plates) — base_unit='st', pack_size=count of pieces per invoice unit. Recipes will say "1 st" or "1 flaska".

If the product is BULK CONTENT poured/scooped from a single container (5 L olive oil canister, 10 kg flour sack, 1 kg vanilla pod jar) — base_unit='g' or 'ml', pack_size=total mass/volume in base_unit. Recipes will say "30 g" or "50 ml".

WORKED EXAMPLES:

(A) San Pellegrino 25cl mineral water, sold KRT of 24 × 25cl bottles, 227 kr/KRT:
  → Chef pulls ONE bottle at a time → countable → base_unit='st', pack_size=24
  Cost: 227 / 24 = 9.46 kr/bottle.
  weight_per_piece_g=250 — DERIVED FROM THE PRODUCT VOLUME (25 cl = 250 ml ≈ 250 g for water at density 1.0).
  DO NOT use brutto_weight_g / count for weight_per_piece. Brutto includes glass + cap + cardboard. Recipes that ask "g of water" want the CONTENT weight only, not bottle weight.

(B) Olive oil 5L canister, 285 kr/canister:
  → Chef pours from one canister → bulk → base_unit='ml', pack_size=5000
  Cost: 285 / 5000 = 0.057 kr/ml. density_g_per_ml=0.91.

(C) Eggs 12-pack (1 carton = 12 eggs), 28 kr/carton:
  → Chef cracks ONE egg at a time → countable → base_unit='st', pack_size=12
  Cost: 28 / 12 = 2.33 kr/egg. weight_per_piece_g=60 (typical Swedish L-size egg net weight; brutto with shell ~65g).

WEIGHT-PER-PIECE rule (when base_unit='st') — CONTENT weight, never brutto:

For BOTTLED LIQUIDS, derive per-piece content volume from ANY of these (they should agree; if they conflict, prefer the lowest-noise source in this order):
  1. units_per_pack_label divided by packs_per_master.
     Example: "6,00 l/Kartong" ÷ 24 bottles = 0.25 l/bottle = 250 ml.
  2. Product name parsed: "25cl"/"75cl"/"330ml"/"500ml" → ml.
     Example: "San Pellegrino Mineralvatten 25cl" → 250 ml.
  3. official_name parsed: same rule.

Then convert ml → g via density:
  - water / mineral water / soft drinks ≈ 1.0 g/ml
  - juice / cordial ≈ 1.04 g/ml
  - wine / beer ≈ 0.99 g/ml
  - spirits (40% ABV) ≈ 0.95 g/ml
  - olive oil ≈ 0.91 g/ml
  - honey / syrup ≈ 1.40 g/ml

For SOLID PIECES (eggs, fruit, baked goods): use net content weight from the catalogue if listed, otherwise typical species values (egg ~60g, lemon ~80g, banana ~120g).

ABSOLUTELY DO NOT divide brutto_weight_g by pack count. Brutto includes glass + caps + labels + cardboard. The recipe-relevant content is what's INSIDE the bottle/can/jar.

(D) Flour 10 kg bag:
  → Chef scoops from one bag → bulk → base_unit='g', pack_size=10000

Default to base_unit='st' for bottled drinks (water, beer, wine, spirits, soft drinks), cans, single-serve packs, eggs, fruit, baked goods sold by piece.
Default to base_unit='ml' for canister/jug-packed liquids (oil, vinegar, syrup, juice concentrate in large containers).
Default to base_unit='g' for bag/sack/bucket-packed solids (flour, sugar, salt, cocoa).

Category: alcohol > beverage > food > cleaning/disposables. Beer/wine/spirits = alcohol. Mineral water / soft drinks / juice = beverage.

Don't invent. If the catalogue lacks data, leave the CURRENT value and lower confidence.`

  const USER = `CURRENT product fields:
${JSON.stringify({
    name:               product.name,
    category:           product.category,
    invoice_unit:       product.invoice_unit,
    pack_size:          product.pack_size,
    base_unit:          product.base_unit,
    weight_per_piece_g: product.weight_per_piece_g,
    density_g_per_ml:   product.density_g_per_ml,
  }, null, 2)}

LINKED SUPPLIER ARTICLE DATA (most recent first):
${JSON.stringify(summarised, null, 2)}

Decide the correct values. Return strict JSON including the confidence field.`

  const res = await anthropicFetch({
    body: {
      model:      AI_MODELS.AGENT,
      max_tokens: 500,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: USER }],
    },
  })
  if (!res.ok) return { ok: false, error: 'AI call failed: ' + res.errorText }

  const txt = res.json?.content?.[0]?.text ?? ''
  let suggestion: AiFillSuggestion
  try {
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('No JSON in response')
    suggestion = JSON.parse(m[0])
  } catch {
    return { ok: false, error: 'AI returned malformed JSON' }
  }

  return {
    ok: true,
    suggestion,
    source_article: {
      supplier_fortnox_number: summarised[0].supplier_fortnox_number,
      official_name:           summarised[0].official_name,
      source:                  summarised[0].source,
    },
  }
}

// Apply a suggestion to a product. Whitelist the fields we write so a
// malformed LLM response can't poke at columns it shouldn't (e.g. name).
export async function applyAiFillSuggestion(db: any, productId: string, s: AiFillSuggestion): Promise<{ ok: boolean; error?: string; applied_fields: string[] }> {
  const patch: Record<string, any> = {}
  const applied: string[] = []

  if (s.category && ['food','beverage','alcohol','cleaning','disposables','other'].includes(s.category)) {
    patch.category = s.category; applied.push('category')
  }
  if (typeof s.pack_size === 'number' && Number.isFinite(s.pack_size) && s.pack_size > 0) {
    patch.pack_size = s.pack_size; applied.push('pack_size')
  }
  if (s.base_unit && ['g','ml','st'].includes(s.base_unit)) {
    patch.base_unit = s.base_unit; applied.push('base_unit')
  }
  if (typeof s.weight_per_piece_g === 'number' && Number.isFinite(s.weight_per_piece_g) && s.weight_per_piece_g > 0) {
    patch.weight_per_piece_g = s.weight_per_piece_g; applied.push('weight_per_piece_g')
  }
  if (typeof s.density_g_per_ml === 'number' && Number.isFinite(s.density_g_per_ml) && s.density_g_per_ml > 0) {
    patch.density_g_per_ml = s.density_g_per_ml; applied.push('density_g_per_ml')
  }
  if (applied.length === 0) return { ok: true, applied_fields: [] }

  const { error } = await db.from('products').update(patch).eq('id', productId)
  if (error) return { ok: false, error: error.message, applied_fields: [] }
  return { ok: true, applied_fields: applied }
}
