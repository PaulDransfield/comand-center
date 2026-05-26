// lib/reports/builders.ts
//
// One builder per report type → a generic ReportSpec (lib/reports/types.ts).
// Every figure is pulled from persisted data; the AI writes only the
// narrative + recommendations (lib/reports/ai-narrative.ts), grounded in
// those figures. Add a report type = add a builder here; renderers unchanged.

import type { ReportSpec, ReportTableRow } from '@/lib/reports/types'
import { kr, marginTone } from '@/lib/reports/types'
import { loadMarginMonths, type MarginMonth } from '@/lib/reports/margin-report'
import { generateReportNarrative } from '@/lib/reports/ai-narrative'

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const round1 = (n: number) => Math.round(n * 10) / 10
const avgOf = (arr: number[]) => (arr.length ? round1(arr.reduce((a, b) => a + b, 0) / arr.length) : 0)

export type ReportType = 'margin' | 'cost' | 'supplier'
export const REPORT_TYPES: ReportType[] = ['margin', 'cost', 'supplier']
export const REPORT_TITLES: Record<ReportType, string> = {
  margin:   'Margin Report',
  cost:     'Cost Breakdown',
  supplier: 'Supplier Spend Report',
}

export async function buildReportSpec(db: any, type: ReportType, businessId: string, businessName: string): Promise<ReportSpec> {
  if (type === 'cost')     return buildCostSpec(db, businessId, businessName)
  if (type === 'supplier') return buildSupplierSpec(db, businessId, businessName)
  return buildMarginSpec(db, businessId, businessName)
}

// ── MARGIN ────────────────────────────────────────────────────────────────
async function buildMarginSpec(db: any, businessId: string, businessName: string): Promise<ReportSpec> {
  const months = await loadMarginMonths(db, businessId)
  const clean  = months.filter(m => m.revenue > 0 && !m.is_anomaly)
  const anomalyCount = months.filter(m => m.is_anomaly).length

  // Headline = the MOST RECENT up-to-3 clean months ("current" margins), not
  // the full-period mean — so data-gap / seasonal-low customers don't show a
  // scary average. Full table + AI still see everything.
  const recent = clean.slice(-3)
  const head   = recent.length ? recent : clean.length ? clean : months
  const headLabel = recent.length >= 2 ? `last ${recent.length} mo` : 'recent'
  const kHead = {
    margin: avgOf(head.map(m => m.margin_pct)),
    food:   avgOf(head.map(m => m.food_pct)),
    labour: avgOf(head.map(m => m.labour_pct)),
    rev:    head.length ? Math.round(head.reduce((s, m) => s + m.revenue, 0) / head.length) : 0,
  }

  const rows: ReportTableRow[] = months.map(m => ({
    cells: { month: `${m.label}${m.is_anomaly ? '  *' : ''}`, revenue: kr(m.revenue), food: `${m.food_pct}%`, labour: `${m.labour_pct}%`, margin: `${m.margin_pct}%` },
    muted: m.is_anomaly,
    toneByKey: m.is_anomaly ? undefined : { margin: marginTone(m.margin_pct) },
  }))

  const dataBlock = `Headline (most recent ${head.length} clean months): net margin ${kHead.margin}%, food ${kHead.food}%, labour ${kHead.labour}%, ~${kHead.rev} kr/month.\nFull period (${months.length} months):\n` +
    months.map(m => `${m.label}: revenue ${Math.round(m.revenue)} kr, food ${m.food_pct}%, labour ${m.labour_pct}%, net margin ${m.margin_pct}%${m.is_anomaly ? '  [DATA ANOMALY — flag, do not treat as real]' : ''}`).join('\n')
  const ai = months.length ? await generateReportNarrative({ reportKind: 'margin report', businessName, dataBlock,
    guidance: '- Benchmarks: food cost 28–32% of sales; healthy net margin ~10–15%.\n- Note that the headline reflects the most RECENT clean months; comment on the trend and what drives the best months.' }) : null

  return {
    type: 'margin', title: REPORT_TITLES.margin, business_name: businessName,
    period_label: months.length ? `${months[0].label} – ${months[months.length - 1].label}` : 'No closed periods yet',
    generated_at: new Date().toISOString(),
    kpis: [
      { label: `Net margin (${headLabel})`, value: `${kHead.margin}%`, tone: marginTone(kHead.margin) },
      { label: 'Food cost',  value: `${kHead.food}%` },
      { label: 'Labour',     value: `${kHead.labour}%` },
      { label: 'Revenue / mo', value: kr(kHead.rev) },
    ],
    summary: ai?.summary ?? (months.length ? `Most recent ${head.length} clean months averaged a ${kHead.margin}% net margin on ~${kr(kHead.rev)} monthly revenue (food ${kHead.food}%, labour ${kHead.labour}%).` : `No closed-month financials yet for ${businessName}.`),
    table: months.length ? {
      heading: 'Monthly margin trend',
      columns: [ { key: 'month', label: 'Month' }, { key: 'revenue', label: 'Revenue', align: 'right' }, { key: 'food', label: 'Food %', align: 'right' }, { key: 'labour', label: 'Labour %', align: 'right' }, { key: 'margin', label: 'Net margin', align: 'right' } ],
      rows,
      note: anomalyCount > 0 ? `* ${anomalyCount} month(s) flagged as a data anomaly and excluded from the headline — worth reviewing in Fortnox.` : undefined,
    } : undefined,
    recommendations: ai?.recommendations ?? fallbackMargin(kHead),
    footnote: 'Figures sourced from your Fortnox financial data.',
    ai_used: !!ai,
  }
}

function fallbackMargin(k: { margin: number; food: number; labour: number }) {
  const r: Array<{ title: string; detail: string }> = []
  if (k.food > 32) r.push({ title: 'Bring food cost toward 28–32%', detail: `Food is ${k.food}% of sales, above target. Review supplier pricing, portioning, and waste.` })
  if (k.labour > 30) r.push({ title: 'Tighten labour scheduling', detail: `Labour is ${k.labour}% of sales. Trim hours on the lowest-revenue dayparts.` })
  r.push({ title: 'Repeat your best months', detail: 'Identify what drove the strongest-margin months and standardise it.' })
  return r
}

// ── COST BREAKDOWN ──────────────────────────────────────────────────────────
async function buildCostSpec(db: any, businessId: string, businessName: string): Promise<ReportSpec> {
  const months = await loadMarginMonths(db, businessId)
  const clean  = months.filter(m => m.revenue > 0 && !m.is_anomaly)
  const otherPct = (m: MarginMonth) => (m.revenue > 0 ? round1((m.other_cost / m.revenue) * 100) : 0)

  const k = {
    food:   avgOf(clean.map(m => m.food_pct)),
    labour: avgOf(clean.map(m => m.labour_pct)),
    other:  avgOf(clean.map(otherPct)),
  }
  const totalCostPct = round1(k.food + k.labour + k.other)

  const rows: ReportTableRow[] = months.map(m => ({
    cells: { month: `${m.label}${m.is_anomaly ? '  *' : ''}`, food: kr(m.food_cost), labour: kr(m.staff_cost), other: kr(m.other_cost), total: kr(m.food_cost + m.staff_cost + m.other_cost) },
    muted: m.is_anomaly,
  }))

  const dataBlock = `Average cost shares (clean months): food ${k.food}%, labour ${k.labour}%, overhead ${k.other}%, total cost ${totalCostPct}% of sales.\nMonthly:\n` +
    months.map(m => `${m.label}: food ${kr(m.food_cost)} (${m.food_pct}%), labour ${kr(m.staff_cost)} (${m.labour_pct}%), overhead ${kr(m.other_cost)} (${otherPct(m)}%)${m.is_anomaly ? '  [ANOMALY]' : ''}`).join('\n')
  const ai = months.length ? await generateReportNarrative({ reportKind: 'cost breakdown', businessName, dataBlock,
    guidance: '- Benchmarks: food 28–32%, labour ~30%, total prime cost (food+labour) ideally <60% of sales.\n- Identify which cost line is the biggest lever and how it moves with revenue.' }) : null

  return {
    type: 'cost', title: REPORT_TITLES.cost, business_name: businessName,
    period_label: months.length ? `${months[0].label} – ${months[months.length - 1].label}` : 'No closed periods yet',
    generated_at: new Date().toISOString(),
    kpis: [
      { label: 'Food cost',     value: `${k.food}%` },
      { label: 'Labour',        value: `${k.labour}%` },
      { label: 'Overhead',      value: `${k.other}%` },
      { label: 'Total / sales', value: `${totalCostPct}%`, tone: totalCostPct > 90 ? 'bad' : totalCostPct > 80 ? 'neutral' : 'good' },
    ],
    summary: ai?.summary ?? (months.length ? `Costs average ${totalCostPct}% of sales (food ${k.food}%, labour ${k.labour}%, overhead ${k.other}%).` : `No closed-month costs yet for ${businessName}.`),
    table: months.length ? {
      heading: 'Monthly cost breakdown',
      columns: [ { key: 'month', label: 'Month' }, { key: 'food', label: 'Food', align: 'right' }, { key: 'labour', label: 'Labour', align: 'right' }, { key: 'other', label: 'Overhead', align: 'right' }, { key: 'total', label: 'Total cost', align: 'right' } ],
      rows,
    } : undefined,
    recommendations: ai?.recommendations ?? [{ title: 'Target prime cost', detail: `Food + labour is ${round1(k.food + k.labour)}% of sales; aim below 60%.` }],
    footnote: 'Figures sourced from your Fortnox financial data.',
    ai_used: !!ai,
  }
}

// ── SUPPLIER SPEND ───────────────────────────────────────────────────────────
async function buildSupplierSpec(db: any, businessId: string, businessName: string): Promise<ReportSpec> {
  const fromIso = new Date(Date.now() - 6 * 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  // Paginate past the 1000-row cap (feedback_supabase_max_rows).
  const byName = new Map<string, { spend: number; invoices: Set<string> }>()
  for (let from = 0; from < 50_000; from += 1000) {
    const { data } = await db.from('supplier_invoice_lines')
      .select('supplier_name_snapshot, supplier_fortnox_number, total_excl_vat, fortnox_invoice_number, invoice_date')
      .eq('business_id', businessId).gte('invoice_date', fromIso).range(from, from + 999)
    const rows = data ?? []
    for (const r of rows) {
      const name = (r.supplier_name_snapshot ?? r.supplier_fortnox_number ?? 'Unknown').toString().trim() || 'Unknown'
      if (!byName.has(name)) byName.set(name, { spend: 0, invoices: new Set() })
      const e = byName.get(name)!
      e.spend += Number(r.total_excl_vat ?? 0)
      if (r.fortnox_invoice_number) e.invoices.add(String(r.fortnox_invoice_number))
    }
    if (rows.length < 1000) break
  }

  const suppliers = Array.from(byName.entries())
    .map(([name, e]) => ({ name, spend: e.spend, invoices: e.invoices.size }))
    .filter(s => s.spend > 0)
    .sort((a, b) => b.spend - a.spend)
  const totalSpend = suppliers.reduce((s, x) => s + x.spend, 0)
  const top = suppliers.slice(0, 15)

  const rows: ReportTableRow[] = top.map(s => ({
    cells: { supplier: s.name.slice(0, 40), invoices: String(s.invoices), spend: kr(s.spend), share: totalSpend > 0 ? `${round1((s.spend / totalSpend) * 100)}%` : '0%' },
  }))

  const dataBlock = `Total supplier spend (last 6 months): ${kr(totalSpend)} across ${suppliers.length} suppliers.\nTop suppliers:\n` +
    top.map(s => `${s.name}: ${kr(s.spend)} (${totalSpend > 0 ? round1((s.spend / totalSpend) * 100) : 0}% of spend, ${s.invoices} invoices)`).join('\n')
  const ai = suppliers.length ? await generateReportNarrative({ reportKind: 'supplier spend report', businessName, dataBlock,
    guidance: '- Look for spend concentration (a few suppliers dominating), consolidation opportunities, and where to negotiate given volume.\n- Do NOT claim per-item price changes you cannot see — only spend totals are provided.' }) : null

  const topShare = totalSpend > 0 && top.length ? round1((top[0].spend / totalSpend) * 100) : 0
  return {
    type: 'supplier', title: REPORT_TITLES.supplier, business_name: businessName,
    period_label: 'Last 6 months',
    generated_at: new Date().toISOString(),
    kpis: [
      { label: 'Total spend', value: kr(totalSpend) },
      { label: 'Suppliers',   value: String(suppliers.length) },
      { label: 'Top supplier', value: `${topShare}%`, tone: topShare > 40 ? 'bad' : 'neutral' },
      { label: 'Top 5 share', value: totalSpend > 0 ? `${round1((suppliers.slice(0, 5).reduce((s, x) => s + x.spend, 0) / totalSpend) * 100)}%` : '0%' },
    ],
    summary: ai?.summary ?? (suppliers.length ? `${kr(totalSpend)} spent across ${suppliers.length} suppliers in the last 6 months; the top supplier is ${topShare}% of spend.` : `No supplier invoices in the last 6 months for ${businessName}.`),
    table: suppliers.length ? {
      heading: 'Top suppliers by spend (last 6 months)',
      columns: [ { key: 'supplier', label: 'Supplier' }, { key: 'invoices', label: 'Invoices', align: 'right' }, { key: 'spend', label: 'Spend', align: 'right' }, { key: 'share', label: 'Share', align: 'right' } ],
      rows,
    } : undefined,
    recommendations: ai?.recommendations ?? [{ title: 'Review supplier concentration', detail: `Your top supplier is ${topShare}% of spend — worth confirming you have competitive terms.` }],
    footnote: 'Spend totals from your Fortnox supplier invoices (last 6 months).',
    ai_used: !!ai,
  }
}
