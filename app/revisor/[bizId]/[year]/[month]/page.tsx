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
import { UX } from '@/lib/constants/tokens'

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

  return (
    <Layout>
      <PrintStyles />

      <div className="cc-revisor-content">
        {/* ── Header ───────────────────────────────────────────────── */}
        <div style={{
          marginBottom:   24,
          paddingBottom:  18,
          borderBottom:   `1px solid ${UX.border}`,
        }}>
          <a
            href="/revisor"
            style={{
              fontSize: 12, color: UX.ink3, textDecoration: 'none',
              display: 'inline-block', marginBottom: 8,
            }}
            className="cc-no-print"
          >
            ← Alla månader
          </a>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: UX.ink1, margin: 0 }}>
            Månadsavslut · {periodLabel}
          </h1>
          <div style={{ fontSize: 13, color: UX.ink3, marginTop: 4 }}>
            <strong>{data.business.name}</strong>
            {data.business.org_number && <> · Org.nr {formatOrgNr(data.business.org_number)}</>}
            {data.business.city && <> · {data.business.city}</>}
          </div>
        </div>

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
                background:   UX.pageBg,
                borderRadius: 6,
                fontSize:     12,
                color:        UX.ink3,
              }}>
                <strong style={{ color: UX.ink2 }}>Intäktsfördelning enligt momssats:</strong>{' '}
                Servering 12% {fmtKr(t.dine_in_revenue)} ·
                Take-away 6% {fmtKr(t.takeaway_revenue)} ·
                Alkohol 25% {fmtKr(t.alcohol_revenue)}
              </div>
            ) : null}

            <div style={{ marginTop: 6, fontSize: 11, color: UX.ink4 }}>
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

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div style={{
          marginTop:   28,
          paddingTop:  14,
          borderTop:   `1px solid ${UX.border}`,
          fontSize:    10,
          color:       UX.ink4,
        }}>
          Genererad av CommandCenter för revisor-vy · {fmtDateTime(data.generated_at)}.
          {' '}Avstämning bör jämföras mot bokföringen i Fortnox.
        </div>
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
        <tr style={{ color: UX.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UX.border}` }}>
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
            <tr key={`hdr-${cls}`} style={{ background: UX.pageBg }}>
              <td colSpan={2} style={{ ...td(), fontWeight: 600, color: UX.ink2 }}>{classLabel[cls]}</td>
              <td style={{ ...td(), textAlign: 'right' as const, fontWeight: 600, color: UX.ink2 }}>
                {fmtKr(subtotal)}
              </td>
            </tr>,
            ...g.map((i, idx) => (
              <tr key={`${cls}-${idx}`} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
                <td style={td()}><code style={{ fontSize: 11, color: UX.ink3 }}>{i.account_number}</code></td>
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
        <tr style={{ color: UX.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UX.border}` }}>
          <th style={th()}>Kategori</th>
          <th style={th()}>Anledning</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Belopp</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Baslinje</th>
          <th style={th()}>Drill-down</th>
        </tr>
      </thead>
      <tbody>
        {flags.map((f, idx) => (
          <tr key={f.id ?? idx} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
            <td style={td()}>{f.category ?? '—'}</td>
            <td style={td()}>{f.reason ?? '—'}</td>
            <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(f.amount_kr)}</td>
            <td style={{ ...td(), textAlign: 'right' as const, color: UX.ink3 }}>{fmtKr(f.baseline_kr)}</td>
            <td style={td()}>
              {f.category && (
                <a
                  href={`/api/integrations/fortnox/drilldown?business_id=${bizId}&year=${year}&month=${month}&category=${encodeURIComponent(f.category)}`}
                  style={{ fontSize: 11, color: UX.ink3 }}
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
        <tr style={{ color: UX.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UX.border}` }}>
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
                borderBottom: `0.5px solid ${UX.borderSoft}`,
                background:   isCurrent ? '#eef2ff' : 'transparent',
                fontWeight:   isCurrent ? 600 : 400,
              }}
            >
              <td style={td()}>{MONTH_NAMES_SV[r.period_month - 1]} {r.period_year}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.revenue)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.staff_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.food_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.other_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const, color: (r.net_profit ?? 0) >= 0 ? UX.greenInk : '#b91c1c' }}>
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
    <div style={{ minHeight: '100vh', background: UX.pageBg }}>
      <header style={{
        background:    'white',
        borderBottom:  `1px solid ${UX.border}`,
        padding:       '12px 24px',
        display:       'flex',
        alignItems:    'center',
        justifyContent: 'space-between',
      }} className="cc-no-print">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: UX.ink1 }}>CommandCenter</span>
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
            padding: '2px 6px', borderRadius: 3,
            background: '#eef2ff', color: '#4338ca',
          }}>REVISOR</span>
        </div>
        <button
          onClick={() => window.print()}
          style={{
            padding: '6px 12px', background: 'white',
            border: `1px solid ${UX.border}`, borderRadius: 7,
            fontSize: 12, fontWeight: 500, color: UX.ink2,
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

function PrintStyles() {
  return (
    <style>{`
      @media print {
        .cc-no-print { display: none !important; }
        body { background: white !important; }
        .cc-revisor-content { max-width: 100% !important; }
      }
    `}</style>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background:   'white',
      border:       `1px solid ${UX.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginBottom: 14,
    }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: UX.ink1, margin: 0, marginBottom: 10 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const TONE: Record<string, string> = { good: UX.greenInk, warn: UX.amberInk, bad: '#b91c1c', neutral: UX.ink1 }
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: UX.ink4, textTransform: 'uppercase' as const, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 500, color: TONE[tone] }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: UX.ink4, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' },
    warn: { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
    bad:  { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
    }}>{text}</div>
  )
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 36, textAlign: 'center' as const, color: UX.ink4, fontSize: 12 }}>{text}</div>
}
function th(): React.CSSProperties {
  return { padding: '8px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }
}
function td(): React.CSSProperties {
  return { padding: '8px 8px', verticalAlign: 'top' as const }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fmtKr(n: number | null | undefined): string {
  if (n == null) return '—'
  return Math.round(Number(n) || 0).toLocaleString('sv-SE') + ' kr'
}
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
