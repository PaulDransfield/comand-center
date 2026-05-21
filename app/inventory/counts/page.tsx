'use client'
// app/inventory/counts/page.tsx
//
// Phase 6 — stock-count report vision page. Per-ingredient flow:
// opening + deliveries + transfers − closing = consumed, side-by-side
// with theoretical "sold" so the operator sees variance at a glance.

export const dynamic = 'force-dynamic'

import AppShell from '@/components/AppShell'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import KpiCardUX from '@/components/ux/KpiCard'
import DemoDataBanner from '@/components/ux/DemoDataBanner'
import { UXP } from '@/lib/constants/tokens'
import {
  MOCK_COUNT_ROWS,
  mockCountFooter,
  type MockCountRow,
} from '@/lib/mock/counts'

function fmt(n: number, unit: string) {
  return `${n.toFixed(unit === 'st' || unit === 'g' ? 0 : 1)}`
}

export default function InventoryCountsPage() {
  const footer = mockCountFooter()
  const flagged = MOCK_COUNT_ROWS.filter(r => Math.abs(r.varians) >= 1.5).length

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>
        <DemoDataBanner />

        <div style={{ marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Lagerräkning</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
            Senaste avstämda räkningen — variansrad mot teoretisk förbrukning enligt recept.
          </p>
        </div>

        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap:                 12,
          marginBottom:        14,
        }}>
          <KpiCardUX
            title="Ingredienser räknade"
            value={String(MOCK_COUNT_ROWS.length)}
            microLabel="Senaste räkning"
          />
          <KpiCardUX
            title="Avvikelser"
            value={String(flagged)}
            deltaGood={false}
            delta={flagged > 0 ? '|varians| ≥ 1.5' : null}
            microLabel="Behöver granskning"
          />
          <KpiCardUX
            title="Räkningar i år"
            value="12"
            microLabel="En per månad"
          />
        </div>

        <BreakdownTable<MockCountRow>
          columns={[
            { key: 'article',     header: 'Vara',           align: 'left',  width: 'minmax(180px, 1.6fr)', render: (r) => (
              <span>
                <span style={{ color: UXP.ink1, fontWeight: 500 }}>{r.name}</span>
                <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1 }}>{r.article}</span>
              </span>
            ) },
            { key: 'varians',     header: 'Varians',        align: 'right', render: (r) =>
              <DeltaChip value={`${r.varians >= 0 ? '+' : ''}${r.varians.toFixed(1)} ${r.unit}`} positiveIsGood={false} />,
            },
            { key: 'ingaende',    header: 'Ingående',       align: 'right', render: (r) => `${fmt(r.ingaende, r.unit)} ${r.unit}` },
            { key: 'leverans',    header: 'Leverans',       align: 'right', render: (r) => `${fmt(r.leverans, r.unit)} ${r.unit}` },
            { key: 'overfort_in', header: 'Överfört',       align: 'right', render: (r) => `${fmt(r.overfort_in - r.overfort_ut, r.unit)} ${r.unit}` },
            { key: 'utgaende',    header: 'Utgående',       align: 'right', render: (r) => `${fmt(r.utgaende, r.unit)} ${r.unit}` },
            { key: 'forbrukat',   header: 'Förbrukat',      align: 'right', render: (r) => `${fmt(r.forbrukat, r.unit)} ${r.unit}` },
            { key: 'sald',        header: 'Sålt (recept)',  align: 'right', render: (r) => `${fmt(r.sald, r.unit)} ${r.unit}` },
          ]}
          sections={[{ rows: MOCK_COUNT_ROWS }]}
          footer={{
            label: 'SUMMA',
            cells: {
              varians:     '',
              ingaende:    String(footer.ingaende),
              leverans:    String(footer.leverans),
              overfort_in: String(footer.overfort_in - footer.overfort_ut),
              utgaende:    String(footer.utgaende),
              forbrukat:   String(footer.forbrukat),
              sald:        String(footer.sald),
            },
          }}
          rowKey={(row) => row.item_id}
        />
      </div>
    </AppShell>
  )
}
