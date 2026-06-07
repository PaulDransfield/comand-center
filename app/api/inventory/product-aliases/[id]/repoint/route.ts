// app/api/inventory/product-aliases/[id]/repoint/route.ts
//
// POST — change which product an alias points to. This is the article-
// connection edit from the Edit-Item modal.
//
// PROPAGATION DESIGN (see edit-item-modal-propagation-addendum.md):
//
//   supplier_invoice_lines link to product_aliases.id via product_alias_id.
//   The product_alias_id → product_id join is resolved AT READ TIME in
//   every cost reader (getProductLatestPrices: SELECT aliases WHERE
//   product_id=X → then SELECT supplier_invoice_lines WHERE
//   product_alias_id IN (aliases)). So:
//
//   - Repointing alias X from product A to product B requires ONE
//     UPDATE on product_aliases.product_id.
//   - product A's next cost read no longer sees X's invoice history.
//   - product B's next cost read DOES see it.
//   - Recipes consuming either product re-cost from the new attribution
//     on next render — no synchronous cascade, no Save hang.
//
//   That's why this endpoint completes in milliseconds even when the
//   alias has hundreds of historical lines: nothing about those lines
//   changes; only the alias's pointer does, and the cost reader follows
//   the new pointer on next read.
//
// Body: { product_id: string }   — the new product target
// Returns: { ok, alias_id, previous_product_id, new_product_id, dependent_lines_count }
//
// Idempotent: repointing to the current product is a no-op (returns ok with
// previous=new). Idempotent on retries — same UPDATE.

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
  const newProductId = body.product_id ? String(body.product_id).trim() : null
  if (!newProductId) return NextResponse.json({ error: 'product_id required' }, { status: 400 })

  const db = createAdminClient()

  // Load alias + its business + verify access.
  const { data: alias, error: aErr } = await db
    .from('product_aliases')
    .select('id, business_id, product_id, supplier_fortnox_number, raw_description, is_active')
    .eq('id', params.id)
    .maybeSingle()
  if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 })
  if (!alias) return NextResponse.json({ error: 'alias not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, alias.business_id)
  if (forbidden) return forbidden

  if (!alias.is_active) {
    return NextResponse.json({ error: 'alias is inactive — reactivate before repointing' }, { status: 400 })
  }

  // Verify the target product exists AND is in the same business.
  // Cross-business repointing would corrupt attribution; reject loudly.
  const { data: target, error: tErr } = await db
    .from('products')
    .select('id, business_id, name')
    .eq('id', newProductId)
    .maybeSingle()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!target) return NextResponse.json({ error: 'target product not found' }, { status: 404 })
  if (target.business_id !== alias.business_id) {
    return NextResponse.json({ error: 'target product belongs to a different business' }, { status: 403 })
  }

  // Idempotent: already pointing where we want?
  if (alias.product_id === newProductId) {
    return NextResponse.json({
      ok: true,
      alias_id:            alias.id,
      previous_product_id: alias.product_id,
      new_product_id:      newProductId,
      no_op:               true,
      dependent_lines_count: null,
    })
  }

  // Count dependent lines for the response so the UI can show "this
  // affected N historical lines" — informational only, not a cascade.
  const { count: depCount } = await db
    .from('supplier_invoice_lines')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', alias.business_id)
    .eq('product_alias_id', alias.id)

  // The single UPDATE — propagation is computational from this point.
  const { error: uErr } = await db
    .from('product_aliases')
    .update({ product_id: newProductId })
    .eq('id', alias.id)
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  // ── Orphan cleanup of the previous product ──────────────────────────
  // A product whose last alias just moved away is now a ghost row:
  // appears in /inventory/items with no article + no price + no supplier.
  // Owner reported this surfaced as visual noise after consolidating
  // duplicates. Auto-archive the previous product when ALL of:
  //   - It has zero remaining active aliases.
  //   - No active recipe_ingredient references it (would break recipes).
  //   - It's not already archived (idempotent).
  // Otherwise leave it alone and report WHY so the UI can guide the owner.
  let oldProductArchived       = false
  let oldProductRecipeCount    = 0
  let oldProductRemainingAliases = 0
  let oldProductArchiveBlockedReason: string | null = null
  if (alias.product_id) {
    const [{ count: remainingAliases }, { count: recipeRefs }, { data: oldProduct }] = await Promise.all([
      db.from('product_aliases')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', alias.product_id)
        .eq('is_active', true),
      db.from('recipe_ingredients')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', alias.product_id),
      db.from('products')
        .select('id, name, archived_at')
        .eq('id', alias.product_id)
        .maybeSingle(),
    ])
    oldProductRemainingAliases = remainingAliases ?? 0
    oldProductRecipeCount      = recipeRefs ?? 0

    const alreadyArchived = !!oldProduct?.archived_at
    if (alreadyArchived) {
      oldProductArchiveBlockedReason = 'already_archived'
    } else if (oldProductRemainingAliases > 0) {
      oldProductArchiveBlockedReason = 'still_has_aliases'
    } else if (oldProductRecipeCount > 0) {
      oldProductArchiveBlockedReason = 'used_by_recipes'
    } else {
      const { error: archErr } = await db
        .from('products')
        .update({ archived_at: new Date().toISOString() })
        .eq('id', alias.product_id)
        .is('archived_at', null)
      if (archErr) {
        // Auto-archive is best-effort — don't fail the whole repoint if it
        // trips on a RLS quirk or constraint. Surface the reason in the
        // response so the owner can archive manually.
        oldProductArchiveBlockedReason = `auto_archive_failed: ${archErr.message}`
      } else {
        oldProductArchived = true
      }
    }
  }

  return NextResponse.json({
    ok: true,
    alias_id:              alias.id,
    previous_product_id:   alias.product_id,
    new_product_id:        newProductId,
    no_op:                 false,
    dependent_lines_count: depCount ?? null,
    old_product_archived:                 oldProductArchived,
    old_product_remaining_aliases_count:  oldProductRemainingAliases,
    old_product_recipe_count:             oldProductRecipeCount,
    old_product_archive_blocked_reason:   oldProductArchiveBlockedReason,
    propagation:           'live-on-read: dependent cost reads now resolve to the new product on next render',
  }, { headers: { 'Cache-Control': 'no-store' } })
}
