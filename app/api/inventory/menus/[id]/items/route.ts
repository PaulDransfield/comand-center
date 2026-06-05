// app/api/inventory/menus/[id]/items/route.ts
//
// POST — add a recipe to a menu as a course.
// Body: { recipe_id, qty?, course_position?, note? }
// Validates: recipe must belong to the same business AND match the menu's
// type (food menu accepts non-drink recipes; drink menu accepts drink recipes).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DRINK_TYPES = new Set(['cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free'])
function isDrinkRecipe(type: string | null | undefined): boolean {
  return DRINK_TYPES.has(String(type ?? '').toLowerCase())
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: menu } = await db.from('menus').select('id, business_id, type').eq('id', params.id).maybeSingle()
  if (!menu) return NextResponse.json({ error: 'menu not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, menu.business_id)
  if (forbidden) return forbidden

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const recipeId = String(body.recipe_id ?? '').trim()
  if (!recipeId) return NextResponse.json({ error: 'recipe_id required' }, { status: 400 })
  const qty = body.qty != null ? Number(body.qty) : 1
  if (!Number.isFinite(qty) || qty <= 0) return NextResponse.json({ error: 'qty must be > 0' }, { status: 400 })

  // Recipe must be at the same business AND match the menu's type.
  const { data: recipe } = await db.from('recipes')
    .select('id, business_id, type').eq('id', recipeId).maybeSingle()
  if (!recipe) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  if (recipe.business_id !== menu.business_id) return NextResponse.json({ error: 'recipe belongs to a different business' }, { status: 400 })
  const recipeIsDrink = isDrinkRecipe(recipe.type)
  if (menu.type === 'food' && recipeIsDrink) return NextResponse.json({ error: 'food menus only accept food recipes' }, { status: 400 })
  if (menu.type === 'drink' && !recipeIsDrink) return NextResponse.json({ error: 'drink menus only accept drink recipes' }, { status: 400 })

  // course_position defaults to max+1 so new items append to the end.
  let position = body.course_position != null ? Number(body.course_position) : null
  if (position == null || !Number.isFinite(position)) {
    const { data: maxRow } = await db.from('menu_items')
      .select('course_position').eq('menu_id', menu.id)
      .order('course_position', { ascending: false }).limit(1).maybeSingle()
    position = (maxRow?.course_position ?? -1) + 1
  }

  const note = body.note != null && body.note !== '' ? String(body.note).slice(0, 500) : null

  const { data, error } = await db.from('menu_items')
    .insert({ menu_id: menu.id, recipe_id: recipeId, qty, course_position: position, note })
    .select('id, course_position, qty')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, item: data })
}
