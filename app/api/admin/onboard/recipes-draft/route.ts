// app/api/admin/onboard/recipes-draft/route.ts
//
// Phase 3 of the concierge onboarding board: AI recipe drafting — the
// biggest manual-labour saver. For each POS menu item that doesn't have a
// recipe yet, Claude drafts an ingredient list (which products from the
// MATCHED catalogue + a starting quantity/unit). We create the recipe +
// ingredients and link the menu item, so the owner reviews/edits quantities
// on /inventory/recipes (the existing cost engine prices it automatically)
// instead of building each recipe from scratch.
//
// Drafts are tagged in `notes` ("AI DRAFT — …") so the owner knows what to
// confirm. No schema change needed.
//
// One-shot, admin-triggered (costs Sonnet tokens) — not in the auto-drive
// loop. Idempotent: only touches menu items still missing a recipe.
//
// Depends on: POS menu items existing (POS sync / manual) + a matched
// product catalogue (run Auto-build first). With an empty catalogue the
// drafts are poor, so we refuse if there are no products.
//
// POST { business_id, limit? }   Auth: ADMIN_SECRET (org-scoped)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { AI_MODELS } from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { checkAndIncrementAiLimit, logAiRequest } from '@/lib/ai/usage'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const MAX_ITEMS_PER_RUN = 40    // Sonnet handles a menu of this size in one call
const MAX_CATALOGUE     = 400   // product context cap
const DRAFT_NOTE = 'AI DRAFT — review quantities & portions before trusting cost.'

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId = String(body?.business_id ?? '').trim()
  const limit = Math.min(MAX_ITEMS_PER_RUN, Math.max(1, Number(body?.limit) || MAX_ITEMS_PER_RUN))
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })
  const orgId = biz.org_id

  const guard = await requireAdmin(req, { orgId, businessId })
  if (!('ok' in guard)) return guard

  // Menu items still missing a recipe.
  const { data: menuItems, error: miErr } = await db
    .from('pos_menu_items')
    .select('id, name, price_inc_vat')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .is('recipe_id', null)
    .order('name')
    .limit(limit)
  if (miErr) return NextResponse.json({ error: miErr.message }, { status: 500 })
  if (!menuItems || menuItems.length === 0) {
    return NextResponse.json({ ok: true, drafted: 0, message: 'No menu items without a recipe.' })
  }

  // Matched catalogue — drafting is only as good as this.
  const { data: products } = await db
    .from('products')
    .select('id, name, category, invoice_unit, base_unit')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
    .limit(MAX_CATALOGUE)
  if (!products || products.length === 0) {
    return NextResponse.json({ error: 'catalogue_empty', message: 'No products yet — run the catalogue Auto-build first so recipes have ingredients to draw from.' }, { status: 409 })
  }

  // Quota gate for the whole click.
  const usage = await checkAndIncrementAiLimit(db, orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  // ── Ask Claude to draft ingredient lists ─────────────────────────────
  const prodByPrefix = new Map<string, any>()
  for (const p of products) prodByPrefix.set(p.id.slice(0, 8), p)

  const catalogueText = products.map((p: any) =>
    `  [${p.id.slice(0, 8)}] ${p.name} (cat:${p.category ?? '?'}, unit:${p.invoice_unit ?? p.base_unit ?? '?'})`
  ).join('\n')

  const menuText = menuItems.map((m: any, i: number) =>
    `  #${i} ${m.name}${m.price_inc_vat != null ? ` (sells ${m.price_inc_vat} kr)` : ''}`
  ).join('\n')

  const SYSTEM_PROMPT = `You are an expert head chef costing a Swedish restaurant's menu. For each menu item, draft the recipe as a list of ingredients drawn ONLY from the supplier product catalogue provided (reference each by its [8-char-prefix]). Give a realistic per-portion quantity and a sensible unit (g, ml, st) for each ingredient.

RULES:
- Use ONLY product prefixes that appear in the catalogue. Never invent a product. If a clearly-needed ingredient isn't in the catalogue, omit it (the owner will add it).
- Quantities are PER PORTION and realistic for the dish (a pizza ~250-320g dough flour-equivalent, ~80-120g cheese, etc).
- Prefer the product's own unit where natural; otherwise g for solids, ml for liquids, st for countable items.
- If you can't confidently draft an item (unknown dish, no relevant products), return an empty ingredients array for it.
- portions: almost always 1 unless the dish is obviously shared.

Return JSON ONLY, an array with one object per menu item, in input order:
[
  { "i": 0, "portions": 1, "ingredients": [ { "p": "abcd1234", "qty": 280, "unit": "g" }, ... ], "note": "one short sentence" }
]`

  const userMessage = `PRODUCT CATALOGUE (reference by [prefix]):
${catalogueText}

MENU ITEMS TO DRAFT (${menuItems.length}):
${menuText}

Return the JSON array only.`

  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.ANALYSIS,   // Sonnet 4.6 — recipe reasoning quality matters
      max_tokens: 16384,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    },
  })
  if (!result.ok) {
    return NextResponse.json({ error: `Anthropic HTTP ${result.status}: ${result.errorText}` }, { status: 502 })
  }
  await logAiRequest(db, {
    org_id: orgId, request_type: 'inventory_recipe_draft', model: AI_MODELS.ANALYSIS,
    input_tokens: result.tokensIn, output_tokens: result.tokensOut, duration_ms: result.durationMs,
  }).catch(() => {})

  const rawText = result.json?.content?.[0]?.text ?? ''
  let parsed: any[]
  try {
    parsed = JSON.parse(rawText.slice(rawText.indexOf('['), rawText.lastIndexOf(']') + 1))
  } catch (e: any) {
    return NextResponse.json({ error: `Failed to parse Claude response: ${String(e?.message ?? e)}` }, { status: 502 })
  }
  const byIndex = new Map<number, any>()
  for (const entry of parsed) if (Number.isInteger(entry?.i)) byIndex.set(entry.i, entry)

  // ── Create recipes + ingredients + link the menu item ────────────────
  const summary = { drafted: 0, ingredients_added: 0, skipped_no_ingredients: 0, linked_existing: 0, errors: [] as string[] }

  for (let i = 0; i < menuItems.length; i++) {
    const item = menuItems[i]
    const draft = byIndex.get(i)
    const ings = Array.isArray(draft?.ingredients) ? draft.ingredients : []
    // Resolve product prefixes → full ids (drop hallucinations).
    const resolved = ings
      .map((g: any) => ({ product: prodByPrefix.get(String(g?.p ?? '').slice(0, 8)), qty: Number(g?.qty), unit: g?.unit ? String(g.unit) : null }))
      .filter((g: any) => g.product && Number.isFinite(g.qty) && g.qty > 0)

    if (resolved.length === 0) { summary.skipped_no_ingredients++; continue }

    try {
      // Create the recipe header. If the name already exists, link the menu
      // item to it instead of drafting a duplicate.
      const portions = Math.max(1, Math.floor(Number(draft?.portions) || 1))
      const note = `${DRAFT_NOTE}${draft?.note ? ' ' + String(draft.note).slice(0, 200) : ''}`
      let recipeId: string
      const { data: created, error: cErr } = await db
        .from('recipes')
        .insert({
          business_id: businessId, org_id: orgId,
          name: item.name, type: null,
          menu_price: item.price_inc_vat != null ? Number(item.price_inc_vat) : null,
          portions, notes: note,
        })
        .select('id')
        .single()
      if (cErr) {
        if ((cErr as any).code === '23505') {
          const { data: existing } = await db.from('recipes').select('id').eq('business_id', businessId).eq('name', item.name).maybeSingle()
          if (!existing) { summary.errors.push(`${item.name}: ${cErr.message}`); continue }
          recipeId = existing.id
          await db.from('pos_menu_items').update({ recipe_id: recipeId }).eq('id', item.id)
          summary.linked_existing++
          continue   // don't append ingredients to a recipe that already existed
        }
        summary.errors.push(`${item.name}: ${cErr.message}`); continue
      } else {
        recipeId = created.id
      }

      // Insert ingredients (fresh recipe → plain insert, positions 0..n).
      const rows = resolved.map((g: any, pos: number) => ({
        recipe_id:    recipeId,
        product_id:   g.product.id,
        subrecipe_id: null,
        quantity:     g.qty,
        unit:         g.unit ?? g.product.invoice_unit ?? null,
        notes:        null,
        position:     pos,
      }))
      const { error: iErr } = await db.from('recipe_ingredients').insert(rows)
      if (iErr) { summary.errors.push(`${item.name} ingredients: ${iErr.message}`); continue }

      await db.from('pos_menu_items').update({ recipe_id: recipeId }).eq('id', item.id)
      summary.drafted++
      summary.ingredients_added += rows.length
    } catch (e: any) {
      summary.errors.push(`${item.name}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  return NextResponse.json({ ok: true, ...summary, items_seen: menuItems.length }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
