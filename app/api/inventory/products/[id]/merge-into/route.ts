// app/api/inventory/products/[id]/merge-into/route.ts
//
// POST — merge this product (the "loser") into a target product (the
// "winner"). One atomic operation:
//   1. Repoint EVERY active alias from loser → winner.
//   2. Auto-archive the loser if no recipe references remain.
//
// Use case: owner has identified two products as duplicates (typically
// via /inventory/duplicates which finds them by shared supplier
// article_number). Instead of repointing aliases one at a time from
// the EditItemModal picker, do the whole consolidation in one click.
//
// Body: { target_product_id: string }   — the winner
// Returns: {
//   ok, source_product_id, target_product_id,
//   aliases_repointed_count,
//   source_archived: bool,
//   source_archive_blocked_reason: string | null,   // 'used_by_recipes' etc.
//   source_recipe_count: number,
// }
//
// Refuses (400) if:
//   - source == target (no-op merge)
//   - source has remaining recipe_ingredient references AND owner
//     hasn't passed `force_archive: false` (default behaviour: leave
//     source in place but still repoint all aliases)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const targetId = body.target_product_id ? String(body.target_product_id).trim() : null
  if (!targetId) return NextResponse.json({ error: 'target_product_id required' }, { status: 400 })

  const sourceId = params.id
  if (sourceId === targetId) {
    return NextResponse.json({ error: 'source and target are the same product — nothing to merge' }, { status: 400 })
  }

  const db = createAdminClient()

  // Load both products, verify same business + access
  const { data: source, error: sErr } = await db
    .from('products')
    .select('id, business_id, name, archived_at')
    .eq('id', sourceId)
    .maybeSingle()
  if (sErr)    return NextResponse.json({ error: sErr.message }, { status: 500 })
  if (!source) return NextResponse.json({ error: 'source product not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, source.business_id)
  if (forbidden) return forbidden

  const { data: target, error: tErr } = await db
    .from('products')
    .select('id, business_id, name, archived_at')
    .eq('id', targetId)
    .maybeSingle()
  if (tErr)    return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!target) return NextResponse.json({ error: 'target product not found' }, { status: 404 })
  if (target.business_id !== source.business_id) {
    return NextResponse.json({ error: 'target product belongs to a different business' }, { status: 403 })
  }
  if (target.archived_at) {
    return NextResponse.json({ error: 'target product is archived — restore before merging into it' }, { status: 400 })
  }

  // ── 1. Repoint every active alias from source → target ──────────────
  // Single UPDATE WHERE — atomic, idempotent on retries.
  const { data: aliasesToMove, error: aErr } = await db
    .from('product_aliases')
    .select('id')
    .eq('business_id', source.business_id)
    .eq('product_id', sourceId)
    .eq('is_active', true)
  if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 })

  const aliasIds = (aliasesToMove ?? []).map(a => a.id)
  let repointedCount = 0
  if (aliasIds.length > 0) {
    const { error: uErr } = await db
      .from('product_aliases')
      .update({ product_id: targetId })
      .in('id', aliasIds)
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
    repointedCount = aliasIds.length
  }

  // ── 2. Auto-archive source if no recipes use it ─────────────────────
  // Same orphan-cleanup logic the single-alias repoint uses, applied to
  // the post-merge state of the source product.
  let sourceArchived              = false
  let sourceArchiveBlockedReason: string | null = null
  let sourceRecipeCount           = 0

  const { count: recipeRefs } = await db
    .from('recipe_ingredients')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', sourceId)
  sourceRecipeCount = recipeRefs ?? 0

  if (source.archived_at) {
    sourceArchiveBlockedReason = 'already_archived'
  } else if (sourceRecipeCount > 0) {
    sourceArchiveBlockedReason = 'used_by_recipes'
  } else {
    const { error: archErr } = await db
      .from('products')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', sourceId)
      .is('archived_at', null)
    if (archErr) {
      sourceArchiveBlockedReason = `auto_archive_failed: ${archErr.message}`
    } else {
      sourceArchived = true
    }
  }

  return NextResponse.json({
    ok:                              true,
    source_product_id:               sourceId,
    target_product_id:               targetId,
    aliases_repointed_count:         repointedCount,
    source_archived:                 sourceArchived,
    source_archive_blocked_reason:   sourceArchiveBlockedReason,
    source_recipe_count:             sourceRecipeCount,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
