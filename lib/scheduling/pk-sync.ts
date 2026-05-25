// lib/scheduling/pk-sync.ts
//
// Pulls Personalkollen scheduled shifts + derived templates into our
// staff_shifts + staff_shift_templates tables (M100). Called by the
// scheduling cron + on-demand from the /scheduling page when the
// owner clicks Refresh.
//
// Architecture per AI-SCHEDULING-PLAN.md §3 + Phase 0 findings:
//   - PK /work-periods/ payload contains everything we need per shift,
//     including the embedded period_name + period_color + costgroup
//     that defines the template.
//   - PK does NOT expose /periods/{id}/ to our token, so we derive
//     templates by deduping (period_name, period_color, costgroup.short_identifier)
//     clusters in the work-periods data.
//   - PK is READ-ONLY for us. We never write back.
//
// Idempotent — pk_work_period_url is the unique key on staff_shifts.
// Multiple calls during the same window safely upsert.

import type { SupabaseClient } from '@supabase/supabase-js'

const PK_BASE = 'https://personalkollen.se/api'

interface SyncOptions {
  /** ISO date YYYY-MM-DD. Default: 12 weeks ago. */
  fromDate?: string
  /** ISO date. Default: 2 weeks from today. */
  toDate?:   string
  /** Include unpublished drafts. PK default false; we want true so the
   *  AI sees in-progress schedules. Memory: feedback_pk_api_gotchas. */
  includeDrafts?: boolean
}

export interface SyncResult {
  shifts_upserted:    number
  templates_upserted: number
  templates_total:    number
  staff_seen:         number
  pages_fetched:      number
  errors:             string[]
}

// PK colour keywords → UXP-compatible hex. Maps the small enum PK uses
// for period_color to brand-friendly display colours. Owners can
// override per-template via staff_shift_templates.display_colour.
const PK_COLOUR_HEX: Record<string, string> = {
  red:     '#e07a7a',
  orange:  '#e8a26b',
  yellow:  '#e8d770',
  green:   '#7fbfa3',
  blue:    '#7aa8d4',
  purple:  '#a99ce6',
  pink:    '#e0a3c1',
  grey:    '#9b9b9b',
  brown:   '#a8856b',
  black:   '#5e5b6b',
}

// Section bucket inference — used when we first see a template.
// Crude keyword match on (template_name + costgroup_name); owner can
// override via section_overridden=true.
const SECTION_KEYWORDS: Record<string, string[]> = {
  kitchen:    ['kök', 'kok', 'kitchen', 'pasta', 'pizza', 'kock', 'chef', 'cook', 'kallskänk', 'varma'],
  foh:        ['foh', 'front', 'sal', 'service', 'server', 'kassa', 'kvall', 'kväll', 'morgon', 'mellan'],
  bar:        ['bar', 'bartender', 'drink'],
  management: ['gm', 'manager', 'chef', 'restaurangchef', 'kontor', 'office', 'admin'],
  office:     ['kontor', 'office', 'admin'],
}

function inferSection(name: string, costgroupName: string | null): string {
  const haystack = `${name} ${costgroupName ?? ''}`.toLowerCase()
  for (const [section, kws] of Object.entries(SECTION_KEYWORDS)) {
    if (kws.some(kw => haystack.includes(kw))) return section
  }
  return 'other'
}

// ─────────────────────────────────────────────────────────────────────
// Entry point

export async function syncScheduleFromPK(
  db:         SupabaseClient,
  businessId: string,
  token:      string,
  opts:       SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    shifts_upserted: 0, templates_upserted: 0, templates_total: 0,
    staff_seen: 0, pages_fetched: 0, errors: [],
  }

  // Resolve org_id once
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz?.org_id) {
    result.errors.push('business not found')
    return result
  }
  const orgId = biz.org_id

  // Default window: 12 weeks back, 2 weeks forward
  const today = new Date()
  const fromIso = opts.fromDate ?? (() => {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - 12 * 7)
    return d.toISOString().slice(0, 10)
  })()
  const toIso = opts.toDate ?? (() => {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() + 2 * 7)
    return d.toISOString().slice(0, 10)
  })()

  // Pull all work-periods in the window. PK paginates with `next` cursor.
  const include = opts.includeDrafts !== false ? '&include_drafts=1' : ''
  let url: string | null = `${PK_BASE}/work-periods/?start__gte=${fromIso}T00:00:00Z&start__lte=${toIso}T23:59:59Z${include}`

  const allShifts: any[] = []
  let pages = 0
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } })
    if (!r.ok) {
      result.errors.push(`PK fetch failed at page ${pages + 1}: HTTP ${r.status}`)
      break
    }
    const json: any = await r.json()
    if (Array.isArray(json?.results)) allShifts.push(...json.results)
    pages++
    url = json?.next ?? null
    if (pages > 50) { result.errors.push('safety cap: stopped at 50 pages'); break }
  }
  result.pages_fetched = pages

  // ── 1. Derive templates by deduping (period_name, period_color, costgroup.short_identifier) ──
  type TemplateKey = string
  const templateKey = (name: string, color: string | null, csid: number | null): TemplateKey =>
    `${name}|${color ?? ''}|${csid ?? ''}`

  const templateBuckets = new Map<TemplateKey, {
    name: string
    pk_period_color: string | null
    pk_costgroup_short_id: number | null
    costgroup_name: string | null
    start_times: string[]
    end_times: string[]
    shifts_count: number
    last_seen_on: string | null
  }>()

  for (const wp of allShifts) {
    if (wp.is_deleted) continue
    const name  = String(wp.period_name ?? 'Unnamed').slice(0, 200)
    const color = (wp.period_color as string | null) ?? null
    const csid  = wp.costgroup?.short_identifier ?? null
    const k = templateKey(name, color, csid)
    if (!templateBuckets.has(k)) {
      templateBuckets.set(k, {
        name, pk_period_color: color, pk_costgroup_short_id: csid,
        costgroup_name: wp.costgroup?.name ?? null,
        start_times: [], end_times: [],
        shifts_count: 0, last_seen_on: null,
      })
    }
    const b = templateBuckets.get(k)!
    b.shifts_count++
    if (wp.start_time) b.start_times.push(wp.start_time)
    if (wp.end_time)   b.end_times.push(wp.end_time)
    if (wp.date && (!b.last_seen_on || wp.date > b.last_seen_on)) b.last_seen_on = wp.date
  }
  result.templates_total = templateBuckets.size

  // Mode helper for modal_start/end_time
  function mode(arr: string[]): string | null {
    if (arr.length === 0) return null
    const counts = new Map<string, number>()
    for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0]
  }

  // Upsert templates one-by-one (it's <50 typically; bulk-upsert with
  // partial composite key is messy with supabase-js). Then re-fetch
  // their IDs so we can link shifts.
  const templateIdByKey = new Map<TemplateKey, string>()
  for (const [k, b] of templateBuckets) {
    const section = inferSection(b.name, b.costgroup_name)
    const displayColour = b.pk_period_color ? (PK_COLOUR_HEX[b.pk_period_color.toLowerCase()] ?? '#9b9b9b') : '#9b9b9b'
    // SELECT-then-INSERT-or-UPDATE pattern (PostgREST onConflict can't
    // use the partial-or-composite key reliably across nullable cols).
    const { data: existing } = await db
      .from('staff_shift_templates')
      .select('id, section_overridden, colour_overridden')
      .eq('business_id', businessId)
      .eq('name', b.name)
      .eq('pk_period_color', b.pk_period_color ?? '')
      .eq('pk_costgroup_short_id', b.pk_costgroup_short_id ?? 0)
      .maybeSingle()

    if (existing) {
      // Update derived stats; preserve owner overrides on section/colour.
      const patch: Record<string, any> = {
        modal_start_time: mode(b.start_times),
        modal_end_time:   mode(b.end_times),
        shifts_count_60d: b.shifts_count,
        last_seen_on:     b.last_seen_on,
      }
      if (!existing.section_overridden) patch.section = section
      if (!existing.colour_overridden)  patch.display_colour = displayColour
      const { error } = await db.from('staff_shift_templates').update(patch).eq('id', existing.id)
      if (error) result.errors.push(`template update: ${error.message}`)
      else { templateIdByKey.set(k, existing.id); result.templates_upserted++ }
    } else {
      const { data: ins, error } = await db.from('staff_shift_templates').insert({
        org_id: orgId, business_id: businessId,
        name: b.name,
        pk_period_color:        b.pk_period_color ?? '',
        pk_costgroup_short_id:  b.pk_costgroup_short_id ?? 0,
        modal_start_time:       mode(b.start_times),
        modal_end_time:         mode(b.end_times),
        section, display_colour: displayColour,
        shifts_count_60d: b.shifts_count,
        last_seen_on: b.last_seen_on,
      }).select('id').single()
      if (error) result.errors.push(`template insert: ${error.message}`)
      else if (ins) { templateIdByKey.set(k, ins.id); result.templates_upserted++ }
    }
  }

  // ── 2. Upsert shifts ──
  const staffUidSet = new Set<string>()
  const shiftRows: any[] = []
  for (const wp of allShifts) {
    if (wp.is_deleted) continue
    const name  = String(wp.period_name ?? 'Unnamed').slice(0, 200)
    const color = (wp.period_color as string | null) ?? null
    const csid  = wp.costgroup?.short_identifier ?? null
    const templateId = templateIdByKey.get(templateKey(name, color, csid)) ?? null

    const staffUid = wp.staff ? String(wp.staff) : null
    if (staffUid) staffUidSet.add(staffUid)

    const breaksSeconds = (wp.breaks ?? []).reduce((s: number, br: any) => {
      if (!br.start || !br.stop) return s
      return s + Math.max(0, (new Date(br.stop).getTime() - new Date(br.start).getTime()) / 1000)
    }, 0)
    const obHours = (wp.additional_salaries ?? []).reduce((s: number, ob: any) =>
      s + (ob.duration ? ob.duration / 3600 : 0), 0)

    shiftRows.push({
      org_id: orgId, business_id: businessId,
      pk_work_period_url: String(wp.url),
      pk_staff_url:       wp.staff ?? null,
      pk_period_url:      wp.period ?? null,
      staff_uid:          staffUid,
      shift_template_id:  templateId,
      shift_date:         wp.date,
      start_at:           wp.start,
      end_at:             wp.end,
      start_time_local:   wp.start_time ?? null,
      end_time_local:     wp.end_time ?? null,
      staff_name:         wp.staff_name ?? null,
      period_name:        name,
      description:        wp.description ?? null,
      estimated_cost:     wp.estimated_cost != null ? Number(wp.estimated_cost) : null,
      // shift_kind heuristic: PK marks vacation as Semester somewhere in
      // the data — typically period_name contains "Semester" or
      // description matches. Refine once we see real data.
      shift_kind:         /semester/i.test(name) || /semester/i.test(wp.description ?? '') ? 'semester' :
                          /sjuk/i.test(name)     || /sjuk/i.test(wp.description ?? '')     ? 'sick' :
                          'regular',
      breaks_seconds:     Math.round(breaksSeconds),
      break_rule_name:        wp.break_rule ?? null,
      break_rule_description: wp.break_rule_description ?? null,
      has_ob:             (wp.additional_salaries ?? []).length > 0,
      ob_hours:           Math.round(obHours * 10) / 10,
      is_published:       wp.is_published ?? false,
      is_read_only:       wp.is_read_only ?? false,
      source:             'pk_sync',
      raw_data:           wp,
      last_synced_at:     new Date().toISOString(),
    })
  }
  result.staff_seen = staffUidSet.size

  // Bulk upsert in chunks of 500.
  for (let i = 0; i < shiftRows.length; i += 500) {
    const slice = shiftRows.slice(i, i + 500)
    const { error } = await db
      .from('staff_shifts')
      .upsert(slice, { onConflict: 'business_id,pk_work_period_url' })
    if (error) {
      result.errors.push(`shift upsert chunk ${i}: ${error.message}`)
      break
    }
    result.shifts_upserted += slice.length
  }

  // ── 3. Refresh staff_profiles — derive metadata from PK staff list
  //       + 12-week shift history. Cheap to do every sync.
  try {
    await refreshStaffProfiles(db, orgId, businessId, token)
  } catch (e: any) {
    result.errors.push(`profile refresh: ${e?.message ?? e}`)
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────
// Staff profile derivation
//
// Pulls /staffs/?with_employments=true for contract/cost facts, then
// walks staff_shifts for the last 12 weeks to derive typical_days,
// primary_section, versatility, etc. Idempotent — upserts the rolled
// numbers into staff_profiles.

async function refreshStaffProfiles(
  db:         SupabaseClient,
  orgId:      string,
  businessId: string,
  token:      string,
): Promise<void> {
  // 1. Pull current staff payload from PK
  const r = await fetch(`${PK_BASE}/staffs/?with_employments=true`, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  })
  if (!r.ok) throw new Error(`PK /staffs/ HTTP ${r.status}`)
  const pkStaff: any[] = []
  let next: string | null = `${PK_BASE}/staffs/?with_employments=true`
  let pages = 0
  while (next) {
    const rr = await fetch(next, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } })
    if (!rr.ok) break
    const j: any = await rr.json()
    if (Array.isArray(j?.results)) pkStaff.push(...j.results)
    next = j?.next ?? null
    pages++
    if (pages > 20) break
  }

  if (pkStaff.length === 0) return

  // 2. Load the last 12 weeks of shifts for derived stats
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - 12 * 7)
  const { data: shifts } = await db
    .from('staff_shifts')
    .select('staff_uid, shift_date, period_name, shift_template_id, shift_kind, is_published, start_at, end_at')
    .eq('business_id', businessId)
    .gte('shift_date', cutoff.toISOString().slice(0, 10))
  const { data: templates } = await db
    .from('staff_shift_templates')
    .select('id, section')
    .eq('business_id', businessId)
    .is('archived_at', null)
  const templateSectionById = new Map((templates ?? []).map((t: any) => [t.id, t.section ?? 'other']))

  // Aggregate per staff
  const statsByStaff = new Map<string, {
    daysWorked: Map<string, number>      // 'mon'..'sun' → count of weeks worked that day
    sections:   Map<string, number>      // section → shift count
    earliestStart: Map<string, number>   // hour → count (for opener/closer classification)
    latestEnd:     Map<string, number>
    totalShifts:   number
    weeksObserved: Set<string>           // for normalising typical_days
  }>()
  const DOW = ['sun','mon','tue','wed','thu','fri','sat']
  for (const s of (shifts ?? [])) {
    if (!s.staff_uid) continue
    if (s.shift_kind === 'semester' || s.shift_kind === 'sick') continue
    if (!statsByStaff.has(s.staff_uid)) {
      statsByStaff.set(s.staff_uid, {
        daysWorked:   new Map(),
        sections:     new Map(),
        earliestStart: new Map(),
        latestEnd:     new Map(),
        totalShifts:   0,
        weeksObserved: new Set(),
      })
    }
    const st = statsByStaff.get(s.staff_uid)!
    const d = new Date(s.shift_date + 'T00:00:00Z')
    const dow = DOW[d.getUTCDay()]
    st.daysWorked.set(dow, (st.daysWorked.get(dow) ?? 0) + 1)
    const sec = templateSectionById.get(s.shift_template_id) ?? 'other'
    st.sections.set(sec, (st.sections.get(sec) ?? 0) + 1)
    const startHour = new Date(s.start_at).getUTCHours()
    const endHour   = new Date(s.end_at).getUTCHours()
    st.earliestStart.set(String(startHour), (st.earliestStart.get(String(startHour)) ?? 0) + 1)
    st.latestEnd.set(String(endHour), (st.latestEnd.get(String(endHour)) ?? 0) + 1)
    st.totalShifts++
    // ISO week key
    const w = isoWeekFor(d)
    st.weeksObserved.add(w)
  }

  // 3. Build upsert rows
  const today = new Date().toISOString().slice(0, 10)
  const profileRows: any[] = []
  for (const s of pkStaff) {
    const staffUid = String(s.url ?? s.id ?? '')
    if (!staffUid) continue
    const activeEmp = (s.employments ?? []).find((e: any) =>
      (!e.end || e.end >= today) && (!e.start || e.start <= today),
    ) ?? null
    const st = statsByStaff.get(staffUid)
    let primarySection: string | null = null
    let typicalDays: Record<string, number> | null = null
    let versatilityScore: number | null = null
    let typicalShiftWindow: string | null = null
    if (st && st.totalShifts > 0) {
      const sortedSecs = Array.from(st.sections.entries()).sort((a, b) => b[1] - a[1])
      primarySection = sortedSecs[0]?.[0] ?? null
      versatilityScore = Math.min(1, sortedSecs.length / 4)
      const weeks = Math.max(1, st.weeksObserved.size)
      typicalDays = {}
      for (const dow of DOW.slice(1).concat(['sun'])) {
        typicalDays[dow] = Math.round(((st.daysWorked.get(dow) ?? 0) / weeks) * 100) / 100
      }
      // Opener/midday/closer based on modal start hour
      const modalStart = Array.from(st.earliestStart.entries()).sort((a, b) => b[1] - a[1])[0]
      if (modalStart) {
        const h = Number(modalStart[0])
        typicalShiftWindow = h < 9 ? 'opener' : h < 14 ? 'midday' : h < 17 ? 'split' : 'closer'
      }
    }

    profileRows.push({
      org_id: orgId, business_id: businessId,
      pk_staff_url: staffUid,
      staff_uid: staffUid,
      display_name:  `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || null,
      full_name:     `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || null,
      email:         s.email ?? null,
      salary_type:        activeEmp?.salary_type ?? null,
      hourly_rate_sek:    activeEmp?.hourly_salary ? Number(activeEmp.hourly_salary) : null,
      monthly_salary_sek: activeEmp?.monthly_salary ? Number(activeEmp.monthly_salary) : null,
      fixed_cost_per_day_sek: activeEmp?.fixed_cost_per_day ? Number(activeEmp.fixed_cost_per_day) : null,
      // PK returns service_grade as percentage already ('100.00' = full-time).
      // Don't multiply by 100 — that overflows NUMERIC(5,2).
      service_grade_pct:  activeEmp?.service_grade ? Number(activeEmp.service_grade) : null,
      hired_at:           activeEmp?.start ?? null,
      contract_end_at:    activeEmp?.end ?? null,
      primary_section:    primarySection,
      typical_days:       typicalDays,
      typical_shift_window: typicalShiftWindow,
      versatility_score:  versatilityScore,
      is_active:          s.confirmed ?? true,
      last_refreshed_at:  new Date().toISOString(),
    })
  }

  // Upsert
  if (profileRows.length > 0) {
    const { error } = await db
      .from('staff_profiles')
      .upsert(profileRows, { onConflict: 'business_id,pk_staff_url' })
    if (error) throw new Error(`profile upsert: ${error.message}`)
  }
}

function isoWeekFor(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dn = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - dn + 3)
  const ft = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const wn = 1 + Math.round(((t.getTime() - ft.getTime()) / 86400000 - 3 + ((ft.getUTCDay() + 6) % 7)) / 7)
  return `${t.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`
}
