// app/api/inventory/prep-sessions/route.ts
//
// GET  /api/inventory/prep-sessions?business_id=X&active=1
//   → 200 { sessions: [...] }
//   Lists active sessions (or all, when active=0/missing) for the business.
//
// POST /api/inventory/prep-sessions
//   body { business_id, name?, items: [{ recipe_id, qty }] }
//   → 200 { session, lines }
//   Runs the prep-list engine on `items`, materialises the result as
//   prep_session_lines (frozen), and returns the new session.
//
//   Refuses if there's already an active session for the business
//   (409 + { error: 'active_session_exists', existing_session_id }).
//   Owner must complete or discard the active session first.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess, requireOperator } from '@/lib/auth/require-role'
import { loadRecipeIndex } from '@/lib/inventory/recipe-cost'
import { aggregatePrepRequirements, type PrepListInput } from '@/lib/inventory/prep-list'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── GET ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const activeOnly = url.searchParams.get('active') === '1'

  const db = createAdminClient()
  let q = db
    .from('prep_sessions')
    .select('id, name, inputs, created_at, completed_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
  if (activeOnly) q = q.is('completed_at', null)
  const { data, error } = await q.limit(activeOnly ? 1 : 50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ sessions: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── POST ───────────────────────────────────────────────────────────────
interface PostBody {
  business_id?: string
  name?:        string | null
  items?:       Array<{ recipe_id?: string; qty?: number }>
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const op = requireOperator(auth)
  if (op) return op

  let body: PostBody
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const items: PrepListInput[] = []
  for (const it of (body.items ?? [])) {
    const rid = String(it?.recipe_id ?? '').trim()
    const qty = Number(it?.qty ?? 0)
    if (!rid || !Number.isFinite(qty) || qty <= 0) continue
    items.push({ recipe_id: rid, qty })
  }
  if (items.length === 0) {
    return NextResponse.json({ error: 'items required (at least one recipe with qty > 0)' }, { status: 400 })
  }

  // H2: cap free-text inputs so a paste-bomb can't fill the row.
  const name = body.name?.toString().trim().slice(0, 200) || null

  const db = createAdminClient()

  // Refuse if an active session already exists for this business.
  // Two layers: the friendly pre-check returns a structured 409, the
  // INSERT below catches Postgres unique-violation (23505) on the
  // partial index `prep_sessions_one_active_idx` to handle the race
  // where two concurrent POSTs both pass the pre-check.
  async function loadExistingActive() {
    return db
      .from('prep_sessions')
      .select('id, name, created_at')
      .eq('business_id', businessId)
      .is('completed_at', null)
      .limit(1)
  }
  const { data: existing } = await loadExistingActive()
  if (existing && existing.length > 0) {
    return NextResponse.json({
      error: 'active_session_exists',
      existing_session_id: existing[0].id,
      existing_session_name: existing[0].name,
      existing_session_created_at: existing[0].created_at,
    }, { status: 409 })
  }

  // Load the recipe index, run the engine — same path the GET preview
  // takes, but here we persist the result.
  const recipeIndex = await loadRecipeIndex(db, businessId)
  const { data: nameRows } = await db
    .from('recipes')
    .select('id, name, type')
    .eq('business_id', businessId)
    .is('archived_at', null)
  const recipeNames = new Map<string, string | null>()
  const recipeTypes = new Map<string, string | null>()
  for (const r of nameRows ?? []) {
    recipeNames.set(r.id, r.name ?? null)
    recipeTypes.set(r.id, (r as any).type ?? null)
  }

  const safeItems = items.filter(i => recipeIndex.has(i.recipe_id))
  if (safeItems.length === 0) {
    return NextResponse.json({ error: 'No recognised recipes in items' }, { status: 400 })
  }

  // M156 — per-dish breakdown. Run the engine once PER DISH so each line
  // carries the quantity for THAT dish and is grouped under it. Multiple
  // chefs can then each own a dish and pull exactly its share, instead of
  // staring at one shared aggregate line with no idea what it's for. The
  // aggregate "Totals" view is derived (summed) at read time.
  const perDish = safeItems.map(item => ({
    recipeId: item.recipe_id,
    dishName: recipeNames.get(item.recipe_id) ?? null,
    result:   aggregatePrepRequirements([item], recipeIndex, recipeNames),
  }))

  // Look up product names across ALL dishes' product lines.
  const productIds = Array.from(new Set(perDish.flatMap(d => d.result.products.map(p => p.product_id))))
  const nameByProductId = new Map<string, string | null>()
  if (productIds.length > 0) {
    const { data: prods } = await db
      .from('products')
      .select('id, name')
      .in('id', productIds)
    for (const p of prods ?? []) nameByProductId.set(p.id, p.name ?? null)
  }

  // Flags aggregated across dishes (dedup by message).
  const flagSet = new Map<string, any>()
  for (const d of perDish) {
    for (const f of d.result.flags ?? []) {
      flagSet.set(JSON.stringify(f), f)
    }
  }
  const allFlags = Array.from(flagSet.values())

  // Insert the session header. H1: catch the 23505 unique-violation
  // race (two concurrent POSTs both passed the pre-check) and return
  // the same friendly 409 shape with the now-existing session id.
  const { data: session, error: sErr } = await db
    .from('prep_sessions')
    .insert({
      org_id:       auth.orgId,
      business_id:  businessId,
      name,
      inputs:       safeItems,
      created_by:   (auth as any).userId ?? null,
    })
    .select('id, name, inputs, created_at, completed_at')
    .single()
  if (sErr || !session) {
    if ((sErr as any)?.code === '23505') {
      const { data: now } = await loadExistingActive()
      const winner = now?.[0]
      return NextResponse.json({
        error: 'active_session_exists',
        existing_session_id: winner?.id ?? null,
        existing_session_name: winner?.name ?? null,
        existing_session_created_at: winner?.created_at ?? null,
        note: 'Concurrent create; another session won the race.',
      }, { status: 409 })
    }
    return NextResponse.json({ error: sErr?.message ?? 'Failed to create session' }, { status: 500 })
  }

  // Materialise lines, grouped per dish. Within each dish: components first
  // (sub-recipes to make), then products (raw ingredients to pull). position
  // runs continuously across dishes so the display order is stable.
  const lineRows: any[] = []
  let pos = 0
  for (const d of perDish) {
    for (const c of d.result.components) {
      lineRows.push({
        session_id:         session.id,
        kind:               'component',
        entity_id:          c.subrecipe_id,
        name_snapshot:      c.name ?? c.subrecipe_id.slice(0, 8),
        total_qty:          c.total_qty,
        unit:               c.unit,
        uncertain:          c.uncertain,
        uncertain_reason:   c.uncertain_reason,
        source_recipe_ids:  c.source_recipes,
        dish_recipe_id:     d.recipeId,
        dish_name_snapshot: d.dishName,
        position:           pos++,
      })
    }
    for (const p of d.result.products) {
      lineRows.push({
        session_id:         session.id,
        kind:               'product',
        entity_id:          p.product_id,
        name_snapshot:      p.name ?? nameByProductId.get(p.product_id) ?? p.product_id.slice(0, 8),
        total_qty:          p.total_qty,
        unit:               p.unit,
        uncertain:          null,
        uncertain_reason:   null,
        source_recipe_ids:  p.source_recipes,
        dish_recipe_id:     d.recipeId,
        dish_name_snapshot: d.dishName,
        position:           pos++,
      })
    }
  }

  if (lineRows.length > 0) {
    const { error: lErr } = await db.from('prep_session_lines').insert(lineRows)
    if (lErr) {
      // Roll back the session header so we don't strand an empty session.
      await db.from('prep_sessions').delete().eq('id', session.id)
      return NextResponse.json({ error: lErr.message }, { status: 500 })
    }
  }

  const { data: lines } = await db
    .from('prep_session_lines')
    .select('id, kind, entity_id, name_snapshot, total_qty, unit, uncertain, uncertain_reason, source_recipe_ids, dish_recipe_id, dish_name_snapshot, checked_at, position')
    .eq('session_id', session.id)
    .order('position')

  // Attach dish_type so the accordion's type pill shows immediately on create
  // (the GET resolves this live too; here we mirror it so there's no "no pill
  // until reload" gap right after creating a session).
  const linesWithType = (lines ?? []).map(l => ({
    ...l,
    dish_type: (l as any).dish_recipe_id ? (recipeTypes.get((l as any).dish_recipe_id) ?? null) : null,
  }))

  return NextResponse.json({ session, lines: linesWithType, flags: allFlags }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
