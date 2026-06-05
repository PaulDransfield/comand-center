// app/api/inventory/items/[id]/ai-fill/route.ts
//
// POST — ask Haiku to derive item-detail fields from the linked
// supplier_articles row. Returns SUGGESTIONS only; the UI shows
// old-vs-new and the owner applies.
//
// Solves the "MS data is right but unorganised" case the owner
// surfaced on San Pellegrino — MS row has 'Antal/enhet: 6,00 l/Kartong'
// + 'Antal per hel förpackning: 24' but the product carries pack_size=250
// (single bottle) and base_unit=ml, so cost math divides by 250 instead
// of 6000 → 24× wrong per-ml price.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { checkAndIncrementAiLimit } from '@/lib/ai/usage'
import { AI_MODELS } from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()

  const { data: product, error: pErr } = await db
    .from('products')
    .select('id, business_id, name, category, invoice_unit, pack_size, base_unit, weight_per_piece_g, density_g_per_ml, default_supplier_name')
    .eq('id', params.id)
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  // Pull the most-relevant supplier_articles row. Mirror the
  // /supplier-article endpoint's combo discovery (alias-derived + the
  // external_catalogue sentinel) but keep just the top hit.
  const { data: aliases } = await db.from('product_aliases')
    .select('id').eq('product_id', product.id).eq('is_active', true)
  const aliasIds = (aliases ?? []).map(a => a.id)

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
  // External catalogue sentinel (Spendrups / Carlsberg / Enjoy / Wine
  // Affair / Lively links from the matcher).
  const { data: ec } = await db.from('products')
    .select('external_catalogue_source, external_catalogue_article')
    .eq('id', product.id).maybeSingle()
  if (ec?.external_catalogue_source && ec?.external_catalogue_article) {
    combos.push({ sup: ec.external_catalogue_source, art: ec.external_catalogue_article, last_seen: '1970-01-01' })
  }
  if (combos.length === 0) {
    return NextResponse.json({ ok: false, error: 'No linked supplier articles to learn from' }, { status: 400 })
  }

  const orParts = combos.map(c => `and(supplier_fortnox_number.eq.${c.sup},article_number.eq.${c.art})`)
  const { data: articles } = await db.from('supplier_articles')
    .select('*').or(orParts.join(',')).eq('fetch_status', 'ok').order('updated_at', { ascending: false })
  if (!articles || articles.length === 0) {
    return NextResponse.json({ ok: false, error: 'No supplier article data found' }, { status: 400 })
  }

  // Build the prompt. Send up to 2 articles in case there are multiple
  // suppliers — LLM picks the more authoritative one.
  const summarised = articles.slice(0, 2).map((a, i) => ({
    idx:               i + 1,
    supplier_fortnox_number: a.supplier_fortnox_number,
    source:            a.source,
    official_name:     a.official_name,
    brand:             a.brand,
    category_path:     a.category_path,
    gtin:              a.gtin,
    units_per_pack:    a.units_per_pack,
    units_per_pack_label: a.units_per_pack_label,
    packs_per_master:  a.packs_per_master,
    net_weight_g:      a.net_weight_g,
    brutto_weight_g:   a.brutto_weight_g,
    storage_type:      a.storage_type,
    country_origin:    a.country_origin,
    unit:              a.unit,
    properties:        a.properties ?? null,
  }))

  const SYSTEM = `You are filling restaurant inventory metadata for a Swedish chef. Read the supplier catalogue data and decide the CORRECT pack_size, base_unit, weight_per_piece_g, density_g_per_ml, and category. Return ONLY strict JSON with these keys:

{
  "category": "food" | "beverage" | "alcohol" | "cleaning" | "disposables" | "other",
  "pack_size": <number>,
  "base_unit": "g" | "ml" | "st",
  "weight_per_piece_g": <number or null>,
  "density_g_per_ml": <number or null>,
  "reasoning": "<one short sentence>"
}

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

WEIGHT-PER-PIECE rule (when base_unit='st'):
  - For BOTTLED LIQUIDS: parse the volume from the product name ("25cl"/"75cl"/"330ml"/"50cl") and convert ml→g using density (water/water-based ≈ 1.0 g/ml; juices ≈ 1.04; wine/spirits ≈ 0.97-1.0; oil ≈ 0.91).
  - For SOLID PIECES (eggs, fruit, baked goods): use net content weight if the catalogue lists it, otherwise typical values (egg ~60g, lemon ~80g, banana ~120g).
  - NEVER divide brutto_weight_g by pack count — that includes container + packaging.

(D) Flour 10 kg bag:
  → Chef scoops from one bag → bulk → base_unit='g', pack_size=10000

Default to base_unit='st' for bottled drinks (water, beer, wine, spirits, soft drinks), cans, single-serve packs, eggs, fruit, baked goods sold by piece.
Default to base_unit='ml' for canister/jug-packed liquids (oil, vinegar, syrup, juice concentrate in large containers).
Default to base_unit='g' for bag/sack/bucket-packed solids (flour, sugar, salt, cocoa).

Category: alcohol > beverage > food > cleaning/disposables. Beer/wine/spirits = alcohol. Mineral water / soft drinks / juice = beverage.

Don't invent. If the catalogue lacks data, leave the CURRENT value.`

  const USER = `CURRENT product fields:
${JSON.stringify({
    name:              product.name,
    category:          product.category,
    invoice_unit:      product.invoice_unit,
    pack_size:         product.pack_size,
    base_unit:         product.base_unit,
    weight_per_piece_g: product.weight_per_piece_g,
    density_g_per_ml:  product.density_g_per_ml,
  }, null, 2)}

LINKED SUPPLIER ARTICLE DATA (most recent first):
${JSON.stringify(summarised, null, 2)}

Decide the correct values. Return strict JSON.`

  const res = await anthropicFetch({
    body: {
      model:      AI_MODELS.AGENT,
      max_tokens: 500,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: USER }],
    },
  })
  if (!res.ok) return NextResponse.json({ error: 'AI call failed: ' + res.errorText }, { status: 502 })

  const txt = res.json?.content?.[0]?.text ?? ''
  let suggestion
  try {
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('No JSON in response')
    suggestion = JSON.parse(m[0])
  } catch (e: any) {
    return NextResponse.json({ error: 'AI returned malformed JSON', raw: txt }, { status: 502 })
  }

  return NextResponse.json({
    ok:         true,
    suggestion,
    source_article: {
      supplier_fortnox_number: summarised[0].supplier_fortnox_number,
      official_name:           summarised[0].official_name,
      source:                  summarised[0].source,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
