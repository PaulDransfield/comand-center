// app/api/cron/fortnox-pdf-backfill/route.ts
//
// Phase 2 of INGESTION-PIPELINE-RELIABILITY-PLAN.md (2026-06-06).
//
// Walks every `fortnox_supplier_invoices` row stuck in
// ingestion_status='header_only' and resolves its file_id via
// `resolveSupplierInvoiceFileId` (both Fortnox endpoints). Once resolved,
// the row flips to ingestion_status='complete' with truthful
// ingestion_meta. Self-chains to drain across the 800s Vercel wall.
//
// One row of new business per scheduled tick: pulls one customer's
// next BATCH_SIZE header_only rows, processes them, persists, and if
// any remain self-launches with `?resume=1` until the customer is
// drained, then moves on to the next customer on the next tick.
//
// Why dedicated (not folded into supplier-sync): supplier-sync is
// "what's new since last cron"; this is "fix the history". Different
// time budget, different retry semantics. Keeping them separate means
// a slow backfill never delays daily incremental ingestion.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret } from '@/lib/admin/check-secret'
import { log } from '@/lib/log/structured'
import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { resolveSupplierInvoiceFileId } from '@/lib/fortnox/api/file-connections'
import { openLedger, closeLedger, buildIngestionMeta } from '@/lib/ingestion/ledger'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const BATCH_SIZE  = 50           // 50 invoices per call = ~50-100 Fortnox API calls
const DEADLINE_MS = 270_000      // self-chain when wall clock exceeds 4m 30s — leaves margin under 300s budget
const MAX_RESUMES = 30           // safety cap — 30 × 50 = 1,500 invoices per cron tick

const EXPECTED_FIELDS = ['given_number', 'invoice_date', 'supplier_name', 'total', 'currency', 'file_id', 'has_pdf']

export async function POST(req: NextRequest) { return run(req) }
export async function GET(req: NextRequest)  { return run(req) }   // Vercel cron uses GET

async function run(req: NextRequest): Promise<NextResponse> {
  noStore()
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const startedAt = Date.now()
  const url       = new URL(req.url)
  const resumes   = parseInt(url.searchParams.get('resume') ?? '0', 10) || 0
  if (resumes > MAX_RESUMES) {
    return NextResponse.json({ ok: true, halted: 'max_resumes', resumes })
  }

  const db = createAdminClient()

  // Pull connected Fortnox integrations. Match the supplier-sync's
  // filter ('connected' + 'warning') so a transient warning state
  // doesn't pause backfill progress. ORDER BY oldest last_sync_at first
  // (column is last_sync_at, not last_synced_at — caught one too many
  // times).
  const { data: integs, error: integErr } = await db
    .from('integrations')
    .select('id, org_id, business_id, status, credentials_enc, last_sync_at')
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'warning'])
    .order('last_sync_at', { ascending: true, nullsFirst: true })
    .limit(20)
  if (integErr) {
    log.error('fortnox_pdf_backfill integration query failed', { error: integErr.message })
    return NextResponse.json({ ok: false, error: integErr.message }, { status: 500 })
  }

  let totalProcessed = 0
  let totalResolved  = 0
  let totalNoPdf     = 0
  let totalFailed    = 0
  const results: any[] = []

  for (const integ of integs ?? []) {
    if (Date.now() - startedAt > DEADLINE_MS) {
      // Self-chain so the next chunk continues without waiting for the next scheduled tick.
      void fetch(`${req.nextUrl.origin}/api/cron/fortnox-pdf-backfill?resume=${resumes + 1}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}` },
      })
      log.info('fortnox_pdf_backfill self-chained', { route: 'cron/fortnox-pdf-backfill', resumes: resumes + 1, processed: totalProcessed })
      return NextResponse.json({
        ok: true, self_chained: true, resumes: resumes + 1,
        processed: totalProcessed, resolved: totalResolved, no_pdf: totalNoPdf, failed: totalFailed, results,
      })
    }

    // Pull this customer's next batch of header_only rows.
    const { data: pending } = await db
      .from('fortnox_supplier_invoices')
      .select('given_number, invoice_date, supplier_name')
      .eq('business_id', integ.business_id)
      .eq('ingestion_status', 'header_only')
      .order('invoice_date', { ascending: false })   // newest first — owner cares about recent invoices more
      .limit(BATCH_SIZE)
    if (!pending || pending.length === 0) continue

    let accessToken: string | null
    try {
      accessToken = await getFreshFortnoxAccessToken(db, integ.org_id, integ.business_id)
    } catch (err: any) {
      log.warn('fortnox_pdf_backfill token refresh failed', { route: 'cron/fortnox-pdf-backfill', business_id: integ.business_id, error: err?.message })
      results.push({ business_id: integ.business_id, error: 'token_refresh_failed', skipped: pending.length })
      continue
    }
    if (!accessToken) {
      results.push({ business_id: integ.business_id, error: 'no_access_token', skipped: pending.length })
      continue
    }

    let processed = 0, resolved = 0, noPdf = 0, failed = 0

    for (const row of pending) {
      if (Date.now() - startedAt > DEADLINE_MS) break

      const ledger = await openLedger({
        db,
        source:          'fortnox',
        resource:        'supplier_invoices',
        operation:       'file_connections',
        business_id:     integ.business_id,
        org_id:          integ.org_id,
        expected_fields: ['file_id', 'has_pdf'],
        context:         { given_number: row.given_number, called_from: 'pdf_backfill_worker' },
      })

      const result = await resolveSupplierInvoiceFileId(accessToken, row.given_number)
      processed++

      if (result.kind === 'has_pdf' || result.kind === 'no_pdf') {
        const fileId = result.kind === 'has_pdf' ? result.file_id : null
        if (fileId) resolved++; else noPdf++
        const populated: string[] = ['given_number', 'invoice_date', 'supplier_name', 'total', 'currency', 'has_pdf']
        if (fileId) populated.push('file_id')
        await db.from('fortnox_supplier_invoices')
          .update({
            file_id:            fileId,
            has_pdf:            fileId != null,
            file_id_fetched_at: new Date().toISOString(),
            ingestion_status:   'complete',
            ingestion_meta:     buildIngestionMeta({
              ledgerId:         ledger.id,
              source_path:      'fortnox_pdf_backfill',
              expected_fields:  EXPECTED_FIELDS,
              populated_fields: populated,
              extra:            { resolved_via: result.kind === 'has_pdf' ? result.source : 'no_pdf' },
            }),
          })
          .eq('business_id', integ.business_id)
          .eq('given_number', row.given_number)
        await closeLedger({ db, handle: ledger, populated_fields: fileId ? ['file_id', 'has_pdf'] : ['has_pdf'], rows_processed: 1 })
      } else if (result.kind === 'not_found') {
        // Invoice deleted from Fortnox after we synced its header. Mark
        // as failed so it doesn't loop; ops can spot-check via the log.
        failed++
        await db.from('fortnox_supplier_invoices')
          .update({
            ingestion_status: 'failed',
            ingestion_meta:   buildIngestionMeta({
              ledgerId:         ledger.id,
              source_path:      'fortnox_pdf_backfill',
              expected_fields:  EXPECTED_FIELDS,
              populated_fields: [],
              extra:            { fail_reason: 'not_found_in_fortnox' },
            }),
          })
          .eq('business_id', integ.business_id)
          .eq('given_number', row.given_number)
        await closeLedger({ db, handle: ledger, populated_fields: [], error: 'not_found', rows_processed: 1 })
      } else {
        // Transient error — leave as header_only so we retry next tick.
        failed++
        await closeLedger({ db, handle: ledger, populated_fields: [], error: (result as any).reason, rows_processed: 1 })
      }
    }

    totalProcessed += processed
    totalResolved  += resolved
    totalNoPdf     += noPdf
    totalFailed    += failed
    results.push({ business_id: integ.business_id, processed, resolved, no_pdf: noPdf, failed })
  }

  log.info('fortnox_pdf_backfill done', {
    route: 'cron/fortnox-pdf-backfill', resumes,
    processed: totalProcessed, resolved: totalResolved, no_pdf: totalNoPdf, failed: totalFailed,
    duration_ms: Date.now() - startedAt,
  })

  return NextResponse.json({
    ok: true, resumes,
    processed: totalProcessed, resolved: totalResolved, no_pdf: totalNoPdf, failed: totalFailed,
    results,
  })
}
