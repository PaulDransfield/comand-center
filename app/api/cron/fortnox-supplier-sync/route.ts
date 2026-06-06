// app/api/cron/fortnox-supplier-sync/route.ts
//
// Daily incremental sync of Fortnox supplier invoices into the local
// fortnox_supplier_invoices cache (M098). User-facing surfaces read
// the cache; this worker reconciles with Fortnox in the background.
//
// Strategy:
//   - For each business with a connected Fortnox integration:
//     1. Look up last_synced_at from fortnox_sync_state
//     2. Pull /supplierinvoices?fromdate=(last - 24h)&todate=today
//     3. UPSERT each into fortnox_supplier_invoices
//     4. Update fortnox_sync_state with new cursor + rows count
//   - First run (no state row): backfill last 12 months
//
// Cost model: 1 Fortnox call per business per day (plus pagination if
// the customer has >500 invoices in the sync window — rare). Eliminates
// the per-render Fortnox traffic that breaks at 3+ customers.

import { NextRequest, NextResponse }    from 'next/server'
import { createAdminClient }            from '@/lib/supabase/server'
import { checkCronSecret }              from '@/lib/admin/check-secret'
import { log }                          from '@/lib/log/structured'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'
import { getFreshFortnoxAccessToken }   from '@/lib/fortnox/api/auth'
import { extractSupplierInvoiceVoucher } from '@/lib/fortnox/extract-voucher-ref'
import { resolveSupplierInvoiceFileId } from '@/lib/fortnox/api/file-connections'
import { openLedger, closeLedger, computeRowStatus, buildIngestionMeta } from '@/lib/ingestion/ledger'

// Field-level contract for one supplier-invoice row (M135 Phase 1).
// HEADER fields are what the list endpoint returns; DETAIL fields are
// what only the detail / file-connections endpoints add. A row that
// has all HEADER but no DETAIL is honestly 'header_only', not 'partial'.
const EXPECTED_FIELDS = [
  'given_number', 'invoice_date', 'supplier_name', 'total', 'currency',
  'file_id', 'has_pdf',
]
const HEADER_FIELDS = [
  'given_number', 'invoice_date', 'supplier_name', 'total', 'currency',
]

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 60

const FORTNOX_API     = 'https://api.fortnox.se/3'
const DEFAULT_BACKFILL_MONTHS = 12   // first run pulls last year
const RESUME_OVERLAP_DAYS     = 1    // re-pull last day to catch late-arriving rows
// Phase 2 — how many of THIS batch's new invoices to resolve file_id for
// inline. The dedicated /api/cron/fortnox-pdf-backfill worker drains the
// rest so the daily sync stays narrow. 25 = ~25s extra per run typical;
// a first-time 12-month backfill puts the rest on the backfill cron.
const INLINE_RESOLVE_CAP      = 25

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { withCronLog } = await import('@/lib/cron/log')
  return withCronLog('fortnox-supplier-sync', async () => {

  const started = Date.now()
  const db = createAdminClient()

  const { data: integrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, status, businesses(name)')
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'warning'])
  if (!integrations?.length) {
    return NextResponse.json({ ok: true, businesses_synced: 0, message: 'no active fortnox integrations' })
  }

  let synced = 0
  const errors: string[] = []
  let totalRowsUpserted = 0

  for (const integ of integrations) {
    const bizName = ((integ.businesses as any)?.name) ?? '(unnamed)'
    if (!integ.business_id) continue
    try {
      const accessToken = await getFreshFortnoxAccessToken(db, integ.org_id, integ.business_id)
      if (!accessToken) {
        errors.push(`${bizName}: no token (integration likely in needs_reauth)`)
        continue
      }

      // Find the cursor — last successful sync's to-date.
      const { data: state } = await db
        .from('fortnox_sync_state')
        .select('last_cursor_date')
        .eq('business_id', integ.business_id)
        .eq('resource', 'supplier_invoices')
        .maybeSingle()

      const today = new Date()
      let fromIso: string
      if (state?.last_cursor_date) {
        // Resume — go back RESUME_OVERLAP_DAYS to catch back-dated entries.
        const d = new Date(state.last_cursor_date)
        d.setUTCDate(d.getUTCDate() - RESUME_OVERLAP_DAYS)
        fromIso = d.toISOString().slice(0, 10)
      } else {
        // First-time backfill.
        const d = new Date(today)
        d.setUTCMonth(d.getUTCMonth() - DEFAULT_BACKFILL_MONTHS)
        fromIso = d.toISOString().slice(0, 10)
      }
      const toIso = today.toISOString().slice(0, 10)

      // Paginate /supplierinvoices in chunks of 500.
      let rowsUpserted = 0
      let page = 1
      while (true) {
        // Ledger open — one row per page fetch + upsert (M135 Phase 1).
        // The list endpoint NEVER returns file_id, so we mark file_id
        // as expected-but-missing. computeRowStatus will tag rows as
        // 'header_only' (the truthful state until Phase 2 fixes the gap).
        const ledger = await openLedger({
          db,
          source:          'fortnox',
          resource:        'supplier_invoices',
          operation:       'list',
          business_id:     integ.business_id,
          org_id:          integ.org_id,
          expected_fields: EXPECTED_FIELDS,
          context:         { page, fromIso, toIso, endpoint: 'list' },
        })

        // No `filter=` param — Fortnox returns all non-cancelled invoices
        // by default. `filter=all` is NOT a valid value (valid options:
        // cancelled, fullypaid, unpaid, unpaidoverdue, unbooked, bookkept).
        // Sending an invalid filter value triggers HTTP 400 ("Ett ogiltigt
        // filter har använts", code 2000587).
        const url = `${FORTNOX_API}/supplierinvoices?fromdate=${fromIso}&todate=${toIso}&limit=500&page=${page}`
        const res = await fortnoxFetch(url, accessToken, { accept: 'application/json' })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          await closeLedger({ db, handle: ledger, populated_fields: [], error: `HTTP ${res.status}: ${t.slice(0, 200)}` })
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`)
        }
        const data = await res.json()
        const invoices = (data.SupplierInvoices ?? []) as any[]
        if (invoices.length === 0) {
          await closeLedger({ db, handle: ledger, populated_fields: HEADER_FIELDS, rows_processed: 0 })
          break
        }

        // Per-row population check — derive which fields actually came
        // through for THIS row. The list endpoint reliably returns the
        // HEADER set; file_id stays missing here by design.
        const upsertRows = invoices.map(inv => {
          const populated: string[] = []
          const gn = String(inv.GivenNumber ?? inv.InvoiceNumber ?? '')
          if (gn) populated.push('given_number')
          const d = inv.InvoiceDate ?? inv.BookKeepingDate ?? null
          if (d) populated.push('invoice_date')
          if (inv.SupplierName) populated.push('supplier_name')
          if (inv.Total != null) populated.push('total')
          if (inv.Currency) populated.push('currency')
          // file_id + has_pdf — DELIBERATELY missing from list endpoint.
          // Phase 2 will add the file-connections call to populate them.

          const rowStatus = computeRowStatus(EXPECTED_FIELDS, populated, HEADER_FIELDS)
          const ingestionMeta = buildIngestionMeta({
            ledgerId:         ledger.id,
            source_path:      'fortnox_supplier_sync',
            expected_fields:  EXPECTED_FIELDS,
            populated_fields: populated,
            extra:            { endpoint: 'list', page },
          })

          return {
            org_id:           integ.org_id,
            business_id:      integ.business_id,
            given_number:     gn,
            invoice_number:   inv.InvoiceNumber ? String(inv.InvoiceNumber) : null,
            supplier_name:    inv.SupplierName ?? '(unknown)',
            supplier_number:  inv.SupplierNumber ? String(inv.SupplierNumber) : null,
            supplier_normalised: String(inv.SupplierName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ''),
            invoice_date:     d,
            bookkeeping_date: inv.BookKeepingDate ?? null,
            due_date:         inv.DueDate         ?? null,
            total:            inv.Total          != null ? Number(inv.Total)         : null,
            currency:         inv.Currency         ?? null,
            vat:              inv.VAT             != null ? Number(inv.VAT)            : null,
            balance:          inv.Balance         != null ? Number(inv.Balance)        : null,
            final_pay_date:   inv.FinalPayDate     ?? null,
            // Fortnox's supplier-invoice payload doesn't expose VoucherSeries /
            // VoucherNumber as top-level fields. The booking voucher ref lives
            // nested in `inv.Vouchers[]` with `ReferenceType='SUPPLIERINVOICE'`
            // (alongside SUPPLIERPAYMENT and other refs). Shared extractor in
            // lib/fortnox/extract-voucher-ref.ts; sql/p20-paydown-ticket1-
            // backfill-APPLY.sql mirrors the same filter for the one-time backfill.
            ...extractSupplierInvoiceVoucher(inv),
            comments:         inv.Comments         ?? null,
            cancelled:        Boolean(inv.Cancelled),
            raw_data:         inv,
            last_synced_at:   new Date().toISOString(),
            // M135 Phase 1 — row-level completeness contract.
            ingestion_status: rowStatus,
            ingestion_meta:   ingestionMeta,
          }
        }).filter(r => r.given_number && r.invoice_date)

        if (upsertRows.length > 0) {
          // unique constraint (business_id, given_number) — full unique
          // (not partial) so onConflict works cleanly.
          const { error: upErr } = await db
            .from('fortnox_supplier_invoices')
            .upsert(upsertRows, { onConflict: 'business_id,given_number' })
          if (upErr) {
            await closeLedger({ db, handle: ledger, populated_fields: HEADER_FIELDS, error: `upsert failed: ${upErr.message}`, rows_processed: upsertRows.length })
            throw new Error(`upsert failed: ${upErr.message}`)
          }
          rowsUpserted += upsertRows.length
        }
        await closeLedger({ db, handle: ledger, populated_fields: HEADER_FIELDS, rows_processed: invoices.length })

        // Phase 2 — inline file_id resolution for the rows we just upserted.
        // Capped at INLINE_RESOLVE_CAP per batch so a first-time backfill
        // (12 months of invoices) doesn't blow the function's time budget.
        // The leftover header_only rows are picked up by the dedicated
        // /api/cron/fortnox-pdf-backfill worker. Concurrency 1 because
        // fortnoxFetch's semaphore already caps in-flight at 2 per token
        // (the file_id resolver does 1-2 Fortnox calls per invoice).
        const toResolve = upsertRows.slice(0, INLINE_RESOLVE_CAP)
        for (const row of toResolve) {
          const subLedger = await openLedger({
            db,
            source:          'fortnox',
            resource:        'supplier_invoices',
            operation:       'file_connections',
            business_id:     integ.business_id,
            org_id:          integ.org_id,
            expected_fields: ['file_id', 'has_pdf'],
            context:         { given_number: row.given_number, called_from: 'supplier_sync_inline' },
          })
          const result = await resolveSupplierInvoiceFileId(accessToken, row.given_number)
          if (result.kind === 'has_pdf' || result.kind === 'no_pdf') {
            const fileId = result.kind === 'has_pdf' ? result.file_id : null
            const populated: string[] = [...HEADER_FIELDS, 'has_pdf']
            if (fileId) populated.push('file_id')
            await db.from('fortnox_supplier_invoices')
              .update({
                file_id:            fileId,
                has_pdf:            fileId != null,
                file_id_fetched_at: new Date().toISOString(),
                ingestion_status:   'complete',
                ingestion_meta:     buildIngestionMeta({
                  ledgerId:         subLedger.id,
                  source_path:      'fortnox_supplier_sync_inline',
                  expected_fields:  EXPECTED_FIELDS,
                  populated_fields: populated,
                  extra:            { resolved_via: result.kind === 'has_pdf' ? result.source : 'no_pdf' },
                }),
              })
              .eq('business_id', integ.business_id)
              .eq('given_number', row.given_number)
            await closeLedger({ db, handle: subLedger, populated_fields: fileId ? ['file_id', 'has_pdf'] : ['has_pdf'], rows_processed: 1 })
          } else {
            // not_found or error — leave as header_only so the backfill worker retries.
            await closeLedger({ db, handle: subLedger, populated_fields: [], error: result.kind === 'not_found' ? 'invoice_not_found' : (result as any).reason, rows_processed: 1 })
          }
        }

        if (invoices.length < 500) break
        page++
        if (page > 50) break  // safety: 50 pages × 500 = 25,000 invoices; far above any realistic single sync
      }

      // Persist cursor for next run.
      await db
        .from('fortnox_sync_state')
        .upsert({
          business_id:       integ.business_id,
          resource:          'supplier_invoices',
          last_synced_at:    new Date().toISOString(),
          last_cursor_date:  toIso,
          rows_synced:       rowsUpserted,
          last_error:        null,
        }, { onConflict: 'business_id,resource' })

      totalRowsUpserted += rowsUpserted
      synced++
      log.info('fortnox_supplier_sync biz ok', {
        route:        'cron/fortnox-supplier-sync',
        business_id:  integ.business_id,
        rows_upserted: rowsUpserted,
        from_date:    fromIso,
        to_date:      toIso,
      })
    } catch (e: any) {
      const msg = `${bizName}: ${e?.message ?? String(e)}`
      errors.push(msg)
      // Record the error on sync_state so an ops dashboard can surface it.
      try {
        await db.from('fortnox_sync_state').upsert({
          business_id:    integ.business_id,
          resource:       'supplier_invoices',
          last_synced_at: new Date().toISOString(),
          last_error:     String(e?.message ?? e).slice(0, 500),
        }, { onConflict: 'business_id,resource' })
      } catch {}
      log.error('fortnox_supplier_sync biz failed', {
        route:        'cron/fortnox-supplier-sync',
        business_id:  integ.business_id,
        error:        e?.message ?? String(e),
      })
    }
  }

  log.info('fortnox_supplier_sync complete', {
    route:               'cron/fortnox-supplier-sync',
    duration_ms:         Date.now() - started,
    businesses_synced:   synced,
    businesses_failed:   errors.length,
    total_rows_upserted: totalRowsUpserted,
  })

  return NextResponse.json({
    ok:                synced > 0 || errors.length === 0,
    businesses_synced: synced,
    total_rows:        totalRowsUpserted,
    errors:            errors.length > 0 ? errors.slice(0, 10) : undefined,
    timestamp:         new Date().toISOString(),
  })
  })
}

export const GET = POST
