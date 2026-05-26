// lib/reports/margin-pptx.ts
//
// PowerPoint (.pptx) renderer for the margin report — same MarginReportSpec,
// different output. Uses pptxgenjs (pure JS). Slides: title, KPIs + summary,
// monthly trend table, recommendations.

import PptxGenJS from 'pptxgenjs'
import type { MarginReportSpec, MarginMonth } from '@/lib/reports/margin-report'

const INK = '3A3550', LAV = '7D6CC9', MUTED = '6B6680', GREEN = '477F60', ROSE = 'B0454E', LINE = 'E6E3F0', BG = 'FAF9FD'
const kr = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kr`
const marginColor = (m: number) => (m >= 10 ? GREEN : m >= 5 ? INK : ROSE)

export async function renderMarginPptx(spec: MarginReportSpec): Promise<Buffer> {
  const p = new PptxGenJS()
  p.defineLayout({ name: 'CC', width: 13.333, height: 7.5 })
  p.layout = 'CC'
  p.author = 'CommandCenter'
  const a = spec.averages

  // ── Slide 1: title ──
  const s1 = p.addSlide()
  s1.background = { color: BG }
  s1.addText('COMMANDCENTER', { x: 0.7, y: 2.3, w: 12, h: 0.4, fontSize: 13, color: LAV, bold: true, charSpacing: 3 })
  s1.addText('Margin Report', { x: 0.7, y: 2.7, w: 12, h: 1.0, fontSize: 44, color: INK, bold: true })
  s1.addText(`${spec.business_name}   ·   ${spec.period_label}`, { x: 0.7, y: 3.8, w: 12, h: 0.5, fontSize: 18, color: MUTED })

  // ── Slide 2: KPIs + summary ──
  const s2 = p.addSlide()
  s2.background = { color: 'FFFFFF' }
  s2.addText('Where margins stand', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, color: INK, bold: true })
  const kpis: Array<[string, string, string]> = [
    ['NET MARGIN (AVG)', `${a.margin_pct}%`, marginColor(a.margin_pct)],
    ['FOOD COST (AVG)',  `${a.food_pct}%`,  INK],
    ['LABOUR (AVG)',     `${a.labour_pct}%`, INK],
    ['REVENUE / MONTH',  kr(a.revenue),     INK],
  ]
  kpis.forEach(([label, value, color], i) => {
    const x = 0.7 + i * 3.05
    s2.addShape(p.ShapeType.roundRect, { x, y: 1.4, w: 2.8, h: 1.5, fill: { color: 'F4F2FB' }, line: { color: LINE, width: 0.5 }, rectRadius: 0.08 })
    s2.addText(label, { x: x + 0.15, y: 1.55, w: 2.5, h: 0.3, fontSize: 9, color: MUTED, bold: true })
    s2.addText(value, { x: x + 0.15, y: 1.95, w: 2.5, h: 0.7, fontSize: 30, color, bold: true })
  })
  s2.addText('Summary', { x: 0.7, y: 3.3, w: 12, h: 0.4, fontSize: 16, color: INK, bold: true })
  s2.addText(spec.executive_summary, { x: 0.7, y: 3.75, w: 11.9, h: 3.0, fontSize: 14, color: INK, lineSpacingMultiple: 1.3, valign: 'top' })

  // ── Slide 3: monthly trend table ──
  const s3 = p.addSlide()
  s3.background = { color: 'FFFFFF' }
  s3.addText('Monthly margin trend', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, color: INK, bold: true })
  const head = ['Month', 'Revenue', 'Food %', 'Labour %', 'Net margin'].map((t, i) => ({
    text: t,
    options: { bold: true, color: MUTED, fontSize: 11, fill: { color: 'F4F2FB' }, align: (i === 0 ? 'left' : 'right') as 'left' | 'right' },
  }))
  const rows = spec.months.map((m: MarginMonth) => ([
    { text: `${m.label}${m.is_anomaly ? '  *' : ''}`, options: { fontSize: 11, color: m.is_anomaly ? MUTED : INK, align: 'left' as const } },
    { text: kr(m.revenue), options: { fontSize: 11, color: INK, align: 'right' as const } },
    { text: `${m.food_pct}%`, options: { fontSize: 11, color: INK, align: 'right' as const } },
    { text: `${m.labour_pct}%`, options: { fontSize: 11, color: INK, align: 'right' as const } },
    { text: `${m.margin_pct}%`, options: { fontSize: 11, bold: true, color: m.is_anomaly ? MUTED : marginColor(m.margin_pct), align: 'right' as const } },
  ]))
  s3.addTable([head, ...rows], { x: 0.7, y: 1.3, w: 11.9, colW: [3.4, 2.3, 2.0, 2.1, 2.1], border: { type: 'solid', color: LINE, pt: 0.5 }, rowH: 0.32, valign: 'middle' })
  if (spec.anomaly_count > 0) {
    s3.addText(`* ${spec.anomaly_count} month(s) flagged as a data anomaly and excluded from the averages — review in Fortnox.`, { x: 0.7, y: 6.9, w: 11.9, h: 0.4, fontSize: 10, italic: true, color: MUTED })
  }

  // ── Slide 4+: recommendations ──
  const s4 = p.addSlide()
  s4.background = { color: 'FFFFFF' }
  s4.addText('Recommendations to improve margin', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, color: INK, bold: true })
  const bullets = spec.recommendations.flatMap((r, i) => ([
    { text: `${i + 1}. ${r.title}`, options: { bold: true, color: INK, fontSize: 15, bullet: false, paraSpaceBefore: 10 } },
    ...(r.detail ? [{ text: r.detail, options: { color: MUTED, fontSize: 12, bullet: false, indentLevel: 1 } }] : []),
  ]))
  s4.addText(bullets as any, { x: 0.7, y: 1.3, w: 11.9, h: 5.6, valign: 'top', lineSpacingMultiple: 1.15 })

  const out = await p.write({ outputType: 'nodebuffer' })
  return out as Buffer
}
