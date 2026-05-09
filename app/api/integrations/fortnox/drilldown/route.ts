// app/api/integrations/fortnox/drilldown/route.ts
//
// Owner drilldown on overhead-review flags. When the owner clicks "Show invoices"
// on a flagged supplier card, this endpoint:
//
//   1. Verifies session + ownership of the business.
//   2. Cache check — overhead_drilldown_cache, keyed (business_id, year, month,
//      category). 5-minute TTL. Cache hit returns immediately.
//   3. Cache miss — fetches vouchers for the period via the Phase 1 voucher
//      fetcher, fetches the period's supplier invoices in parallel, joins them,
//      filters voucher rows by the BAS account range matching the requested
//      category, groups voucher rows by parent supplier invoice, returns the
//      nested JSON below.
//   4. Writes the payload to overhead_drilldown_cache.
//
// Output shape:
//   {
//     flagged_total:  number,                 // sum across all suppliers in this category for this period (live from Fortnox)
//     suppliers:      SupplierGroup[],        // each supplier with their invoice contributions
//     manual_journals: ManualJournal[],       // voucher rows with no parent supplier invoice
//     fetched_at:     string,                 // ISO; client uses to display freshness
//     fortnox_calls:  { vouchers: number; invoices: number; details: number },
//   }
//
// The client filters `suppliers` to the supplier_name_normalised matching the
// flag they clicked, then renders that supplier's invoices chronologically.
// Caching at the (period, category) granularity means scrolling through 10
// flags in the same category+month triggers ONE Fortnox fetch.

import { NextRequest, NextResponse }    from 'next/server'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { fetchVouchersForRange }        from '@/lib/fortnox/api/vouchers'
import { decrypt }                      from '@/lib/integrations/encryption'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CACHE_TTL_MS = 5 * 60 * 1000

// BAS account ranges per category. Mirrors lib/fortnox/classify.ts but
// expressed as inclusive ranges for direct integer comparison.
const CATEGORY_ACCOUNT_RANGES: Record<string, Array<[number, number]>> = {
  revenue:      [[3000, 3999]],
  food_cost:    [[4000, 4999]],
  other_cost:   [[5000, 6999]],
  staff_cost:   [[7000, 7799], [7900, 7999]],
  depreciation: [[7800, 7899]],
  financial:    [[8000, 8999]],
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DrilldownInvoice {
  source_type:        'supplier_invoice' | 'manual_journal'
  source_id:          string                  // GivenNumber for supplier invoice; "series-number" for vouchers
  fortnox_url:        string                  // Fortnox web UI URL for "Open in Fortnox"
  file_id:            string | null           // Fortnox file id for PDF retrieval, if attached
  date:               string                  // ISO YYYY-MM-DD
  invoice_number:     string                  // Display number (GivenNumber or voucher series-number)
  supplier_name:      string
  amount:             number                  // Contribution to THIS category (may be a portion of the full invoice)
  full_total:         number | null           // Full invoice total (informative, shown in modal)
  account:            number                  // BAS account
  account_description: string | null
  description:        string | null
  voucher_series:     string
  voucher_number:     number
}

export interface SupplierGroup {
  supplier_name:            string
  supplier_name_normalised: string
  total:                    number            // Sum of `amount` for all invoices in the group
  invoice_count:            number
  first_date:               string
  last_date:                string
  invoices:                 DrilldownInvoice[]
}

export interface DrilldownPayload {
  flagged_total:    number
  suppliers:        SupplierGroup[]
  manual_journals:  DrilldownInvoice[]
  fetched_at:       string
  fortnox_calls:    { vouchers: number; invoices: number; details: number }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const businessId  = String(body?.business_id ?? '').trim()
  const periodYear  = Number(body?.year)
  const periodMonth = Number(body?.month)
  const category    = String(body?.category ?? '').trim()

  if (!businessId || !Number.isFinite(periodYear) || !Number.isFinite(periodMonth) || !category) {
    return NextResponse.json({ error: 'business_id, year, month, category required' }, { status: 400 })
  }
  if (periodMonth < 1 || periodMonth > 12) {
    return NextResponse.json({ error: 'month must be 1-12' }, { status: 400 })
  }
  if (!CATEGORY_ACCOUNT_RANGES[category]) {
    return NextResponse.json({ error: `Unknown category: ${category}` }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify the caller's org owns this business — prevents cross-org peek.
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // ── 1. Cache check ────────────────────────────────────────────────────────
  const { data: cached } = await db
    .from('overhead_drilldown_cache')
    .select('payload, fetched_at')
    .eq('business_id', businessId)
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .eq('category', category)
    .maybeSingle()

  if (cached && cached.fetched_at) {
    const age = Date.now() - new Date(cached.fetched_at).getTime()
    if (age < CACHE_TTL_MS) {
      return NextResponse.json({ ...cached.payload, cache: 'hit' }, { headers: { 'Cache-Control': 'no-store' } })
    }
  }

  // ── 2. Cache miss — fetch fresh from Fortnox ──────────────────────────────
  // Find the connected Fortnox integration for this org/business.
  const { data: integ } = await db
    .from('integrations')
    .select('id, business_id, status')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .eq('status', 'connected')
    .limit(1)
    .maybeSingle()

  if (!integ) {
    return NextResponse.json({
      error: 'no_fortnox_connection',
      message: 'Connect Fortnox to drill into this cost.',
    }, { status: 404 })
  }

  // Date range for the requested month.
  const lastDay = new Date(periodYear, periodMonth, 0).getDate()
  const fromIso = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`
  const toIso   = `${periodYear}-${String(periodMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  // Parallel: vouchers (with rows) + supplier invoices for the period.
  const [voucherResult, supplierInvoices] = await Promise.all([
    fetchVouchersForRange({
      db,
      orgId:      auth.orgId,
      businessId,
      fromDate:   fromIso,
      toDate:     toIso,
    }),
    fetchSupplierInvoices(db, integ.id, fromIso, toIso),
  ])

  // Join vouchers to their parent supplier invoice via VoucherSeries+VoucherNumber.
  // Supplier invoice rows expose VoucherSeries and VoucherNumber; vouchers expose
  // their own series+number. The two match when the supplier invoice has been
  // booked (posted to bookkeeping).
  const invoiceByVoucher = new Map<string, FortnoxSupplierInvoice>()
  for (const si of supplierInvoices) {
    const key = `${si.VoucherSeries ?? ''}|${si.VoucherNumber ?? ''}`
    if (key !== '|') invoiceByVoucher.set(key, si)
  }

  // ── 3. Filter voucher rows by category, join with invoice metadata ────────
  const ranges = CATEGORY_ACCOUNT_RANGES[category]
  const inCategory = (acct: number) => ranges.some(([lo, hi]) => acct >= lo && acct <= hi)

  const supplierMap = new Map<string, SupplierGroup>()
  const manualJournals: DrilldownInvoice[] = []
  let flaggedTotal = 0

  for (const v of voucherResult.vouchers) {
    const voucherKey = `${v.VoucherSeries}|${v.VoucherNumber}`
    const invoice    = invoiceByVoucher.get(voucherKey) ?? null

    // Sum the in-category contribution of this voucher. Costs are debit -
    // credit; revenue is credit - debit.
    let contribution = 0
    let pickedAccount  = 0
    let pickedAccountDesc: string | null = null
    for (const row of v.VoucherRows ?? []) {
      if (row.Removed) continue
      const acct = Number(row.Account)
      if (!Number.isFinite(acct) || !inCategory(acct)) continue
      const debit  = Number(row.Debit  ?? 0)
      const credit = Number(row.Credit ?? 0)
      const amt    = category === 'revenue' || category === 'financial'
        ? credit - debit
        : debit - credit
      if (amt <= 0) continue
      contribution += amt
      // Pick the first matching account for display purposes.
      if (pickedAccount === 0) {
        pickedAccount     = acct
        pickedAccountDesc = row.AccountDescription ?? null
      }
    }
    if (contribution <= 0) continue

    flaggedTotal += contribution

    if (invoice) {
      const supName     = invoice.SupplierName ?? '—'
      const supNorm     = normaliseSupplier(supName)
      const fortnoxUrl  = `https://apps.fortnox.se/supplierinvoice/${encodeURIComponent(invoice.GivenNumber ?? '')}`
      const inv: DrilldownInvoice = {
        source_type:         'supplier_invoice',
        source_id:           String(invoice.GivenNumber ?? ''),
        fortnox_url:         fortnoxUrl,
        file_id:             invoice.SupplierInvoiceFileConnections?.[0]?.FileId ?? null,
        date:                invoice.InvoiceDate ?? invoice.BookKeepingDate ?? v.TransactionDate,
        invoice_number:      String(invoice.InvoiceNumber ?? invoice.GivenNumber ?? '—'),
        supplier_name:       supName,
        amount:              round2(contribution),
        full_total:          parseAmount(invoice.Total ?? invoice.GrossAmount),
        account:             pickedAccount,
        account_description: pickedAccountDesc,
        description:         invoice.Comments ?? v.Description ?? null,
        voucher_series:      v.VoucherSeries,
        voucher_number:      v.VoucherNumber,
      }
      const group = supplierMap.get(supNorm) ?? {
        supplier_name:            supName,
        supplier_name_normalised: supNorm,
        total:        0,
        invoice_count: 0,
        first_date:    inv.date,
        last_date:     inv.date,
        invoices:      [],
      }
      group.invoices.push(inv)
      group.total        = round2(group.total + contribution)
      group.invoice_count++
      if (inv.date < group.first_date) group.first_date = inv.date
      if (inv.date > group.last_date)  group.last_date  = inv.date
      supplierMap.set(supNorm, group)
    } else {
      // Voucher with no parent supplier invoice — treat as manual journal.
      manualJournals.push({
        source_type:         'manual_journal',
        source_id:           `${v.VoucherSeries}-${v.VoucherNumber}`,
        fortnox_url:         `https://apps.fortnox.se/voucher/${encodeURIComponent(v.VoucherSeries)}/${v.VoucherNumber}`,
        file_id:             null,
        date:                v.TransactionDate,
        invoice_number:      `${v.VoucherSeries}-${v.VoucherNumber}`,
        supplier_name:       v.Description ?? 'Manual journal',
        amount:              round2(contribution),
        full_total:          null,
        account:             pickedAccount,
        account_description: pickedAccountDesc,
        description:         v.Description ?? v.Comments ?? null,
        voucher_series:      v.VoucherSeries,
        voucher_number:      v.VoucherNumber,
      })
    }
  }

  // Sort each supplier's invoices chronologically; sort suppliers by total desc.
  const suppliers = Array.from(supplierMap.values())
    .map(g => ({ ...g, invoices: g.invoices.slice().sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => b.total - a.total)
  manualJournals.sort((a, b) => a.date.localeCompare(b.date))

  const payload: DrilldownPayload = {
    flagged_total:    round2(flaggedTotal),
    suppliers,
    manual_journals:  manualJournals,
    fetched_at:       new Date().toISOString(),
    fortnox_calls: {
      vouchers: voucherResult.listRequests,
      invoices: 1,
      details:  voucherResult.detailRequests,
    },
  }

  // ── 4. Cache ─────────────────────────────────────────────────────────────
  await db
    .from('overhead_drilldown_cache')
    .upsert({
      business_id:  businessId,
      period_year:  periodYear,
      period_month: periodMonth,
      category,
      payload,
      fetched_at:   new Date().toISOString(),
    }, { onConflict: 'business_id,period_year,period_month,category' })

  return NextResponse.json({ ...payload, cache: 'miss' }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FortnoxSupplierInvoice {
  '@url'?:                      string
  GivenNumber?:                 number | string
  InvoiceNumber?:               number | string
  SupplierName?:                string
  SupplierNumber?:              string
  InvoiceDate?:                 string
  BookKeepingDate?:             string
  Total?:                       number | string
  GrossAmount?:                 number | string
  Comments?:                    string
  VoucherSeries?:               string
  VoucherNumber?:               number | string
  Cancelled?:                   boolean
  SupplierInvoiceFileConnections?: Array<{ FileId: string }>
}

async function fetchSupplierInvoices(db: any, integrationId: string, fromDate: string, toDate: string): Promise<FortnoxSupplierInvoice[]> {
  const { data: integ } = await db
    .from('integrations')
    .select('credentials_enc')
    .eq('id', integrationId)
    .maybeSingle()
  if (!integ?.credentials_enc) return []

  let creds: any
  try { creds = JSON.parse(decrypt(integ.credentials_enc) ?? '{}') } catch { return [] }
  const accessToken = String(creds?.access_token ?? '')
  if (!accessToken) return []

  // Single list call. Pagination would be needed for high-volume customers
  // (>500 supplier invoices in a month) but not for typical restaurant scale.
  // No `filter=` param — Fortnox returns all non-cancelled invoices by
  // default. `filter=all` is NOT a valid value (caused HTTP 400 on /supplierinvoices).
  const url = `https://api.fortnox.se/3/supplierinvoices?fromdate=${fromDate}&todate=${toDate}&limit=500`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  })
  if (!res.ok) return []
  const body = await res.json().catch(() => null) as any
  const invoices: FortnoxSupplierInvoice[] = body?.SupplierInvoices ?? []
  return invoices.filter(i => !i.Cancelled)
}

function normaliseSupplier(name: string): string {
  return String(name ?? '').toLowerCase().trim()
    .replace(/\b(ab|aktiebolag|hb|kb|enskild firma|as)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseAmount(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
