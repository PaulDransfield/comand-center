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
    .select('id, business_id, name, category, invoice_unit, pack_size, base_unit, units_per_pack, weight_per_piece_g, density_g_per_ml, default_supplier_name')
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

  const SYSTEM = `You are filling restaurant inventory metadata for a Swedish chef. Read the supplier catalogue data and decide the CORRECT pack_size, base_unit, units_per_pack, and category. Return ONLY strict JSON with these keys:

{
  "category": "food" | "beverage" | "alcohol" | "cleaning" | "disposables" | "other",
  "pack_size": <number>,             // TOTAL of the invoice unit, in base_unit. e.g. 24 bottles of 250ml in one KRT = pack_size 6000, base_unit 'ml'.
  "base_unit": "g" | "ml" | "st",
  "units_per_pack": <integer or null>,  // for st/count items: how many pieces per pack. null for mass/volume.
  "weight_per_piece_g": <number or null>,  // only for base_unit='st' when relevant (eggs, fruit). null otherwise.
  "density_g_per_ml": <number or null>,    // for liquids when known (olive oil ~0.91, water/water-based ~1.0, syrup ~1.35). null = unknown.
  "reasoning": "<one short sentence>"
}

Hard rules:
1. pack_size is the TOTAL invoice unit in base_unit. KRT of 24x250ml = 6000 ml. NEVER 250.
2. Bottles, cans, packs of single-serving drinks → base_unit='ml' or 'g' depending on contents.
3. "Antal/enhet: 6,00 l/Kartong" means 6 liters per KRT (carton). "Antal per hel förpackning: 24" means 24 single items per outer pack — multiply to get the math.
4. Mass-based items (kg, g) → base_unit='g'; convert kg→g (1 kg = 1000 g).
5. Discrete pieces (eggs, plates, glass straws) → base_unit='st', units_per_pack=count of pieces per KRT.
6. Category: alcohol > beverage > food > cleaning/disposables. "Ehrlich Glass" or "Plåster" = disposables. Beer/wine/spirits = alcohol. Soft drinks/water/juice = beverage.
7. Don't invent. If the catalogue lacks info, leave the field as the CURRENT value.

Be conservative on density. Only set when the product clearly tells you (oil, syrup, mineral water).`

  const USER = `CURRENT product fields:
${JSON.stringify({
    name:              product.name,
    category:          product.category,
    invoice_unit:      product.invoice_unit,
    pack_size:         product.pack_size,
    base_unit:         product.base_unit,
    units_per_pack:    product.units_per_pack,
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
