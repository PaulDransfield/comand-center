// components/reports/MarginReportPdf.tsx
//
// GENERIC report PDF renderer (margin / cost / supplier / future types) via
// @react-pdf/renderer. Pure server-side (no headless browser). Consumes any
// ReportSpec (lib/reports/types.ts). Exports renderReportPdf(spec) → Buffer;
// renderMarginPdf is a back-compat alias.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { ReportSpec } from '@/lib/reports/types'
import { RC, toneHex } from '@/lib/reports/types'

const INK = `#${RC.ink}`, INK2 = `#${RC.muted}`, LAV = `#${RC.lav}`, LINE = `#${RC.line}`

const s = StyleSheet.create({
  page:     { paddingTop: 44, paddingBottom: 48, paddingHorizontal: 44, fontSize: 10, color: INK, fontFamily: 'Helvetica' },
  brand:    { fontSize: 9, letterSpacing: 2, color: LAV, fontFamily: 'Helvetica-Bold' },
  title:    { fontSize: 22, marginTop: 6, fontFamily: 'Helvetica-Bold', color: INK },
  sub:      { fontSize: 10, color: INK2, marginTop: 3 },
  rule:     { borderBottomWidth: 1, borderBottomColor: LINE, marginTop: 14, marginBottom: 16 },
  kpiRow:   { flexDirection: 'row', gap: 10, marginBottom: 18 },
  kpi:      { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 10 },
  kpiLabel: { fontSize: 7.5, letterSpacing: 0.6, color: INK2, textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, marginTop: 4, fontFamily: 'Helvetica-Bold' },
  h2:       { fontSize: 12, fontFamily: 'Helvetica-Bold', marginBottom: 7, color: INK },
  body:     { fontSize: 10, lineHeight: 1.5, color: INK, marginBottom: 16 },
  tHead:    { flexDirection: 'row', backgroundColor: '#f4f2fb', paddingVertical: 5, paddingHorizontal: 6, borderRadius: 3 },
  tRow:     { flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: LINE },
  th:       { fontSize: 7.5, color: INK2, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.4 },
  td:       { fontSize: 9, color: INK },
  note:     { fontSize: 8, color: INK2, marginTop: 6, lineHeight: 1.4 },
  rec:      { flexDirection: 'row', marginBottom: 9 },
  recNum:   { width: 16, fontFamily: 'Helvetica-Bold', color: LAV },
  recTitle: { fontFamily: 'Helvetica-Bold', fontSize: 10, color: INK },
  recDetail:{ fontSize: 9.5, color: INK2, lineHeight: 1.45, marginTop: 1 },
  footer:   { position: 'absolute', bottom: 24, left: 44, right: 44, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 6, fontSize: 7.5, color: INK2, flexDirection: 'row', justifyContent: 'space-between' },
})

function ReportDoc({ spec }: { spec: ReportSpec }) {
  const cols = spec.table?.columns ?? []
  const colW = (i: number, align?: string) => (i === 0 ? { width: '28%' } : { width: `${72 / Math.max(1, cols.length - 1)}%`, textAlign: (align ?? 'right') as any })
  return (
    <Document title={`${spec.business_name} — ${spec.title}`} author="CommandCenter">
      <Page size="A4" style={s.page}>
        <Text style={s.brand}>COMMANDCENTER</Text>
        <Text style={s.title}>{spec.title}</Text>
        <Text style={s.sub}>{spec.business_name}   ·   {spec.period_label}</Text>
        <View style={s.rule} />

        <View style={s.kpiRow}>
          {spec.kpis.slice(0, 4).map((k, i) => (
            <View style={s.kpi} key={i}>
              <Text style={s.kpiLabel}>{k.label}</Text>
              <Text style={[s.kpiValue, { color: toneHex(k.tone) }]}>{k.value}</Text>
            </View>
          ))}
        </View>

        <Text style={s.h2}>Summary</Text>
        <Text style={s.body}>{spec.summary}</Text>

        {spec.table && (
          <>
            <Text style={s.h2}>{spec.table.heading}</Text>
            <View style={s.tHead}>
              {cols.map((c, i) => <Text key={c.key} style={[s.th, colW(i, c.align)]}>{c.label}</Text>)}
            </View>
            {spec.table.rows.map((r, ri) => (
              <View style={s.tRow} key={ri}>
                {cols.map((c, i) => (
                  <Text key={c.key} style={[s.td, colW(i, c.align), r.muted ? { color: INK2 } : (r.toneByKey?.[c.key] ? { color: toneHex(r.toneByKey[c.key]), fontFamily: 'Helvetica-Bold' } : {})]}>
                    {r.cells[c.key] ?? ''}
                  </Text>
                ))}
              </View>
            ))}
            {spec.table.note ? <Text style={s.note}>{spec.table.note}</Text> : null}
          </>
        )}

        {spec.recommendations.length > 0 && (
          <View style={{ marginTop: 18 }}>
            <Text style={s.h2}>Recommendations</Text>
            {spec.recommendations.map((r, i) => (
              <View style={s.rec} key={i} wrap={false}>
                <Text style={s.recNum}>{i + 1}.</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.recTitle}>{r.title}</Text>
                  {r.detail ? <Text style={s.recDetail}>{r.detail}</Text> : null}
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={s.footer} fixed>
          <Text>{spec.footnote ?? 'Figures from your Fortnox data.'}{spec.ai_used ? ' · narrative by CommandCenter AI' : ''}</Text>
          <Text>{new Date(spec.generated_at).toLocaleDateString('en-GB')}</Text>
        </View>
      </Page>
    </Document>
  )
}

export async function renderReportPdf(spec: ReportSpec): Promise<Buffer> {
  return renderToBuffer(<ReportDoc spec={spec} />)
}
export const renderMarginPdf = renderReportPdf   // back-compat
