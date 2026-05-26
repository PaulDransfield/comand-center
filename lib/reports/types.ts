// lib/reports/types.ts
//
// Generic report spec shared by every report type (margin, cost, supplier,
// …) and every renderer (PDF / Word / PowerPoint). A report type's builder
// produces a ReportSpec; the renderers turn ANY ReportSpec into a file. New
// report types = a new builder, no renderer changes.

export type Tone = 'good' | 'bad' | 'neutral'

export interface ReportKpi {
  label: string
  value: string
  tone?: Tone
}

export interface ReportTableCol {
  key:    string
  label:  string
  align?: 'left' | 'right'
}

export interface ReportTableRow {
  cells: Record<string, string>
  muted?: boolean                       // greyed (e.g. flagged anomaly)
  toneByKey?: Record<string, Tone>      // per-cell colour (e.g. the margin column)
}

export interface ReportTable {
  heading: string
  columns: ReportTableCol[]
  rows:    ReportTableRow[]
  note?:   string                       // small footnote under the table
}

export interface ReportSpec {
  type:           string                // 'margin' | 'cost' | 'supplier'
  title:          string                // "Margin Report"
  business_name:  string
  period_label:   string
  generated_at:   string
  kpis:           ReportKpi[]           // up to 4 shown in the header strip
  summary:        string                // executive summary (AI)
  table?:         ReportTable
  recommendations: Array<{ title: string; detail: string }>
  footnote?:      string
  ai_used:        boolean
}

// Hex colours shared by the renderers (no '#', some libs want bare hex).
export const RC = {
  ink:   '3A3550',
  muted: '6B6680',
  lav:   '7D6CC9',
  green: '477F60',
  rose:  'B0454E',
  line:  'E6E3F0',
  panel: 'F4F2FB',
} as const

export function toneHex(t: Tone | undefined): string {
  return t === 'good' ? RC.green : t === 'bad' ? RC.rose : RC.ink
}

export const kr = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kr`
export const marginTone = (m: number): Tone => (m >= 10 ? 'good' : m >= 5 ? 'neutral' : 'bad')
