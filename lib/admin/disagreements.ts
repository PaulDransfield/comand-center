// lib/admin/disagreements.ts
//
// Shared lookup for "data-source disagreements" — periods where the
// aggregator had to pick between two sources (PK / Fortnox / POS) that
// reported materially different numbers. Used by:
//
//   - /api/admin/data-disagreements   (on-demand view for /admin/v2)
//   - /api/cron/data-source-disagreements-alert (daily ops email)
//
// One source of truth for the classification keeps the email + the UI in
// sync as new sources land (Caspeco etc).

export type DisagreementCategory =
  | 'critical'    // PK and Fortnox materially disagree (> 30 % gap on staff)
  | 'warning'     // partial-coverage scenarios

export type DisagreementKind =
  | 'staff_pk_vs_fortnox_disagrees'      // critical
  | 'staff_pk_partial_with_fortnox'      // warning — Fortnox used, PK was mid-period
  | 'staff_pk_only_partial'              // warning — PK used as last resort
  | 'revenue_pos_partial'                // warning — POS covered <90 % of month

export interface Disagreement {
  org_id:        string
  org_name:      string | null
  business_id:   string
  business_name: string | null
  year:          number
  month:         number
  kind:          DisagreementKind
  category:      DisagreementCategory
  /** Human-readable summary suitable for the email body. */
  summary:       string
  /** Sources involved + their values, for the diff display. */
  detail: {
    chosen_source: string
    chosen_value:  number
    other_source?: string
    other_value?:  number
    ratio?:        number     // value / other_value where applicable
  }
  updated_at:    string       // monthly_metrics.updated_at
}

const COST_KIND_BY_SOURCE: Record<string, DisagreementKind> = {
  fortnox_pk_disagrees: 'staff_pk_vs_fortnox_disagrees',
  fortnox_pk_partial:   'staff_pk_partial_with_fortnox',
  pk_partial:           'staff_pk_only_partial',
}

const REV_KIND_BY_SOURCE: Record<string, DisagreementKind> = {
  pos_partial: 'revenue_pos_partial',
}

const CATEGORY: Record<DisagreementKind, DisagreementCategory> = {
  staff_pk_vs_fortnox_disagrees: 'critical',
  staff_pk_partial_with_fortnox: 'warning',
  staff_pk_only_partial:         'warning',
  revenue_pos_partial:           'warning',
}

interface FindOpts {
  /** Look back N days from now (using monthly_metrics.updated_at). */
  days?:        number
  /** Restrict to a single org. Omitted = all customers. */
  orgId?:       string
  /** When set, only return rows updated AFTER this ISO timestamp.
   *  Used by the daily cron to fire on NEW disagreements only. */
  since?:       string
}

interface FindResult {
  rows:       Disagreement[]
  byCategory: Record<DisagreementCategory, number>
}

export async function findDisagreements(db: any, opts: FindOpts = {}): Promise<FindResult> {
  const days   = opts.days ?? 30
  const cutoff = opts.since
    ? new Date(opts.since)
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Pull every monthly_metrics row whose source field matches a known
  // disagreement code. Using 'or' keeps it a single round-trip.
  let query = db
    .from('monthly_metrics')
    .select('org_id, business_id, year, month, revenue, staff_cost, rev_source, cost_source, updated_at')
    .gte('updated_at', cutoff.toISOString())
    .or(`cost_source.in.(${Object.keys(COST_KIND_BY_SOURCE).join(',')}),rev_source.in.(${Object.keys(REV_KIND_BY_SOURCE).join(',')})`)
    .order('updated_at', { ascending: false })
    .limit(500)
  if (opts.orgId) query = query.eq('org_id', opts.orgId)

  const { data: mmRows, error: mmErr } = await query
  if (mmErr) throw new Error(`monthly_metrics fetch failed: ${mmErr.message}`)

  const rowsRaw = mmRows ?? []
  if (!rowsRaw.length) {
    return { rows: [], byCategory: { critical: 0, warning: 0 } }
  }

  // Pull tracker_data for the SAME (business, year, month) combos so we
  // can include the comparison values in the email/UI. Single batched
  // query rather than N round-trips.
  const trackerRes = await db
    .from('tracker_data')
    .select('business_id, period_year, period_month, revenue, staff_cost')
    .in('business_id', [...new Set(rowsRaw.map((r: any) => r.business_id))])
  const trackerByKey = new Map<string, any>()
  for (const t of trackerRes.data ?? []) {
    trackerByKey.set(`${t.business_id}:${t.period_year}:${t.period_month}`, t)
  }

  // Resolve org + business names — small batches, single round-trip each.
  const orgIds = [...new Set(rowsRaw.map((r: any) => r.org_id))]
  const bizIds = [...new Set(rowsRaw.map((r: any) => r.business_id))]
  const [orgsRes, bizRes] = await Promise.all([
    db.from('organisations').select('id, name').in('id', orgIds),
    db.from('businesses').select('id, name').in('id', bizIds),
  ])
  const orgName = new Map<string, string>((orgsRes.data ?? []).map((o: any) => [o.id as string, o.name as string]))
  const bizName = new Map<string, string>((bizRes.data ?? []).map((b: any) => [b.id as string, b.name as string]))

  const rows: Disagreement[] = []
  for (const r of rowsRaw) {
    const tracker = trackerByKey.get(`${r.business_id}:${r.year}:${r.month}`)

    // Each row may have BOTH a cost-source disagreement AND a rev-source
    // one — emit a separate entry per kind for clarity in the digest.
    const kinds: DisagreementKind[] = []
    if (COST_KIND_BY_SOURCE[r.cost_source])  kinds.push(COST_KIND_BY_SOURCE[r.cost_source])
    if (REV_KIND_BY_SOURCE[r.rev_source])    kinds.push(REV_KIND_BY_SOURCE[r.rev_source])

    for (const kind of kinds) {
      const detail = buildDetail(kind, r, tracker)
      rows.push({
        org_id:        r.org_id,
        org_name:      orgName.get(r.org_id) ?? null,
        business_id:   r.business_id,
        business_name: bizName.get(r.business_id) ?? null,
        year:          r.year,
        month:         r.month,
        kind,
        category:      CATEGORY[kind],
        summary:       buildSummary(kind, r, tracker, bizName.get(r.business_id) ?? r.business_id),
        detail,
        updated_at:    r.updated_at,
      })
    }
  }

  const byCategory = rows.reduce((acc: Record<DisagreementCategory, number>, d) => {
    acc[d.category] = (acc[d.category] ?? 0) + 1
    return acc
  }, { critical: 0, warning: 0 })

  return { rows, byCategory }
}

function buildDetail(kind: DisagreementKind, r: any, tracker: any | undefined): Disagreement['detail'] {
  switch (kind) {
    case 'staff_pk_vs_fortnox_disagrees': {
      const ratio = tracker?.staff_cost > 0 ? r.staff_cost / Number(tracker.staff_cost) : undefined
      return {
        chosen_source: 'fortnox',
        chosen_value:  Number(tracker?.staff_cost ?? 0),
        other_source:  'pk',
        other_value:   r.staff_cost,
        ratio,
      }
    }
    case 'staff_pk_partial_with_fortnox':
      return {
        chosen_source: 'fortnox',
        chosen_value:  Number(tracker?.staff_cost ?? 0),
        other_source:  'pk_partial',
        other_value:   r.staff_cost,
      }
    case 'staff_pk_only_partial':
      return { chosen_source: 'pk_partial', chosen_value: r.staff_cost }
    case 'revenue_pos_partial':
      return { chosen_source: 'pos_partial', chosen_value: r.revenue }
  }
}

function buildSummary(kind: DisagreementKind, r: any, tracker: any | undefined, bizLabel: string): string {
  const period = `${r.year}-${String(r.month).padStart(2, '0')}`
  const fmt = (n: number) => Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
  switch (kind) {
    case 'staff_pk_vs_fortnox_disagrees': {
      const tStaff = Number(tracker?.staff_cost ?? 0)
      const ratio  = tStaff > 0 ? Math.round((r.staff_cost / tStaff) * 100) : 0
      return `${bizLabel} ${period}: PK staff ${fmt(r.staff_cost)} vs Fortnox ${fmt(tStaff)} (${ratio}%) — using Fortnox`
    }
    case 'staff_pk_partial_with_fortnox':
      return `${bizLabel} ${period}: PK staff partial coverage, using Fortnox ${fmt(Number(tracker?.staff_cost ?? 0))}`
    case 'staff_pk_only_partial':
      return `${bizLabel} ${period}: PK staff partial (no Fortnox to compare) ${fmt(r.staff_cost)}`
    case 'revenue_pos_partial':
      return `${bizLabel} ${period}: POS revenue partial coverage (${fmt(r.revenue)})`
  }
}
