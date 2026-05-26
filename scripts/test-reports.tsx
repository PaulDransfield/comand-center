// Smoke-test the generic renderers from one ReportSpec.
// Run: npx tsx scripts/test-reports.tsx
import { renderReportPdf } from '../components/reports/MarginReportPdf'
import { renderReportDocx } from '../lib/reports/margin-docx'
import { renderReportPptx } from '../lib/reports/margin-pptx'
import type { ReportSpec } from '../lib/reports/types'

const spec: ReportSpec = {
  type: 'margin', title: 'Margin Report', business_name: 'Vero Italiano',
  period_label: 'Nov 2025 – Apr 2026', generated_at: new Date().toISOString(),
  kpis: [
    { label: 'Net margin (last 3 mo)', value: '16.3%', tone: 'good' },
    { label: 'Food cost', value: '28.4%' },
    { label: 'Labour', value: '31.4%' },
    { label: 'Revenue / mo', value: '1,080,000 kr' },
  ],
  summary: 'Recent months averaged a 16.3% net margin; November was the standout. One month is flagged for review (0% labour, excluded from the headline).',
  table: {
    heading: 'Monthly margin trend',
    columns: [ { key: 'month', label: 'Month' }, { key: 'revenue', label: 'Revenue', align: 'right' }, { key: 'food', label: 'Food %', align: 'right' }, { key: 'labour', label: 'Labour %', align: 'right' }, { key: 'margin', label: 'Net margin', align: 'right' } ],
    rows: [
      { cells: { month: 'Nov 2025', revenue: '1,623,951 kr', food: '15.7%', labour: '29.1%', margin: '29.9%' }, toneByKey: { margin: 'good' } },
      { cells: { month: 'Jan 2026', revenue: '640,000 kr', food: '35.9%', labour: '34.4%', margin: '3.1%' }, toneByKey: { margin: 'bad' } },
      { cells: { month: 'Apr 2026  *', revenue: '1,135,074 kr', food: '31.6%', labour: '0%', margin: '29.2%' }, muted: true },
    ],
    note: '* 1 month flagged as a data anomaly and excluded from the headline.',
  },
  recommendations: [
    { title: 'Investigate the April labour gap', detail: 'Apr 2026 shows 0% labour — almost certainly posted to a different period.' },
    { title: 'Hold food cost near November levels', detail: 'November hit 15.7%; standardise what drove it.' },
  ],
  footnote: 'Figures sourced from your Fortnox financial data.',
  ai_used: true,
}

const sig = (b: Buffer) => b.subarray(0, 4).toString('latin1')
;(async () => {
  const pdf  = await renderReportPdf(spec)
  const docx = await renderReportDocx(spec)
  const pptx = await renderReportPptx(spec)
  console.log(`PDF : ${pdf.length} bytes  sig="${sig(pdf)}"  -> ${sig(pdf) === '%PDF' ? 'VALID' : 'BAD'}`)
  console.log(`DOCX: ${docx.length} bytes  sig="${sig(docx)}"  -> ${sig(docx).startsWith('PK') ? 'VALID (ooxml)' : 'BAD'}`)
  console.log(`PPTX: ${pptx.length} bytes  sig="${sig(pptx)}"  -> ${sig(pptx).startsWith('PK') ? 'VALID (ooxml)' : 'BAD'}`)
})()
