// app/api/inventory/lines/extract-pdfs/route.ts
//
// Phase B.1 kick endpoint (INVENTORY-PATH-B-PDF-EXTRACTION.md §6.B1).
// Identifies supplier invoices that have empty-description placeholder
// rows from Phase A backfill, fetches the attached PDF, runs Claude
// Sonnet 4.6 vision + tool use to extract structured product rows,
// validates against the Fortnox header total, and replaces the
// placeholders atomically.
//
// Background-worker pattern (same shape as the Phase A backfill):
//   1. UPSERT inventory_backfill_state to 'pending'
//   2. waitUntil(runPdfExtractionBatch)
//   3. Return immediately with { ok, status: 'started' }
//
// The worker processes BATCH_SIZE invoices per call. If more remain,
// auto-chains another batch via waitUntil so the catalogue keeps
// progressing without owner intervention.

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { waitUntil } from '@vercel/functions'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { runPdfExtractionBatch } from '@/lib/inventory/pdf-extraction-worker'

export async function POST(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  await db
    .from('inventory_backfill_state')
    .upsert({
      org_id:        auth.orgId,
      business_id:   businessId,
      status:        'pending',
      progress: {
        phase:        'enqueued',
        operation:    'pdf_extraction',
        triggered_at: new Date().toISOString(),
        triggered_by: auth.userId,
      },
      started_at:    new Date().toISOString(),
      finished_at:   null,
      error_message: null,
    }, { onConflict: 'business_id' })

  waitUntil(
    runWithAutoChain(db, auth.orgId, businessId).catch(err =>
      db.from('inventory_backfill_state').update({
        status:        'failed',
        error_message: `pdf extraction worker crashed: ${err?.message ?? err}`,
        finished_at:   new Date().toISOString(),
      }).eq('business_id', businessId).then(() => {})
    )
  )

  return NextResponse.json({
    ok:          true,
    status:      'started',
    business_id: businessId,
    message:     'PDF extraction running in background. Poll the status endpoint for progress.',
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

// Auto-chain batches until no invoices remain. Each batch is bounded
// by the worker's BATCH_SIZE (currently 40). Hard chain cap (16) keeps
// us inside the 800 s function maxDuration even in the worst case.
const MAX_CHAIN_BATCHES = 16

async function runWithAutoChain(db: any, orgId: string, businessId: string): Promise<void> {
  for (let i = 0; i < MAX_CHAIN_BATCHES; i++) {
    const summary = await runPdfExtractionBatch(db, { org_id: orgId, business_id: businessId })
    if (summary.invoices_in_batch === 0)     break
    if (summary.remaining_after_batch === 0) break
  }
}
