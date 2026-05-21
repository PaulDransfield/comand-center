// lib/inventory/backfill-worker.ts
//
// The actual 12-month Fortnox supplier-invoice walk + persist + match
// loop. Extracted from the old synchronous endpoint so it can be fired
// from `waitUntil()` (admin kick + future cron) without an HTTP handler
// in the middle.
//
// Writes per-batch progress into `inventory_backfill_state.progress`
// so the admin UI can poll for live counts. Updates every 5 invoices
// (cheap; one UPDATE per ~75 rows on average).
//
// Idempotent end-to-end: the underlying tables' unique constraints +
// the matcher's "only act on needs_review / NULL rows" rule mean
// re-firing on a partially-completed business is safe — it picks up
// where the previous run left off and skips already-persisted lines.

import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { fortnoxFetch }                from '@/lib/fortnox/api/fetch'
import { matchInvoiceLine, type InvoiceLineForMatching, type MatchOutcome } from '@/lib/inventory/matcher'

const FORTNOX_API = 'https://api.fortnox.se/3'

// How often we update inventory_backfill_state.progress while the
// worker is grinding. Every 5 invoices is roughly every 8-12 seconds
// — fast enough for a snappy admin UI without spamming the DB.
const PROGRESS_FLUSH_EVERY_N_INVOICES = 5

interface WorkerInput {
  org_id:       string
  business_id:  string
  months_back?: number          // default 12
}

interface ProgressShape {
  phase:                 'fetching_invoice_list' | 'fetching_rows' | 'matching' | 'done'
  window:                { from: string; to: string }
  invoices_found:        number
  invoices_processed:    number
  lines_inserted:        number
  lines_skipped_existing: number
  lines_matched:         number
  lines_needs_review:    number
  lines_not_inventory:   number
  errors:                Array<{ invoice: string; error: string }>
  error_count:           number
}

interface SupplierInvoiceListItem {
  GivenNumber?:    number | string
  InvoiceNumber?:  number | string
  InvoiceDate?:    string
  BookKeepingDate?: string
  SupplierNumber?: string
  SupplierName?:   string
  Cancelled?:      boolean
}

interface SupplierInvoiceRow {
  ItemDescription?:    string
  ArticleNumber?:      string
  DeliveredQuantity?:  number | string
  OrderedQuantity?:    number | string
  Unit?:               string
  Price?:              number | string
  Total?:              number | string
  VAT?:                number | string
  AccountNumber?:      string | number
}

export async function runInventoryBackfill(
  db: any,
  input: WorkerInput,
): Promise<void> {
  const months = Number.isFinite(input.months_back) ? Number(input.months_back) : 12
  const now    = new Date()
  const fromIso = isoDate(new Date(now.getFullYear(), now.getMonth() - months, 1))
  const toIso   = isoDate(now)

  const p: ProgressShape = {
    phase:                  'fetching_invoice_list',
    window:                 { from: fromIso, to: toIso },
    invoices_found:         0,
    invoices_processed:     0,
    lines_inserted:         0,
    lines_skipped_existing: 0,
    lines_matched:          0,
    lines_needs_review:     0,
    lines_not_inventory:    0,
    errors:                 [],
    error_count:            0,
  }

  // Mark running + initial progress.
  await flush(db, input.business_id, 'running', p)

  // ── Get a fresh access token (auto-handles refresh / needs_reauth) ──
  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, input.org_id, input.business_id)
  } catch (err: any) {
    await fail(db, input.business_id, p, `Fortnox token refresh failed: ${err?.message ?? err}`)
    return
  }
  if (!accessToken) {
    await fail(db, input.business_id, p, 'No Fortnox connection for this business — connect Fortnox first.')
    return
  }

  // ── Phase 1: list invoices in window ──
  const invoices: SupplierInvoiceListItem[] = []
  try {
    for (let page = 1; page <= 20; page++) {
      const url = `${FORTNOX_API}/supplierinvoices?fromdate=${fromIso}&todate=${toIso}&limit=500&page=${page}`
      const res = await fortnoxFetch(url, accessToken)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        await fail(db, input.business_id, p, `Fortnox /supplierinvoices failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
        return
      }
      const body: any = await res.json().catch(() => null)
      const items: SupplierInvoiceListItem[] = body?.SupplierInvoices ?? []
      for (const inv of items) if (!inv.Cancelled) invoices.push(inv)
      const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? body?.MetaInformation?.TotalPages ?? 1)
      if (page >= totalPages) break
    }
  } catch (err: any) {
    await fail(db, input.business_id, p, `List fetch threw: ${err?.message ?? err}`)
    return
  }

  p.invoices_found = invoices.length
  p.phase          = 'fetching_rows'
  await flush(db, input.business_id, 'running', p)

  // ── Phase 2: per-invoice row fetch + persist + match ──
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i]
    const givenNumber  = inv.GivenNumber ?? inv.InvoiceNumber
    const supplierNum  = String(inv.SupplierNumber ?? '').trim()
    const invoiceDate  = String(inv.InvoiceDate ?? inv.BookKeepingDate ?? '').slice(0, 10)
    if (givenNumber == null || !supplierNum || !invoiceDate) {
      p.invoices_processed += 1
      continue
    }
    const invoiceNumber = String(givenNumber)

    try {
      // Skip-already-ingested optimisation: if this invoice's rows are
      // already in supplier_invoice_lines, don't waste a Fortnox call.
      // Fortnox rate-limits at ~25 req/5sec per token, so each detail
      // call costs us roughly 30 seconds of wall time on a hot day.
      // Skipping shaves hours off re-runs. Invoices on Fortnox are
      // effectively immutable once posted (the daily incremental cron
      // handles edits via the (business_id, fortnox_invoice_number,
      // row_number) idempotency key on supplier_invoice_lines).
      const { count: existingCount } = await db
        .from('supplier_invoice_lines')
        .select('id', { count: 'exact', head: true })
        .eq('business_id',            input.business_id)
        .eq('fortnox_invoice_number', invoiceNumber)
      if (existingCount && existingCount > 0) {
        p.invoices_processed       += 1
        p.lines_skipped_existing   += existingCount
        continue
      }

      const detailUrl = `${FORTNOX_API}/supplierinvoices/${encodeURIComponent(invoiceNumber)}`
      const detailRes = await fortnoxFetch(detailUrl, accessToken)
      if (!detailRes.ok) {
        p.errors.push({ invoice: invoiceNumber, error: `HTTP ${detailRes.status}` })
        p.error_count += 1
        p.invoices_processed += 1
        continue
      }
      const detail: any = await detailRes.json().catch(() => null)
      const rows: SupplierInvoiceRow[] = detail?.SupplierInvoice?.SupplierInvoiceRows ?? []
      if (rows.length === 0) {
        p.invoices_processed += 1
        continue
      }

      const periodYear  = parseInt(invoiceDate.slice(0, 4), 10)
      const periodMonth = parseInt(invoiceDate.slice(5, 7), 10)
      const inserts = rows.map((r, idx) => ({
        org_id:                  input.org_id,
        business_id:             input.business_id,
        supplier_fortnox_number: supplierNum,
        supplier_name_snapshot:  inv.SupplierName ?? null,
        fortnox_invoice_number:  invoiceNumber,
        invoice_date:            invoiceDate,
        invoice_period_year:     periodYear,
        invoice_period_month:    periodMonth,
        row_number:              idx + 1,
        raw_description:         String(r.ItemDescription ?? '').trim(),
        article_number:          r.ArticleNumber ? String(r.ArticleNumber) : null,
        quantity:                toNum(r.DeliveredQuantity ?? r.OrderedQuantity),
        unit:                    r.Unit ? String(r.Unit) : null,
        price_per_unit:          toNum(r.Price),
        total_excl_vat:          toNum(r.Total) ?? 0,
        vat_rate:                toNum(r.VAT),
        account_number:          r.AccountNumber != null ? String(r.AccountNumber) : null,
        match_status:            'needs_review' as const,
      }))

      const { data: insertedRows, error: insertErr } = await db
        .from('supplier_invoice_lines')
        .upsert(inserts, {
          onConflict:       'business_id,fortnox_invoice_number,row_number',
          ignoreDuplicates: true,
        })
        .select('id, org_id, business_id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, unit, account_number, match_status')

      if (insertErr) {
        p.errors.push({ invoice: invoiceNumber, error: `upsert: ${insertErr.message}` })
        p.error_count += 1
        p.invoices_processed += 1
        continue
      }

      const fresh = (insertedRows ?? []).filter((r: any) => r.match_status === 'needs_review')
      p.lines_inserted        += fresh.length
      p.lines_skipped_existing += inserts.length - fresh.length

      // ── Run matcher on each new line ──
      // Flip to 'matching' on the first matching call so the UI shows
      // the phase change immediately.
      if (p.phase !== 'matching') {
        p.phase = 'matching'
      }

      for (const row of fresh) {
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
          p.errors.push({ invoice: invoiceNumber, error: `matcher: ${e?.message ?? e}` })
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
      }

      p.invoices_processed += 1
    } catch (e: any) {
      p.errors.push({ invoice: invoiceNumber, error: String(e?.message ?? e) })
      p.error_count += 1
      p.invoices_processed += 1
    }

    // Cap errors[] to last 20 in the persisted row so the column doesn't bloat.
    if (p.errors.length > 20) p.errors = p.errors.slice(-20)

    // Periodic progress flush.
    if ((i + 1) % PROGRESS_FLUSH_EVERY_N_INVOICES === 0) {
      await flush(db, input.business_id, 'running', p)
    }
  }

  p.phase = 'done'
  await complete(db, input.business_id, p)
}

// ── Persistence helpers ──────────────────────────────────────────────

async function flush(db: any, businessId: string, status: 'running', p: ProgressShape) {
  await db.from('inventory_backfill_state')
    .update({ status, progress: p })
    .eq('business_id', businessId)
}

async function complete(db: any, businessId: string, p: ProgressShape) {
  await db.from('inventory_backfill_state')
    .update({
      status:        'completed',
      progress:      p,
      finished_at:   new Date().toISOString(),
      error_message: null,
    })
    .eq('business_id', businessId)
}

async function fail(db: any, businessId: string, p: ProgressShape, message: string) {
  await db.from('inventory_backfill_state')
    .update({
      status:        'failed',
      progress:      p,
      error_message: message,
      finished_at:   new Date().toISOString(),
    })
    .eq('business_id', businessId)
}

// ── Misc ────────────────────────────────────────────────────────────

function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }
function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v); return Number.isFinite(n) ? n : null
}
