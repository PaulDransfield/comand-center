// app/api/inventory/lines/backfill/route.ts
//
// Phase A capture endpoint (INVENTORY-CATALOGUE-PLAN.md §6 Phase A).
//
// Walks Fortnox /supplierinvoices for the last 12 months, fetches each
// invoice's per-row detail, and upserts into supplier_invoice_lines.
// Runs the matcher on each new line so the catalogue is populated in
// the same call.
//
// Idempotent: re-running on a business that's already been backfilled
// is a no-op via ON CONFLICT on (business_id, fortnox_invoice_number,
// row_number). The matcher itself is idempotent too (only acts on
// match_status='needs_review' or NULL).
//
// Auth: owner-only via requireBusinessAccess. Fortnox token via the
// shared getFreshFortnoxAccessToken chokepoint (auto needs_reauth on
// invalid_grant per feedback_fortnox_token_refresh_required).
//
// Per the plan's open question Q5: this initial implementation runs
// synchronously. If Vero's 12-month window times out the function
// (>300s on Pro), we'll add a job-queue split — but for the expected
// ~150 invoices × ~15 lines × ~50ms-per-matcher-call ≈ 2 min worst
// case, sync is the simpler shape.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { fortnoxFetch } from '@/lib/fortnox/api/fetch'
import { matchInvoiceLine, type InvoiceLineForMatching, type MatchOutcome } from '@/lib/inventory/matcher'

const FORTNOX_API = 'https://api.fortnox.se/3'

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

export async function POST(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const bizForbidden = requireBusinessAccess(auth, businessId)
  if (bizForbidden) return bizForbidden

  const db = createAdminClient()

  // ── Fortnox token ────────────────────────────────────────────────
  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, auth.orgId, businessId)
  } catch (err: any) {
    return NextResponse.json({
      error:   'fortnox_token_refresh_failed',
      message: err?.message ?? 'Token refresh failed — please reconnect Fortnox.',
    }, { status: 401 })
  }
  if (!accessToken) {
    return NextResponse.json({
      error:   'no_fortnox_connection',
      message: 'Connect Fortnox to backfill inventory lines.',
    }, { status: 404 })
  }

  // ── Window: 12 months back (Q3 default in the plan) ──────────────
  const now = new Date()
  const fromIso = isoDate(new Date(now.getFullYear(), now.getMonth() - 12, 1))
  const toIso   = isoDate(now)

  // ── Pull the list of invoices ───────────────────────────────────
  const invoices: SupplierInvoiceListItem[] = []
  for (let page = 1; page <= 20; page++) {
    const url = `${FORTNOX_API}/supplierinvoices?fromdate=${fromIso}&todate=${toIso}&limit=500&page=${page}`
    const res = await fortnoxFetch(url, accessToken)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({
        error:  `Fortnox /supplierinvoices failed: HTTP ${res.status}`,
        detail: text.slice(0, 200),
      }, { status: 502 })
    }
    const list: any = await res.json().catch(() => null)
    const items: SupplierInvoiceListItem[] = list?.SupplierInvoices ?? []
    for (const inv of items) if (!inv.Cancelled) invoices.push(inv)
    const totalPages = Number(list?.MetaInformation?.['@TotalPages'] ?? list?.MetaInformation?.TotalPages ?? 1)
    if (page >= totalPages) break
  }

  // ── Per-invoice row pull + persist + match ──────────────────────
  let invoicesProcessed = 0
  let linesInserted      = 0
  let linesSkippedExisting = 0
  let linesMatched       = 0
  let linesNeedsReview   = 0
  let linesNotInventory  = 0
  let errors: Array<{ invoice: string; error: string }> = []

  for (const inv of invoices) {
    const givenNumber = inv.GivenNumber ?? inv.InvoiceNumber
    if (givenNumber == null) continue
    const invoiceNumber = String(givenNumber)
    const supplierNumber = String(inv.SupplierNumber ?? '').trim()
    if (!supplierNumber) continue

    const invoiceDate = String(inv.InvoiceDate ?? inv.BookKeepingDate ?? '').slice(0, 10)
    if (!invoiceDate) continue

    try {
      // Fetch invoice detail (with rows). Voucher number is in the list
      // but the row array only lives on /supplierinvoices/{n}.
      const detailUrl = `${FORTNOX_API}/supplierinvoices/${encodeURIComponent(invoiceNumber)}`
      const detailRes = await fortnoxFetch(detailUrl, accessToken)
      if (!detailRes.ok) {
        errors.push({ invoice: invoiceNumber, error: `HTTP ${detailRes.status}` })
        continue
      }
      const detail: any = await detailRes.json().catch(() => null)
      const rows: SupplierInvoiceRow[] = detail?.SupplierInvoice?.SupplierInvoiceRows ?? []
      if (rows.length === 0) {
        // No itemised rows on this invoice. Recorded as a known
        // unprocessable invoice in the future (plan §7 Edge cases);
        // for now skip silently.
        invoicesProcessed += 1
        continue
      }

      // Build row inserts. The unique constraint
      // (business_id, fortnox_invoice_number, row_number) makes this
      // idempotent — re-runs hit DO NOTHING on the conflict.
      const periodYear  = parseInt(invoiceDate.slice(0, 4), 10)
      const periodMonth = parseInt(invoiceDate.slice(5, 7), 10)
      const inserts = rows.map((r, idx) => ({
        org_id:                  auth.orgId,
        business_id:             businessId,
        supplier_fortnox_number: supplierNumber,
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
        errors.push({ invoice: invoiceNumber, error: insertErr.message })
        continue
      }

      const fresh = (insertedRows ?? []).filter(r => r.match_status === 'needs_review')
      linesInserted        += fresh.length
      linesSkippedExisting += inserts.length - fresh.length

      // ── Run matcher on each new line ──────────────────────────────
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
          errors.push({ invoice: invoiceNumber, error: `matcher: ${e?.message ?? e}` })
          continue
        }

        // Persist matcher outcome on the line row.
        const update: any = {
          match_status:     outcome.status,
          product_alias_id: outcome.alias_id,
          match_candidates: outcome.candidates.length ? outcome.candidates : null,
        }
        if (outcome.status === 'matched' || outcome.status === 'not_inventory') {
          update.matched_at = new Date().toISOString()
        }
        await db.from('supplier_invoice_lines').update(update).eq('id', row.id)

        if (outcome.status === 'matched')         linesMatched      += 1
        else if (outcome.status === 'needs_review') linesNeedsReview += 1
        else if (outcome.status === 'not_inventory') linesNotInventory += 1
      }

      invoicesProcessed += 1
    } catch (e: any) {
      errors.push({ invoice: invoiceNumber, error: String(e?.message ?? e) })
    }
  }

  return NextResponse.json({
    ok: true,
    window:               { from: fromIso, to: toIso },
    invoices_found:       invoices.length,
    invoices_processed:   invoicesProcessed,
    lines_inserted:       linesInserted,
    lines_skipped_existing: linesSkippedExisting,
    lines_matched:        linesMatched,
    lines_needs_review:   linesNeedsReview,
    lines_not_inventory:  linesNotInventory,
    errors:               errors.slice(0, 20),
    error_count:          errors.length,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

// ─── helpers ─────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
