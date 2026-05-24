// app/api/suppliers/rollup/route.ts
//
// Phase 5+ — supplier cost intelligence. Two-source rollup:
//
//   1. /suppliers (Fortnox master list) — the canonical list of every
//      supplier the customer has set up in Fortnox. We list ALL of
//      them on the /suppliers page so food, drink, takeaway and
//      cleaning suppliers always appear, even if they had zero
//      invoices in the last 6 months.
//
//   2. /supplierinvoices (Fortnox invoice ledger, 6-month window) —
//      the actual spend. Joined onto the master by supplier name (or
//      SupplierNumber when both sides have it) so each master row
//      gains spend_total, invoice_count, last_invoice, monthly series,
//      delta, flag.
//
// Per-supplier, the response also includes a `recent_invoices` array
// (top 10 by date desc) with the file_id and a fortnox_url so the
// /suppliers page can open the PDF with one click via the existing
// /api/integrations/fortnox/file proxy.
//
// Categorisation (food / drink / takeaway / cleaning / services /
// utilities / other) is a heuristic on the supplier name + a fallback
// on the supplier number range so the operator can filter "show me
// every food supplier" without manually tagging each one.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'
import { getFreshFortnoxAccessToken }   from '@/lib/fortnox/api/auth'
import { requireBusinessAccess }        from '@/lib/auth/require-role'
import { supplierInvoiceUrl, getFortnoxWorkspaceId } from '@/lib/fortnox/web-url'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 30

const CACHE_TTL_MS    = 30 * 60 * 1000
const WINDOW_MONTHS   = 6
const PRICE_RISE_FLAG = 0.10   // 10% rise in the second half flags the supplier
const FORTNOX_API     = 'https://api.fortnox.se/3'
const RECENT_INVOICES_PER_SUPPLIER = 10

export type SupplierCategory =
  | 'food'
  | 'drink'
  | 'takeaway'
  | 'cleaning'
  | 'services'
  | 'utilities'
  | 'other'

export interface SupplierInvoiceLite {
  given_number:    string
  invoice_number:  string
  invoice_date:    string
  total:           number | null
  currency:        string | null
  file_id:         string | null
  fortnox_url:     string | null
}

export interface SupplierRollupRow {
  supplier_name:     string
  supplier_number:   string | null
  category:          SupplierCategory
  invoice_count:     number
  spend_total:       number
  last_invoice_kr:   number | null
  last_invoice_date: string | null
  monthly_series:    Array<{ month: string; kr: number }>
  trailing_avg:      number
  recent_avg:        number
  delta_pct:         number | null
  flag_price_rise:   boolean
  /** Top 10 invoices by date desc — for one-click PDF access. */
  recent_invoices:   SupplierInvoiceLite[]
}

export interface SuppliersRollupPayload {
  suppliers:   SupplierRollupRow[]
  window:      { from: string; to: string; months: number }
  category_counts: Record<SupplierCategory, number>
  fetched_at:  string
  cache?:      'hit' | 'miss'
}

// ── Category heuristics ─────────────────────────────────────────────
// Keyword-based — quick to maintain, easy for the operator to override
// by editing this map. Future iteration could persist per-supplier
// overrides in a Supabase table.
const CATEGORY_KEYWORDS: Record<SupplierCategory, RegExp[]> = {
  food: [
    /\b(martin\s*&?\s*servera|menigo|grönsakshallen|gronsakshallen|skafferi|fisk|kött|kott|chark|deli|bage|bage?ri|mejeri|frukt|grönt|gront|italmark|coop|axfood)\b/i,
    /\b(food|food\s*service|råvar|ravar|livsmedel|importör|importor)\b/i,
  ],
  drink: [
    /\b(systembolaget|carlsberg|spendrups|kopparberg|åbro|abro|kafve?|bryggeri|vin|öl|ol\b|sprit|läsk|lask|kaffe|java\s*roast)\b/i,
    /\b(beverage|drink|coffee|brewer)\b/i,
  ],
  takeaway: [
    /\b(foodora|wolt|uber\s*eats|emballage|engångs|engangs|takeaway|to\s*go|cardboard|carton)\b/i,
  ],
  cleaning: [
    /\b(städ|stad\b|kemtvätt|kemtvatt|tvätt|tvatt|hygien|servett|toa|toalett|cleaning|sanit|diversey|nilfisk)\b/i,
  ],
  utilities: [
    /\b(fortum|vattenfall|eon|e\.on|göteborg\s*energi|telia|tele2|telenor|comhem|tre\b|hallon|bredband2|el\b|elnät|elnat|fjärrvärme|fjarrvarme|vatten|sopor|återvinn|atervinn)\b/i,
  ],
  services: [
    /\b(advokat|jurist|revisor|redovisning|accountant|consult|reklam|marketing|design|byrå|byra|försäkring|forsakring|bank|nordea|swedbank|handelsbanken|seb|nets|klarna|stripe)\b/i,
    /\b(it\b|software|saas|abonnemang|prenumeration|cloud|hosting|microsoft|adobe|google|amazon|aws)\b/i,
  ],
  other: [],
}

function categoriseSupplier(name: string, number: string | null): SupplierCategory {
  for (const [cat, patterns] of Object.entries(CATEGORY_KEYWORDS) as Array<[SupplierCategory, RegExp[]]>) {
    if (cat === 'other') continue
    if (patterns.some(p => p.test(name))) return cat
  }
  return 'other'
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

  // Resolve Fortnox workspace_id once so deep links can render
  const workspaceId = await getFortnoxWorkspaceId(db, businessId)

  // ── Cache check ──────────────────────────────────────────────────
  // Cache key bumped to v3: the v2 payload baked the (broken) old
  // /supplierinvoice/{number} URLs. v3 uses the workspace-id-aware
  // helper. Old v2 cache rows expire on their own.
  const cacheKey = {
    business_id:  businessId,
    period_year:  0,
    period_month: 0,
    category:     `__suppliers_rollup_v3_${WINDOW_MONTHS}m__`,
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

  // ── Pull the supplier master list ────────────────────────────────
  // /suppliers returns every supplier on the Fortnox account, active
  // or inactive. Pagination same shape as supplierinvoices. Defensive
  // 5-page ceiling.
  interface RawMaster {
    SupplierNumber?: string
    Name?:           string
    Active?:         boolean
  }
  const masterRaw: RawMaster[] = []
  for (let page = 1; page <= 5; page++) {
    const url = `${FORTNOX_API}/suppliers?limit=500&page=${page}`
    const res = await fortnoxFetch(url, accessToken)
    if (!res.ok) {
      // Suppliers endpoint is non-fatal — if it fails we still build
      // the rollup from invoices alone.
      break
    }
    const body: any = await res.json().catch(() => null)
    const items: RawMaster[] = body?.Suppliers ?? []
    for (const s of items) masterRaw.push(s)
    const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? body?.MetaInformation?.TotalPages ?? 1)
    if (page >= totalPages) break
  }

  // ── Pull every supplier invoice in the window ────────────────────
  interface RawInvoice {
    SupplierName?:    string
    SupplierNumber?:  string
    GivenNumber?:     number | string
    InvoiceNumber?:   number | string
    InvoiceDate?:     string
    BookKeepingDate?: string
    Total?:           number | string
    Currency?:        string
    Cancelled?:       boolean
    SupplierInvoiceFileConnections?: Array<{ FileId: string }>
  }
  const invoices: RawInvoice[] = []
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
    for (const inv of items) if (!inv.Cancelled) invoices.push(inv)
    const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? body?.MetaInformation?.TotalPages ?? 1)
    if (page >= totalPages) break
  }

  // ── Roll up invoices by supplier name (canonical join key) ───────
  type Acc = {
    supplier_name:     string
    supplier_number:   string | null
    invoice_count:     number
    spend_total:       number
    last_invoice_kr:   number | null
    last_invoice_date: string | null
    by_month:          Map<string, number>
    invoices:          SupplierInvoiceLite[]
  }
  const accs = new Map<string, Acc>()
  function keyFor(name: string): string {
    return name.toLowerCase().replace(/\s+/g, ' ').trim()
  }
  for (const inv of invoices) {
    const name = String(inv.SupplierName ?? '').trim()
    if (!name) continue
    const date = String(inv.InvoiceDate ?? inv.BookKeepingDate ?? '').slice(0, 10)
    if (!date) continue
    const month = date.slice(0, 7)
    const kr    = parseAmount(inv.Total) ?? 0
    const k     = keyFor(name)

    let acc = accs.get(k)
    if (!acc) {
      acc = {
        supplier_name:     name,
        supplier_number:   inv.SupplierNumber ? String(inv.SupplierNumber) : null,
        invoice_count:     0,
        spend_total:       0,
        last_invoice_kr:   null,
        last_invoice_date: null,
        by_month:          new Map(),
        invoices:          [],
      }
      accs.set(k, acc)
    }
    acc.invoice_count += 1
    acc.spend_total   += kr
    acc.by_month.set(month, (acc.by_month.get(month) ?? 0) + kr)
    if (acc.last_invoice_date == null || date > acc.last_invoice_date) {
      acc.last_invoice_date = date
      acc.last_invoice_kr   = kr
    }
    // Lite invoice record — kept on the acc so per-supplier drawer can
    // list the recent N. file_id may be null when no PDF was attached
    // (e.g. manually-entered invoices); fortnox_url is always present
    // so the operator can at least jump into the booked voucher.
    const given = String(inv.GivenNumber ?? inv.InvoiceNumber ?? '')
    acc.invoices.push({
      given_number:   given,
      invoice_number: String(inv.InvoiceNumber ?? inv.GivenNumber ?? '—'),
      invoice_date:   date,
      total:          parseAmount(inv.Total),
      currency:       inv.Currency ? String(inv.Currency) : 'SEK',
      file_id:        inv.SupplierInvoiceFileConnections?.[0]?.FileId ?? null,
      fortnox_url:    supplierInvoiceUrl(workspaceId, given),
    })
  }

  // ── Merge master list onto the rollup ────────────────────────────
  // Every master-list entry that doesn't already have an Acc becomes a
  // zero-spend row so it still appears under its category. Master rows
  // are skipped if Active === false to keep the dropdown sane.
  for (const s of masterRaw) {
    const name = String(s.Name ?? '').trim()
    if (!name) continue
    if (s.Active === false) continue
    const k = keyFor(name)
    if (!accs.has(k)) {
      accs.set(k, {
        supplier_name:     name,
        supplier_number:   s.SupplierNumber ? String(s.SupplierNumber) : null,
        invoice_count:     0,
        spend_total:       0,
        last_invoice_kr:   null,
        last_invoice_date: null,
        by_month:          new Map(),
        invoices:          [],
      })
    } else {
      // If the invoice side never carried a SupplierNumber, fill it in
      // from the master row. Helps with future per-supplier deep links.
      const acc = accs.get(k)!
      if (!acc.supplier_number && s.SupplierNumber) acc.supplier_number = String(s.SupplierNumber)
    }
  }

  // ── Build the month axis ────────────────────────────────────────
  const months: string[] = []
  for (let i = WINDOW_MONTHS - 1; i >= 0; i--) {
    const d = new Date(today.getUTCFullYear(), today.getUTCMonth() - i, 1)
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  const halfIdx = Math.floor(months.length / 2)

  // ── Shape output rows ────────────────────────────────────────────
  const suppliers: SupplierRollupRow[] = []
  const categoryCounts: Record<SupplierCategory, number> = {
    food: 0, drink: 0, takeaway: 0, cleaning: 0, services: 0, utilities: 0, other: 0,
  }
  for (const acc of accs.values()) {
    const series       = months.map(m => ({ month: m, kr: Math.round(acc.by_month.get(m) ?? 0) }))
    const trailing     = series.slice(0, halfIdx).map(s => s.kr)
    const recent       = series.slice(halfIdx).map(s => s.kr)
    const trailing_avg = trailing.length ? trailing.reduce((s, v) => s + v, 0) / trailing.length : 0
    const recent_avg   = recent.length   ? recent.reduce((s, v) => s + v, 0)   / recent.length   : 0
    const delta_pct    = trailing_avg > 0 ? (recent_avg - trailing_avg) / trailing_avg : null
    const category     = categoriseSupplier(acc.supplier_name, acc.supplier_number)
    categoryCounts[category] += 1

    // Sort the per-supplier invoice list newest-first and cap.
    const recentInvoices = acc.invoices
      .sort((a, b) => b.invoice_date.localeCompare(a.invoice_date))
      .slice(0, RECENT_INVOICES_PER_SUPPLIER)

    suppliers.push({
      supplier_name:     acc.supplier_name,
      supplier_number:   acc.supplier_number,
      category,
      invoice_count:     acc.invoice_count,
      spend_total:       Math.round(acc.spend_total),
      last_invoice_kr:   acc.last_invoice_kr,
      last_invoice_date: acc.last_invoice_date,
      monthly_series:    series,
      trailing_avg:      Math.round(trailing_avg),
      recent_avg:        Math.round(recent_avg),
      delta_pct,
      flag_price_rise:   delta_pct != null && delta_pct >= PRICE_RISE_FLAG,
      recent_invoices:   recentInvoices,
    })
  }

  // Sort: suppliers WITH spend first (by spend desc), then zero-spend
  // alphabetical so the "always-listed" master rows don't bury the
  // operator's actual active suppliers.
  suppliers.sort((a, b) => {
    if (a.spend_total !== b.spend_total) return b.spend_total - a.spend_total
    return a.supplier_name.localeCompare(b.supplier_name)
  })

  const payload: SuppliersRollupPayload = {
    suppliers,
    window:          { from: fromIso, to: toIso, months: WINDOW_MONTHS },
    category_counts: categoryCounts,
    fetched_at:      new Date().toISOString(),
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
