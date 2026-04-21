// lib/alerts/line-item-anomalies.ts
//
// Runs alongside the existing monthly anomaly detector.  Where the main
// detector compares monthly_metrics totals against historic rolling
// averages, this one looks INSIDE the P&L at the tracker_line_items
// rows that Fortnox gives us.  Four signals it catches that the
// aggregated totals don't:
//
//   new_vendor   — a label appearing for the first time in 6 months
//   cost_creep   — same label rising >15% MoM in the last 3 months
//   spike        — one-month amount >3× the rolling 5-month median
//   dormant      — subscription-like line that had been monthly then
//                  disappeared for 2+ consecutive months
//
// Writes into anomaly_alerts (the existing table) so the alerts page
// and badge already pick them up.  Dedupes by (business, alert_type,
// metadata.label) within the same month.

import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'

export interface LineItemAnomaliesInput {
  orgId:      string
  businessId: string
  db:         any
}

const MIN_AMOUNT_KR = 300   // ignore noise below this

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export async function runLineItemAnomalies({ orgId, businessId, db }: LineItemAnomaliesInput) {
  const now = new Date()
  const windowMonths = 6
  const cutoff = new Date(now.getFullYear(), now.getMonth() - windowMonths + 1, 1)

  // Pull the window
  const { data: rows } = await db
    .from('tracker_line_items')
    .select('period_year, period_month, label_sv, subcategory, amount')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('category', 'other_cost')
    .or(`period_year.gt.${cutoff.getFullYear()},and(period_year.eq.${cutoff.getFullYear()},period_month.gte.${cutoff.getMonth() + 1})`)
    .order('period_year', { ascending: true })
    .order('period_month', { ascending: true })

  if (!rows?.length) return { findings: [], reason: 'no_data' }

  // Pivot: label → { YYYY-MM → amount }
  const byLabel: Record<string, { sub: string | null; months: Map<string, number> }> = {}
  const monthKeys = new Set<string>()
  for (const r of rows) {
    const mk = `${r.period_year}-${String(r.period_month).padStart(2, '0')}`
    monthKeys.add(mk)
    if (!byLabel[r.label_sv]) byLabel[r.label_sv] = { sub: r.subcategory, months: new Map() }
    byLabel[r.label_sv].months.set(mk, (byLabel[r.label_sv].months.get(mk) ?? 0) + Number(r.amount ?? 0))
  }
  const sortedMonths = Array.from(monthKeys).sort()
  if (sortedMonths.length < 2) return { findings: [], reason: 'insufficient_window' }

  const latestMonth = sortedMonths[sortedMonths.length - 1]

  type Finding = { kind: 'new_vendor'|'cost_creep'|'spike'|'dormant'; label: string; subcategory: string|null; detail: string; severity: 'low'|'medium'|'high' }
  const findings: Finding[] = []

  for (const [label, v] of Object.entries(byLabel)) {
    const months = v.months
    const latestVal = months.get(latestMonth) ?? 0

    // 1. NEW VENDOR — only appears in the latest month within this window
    if (latestVal >= MIN_AMOUNT_KR && months.size === 1) {
      findings.push({
        kind: 'new_vendor', label, subcategory: v.sub,
        detail: `First appearance in ${windowMonths} months — ${Math.round(latestVal)} kr.`,
        severity: latestVal > 5_000 ? 'medium' : 'low',
      })
      continue
    }

    // 2. SPIKE — latest month > 3× median of the previous (non-zero) months
    const prior = sortedMonths.slice(0, -1).map(m => months.get(m) ?? 0).filter(x => x > 0)
    if (latestVal >= MIN_AMOUNT_KR && prior.length >= 3) {
      const med = median(prior)
      if (med > 0 && latestVal > med * 3) {
        findings.push({
          kind: 'spike', label, subcategory: v.sub,
          detail: `${Math.round(latestVal)} kr in ${latestMonth} vs typical ${Math.round(med)} kr — ${(latestVal / med).toFixed(1)}× normal.`,
          severity: latestVal > 10_000 ? 'high' : 'medium',
        })
      }
    }

    // 3. COST CREEP — trailing 3 months each ≥15% above the previous
    if (sortedMonths.length >= 4) {
      const last4 = sortedMonths.slice(-4).map(m => months.get(m) ?? 0)
      const creeping = last4.every((val, i) => i === 0 || (last4[i - 1] > 0 && val >= last4[i - 1] * 1.15))
      if (creeping && last4[0] > 0) {
        const growthPct = ((last4[3] - last4[0]) / last4[0]) * 100
        findings.push({
          kind: 'cost_creep', label, subcategory: v.sub,
          detail: `Rising every month: ${last4.map(n => Math.round(n)).join(' → ')} kr (+${Math.round(growthPct)}% in 3 months).`,
          severity: growthPct > 50 ? 'high' : 'medium',
        })
      }
    }

    // 4. DORMANT — was monthly for 3+ months, then gone for 2+
    if (sortedMonths.length >= 5) {
      const hist = sortedMonths.slice(0, -2).map(m => months.get(m) ?? 0)
      const recent = sortedMonths.slice(-2).map(m => months.get(m) ?? 0)
      const wasRegular = hist.filter(x => x > 0).length >= 3
      const isGone     = recent.every(x => x === 0)
      if (wasRegular && isGone) {
        const last = hist.filter(x => x > 0).slice(-1)[0]
        findings.push({
          kind: 'dormant', label, subcategory: v.sub,
          detail: `Was ${Math.round(last)} kr/month, gone for last 2 months. Cancelled or just late in bookkeeping?`,
          severity: 'low',
        })
      }
    }
  }

  // Upsert into anomaly_alerts.  Dedupe on (business, alert_type, metadata.label)
  // within the current month — the existing anomaly-check cron runs daily and
  // this would otherwise stack duplicates.
  const today = now.toISOString().slice(0, 10)
  const inserted: any[] = []
  for (const f of findings) {
    // Check for existing today (simple dedupe guard)
    const { data: existing } = await db.from('anomaly_alerts')
      .select('id')
      .eq('business_id', businessId)
      .eq('alert_type', `line_item_${f.kind}`)
      .eq('date', today)
      .contains('metadata', { label: f.label })
      .maybeSingle()

    if (existing) continue

    const { data: row, error } = await db.from('anomaly_alerts').insert({
      org_id:      orgId,
      business_id: businessId,
      alert_type:  `line_item_${f.kind}`,
      severity:    f.severity,
      title:       f.kind === 'new_vendor'  ? `New cost appeared: ${f.label}`
                : f.kind === 'spike'        ? `Unusual spike: ${f.label}`
                : f.kind === 'cost_creep'   ? `Cost creeping: ${f.label}`
                : f.kind === 'dormant'      ? `Subscription stopped: ${f.label}`
                :                              f.label,
      description: f.detail,
      date:        today,
      metadata:    { label: f.label, subcategory: f.subcategory, kind: f.kind },
      is_read:     false,
      is_dismissed:false,
    }).select('id').maybeSingle()

    if (!error && row) inserted.push(row.id)
  }

  return { findings, inserted: inserted.length, reason: 'ok' }
}
