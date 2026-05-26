// Smoke-test all three renderers from one spec. Run: npx tsx scripts/test-reports.tsx
import { renderMarginPdf } from '../components/reports/MarginReportPdf'
import { renderMarginDocx } from '../lib/reports/margin-docx'
import { renderMarginPptx } from '../lib/reports/margin-pptx'

const months = [
  { year: 2025, month: 11, label: 'Nov 2025', revenue: 1620000, food_cost: 254000, staff_cost: 471000, other_cost: 400000, net_profit: 495000, margin_pct: 30.6, food_pct: 15.7, labour_pct: 29.1, is_anomaly: false },
  { year: 2025, month: 12, label: 'Dec 2025', revenue: 980000,  food_cost: 330000, staff_cost: 300000, other_cost: 200000, net_profit: 150000, margin_pct: 15.3, food_pct: 33.7, labour_pct: 30.6, is_anomaly: false },
  { year: 2026, month: 1,  label: 'Jan 2026', revenue: 640000,  food_cost: 230000, staff_cost: 220000, other_cost: 170000, net_profit: 20000,  margin_pct: 3.1,  food_pct: 35.9, labour_pct: 34.4, is_anomaly: false },
  { year: 2026, month: 4,  label: 'Apr 2026', revenue: 1135000, food_cost: 359000, staff_cost: 0,       other_cost: 400000, net_profit: 376000, margin_pct: 29.2, food_pct: 31.6, labour_pct: 0,    is_anomaly: true },
]
const spec: any = {
  business_name: 'Vero Italiano', period_label: 'Nov 2025 – Apr 2026', generated_at: new Date().toISOString(),
  months, latest: months[months.length - 1],
  averages: { margin_pct: 16.3, food_pct: 28.4, labour_pct: 31.4, revenue: 1080000 },
  anomaly_count: 1,
  executive_summary: 'Net margin averaged 16.3% across the clean months, with November the standout (30.6%) on strong revenue and tight 15.7% food cost. One month (Apr 2026) is flagged for review — 0% recorded labour is operationally impossible and was excluded from the averages.',
  recommendations: [
    { title: 'Investigate the April 2026 labour gap', detail: 'Apr 2026 shows 0% labour on 1.1M kr revenue — labour was almost certainly posted to a different period. Correct it before trusting the average.' },
    { title: 'Hold food cost near November levels', detail: 'November hit 15.7% food cost; January slipped to 35.9%. Document what drove the strong month and standardise it.' },
  ],
  ai_used: true,
}

const sig = (b: Buffer) => b.subarray(0, 4).toString('latin1')
;(async () => {
  const pdf  = await renderMarginPdf(spec)
  const docx = await renderMarginDocx(spec)
  const pptx = await renderMarginPptx(spec)
  console.log(`PDF : ${pdf.length} bytes  sig="${sig(pdf)}"  -> ${sig(pdf) === '%PDF' ? 'VALID' : 'BAD'}`)
  console.log(`DOCX: ${docx.length} bytes  sig="${sig(docx)}"  -> ${sig(docx).startsWith('PK') ? 'VALID (zip/ooxml)' : 'BAD'}`)
  console.log(`PPTX: ${pptx.length} bytes  sig="${sig(pptx)}"  -> ${sig(pptx).startsWith('PK') ? 'VALID (zip/ooxml)' : 'BAD'}`)
})()
