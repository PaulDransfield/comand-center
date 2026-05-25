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
import { checkCronSecret, checkAdminSecret } from '@/lib/admin/check-secret'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

export async function POST(req: NextRequest) {
  noStore()

  if (!checkCronSecret(req) && !checkAdminSecret(req)) {
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
// Matcher chain policy (chainRematch=true):
//   1. EVERY TERMINATION fires the matcher — both 'success' (remaining=0)
//      and 'budget_exhausted'. Catalogue keeps growing during a multi-
//      day extraction run instead of staying empty until the very end.
//   2. Matcher is idempotent — it only processes lines with
//      match_status IN ('not_inventory','needs_review'), so re-running
//      is cheap when there's nothing new.
function kickMatcher(businessId: string, reason: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL ??
               (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  const secret = process.env.CRON_SECRET
  if (!base || !secret) return
  fetch(`${base}/api/cron/inventory-rematch-business`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({ business_id: businessId, chained_from: reason }),
  }).catch(err => console.error('[inventory-pdf-extract] kick matcher failed:', err))
}

// On full extraction completion, kick the catalogue auto-build so products
// are created from the freshly-extracted line descriptions — the last step
// that makes the catalogue appear without a human. The endpoint accepts
// CRON_SECRET and self-chains chunk-by-chunk until the catalogue is built.
function kickCatalogueAutobuild(businessId: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL ??
               (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  const secret = process.env.CRON_SECRET
  if (!base || !secret) return
  fetch(`${base}/api/admin/onboard/catalogue-autobuild`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
    body:    JSON.stringify({ business_id: businessId, chain: 0 }),
  }).catch(err => console.error('[inventory-pdf-extract] kick autobuild failed:', err))
}

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
      if (chainRematch) {
        kickMatcher(businessId, 'pdf_extract_complete')
        // The matcher only LINKS to existing products. On a cold catalogue,
        // the AI auto-build is what CREATES products from the freshly-
        // extracted descriptions — the final step that makes the catalogue
        // appear with no human. It's cron-authed + self-chaining.
        kickCatalogueAutobuild(businessId)
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
  // Also kick matcher on budget exhaustion — catalogue grows with what
  // we have so far instead of waiting for the next sweep tick or final
  // completion 1-2 days out.
  if (chainRematch) kickMatcher(businessId, 'pdf_extract_partial')
}
