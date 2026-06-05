'use client'
// app/inventory/recipes/menus/[id]/page.tsx
//
// Set menu editor. Header carries name + price + VAT + GP summary;
// body is the course list (each row a recipe with qty + per-line cost).
// Add-course picker filters by menu.type (food menus take food recipes,
// drink menus take drink recipes).

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { PageContainer } from '@/components/ui/Layout'
import { fmtKr } from '@/lib/format'

interface MenuItem {
  id:                    string
  recipe_id:             string
  recipe_name:           string
  recipe_type:           string | null
  recipe_image:          string | null
  course_position:       number
  qty:                   number
  note:                  string | null
  food_cost_per_portion: number
  line_food_cost:        number
  incomplete:            boolean
}
interface Menu {
  id: string; name: string; type: 'food' | 'drink'
  selling_price_ex_vat: number | null
  menu_price: number | null
  vat_rate: number | null
  channel: 'dine_in' | 'takeaway' | null
  notes: string | null
}
interface Summary {
  item_count: number
  food_cost: number
  gp_kr: number | null
  gp_pct: number | null
  cost_pct: number | null
  incomplete: boolean
}

interface RecipeOption { id: string; name: string; type: string | null }

export default function MenuEditorPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const menuId = String(params?.id ?? '')

  const [menu, setMenu] = useState<Menu | null>(null)
  const [items, setItems] = useState<MenuItem[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [recipeOptions, setRecipeOptions] = useState<RecipeOption[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setMenu(j.menu); setItems(j.items ?? []); setSummary(j.summary)
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [menuId])

  useEffect(() => { if (menuId) load() }, [menuId, load])

  // Load recipe picker options when picker opens.
  useEffect(() => {
    if (!picker || !menu) return
    const bizId = typeof window !== 'undefined' ? localStorage.getItem('cc_selected_biz') : null
    if (!bizId) return
    fetch(`/api/inventory/recipes?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        const DRINK = new Set(['cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free'])
        const all: RecipeOption[] = (j.recipes ?? []).map((r: any) => ({ id: r.id, name: r.name, type: r.type }))
        const filtered = all.filter(r => {
          const isDrink = DRINK.has(String(r.type ?? '').toLowerCase())
          return menu.type === 'drink' ? isDrink : !isDrink
        })
        setRecipeOptions(filtered)
      })
      .catch(() => {})
  }, [picker, menu])

  async function patchMenu(patch: Record<string, any>) {
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function addCourse(recipeId: string) {
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}/items`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipe_id: recipeId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setPicker(false); setPickerQuery('')
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function patchItem(itemId: string, patch: Record<string, any>) {
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}/items/${itemId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function deleteItem(itemId: string) {
    if (!window.confirm('Remove this course?')) return
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}/items/${itemId}`, { method: 'DELETE', cache: 'no-store' })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function deleteMenu() {
    if (!window.confirm('Archive this menu? It will be hidden from the list but its data is preserved.')) return
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}`, { method: 'DELETE', cache: 'no-store' })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      router.push('/inventory/recipes/menus')
    } catch (e: any) { alert(e.message) }
  }

  const filteredOptions = recipeOptions.filter(r =>
    !pickerQuery.trim() || r.name.toLowerCase().includes(pickerQuery.toLowerCase()),
  )

  return (
    <AppShell>
      <PageContainer>
        <button onClick={() => router.push('/inventory/recipes/menus')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 12, padding: 0, marginBottom: 10, fontFamily: 'inherit' }}>
          ← Back to set menus
        </button>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}
        {loading && <div style={{ padding: 24, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>}

        {menu && !loading && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <input
                  defaultValue={menu.name}
                  onBlur={e => { if (e.target.value.trim() !== menu.name) patchMenu({ name: e.target.value.trim() }) }}
                  style={{ ...inputStyle, fontSize: 22, fontWeight: 600, color: UXP.ink1, width: '100%', border: 'none', padding: 0, background: 'transparent' }}
                />
                <div style={{ fontSize: 12, color: UXP.ink3, marginTop: 4 }}>
                  {menu.type === 'food' ? 'Food menu' : 'Drink menu'} · {items.length} course{items.length === 1 ? '' : 's'}
                </div>
              </div>
              <button onClick={deleteMenu}
                style={{ padding: '6px 12px', fontSize: 11, background: 'transparent', color: UXP.coral, border: `0.5px solid ${UXP.coral}`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>
                Archive menu
              </button>
            </div>

            {/* Cost summary strip */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16, padding: '14px 16px', background: UXP.subtleBg, borderRadius: 8 }}>
              <Stat label="Food cost"  value={summary ? fmtKr(summary.food_cost) : '—'} />
              <Stat label="Cost %"     value={summary?.incomplete ? '—' : (summary?.cost_pct != null ? `${summary.cost_pct.toFixed(1)} %` : '—')} />
              <Stat label="GP %"       value={summary?.incomplete ? '—' : (summary?.gp_pct != null ? `${summary.gp_pct.toFixed(1)} %` : '—')}
                    color={summary?.gp_pct != null ? (summary.gp_pct < 65 ? UXP.coral : UXP.greenDeep) : undefined} />
              <Stat label="GP kr"      value={summary?.incomplete ? '—' : (summary?.gp_kr != null ? fmtKr(summary.gp_kr) : '—')} />
              <Stat label="Menu price" value={menu.menu_price != null ? fmtKr(menu.menu_price) : (menu.selling_price_ex_vat != null ? fmtKr(menu.selling_price_ex_vat) : '—')} />
            </div>

            {/* Price + VAT editor */}
            <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, marginBottom: 8 }}>Price & VAT</div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <Field label="Price ex-VAT">
                  <input type="number" min="0" step="0.01" defaultValue={menu.selling_price_ex_vat ?? ''}
                    onBlur={e => {
                      const v = e.target.value.trim() === '' ? null : Number(e.target.value)
                      if (v !== menu.selling_price_ex_vat) patchMenu({ selling_price_ex_vat: v })
                    }} style={{ ...inputStyle, width: 110 }} />
                </Field>
                <Field label="Menu price (inc-VAT)">
                  <input type="number" min="0" step="1" defaultValue={menu.menu_price ?? ''}
                    onBlur={e => {
                      const v = e.target.value.trim() === '' ? null : Number(e.target.value)
                      if (v !== menu.menu_price) patchMenu({ menu_price: v })
                    }} style={{ ...inputStyle, width: 110 }} />
                </Field>
                <Field label="VAT %">
                  <select defaultValue={menu.vat_rate ?? 12}
                    onChange={e => patchMenu({ vat_rate: Number(e.target.value) })}
                    style={{ ...inputStyle, width: 80 }}>
                    <option value="6">6 %</option>
                    <option value="12">12 %</option>
                    <option value="25">25 %</option>
                  </select>
                </Field>
                <Field label="Channel">
                  <select defaultValue={menu.channel ?? 'dine_in'}
                    onChange={e => patchMenu({ channel: e.target.value })}
                    style={{ ...inputStyle, width: 110 }}>
                    <option value="dine_in">Dine-in</option>
                    <option value="takeaway">Takeaway</option>
                  </select>
                </Field>
              </div>
            </div>

            {/* Courses */}
            <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: `0.5px solid ${UXP.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2 }}>Courses</div>
                <button onClick={() => setPicker(true)}
                  style={{ padding: '4px 10px', fontSize: 11, background: UXP.lavMid, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}>
                  + Add {menu.type === 'food' ? 'course' : 'pour'}
                </button>
              </div>
              {items.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
                  No {menu.type === 'food' ? 'courses' : 'pours'} yet. Add one to start building the menu.
                </div>
              )}
              {items.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: UXP.subtleBg }}>
                      <Th label="#" />
                      <Th label="Recipe" />
                      <Th label="Qty" align="right" />
                      <Th label="Cost / portion" align="right" />
                      <Th label="Line cost" align="right" />
                      <Th label="" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={it.id} style={{ borderTop: `0.5px solid ${UXP.border}` }}>
                        <td style={td}>{idx + 1}</td>
                        <td style={td}>
                          <div style={{ color: UXP.ink1, fontWeight: 500 }}>{it.recipe_name}</div>
                          {it.recipe_type && <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>{it.recipe_type}</div>}
                          {it.incomplete && <div style={{ fontSize: 10, color: UXP.coral, marginTop: 1 }}>Incomplete cost</div>}
                        </td>
                        <td style={{ ...td, textAlign: 'right' as const }}>
                          <input type="number" min="0.01" step="0.5" defaultValue={it.qty}
                            onBlur={e => { const v = Number(e.target.value); if (v > 0 && v !== it.qty) patchItem(it.id, { qty: v }) }}
                            style={{ ...inputStyle, width: 70, textAlign: 'right' as const }} />
                        </td>
                        <td style={numTd}>{fmtKr(it.food_cost_per_portion)}</td>
                        <td style={numTd}>{fmtKr(it.line_food_cost)}</td>
                        <td style={{ ...td, textAlign: 'right' as const }}>
                          <button onClick={() => deleteItem(it.id)}
                            style={{ background: 'transparent', border: 'none', color: UXP.ink4, cursor: 'pointer', fontSize: 14, padding: 0 }} aria-label="Remove">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {/* Course picker modal */}
        {picker && menu && (
          <div style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div style={{ background: '#fff', borderRadius: 8, maxWidth: 520, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: `0.5px solid ${UXP.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1 }}>
                  Add {menu.type === 'food' ? 'a course' : 'a pour'}
                </div>
                <button onClick={() => { setPicker(false); setPickerQuery('') }}
                  style={{ background: 'transparent', border: 'none', color: UXP.ink3, fontSize: 18, cursor: 'pointer', padding: 0 }}>×</button>
              </div>
              <div style={{ padding: 12, borderBottom: `0.5px solid ${UXP.border}` }}>
                <input
                  type="text" autoFocus placeholder={menu.type === 'food' ? 'Search food recipes…' : 'Search drink recipes…'}
                  value={pickerQuery} onChange={e => setPickerQuery(e.target.value)}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div style={{ overflowY: 'auto' as const, flex: 1 }}>
                {filteredOptions.length === 0 && (
                  <div style={{ padding: 16, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12 }}>No matching recipes.</div>
                )}
                {filteredOptions.map(r => (
                  <button key={r.id} onClick={() => addCourse(r.id)}
                    style={{ display: 'block', width: '100%', textAlign: 'left' as const, padding: '10px 16px', background: 'transparent', border: 'none', borderBottom: `0.5px solid ${UXP.border}`, cursor: 'pointer', fontFamily: 'inherit' }}>
                    <div style={{ fontSize: 12, color: UXP.ink1, fontWeight: 500 }}>{r.name}</div>
                    {r.type && <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>{r.type}</div>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    </AppShell>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: UXP.ink4, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: color ?? UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}
function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return (
    <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, textAlign: align }}>{label}</th>
  )
}
const inputStyle: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12, border: `0.5px solid ${UXP.border}`, borderRadius: 4,
  background: '#fff', color: UXP.ink1, fontFamily: 'inherit', outline: 'none',
}
const td: React.CSSProperties = { padding: '10px 12px', fontSize: 12, color: UXP.ink2 }
const numTd: React.CSSProperties = { ...td, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1 }
