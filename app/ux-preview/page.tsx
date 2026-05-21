'use client'
// app/ux-preview/page.tsx
//
// Phase 1 robustness preview. Each `components/ux/*` component rendered
// against the four ugly-data cases the Phase 1 prompt mandates:
//   1. Long names (must ellipsis/wrap)
//   2. 9-figure numbers (must align, must not overflow)
//   3. Null values (must render as "—")
//   4. Negative deltas (must render rose, not green)
//
// Not linked from nav. Visit /ux-preview directly on the preview
// deployment. (Originally lived at /_ux-preview, but Next.js App Router
// treats folders prefixed with `_` as PRIVATE — they opt out of routing
// entirely — so the route 404'd. Renamed to remove the underscore.)
//
// Auth: none. The page renders only the new presentational components,
// no live data, so showing it without auth is safe.

import AppShellUX, { NavItem } from '@/components/ux/AppShellUX'
import KpiCard from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { fmtKr, fmtPct } from '@/lib/format'
import { UXP } from '@/lib/constants/tokens'

const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', icon: <Icon shape="square" /> },
  { key: 'flash',    label: 'Flash P&L', icon: <Icon shape="bars" /> },
  { key: 'reviews',  label: 'Reviews',   icon: <Icon shape="star" /> },
]

export default function UxPreviewPage() {
  return (
    <AppShellUX
      section="UX preview"
      dateLabel="Phase 1 · Foundation"
      compareLabel="Ugly data"
      navItems={NAV}
      activeKey="overview"
    >
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'grid', gap: 16 }}>
        <Header />
        <SectionTitle>Case 1 — long names</SectionTitle>
        <KpiRow case="long" />
        <SectionTitle>Case 2 — 9-figure numbers</SectionTitle>
        <KpiRow case="big" />
        <SectionTitle>Case 3 — nulls</SectionTitle>
        <KpiRow case="null" />
        <SectionTitle>Case 4 — negative deltas</SectionTitle>
        <KpiRow case="neg" />

        <SectionTitle>PairedBarChart — all four cases</SectionTitle>
        <ChartRow />

        <SectionTitle>BreakdownTable — all four cases</SectionTitle>
        <TableRow />
      </div>
    </AppShellUX>
  )
}

// ── KPI cards ──────────────────────────────────────────────────────

function KpiRow({ case: kase }: { case: 'long' | 'big' | 'null' | 'neg' }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
      {/* plain */}
      <KpiCard
        title={kase === 'long' ? 'Revenue this period (a much longer label than usual on purpose to test wrapping)' : 'Revenue'}
        value={kase === 'null' ? '—'
             : kase === 'big'  ? fmtKr(1_284_593_421)
             : kase === 'neg'  ? fmtKr(-180_000)
             : fmtKr(280_000)}
        delta={kase === 'null' ? null
             : kase === 'neg'  ? '-12.4%'
             : '+9.6%'}
        deltaGood
      />
      {/* channels */}
      <KpiCard
        title="Channels"
        value={kase === 'big' ? fmtKr(1_284_593_000) : fmtKr(280_000)}
        delta={kase === 'neg' ? '-3.1%' : '+2.0%'}
        deltaGood
        variant="channels"
        channels={[
          { label: 'Dine-in',  value: kase === 'big' ? 800_000_000 : 180_000, share: 0.62, color: UXP.lav },
          { label: 'Takeaway', value: kase === 'big' ? 280_000_000 : 60_000,  share: 0.21, color: UXP.lavMid },
          { label: 'Alcohol',  value: kase === 'big' ? 204_593_421 : 40_000,  share: 0.17, color: UXP.lavPale },
        ]}
      />
      {/* stacked */}
      <KpiCard
        title="Food vs labour"
        value={kase === 'null' ? '—' : fmtPct(33.4)}
        delta={kase === 'neg' ? '+2.1pp' : '-0.8pp'}
        deltaGood={false}
        variant="stacked"
        stackedBars={[
          { label: 'Food cost',   value: 28, max: 100, color: UXP.coral },
          { label: 'Labour cost', value: 33, max: 100, color: UXP.lavDeep },
        ]}
      />
      {/* targetBand */}
      <KpiCard
        title="Labour vs target"
        value={kase === 'null' ? '—' : fmtPct(kase === 'big' ? 78 : 33)}
        delta={kase === 'neg' ? '+5pp over' : 'on target'}
        deltaGood={false}
        variant="targetBand"
        targetBand={{
          actualPct:    kase === 'big' ? 78 : kase === 'neg' ? 52 : 33,
          targetMinPct: 30,
          targetMaxPct: 35,
        }}
      />
    </div>
  )
}

// ── Chart cases ────────────────────────────────────────────────────

function ChartRow() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 12, padding: 16 }}>
      <PairedBarChart
        groups={days}
        series={[
          { label: 'Revenue',    data: [42_000, 48_000, 51_000, 45_000, 92_000, 105_000, 0],         color: UXP.lav },
          { label: 'Last week',  data: [38_000, 50_000, 47_000, 49_000, 88_000, 97_000,  null as any], color: UXP.lavMid },
        ]}
        lines={[
          { label: 'Labour %',   data: [33, 34, 36, 32, 31, 38, null], color: UXP.coral },
          { label: 'Prev wk %',  data: [35, 32, 38, 30, 30, 36, null], color: UXP.coralLine, dashed: true },
        ]}
        leftMax={120_000}
        rightMax={50}
        leftAxisUnit="kr"
        width={1040}
        height={220}
      />
    </div>
  )
}

// ── Table cases ────────────────────────────────────────────────────

function TableRow() {
  const longName = 'A supplier with a deliberately very long name to test ellipsis behaviour at the cell boundary'
  return (
    <BreakdownTable
      columns={[
        { key: 'name',  header: 'Supplier',    align: 'left',  width: 'minmax(180px, 2fr)' },
        { key: 'spend', header: 'Spend',       align: 'right', width: '1fr',
          render: (r) => r.spend == null ? null : fmtKr(r.spend) },
        { key: 'delta', header: 'Δ vs avg',    align: 'right', width: '100px',
          render: (r) => r.delta == null ? null : <DeltaChip value={r.delta} positiveIsGood={false} /> },
        { key: 'last',  header: 'Last invoice', align: 'right', width: '110px' },
      ]}
      sections={[
        {
          label: 'Food',
          rows: [
            { name: longName, spend: 1_284_593_421, delta: '+12.4%', last: '21 May' },
            { name: 'Martin & Servera', spend: 142_500,    delta: '-3.1%',  last: '20 May' },
          ],
        },
        {
          label: 'Beverage',
          rows: [
            { name: 'Systembolaget', spend: 88_400,  delta: null,     last: '18 May' },
            { name: 'Local brewery', spend: null,    delta: null,     last: '—' },
            { name: 'Negative test', spend: -2_100,  delta: '-9.0%',  last: '—' },
          ],
        },
      ]}
      footer={{
        label: 'Total',
        cells: {
          spend: fmtKr(1_284_822_220),
          delta: <DeltaChip value="+9.6%" positiveIsGood={false} />,
          last:  '21 May',
        },
      }}
    />
  )
}

// ── Atoms ──────────────────────────────────────────────────────────

function Header() {
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 12, padding: '14px 16px' }}>
      <h1 style={{
        fontFamily:    'var(--font-display)',
        fontSize:      18,
        fontWeight:    500,
        letterSpacing: '-0.02em',
        color:         UXP.ink1,
        margin:        0,
      }}>
        Phase 1 — robustness preview
      </h1>
      <p style={{ fontSize: 11, color: UXP.ink3, margin: '6px 0 0', lineHeight: 1.5 }}>
        Each component below is rendered with the four ugly-data cases the prompt mandates. If
        anything wraps wrong, overflows, or shows raw template literals, that's a Phase 1 regression.
      </p>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize:       9,
      letterSpacing:  '0.06em',
      textTransform:  'uppercase' as const,
      color:          UXP.ink3,
      marginTop:      8,
    }}>
      {children}
    </div>
  )
}

function Icon({ shape }: { shape: 'square' | 'bars' | 'star' }) {
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (shape) {
    case 'square': return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
    case 'bars':   return <svg {...common}><line x1="6"  y1="20" x2="6"  y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="14"/></svg>
    case 'star':   return <svg {...common}><polygon points="12 2 15 9 22 9 16 14 18 21 12 17 6 21 8 14 2 9 9 9"/></svg>
  }
}
