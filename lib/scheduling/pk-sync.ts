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

  return result
}
