// app/api/integrations/fortnox/recent-invoices/route.ts
//
// Live operational feed: most-recent supplier invoices booked into Fortnox,
// regardless of period closure. Used by the dashboard's "Recent activity"
// component so owners can see what's coming in day-to-day even when the
// monthly P&L hasn't closed yet (and might never close — Apr/May 2026 in
// Vero's case until the accountant catches up).
//
// Why a separate endpoint from /drilldown:
//   - drilldown is scoped to a (period, category) — answers "what supplier
//     invoices contributed to this flagged cost overrun?"
//   - recent-invoices is scoped to a date window across ALL categories —
//     answers "what's been booked this week?"
//   - Different cache key, different shape, different UX
//
// Inputs:
//   business_id: required (query param)
//   days:        optional (default 14, max 90)
//
// Output:
//   {
//     invoices: [{
//       supplier_name, given_number, invoice_date, total, file_id,
//       fortnox_url, voucher_series, voucher_number, currency, comments
//     }],
//     fetched_at, days_window
//   }
//
// Caching: 5-min cache via overhead_drilldown_cache row keyed
// `(business_id, year=0, month=0, category='__recent_invoices__')` so we
// don't hammer Fortnox when the dashboard mounts repeatedly. The synthetic
// (0, 0, '__recent_invoices__') key avoids needing a new table.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { decrypt }                      from '@/lib/integrations/encryption'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 30

const CACHE_TTL_MS = 5 * 60 * 1000
const FORTNOX_API  = 'https://api.fortnox.se/3'

interface FortnoxSupplierInvoice {
  '@url'?:         string
  GivenNumber?:    number | string
  InvoiceNumber?:  number | string
  SupplierName?:   string
  SupplierNumber?: string
  InvoiceDate?:    string
  BookKeepingDate?:string
  Total?:          number | string
  Currency?:       string
  Comments?:       string
  VoucherSeries?:  string
  VoucherNumber?:  number | string
  Cancelled?:      boolean
  SupplierInvoiceFileConnections?: Array<{ FileId: string }>
}

export interface RecentInvoice {
  supplier_name:    string
  given_number:     string
  invoice_number:   string
  invoice_date:     string         // YYYY-MM-DD (or BookKeepingDate fallback)
  total:            number | null
  currency:         string | null
  file_id:          string | null
  fortnox_url:      string
  voucher_series:   string | null
  voucher_number:   string | null
  comments:         string | null
}

export interface RecentInvoicesPayload {
  invoices:        RecentInvoice[]
  fetched_at:      string
  days_window:     number               // 0 when year_month-mode active
  year_month?:     string | null        // 'YYYY-MM' if year_month-mode, else null
  supplier_filter?: string | null
  cache?:          'hit' | 'miss'
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = (req.nextUrl.searchParams.get('business_id') ?? '').trim()
  const daysParam  = Number(req.nextUrl.searchParams.get('days') ?? 14)
  const days       = Math.max(1, Math.min(90, Number.isFinite(daysParam) ? daysParam : 14))
  // Optional calendar-month window — used by the Overheads flag detail
  // pane so a flag for "March 2026 / supplier X" can show a flat list
  // of supplier-X invoices in March 2026 without doing the full
  // voucher-aware drilldown (which is slow + flaky).
  const yearMonth      = (req.nextUrl.searchParams.get('year_month') ?? '').trim()
  const supplierFilter = (req.nextUrl.searchParams.get('supplier_filter') ?? '').trim().toLowerCase()
  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify ownership.
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // Cache check (synthetic key for "recent invoices" — re-uses the
  // overhead_drilldown_cache table which is the right shape for this).
  // Different cache keys for days-mode vs year_month-mode so they don't
  // collide. supplier_filter goes into the key too — different supplier
  // filters return different result sets.
  const yearMonthValid = /^\d{4}-\d{2}$/.test(yearMonth)
  const cacheCategory = yearMonthValid
    ? `__flag_invoices_${yearMonth}_${supplierFilter || 'all'}__`
    : `__recent_invoices_${days}d__`
  const cacheKey = {
    business_id:  businessId,
    period_year:  0,
    period_month: 0,
    category:     cacheCategory,
  }
  const { data: cached } = await db
    .from('overhead_drilldown_cache')
    .select('payload, fetched_at')
    .eq('business_id', cacheKey.business_id)
    .eq('period_year', cacheKey.period_year)
    .eq('period_month', cacheKey.period_month)
    .eq('category', cacheKey.category)
    .maybeSingle()

  if (cached?.fetched_at) {
    const age = Date.now() - new Date(cached.fetched_at).getTime()
    if (age < CACHE_TTL_MS) {
      return NextResponse.json(
        { ...(cached.payload as any), cache: 'hit' },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
  }

  // Connected Fortnox integration
  const { data: integ } = await db
    .from('integrations')
    .select('credentials_enc, status')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'error', 'warning'])
    .limit(1)
    .maybeSingle()

  if (!integ?.credentials_enc) {
    return NextResponse.json({
      error:   'no_fortnox_connection',
      message: 'Connect Fortnox to see recent invoices.',
    }, { status: 404 })
  }

  let creds: any
  try {
    creds = JSON.parse(decrypt(integ.credentials_enc) ?? '{}')
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt Fortnox credentials' }, { status: 500 })
  }
  const accessToken = String(creds?.access_token ?? '')
  if (!accessToken) {
    return NextResponse.json({ error: 'No Fortnox access token' }, { status: 500 })
  }

  // Range: either calendar-month window (year_month=YYYY-MM mode) or
  // last-N-days. Stockholm-local YYYY-MM-DD.
  let fromIso: string
  let toIso:   string
  if (yearMonthValid) {
    const [y, m] = yearMonth.split('-').map(Number)
    const lastDay = new Date(y!, m!, 0).getDate()
    fromIso = `${y}-${String(m).padStart(2, '0')}-01`
    toIso   = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  } else {
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
    const todayDate  = new Date(todayLocal + 'T00:00:00Z')
    const fromDate   = new Date(todayDate.getTime() - days * 86_400_000)
    fromIso = fromDate.toISOString().slice(0, 10)
    toIso   = todayLocal
  }

  // /supplierinvoices is paginated with limit=500. For 90 days × restaurant
  // volume (~30 invoices/month) we max at ~90 — single page is enough.
  // Defensive: bail out at page 5 to avoid runaways.
  const collected: FortnoxSupplierInvoice[] = []
  for (let page = 1; page <= 5; page++) {
    // No `filter=` param — Fortnox returns all non-cancelled invoices by
    // default. `filter=all` is NOT a valid value (valid options: cancelled,
    // fullypaid, unpaid, unpaidoverdue, unbooked, bookkept). Sending an
    // invalid filter value triggers HTTP 400 from /supplierinvoices.
    const url = `${FORTNOX_API}/supplierinvoices?fromdate=${fromIso}&todate=${toIso}&limit=500&page=${page}`
    const res = await fortnoxFetch(url, accessToken)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({
        error:  `Fortnox /supplierinvoices failed: HTTP ${res.status}`,
        detail: text.slice(0, 200),
      }, { status: 502 })
    }
    const body: any = await res.json().catch(() => null)
    const pageInvoices: FortnoxSupplierInvoice[] = body?.SupplierInvoices ?? []
    for (const inv of pageInvoices) if (!inv.Cancelled) collected.push(inv)
    const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? body?.MetaInformation?.TotalPages ?? 1)
    if (page >= totalPages) break
  }

  // Optional supplier filter — used by the Overheads flag detail pane.
  // Match is case-insensitive substring. Normalisation matches what the
  // drilldown route does (strips Swedish company-form suffixes).
  const filtered = supplierFilter
    ? collected.filter(inv => {
        const name = String(inv.SupplierName ?? '').toLowerCase()
        const norm = name.replace(/\b(ab|aktiebolag|hb|kb|enskild firma|as)\b/g, '').trim()
        return name.includes(supplierFilter) || norm.includes(supplierFilter)
      })
    : collected

  // Map to display shape, sort newest first
  const invoices: RecentInvoice[] = filtered
    .map(inv => {
      const date = String(inv.InvoiceDate ?? inv.BookKeepingDate ?? '').slice(0, 10)
      const total = parseAmount(inv.Total)
      return {
        supplier_name:  String(inv.SupplierName ?? '—'),
        given_number:   String(inv.GivenNumber ?? ''),
        invoice_number: String(inv.InvoiceNumber ?? inv.GivenNumber ?? '—'),
        invoice_date:   date,
        total,
        currency:       inv.Currency ? String(inv.Currency) : 'SEK',
        file_id:        inv.SupplierInvoiceFileConnections?.[0]?.FileId ?? null,
        fortnox_url:    `https://apps.fortnox.se/supplierinvoice/${encodeURIComponent(String(inv.GivenNumber ?? ''))}`,
        voucher_series: inv.VoucherSeries ? String(inv.VoucherSeries) : null,
        voucher_number: inv.VoucherNumber != null ? String(inv.VoucherNumber) : null,
        comments:       inv.Comments ? String(inv.Comments) : null,
      }
    })
    .filter(i => i.invoice_date)
    .sort((a, b) => b.invoice_date.localeCompare(a.invoice_date))

  const payload: RecentInvoicesPayload = {
    invoices,
    fetched_at:  new Date().toISOString(),
    days_window: yearMonthValid ? 0 : days,
    year_month:  yearMonthValid ? yearMonth : null,
    supplier_filter: supplierFilter || null,
  }

  await db
    .from('overhead_drilldown_cache')
    .upsert({
      business_id:  cacheKey.business_id,
      period_year:  cacheKey.period_year,
      period_month: cacheKey.period_month,
      category:     cacheKey.category,
      payload,
      fetched_at:   new Date().toISOString(),
    }, { onConflict: 'business_id,period_year,period_month,category' })

  return NextResponse.json(
    { ...payload, cache: 'miss' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function parseAmount(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
