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
import { requireBusinessAccess }        from '@/lib/auth/require-role'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'
import { getFreshFortnoxAccessToken }   from '@/lib/fortnox/api/auth'
import { supplierInvoiceUrl, getFortnoxWorkspaceId } from '@/lib/fortnox/web-url'

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
  DueDate?:        string
  FinalPayDate?:   string
  Total?:          number | string
  Balance?:        number | string         // remaining to pay; 0 = fully paid
  Currency?:       string
  Comments?:       string
  VoucherSeries?:  string
  VoucherNumber?:  number | string
  Cancelled?:      boolean
  Booked?:         boolean
  SupplierInvoiceFileConnections?: Array<{ FileId: string }>
}

export interface RecentInvoice {
  supplier_name:    string
  given_number:     string
  invoice_number:   string
  invoice_date:     string         // YYYY-MM-DD (or BookKeepingDate fallback)
  due_date:         string | null
  final_pay_date:   string | null
  total:            number | null
  balance:          number | null  // remaining to pay; 0 = fully paid
  status:           'paid' | 'overdue' | 'pending'
  currency:         string | null
  file_id:          string | null
  fortnox_url:      string | null
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
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

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

  // ── M098 local cache path ────────────────────────────────────────
  // Before hitting Fortnox live, try the fortnox_supplier_invoices
  // cache populated by /api/cron/fortnox-supplier-sync. When the cache
  // has rows for this business AND last_synced_at is recent (≤26h),
  // serve from the cache. This eliminates the per-render Fortnox
  // traffic that breaks the 25 req/5sec rate limit at customer #3+.
  //
  // Date window is computed inline (same logic as the live path
  // below) so the early-return doesn't duplicate state.
  const fromIsoLocal = (() => {
    if (yearMonthValid) {
      const [y, m] = yearMonth.split('-').map(Number)
      return `${y}-${String(m).padStart(2, '0')}-01`
    }
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
    const fromDate   = new Date(new Date(todayLocal + 'T00:00:00Z').getTime() - days * 86_400_000)
    return fromDate.toISOString().slice(0, 10)
  })()
  const toIsoLocal = (() => {
    if (yearMonthValid) {
      const [y, m] = yearMonth.split('-').map(Number)
      const lastDay = new Date(y!, m!, 0).getDate()
      return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    }
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
  })()

  const { data: syncState } = await db
    .from('fortnox_sync_state')
    .select('last_synced_at, last_cursor_date')
    .eq('business_id', businessId)
    .eq('resource', 'supplier_invoices')
    .maybeSingle()

  const cacheAgeMs = syncState?.last_synced_at
    ? Date.now() - new Date(syncState.last_synced_at).getTime()
    : Infinity
  const M098_FRESH_MS = 26 * 60 * 60 * 1000   // 26h — daily cron + safety margin

  if (cacheAgeMs < M098_FRESH_MS) {
    let q = db
      .from('fortnox_supplier_invoices')
      .select('given_number, invoice_number, supplier_name, invoice_date, due_date, final_pay_date, total, balance, currency, file_id, voucher_series, voucher_number, comments, cancelled')
      .eq('business_id', businessId)
      .eq('cancelled', false)
      .gte('invoice_date', fromIsoLocal)
      .lte('invoice_date', toIsoLocal)
      .order('invoice_date', { ascending: false })
      .limit(500)
    if (supplierFilter) {
      q = q.ilike('supplier_normalised', `%${supplierFilter.replace(/[^a-z0-9]+/g, '')}%`)
    }
    const { data: cacheRows, error: cacheErr } = await q

    if (!cacheErr && cacheRows && cacheRows.length > 0) {
      const workspaceIdEarly = await getFortnoxWorkspaceId(db, businessId)
      const todayLocalIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
      const invoices: RecentInvoice[] = cacheRows.map((r: any) => {
        const balance = r.balance != null ? Number(r.balance) : null
        const finalPay = r.final_pay_date ?? null
        const due = r.due_date ?? null
        let status: 'paid' | 'overdue' | 'pending' = 'pending'
        if (finalPay || (balance != null && Math.abs(balance) < 0.01)) status = 'paid'
        else if (due && due < todayLocalIso && (balance == null || balance > 0.5)) status = 'overdue'
        return {
          supplier_name:  String(r.supplier_name ?? '—'),
          given_number:   String(r.given_number ?? ''),
          invoice_number: String(r.invoice_number ?? r.given_number ?? '—'),
          invoice_date:   String(r.invoice_date),
          due_date:       due,
          final_pay_date: finalPay,
          total:          r.total != null ? Number(r.total) : null,
          balance,
          status,
          currency:       r.currency ?? 'SEK',
          file_id:        r.file_id ?? null,
          fortnox_url:    supplierInvoiceUrl(workspaceIdEarly, String(r.given_number ?? '')),
          voucher_series: r.voucher_series ?? null,
          voucher_number: r.voucher_number != null ? String(r.voucher_number) : null,
          comments:       r.comments ?? null,
        }
      })

      const payload: RecentInvoicesPayload = {
        invoices,
        fetched_at:      new Date().toISOString(),
        days_window:     yearMonthValid ? 0 : days,
        year_month:      yearMonthValid ? yearMonth : null,
        supplier_filter: supplierFilter || null,
      }

      // Write through to the 5-min in-app cache so repeat renders
      // within 5 min skip even this DB query.
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
        { ...payload, cache: 'm098' },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
  }
  // Fall through to live-Fortnox path: M098 empty or stale.

  // Helper: when Fortnox is unreachable mid-fetch (token refresh fails,
  // rate-limit, 5xx, etc.) we still want to return data if we have ANY
  // cached payload — staleness is far better than the dashboard widget
  // saying 'No recent invoices' when 19 are sitting in the cache.
  //
  // Two layers:
  //  1. Use the cache entry that EXACTLY matches the requested key.
  //  2. If that's empty (e.g. page requested days=90 but only days=14
  //     is cached), look at any __recent_invoices_*__ entry for this
  //     business and pick the freshest one. Returns SOME invoices to
  //     the UI even when the exact window isn't cached.
  const fallbackToStale = async (reason: string) => {
    if (cached?.payload) {
      return NextResponse.json(
        { ...(cached.payload as any), cache: 'stale', stale_reason: reason },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
    // Broader lookup: any recent-invoices cache for this business.
    const { data: anyCached } = await db
      .from('overhead_drilldown_cache')
      .select('payload, fetched_at, category')
      .eq('business_id', cacheKey.business_id)
      .eq('period_year',  0)
      .eq('period_month', 0)
      .like('category', '__recent_invoices_%')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (anyCached?.payload) {
      return NextResponse.json({
        ...(anyCached.payload as any),
        cache:        'stale_alt',
        stale_reason: `${reason}; using ${anyCached.category}`,
      }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return null
  }

  // Resolve a live Fortnox access token. Refreshes via refresh_token if
  // the stored access_token is within 5min of its 60-min expiry. Without
  // this, a dashboard mount more than an hour after OAuth would 401 — the
  // bug Vero hit on 2026-05-11, exactly one day after onboarding.
  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, auth.orgId, businessId)
  } catch (err: any) {
    const stale = await fallbackToStale(`token_refresh_failed: ${err?.message ?? err}`)
    if (stale) return stale
    return NextResponse.json({
      error:   'fortnox_token_refresh_failed',
      message: err?.message ?? 'Token refresh failed — please reconnect Fortnox.',
    }, { status: 401 })
  }
  if (!accessToken) {
    const stale = await fallbackToStale('no_token')
    if (stale) return stale
    return NextResponse.json({
      error:   'no_fortnox_connection',
      message: 'Connect Fortnox to see recent invoices.',
    }, { status: 404 })
  }

  const workspaceId = await getFortnoxWorkspaceId(db, businessId)

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
      const stale = await fallbackToStale(`fortnox_${res.status}: ${text.slice(0, 80)}`)
      if (stale) return stale
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

  // Today (Stockholm-local) for overdue determination.
  const todayLocalIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())

  // Map to display shape, sort newest first
  const invoices: RecentInvoice[] = filtered
    .map(inv => {
      const date = String(inv.InvoiceDate ?? inv.BookKeepingDate ?? '').slice(0, 10)
      const dueDate = String(inv.DueDate ?? '').slice(0, 10) || null
      const finalPay = String(inv.FinalPayDate ?? '').slice(0, 10) || null
      const total = parseAmount(inv.Total)
      const balance = parseAmount(inv.Balance)

      // Derive status from Fortnox's payment signals:
      //   - FinalPayDate set OR Balance === 0  → paid
      //   - DueDate in the past AND balance > 0 → overdue
      //   - otherwise → pending
      // Fortnox doesn't ship a single 'status' field on supplier invoices;
      // the convention above is what their own UI uses to color-code rows.
      let status: 'paid' | 'overdue' | 'pending' = 'pending'
      if (finalPay || (balance != null && Math.abs(balance) < 0.01)) {
        status = 'paid'
      } else if (dueDate && dueDate < todayLocalIso && (balance == null || balance > 0.5)) {
        status = 'overdue'
      }

      return {
        supplier_name:  String(inv.SupplierName ?? '—'),
        given_number:   String(inv.GivenNumber ?? ''),
        invoice_number: String(inv.InvoiceNumber ?? inv.GivenNumber ?? '—'),
        invoice_date:   date,
        due_date:       dueDate,
        final_pay_date: finalPay,
        total,
        balance,
        status,
        currency:       inv.Currency ? String(inv.Currency) : 'SEK',
        file_id:        inv.SupplierInvoiceFileConnections?.[0]?.FileId ?? null,
        fortnox_url:    supplierInvoiceUrl(workspaceId, String(inv.GivenNumber ?? '')),
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
