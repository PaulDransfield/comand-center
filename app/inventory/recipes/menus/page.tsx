'use client'
// app/inventory/recipes/menus/page.tsx
//
// Set menus list — fixed-price multi-course packages, presented as a card
// grid that mirrors the recipes list so chef/owner can scan visually.
// Toggle Food / Drink. Click a menu → editor.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { PageContainer } from '@/components/ui/Layout'
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable'
import { fmtKr } from '@/lib/format'

interface MenuRow {
  id:                   string
  name:                 string
  type:                 'food' | 'drink'
  selling_price_ex_vat: number | null
  menu_price:           number | null
  vat_rate:             number | null
  channel:              string | null
  image_url:            string | null
  item_count:           number
  food_cost:            number | null
  gp_kr:                number | null
  gp_pct:               number | null
  cost_pct:             number | null
  incomplete:           boolean
  updated_at:           string
}

export default function MenusListPage() {
  const router = useRouter()
  const [bizId, setBizId] = useState<string | null>(null)
  const [view, setView] = useState<'food' | 'drink'>('food')
  const [rows, setRows] = useState<MenuRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setBizId(typeof window !== 'undefined' ? localStorage.getItem('cc_selected_biz') : null)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) { setRows([]); setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/menus?business_id=${bizId}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setRows(j.menus ?? [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])

  useEffect(() => { load() }, [load])

  const filtered = rows.filter(r => r.type === view)
  const foodCount  = rows.filter(r => r.type === 'food').length
  const drinkCount = rows.filter(r => r.type === 'drink').length

  async function createMenu() {
    if (!bizId || busy) return
    const name = window.prompt(view === 'food' ? 'Food menu name (e.g. "5-course tasting")' : 'Drink menu name (e.g. "Wine pairing 3 glasses")')?.trim()
    if (!name) return
    setBusy(true)
    try {
      const r = await fetch('/api/inventory/menus', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, name, type: view }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      router.push(`/inventory/recipes/menus/${j.menu.id}`)
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const cols: Array<DataTableColumn<MenuRow>> = [
    { id: 'img', header: '',
      cell: r => r.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.image_url} alt="" loading="lazy"
          style={{ width: 36, height: 36, borderRadius: 5, objectFit: 'cover' as const,
                   border: `0.5px solid ${UXP.border}`, background: '#fff', display: 'block' }} />
      ) : (
        <div style={{ width: 36, height: 36, borderRadius: 5, background: UXP.subtleBg, border: `0.5px dashed ${UXP.border}` }} />
      ),
    },
    { id: 'name', header: 'Menu', primary: true,
      cell: r => (
        <div>
          <span style={{ fontWeight: 500, color: UXP.ink1 }}>{r.name}</span>
          {r.incomplete && (
            <div style={{ fontSize: 10, color: UXP.coral, marginTop: 2 }}>Incomplete cost</div>
          )}
        </div>
      ),
    },
    { id: 'courses', header: view === 'food' ? 'Courses' : 'Pours', align: 'right' as const,
      cell: r => <span style={{ color: UXP.ink3 }}>{r.item_count}</span> },
    { id: 'price', header: 'Menu price', align: 'right' as const, hideOnMobile: true,
      cell: r => <span>{r.menu_price != null ? fmtKr(r.menu_price) : (r.selling_price_ex_vat != null ? fmtKr(r.selling_price_ex_vat) : '—')}</span> },
    { id: 'cost', header: 'Food cost', align: 'right' as const, hideOnMobile: true,
      cell: r => <span>{r.food_cost != null ? fmtKr(r.food_cost) : '—'}</span> },
    { id: 'costpct', header: 'Cost %', align: 'right' as const, hideOnMobile: true,
      cell: r => <span style={{ color: r.cost_pct == null ? UXP.ink3 : (r.cost_pct >= 35 ? UXP.coral : UXP.ink2) }}>
        {r.incomplete ? '—' : (r.cost_pct != null ? `${r.cost_pct.toFixed(1)} %` : '—')}
      </span> },
    { id: 'gp', header: 'GP %', align: 'right' as const,
      cell: r => r.incomplete ? (
        <span style={{ display: 'inline-block', padding: '2px 8px',
                       background: '#fef3e0', color: UXP.coral,
                       fontSize: 10, fontWeight: 600, borderRadius: 6 }}>Incomplete</span>
      ) : r.gp_pct != null ? (
        <span style={{ color: r.gp_pct < 65 ? UXP.coral : UXP.greenDeep, fontWeight: 500 }}>
          {r.gp_pct.toFixed(1)} %
          {r.gp_kr != null && (
            <span style={{ display: 'block', fontSize: 10, color: UXP.ink4, fontWeight: 400, marginTop: 1 }}>
              {fmtKr(r.gp_kr)}
            </span>
          )}
        </span>
      ) : <span style={{ color: UXP.ink3 }}>—</span>,
    },
  ]

  return (
    <AppShell>
      <PageContainer>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>Set menus</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
              Fixed-price packages built from existing recipes. Food and drinks
              tracked separately — pick the courses (or pours), set the menu
              price, and see GP% recompute live from the underlying recipe costs.
            </p>
          </div>
          <button
            onClick={createMenu}
            disabled={!bizId || busy}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 5,
              cursor: bizId && !busy ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
              opacity: bizId ? 1 : 0.5,
            }}
          >
            + New {view === 'food' ? 'food menu' : 'drink menu'}
          </button>
        </div>

        {bizId && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            <ViewPill active={view === 'food'}  onClick={() => setView('food')}  label="Food menus"  count={foodCount} />
            <ViewPill active={view === 'drink'} onClick={() => setView('drink')} label="Drink menus" count={drinkCount} />
          </div>
        )}

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}
        {!bizId && (
          <div style={emptyCard}>Select a business in the sidebar to load its menus.</div>
        )}
        {bizId && loading && <div style={emptyCard}>Loading…</div>}
        {bizId && !loading && filtered.length === 0 && !error && (
          <div style={emptyCard}>
            No {view === 'food' ? 'food' : 'drink'} menus yet. Click the button above to create one.
          </div>
        )}

        {filtered.length > 0 && (
          <DataTable<MenuRow>
            data={filtered}
            columns={cols}
            getKey={r => r.id}
            onRowClick={r => router.push(`/inventory/recipes/menus/${r.id}`)}
            style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}
          />
        )}
      </PageContainer>
    </AppShell>
  )
}

function ViewPill({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '5px 12px', fontSize: 12, fontWeight: active ? 600 : 500,
        background: active ? UXP.lavDeep : 'transparent',
        color: active ? '#fff' : UXP.ink3,
        border: `0.5px solid ${active ? UXP.lavDeep : UXP.border}`,
        borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
      }}>
      {label} <span style={{ opacity: 0.7, fontWeight: 400, marginLeft: 4 }}>{count}</span>
    </button>
  )
}

const emptyCard: React.CSSProperties = {
  padding: 24, background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
  borderRadius: 8, color: UXP.ink3, fontSize: 13, textAlign: 'center' as const,
}
