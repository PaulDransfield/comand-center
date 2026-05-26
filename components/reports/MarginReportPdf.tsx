// components/reports/MarginReportPdf.tsx
//
// @react-pdf/renderer document for the margin report. Pure server-side PDF
// (no headless browser). Exports renderMarginPdf(spec) → Buffer so the API
// route can stay a plain .ts file.
//
// Branded with the CommandCenter pastel palette. Helvetica (built-in)
// covers Swedish åäö via WinAnsi, so supplier/business names render fine.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { MarginReportSpec, MarginMonth } from '@/lib/reports/margin-report'

const INK   = '#3a3550'
const INK2  = '#6b6680'
const LAV   = '#7d6cc9'
const GREEN = '#477f60'
const ROSE  = '#b0454e'
const LINE  = '#e6e3f0'

const s = StyleSheet.create({
  page:       { paddingTop: 44, paddingBottom: 48, paddingHorizontal: 44, fontSize: 10, color: INK, fontFamily: 'Helvetica' },
  brand:      { fontSize: 9, letterSpacing: 2, color: LAV, fontFamily: 'Helvetica-Bold' },
  title:      { fontSize: 22, marginTop: 6, fontFamily: 'Helvetica-Bold', color: INK },
  sub:        { fontSize: 10, color: INK2, marginTop: 3 },
  rule:       { borderBottomWidth: 1, borderBottomColor: LINE, marginTop: 14, marginBottom: 16 },

  kpiRow:     { flexDirection: 'row', gap: 10, marginBottom: 18 },
  kpi:        { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 10 },
  kpiLabel:   { fontSize: 7.5, letterSpacing: 0.6, color: INK2, textTransform: 'uppercase' },
  kpiValue:   { fontSize: 16, marginTop: 4, fontFamily: 'Helvetica-Bold' },

  h2:         { fontSize: 12, fontFamily: 'Helvetica-Bold', marginBottom: 7, color: INK },
  body:       { fontSize: 10, lineHeight: 1.5, color: INK, marginBottom: 16 },

  tHead:      { flexDirection: 'row', backgroundColor: '#f4f2fb', paddingVertical: 5, paddingHorizontal: 6, borderRadius: 3 },
  tRow:       { flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: LINE },
  th:         { fontSize: 7.5, color: INK2, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.4 },
  td:         { fontSize: 9, color: INK },
  cMonth:     { width: '28%' },
  cNum:       { width: '18%', textAlign: 'right' },

  rec:        { flexDirection: 'row', marginBottom: 9 },
  recNum:     { width: 16, fontFamily: 'Helvetica-Bold', color: LAV },
  recTitle:   { fontFamily: 'Helvetica-Bold', fontSize: 10, color: INK },
  recDetail:  { fontSize: 9.5, color: INK2, lineHeight: 1.45, marginTop: 1 },

  footer:     { position: 'absolute', bottom: 24, left: 44, right: 44, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 6, fontSize: 7.5, color: INK2, flexDirection: 'row', justifyContent: 'space-between' },
})

const kr = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kr`
function tone(margin: number) { return margin >= 10 ? GREEN : margin >= 5 ? INK : ROSE }

function MarginDoc({ spec }: { spec: MarginReportSpec }) {
  const a = spec.averages
  const latest = spec.latest
  return (
    <Document title={`${spec.business_name} — Margin Report`} author="CommandCenter">
      <Page size="A4" style={s.page}>
        <Text style={s.brand}>COMMANDCENTER</Text>
        <Text style={s.title}>Margin Report</Text>
        <Text style={s.sub}>{spec.business_name}   ·   {spec.period_label}</Text>
        <View style={s.rule} />

        {/* KPIs — latest closed month + period averages */}
        <View style={s.kpiRow}>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Net margin (avg)</Text>
            <Text style={[s.kpiValue, { color: tone(a.margin_pct) }]}>{a.margin_pct}%</Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Food cost (avg)</Text>
            <Text style={s.kpiValue}>{a.food_pct}%</Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Labour (avg)</Text>
            <Text style={s.kpiValue}>{a.labour_pct}%</Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Revenue / month</Text>
            <Text style={s.kpiValue}>{kr(a.revenue)}</Text>
          </View>
        </View>

        {/* Executive summary */}
        <Text style={s.h2}>Summary</Text>
        <Text style={s.body}>{spec.executive_summary}</Text>

        {/* Monthly table */}
        <Text style={s.h2}>Monthly margin trend</Text>
        <View style={s.tHead}>
          <Text style={[s.th, s.cMonth]}>Month</Text>
          <Text style={[s.th, s.cNum]}>Revenue</Text>
          <Text style={[s.th, s.cNum]}>Food %</Text>
          <Text style={[s.th, s.cNum]}>Labour %</Text>
          <Text style={[s.th, s.cNum]}>Net margin</Text>
        </View>
        {spec.months.map((m: MarginMonth) => (
          <View style={s.tRow} key={`${m.year}-${m.month}`}>
            <Text style={[s.td, s.cMonth, m.is_anomaly ? { color: INK2 } : {}]}>{m.label}{m.is_anomaly ? '  *' : ''}</Text>
            <Text style={[s.td, s.cNum]}>{kr(m.revenue)}</Text>
            <Text style={[s.td, s.cNum]}>{m.food_pct}%</Text>
            <Text style={[s.td, s.cNum]}>{m.labour_pct}%</Text>
            <Text style={[s.td, s.cNum, { color: m.is_anomaly ? INK2 : tone(m.margin_pct), fontFamily: 'Helvetica-Bold' }]}>{m.margin_pct}%</Text>
          </View>
        ))}
        {spec.anomaly_count > 0 && (
          <Text style={{ fontSize: 8, color: INK2, marginTop: 6, lineHeight: 1.4 }}>
            * {spec.anomaly_count} month{spec.anomaly_count > 1 ? 's' : ''} flagged as a data anomaly (e.g. a stock write-off or uncaptured labour) and excluded from the averages above — worth reviewing in Fortnox.
          </Text>
        )}

        {/* Recommendations */}
        {spec.recommendations.length > 0 && (
          <View style={{ marginTop: 18 }}>
            <Text style={s.h2}>Recommendations to improve margin</Text>
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
          <Text>Figures sourced from your Fortnox financial data{spec.ai_used ? ' · narrative generated by CommandCenter AI' : ''}.</Text>
          <Text>{new Date(spec.generated_at).toLocaleDateString('en-GB')}</Text>
        </View>
      </Page>
    </Document>
  )
}

export async function renderMarginPdf(spec: MarginReportSpec): Promise<Buffer> {
  return renderToBuffer(<MarginDoc spec={spec} />)
}
