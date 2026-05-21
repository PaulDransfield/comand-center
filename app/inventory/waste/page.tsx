'use client'
// app/inventory/waste/page.tsx
//
// Phase 6 — waste analytics vision page. Reasons → PairedBarChart;
// top ingredients → BreakdownTable with "% of total waste" chips.

export const dynamic = 'force-dynamic'

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import DemoDataBanner from '@/components/ux/DemoDataBanner'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import {
  MOCK_WASTE_REASONS,
  MOCK_WASTE_INGREDIENTS,
  MOCK_WASTE_TOTAL_VALUE,
  MOCK_WASTE_TOTAL_EVENTS,
  type MockWasteIngredient,
} from '@/lib/mock/waste'

export default function InventoryWastePage() {
  const sortedIngredients = [...MOCK_WASTE_INGREDIENTS].sort((a, b) => b.value - a.value)
  const reasonsByValue   = [...MOCK_WASTE_REASONS].sort((a, b) => b.value - a.value)
  const topReason        = reasonsByValue[0]

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>
        <DemoDataBanner />

        <div style={{ marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Svinn</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
            Rullande 30-dagar — registrerade händelser och beräknat värde per anledning.
          </p>
        </div>

        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap:                 12,
          marginBottom:        14,
        }}>
          <KpiCardUX
            title="Svinn (kostnad)"
            value={fmtKr(MOCK_WASTE_TOTAL_VALUE)}
            deltaGood={false}
            delta="−6.2% mot förra 30d"
            microLabel="Rullande 30 dagar"
          />
          <KpiCardUX
            title="Händelser"
            value={String(MOCK_WASTE_TOTAL_EVENTS)}
            microLabel={`${sortedIngredients.length} unika artiklar`}
          />
          <KpiCardUX
            title="Toppanledning"
            value={topReason?.reason ?? '—'}
            microLabel={topReason ? `${fmtKr(topReason.value)} · ${topReason.count} fall` : ''}
          />
          <KpiCardUX
            title="Svinn / dag"
            value={fmtKr(Math.round(MOCK_WASTE_TOTAL_VALUE / 30))}
            deltaGood={false}
            microLabel="Snittkostnad"
          />
        </div>

        {/* Reasons chart */}
        <div style={{
          background:   UXP.cardBg,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: UXP.r_lg,
          padding:      '14px 16px',
          marginBottom: 12,
        }}>
          <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 8, fontWeight: 500 }}>
            Värde per anledning
          </div>
          <PairedBarChart
            groups={reasonsByValue.map(r => r.reason)}
            series={[
              { label: 'Värde',    data: reasonsByValue.map(r => r.value), color: UXP.lav  },
            ]}
            lines={[{
              label:  'Antal fall',
              data:   reasonsByValue.map(r => r.count),
              color:  UXP.coral,
              dashed: false,
            }]}
            width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 900) : 900}
            height={220}
          />
        </div>

        {/* Ingredient leaderboard */}
        <BreakdownTable<MockWasteIngredient>
          columns={[
            { key: 'name',     header: 'Artikel',      align: 'left',  render: (r) => r.name },
            { key: 'category', header: 'Kategori',     align: 'left',  render: (r) => r.category },
            { key: 'reason',   header: 'Toppanledning', align: 'left', render: (r) => (
              <span style={{
                display:      'inline-block',
                padding:      '2px 6px',
                background:   UXP.lavFill,
                color:        UXP.lavText,
                borderRadius: 6,
                fontSize:     10,
              }}>{r.top_reason}</span>
            ) },
            { key: 'events',   header: 'Händelser',     align: 'right', render: (r) => String(r.events) },
            { key: 'value',    header: 'Värde',         align: 'right', render: (r) => fmtKr(r.value) },
            { key: 'pct',      header: '% av svinn',    align: 'right', render: (r) => (
              <DeltaChip
                value={`${((r.value / MOCK_WASTE_TOTAL_VALUE) * 100).toFixed(1)}%`}
                positiveIsGood={false}
              />
            ) },
          ]}
          sections={[{ rows: sortedIngredients }]}
          footer={{
            label: 'Summa',
            cells: {
              category: '',
              reason:   '',
              events:   String(MOCK_WASTE_TOTAL_EVENTS),
              value:    fmtKr(MOCK_WASTE_TOTAL_VALUE),
              pct:      '100%',
            },
          }}
          rowKey={(row) => row.item_id}
        />
      </div>
    </AppShell>
  )
}
