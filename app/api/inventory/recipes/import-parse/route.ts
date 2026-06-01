// app/api/inventory/recipes/import-parse/route.ts
//
// Owner-facing AI bulk recipe importer — PARSE step.
//
// Owner pastes a menu (one dish per line, or freer-form text) → Sonnet
// drafts each dish with ingredient quantities drawn from the existing
// product catalogue. Returns the drafts without writing anything — the
// owner reviews them in the UI, edits any quantities/products that look
// wrong, then a separate save step bulk-inserts via the existing
// /api/inventory/recipes POST + /[id]/ingredients POST endpoints.
//
// Reuses the proven prompt + catalogue-prefix-matching pattern from
// /api/admin/onboard/recipes-draft, but owner-facing instead of admin
// (AI-quota-gated, scoped to the caller's businesses).
//
// POST { business_id, menu_text }
//   → { drafts: [{ name, portions, ingredients: [{ product_id, product_name, quantity, unit }] }], tokens_in, tokens_out }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { AI_MODELS } from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { checkAndIncrementAiLimit, logAiRequest } from '@/lib/ai/usage'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const MAX_DISHES      = 40    // Sonnet handles this in one call comfortably
const MAX_CATALOGUE   = 1500  // product context cap. Bumped from 400 after
                              // the Chicce truncation incident — alphabetical
                              // sort meant any product past letter G never
                              // entered Sonnet's context (Mozzarella at 691,
                              // Parmigiano at 783, Ruccola at 943). 1500
                              // comfortably fits Chicce's 854 food products
                              // and Vero's ~600 within ~25k input tokens.
const MAX_INPUT_CHARS = 8000  // ~2000 tokens of menu text; owner can iterate

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body?.business_id ?? '').trim()
  const menuText   = String(body?.menu_text   ?? '').trim()

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!menuText)   return NextResponse.json({ error: 'menu_text required' },   { status: 400 })
  if (menuText.length > MAX_INPUT_CHARS) {
    return NextResponse.json({ error: `menu_text too long (${menuText.length} > ${MAX_INPUT_CHARS} chars)` }, { status: 400 })
  }

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // AI-quota gate. checkAndIncrementAiLimit is the right shape per
  // CLAUDE.md Session 21 invariants — atomic on user-triggered endpoints.
  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  // Catalogue context — owner gets recipes that draw from THEIR
  // catalogue, not hallucinated names.
  //
  // Filter to food + beverage + alcohol categories only. Cleaning
  // supplies, disposables, takeaway packaging wouldn't be ingredients
  // in any sane recipe and just steal tokens. Caught the prior
  // Chicce truncation bug (164 non-edible products pushed real
  // ingredients past the 400-product cutoff).
  const { data: products } = await db
    .from('products')
    .select('id, name, category, invoice_unit, base_unit')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .in('category', ['food', 'beverage', 'alcohol'])
    .order('name')
    .limit(MAX_CATALOGUE)

  if (!products || products.length === 0) {
    return NextResponse.json({
      error:   'catalogue_empty',
      message: 'No products in this business yet — set up the catalogue (Inventory → Articles) before bulk-importing recipes, so the AI has ingredients to reference.',
    }, { status: 409 })
  }

  const prodByPrefix = new Map<string, any>()
  for (const p of products) prodByPrefix.set(p.id.slice(0, 8), p)

  const catalogueText = products.map((p: any) =>
    `  [${p.id.slice(0, 8)}] ${p.name} (cat:${p.category ?? '?'}, unit:${p.invoice_unit ?? p.base_unit ?? '?'})`
  ).join('\n')

  // SYSTEM_PROMPT mirrors the admin recipes-draft version with one
  // difference: input is free-form text (menu paste), not pre-parsed
  // menu items. Tell Sonnet to first identify dishes from the text, then
  // draft ingredients per dish.
  const SYSTEM_PROMPT = `You are an expert head chef costing a Swedish restaurant's menu. The owner has pasted their menu as free-form text. Your job:

1. Identify each distinct DISH in the input. Skip section headers, intros, footers — focus on dish names.
2. For each dish, draft a per-portion ingredient list drawn ONLY from the supplier product catalogue (reference each by its [8-char prefix]).
3. If a dish has a selling price in the input, capture it as selling_price_inc_vat; else leave it null.

── INGREDIENT MATCHING (this is where most drafts fail) ──

Menu language (chef writing) and catalogue language (supplier descriptions) diverge constantly. Match by **what the ingredient IS**, not by string similarity. Examples:

- Menu says "mozzarella"  → match catalogue "Mozzarella per pizza Julienne 2,5kg" or similar (any mozzarella product).
- Menu says "parmesan"    → match "Parmigiano Reggiano DOP" or "Pecorino" (Italian hard cheeses are the chef's "parmesan").
- Menu says "parmaskinka" → match "Prosciutto di Parma" (parma ham). Look for "prosciutto", "skinka", "ham".
- Menu says "ruccola"      → match "Ruccola 200g" or "Ruccola Tvättad 4x500g" (any rocket/arugula).
- Menu says "olivolja"     → match "Olivolja Extra Jungfru" or similar olive oil.
- Menu says "tomatsås"     → match "Pizzatomater", "Mutti Polpa", "Hela Tomater" (any tomato product suitable as a sauce base).
- Menu says "basilika" / "basil" → match "Basilika 100g" or "Basilika Färsk".
- Menu says "pinsa base" / "pizzabotten" → match "Pinsa Base", "FRYS Base pizza", or similar.

The menu is often bilingual (Swedish + English) — both refer to the same ingredient. Translate freely.

RULES:
- Use ONLY product prefixes that appear in the catalogue. Never invent a product.
- For each menu ingredient, scan the ENTIRE catalogue for ANY product that could plausibly fill the role. Don't give up if the chef's word doesn't appear verbatim.
- Quantities are PER PORTION and realistic for the dish:
  * Pinsa/pizza: 200-300g base + 60-100g cheese + 30-50g sauce + ~20-30g garnish each (ham/parmesan/herbs)
  * Salad:      150-200g leaves + 30-80g protein/cheese + 10-20g dressing
  * Pasta:      120-150g pasta + 80-120g sauce/protein + 10g garnish
- Prefer the product's own unit where natural; otherwise g for solids, ml for liquids, st for countable items.
- If a dish references an ingredient that genuinely has no plausible catalogue match (e.g. "elderflower foam" with nothing close), omit it and note this in the dish's note field.
- portions: almost always 1 unless the dish is obviously shared/family-size.
- Up to ${MAX_DISHES} dishes per import.

Return JSON ONLY, an array with one object per dish, in input order:
[
  {
    "name":     "Pinsa Margherita",
    "portions": 1,
    "selling_price_inc_vat": 195,
    "note":     "one short sentence about the dish",
    "ingredients": [
      { "p": "abcd1234", "qty": 280, "unit": "g" }
    ]
  }
]`

  const userMessage = `PRODUCT CATALOGUE (reference by [prefix]):
${catalogueText}

MENU INPUT (free-form text):
${menuText}

Return the JSON array only.`

  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.ANALYSIS,   // Sonnet 4.6
      max_tokens: 16384,
      system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages:   [{ role: 'user', content: userMessage }],
    },
  })
  if (!result.ok) {
    return NextResponse.json({ error: `Anthropic HTTP ${result.status}: ${result.errorText}` }, { status: 502 })
  }
  await logAiRequest(db, {
    org_id:        auth.orgId,
    request_type:  'inventory_recipe_import_parse',
    model:         AI_MODELS.ANALYSIS,
    input_tokens:  result.tokensIn,
    output_tokens: result.tokensOut,
    duration_ms:   result.durationMs,
  }).catch(() => {})

  const rawText = result.json?.content?.[0]?.text ?? ''
  let parsed: any[]
  try {
    parsed = JSON.parse(rawText.slice(rawText.indexOf('['), rawText.lastIndexOf(']') + 1))
  } catch (e: any) {
    return NextResponse.json({
      error:   `Failed to parse AI response: ${String(e?.message ?? e)}`,
      raw:     rawText.slice(0, 500),
    }, { status: 502 })
  }

  // Resolve prefixes → product info; drop any hallucinated products.
  // Owner sees friendly product names in the preview, not 8-char IDs.
  const drafts = (Array.isArray(parsed) ? parsed : [])
    .map((d: any) => {
      const name = String(d?.name ?? '').trim().slice(0, 200)
      if (!name) return null
      const ingredients = (Array.isArray(d?.ingredients) ? d.ingredients : [])
        .map((g: any) => {
          const prod = prodByPrefix.get(String(g?.p ?? '').slice(0, 8))
          const qty  = Number(g?.qty)
          if (!prod || !Number.isFinite(qty) || qty <= 0) return null
          return {
            product_id:   prod.id,
            product_name: prod.name,
            quantity:     qty,
            unit:         g?.unit ? String(g.unit).trim() : (prod.base_unit ?? prod.invoice_unit ?? 'g'),
          }
        })
        .filter(Boolean)
      return {
        name,
        portions:                Math.max(1, Math.floor(Number(d?.portions) || 1)),
        selling_price_inc_vat:   d?.selling_price_inc_vat != null ? Number(d.selling_price_inc_vat) : null,
        note:                    d?.note ? String(d.note).slice(0, 200) : null,
        ingredients,
      }
    })
    .filter(Boolean)

  return NextResponse.json({
    ok:            true,
    drafts,
    tokens_in:     result.tokensIn,
    tokens_out:    result.tokensOut,
    catalogue_size: products.length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
