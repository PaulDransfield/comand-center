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

export type ReportType = 'margin' | 'cost' | 'supplier' | 'top-products'
export const REPORT_TYPES: ReportType[] = ['margin', 'cost', 'supplier', 'top-products']
export const REPORT_TITLES: Record<ReportType, string> = {
  margin:         'Margin Report',
  cost:           'Cost Breakdown',
  supplier:       'Supplier Spend Report',
  'top-products': 'Top Products Report',
}

export interface ReportParams {
  supplier_filter?: string | null
  date_from?:       string | null   // ISO YYYY-MM-DD
  date_to?:         string | null
  rank_by?:         'spend' | 'quantity' | 'invoice_count'
  limit?:           number
}

export async function buildReportSpec(db: any, type: ReportType, businessId: string, businessName: string, params: ReportParams = {}): Promise<ReportSpec> {
  if (type === 'cost')          return buildCostSpec(db, businessId, businessName)
  if (type === 'supplier')      return buildSupplierSpec(db, businessId, businessName)
  if (type === 'top-products')  return buildTopProductsSpec(db, businessId, businessName, params)
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

// ── TOP PRODUCTS ────────────────────────────────────────────────────────────
async function buildTopProductsSpec(db: any, businessId: string, businessName: string, params: ReportParams): Promise<ReportSpec> {
  const supplierFilter = params.supplier_filter ? params.supplier_filter.trim().toLowerCase() : null
  const dateFrom       = params.date_from ?? null
  const dateTo         = params.date_to   ?? null
  const rankBy         = params.rank_by ?? 'spend'
  const limit          = Math.min(100, Math.max(1, params.limit ?? 20))

  // Paginate past the 1000-row cap (feedback_supabase_max_rows).
  type Row = {
    product_alias_id: string | null
    supplier_name_snapshot: string | null
    supplier_fortnox_number: string | null
    quantity: any
    total_excl_vat: any
    price_per_unit: any
    invoice_date: string | null
    fortnox_invoice_number: string | null
  }
  const allLines: Row[] = []
  for (let from = 0; from < 50_000; from += 1000) {
    let q = db.from('supplier_invoice_lines')
      .select('product_alias_id, supplier_name_snapshot, supplier_fortnox_number, quantity, total_excl_vat, price_per_unit, invoice_date, fortnox_invoice_number')
      .eq('business_id', businessId).not('product_alias_id', 'is', null)
    if (supplierFilter) q = q.ilike('supplier_name_snapshot', `%${supplierFilter}%`)
    if (dateFrom)       q = q.gte('invoice_date', dateFrom)
    if (dateTo)         q = q.lte('invoice_date', dateTo)
    const { data } = await q.range(from, from + 999)
    allLines.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }

  if (allLines.length === 0) {
    return {
      type: 'top-products' as any, title: REPORT_TITLES['top-products'], business_name: businessName,
      period_label: filterLabel(supplierFilter, dateFrom, dateTo),
      generated_at: new Date().toISOString(),
      kpis: [],
      summary: `No matched supplier invoice lines for the given filters (${filterLabel(supplierFilter, dateFrom, dateTo)}).`,
      recommendations: [],
      footnote: 'Only matched invoice lines counted. Unmatched / rebate / fee lines excluded.',
      ai_used: false,
    }
  }

  // Resolve alias → product → product details.
  const aliasIds = Array.from(new Set(allLines.map(l => l.product_alias_id).filter(Boolean) as string[]))
  const aliasToProduct = new Map<string, string>()
  for (let i = 0; i < aliasIds.length; i += 100) {
    const slice = aliasIds.slice(i, i + 100)
    const { data: aRows } = await db.from('product_aliases').select('id, product_id').in('id', slice)
    for (const a of aRows ?? []) aliasToProduct.set((a as any).id, (a as any).product_id)
  }
  const productIds = Array.from(new Set(Array.from(aliasToProduct.values())))
  const productById = new Map<string, any>()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data: pRows } = await db.from('products').select('id, name, category, default_supplier_name').in('id', slice)
    for (const p of pRows ?? []) productById.set((p as any).id, p)
  }

  type Agg = { name: string; category: string | null; supplier: string | null; total_spend: number; total_quantity: number; line_count: number; invoice_numbers: Set<string>; last_date: string | null }
  const agg = new Map<string, Agg>()
  let totalLinesSpend = 0
  for (const l of allLines) {
    const pid = l.product_alias_id ? aliasToProduct.get(l.product_alias_id) : null
    if (!pid) continue
    const prod = productById.get(pid)
    if (!prod) continue
    let row = agg.get(pid)
    if (!row) row = { name: prod.name, category: prod.category, supplier: prod.default_supplier_name ?? l.supplier_name_snapshot ?? null,
                      total_spend: 0, total_quantity: 0, line_count: 0, invoice_numbers: new Set(), last_date: null }
    const spend = l.total_excl_vat != null ? Number(l.total_excl_vat)
                : (l.price_per_unit != null && l.quantity != null) ? Number(l.price_per_unit) * Number(l.quantity)
                : 0
    if (Number.isFinite(spend)) { row.total_spend += spend; totalLinesSpend += spend }
    row.total_quantity += l.quantity != null ? Number(l.quantity) : 0
    row.line_count     += 1
    if (l.fortnox_invoice_number) row.invoice_numbers.add(String(l.fortnox_invoice_number))
    if (l.invoice_date && (!row.last_date || l.invoice_date > row.last_date)) row.last_date = l.invoice_date
    agg.set(pid, row)
  }

  const ranked = Array.from(agg.values()).sort((a, b) => {
    if (rankBy === 'quantity')      return b.total_quantity - a.total_quantity
    if (rankBy === 'invoice_count') return b.invoice_numbers.size - a.invoice_numbers.size
    return b.total_spend - a.total_spend
  }).slice(0, limit)

  const tableRows: ReportTableRow[] = ranked.map((r, i) => ({
    cells: {
      rank:     String(i + 1),
      product:  r.name.slice(0, 50),
      supplier: (r.supplier ?? '—').slice(0, 30),
      qty:      Math.round(r.total_quantity * 100) / 100 + '',
      spend:    kr(r.total_spend),
      invoices: String(r.invoice_numbers.size),
      last:     r.last_date ?? '—',
    },
  }))

  const dataBlock = `Top ${ranked.length} products at ${businessName}${supplierFilter ? ` from supplier matching "${supplierFilter}"` : ''} ranked by ${rankBy}:\n` +
    ranked.map((r, i) => `${i + 1}. ${r.name} — spend ${kr(r.total_spend)}, qty ${Math.round(r.total_quantity)} ${r.line_count > 1 ? '(' + r.line_count + ' lines)' : ''}, ${r.invoice_numbers.size} invoice${r.invoice_numbers.size === 1 ? '' : 's'}, last ${r.last_date ?? '—'}`).join('\n')
  const ai = ranked.length ? await generateReportNarrative({ reportKind: 'top products report', businessName, dataBlock,
    guidance: '- Highlight any products dominating spend (single line >20% of the total in this list). - Call out concentration risk if 80% of spend is in the top 5. - Suggest negotiation leverage with the highest-volume items. - Do NOT invent prices, just describe the ranked data.' }) : null

  return {
    type: 'top-products' as any,
    title: REPORT_TITLES['top-products'],
    business_name: businessName,
    period_label: filterLabel(supplierFilter, dateFrom, dateTo),
    generated_at: new Date().toISOString(),
    kpis: [
      { label: 'Products ranked', value: String(ranked.length) },
      { label: 'Total spend',     value: kr(totalLinesSpend) },
      { label: 'Top 1 share',     value: totalLinesSpend > 0 && ranked[0] ? `${round1((ranked[0].total_spend / totalLinesSpend) * 100)}%` : '—' },
      { label: 'Rank by',         value: rankBy },
    ],
    summary: ai?.summary ?? `Top ${ranked.length} products by ${rankBy}${supplierFilter ? ` from suppliers matching "${supplierFilter}"` : ''}; total spend across these = ${kr(ranked.reduce((s, r) => s + r.total_spend, 0))}.`,
    table: {
      heading: `Top ${ranked.length} products by ${rankBy}${supplierFilter ? ` — ${supplierFilter}` : ''}`,
      columns: [
        { key: 'rank',     label: '#' },
        { key: 'product',  label: 'Product' },
        { key: 'supplier', label: 'Supplier' },
        { key: 'qty',      label: 'Qty',      align: 'right' },
        { key: 'spend',    label: 'Spend',    align: 'right' },
        { key: 'invoices', label: 'Invoices', align: 'right' },
        { key: 'last',     label: 'Last seen' },
      ],
      rows: tableRows,
    },
    recommendations: ai?.recommendations ?? [{ title: 'Negotiate on the leaders', detail: `${ranked[0]?.name ?? 'Your top product'} is the largest line item; volume gives leverage on price.` }],
    footnote: 'Only matched invoice lines counted. Unmatched / rebate / fee lines excluded.',
    ai_used: !!ai,
  }
}

function filterLabel(sup: string | null, from: string | null, to: string | null): string {
  const parts: string[] = []
  if (sup)  parts.push(`supplier: ${sup}`)
  if (from) parts.push(`from ${from}`)
  if (to)   parts.push(`to ${to}`)
  return parts.length ? parts.join(' · ') : 'All lines, all time'
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
