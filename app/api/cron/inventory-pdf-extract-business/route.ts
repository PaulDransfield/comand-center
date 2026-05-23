// app/api/cron/inventory-pdf-extract-business/route.ts
//
// Admin / cron entry point for kicking the PDF extraction worker for a
// single business. Bypasses the user-session auth that
// /api/inventory/lines/extract-pdfs requires, so ops can re-kick a
// stuck business without needing the owner to log in.
//
// POST /api/cron/inventory-pdf-extract-business
//   Body: { business_id, reset_extracting?: boolean }
//   Auth: Bearer CRON_SECRET or ADMIN_SECRET
//
// reset_extracting: optional flag — when true, resets any rows stuck in
// status='extracting' for > 30 min back to 'pending' so the worker
// picks them up again. Useful when an earlier batch crashed mid-flight.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { waitUntil } from '@vercel/functions'
import { runPdfExtractionBatch } from '@/lib/inventory/pdf-extraction-worker'

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
  const businessId       = String(body.business_id ?? '').trim()
  const resetExtracting  = body.reset_extracting  === true
  const chainRematch     = body.chain_rematch     === true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Optional: rescue stuck rows
  let resetCount = 0
  if (resetExtracting) {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { data: stuck } = await db
      .from('invoice_pdf_extractions')
      .update({ status: 'pending', started_at: null })
      .eq('business_id', businessId)
      .eq('status', 'extracting')
      .lt('started_at', cutoff)
      .select('id')
    resetCount = stuck?.length ?? 0
  }

  // Mark state, then auto-chain batches in background until done.
  await db
    .from('inventory_backfill_state')
    .upsert({
      org_id:        biz.org_id,
      business_id:   businessId,
      status:        'pending',
      progress: {
        phase:        'enqueued',
        operation:    'pdf_extraction',
        triggered_at: new Date().toISOString(),
        triggered_by: 'cron_admin',
      },
      started_at:    new Date().toISOString(),
      finished_at:   null,
      error_message: null,
    }, { onConflict: 'business_id' })

  waitUntil(
    runWithAutoChain(db, biz.org_id, businessId, chainRematch).catch(err =>
      db.from('inventory_backfill_state').update({
        status:        'failed',
        error_message: `pdf extraction worker crashed: ${err?.message ?? err}`,
        finished_at:   new Date().toISOString(),
      }).eq('business_id', businessId).then(() => {})
    )
  )

  return NextResponse.json({
    ok:               true,
    status:           'started',
    business:         biz.name,
    business_id:      businessId,
    reset_extracting: resetCount,
    message:          'PDF extraction running in background. Poll invoice_pdf_extractions for progress.',
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// Auto-chain batches until no candidates remain. Bounded total time
// is capped by Vercel's 800 s maxDuration on this function; the worker
// runs its own ~750 s budget per chained call.
//
// When chainRematch=true and extraction reaches remaining=0, fire-and-
// forget kicks the rematch admin endpoint so the catalogue populates
// without a second manual call. Onboarding hook (Phase B.3) uses this.
async function runWithAutoChain(db: any, orgId: string, businessId: string, chainRematch: boolean = false): Promise<void> {
  const STARTED = Date.now()
  const BUDGET_MS = 750_000   // leave 50 s safety margin under maxDuration
  let chained = 0
  while (Date.now() - STARTED < BUDGET_MS) {
    const summary = await runPdfExtractionBatch(db, { org_id: orgId, business_id: businessId })
    chained++
    console.log(JSON.stringify({
      at: 'cron.inventory-pdf-extract.batch',
      business_id: businessId,
      batch: chained,
      ...summary,
    }))
    if (summary.invoices_in_batch === 0 || summary.remaining_after_batch === 0) {
      // No more work. Mark done.
      await db.from('inventory_backfill_state').update({
        status:        'success',
        finished_at:   new Date().toISOString(),
        progress: {
          phase:       'pdf_extraction_complete',
          batches:     chained,
          final_summary: summary,
        },
      }).eq('business_id', businessId)

      // Phase B.3 chain: kick the matcher now that extraction is done.
      if (chainRematch) {
        const base = process.env.NEXT_PUBLIC_APP_URL ??
                     (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
        const secret = process.env.CRON_SECRET
        if (base && secret) {
          fetch(`${base}/api/cron/inventory-rematch-business`, {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${secret}`,
            },
            body: JSON.stringify({ business_id: businessId, chained_from: 'pdf_extract' }),
          }).catch(err => console.error('[inventory-pdf-extract] chain rematch failed:', err))
        }
      }
      return
    }
  }
  // Hit budget — leave state pending so a re-kick continues.
  await db.from('inventory_backfill_state').update({
    status:  'pending',
    progress: {
      phase:    'pdf_extraction_partial',
      batches:  chained,
      reason:   'budget_exhausted_will_resume_on_next_kick',
    },
  }).eq('business_id', businessId)
}
