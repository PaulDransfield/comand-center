// app/api/cron/inventory-lines-sync/route.ts
//
// Daily incremental for the inventory catalogue (INVENTORY-CATALOGUE-PLAN.md
// §6 Phase A). Picks up new supplier invoices created in Fortnox in the
// last 48h (overlap window for safety against race / late-bookkeeping)
// and runs them through the same persist + match pipeline as the manual
// backfill.
//
// Only fires for businesses that already have at least one row in
// supplier_invoice_lines — i.e. backfilled once via the manual endpoint.
// Greenfield businesses don't get auto-started; the owner has to run the
// initial backfill explicitly.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { fortnoxFetch } from '@/lib/fortnox/api/fetch'
import { matchInvoiceLine, type InvoiceLineForMatching, type MatchOutcome } from '@/lib/inventory/matcher'

const FORTNOX_API = 'https://api.fortnox.se/3'
const LOOKBACK_DAYS = 2

export async function POST(req: NextRequest) {
  return handle(req)
}
export async function GET(req: NextRequest) {
  return handle(req)
}

async function handle(req: NextRequest) {
  noStore()
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = createAdminClient()

  // Which businesses are subscribed to inventory? Anyone with any row
  // in supplier_invoice_lines. Cheap distinct query.
  const { data: bizRows } = await db
    .from('supplier_invoice_lines')
    .select('org_id, business_id')
    .limit(10000)
  const seen = new Set<string>()
  const eligible: Array<{ org_id: string; business_id: string }> = []
  for (const r of bizRows ?? []) {
    const k = `${r.org_id}::${r.business_id}`
    if (seen.has(k)) continue
    seen.add(k)
    eligible.push({ org_id: r.org_id, business_id: r.business_id })
  }

  const summary: any[] = []
  const fromDate = isoDate(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000))
  const toDate   = isoDate(new Date())

  for (const biz of eligible) {
    let accessToken: string | null = null
    try {
      accessToken = await getFreshFortnoxAccessToken(db, biz.org_id, biz.business_id)
    } catch {
      summary.push({ business_id: biz.business_id, skipped: 'fortnox_needs_reauth' })
      continue
    }
    if (!accessToken) {
      summary.push({ business_id: biz.business_id, skipped: 'no_fortnox' })
      continue
    }

    const counts = await syncOneBusiness(db, biz.org_id, biz.business_id, accessToken, fromDate, toDate)
    summary.push({ business_id: biz.business_id, ...counts })
  }

  return NextResponse.json({
    ok: true,
    eligible_businesses: eligible.length,
    window: { from: fromDate, to: toDate },
    summary,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

interface SyncCounts {
  invoices_processed:   number
  lines_inserted:       number
  lines_matched:        number
  lines_needs_review:   number
  lines_not_inventory:  number
}

async function syncOneBusiness(
  db: any,
  orgId: string,
  businessId: string,
  accessToken: string,
  fromDate: string,
  toDate: string,
): Promise<SyncCounts> {
  let invoicesProcessed = 0
  let linesInserted     = 0
  let linesMatched      = 0
  let linesNeedsReview  = 0
  let linesNotInventory = 0

  // Page the list endpoint
  const invoices: any[] = []
  for (let page = 1; page <= 5; page++) {
    const url = `${FORTNOX_API}/supplierinvoices?fromdate=${fromDate}&todate=${toDate}&limit=500&page=${page}`
    const res = await fortnoxFetch(url, accessToken)
    if (!res.ok) break
    const body: any = await res.json().catch(() => null)
    const items: any[] = body?.SupplierInvoices ?? []
    for (const inv of items) if (!inv.Cancelled) invoices.push(inv)
    const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? body?.MetaInformation?.TotalPages ?? 1)
    if (page >= totalPages) break
  }

  for (const inv of invoices) {
    const givenNumber = inv.GivenNumber ?? inv.InvoiceNumber
    if (givenNumber == null) continue
    const invoiceNumber = String(givenNumber)
    const supplierNumber = String(inv.SupplierNumber ?? '').trim()
    if (!supplierNumber) continue
    const invoiceDate = String(inv.InvoiceDate ?? inv.BookKeepingDate ?? '').slice(0, 10)
    if (!invoiceDate) continue

    const detailUrl = `${FORTNOX_API}/supplierinvoices/${encodeURIComponent(invoiceNumber)}`
    const detailRes = await fortnoxFetch(detailUrl, accessToken)
    if (!detailRes.ok) continue
    const detail: any = await detailRes.json().catch(() => null)
    const rows: any[] = detail?.SupplierInvoice?.SupplierInvoiceRows ?? []
    if (rows.length === 0) { invoicesProcessed += 1; continue }

    const periodYear  = parseInt(invoiceDate.slice(0, 4), 10)
    const periodMonth = parseInt(invoiceDate.slice(5, 7), 10)
    const inserts = rows.map((r: any, idx: number) => ({
      org_id:                  orgId,
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

    const { data: insertedRows } = await db
      .from('supplier_invoice_lines')
      .upsert(inserts, {
        onConflict:       'business_id,fortnox_invoice_number,row_number',
        ignoreDuplicates: true,
      })
      .select('id, org_id, business_id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, unit, account_number, match_status, source')

    const fresh = (insertedRows ?? []).filter((r: any) => r.match_status === 'needs_review')
    linesInserted += fresh.length

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
        source:                   row.source ?? 'fortnox_row',
      }
      let outcome: MatchOutcome
      try {
        outcome = await matchInvoiceLine(db, lineInput)
      } catch { continue }

      const update: any = {
        match_status:     outcome.status,
        product_alias_id: outcome.alias_id,
        match_candidates: outcome.candidates.length ? outcome.candidates : null,
      }
      if (outcome.status === 'matched' || outcome.status === 'not_inventory') {
        update.matched_at = new Date().toISOString()
      }
      await db.from('supplier_invoice_lines').update(update).eq('id', row.id)

      if (outcome.status === 'matched')          linesMatched      += 1
      else if (outcome.status === 'needs_review') linesNeedsReview += 1
      else if (outcome.status === 'not_inventory') linesNotInventory += 1
    }

    invoicesProcessed += 1
  }

  return { invoices_processed: invoicesProcessed, lines_inserted: linesInserted, lines_matched: linesMatched, lines_needs_review: linesNeedsReview, lines_not_inventory: linesNotInventory }
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }
function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v); return Number.isFinite(n) ? n : null
}
