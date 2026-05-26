// lib/reports/margin-docx.ts
//
// GENERIC report Word (.docx) renderer — consumes any ReportSpec. Exports
// renderReportDocx; renderMarginDocx is a back-compat alias.

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
} from 'docx'
import type { ReportSpec } from '@/lib/reports/types'
import { RC, toneHex } from '@/lib/reports/types'

function cell(text: string, opts: { bold?: boolean; color?: string; align?: any; header?: boolean } = {}) {
  return new TableCell({
    shading: opts.header ? { fill: 'F4F2FB' } : undefined,
    children: [new Paragraph({
      alignment: opts.align ?? AlignmentType.LEFT,
      children: [new TextRun({ text, bold: opts.bold, color: (opts.color ?? RC.ink).replace('#', ''), size: 18 })],
    })],
  })
}

export async function renderReportDocx(spec: ReportSpec): Promise<Buffer> {
  const children: any[] = [
    new Paragraph({ children: [new TextRun({ text: 'COMMANDCENTER', bold: true, color: RC.lav, size: 16, characterSpacing: 40 })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: spec.title, color: RC.ink })] }),
    new Paragraph({ children: [new TextRun({ text: `${spec.business_name}   ·   ${spec.period_label}`, color: RC.muted, size: 20 })] }),
    new Paragraph({ spacing: { before: 200 }, children: [new TextRun({
      text: spec.kpis.map(k => `${k.label}: ${k.value}`).join('      '), bold: true, size: 20, color: RC.ink,
    })] }),
    new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun({ text: 'Summary', color: RC.ink })] }),
    new Paragraph({ children: [new TextRun({ text: spec.summary, size: 20, color: RC.ink })] }),
  ]

  if (spec.table) {
    const cols = spec.table.columns
    const headerRow = new TableRow({ children: cols.map(c => cell(c.label, { header: true, bold: true, align: c.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT })) })
    const dataRows = spec.table.rows.map(r => new TableRow({ children: cols.map(c => cell(r.cells[c.key] ?? '', {
      align: c.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      bold: !!r.toneByKey?.[c.key],
      color: r.muted ? RC.muted : (r.toneByKey?.[c.key] ? toneHex(r.toneByKey[c.key]) : RC.ink),
    })) }))
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun({ text: spec.table.heading, color: RC.ink })] }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows],
        borders: { top: { style: BorderStyle.SINGLE, size: 1, color: 'E6E3F0' }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E6E3F0' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'F0EEF8' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
      }),
    )
    if (spec.table.note) children.push(new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: spec.table.note, italics: true, size: 16, color: RC.muted })] }))
  }

  if (spec.recommendations.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280 }, children: [new TextRun({ text: 'Recommendations', color: RC.ink })] }))
    spec.recommendations.forEach((r, i) => {
      children.push(new Paragraph({ spacing: { before: 140 }, children: [new TextRun({ text: `${i + 1}. ${r.title}`, bold: true, size: 20, color: RC.ink })] }))
      if (r.detail) children.push(new Paragraph({ children: [new TextRun({ text: r.detail, size: 19, color: RC.muted })] }))
    })
  }

  children.push(new Paragraph({ spacing: { before: 320 }, children: [new TextRun({
    text: `${spec.footnote ?? 'Figures from your Fortnox data.'}${spec.ai_used ? ' · narrative by CommandCenter AI' : ''}.  Generated ${new Date(spec.generated_at).toLocaleDateString('en-GB')}.`,
    size: 15, color: RC.muted,
  })] }))

  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc) as unknown as Promise<Buffer>
}
export const renderMarginDocx = renderReportDocx   // back-compat
