// app/api/suppliers/rollup/route.ts
//
// Phase 5 — supplier cost intelligence. Pulls the last 180 days of
// Fortnox supplier invoices for a business and rolls them up by
// supplier so the /suppliers page can show: total spend, last
// invoice, ΔΔ vs trailing average, monthly sparkline.
//
// Model:
//   - Calls Fortnox /supplierinvoices with a 6-month window (same way
//     /api/integrations/fortnox/recent-invoices does — single shared
//     auth + paging pattern). Reuses the 5-min cache table the recent-
//     invoices route owns.
//   - Group by SupplierName (Fortnox doesn't always populate
//     SupplierNumber, so name is the only reliable key).
//   - For each supplier:
//       spend_total       = sum(Total) across the window
//       last_invoice_kr   = most recent invoice's Total
//       last_invoice_date = newest InvoiceDate
//       monthly_series    = [{ month: 'YYYY-MM', kr: number }] across 6 mo
//       trailing_avg      = mean of months 1–3 (oldest half)
//       recent_avg        = mean of months 4–6 (newest half)
//       delta_pct         = (recent_avg − trailing_avg) / trailing_avg
//       flag_price_rise   = delta_pct >= 0.10 (configurable threshold)
//
// Returns: { suppliers: SupplierRow[], window: {from, to, months: 6}, cache }
//
// Caching: 30-min TTL via overhead_drilldown_cache with synthetic key
// (period_year=0, period_month=0, category='__suppliers_rollup_<bizId>__').
// Suppliers data doesn't shift every minute, and a 30-min refresh window
// is cheap on the Fortnox side.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'
import { getFreshFortnoxAccessToken }   from '@/lib/fortnox/api/auth'
import { requireBusinessAccess }        from '@/lib/auth/require-role'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 30

const CACHE_TTL_MS    = 30 * 60 * 1000
const WINDOW_MONTHS   = 6
const PRICE_RISE_FLAG = 0.10   // 10% rise in the second half flags the supplier
const FORTNOX_API     = 'https://api.fortnox.se/3'

export interface SupplierRollupRow {
  supplier_name:     string
  invoice_count:     number
  spend_total:       number
  last_invoice_kr:   number | null
  last_invoice_date: string | null
  monthly_series:    Array<{ month: string; kr: number }>
  trailing_avg:      number   // mean of months 1–3 (oldest half)
  recent_avg:        number   // mean of months 4–6 (newest half)
  delta_pct:         number | null   // (recent − trailing) / trailing
  flag_price_rise:   boolean
}

export interface SuppliersRollupPayload {
  suppliers:   SupplierRollupRow[]
  window:      { from: string; to: string; months: number }
  fetched_at:  string
  cache?:      'hit' | 'miss'
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = (req.nextUrl.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const bizForbidden = requireBusinessAccess(auth, businessId); if (bizForbidden) return bizForbidden

  const db = createAdminClient()

  // ── Date window (Stockholm-local) ────────────────────────────────
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
  const today      = new Date(todayLocal + 'T00:00:00Z')
  const fromDate   = new Date(today)
  fromDate.setUTCMonth(fromDate.getUTCMonth() - WINDOW_MONTHS)
  const fromIso = fromDate.toISOString().slice(0, 10)
  const toIso   = todayLocal

  // ── Cache check ──────────────────────────────────────────────────
  const cacheKey = {
    business_id:  businessId,
    period_year:  0,
    period_month: 0,
    category:     `__suppliers_rollup_${WINDOW_MONTHS}m__`,
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
      message: 'Connect Fortnox to see supplier cost intelligence.',
    }, { status: 404 })
  }

  // ── Pull every supplier invoice in the window ────────────────────
  // Mirrors recent-invoices: pagination with limit=500, defensive 5-page
  // ceiling so a misbehaving Fortnox can't run us out of maxDuration.
  interface RawInvoice {
    SupplierName?: string
    InvoiceDate?:  string
    BookKeepingDate?: string
    Total?:        number | string
    Cancelled?:    boolean
  }
  const collected: RawInvoice[] = []
  for (let page = 1; page <= 5; page++) {
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
    const items: RawInvoice[] = body?.SupplierInvoices ?? []
    for (const inv of items) if (!inv.Cancelled) collected.push(inv)
    const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? body?.MetaInformation?.TotalPages ?? 1)
    if (page >= totalPages) break
  }

  // ── Roll up by supplier ──────────────────────────────────────────
  type Acc = {
    supplier_name:     string
    invoice_count:     number
    spend_total:       number
    last_invoice_kr:   number | null
    last_invoice_date: string | null
    by_month:          Map<string, number>   // 'YYYY-MM' → kr
  }
  const accs = new Map<string, Acc>()
  for (const inv of collected) {
    const name = String(inv.SupplierName ?? '').trim() || '—'
    const date = String(inv.InvoiceDate ?? inv.BookKeepingDate ?? '').slice(0, 10)
    if (!date) continue
    const month = date.slice(0, 7)  // 'YYYY-MM'
    const kr = parseAmount(inv.Total) ?? 0

    let acc = accs.get(name)
    if (!acc) {
      acc = {
        supplier_name:     name,
        invoice_count:     0,
        spend_total:       0,
        last_invoice_kr:   null,
        last_invoice_date: null,
        by_month:          new Map(),
      }
      accs.set(name, acc)
    }
    acc.invoice_count += 1
    acc.spend_total   += kr
    acc.by_month.set(month, (acc.by_month.get(month) ?? 0) + kr)
    if (acc.last_invoice_date == null || date > acc.last_invoice_date) {
      acc.last_invoice_date = date
      acc.last_invoice_kr   = kr
    }
  }

  // ── Build the month axis (6 contiguous months ending this month) ─
  const months: string[] = []
  for (let i = WINDOW_MONTHS - 1; i >= 0; i--) {
    const d = new Date(today.getUTCFullYear(), today.getUTCMonth() - i, 1)
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  const halfIdx = Math.floor(months.length / 2)   // 3 for WINDOW=6

  // ── Shape output rows ────────────────────────────────────────────
  const suppliers: SupplierRollupRow[] = []
  for (const acc of accs.values()) {
    const series = months.map(m => ({ month: m, kr: Math.round(acc.by_month.get(m) ?? 0) }))
    const trailing = series.slice(0, halfIdx).map(s => s.kr)
    const recent   = series.slice(halfIdx).map(s => s.kr)
    const trailing_avg = trailing.length ? trailing.reduce((s, v) => s + v, 0) / trailing.length : 0
    const recent_avg   = recent.length   ? recent.reduce((s, v) => s + v, 0)   / recent.length   : 0
    const delta_pct    = trailing_avg > 0 ? (recent_avg - trailing_avg) / trailing_avg : null

    suppliers.push({
      supplier_name:     acc.supplier_name,
      invoice_count:     acc.invoice_count,
      spend_total:       Math.round(acc.spend_total),
      last_invoice_kr:   acc.last_invoice_kr,
      last_invoice_date: acc.last_invoice_date,
      monthly_series:    series,
      trailing_avg:      Math.round(trailing_avg),
      recent_avg:        Math.round(recent_avg),
      delta_pct,
      flag_price_rise:   delta_pct != null && delta_pct >= PRICE_RISE_FLAG,
    })
  }

  // Sort by total spend desc — operator's natural "where's the money
  // going" mental model. Caller (the page) is free to re-sort.
  suppliers.sort((a, b) => b.spend_total - a.spend_total)

  const payload: SuppliersRollupPayload = {
    suppliers,
    window:     { from: fromIso, to: toIso, months: WINDOW_MONTHS },
    fetched_at: new Date().toISOString(),
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
