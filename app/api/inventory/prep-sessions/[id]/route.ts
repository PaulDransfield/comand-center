// app/api/inventory/prep-sessions/[id]/route.ts
//
// GET    — load a session + its lines
// PATCH  — rename, or set completed_at = NOW()
// DELETE — discard (only when not yet completed)
//
// All routes verify the caller owns the parent session's business.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess, requireOperator } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadSession(db: any, sessionId: string) {
  return db
    .from('prep_sessions')
    .select('id, business_id, name, inputs, created_at, completed_at')
    .eq('id', sessionId)
    .maybeSingle()
}

// ── GET ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: session, error } = await loadSession(db, params.id)
  if (error)   return NextResponse.json({ error: error.message }, { status: 500 })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, session.business_id)
  if (forbidden) return forbidden

  const { data: linesRaw } = await db
    .from('prep_session_lines')
    .select('id, kind, entity_id, name_snapshot, total_qty, unit, uncertain, uncertain_reason, source_recipe_ids, dish_recipe_id, dish_name_snapshot, checked_at, checked_by, position')
    .eq('session_id', session.id)
    .order('position')
  const lines = linesRaw ?? []

  // Accountability (M153) — resolve who completed each line to a display name.
  // checked_by is a user id; map to full_name / email via public.users.
  const checkerIds = Array.from(new Set(lines.map((l: any) => l.checked_by).filter(Boolean))) as string[]
  const checkerById = new Map<string, string>()
  if (checkerIds.length > 0) {
    const { data: us } = await db.from('users').select('id, full_name, email').in('id', checkerIds)
    for (const u of us ?? []) checkerById.set((u as any).id, (u as any).full_name || (u as any).email || 'Unknown')
  }

  // M156 — resolve each line's parent-dish TYPE (pizza/pasta/…) so the prep
  // accordion can show a type pill next to the dish name.
  const dishIds = Array.from(new Set(lines.map((l: any) => l.dish_recipe_id).filter(Boolean))) as string[]
  const dishTypeById = new Map<string, string | null>()
  if (dishIds.length > 0) {
    const { data: ds } = await db.from('recipes').select('id, type').in('id', dishIds)
    for (const d of ds ?? []) dishTypeById.set((d as any).id, (d as any).type ?? null)
  }

  // Enrichment pass — attach live `meta` to each line so the kitchen
  // can see HOW to prep, not just how much:
  //
  //   - component line: meta.method = recipes.method of the sub-recipe.
  //     Loaded live (not frozen) so owner method edits flow through to
  //     the kitchen mid-service. Method text doesn't change the prep
  //     quantities, so freshness here is safe.
  //
  //   - product line: meta.uses = [{ recipe_id, recipe_name, notes,
  //     quantity, unit }] — every recipe_ingredients row in the
  //     business where product_id = this line's entity_id. Cook sees
  //     the per-dish prep instruction ("quarter the carciofi") next to
  //     the aggregated qty. We don't filter by session source_recipe_ids
  //     — showing every use across the business is more useful than less.
  const componentIds = lines.filter(l => l.kind === 'component').map(l => l.entity_id)
  const productIds   = lines.filter(l => l.kind === 'product'  ).map(l => l.entity_id)

  // Method + notes (fallback when method is null — legacy recipes /
  // bulk-importer writes often land in notes instead) + the sub-recipe's
  // own ingredient list so the modal can let the chef write prep notes
  // ("juice the lemon" / "chop the garlic") against each ingredient
  // EVEN when the sub has no yield set (so its ingredients aren't
  // rolled up as separate product lines). archived_at carried so the
  // UI can surface a "sub-recipe was archived after this session was
  // saved" banner instead of silently serving stale content (H3).
  const methodById   = new Map<string, string | null>()
  const notesById    = new Map<string, string | null>()
  const archivedById = new Map<string, string | null>()
  const subIngredientsByRecipe = new Map<string, Array<{ ingredient_id: string; product_id: string | null; product_name: string | null; quantity: number; unit: string | null; notes: string | null; position: number }>>()
  if (componentIds.length > 0) {
    const { data: rs } = await db
      .from('recipes')
      .select('id, method, notes, archived_at')
      .in('id', componentIds)
    for (const r of rs ?? []) {
      methodById.set(r.id, (r as any).method ?? null)
      notesById.set(r.id, (r as any).notes ?? null)
      archivedById.set(r.id, (r as any).archived_at ?? null)
    }
    const { data: subIngs } = await db
      .from('recipe_ingredients')
      .select('id, recipe_id, product_id, quantity, unit, notes, position, products(name)')
      .in('recipe_id', componentIds)
      .order('position')
    for (const i of subIngs ?? []) {
      const list = subIngredientsByRecipe.get((i as any).recipe_id) ?? []
      list.push({
        ingredient_id: (i as any).id,
        product_id:    (i as any).product_id,
        product_name:  ((i as any).products as any)?.name ?? null,
        quantity:      Number((i as any).quantity ?? 0),
        unit:          (i as any).unit ?? null,
        notes:         (i as any).notes ?? null,
        position:      Number((i as any).position ?? 0),
      })
      subIngredientsByRecipe.set((i as any).recipe_id, list)
    }
  }

  // Map product_id → list of uses across recipes in this business.
  // ingredient_id is the recipe_ingredients row id — needed by the
  // inline-edit UI so it can PATCH the right (recipe, ingredient) target
  // when the chef writes a prep note ("juice and zest the lemon").
  //
  // Two-step query — DON'T use recipes!inner here. recipe_ingredients
  // has TWO FKs to recipes (recipe_id AND subrecipe_id); the embed's
  // auto-detected join can pick subrecipe_id and the inner join drops
  // every row with a NULL subrecipe (which is most product ingredients).
  // The two-step pattern joins on recipe_id explicitly and avoids the
  // ambiguity entirely.
  const usesByProductId = new Map<string, Array<{ ingredient_id: string; recipe_id: string; recipe_name: string | null; notes: string | null; quantity: number; unit: string | null }>>()
  if (productIds.length > 0) {
    const { data: bizRecipes } = await db
      .from('recipes')
      .select('id, name')
      .eq('business_id', session.business_id)
      .is('archived_at', null)
    const bizRecipeIds = (bizRecipes ?? []).map((r: any) => r.id)
    const nameByRecipeId = new Map<string, string | null>()
    for (const r of bizRecipes ?? []) nameByRecipeId.set(r.id, (r as any).name ?? null)

    if (bizRecipeIds.length > 0) {
      const { data: ris } = await db
        .from('recipe_ingredients')
        .select('id, recipe_id, product_id, quantity, unit, notes')
        .in('product_id', productIds)
        .in('recipe_id', bizRecipeIds)
      for (const r of ris ?? []) {
        const pid = (r as any).product_id as string
        const rid = (r as any).recipe_id as string
        if (!pid || !rid) continue
        const list = usesByProductId.get(pid) ?? []
        list.push({
          ingredient_id: (r as any).id,
          recipe_id:     rid,
          recipe_name:   nameByRecipeId.get(rid) ?? null,
          notes:         (r as any).notes ?? null,
          quantity:      Number((r as any).quantity ?? 0),
          unit:          (r as any).unit ?? null,
        })
        usesByProductId.set(pid, list)
      }
    }
  }

  const enrichedLines = lines.map(l => ({
    ...l,
    checked_by_name: (l as any).checked_by ? (checkerById.get((l as any).checked_by) ?? null) : null,
    dish_type: (l as any).dish_recipe_id ? (dishTypeById.get((l as any).dish_recipe_id) ?? null) : null,
    meta: l.kind === 'component'
      ? {
          method:      methodById.get(l.entity_id)   ?? null,
          notes:       notesById.get(l.entity_id)    ?? null,
          archived_at: archivedById.get(l.entity_id) ?? null,  // H3
          ingredients: subIngredientsByRecipe.get(l.entity_id) ?? [],
        }
      : { uses: usesByProductId.get(l.entity_id) ?? [] },
  }))

  return NextResponse.json({ session, lines: enrichedLines }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

// ── PATCH ──────────────────────────────────────────────────────────────
interface PatchBody {
  name?:     string | null
  // 'now' = mark completed_at to NOW. Anything else ignored. Sending
  // completed_at: null would re-open a completed session, which we
  // deliberately don't expose at this layer — keep history immutable.
  complete?: 'now'
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const op = requireOperator(auth)
  if (op) return op

  let body: PatchBody
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const db = createAdminClient()
  const { data: session, error } = await loadSession(db, params.id)
  if (error)    return NextResponse.json({ error: error.message }, { status: 500 })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, session.business_id)
  if (forbidden) return forbidden

  const patch: Record<string, any> = {}
  if (body.name !== undefined) patch.name = body.name?.toString().trim().slice(0, 200) || null  // H2
  if (body.complete === 'now' && !session.completed_at) {
    patch.completed_at = new Date().toISOString()
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ session }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const { data: updated, error: uErr } = await db
    .from('prep_sessions')
    .update(patch)
    .eq('id', session.id)
    .select('id, business_id, name, inputs, created_at, completed_at')
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({ session: updated }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── DELETE ─────────────────────────────────────────────────────────────
// Only allowed while the session is still active. Completed sessions
// are history — preserve them. CASCADE drops the lines automatically.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const op = requireOperator(auth)
  if (op) return op

  const db = createAdminClient()
  const { data: session, error } = await loadSession(db, params.id)
  if (error)    return NextResponse.json({ error: error.message }, { status: 500 })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, session.business_id)
  if (forbidden) return forbidden
  if (session.completed_at) {
    return NextResponse.json({ error: 'Cannot delete a completed session — it is history' }, { status: 409 })
  }

  const { error: dErr } = await db.from('prep_sessions').delete().eq('id', session.id)
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
