// @ts-nocheck
// scripts/verification-report.ts
//
// Phase 1 Fortnox API verification harness — report generator.
//
// Reads verification_tracker_data + verification_tracker_line_items written
// by verification-runner.ts and compares them month-by-month against the
// production tracker_data (which came from PDF upload). Writes a single
// markdown report at FORTNOX-VERIFICATION-REPORT-2026-05-07.md.
//
// Drift classification (per the Phase 1 prompt):
//   - exact:      |API − PDF| < 0.01 SEK
//   - tolerable:  |API − PDF| < 1% AND < 100 SEK
//   - material:   anything else
//
// Material findings get a root-cause walk: which line items differ, by
// account number, label, and amount.
//
// Usage:
//   npx tsx scripts/verification-report.ts [run_id]
//
// If run_id is omitted, uses the most recent verification_runs row.

import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { resolve }       from 'node:path'

const VERO_ORG_ID = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'

interface PeriodKey {
  business_id: string
  period_year: number
  period_month: number
}

interface TrackerRow {
  business_id:      string
  period_year:      number
  period_month:     number
  revenue:          number
  dine_in_revenue:  number
  takeaway_revenue: number
  alcohol_revenue:  number
  food_cost:        number
  alcohol_cost:     number
  staff_cost:       number
  other_cost:       number
  net_profit:       number
  margin_pct:       number
  source?:          string
}

interface MetricDiff {
  metric:    string
  api:       number
  pdf:       number
  delta:     number
  pct:       number | null
  category:  'exact' | 'tolerable' | 'material'
}

interface PeriodComparison {
  period_year:  number
  period_month: number
  pdfRow:       TrackerRow | null
  apiRow:       TrackerRow | null
  diffs:        MetricDiff[]
}

const COMPARED_METRICS = [
  'revenue',
  'dine_in_revenue',
  'takeaway_revenue',
  'alcohol_revenue',
  'food_cost',
  'alcohol_cost',
  'staff_cost',
  'other_cost',
  'net_profit',
] as const

async function main() {
  preflight()
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const runId = process.argv[2] ?? (await loadLatestRunId(db))
  if (!runId) {
    console.error('No verification_runs row found. Run verification-runner.ts first.')
    process.exit(1)
  }

  const run = await loadRun(db, runId)
  console.log(`[report] generating for run ${runId} (${run.from_date} → ${run.to_date})`)

  // Load both sides
  const apiRows = await loadVerificationTrackerRows(db, run.from_date, run.to_date)
  const pdfRows = await loadProductionTrackerRows(db, run.business_id, run.from_date, run.to_date)

  // Index by (year, month)
  const apiByPeriod = new Map<string, TrackerRow>()
  for (const r of apiRows) apiByPeriod.set(`${r.period_year}-${r.period_month}`, r)
  const pdfByPeriod = new Map<string, TrackerRow>()
  for (const r of pdfRows) pdfByPeriod.set(`${r.period_year}-${r.period_month}`, r)

  // Comparison set: any period that appears in either side
  const periodKeys = new Set<string>()
  apiByPeriod.forEach((_, k) => periodKeys.add(k))
  pdfByPeriod.forEach((_, k) => periodKeys.add(k))

  const comparisons: PeriodComparison[] = []
  for (const key of [...periodKeys].sort()) {
    const [y, m] = key.split('-').map(Number)
    const apiRow = apiByPeriod.get(key) ?? null
    const pdfRow = pdfByPeriod.get(key) ?? null
    comparisons.push({
      period_year:  y,
      period_month: m,
      pdfRow, apiRow,
      diffs: diffPeriod(apiRow, pdfRow),
    })
  }

  // Material findings — root-cause walk by line item
  const rootCauses = await rootCauseMaterialFindings(db, run, comparisons)

  // Write report
  const outPath = resolve(process.cwd(), 'FORTNOX-VERIFICATION-REPORT-2026-05-07.md')
  const md = renderReport(run, comparisons, rootCauses)
  writeFileSync(outPath, md, 'utf8')
  console.log(`[report] written to ${outPath}`)
}

// ── Loaders ──────────────────────────────────────────────────────────────────

function preflight(): void {
  const required = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    console.error('Missing env:', missing.join(', '))
    process.exit(1)
  }
}

async function loadLatestRunId(db: any): Promise<string | null> {
  const { data, error } = await db
    .from('verification_runs')
    .select('id, status')
    .eq('org_id', VERO_ORG_ID)
    .order('run_started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  if (data.status !== 'completed') {
    console.warn(`[report] latest run ${data.id} has status=${data.status} — comparison may be incomplete`)
  }
  return data.id
}

async function loadRun(db: any, runId: string): Promise<any> {
  const { data, error } = await db
    .from('verification_runs')
    .select('*')
    .eq('id', runId)
    .single()
  if (error || !data) throw new Error(`Run ${runId} not found`)
  return data
}

async function loadVerificationTrackerRows(db: any, from: string, to: string): Promise<TrackerRow[]> {
  const { data, error } = await db
    .from('verification_tracker_data')
    .select('*')
    .eq('org_id', VERO_ORG_ID)
  if (error) throw new Error(`load verification rows: ${error.message}`)
  // Filter client-side to the run's period range
  const fromYM = ymKey(from), toYM = ymKey(to)
  return (data ?? []).filter((r: any) => {
    const k = `${r.period_year}-${String(r.period_month).padStart(2, '0')}`
    return k >= fromYM && k <= toYM
  })
}

async function loadProductionTrackerRows(db: any, businessId: string, from: string, to: string): Promise<TrackerRow[]> {
  const { data, error } = await db
    .from('tracker_data')
    .select('*')
    .eq('org_id', VERO_ORG_ID)
    .eq('business_id', businessId)
  if (error) throw new Error(`load production rows: ${error.message}`)
  const fromYM = ymKey(from), toYM = ymKey(to)
  return (data ?? []).filter((r: any) => {
    const k = `${r.period_year}-${String(r.period_month).padStart(2, '0')}`
    return k >= fromYM && k <= toYM
  })
}

function ymKey(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(5, 7)}`
}

// ── Diffing ──────────────────────────────────────────────────────────────────

function diffPeriod(api: TrackerRow | null, pdf: TrackerRow | null): MetricDiff[] {
  const out: MetricDiff[] = []
  for (const m of COMPARED_METRICS) {
    const apiVal = api ? Number((api as any)[m] ?? 0) : 0
    const pdfVal = pdf ? Number((pdf as any)[m] ?? 0) : 0
    const delta  = apiVal - pdfVal
    const abs    = Math.abs(delta)
    const pct    = pdfVal !== 0 ? (delta / pdfVal) * 100 : null
    const category: MetricDiff['category'] =
      abs < 0.01 ? 'exact'
      : abs < 100 && pct !== null && Math.abs(pct) < 1 ? 'tolerable'
      : 'material'
    out.push({ metric: m, api: apiVal, pdf: pdfVal, delta, pct, category })
  }
  return out
}

// ── Material-finding root cause ──────────────────────────────────────────────

interface RootCauseFinding {
  period:     string
  metric:     string
  delta:      number
  apiLines:   Array<{ account: number; label: string; amount: number; subcategory: string | null }>
  pdfLines:   Array<{ account: number | null; label: string; amount: number; subcategory: string | null }>
  observation: string
}

async function rootCauseMaterialFindings(
  db: any, run: any, comparisons: PeriodComparison[],
): Promise<RootCauseFinding[]> {
  const out: RootCauseFinding[] = []
  for (const c of comparisons) {
    for (const d of c.diffs) {
      if (d.category !== 'material') continue
      const period = `${c.period_year}-${String(c.period_month).padStart(2, '0')}`

      // Pull line items from both sides for this metric+period
      const apiLines = await topLineItemsForCategory(
        db, 'verification_tracker_line_items', c.period_year, c.period_month, metricToCategory(d.metric),
      )
      const pdfLines = await topLineItemsForCategory(
        db, 'tracker_line_items', c.period_year, c.period_month, metricToCategory(d.metric),
      )

      out.push({
        period,
        metric:     d.metric,
        delta:      d.delta,
        apiLines:   apiLines,
        pdfLines:   pdfLines,
        observation: observationFor(d, apiLines, pdfLines),
      })
      // One root-cause walk per metric per period is plenty — first material
      // wins. The full report still lists every material delta in the
      // summary table.
    }
  }
  return out
}

async function topLineItemsForCategory(
  db: any, table: string, year: number, month: number, category: string,
): Promise<RootCauseFinding['apiLines']> {
  if (!category) return []
  const { data } = await db
    .from(table)
    .select('account, fortnox_account, label_sv, label, amount, subcategory, category')
    .eq('period_year', year)
    .eq('period_month', month)
    .eq('category', category)
    .order('amount', { ascending: false })
    .limit(20)
  return (data ?? []).map((r: any) => ({
    account:     Number(r.fortnox_account ?? r.account ?? 0) || null,
    label:       String(r.label_sv ?? r.label ?? ''),
    amount:      Number(r.amount ?? 0),
    subcategory: r.subcategory ?? null,
  }))
}

function metricToCategory(m: string): string {
  switch (m) {
    case 'revenue':
    case 'dine_in_revenue':
    case 'takeaway_revenue':
    case 'alcohol_revenue':
      return 'revenue'
    case 'food_cost':
    case 'alcohol_cost':
      return 'food_cost'
    case 'staff_cost':
      return 'staff_cost'
    case 'other_cost':
      return 'other_cost'
    case 'net_profit':
      return ''   // composite — no single line-item category
    default:
      return ''
  }
}

function observationFor(
  d: MetricDiff, api: RootCauseFinding['apiLines'], pdf: RootCauseFinding['pdfLines'],
): string {
  if (d.pdf === 0 && d.api !== 0) return 'PDF has zero, API has data — PDF likely missing a line or this period was never applied via PDF.'
  if (d.api === 0 && d.pdf !== 0) return 'API has zero, PDF has data — vouchers may not exist for this period or were filtered out by the translation layer.'
  // VAT subset signal
  if ((d.metric === 'dine_in_revenue' || d.metric === 'takeaway_revenue' || d.metric === 'alcohol_revenue') && d.api === 0 && d.pdf > 0) {
    return 'Expected: voucher rows do not carry VAT-rate label text the same way Resultatrapport rows do. The translation layer cannot recover the dine_in/takeaway/alcohol split from voucher data alone — needs the chart of accounts (3xxx subdivision by VAT class).'
  }
  // Account mismatch hint
  const apiAccts = new Set(api.map(l => l.account).filter(Boolean))
  const pdfAccts = new Set(pdf.map(l => l.account).filter(Boolean))
  const onlyApi  = [...apiAccts].filter(a => a && !pdfAccts.has(a))
  const onlyPdf  = [...pdfAccts].filter(a => a && !apiAccts.has(a))
  if (onlyApi.length || onlyPdf.length) {
    return `Account-coverage mismatch — only-in-API accounts: ${onlyApi.slice(0, 5).join(', ') || 'none'}; only-in-PDF: ${onlyPdf.slice(0, 5).join(', ') || 'none'}.`
  }
  return 'Same accounts on both sides — drift is amount-level. Likely cause: voucher row corrections / rebookings between the PDF cutoff and the API fetch.'
}

// ── Report rendering ─────────────────────────────────────────────────────────

function renderReport(run: any, comparisons: PeriodComparison[], rootCauses: RootCauseFinding[]): string {
  const allDiffs = comparisons.flatMap(c => c.diffs.map(d => ({ ...d, period: `${c.period_year}-${String(c.period_month).padStart(2, '0')}` })))
  const totalDiffs = allDiffs.length
  const exact     = allDiffs.filter(d => d.category === 'exact').length
  const tolerable = allDiffs.filter(d => d.category === 'tolerable').length
  const material  = allDiffs.filter(d => d.category === 'material').length

  const meta = run.metadata ?? {}

  let md = ''
  md += `# Fortnox API Verification Report\n`
  md += `> Generated 2026-05-07 from verification run \`${run.id}\`.\n`
  md += `> Phase 1 of the Fortnox API backfill plan. Read-only comparison of API-derived metrics vs PDF-derived production metrics.\n\n`
  md += `---\n\n`

  // Executive summary
  md += `## Executive summary\n\n`
  if (material === 0 && tolerable === 0) {
    md += `API-derived metrics match the PDF-derived production metrics exactly across every compared dimension and period. ${exact}/${totalDiffs} diffs at <0.01 SEK precision. Phase 2 can proceed as planned with high confidence the API path will produce equivalent P&L data.\n\n`
  } else if (material === 0) {
    md += `API-derived metrics match the PDF-derived production metrics within tolerable precision. ${exact}/${totalDiffs} exact + ${tolerable}/${totalDiffs} tolerable drift (< 1% AND < 100 SEK), no material drift. Phase 2 can proceed as planned. Tolerable drift is detailed in §3.\n\n`
  } else {
    md += `API-derived metrics show **${material} material drifts** vs PDF-derived production over the ${run.from_date} → ${run.to_date} window (${exact} exact, ${tolerable} tolerable). Phase 2 should NOT proceed as a like-for-like API replacement until the material findings are addressed. Root-cause walks for each material finding are in §4.\n\n`
  }

  // Method
  md += `## 1. Method\n\n`
  md += `- Date range: \`${run.from_date}\` to \`${run.to_date}\` (90-day window ending today)\n`
  md += `- Org: \`${run.org_id}\` (Vero)\n`
  md += `- Business: \`${run.business_id ?? 'n/a'}\`\n`
  md += `- Vouchers fetched: ${run.voucher_count ?? '—'} (${meta.list_requests ?? '—'} list requests, ${meta.detail_requests ?? '—'} detail requests, ${meta.duration_ms != null ? `${(meta.duration_ms / 1000).toFixed(1)}s` : '—'})\n`
  md += `- Vouchers translated to periods: ${meta.periods_written ?? '—'} (${meta.skipped_vouchers ?? 0} skipped)\n`
  md += `- Tables compared: \`tracker_data\` vs \`verification_tracker_data\` (line-item drill-down via \`tracker_line_items\` vs \`verification_tracker_line_items\`)\n`
  md += `- Aggregator NOT run during verification — daily/dept metrics can't be cross-checked from voucher data alone (POS revenue + PK staff feeds are independent).\n\n`

  // Match summary
  md += `## 2. Match summary\n\n`
  md += `| Bucket | Count | % of total |\n|---|---:|---:|\n`
  md += `| Exact (< 0.01 SEK) | ${exact} | ${pct(exact, totalDiffs)} |\n`
  md += `| Tolerable (< 1% AND < 100 SEK) | ${tolerable} | ${pct(tolerable, totalDiffs)} |\n`
  md += `| Material | ${material} | ${pct(material, totalDiffs)} |\n`
  md += `| **Total comparisons** | **${totalDiffs}** | 100% |\n\n`

  // Per-period breakdown
  md += `### Per-period breakdown\n\n`
  md += `| Period | Metric | API | PDF | Δ | Δ% | Bucket |\n|---|---|---:|---:|---:|---:|---|\n`
  for (const c of comparisons) {
    const period = `${c.period_year}-${String(c.period_month).padStart(2, '0')}`
    for (const d of c.diffs) {
      md += `| ${period} | ${d.metric} | ${fmt(d.api)} | ${fmt(d.pdf)} | ${fmtDelta(d.delta)} | ${fmtPct(d.pct)} | ${d.category} |\n`
    }
  }
  md += `\n`

  // Tolerable detail
  if (tolerable > 0) {
    md += `## 3. Tolerable drift detail\n\n`
    md += `| Period | Metric | Δ | Δ% |\n|---|---|---:|---:|\n`
    for (const d of allDiffs.filter(d => d.category === 'tolerable')) {
      md += `| ${(d as any).period} | ${d.metric} | ${fmtDelta(d.delta)} | ${fmtPct(d.pct)} |\n`
    }
    md += `\nThese are within the < 1% AND < 100 SEK band. Likely sources: rounding at the per-row vs per-rollup boundary; voucher row corrections that nudged a category by a small amount.\n\n`
  }

  // Material root-cause walks
  if (rootCauses.length > 0) {
    md += `## 4. Material drift findings\n\n`
    for (const rc of rootCauses) {
      md += `### ${rc.period} · ${rc.metric}\n\n`
      md += `- **Delta:** ${fmtDelta(rc.delta)} SEK\n`
      md += `- **Observation:** ${rc.observation}\n\n`
      if (rc.apiLines.length > 0) {
        md += `<details><summary>Top API line items (${rc.apiLines.length})</summary>\n\n`
        md += `| Account | Label | Subcat | Amount |\n|---:|---|---|---:|\n`
        for (const l of rc.apiLines.slice(0, 10)) md += `| ${l.account ?? ''} | ${escMd(l.label)} | ${l.subcategory ?? ''} | ${fmt(l.amount)} |\n`
        md += `\n</details>\n\n`
      }
      if (rc.pdfLines.length > 0) {
        md += `<details><summary>Top PDF line items (${rc.pdfLines.length})</summary>\n\n`
        md += `| Account | Label | Subcat | Amount |\n|---:|---|---|---:|\n`
        for (const l of rc.pdfLines.slice(0, 10)) md += `| ${l.account ?? ''} | ${escMd(l.label)} | ${l.subcategory ?? ''} | ${fmt(l.amount)} |\n`
        md += `\n</details>\n\n`
      }
    }
  }

  // Implications
  md += `## 5. Implications for Phase 2\n\n`
  if (material === 0 && tolerable === 0) {
    md += `Voucher-derived API path produces metrics indistinguishable from PDF-derived production metrics for this 90-day window. The classifier in \`lib/fortnox/classify.ts\` carries enough of the signal that the apply chokepoint's validators (\`lib/fortnox/validators.ts\`) should pass on API-derived rollups without modification. Phase 2 can proceed to: (a) productionise the voucher fetcher with state tracking + resume; (b) wire it into a customer-facing "Connect Fortnox" flow with a 12-month backfill on connect; (c) replace or merge the existing Path A in \`lib/sync/engine.ts\`.\n\n`
  } else if (material === 0) {
    md += `Voucher-derived API path matches PDF-derived production metrics within tolerable precision. Phase 2 can proceed but should plan for a reconciliation pass during onboarding: the API backfill will produce metrics that are within 1% of what an accountant's PDF would produce, which is acceptable for forecasting / labour-target / margin-tracking use cases but should be flagged in the UI as "API-derived (≤ 1% drift vs accountant report)".\n\n`
  } else {
    md += `Voucher-derived API path shows material drift vs PDF-derived production for at least one metric. Phase 2 cannot proceed as a like-for-like API replacement until the material findings in §4 are addressed. The most likely architecture for Phase 2 given this finding: hybrid mode where the API path covers the daily / weekly / "since last PDF" tail and the PDF apply remains the canonical month-end reconciliation. The two paths converge through projectRollup so there is no second writer.\n\n`
  }

  // Out-of-scope notes
  md += `## 6. Out of scope (observed during this work)\n\n`
  md += `- The two parallel sync paths in \`lib/sync/engine.ts\` and \`app/api/integrations/fortnox/route.ts\` write to different tables. Cleanup belongs in a separate task; documented in \`FORTNOX-API-AUDIT-2026-05-07.md\` §6.\n`
  md += `- The \`financial_logs\` writes in \`syncFortnox\` use \`v.TransactionInformation\` (a free-text field) as a numeric amount. Pre-existing bug, materially affects whether \`financial_logs\` content can be trusted. Not Phase 1's job to fix.\n`
  md += `- VAT-rate revenue split (dine_in / takeaway / alcohol) is incomplete from voucher data alone — voucher rows lack the "X % moms" label text Resultatrapport PDFs carry. Phase 2 needs the chart of accounts (3xxx subranges) to recover this signal.\n`
  md += `- The PDF-derived production data may itself contain anomalies (the M047 chokepoint is recent, 2026-05-03). If a material finding traces back to a PDF-side mistake, that's a separate investigation.\n\n`

  md += `> "Verification report ready for review."\n`
  return md
}

function pct(n: number, total: number): string {
  if (total === 0) return '—'
  return `${((n / total) * 100).toFixed(1)}%`
}
function fmt(n: number): string { return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') }
function fmtDelta(n: number): string { return (n >= 0 ? '+' : '') + fmt(n) }
function fmtPct(p: number | null): string { return p == null ? 'n/a' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%` }
function escMd(s: string): string { return s.replace(/\|/g, '\\|') }

main().catch(e => {
  console.error('[report] uncaught:', e?.stack ?? e)
  process.exit(1)
})
