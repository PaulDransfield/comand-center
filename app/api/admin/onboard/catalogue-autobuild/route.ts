// app/api/admin/onboard/catalogue-autobuild/route.ts
//
// Phase 2 of the concierge onboarding board: one-click "Auto-build
// catalogue". Server-side, admin-driven:
//   1. Generates AI suggestions across the whole needs_review queue
//      (reuses lib/inventory/ai-suggest-core — the same Haiku classifier
//      the /inventory/review page uses), in batches of 120 groups.
//   2. Auto-applies every suggestion at/above the AI's own review
//      threshold (confidence ≥ 0.65 AND action ≠ 'review'):
//        - create_new       → create product + alias, link lines (matched)
//        - approve_existing  → link to the suggested existing product
//        - skip_non_inventory→ mark lines not_inventory
//   3. Leaves genuine ambiguities (action='review' / low confidence) for
//      the owner — that residual is what the board shows as "to review".
//
// NOT part of the auto-drive loop (it costs Haiku tokens) — the board
// fires it once per click. Idempotent: re-running re-classifies whatever
// is still needs_review and applies the confident ones.
//
// The "other" bucket is handled separately by the nightly recategorise
// cron + the /inventory/items "Sort other" button, so it's out of scope here.
//
// POST { business_id }   Auth: ADMIN_SECRET (org-scoped via requireAdmin)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { checkAndIncrementAiLimit } from '@/lib/ai/usage'
import { buildGroups, runClaudeBatch, MAX_GROUPS_PER_RUN } from '@/lib/inventory/ai-suggest-core'
import { createProductFromLine, type InvoiceLineForMatching } from '@/lib/inventory/matcher'
import { normaliseDescription } from '@/lib/inventory/normalise'
import type { InventoryCategory } from '@/lib/inventory/categories'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const APPLY_CONFIDENCE = 0.65   // matches the AI's own 'review' cutoff + the bulk-apply UI
// ONE Haiku chunk per request (~90-120s) so a single call never approaches
// the 300s function cap. Big catalogues take several chunks — the board
// chains the calls, and the cache below means already-classified groups are
// skipped on subsequent rounds (no redundant Haiku spend).
const VALID_CATEGORIES: InventoryCategory[] = [
  'food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other',
]

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId = String(body?.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })
  const orgId = biz.org_id

  const guard = await requireAdmin(req, { orgId, businessId })
  if (!('ok' in guard)) return guard

  // Coarse per-org quota gate for the whole click (the per-call logAiRequest
  // inside runClaudeBatch feeds the cost dashboard separately).
  const usage = await checkAndIncrementAiLimit(db, orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  // ── Load the needs_review lines (with ids, so we can apply directly) ──
  const { data: lines, error: linesErr } = await db
    .from('supplier_invoice_lines')
    .select('id, org_id, business_id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, unit, account_number, price_per_unit, total_excl_vat, invoice_date')
    .eq('business_id', businessId)
    .eq('match_status', 'needs_review')
    .limit(15_000)
  if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 })

  // Group keyed exactly like ai-suggest-core (supplier\x1fnormalised\x1funit
  // → base64url), keeping the line ids + a representative seed per group so
  // we can apply suggestions back to the underlying rows.
  const idsByKey  = new Map<string, string[]>()
  const seedByKey = new Map<string, any>()
  for (const l of (lines ?? [])) {
    const norm = normaliseDescription(l.raw_description ?? '')
    if (!norm) continue
    const unit = (l.unit ?? '').trim().toLowerCase()
    const key = Buffer.from(`${l.supplier_fortnox_number}\x1f${norm}\x1f${unit}`, 'utf-8').toString('base64url')
    if (!idsByKey.has(key)) { idsByKey.set(key, []); seedByKey.set(key, l) }
    idsByKey.get(key)!.push(l.id)
  }

  const groups = buildGroups(lines ?? [])
  if (groups.length === 0) {
    return NextResponse.json({ ok: true, groups: 0, message: 'No needs_review groups to classify.' })
  }
  groups.sort((a, b) => b.line_count - a.line_count)

  // ── 1. Classify ONE chunk of not-yet-classified groups (one Haiku call) ──
  // Skip groups that already have a cached suggestion so chained calls don't
  // re-spend Haiku on the same groups.
  const { data: existingSugg } = await db
    .from('inventory_review_suggestions')
    .select('group_key')
    .eq('business_id', businessId)
  const haveSuggestion = new Set((existingSugg ?? []).map((s: any) => s.group_key))
  const groupsNeedingAi = groups.filter(g => !haveSuggestion.has(g.group_key)).slice(0, MAX_GROUPS_PER_RUN)

  let suggestedCount = 0
  if (groupsNeedingAi.length > 0) {
    const rows = await runClaudeBatch(db, orgId, businessId, groupsNeedingAi)
    suggestedCount = rows.length
  }

  // ── Load all cached suggestions for the business (incl. earlier runs) ──
  const { data: suggestions } = await db
    .from('inventory_review_suggestions')
    .select('group_key, action, confidence, product_id, suggested_name, suggested_category')
    .eq('business_id', businessId)

  // Existing products → resolve approve_existing name + category.
  const { data: products } = await db
    .from('products')
    .select('id, name, category')
    .eq('business_id', businessId)
  const prodById = new Map<string, { name: string; category: string }>()
  for (const p of (products ?? [])) prodById.set(p.id, { name: p.name, category: p.category })

  // ── 2. Apply confident, non-review suggestions ───────────────────────
  const summary = {
    groups: groups.length, suggested: suggestedCount,
    applied_create: 0, applied_approve: 0, applied_skip: 0,
    left_for_review: 0, lines_resolved: 0, errors: [] as string[],
  }

  for (const s of (suggestions ?? [])) {
    const ids = idsByKey.get(s.group_key)
    if (!ids || ids.length === 0) continue   // group no longer needs_review

    const confident = Number(s.confidence ?? 0) >= APPLY_CONFIDENCE && s.action !== 'review'
    if (!confident) { summary.left_for_review++; continue }

    try {
      if (s.action === 'skip_non_inventory') {
        await updateLines(db, ids, { match_status: 'not_inventory' })
        summary.applied_skip++
        summary.lines_resolved += ids.length
        continue
      }

      // create_new | approve_existing → product + alias, then link lines.
      let name: string | null = null
      let category: InventoryCategory = 'other'
      if (s.action === 'approve_existing' && s.product_id && prodById.has(s.product_id)) {
        const p = prodById.get(s.product_id)!
        name = p.name
        category = (VALID_CATEGORIES.includes(p.category as InventoryCategory) ? p.category : 'other') as InventoryCategory
      } else if (s.action === 'create_new' && s.suggested_name) {
        name = String(s.suggested_name).trim()
        category = (VALID_CATEGORIES.includes(s.suggested_category as InventoryCategory) ? s.suggested_category : 'other') as InventoryCategory
      }
      if (!name) { summary.left_for_review++; continue }

      const seed = seedByKey.get(s.group_key)
      const lineForMatcher: InvoiceLineForMatching = {
        id:                       seed.id,
        business_id:              seed.business_id,
        org_id:                   seed.org_id,
        supplier_fortnox_number:  seed.supplier_fortnox_number,
        supplier_name_snapshot:   seed.supplier_name_snapshot,
        article_number:           seed.article_number,
        raw_description:          seed.raw_description,
        unit:                     seed.unit,
        account_number:           seed.account_number,
      }
      const created = await createProductFromLine(db, lineForMatcher, name, category)
      await updateLines(db, ids, { match_status: 'matched', product_alias_id: created.alias_id })

      if (s.action === 'approve_existing') summary.applied_approve++
      else summary.applied_create++
      summary.lines_resolved += ids.length
    } catch (e: any) {
      summary.errors.push(`${s.group_key.slice(0, 12)}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  // How many review lines remain after this round — drives the board's
  // chaining loop (it re-calls until nothing more is classified or applied).
  const { count: remainingReview } = await db
    .from('supplier_invoice_lines')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('match_status', 'needs_review')

  const appliedTotal = summary.applied_create + summary.applied_approve + summary.applied_skip

  return NextResponse.json({
    ok: true,
    ...summary,
    ai_classified:         suggestedCount,
    applied_total:         appliedTotal,
    remaining_review_lines: remainingReview ?? 0,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

// Chunked .in() update (500-row PostgREST cap).
async function updateLines(db: any, ids: string[], patch: Record<string, any>): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await db
      .from('supplier_invoice_lines')
      .update(patch)
      .in('id', ids.slice(i, i + 500))
    if (error) throw new Error(error.message)
  }
}
