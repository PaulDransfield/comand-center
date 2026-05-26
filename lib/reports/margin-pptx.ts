// lib/reports/margin-pptx.ts
//
// GENERIC report PowerPoint (.pptx) renderer — consumes any ReportSpec.
// Exports renderReportPptx; renderMarginPptx is a back-compat alias.

import PptxGenJS from 'pptxgenjs'
import type { ReportSpec } from '@/lib/reports/types'
import { RC, toneHex } from '@/lib/reports/types'

const HX = (h: string) => h.replace('#', '')

export async function renderReportPptx(spec: ReportSpec): Promise<Buffer> {
  const p = new PptxGenJS()
  p.defineLayout({ name: 'CC', width: 13.333, height: 7.5 })
  p.layout = 'CC'
  p.author = 'CommandCenter'

  // Title slide
  const s1 = p.addSlide(); s1.background = { color: 'FAF9FD' }
  s1.addText('COMMANDCENTER', { x: 0.7, y: 2.3, w: 12, h: 0.4, fontSize: 13, color: RC.lav, bold: true, charSpacing: 3 })
  s1.addText(spec.title, { x: 0.7, y: 2.7, w: 12, h: 1.0, fontSize: 44, color: RC.ink, bold: true })
  s1.addText(`${spec.business_name}   ·   ${spec.period_label}`, { x: 0.7, y: 3.8, w: 12, h: 0.5, fontSize: 18, color: RC.muted })

  // KPIs + summary
  const s2 = p.addSlide(); s2.background = { color: 'FFFFFF' }
  s2.addText('Key figures', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, color: RC.ink, bold: true })
  spec.kpis.slice(0, 4).forEach((k, i) => {
    const x = 0.7 + i * 3.05
    s2.addShape(p.ShapeType.roundRect, { x, y: 1.4, w: 2.8, h: 1.5, fill: { color: 'F4F2FB' }, line: { color: RC.line, width: 0.5 }, rectRadius: 0.08 })
    s2.addText(k.label.toUpperCase(), { x: x + 0.15, y: 1.55, w: 2.5, h: 0.4, fontSize: 9, color: RC.muted, bold: true })
    s2.addText(k.value, { x: x + 0.15, y: 2.0, w: 2.5, h: 0.7, fontSize: 26, color: HX(toneHex(k.tone)), bold: true })
  })
  s2.addText('Summary', { x: 0.7, y: 3.3, w: 12, h: 0.4, fontSize: 16, color: RC.ink, bold: true })
  s2.addText(spec.summary, { x: 0.7, y: 3.75, w: 11.9, h: 3.0, fontSize: 14, color: RC.ink, lineSpacingMultiple: 1.3, valign: 'top' })

  // Table
  if (spec.table) {
    const s3 = p.addSlide(); s3.background = { color: 'FFFFFF' }
    s3.addText(spec.table.heading, { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, color: RC.ink, bold: true })
    const head = spec.table.columns.map(c => ({ text: c.label, options: { bold: true, color: RC.muted, fontSize: 11, fill: { color: 'F4F2FB' }, align: (c.align === 'right' ? 'right' : 'left') as 'left' | 'right' } }))
    const rows = spec.table.rows.map(r => spec.table!.columns.map(c => ({
      text: r.cells[c.key] ?? '',
      options: { fontSize: 11, bold: !!r.toneByKey?.[c.key], color: r.muted ? RC.muted : HX(r.toneByKey?.[c.key] ? toneHex(r.toneByKey[c.key]) : RC.ink), align: (c.align === 'right' ? 'right' : 'left') as 'left' | 'right' },
    })))
    s3.addTable([head, ...rows], { x: 0.7, y: 1.3, w: 11.9, border: { type: 'solid', color: RC.line, pt: 0.5 }, rowH: 0.3, valign: 'middle', autoPage: true, autoPageRepeatHeader: true })
    if (spec.table.note) s3.addText(spec.table.note, { x: 0.7, y: 6.95, w: 11.9, h: 0.4, fontSize: 10, italic: true, color: RC.muted })
  }

  // Recommendations
  if (spec.recommendations.length) {
    const s4 = p.addSlide(); s4.background = { color: 'FFFFFF' }
    s4.addText('Recommendations', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, color: RC.ink, bold: true })
    const bullets = spec.recommendations.flatMap((r, i) => ([
      { text: `${i + 1}. ${r.title}`, options: { bold: true, color: RC.ink, fontSize: 15, paraSpaceBefore: 10 } },
      ...(r.detail ? [{ text: r.detail, options: { color: RC.muted, fontSize: 12, indentLevel: 1 } }] : []),
    ]))
    s4.addText(bullets as any, { x: 0.7, y: 1.3, w: 11.9, h: 5.6, valign: 'top', lineSpacingMultiple: 1.15 })
  }

  return (await p.write({ outputType: 'nodebuffer' })) as Buffer
}
export const renderMarginPptx = renderReportPptx   // back-compat
