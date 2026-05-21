// app/api/inventory/lines/rematch/route.ts
//
// "Re-match" endpoint. Walks already-persisted supplier_invoice_lines
// rows for a business and re-runs the matcher on them — without
// re-fetching from Fortnox. Useful after:
//
//   - lib/inventory/categories.ts allowlist changes (e.g. broadening
//     the inventory BAS range; lines that were 'not_inventory' under
//     the old rules can be re-evaluated)
//   - matcher logic tweaks
//   - manually flipping lines back to 'needs_review' via SQL
//
// Default: process ALL non-matched lines (status IN ('not_inventory',
// 'needs_review')). Pass `?only_not_inventory=1` to limit to the
// not_inventory rows specifically (e.g. after broadening the
// allowlist).
//
// Background-worker pattern same as the backfill: kick + waitUntil +
// status row. Same poll endpoint at /backfill/status returns the
// progress — the inventory_backfill_state row is reused (one in-flight
// op per business at a time).

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { waitUntil } from '@vercel/functions'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { matchInvoiceLine, type InvoiceLineForMatching, type MatchOutcome } from '@/lib/inventory/matcher'

export async function POST(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const businessId      = String(body.business_id ?? '').trim()
  const onlyNotInv      = !!body.only_not_inventory
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Reset state row for the new run (mirrors the backfill kick's UPSERT).
  await db
    .from('inventory_backfill_state')
    .upsert({
      org_id:        auth.orgId,
      business_id:   businessId,
      status:        'pending',
      progress:      {
        phase:         'enqueued',
        operation:     onlyNotInv ? 'rematch_not_inventory_only' : 'rematch_all',
        triggered_at:  new Date().toISOString(),
        triggered_by:  auth.userId,
      },
      started_at:    new Date().toISOString(),
      finished_at:   null,
      error_message: null,
    }, { onConflict: 'business_id' })

  // Fire worker. Errors caught + persisted by the worker.
  waitUntil(
    runRematch(db, businessId, auth.orgId, onlyNotInv).catch(err =>
      db.from('inventory_backfill_state').update({
        status:        'failed',
        error_message: `rematch crashed: ${err?.message ?? err}`,
        finished_at:   new Date().toISOString(),
      }).eq('business_id', businessId).then(() => {})
    )
  )

  return NextResponse.json({
    ok:          true,
    status:      'started',
    business_id: businessId,
    only_not_inventory: onlyNotInv,
    message:     'Rematch running in the background. Poll /api/inventory/lines/backfill/status for progress.',
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

// ─────────────────────────────────────────────────────────────────────

async function runRematch(
  db:           any,
  businessId:   string,
  orgId:        string,
  onlyNotInv:   boolean,
): Promise<void> {
  const p: any = {
    phase:                  'matching',
    operation:              onlyNotInv ? 'rematch_not_inventory_only' : 'rematch_all',
    invoices_found:         0,
    invoices_processed:     0,
    lines_inserted:         0,
    lines_skipped_existing: 0,
    lines_matched:          0,
    lines_needs_review:     0,
    lines_not_inventory:    0,
    errors:                 [],
    error_count:            0,
    rematched_total:        0,
  }
  await flush(db, businessId, 'running', p)

  // Pull the candidate rows in pages of 500. Bypass RLS via the
  // service-role client (we're inside a background worker, not a
  // user-request context).
  const targetStatuses = onlyNotInv ? ['not_inventory'] : ['not_inventory', 'needs_review']

  let total = 0
  const pageSize = 500
  let pageFrom = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: rows, error } = await db
      .from('supplier_invoice_lines')
      .select('id, org_id, business_id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, unit, account_number')
      .eq('business_id', businessId)
      .in('match_status', targetStatuses)
      // Only act on rows that aren't already linked. Defensive — the
      // matcher's own contract says it skips matched rows anyway.
      .is('product_alias_id', null)
      .range(pageFrom, pageFrom + pageSize - 1)
    if (error) {
      p.errors.push({ invoice: '(load)', error: error.message })
      p.error_count += 1
      break
    }
    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const lineInput: InvoiceLineForMatching = {
        id:                       row.id,
        business_id:              row.business_id,
        org_id:                   row.org_id,
        supplier_fortnox_number:  row.supplier_fortnox_number,
        supplier_name_snapshot:   row.supplier_name_snapshot,
        article_number:           row.article_number,
        raw_description:          row.raw_description,
        unit:                     row.unit,
        account_number:           row.account_number,
      }
      let outcome: MatchOutcome
      try {
        outcome = await matchInvoiceLine(db, lineInput)
      } catch (e: any) {
        p.errors.push({ invoice: row.id, error: `matcher: ${e?.message ?? e}` })
        p.error_count += 1
        continue
      }

      const update: any = {
        match_status:     outcome.status,
        product_alias_id: outcome.alias_id,
        match_candidates: outcome.candidates.length ? outcome.candidates : null,
      }
      if (outcome.status === 'matched' || outcome.status === 'not_inventory') {
        update.matched_at = new Date().toISOString()
      }
      await db.from('supplier_invoice_lines').update(update).eq('id', row.id)

      if (outcome.status === 'matched')          p.lines_matched      += 1
      else if (outcome.status === 'needs_review') p.lines_needs_review += 1
      else if (outcome.status === 'not_inventory') p.lines_not_inventory += 1

      total += 1
      p.rematched_total = total
    }

    // Cap errors[] to last 20 in the persisted row so the column doesn't bloat.
    if (p.errors.length > 20) p.errors = p.errors.slice(-20)

    await flush(db, businessId, 'running', p)

    if (rows.length < pageSize) break
    pageFrom += pageSize
  }

  p.phase = 'done'
  await db.from('inventory_backfill_state').update({
    status:        'completed',
    progress:      p,
    finished_at:   new Date().toISOString(),
    error_message: null,
  }).eq('business_id', businessId)
}

async function flush(db: any, businessId: string, status: 'running', p: any) {
  await db.from('inventory_backfill_state')
    .update({ status, progress: p })
    .eq('business_id', businessId)
}
