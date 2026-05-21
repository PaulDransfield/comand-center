'use client'
// app/inventory/items/page.tsx
//
// Phase 6 vision page — Inventory item master. Mock data lives in
// lib/mock/inventory.ts and is rendered through the canonical
// BreakdownTable + KpiCardUX so swapping to /api/inventory/items later
// requires no UI work.

export const dynamic = 'force-dynamic'

import { useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import BreakdownTable from '@/components/ux/BreakdownTable'
import KpiCardUX from '@/components/ux/KpiCard'
import DemoDataBanner from '@/components/ux/DemoDataBanner'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import {
  MOCK_INVENTORY_ITEMS,
  MOCK_INVENTORY_TOTAL,
  type MockInventoryItem,
} from '@/lib/mock/inventory'

const TYPE_FILTERS: Array<MockInventoryItem['type'] | 'Alla'> = [
  'Alla', 'Råvara', 'Förbrukning', 'Dryck', 'Tillagad',
]

export default function InventoryItemsPage() {
  const [filter, setFilter] = useState<typeof TYPE_FILTERS[number]>('Alla')
  const [open,   setOpen]   = useState<MockInventoryItem | null>(null)

  const filtered = useMemo(() => filter === 'Alla'
    ? MOCK_INVENTORY_ITEMS
    : MOCK_INVENTORY_ITEMS.filter(i => i.type === filter),
    [filter])

  const suppliers = useMemo(() => new Set(MOCK_INVENTORY_ITEMS.map(i => i.main_supplier)), [])
  const avgPrice = useMemo(() => MOCK_INVENTORY_ITEMS.reduce((s, i) => s + i.price_sek, 0) / MOCK_INVENTORY_ITEMS.length, [])

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>
        <DemoDataBanner />

        <div style={{ marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Artiklar</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
            Råvaror, drycker och förbrukningsartiklar — sorterat per kategori.
          </p>
        </div>

        {/* KPI strip — mock totals from the inventory fixture. */}
        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap:                 12,
          marginBottom:        14,
        }}>
          <KpiCardUX
            title="Artiklar"
            value={MOCK_INVENTORY_TOTAL.toLocaleString('sv-SE')}
            microLabel="Totalt i artikelregistret"
          />
          <KpiCardUX
            title="Leverantörer"
            value={String(suppliers.size + 12)  /* +12 so the demo looks realistic */}
            microLabel="Aktiva"
          />
          <KpiCardUX
            title="Snittpris / enhet"
            value={fmtKr(Math.round(avgPrice))}
            microLabel="Per beställningsenhet"
          />
        </div>

        {/* Filter chips */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' as const }}>
          {TYPE_FILTERS.map(opt => {
            const active = opt === filter
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setFilter(opt)}
                style={{
                  padding:      '4px 10px',
                  background:   active ? UXP.lavFill : UXP.cardBg,
                  color:        active ? UXP.lavText : UXP.ink2,
                  border:       `0.5px solid ${active ? UXP.lav : UXP.border}`,
                  borderRadius: 999,
                  fontSize:     11,
                  fontFamily:   'inherit',
                  cursor:       'pointer',
                }}
              >
                {opt}
              </button>
            )
          })}
        </div>

        <BreakdownTable<MockInventoryItem>
          columns={[
            { key: 'name',     header: 'Namn',              align: 'left',  render: (r) => (
              <button
                type="button"
                onClick={() => setOpen(r)}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: UXP.ink1, fontWeight: 500, cursor: 'pointer',
                  fontFamily: 'inherit', textAlign: 'left' as const,
                }}
              >
                {r.name}
              </button>
            ) },
            { key: 'type',     header: 'Typ',               align: 'left',  render: (r) => r.type },
            { key: 'category', header: 'Kategori',          align: 'left',  render: (r) => r.category },
            { key: 'supplier', header: 'Huvudleverantör',   align: 'left',  render: (r) => r.main_supplier },
            { key: 'order',    header: 'Beställningsenhet', align: 'left',  render: (r) => r.order_unit },
            { key: 'price',    header: 'Pris',              align: 'right', render: (r) => fmtKr(r.price_sek) },
            { key: 'vat',      header: 'Moms',              align: 'right', render: (r) => `${r.vat_pct}%` },
          ]}
          sections={[{ rows: filtered }]}
          footer={{
            label: `1–${filtered.length} av ${MOCK_INVENTORY_TOTAL.toLocaleString('sv-SE')}`,
            cells: { type: '', category: '', supplier: '', order: '', price: '', vat: '' },
          }}
          rowKey={(row) => row.id}
        />

        {open && (
          <ItemDrawer item={open} onClose={() => setOpen(null)} />
        )}
      </div>
    </AppShell>
  )
}

function ItemDrawer({ item, onClose }: { item: MockInventoryItem; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Artikeldetaljer"
      style={{
        position:   'fixed' as const,
        top:        0, right: 0, bottom: 0,
        width:      'min(420px, 100%)',
        background: UXP.cardBg,
        borderLeft: `0.5px solid ${UXP.border}`,
        boxShadow:  '-8px 0 24px rgba(58,53,80,0.08)',
        padding:    '18px 22px',
        overflow:   'auto',
        zIndex:     50,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            {item.category}
          </div>
          <div style={{ fontSize: 17, fontWeight: 500, color: UXP.ink1, marginTop: 2 }}>
            {item.name}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Stäng"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 16 }}
        >×</button>
      </div>

      <DetailRow label="Typ"               value={item.type} />
      <DetailRow label="Huvudleverantör"   value={item.main_supplier} />
      <DetailRow label="Beställningsenhet" value={item.order_unit} />
      <DetailRow label="Förpackning"       value={item.pack_size} />
      <DetailRow label="Pris"              value={`${fmtKr(item.price_sek)} · ${item.vat_pct}% moms`} />
      <DetailRow label="Förvaring"         value={item.storage_areas.join(' · ')} />
      <DetailRow label="Antal-enheter"     value={item.count_units.join(' · ')} />
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display:      'flex',
      justifyContent: 'space-between',
      gap:          12,
      padding:      '10px 0',
      borderBottom: `0.5px solid ${UXP.borderSoft}`,
      fontSize:     12,
    }}>
      <span style={{ color: UXP.ink3 }}>{label}</span>
      <span style={{ color: UXP.ink1, textAlign: 'right' as const }}>{value}</span>
    </div>
  )
}
