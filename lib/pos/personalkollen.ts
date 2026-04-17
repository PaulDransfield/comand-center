// @ts-nocheck
// lib/pos/personalkollen.ts
// Personalkollen integration — staff scheduling and time reporting
// Auth: Authorization: Token <api_key>
// Base: https://personalkollen.se/api/

const BASE = 'https://personalkollen.se/api'

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

async function fetchAll(endpoint: string, token: string): Promise<any[]> {
  const results: any[] = []
  let url: string | null = `${BASE}${endpoint}`
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Personalkollen error ${res.status}: ${res.statusText}`)
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
  if (toDate)   params.push(`start__lte=${toDate}`)
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
export async function getWorkPeriods(token: string, fromDate?: string, toDate?: string) {
  let endpoint = '/work-periods/'
  const params: string[] = []
  if (fromDate) params.push(`start__gte=${fromDate}`)
  if (toDate)   params.push(`start__lte=${toDate}`)
  if (params.length) endpoint += '?' + params.join('&')

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
      }
    })
}

// ── Sales ─────────────────────────────────────────────────────────────────────
// Response: { uid, url, sale_time, workplace, payments, items, number_of_guests }
export async function getSales(token: string, fromDate?: string, toDate?: string) {
  let endpoint = '/sales/'
  const params: string[] = []
  if (fromDate) params.push(`sale_time__gte=${fromDate}`)
  if (toDate)   params.push(`sale_time__lte=${toDate}`)
  if (params.length) endpoint += '?' + params.join('&')

  const sales = await fetchAll(endpoint, token)
  return sales.map((s: any) => {
    const totalGross = (s.payments ?? []).reduce((sum: number, p: any) => sum + parseFloat(p.amount ?? 0), 0)

    // PK API returns payment amounts — store as-is since the exact VAT treatment
    // depends on POS configuration. Revenue figures match PK's "Kassaförsäljning"
    // view. PK's dashboard "Försäljning" may show different figures depending on
    // their own VAT/reporting settings.
    const foodGross  = (s.items ?? []).filter((i: any) => i.category === 'food' || i.item_type === 'food').reduce((sum: number, i: any) => sum + parseFloat(i.total ?? 0), 0)
    const drinkGross = (s.items ?? []).filter((i: any) => i.category === 'drink' || i.item_type === 'drink').reduce((sum: number, i: any) => sum + parseFloat(i.total ?? 0), 0)

    return {
      uid:           s.uid,
      url:           s.url,
      sale_time:     s.sale_time,
      workplace_url: s.workplace,
      amount:        Math.round(totalGross * 100) / 100,
      covers:        s.number_of_guests ?? null,
      is_takeaway:   s.is_take_away ?? false,
      tip:           s.tip ? parseFloat(s.tip) : 0,
      payment_types: (s.payments ?? []).map((p: any) => p.payment_type ?? 'unknown'),
      food_revenue:  Math.round(foodGross * 100) / 100,
      drink_revenue: Math.round(drinkGross * 100) / 100,
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
  if (toDate)   params.push(`date__lte=${toDate}`)
  if (params.length) endpoint += '?' + params.join('&')

  const forecasts = await fetchAll(endpoint, token)
  return forecasts.map((f: any) => ({
    id:           f.id,
    workplace_url: f.workplace,
    date:         f.date,
    amount:       parseFloat(f.amount ?? 0),
  }))
}
