'use client'
// app/revisor/[bizId]/[year]/[month]/page.tsx
//
// Month detail page for the revisor surface. Shows everything the
// accountant needs for a monthly close:
//   - Business header (name, org-nr, period)
//   - P&L summary card (revenue, food, staff, other, depreciation,
//     financial, net_profit, margin)
//   - BAS line items grouped by class (3xxx/4xxx/5xxx/6xxx/7xxx/8xxx)
//   - History: 12-month trend for revenue + margin
//   - Overhead flags with drilldown to source invoice PDFs
//   - Print-friendly stylesheet (Ctrl/Cmd+P → clean PDF)
//
// Read-only. No mutations on this surface.

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { UX, UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
// Phase 5 — Bookkeeping. Accountant close-the-month KpiCardUX strip:
// Intäkter (3xxx) · Kostnader (4-7xxx) · Resultat · Marginal. Avstämd
// chip beside the title when the period sourced from a Fortnox PDF
// (the human-reviewed path) — see CLAUDE.md Session 17 invariants.
import KpiCardUX from '@/components/ux/KpiCard'

const MONTH_NAMES_SV = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

interface Business {
  id:         string
  name:       string
  city:       string | null
  country:    string | null
  org_number: string | null
}

interface Tracker {
  revenue:         number | null
  food_cost:       number | null
  staff_cost:      number | null
  other_cost:      number | null
  depreciation:    number | null
  financial:       number | null
  net_profit:      number | null
  margin_pct:      number | null
  dine_in_revenue:  number | null
  takeaway_revenue: number | null
  alcohol_revenue:  number | null
  source:           string | null
  created_via:      string | null
  updated_at:       string | null
}

interface LineItem {
  account_number:      string | null
  account_description: string | null
  amount:              number | null
  kind:                string | null
  source:              string | null
}

interface HistoryRow {
  period_year:  number
  period_month: number
  revenue:      number | null
  food_cost:    number | null
  staff_cost:   number | null
  other_cost:   number | null
  net_profit:   number | null
  margin_pct:   number | null
}

interface OverheadFlag {
  id?:           string
  category?:     string
  rule_id?:      string
  reason?:       string
  amount_kr?:    number
  baseline_kr?:  number
  severity?:     string
}

interface MonthData {
  mode:            'month_detail'
  business:        Business
  period:          { year: number; month: number }
  tracker:         Tracker | null
  line_items:      LineItem[]
  history:         HistoryRow[]
  overhead_flags:  OverheadFlag[]
  generated_at:    string
}

export default function RevisorMonthDetail() {
  const params = useParams() as { bizId: string; year: string; month: string }
  const [data, setData]       = useState<MonthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    const qs = new URLSearchParams({
      business_id: params.bizId,
      year:        params.year,
      month:       params.month,
    })
    fetch(`/api/revisor/data?${qs.toString()}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { setData(j); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [params.bizId, params.year, params.month])

  if (loading) return <Layout><Empty text="Laddar…" /></Layout>
  if (error)   return <Layout><Banner tone="bad" text={error} /></Layout>
  if (!data)   return <Layout><Empty text="Ingen data" /></Layout>

  const m = data.period.month
  const y = data.period.year
  const periodLabel = `${MONTH_NAMES_SV[m - 1]} ${y}`
  const t = data.tracker

  // Phase R1 (REVISOR-COMPLIANCE-PLAN.md) — Bokföringslagen 7 kap. archival
  // compliance: every printed page carries identifying business + period
  // + source + timestamp. Format the period as a strict ISO date range so
  // it's audit-trail unambiguous.
  const periodStart = `${y}-${String(m).padStart(2, '0')}-01`
  const periodEnd   = (() => {
    // Last day of the month — use the JS Date trick (day 0 of next month).
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  })()
  const generatedAt = new Date().toLocaleString('sv-SE', {
    year:   'numeric', month: '2-digit', day:    '2-digit',
    hour:   '2-digit', minute: '2-digit',
    hour12: false,
  })
  const sourceLabel = (() => {
    const src = t?.source ?? null
    if (src === 'fortnox_pdf')   return 'Fortnox (manuellt avstämd PDF)'
    if (src === 'fortnox_apply') return 'Fortnox (apply-pipeline)'
    if (src === 'fortnox_api')   return 'Fortnox API'
    if (src === 'manual')        return 'Manuellt inmatat'
    return src ?? 'okänd'
  })()

  return (
    <Layout>
      <PrintStyles
        businessName={data.business.name}
        orgNumber={data.business.org_number}
        periodStart={periodStart}
        periodEnd={periodEnd}
        periodLabel={periodLabel}
        generatedAt={generatedAt}
      />

      <div className="cc-revisor-content">
        {/* ── Header ───────────────────────────────────────────────── */}
        <div style={{
          marginBottom:   24,
          paddingBottom:  18,
          borderBottom:   `1px solid ${UXP.border}`,
        }}>
          <a
            href="/revisor"
            style={{
              fontSize: 12, color: UXP.ink3, textDecoration: 'none',
              display: 'inline-block', marginBottom: 8,
            }}
            className="cc-no-print"
          >
            ← Alla månader
          </a>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: UXP.ink1, margin: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
            <span>Månadsavslut · {periodLabel}</span>
            {t && (t.source === 'fortnox_pdf' || t.source === 'fortnox_apply') && (
              <span style={{
                fontSize:      10,
                fontWeight:    600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase' as const,
                padding:       '3px 8px',
                background:    UXP.greenFill,
                color:         UXP.greenDeep,
                borderRadius:  999,
              }}>
                Avstämd
              </span>
            )}
          </h1>
          <div style={{ fontSize: 13, color: UXP.ink3, marginTop: 4 }}>
            <strong>{data.business.name}</strong>
            {data.business.org_number && <> · Org.nr {formatOrgNr(data.business.org_number)}</>}
            {data.business.city && <> · {data.business.city}</>}
          </div>
        </div>

        {/* Phase 5 KPI strip — accountant close-the-month roll-up. Reads
            the same tracker_data row that powers the resultaträkning
            grid below; presentation only. */}
        {t && (() => {
          const intakter = Number(t.revenue ?? 0)
          const kostnader = Number(t.food_cost ?? 0) + Number(t.staff_cost ?? 0) + Number(t.other_cost ?? 0)
          const resultat = Number(t.net_profit ?? 0)
          const marginal = t.margin_pct != null ? Number(t.margin_pct) : null
          return (
            <div
              style={{
                display:             'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap:                 12,
                marginBottom:        18,
              }}
            >
              <KpiCardUX
                title="Intäkter (3xxx)"
                value={fmtKr(intakter)}
                microLabel={periodLabel}
              />
              <KpiCardUX
                title="Kostnader (4-7xxx)"
                value={fmtKr(kostnader)}
                deltaGood={false}
                microLabel={intakter > 0 ? `${((kostnader / intakter) * 100).toFixed(1)}% av oms` : ''}
              />
              <KpiCardUX
                title="Resultat"
                value={fmtKr(resultat)}
                deltaGood
                delta={resultat >= 0 ? '+' : '−'}
              />
              <KpiCardUX
                title="Marginal"
                value={marginal != null ? marginal.toFixed(1) + '%' : '—'}
                variant="targetBand"
                targetBand={marginal != null ? {
                  actualPct:    Math.max(0, Math.min(100, marginal)),
                  targetMinPct: 5,
                  targetMaxPct: 15,
                } : undefined}
                microLabel="Mål 5-15%"
              />
            </div>
          )
        })()}

        {/* ── P&L summary card ────────────────────────────────────── */}
        {t == null ? (
          <Banner tone="warn" text="Ingen avslutad P&L för denna period. Antingen är månaden inte stängd än, eller så har Fortnox-data inte synkroniserats." />
        ) : (
          <Section title="Resultaträkning (sammandrag)">
            <div style={{
              display:    'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap:        14,
              padding:    '10px 4px',
            }}>
              <Metric label="Omsättning"      value={fmtKr(t.revenue)} tone="neutral" />
              <Metric label="Råvarukostnad"   value={fmtKr(t.food_cost)}  tone="neutral" sub={pctOf(t.food_cost,  t.revenue)} />
              <Metric label="Personalkostnad" value={fmtKr(t.staff_cost)} tone="neutral" sub={pctOf(t.staff_cost, t.revenue)} />
              <Metric label="Övriga kostnader" value={fmtKr(t.other_cost)} tone="neutral" sub={pctOf(t.other_cost, t.revenue)} />
              <Metric label="Avskrivningar"    value={fmtKr(t.depreciation)} tone="neutral" />
              <Metric label="Finansiella"      value={fmtKr(t.financial)} tone="neutral" />
              <Metric
                label="Resultat"
                value={fmtKr(t.net_profit)}
                tone={(t.net_profit ?? 0) >= 0 ? 'good' : 'bad'}
                sub={pctOf(t.net_profit, t.revenue)}
              />
              <Metric
                label="Marginal"
                value={t.margin_pct != null ? Number(t.margin_pct).toFixed(1) + '%' : '—'}
                tone={(t.margin_pct ?? 0) >= 10 ? 'good' : (t.margin_pct ?? 0) >= 5 ? 'warn' : 'bad'}
              />
            </div>

            {/* VAT-coded revenue split */}
            {(t.dine_in_revenue || t.takeaway_revenue || t.alcohol_revenue) ? (
              <div style={{
                marginTop:    4,
                padding:      '10px 12px',
                background:   UXP.pageBg,
                borderRadius: 6,
                fontSize:     12,
                color:        UXP.ink3,
              }}>
                <strong style={{ color: UXP.ink2 }}>Intäktsfördelning enligt momssats:</strong>{' '}
                Servering 12% {fmtKr(t.dine_in_revenue)} ·
                Take-away 6% {fmtKr(t.takeaway_revenue)} ·
                Alkohol 25% {fmtKr(t.alcohol_revenue)}
              </div>
            ) : null}

            <div style={{ marginTop: 6, fontSize: 11, color: UXP.ink4 }}>
              Källa: <strong>{t.source ?? '—'}</strong>
              {t.created_via && <> · Inläst via {t.created_via}</>}
              {t.updated_at  && <> · Uppdaterad {fmtDateTime(t.updated_at)}</>}
            </div>
          </Section>
        )}

        {/* ── BAS line items ───────────────────────────────────────── */}
        {data.line_items.length > 0 && (
          <Section title="BAS-klassificerade poster">
            <BasTable items={data.line_items} />
          </Section>
        )}

        {/* ── Overhead flags ───────────────────────────────────────── */}
        {data.overhead_flags.length > 0 && (
          <Section title="Kostnadsflaggor för granskning">
            <FlagsTable flags={data.overhead_flags} bizId={data.business.id} year={y} month={m} />
          </Section>
        )}

        {/* ── 12-month trend ───────────────────────────────────────── */}
        {data.history.length > 1 && (
          <Section title="12-månaders trend">
            <TrendTable history={data.history} currentPeriod={data.period} />
          </Section>
        )}

        {/* ── BFL 7 kap. compliance footer ─────────────────────────── */}
        <ComplianceFooter
          businessName={data.business.name}
          orgNumber={data.business.org_number}
          periodStart={periodStart}
          periodEnd={periodEnd}
          generatedAt={generatedAt}
          sourceLabel={sourceLabel}
        />
      </div>
    </Layout>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────

function BasTable({ items }: { items: LineItem[] }) {
  // Group by BAS class (first digit of account)
  const groups = items.reduce<Record<string, LineItem[]>>((g, item) => {
    const cls = (item.account_number ?? '?')[0] ?? '?'
    if (!g[cls]) g[cls] = []
    g[cls].push(item)
    return g
  }, {})
  const classOrder = ['3', '4', '5', '6', '7', '8', '?']
  const classLabel: Record<string, string> = {
    '3': 'Intäkter (3xxx)',
    '4': 'Råvaror (4xxx)',
    '5': 'Lokal/övriga (5xxx)',
    '6': 'Övriga kostnader (6xxx)',
    '7': 'Personal (7xxx)',
    '8': 'Finansiella (8xxx)',
    '?': 'Okänd kontoklass',
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
      <thead>
        <tr style={{ color: UXP.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UXP.border}` }}>
          <th style={th()}>Konto</th>
          <th style={th()}>Beskrivning</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Belopp</th>
        </tr>
      </thead>
      <tbody>
        {classOrder.flatMap(cls => {
          const g = groups[cls]
          if (!g || g.length === 0) return []
          const subtotal = g.reduce((s, i) => s + Number(i.amount ?? 0), 0)
          return [
            <tr key={`hdr-${cls}`} style={{ background: UXP.pageBg }}>
              <td colSpan={2} style={{ ...td(), fontWeight: 600, color: UXP.ink2 }}>{classLabel[cls]}</td>
              <td style={{ ...td(), textAlign: 'right' as const, fontWeight: 600, color: UXP.ink2 }}>
                {fmtKr(subtotal)}
              </td>
            </tr>,
            ...g.map((i, idx) => (
              <tr key={`${cls}-${idx}`} style={{ borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
                <td style={td()}><code style={{ fontSize: 11, color: UXP.ink3 }}>{i.account_number}</code></td>
                <td style={td()}>{i.account_description}</td>
                <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(i.amount)}</td>
              </tr>
            )),
          ]
        })}
      </tbody>
    </table>
  )
}

function FlagsTable({ flags, bizId, year, month }: { flags: OverheadFlag[]; bizId: string; year: number; month: number }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
      <thead>
        <tr style={{ color: UXP.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UXP.border}` }}>
          <th style={th()}>Kategori</th>
          <th style={th()}>Anledning</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Belopp</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Baslinje</th>
          <th style={th()}>Drill-down</th>
        </tr>
      </thead>
      <tbody>
        {flags.map((f, idx) => (
          <tr key={f.id ?? idx} style={{ borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
            <td style={td()}>{f.category ?? '—'}</td>
            <td style={td()}>{f.reason ?? '—'}</td>
            <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(f.amount_kr)}</td>
            <td style={{ ...td(), textAlign: 'right' as const, color: UXP.ink3 }}>{fmtKr(f.baseline_kr)}</td>
            <td style={td()}>
              {f.category && (
                <a
                  href={`/api/integrations/fortnox/drilldown?business_id=${bizId}&year=${year}&month=${month}&category=${encodeURIComponent(f.category)}`}
                  style={{ fontSize: 11, color: UXP.ink3 }}
                  className="cc-no-print"
                  target="_blank"
                  rel="noopener"
                >
                  Visa fakturor →
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function TrendTable({ history, currentPeriod }: { history: HistoryRow[]; currentPeriod: { year: number; month: number } }) {
  // Sort oldest first for reading
  const sorted = [...history].sort((a, b) =>
    (a.period_year - b.period_year) || (a.period_month - b.period_month),
  )
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
      <thead>
        <tr style={{ color: UXP.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UXP.border}` }}>
          <th style={th()}>Period</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Omsättning</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Personal</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Råvaror</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Övrigt</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Resultat</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Marginal</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(r => {
          const isCurrent = r.period_year === currentPeriod.year && r.period_month === currentPeriod.month
          return (
            <tr
              key={`${r.period_year}-${r.period_month}`}
              style={{
                borderBottom: `0.5px solid ${UXP.borderSoft}`,
                background:   isCurrent ? UXP.lavFill : 'transparent',
                fontWeight:   isCurrent ? 600 : 400,
              }}
            >
              <td style={td()}>{MONTH_NAMES_SV[r.period_month - 1]} {r.period_year}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.revenue)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.staff_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.food_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.other_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const, color: (r.net_profit ?? 0) >= 0 ? UXP.greenDeep : UXP.roseText }}>
                {fmtKr(r.net_profit)}
              </td>
              <td style={{ ...td(), textAlign: 'right' as const }}>
                {r.margin_pct != null ? Number(r.margin_pct).toFixed(1) + '%' : '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: UXP.pageBg }}>
      <header style={{
        background:    'white',
        borderBottom:  `1px solid ${UXP.border}`,
        padding:       '12px 24px',
        display:       'flex',
        alignItems:    'center',
        justifyContent: 'space-between',
      }} className="cc-no-print">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: UXP.ink1 }}>CommandCenter</span>
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
            padding: '2px 6px', borderRadius: 3,
            background: UXP.lavFill, color: UXP.lavText,
          }}>REVISOR</span>
        </div>
        <button
          onClick={() => window.print()}
          style={{
            padding: '6px 12px', background: 'white',
            border: `1px solid ${UXP.border}`, borderRadius: 7,
            fontSize: 12, fontWeight: 500, color: UXP.ink2,
            cursor: 'pointer',
          }}
        >
          Skriv ut / PDF
        </button>
      </header>
      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 80px' }}>
        {children}
      </main>
    </div>
  )
}

// Bokföringslagen 7 kap. compliance: a printed monthly-close document
// must carry identifying business + period + system source + generation
// timestamp + page count on every page, and a currency declaration.
// Phase R1 of REVISOR-COMPLIANCE-PLAN.md.
//
// CSS @page runners (@top-left etc.) are populated via string content
// injected into a <style> tag at render time. The runners apply to
// every printed page automatically — no per-section markup needed.
// JS string escaping: CSS content() values are double-quoted, so any "
// in the business name gets backslash-escaped.
function PrintStyles({
  businessName, orgNumber, periodStart, periodEnd, periodLabel, generatedAt,
}: {
  businessName: string
  orgNumber:    string | null
  periodStart:  string                // YYYY-MM-DD
  periodEnd:    string                // YYYY-MM-DD
  periodLabel:  string                // e.g. "mars 2026"
  generatedAt:  string                // formatted local timestamp
}) {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const headerLeft  = orgNumber
    ? `${esc(businessName)} · Org.nr ${formatOrgNr(orgNumber)}`
    : esc(businessName)
  const headerRight = `Räkenskapsperiod ${periodStart} — ${periodEnd}`
  const footerLeft  = `Skapad ${esc(generatedAt)} av CommandCenter · commandcenter.se`
  const footerRight = 'Alla belopp i SEK om inget annat anges'

  return (
    <style>{`
      @page {
        size: A4 portrait;
        margin: 24mm 16mm 26mm 16mm;
        @top-left      { content: "${headerLeft}";  font-family: 'Spline Sans', system-ui, sans-serif; font-size: 9pt; color: #6b7280; }
        @top-right     { content: "${headerRight}"; font-family: 'Spline Sans', system-ui, sans-serif; font-size: 9pt; color: #6b7280; }
        @bottom-center { content: "Sida " counter(page) " av " counter(pages); font-family: 'Spline Sans', system-ui, sans-serif; font-size: 9pt; color: #6b7280; }
        @bottom-left   { content: "${footerLeft}";  font-family: 'Spline Sans', system-ui, sans-serif; font-size: 8pt; color: #9ca3af; }
        @bottom-right  { content: "${footerRight}"; font-family: 'Spline Sans', system-ui, sans-serif; font-size: 8pt; color: #9ca3af; }
      }
      @media print {
        .cc-no-print          { display: none !important; }
        body                  { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .cc-revisor-content   { max-width: 100% !important; }
        /* Keep cards/sections from being split awkwardly across pages */
        section, .cc-revisor-section { break-inside: avoid; }
        /* Table rules: header rows repeat on every page; row breaks safely */
        table { page-break-inside: auto; }
        tr    { page-break-inside: avoid; page-break-after: auto; }
        thead { display: table-header-group; }
        tfoot { display: table-footer-group; }
        /* The compliance footer is always visible but doesn't need a page-
           break in print — it sits at the end of the document body. */
        .cc-compliance-footer { break-inside: avoid; }
      }
    `}</style>
  )
}

// Visible-everywhere compliance footer block. Sits at the end of the
// document body so it's the last thing on screen AND the last thing on
// the final printed page. Carries the legal acknowledgment that this
// summary is not itself the formal verifikationslista required by
// Bokföringslagen 5 kap. — that lives in the SIE export (Phase R2) or
// in the customer's Fortnox account.
function ComplianceFooter({
  businessName, orgNumber, periodStart, periodEnd, generatedAt, sourceLabel,
}: {
  businessName: string
  orgNumber:    string | null
  periodStart:  string
  periodEnd:    string
  generatedAt:  string
  sourceLabel:  string                // 'Fortnox (manuellt avstämd)' | 'Manuellt inmatat' | etc.
}) {
  return (
    <section
      className="cc-compliance-footer"
      style={{
        marginTop:    24,
        paddingTop:   16,
        borderTop:    `1px solid ${UXP.border}`,
        fontSize:     10,
        color:        UXP.ink3,
        lineHeight:   1.7,
      }}
    >
      <div style={{ fontWeight: 600, color: UXP.ink2, marginBottom: 4 }}>
        Genererad av CommandCenter (commandcenter.se) · {generatedAt}
      </div>
      <div>
        <strong>Företag:</strong> {businessName}
        {orgNumber && <> · <strong>Org.nr:</strong> {formatOrgNr(orgNumber)}</>}
      </div>
      <div>
        <strong>Räkenskapsperiod:</strong> {periodStart} till {periodEnd}
      </div>
      <div>
        <strong>Datakälla:</strong> {sourceLabel} · <strong>Valuta:</strong> SEK
      </div>
      <div style={{ marginTop: 6, fontSize: 9, color: UXP.ink4, fontStyle: 'italic' as const }}>
        Denna sammanställning utgör inte ersättning för formell verifikationslista per Bokföringslagen 5 kap. För revisorsbruk:
        ladda ner SIE-fil eller använd Fortnox direkt för fullständig verifikationsåtkomst.
      </div>
    </section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background:   'white',
      border:       `1px solid ${UXP.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginBottom: 14,
    }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, margin: 0, marginBottom: 10 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const TONE: Record<string, string> = { good: UXP.greenDeep, warn: UXP.coral, bad: UXP.roseText, neutral: UXP.ink1 }
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: UXP.ink4, textTransform: 'uppercase' as const, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 500, color: TONE[tone] }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: UXP.greenFill, border: UXP.green,  fg: UXP.greenDeep },
    warn: { bg: UXP.lavFill,   border: UXP.lavMid, fg: UXP.coral     },
    bad:  { bg: UXP.roseFill,  border: UXP.rose,   fg: UXP.roseText  },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `0.5px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
    }}>{text}</div>
  )
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12 }}>{text}</div>
}
function th(): React.CSSProperties {
  return { padding: '8px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }
}
function td(): React.CSSProperties {
  return { padding: '8px 8px', verticalAlign: 'top' as const }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function pctOf(n: number | null | undefined, total: number | null | undefined): string | null {
  if (n == null || total == null || total === 0) return null
  return ((Number(n) / Number(total)) * 100).toFixed(1) + '% av oms.'
}
function formatOrgNr(s: string): string {
  const clean = s.replace(/\D/g, '')
  if (clean.length !== 10) return s
  return `${clean.slice(0, 6)}-${clean.slice(6)}`
}
function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
  } catch { return iso }
}
