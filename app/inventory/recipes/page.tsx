'use client'
// app/inventory/recipes/page.tsx
//
// Phase 6 — Menyrecept. Recipes from lib/mock/recipes.ts; per-recipe
// cost/GP computed against the mock item master so swapping the item
// master to real data later automatically re-prices recipes.

export const dynamic = 'force-dynamic'

import { useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import KpiCardUX from '@/components/ux/KpiCard'
import DemoDataBanner from '@/components/ux/DemoDataBanner'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'
import { MOCK_INVENTORY_ITEMS } from '@/lib/mock/inventory'
import {
  MOCK_RECIPES,
  MOCK_RECIPES_TOTAL,
  recipeFoodCost,
  recipeGpPct,
  type MockRecipe,
} from '@/lib/mock/recipes'

export default function InventoryRecipesPage() {
  const [open, setOpen] = useState<MockRecipe | null>(null)

  const enriched = useMemo(() => MOCK_RECIPES.map(r => ({
    ...r,
    food_cost: recipeFoodCost(r),
    food_pct:  r.sale_price > 0 ? (recipeFoodCost(r) / r.sale_price) * 100 : 0,
    gp_pct:    recipeGpPct(r),
  })), [])

  const avgGp = enriched.reduce((s, r) => s + r.gp_pct, 0) / Math.max(1, enriched.length)
  const lowGp = enriched.filter(r => r.gp_pct < 65).length
  const totalRevenuePerCover = enriched.reduce((s, r) => s + r.sale_price, 0) / Math.max(1, enriched.length)

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>
        <DemoDataBanner />

        <div style={{ marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Menyrecept</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
            Beräknad råvarukostnad och GP per rätt — baserat på aktuella priser i artikelregistret.
          </p>
        </div>

        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap:                 12,
          marginBottom:        14,
        }}>
          <KpiCardUX
            title="Recept"
            value={MOCK_RECIPES_TOTAL.toLocaleString('sv-SE')}
            microLabel="Aktiva på menyn"
          />
          <KpiCardUX
            title="Snitt GP"
            value={fmtPct(avgGp)}
            variant="targetBand"
            targetBand={{
              actualPct:    Math.min(100, avgGp),
              targetMinPct: 65,
              targetMaxPct: 80,
            }}
            microLabel="Mål 65-80%"
          />
          <KpiCardUX
            title="GP under mål"
            value={String(lowGp)}
            deltaGood={false}
            delta={lowGp > 0 ? '< 65%' : null}
            microLabel="Behöver granskning"
          />
          <KpiCardUX
            title="Snittpris"
            value={fmtKr(Math.round(totalRevenuePerCover))}
            microLabel="Per rätt"
          />
        </div>

        <BreakdownTable
          columns={[
            { key: 'name',  header: 'Recept',     align: 'left',  render: (r: any) => (
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
            { key: 'type',  header: 'Typ',        align: 'left',  render: (r: any) => r.type },
            { key: 'sale',  header: 'Pris',       align: 'right', render: (r: any) => fmtKr(r.sale_price) },
            { key: 'cost',  header: 'Råvarukostnad', align: 'right', render: (r: any) => fmtKr(r.food_cost) },
            { key: 'pct',   header: 'Råvaru-%',   align: 'right', render: (r: any) => {
              const target = 25
              return <DeltaChip value={`${r.food_pct.toFixed(1)}%`} positiveIsGood={false} />
            } },
            { key: 'gp',    header: 'GP %',       align: 'right', render: (r: any) => fmtPct(r.gp_pct) },
          ]}
          sections={[{ rows: enriched }]}
          footer={{
            label: `${enriched.length} synliga`,
            cells: { type: '', sale: '', cost: '', pct: '', gp: '' },
          }}
          rowKey={(row: any) => row.id}
        />

        {open && (
          <RecipeDrawer recipe={open} onClose={() => setOpen(null)} />
        )}
      </div>
    </AppShell>
  )
}

function RecipeDrawer({ recipe, onClose }: { recipe: MockRecipe; onClose: () => void }) {
  const cost = recipeFoodCost(recipe)
  const gp   = recipeGpPct(recipe)
  return (
    <div
      role="dialog"
      aria-label="Receptdetaljer"
      style={{
        position:   'fixed' as const,
        top:        0, right: 0, bottom: 0,
        width:      'min(460px, 100%)',
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
            {recipe.type}
          </div>
          <div style={{ fontSize: 17, fontWeight: 500, color: UXP.ink1, marginTop: 2 }}>
            {recipe.name}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Stäng"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 16 }}
        >×</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <SummaryStat label="Försäljningspris" value={fmtKr(recipe.sale_price)} />
        <SummaryStat label="Råvarukostnad"   value={fmtKr(cost)} />
        <SummaryStat label="GP"              value={fmtPct(gp)}  tone="good" />
        <SummaryStat label="Råvaru-%"        value={`${(((cost / recipe.sale_price) || 0) * 100).toFixed(1)}%`} />
      </div>

      <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 6, fontWeight: 500 }}>Ingredienser</div>
      {recipe.ingredients.map((ing, idx) => {
        const item = MOCK_INVENTORY_ITEMS.find(i => i.id === ing.item_id)
        return (
          <div
            key={idx}
            style={{
              display:        'flex',
              justifyContent: 'space-between',
              padding:        '8px 0',
              borderBottom:   `0.5px solid ${UXP.borderSoft}`,
              fontSize:       12,
            }}
          >
            <span style={{ color: UXP.ink1 }}>{item?.name ?? ing.item_id}</span>
            <span style={{ color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
              {ing.qty} {ing.unit}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <div style={{ background: UXP.subtleBg, padding: '10px 12px', borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{
        fontSize:           18,
        fontWeight:         500,
        color:              tone === 'good' ? UXP.greenDeep : UXP.ink1,
        marginTop:          2,
        fontVariantNumeric: 'tabular-nums' as const,
      }}>{value}</div>
    </div>
  )
}
