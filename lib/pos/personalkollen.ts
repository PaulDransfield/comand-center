// @ts-nocheck
// lib/pos/personalkollen.ts
// Personalkollen integration — staff scheduling and time reporting
// Auth: Authorization: Token <api_key>
// Base: https://personalkollen.se/api/

const BASE = 'https://personalkollen.se/api'

// Django parses a bare date ("2026-04-21") in a DateTime filter as 00:00:00.
// That means `sale_time__lte=2026-04-21` matches sales up to midnight at the
// START of that day — excluding all of 2026-04-21 AND the evening of the
// previous day (since restaurants close after 22:00, those rows fail <=00:00).
//
// Bug confirmed 2026-04-21: Mon 20 Apr + Sun 19 Apr were silently dropped
// from master-sync because each morning's cron passed `toDate` as a bare
// date and cut off yesterday's dinner service.
//
// Fix: if the caller passes a date-only string, pad to end-of-day in local
// time so the __lte window is inclusive of the full day.
function endOfDay(d: string): string {
  // Already a datetime? Leave alone.
  if (d.includes('T') || d.includes(' ')) return d
  return `${d}T23:59:59`
}

// Map Swedish OB verbose names from PK to English labels
// PK returns ob.tag like "ob1","ob2","ob3" and ob.verbose_name in Swedish
// We keep the tag as the key and provide English display names
const OB_TYPE_EN: Record<string, string> = {
  ob1: 'Evening OB',
  ob2: 'Night OB',
  ob3: 'Weekend OB',
}
function obLabel(ob: any): string {
  const tag = (ob.tag ?? '').toLowerCase()
  if (OB_TYPE_EN[tag]) return OB_TYPE_EN[tag]
  // Fallback: if tag doesn't match, use tag as-is (e.g. "ob1")
  return ob.tag ?? 'OB'
}

// Thrown when PK returns 401/403 — signals the customer's API token was
// revoked or rotated and the integration needs reconnection. Typed so
// sync/engine can distinguish auth failures from transient network errors
// and flip `integrations.status` + send a re-auth email (rather than silent
// retry-until-you-email-support).
export class PersonalkollenAuthError extends Error {
  readonly code = 'PK_AUTH_EXPIRED'
  readonly httpStatus: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'PersonalkollenAuthError'
    this.httpStatus = status
  }
}

async function fetchAll(endpoint: string, token: string): Promise<any[]> {
  const results: any[] = []
  let url: string | null = `${BASE}${endpoint}`
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new PersonalkollenAuthError(res.status, `Personalkollen ${res.status}: token revoked or rotated`)
      }
      throw new Error(`Personalkollen error ${res.status}: ${res.statusText}`)
    }
    const data = await res.json()
    results.push(...(data.results ?? []))
    url = data.next ?? null
  }
  return results
}

// ── Workplaces ────────────────────────────────────────────────────────────────
// Response: { url, short_identifier, description, company }
export async function getWorkplaces(token: string) {
  const places = await fetchAll('/workplaces/', token)
  return places.map((w: any) => ({
    id:          w.short_identifier,
    url:         w.url,
    name:        w.description,
    company_url: w.company,
  }))
}

// ── Staff ─────────────────────────────────────────────────────────────────────
// Response: { id, url, first_name, last_name, email, group_name, workplace, confirmed }
export async function getStaff(token: string) {
  const staff = await fetchAll('/staffs/', token)
  return staff.map((s: any) => ({
    id:            s.id,
    url:           s.url,
    name:          `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(),
    email:         s.email ?? null,
    group:         s.group_name ?? null,
    workplace_url: s.workplace ?? null,
    confirmed:     s.confirmed ?? false,
  }))
}

// ── Logged times (actual worked hours) ───────────────────────────────────────
// Response: { url, start, stop, work_time, cost, estimated_salary, staff, workplace, is_canceled, is_guest }
export async function getLoggedTimes(token: string, fromDate?: string, toDate?: string) {
  let endpoint = '/logged-times/'
  const params: string[] = []
  if (fromDate) params.push(`start__gte=${fromDate}`)
  if (toDate)   params.push(`start__lte=${endOfDay(toDate)}`)
  if (params.length) endpoint += '?' + params.join('&')

  const times = await fetchAll(endpoint, token)
  return times
    .filter((t: any) => !t.is_canceled && !t.is_guest && t.stop)
    .map((t: any) => ({
      url:              t.url,
      staff_url:        t.staff,
      workplace_url:    t.workplace,
      start:            t.start,
      stop:             t.stop,
      real_start:       t.real_start ?? null,
      real_stop:        t.real_stop  ?? null,
      hours:            t.work_time ? Math.round((t.work_time / 3600) * 10) / 10 : null,
      breaks_duration:  t.breaks_duration ?? 0,     // total break seconds
      cost:             t.cost ?? null,              // includes employer taxes + vacation pay
      salary:           t.estimated_salary ?? null,  // time × hourly rate
      shift_salary:     t.shift_salary ?? null,      // fixed shift salary
      costgroup:        t.costgroup ?? null,          // { name, url } section within workplace
      ob_supplement:    0,                            // calculated below
      ob_hours:         Math.round(((t.additional_salaries ?? []).reduce((s: number, ob: any) => s + (ob.duration ? ob.duration / 3600 : 0), 0)) * 10) / 10,
      ob_types:         (t.additional_salaries ?? []).map((ob: any) => obLabel(ob)).join(', '),
      ob_amount_kr:     (t.additional_salaries ?? []).reduce((s: number, ob: any) => {
        // Approximate OB supplement value
        const tag = ob.tag ?? ''
        const hrs = ob.duration ? ob.duration / 3600 : 0
        // OB1 ~25kr/h, OB2 ~50kr/h, OB3 ~80kr/h based on Visita/HRF agreement
        const rate = tag.includes('ob3') ? 80 : tag.includes('ob2') ? 50 : 25
        return s + (hrs * rate)
      }, 0),
    }))
}

// ── Work periods (scheduled shifts) ──────────────────────────────────────────
// Response: { url, staff, staff_name, date, start, end, estimated_cost, workplace, is_deleted }
//
// include_drafts=1 is essential: per PK docs, work periods that have never
// been published (or have no assigned staff) are excluded by default. Owners
// often build next week's schedule without explicitly "publishing" — or
// leave some slots unassigned — and without this flag the /work-periods/
// endpoint silently returns empty, breaking the scheduling AI page.
// The extractor still filters out is_deleted below, and we also drop
// is_published=false at the call-site if we want a "published-only" view.
export async function getWorkPeriods(token: string, fromDate?: string, toDate?: string) {
  let endpoint = '/work-periods/'
  const params: string[] = ['include_drafts=1']
  if (fromDate) params.push(`start__gte=${fromDate}`)
  if (toDate)   params.push(`start__lte=${endOfDay(toDate)}`)
  endpoint += '?' + params.join('&')

  const periods = await fetchAll(endpoint, token)
  return periods
    .filter((p: any) => !p.is_deleted)
    .map((p: any) => {
      // Sum OB supplements
      const obTotal = (p.additional_salaries ?? []).reduce((s: number, ob: any) => {
        // duration in seconds × estimated rate — we store just the flag for now
        return s + (ob.duration ? ob.duration / 3600 : 0)
      }, 0)
      return {
        url:                p.url,
        staff_url:          p.staff,
        staff_name:         p.staff_name ?? null,
        date:               p.date,
        start:              p.start,
        end:                p.end,
        estimated_cost:     p.estimated_cost ?? 0,
        workplace_url:      p.workplace,
        period_name:        p.period_name ?? null,
        costgroup:          p.costgroup ?? null,
        ob_hours:           Math.round(obTotal * 10) / 10,
        has_ob:             (p.additional_salaries ?? []).length > 0,
        // Surface publish state so the scheduling AI can treat drafts
        // differently from published shifts if needed (e.g. badge them,
        // or exclude from "actual hours planned" totals).
        is_published:       p.is_published ?? true,
      }
    })
}

// ── Sales ─────────────────────────────────────────────────────────────────────
//
// Revenue interpretation (verified against live PK data 2026-04-19 via
// scripts/diag-vat-*.mjs):
//
//   item.amount          = quantity
//   item.price_per_unit  = NET price (ex-VAT)
//   item.vat             = VAT rate as decimal (0.06, 0.12, 0.25)
//   payments[].amount    = GROSS paid (inc-VAT + tip)
//   sale.tip             = tip portion of payments
//
// Swedish VAT coding doubles as product/service classification:
//   6 %  → takeaway food (reduced rate)
//   12 % → dine-in food
//   25 % → alcohol / soft drinks
//
// We report `amount` as NET so it matches PK dashboard "Försäljning ex. moms".
// Tip is separated, gross kept as `gross_amount` for reconciliation.
export async function getSales(token: string, fromDate?: string, toDate?: string) {
  let endpoint = '/sales/'
  const params: string[] = []
  if (fromDate) params.push(`sale_time__gte=${fromDate}`)
  if (toDate)   params.push(`sale_time__lte=${endOfDay(toDate)}`)
  if (params.length) endpoint += '?' + params.join('&')

  const raw = await fetchAll(endpoint, token)

  return raw.map((s: any) => {
    // Net from items: Σ (qty × price_per_unit). This is already ex-VAT.
    //
    // Swedish VAT coding (verified 2026-04-19 against Vero restaurant data):
    //   12 %  → dine-in food
    //   25 %  → alcohol / soft drinks
    //    6 %  → takeaway food (reduced rate — Swedish tax code)
    //
    // So the VAT rate doubles as a reliable dine-in-vs-takeaway signal, since
    // PK's own `is_take_away` boolean is null on most rows.
    let net          = 0
    let foodNet      = 0
    let drinkNet     = 0
    let takeawayNet  = 0
    let dineInNet    = 0
    for (const i of (s.items ?? [])) {
      const qty    = parseFloat(i.amount          ?? 0)
      const price  = parseFloat(i.price_per_unit  ?? 0)
      const vat    = parseFloat(i.vat             ?? 0)
      const line   = qty * price
      net += line
      if      (Math.abs(vat - 0.12) < 0.001) { foodNet  += line; dineInNet   += line }
      else if (Math.abs(vat - 0.06) < 0.001) { foodNet  += line; takeawayNet += line }
      else if (Math.abs(vat - 0.25) < 0.001) { drinkNet += line; dineInNet   += line }
      else                                   { drinkNet += line; dineInNet   += line }  // unknowns default to drink / dine-in
    }

    const gross = (s.payments ?? []).reduce((sum: number, p: any) => sum + parseFloat(p.amount ?? 0), 0)
    const tip   = s.tip ? parseFloat(s.tip) : 0

    // Prefer the VAT-rate signal over PK's `is_take_away` (mostly null).
    // Fall back to the flag only if no 6 % items at all.
    const isTakeaway = takeawayNet > 0 ? true : (s.is_take_away ?? false)

    return {
      uid:           s.uid,
      url:           s.url,
      sale_time:     s.sale_time,
      workplace_url: s.workplace,

      // `amount` is now NET ex-VAT (matches PK dashboard "Försäljning ex. moms").
      // Tip excluded (reported separately). Gross kept as `gross_amount` for
      // reconciliation / VAT reports.
      amount:        Math.round(net * 100) / 100,
      gross_amount:  Math.round(gross * 100) / 100,

      covers:        s.number_of_guests ?? null,
      is_takeaway:   isTakeaway,
      tip,
      payment_types: (s.payments ?? []).map((p: any) => p.method?.name ?? p.payment_type ?? 'unknown'),
      food_revenue:     Math.round(foodNet * 100) / 100,
      drink_revenue:    Math.round(drinkNet * 100) / 100,
      takeaway_revenue: Math.round(takeawayNet * 100) / 100,
      dine_in_revenue:  Math.round(dineInNet * 100) / 100,
    }
  })
}

// ── Summary for a date range ──────────────────────────────────────────────────
export async function getStaffSummary(token: string, fromDate: string, toDate: string) {
  const [logged, scheduled, workplaces] = await Promise.all([
    getLoggedTimes(token, fromDate, toDate),
    getWorkPeriods(token, fromDate, toDate),
    getWorkplaces(token),
  ])

  const totalLoggedHours    = logged.reduce((s, t) => s + (t.hours ?? 0), 0)
  const totalScheduledHours = scheduled.reduce((s, p) => {
    if (!p.start || !p.end) return s
    const hrs = (new Date(p.end).getTime() - new Date(p.start).getTime()) / 3600000
    return s + Math.max(0, hrs)
  }, 0)
  const totalStaffCost      = logged.reduce((s, t) => s + (t.cost ?? 0), 0)
  const scheduledCost       = scheduled.reduce((s, p) => s + (p.estimated_cost ?? 0), 0)

  return {
    period:             { from: fromDate, to: toDate },
    workplaces:         workplaces.length,
    logged_hours:       Math.round(totalLoggedHours * 10) / 10,
    scheduled_hours:    Math.round(totalScheduledHours * 10) / 10,
    staff_cost_actual:  Math.round(totalStaffCost),    // actual cost incl. taxes
    staff_cost_scheduled: Math.round(scheduledCost),   // estimated from schedule
    shifts_logged:      logged.length,
    shifts_scheduled:   scheduled.length,
  }
}

// ── Sale forecast ─────────────────────────────────────────────────────────────
export async function getSaleForecast(token: string, fromDate?: string, toDate?: string) {
  let endpoint = '/sale-forecast/'
  const params: string[] = []
  if (fromDate) params.push(`date__gte=${fromDate}`)
  if (toDate)   params.push(`date__lte=${endOfDay(toDate)}`)
  if (params.length) endpoint += '?' + params.join('&')

  const forecasts = await fetchAll(endpoint, token)
  return forecasts.map((f: any) => ({
    id:           f.id,
    workplace_url: f.workplace,
    date:         f.date,
    amount:       parseFloat(f.amount ?? 0),
  }))
}
