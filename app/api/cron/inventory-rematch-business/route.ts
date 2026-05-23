// app/api/cron/inventory-rematch-business/route.ts
//
// Admin / cron entry point to re-run the matcher across all unmatched
// supplier_invoice_lines rows for a business. Mirrors the auth +
// background-worker pattern of inventory-pdf-extract-business; lets
// ops trigger rematching after a PDF-extraction batch completes
// without needing the owner logged in.
//
// POST /api/cron/inventory-rematch-business
//   Body: { business_id, only_not_inventory?: boolean }
//   Auth: Bearer CRON_SECRET or ADMIN_SECRET
//
// Workflow:
//   1. Pull all rows with match_status IN ('not_inventory','needs_review')
//      (or just 'not_inventory' when only_not_inventory=true)
//   2. Run matchInvoiceLine() on each
//   3. Update row with new status / alias / candidates
//   4. Track progress in inventory_backfill_state
//
// Same worker module as /api/inventory/lines/rematch (the owner-facing
// endpoint) but with cron-secret auth instead of user session.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { waitUntil } from '@vercel/functions'
import { createAdminClient } from '@/lib/supabase/server'
import { matchInvoiceLine, type InvoiceLineForMatching, type MatchOutcome } from '@/lib/inventory/matcher'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

export async function POST(req: NextRequest) {
  noStore()

  const adminSecret = process.env.ADMIN_SECRET
  const cronSecret  = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (!(adminSecret && auth === `Bearer ${adminSecret}`) &&
      !(cronSecret  && auth === `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const onlyNotInv = body.only_not_inventory === true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  await db
    .from('inventory_backfill_state')
    .upsert({
      org_id:        biz.org_id,
      business_id:   businessId,
      status:        'pending',
      progress: {
        phase:        'enqueued',
        operation:    onlyNotInv ? 'rematch_not_inventory_only' : 'rematch_all',
        triggered_at: new Date().toISOString(),
        triggered_by: 'cron_admin',
      },
      started_at:    new Date().toISOString(),
      finished_at:   null,
      error_message: null,
    }, { onConflict: 'business_id' })

  waitUntil(
    runRematch(db, businessId, biz.org_id, onlyNotInv).catch(err =>
      db.from('inventory_backfill_state').update({
        status:        'failed',
        error_message: `rematch crashed: ${err?.message ?? err}`,
        finished_at:   new Date().toISOString(),
      }).eq('business_id', businessId).then(() => {})
    )
  )

  return NextResponse.json({
    ok:                 true,
    status:             'started',
    business:           biz.name,
    business_id:        businessId,
    only_not_inventory: onlyNotInv,
    message:            'Rematch running in background. Poll inventory_backfill_state for progress.',
  }, { headers: { 'Cache-Control': 'no-store' } })
}

async function runRematch(
  db:         any,
  businessId: string,
  orgId:      string,
  onlyNotInv: boolean,
): Promise<void> {
  const p: any = {
    phase:                  'matching',
    operation:              onlyNotInv ? 'rematch_not_inventory_only' : 'rematch_all',
    invoices_processed:     0,
    lines_matched:          0,
    lines_needs_review:     0,
    lines_not_inventory:    0,
    rematched_total:        0,
    errors:                 [],
    error_count:            0,
  }
  const flush = async (status: string) => {
    await db.from('inventory_backfill_state').update({
      progress: p,
      status,
      finished_at: status === 'success' || status === 'failed' ? new Date().toISOString() : null,
    }).eq('business_id', businessId)
  }
  await flush('running')

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
      .is('product_alias_id', null)
      .range(pageFrom, pageFrom + pageSize - 1)
    if (error) {
      p.errors.push({ phase: 'load', error: error.message })
      p.error_count++
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
        p.errors.push({ id: row.id, error: `matcher: ${e?.message ?? e}` })
        p.error_count++
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
      if (outcome.status === 'matched')          p.lines_matched++
      else if (outcome.status === 'needs_review') p.lines_needs_review++
      else if (outcome.status === 'not_inventory') p.lines_not_inventory++
      total++
      p.rematched_total = total
    }

    if (p.errors.length > 20) p.errors = p.errors.slice(-20)
    await flush('running')
    if (rows.length < pageSize) break
    pageFrom += pageSize
  }

  p.phase = 'complete'
  await flush('success')
}
