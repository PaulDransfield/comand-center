// Local render smoke-test: build a sample spec, render the PDF, write it out.
// Run: npx tsx scripts/test-margin-pdf.tsx
import { writeFileSync } from 'node:fs'
import { renderMarginPdf } from '../components/reports/MarginReportPdf'

const months = [
  { year: 2025, month: 11, label: 'Nov 2025', revenue: 820000, food_cost: 270000, staff_cost: 250000, other_cost: 180000, net_profit: 120000, margin_pct: 14.6, food_pct: 32.9, labour_pct: 30.5 },
  { year: 2025, month: 12, label: 'Dec 2025', revenue: 980000, food_cost: 330000, staff_cost: 300000, other_cost: 200000, net_profit: 150000, margin_pct: 15.3, food_pct: 33.7, labour_pct: 30.6 },
  { year: 2026, month: 1,  label: 'Jan 2026', revenue: 640000, food_cost: 230000, staff_cost: 220000, other_cost: 170000, net_profit: 20000,  margin_pct: 3.1,  food_pct: 35.9, labour_pct: 34.4 },
  { year: 2026, month: 2,  label: 'Feb 2026', revenue: 710000, food_cost: 235000, staff_cost: 225000, other_cost: 175000, net_profit: 75000,  margin_pct: 10.6, food_pct: 33.1, labour_pct: 31.7 },
]
const spec = {
  business_name: 'Vero Italiano',
  period_label: 'Nov 2025 – Feb 2026',
  generated_at: new Date().toISOString(),
  months,
  latest: months[months.length - 1],
  averages: { margin_pct: 10.9, food_pct: 33.9, labour_pct: 31.8, revenue: 787500 },
  executive_summary: 'Net margin averaged 10.9% over four closed months but dipped to 3.1% in January as revenue fell ~35% while labour stayed flat at 34%. Food cost is consistently above the 28–32% target.',
  recommendations: [
    { title: 'Flex labour to January demand', detail: 'Labour held at 34% of sales in January despite a revenue drop. Trim hours on the slowest dayparts to protect margin in low-season months.' },
    { title: 'Bring food cost to target', detail: 'Food is averaging 33.9% vs the 28–32% benchmark. Review pricing and waste on the top-spend suppliers.' },
    { title: 'Repeat December', detail: 'December delivered the strongest margin (15.3%) on the highest revenue — capture which mix/pricing drove it.' },
  ],
  ai_used: false,
}

;(async () => {
  const buf = await renderMarginPdf(spec as any)
  writeFileSync('scripts/_margin-sample.pdf', buf)
  const head = buf.subarray(0, 5).toString('latin1')
  console.log(`Rendered ${buf.length} bytes, header="${head}" -> ${head === '%PDF-' ? 'VALID PDF' : 'NOT A PDF'}`)
})()
