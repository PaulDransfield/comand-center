'use client'
// app/inventory/sales/page.tsx
//
// Manual weekly POS sales entry. Feeds the variance loop (theoretical
// vs actual food cost) — see POS-RECIPE-MAPPING-PLAN.md. Future POS
// connectors will write pos_sales rows automatically; this page is for
// restaurants without a connectable POS.
//
// Layout:
//   - Header: business + week-window selector (default = last 6 weeks)
//   - "+ Add menu item" → modal with name + recipe-picker
//   - Grid: rows = menu items, columns = weeks (Monday-Sunday).
//     Each cell is an editable quantity input; saves on blur.
//   - Footer: per-week totals + theoretical food-cost preview when
//     recipes are mapped.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface RecipeRef {
  id:          string
  name:        string
  food_cost:   number | null   // per portion, kr
  portions:    number | null
  menu_price?: number | null
}
interface MenuItem {
  id:            string
  name:          string
  pos_provider:  string
  recipe_id:     string | null
  price_inc_vat: number | null
  recipe?:       RecipeRef | null
}
interface Sale {
  id:          string
  pos_item_id: string
  sold_date:   string   // YYYY-MM-DD (Monday for manual entries)
  quantity:    number
  net_revenue: number | null
}

// Weeks shown in the entry grid (most recent first).
const WEEKS_TO_SHOW = 6

export default function SalesPage() {
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [items,    setItems]    = useState<MenuItem[]>([])
  const [sales,    setSales]    = useState<Sale[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [adding,   setAdding]   = useState(false)
  // Track in-flight save indicator per cell key (`${itemId}_${weekStart}`)
  const [saving,   setSaving]   = useState<Record<string, boolean>>({})

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() {
      const next = localStorage.getItem('cc_selected_biz')
      if (next) setBizId(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Build the list of week-start dates (Mondays) to show.
  const weeks = useMemo(() => buildWeeks(WEEKS_TO_SHOW), [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const from = weeks[weeks.length - 1]   // oldest week
      const to   = isoToday()
      const [itemsRes, salesRes] = await Promise.all([
        fetch(`/api/inventory/pos-menu-items?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' }),
        fetch(`/api/inventory/pos-sales?business_id=${encodeURIComponent(bizId)}&from=${from}&to=${to}`, { cache: 'no-store' }),
      ])
      if (!itemsRes.ok) throw new Error((await itemsRes.json().catch(() => ({}))).error ?? `HTTP ${itemsRes.status}`)
      if (!salesRes.ok) throw new Error((await salesRes.json().catch(() => ({}))).error ?? `HTTP ${salesRes.status}`)
      const itemsJson = await itemsRes.json()
      const salesJson = await salesRes.json()
      setItems(itemsJson.items ?? [])
      setSales(salesJson.sales ?? [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId, weeks])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  // Map for O(1) cell lookup
  const salesByKey = useMemo(() => {
    const m = new Map<string, Sale>()
    for (const s of sales) m.set(`${s.pos_item_id}_${s.sold_date}`, s)
    return m
  }, [sales])

  async function saveCell(itemId: string, weekStart: string, qty: number) {
    if (!bizId) return
    const key = `${itemId}_${weekStart}`
    setSaving(s => ({ ...s, [key]: true }))
    try {
      const r = await fetch('/api/inventory/pos-sales', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        cache:   'no-store',
        body:    JSON.stringify({ business_id: bizId, pos_item_id: itemId, week_start: weekStart, quantity: qty }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(`Save failed: ${j.error ?? r.status}`)
      } else {
        await load()
      }
    } finally {
      setSaving(s => { const next = { ...s }; delete next[key]; return next })
    }
  }

  async function addItem(name: string, recipeId: string | null) {
    if (!bizId) return
    const r = await fetch('/api/inventory/pos-menu-items', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      cache:   'no-store',
      body:    JSON.stringify({ business_id: bizId, name, recipe_id: recipeId }),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      throw new Error(j.error ?? `HTTP ${r.status}`)
    }
    setAdding(false)
    await load()
  }

  async function deleteItem(id: string) {
    if (!confirm('Archive this menu item? Past sales stay attached for historical reports.')) return
    const r = await fetch(`/api/inventory/pos-menu-items/${id}`, { method: 'DELETE', cache: 'no-store' })
    if (r.ok) await load()
  }

  // KPIs
  const totalItems       = items.length
  const itemsMapped      = items.filter(i => i.recipe_id).length
  const totalSalesUnits  = sales.reduce((s, x) => s + Number(x.quantity ?? 0), 0)
  const totalRevenue     = sales.reduce((s, x) => s + Number(x.net_revenue ?? 0), 0)
  const theoreticalCost  = sales.reduce((s, x) => {
    const item = items.find(i => i.id === x.pos_item_id)
    const perPortion = item?.recipe?.food_cost ?? 0
    return s + Number(x.quantity ?? 0) * Number(perPortion ?? 0)
  }, 0)

  return (
    <AppShell>
      <div style={{ maxWidth: 1280, padding: '20px 24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Sales (manual entry)</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
              Enter weekly sales per menu item. Maps to recipes for theoretical food-cost calc.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 500,
              background: UXP.ink1, color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >+ Add menu item</button>
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          <Kpi label="Menu items" value={`${totalItems}`} sub={`${itemsMapped} mapped to recipes`} />
          <Kpi label={`Units sold (${WEEKS_TO_SHOW}w)`} value={totalSalesUnits.toFixed(0)} />
          <Kpi label={`Revenue (${WEEKS_TO_SHOW}w)`} value={totalRevenue > 0 ? fmtKr(totalRevenue) : '—'} />
          <Kpi label={`Theoretical food cost (${WEEKS_TO_SHOW}w)`} value={theoreticalCost > 0 ? fmtKr(theoreticalCost) : '—'} sub="from recipe mappings" />
        </div>

        {error && (
          <div style={{ padding: 12, background: UXP.roseFill, color: UXP.roseText, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            {error}
          </div>
        )}

        {loading && !items.length && <div style={{ fontSize: 12, color: UXP.ink3 }}>Loading…</div>}

        {!loading && items.length === 0 && (
          <Empty>
            No menu items yet. Click <strong>+ Add menu item</strong> to add the dishes you sell.
            Mapping each to a recipe unlocks theoretical food-cost calc.
          </Empty>
        )}

        {/* Entry grid */}
        {items.length > 0 && (
          <div style={{
            border: `0.5px solid ${UXP.border}`,
            borderRadius: 8,
            overflow: 'hidden',
            background: UXP.cardBg,
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'inherit' }}>
                <thead>
                  <tr style={{ background: UXP.subtleBg, borderBottom: `0.5px solid ${UXP.border}` }}>
                    <th style={th(240, true)}>Menu item</th>
                    <th style={th(140, true)}>Recipe</th>
                    {weeks.map(w => (
                      <th key={w} style={th(80)}>{weekLabel(w)}</th>
                    ))}
                    <th style={th(40)}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.id} style={{ borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
                      <td style={td(true)}>
                        <div style={{ fontWeight: 500, color: UXP.ink1 }}>{item.name}</div>
                        {item.price_inc_vat != null && (
                          <div style={{ fontSize: 10, color: UXP.ink4 }}>{fmtKr(item.price_inc_vat)} inc VAT</div>
                        )}
                      </td>
                      <td style={td(true)}>
                        {item.recipe ? (
                          <span style={{
                            display: 'inline-block', padding: '2px 8px',
                            background: UXP.lavFill, color: UXP.lavText,
                            borderRadius: 999, fontSize: 10,
                          }}>{item.recipe.name}</span>
                        ) : (
                          <RecipePicker
                            currentRecipeId={item.recipe_id}
                            itemId={item.id}
                            businessId={bizId!}
                            onMapped={() => load()}
                          />
                        )}
                      </td>
                      {weeks.map(w => {
                        const key = `${item.id}_${w}`
                        const sale = salesByKey.get(key)
                        return (
                          <td key={w} style={{ ...td(false), textAlign: 'right' }}>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              defaultValue={sale ? String(sale.quantity) : ''}
                              placeholder="—"
                              onBlur={e => {
                                const raw = e.currentTarget.value.trim()
                                const next = raw === '' ? null : Number(raw)
                                const prev = sale?.quantity ?? null
                                if (next === prev) return
                                if (next == null || !Number.isFinite(next)) return
                                saveCell(item.id, w, next)
                              }}
                              style={{
                                width: 64, padding: '3px 6px',
                                fontSize: 12, textAlign: 'right',
                                border: `0.5px solid ${saving[key] ? UXP.lav : UXP.borderSoft}`,
                                borderRadius: 3,
                                background: 'transparent', color: UXP.ink1,
                                fontVariantNumeric: 'tabular-nums',
                                fontFamily: 'inherit',
                              }}
                            />
                          </td>
                        )
                      })}
                      <td style={{ ...td(false), textAlign: 'center' }}>
                        <button
                          type="button"
                          onClick={() => deleteItem(item.id)}
                          title="Archive menu item"
                          style={{
                            padding: 0, background: 'transparent', border: 'none',
                            cursor: 'pointer', fontSize: 14, color: UXP.ink4,
                          }}
                        >×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p style={{ fontSize: 11, color: UXP.ink4, marginTop: 14, lineHeight: 1.6 }}>
          Tip: enter ANY positive number to save a cell; leave blank to mean "not entered". Cells save automatically when you tab/click away.
          Once you have 2-3 weeks of data + a stock count, <a href="/inventory/variance" style={{ color: UXP.lavText, textDecoration: 'underline' }}>/inventory/variance</a> will show theoretical vs actual food cost — the shrinkage signal.
        </p>
      </div>

      {adding && bizId && (
        <AddItemModal
          businessId={bizId}
          onClose={() => setAdding(false)}
          onSave={addItem}
        />
      )}
    </AppShell>
  )
}

// ── Recipe picker (inline) ────────────────────────────────────────────
function RecipePicker({
  currentRecipeId, itemId, businessId, onMapped,
}: {
  currentRecipeId: string | null
  itemId:          string
  businessId:      string
  onMapped:        () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open || query.trim().length < 1) { setResults([]); return }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/inventory/recipes/search?business_id=${encodeURIComponent(businessId)}&q=${encodeURIComponent(query)}&limit=8`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setResults(j.recipes ?? [])
    }, 200)
    return () => clearTimeout(t)
  }, [open, query, businessId])

  async function pick(recipeId: string) {
    await fetch(`/api/inventory/pos-menu-items/${itemId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      cache:   'no-store',
      body:    JSON.stringify({ recipe_id: recipeId }),
    })
    setOpen(false)
    setQuery('')
    onMapped()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          fontSize: 10, color: UXP.ink3, background: 'transparent',
          border: `0.5px dashed ${UXP.border}`, borderRadius: 999,
          padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >Map recipe…</button>
    )
  }
  return (
    <div style={{ position: 'relative' as const }}>
      <input
        autoFocus
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder="Search recipes…"
        style={{
          width: 130, padding: '3px 6px', fontSize: 11,
          border: `0.5px solid ${UXP.lav}`, borderRadius: 3,
          fontFamily: 'inherit',
        }}
      />
      {results.length > 0 && (
        <div style={{
          position: 'absolute' as const, top: '100%', left: 0,
          background: '#fff', border: `0.5px solid ${UXP.border}`,
          borderRadius: 4, marginTop: 2, zIndex: 10,
          width: 240, maxHeight: 240, overflowY: 'auto' as const,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
          {results.map(r => (
            <button
              key={r.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); pick(r.id) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left' as const,
                padding: '6px 10px', fontSize: 11, color: UXP.ink1,
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >{r.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Add-item modal ────────────────────────────────────────────────────
function AddItemModal({
  businessId, onClose, onSave,
}: {
  businessId: string
  onClose:    () => void
  onSave:     (name: string, recipeId: string | null) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [recipeId, setRecipeId] = useState<string | null>(null)
  const [recipeName, setRecipeName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true); setErr(null)
    try {
      await onSave(name.trim(), recipeId)
    } catch (e: any) { setErr(e.message); setSaving(false) }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed' as const, inset: 0, background: 'rgba(20,18,40,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16,
    }}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={{
        width: 'min(480px, 100%)', background: '#fff', borderRadius: 8, padding: 20,
        boxShadow: '0 20px 60px rgba(0,0,0,0.40)',
      }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 500, color: UXP.ink1 }}>Add menu item</h3>
        <label style={{ display: 'block', fontSize: 11, color: UXP.ink3, marginBottom: 4 }}>Name</label>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Margherita pizza, Caesar salad"
          style={{
            width: '100%', padding: '6px 10px', fontSize: 13,
            border: `0.5px solid ${UXP.border}`, borderRadius: 4,
            fontFamily: 'inherit', marginBottom: 14,
          }}
        />
        <label style={{ display: 'block', fontSize: 11, color: UXP.ink3, marginBottom: 4 }}>Recipe (optional — can map later)</label>
        <RecipeSelectorInline
          businessId={businessId}
          currentName={recipeName}
          onPick={(id, n) => { setRecipeId(id); setRecipeName(n) }}
        />
        {err && <div style={{ fontSize: 11, color: UXP.roseText, marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onClose} style={btnSecondary()}>Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} style={btnPrimary()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}

function RecipeSelectorInline({
  businessId, currentName, onPick,
}: {
  businessId: string
  currentName: string | null
  onPick: (id: string, name: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (query.trim().length < 1) { setResults([]); return }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/inventory/recipes/search?business_id=${encodeURIComponent(businessId)}&q=${encodeURIComponent(query)}&limit=8`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setResults(j.recipes ?? [])
    }, 200)
    return () => clearTimeout(t)
  }, [query, businessId])
  return (
    <div>
      <input
        type="text"
        value={currentName ?? query}
        onChange={e => { setQuery(e.target.value) }}
        placeholder="Search recipes…"
        style={{
          width: '100%', padding: '6px 10px', fontSize: 13,
          border: `0.5px solid ${UXP.border}`, borderRadius: 4,
          fontFamily: 'inherit',
        }}
      />
      {results.length > 0 && (
        <div style={{ marginTop: 4, border: `0.5px solid ${UXP.border}`, borderRadius: 4, background: '#fff' }}>
          {results.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => { onPick(r.id, r.name); setResults([]); setQuery('') }}
              style={{
                display: 'block', width: '100%', textAlign: 'left' as const,
                padding: '6px 10px', fontSize: 11, color: UXP.ink1,
                background: 'transparent', border: 'none', borderBottom: `0.5px solid ${UXP.borderSoft}`,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >{r.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Atoms ─────────────────────────────────────────────────────────────
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
      borderRadius: 8, padding: 12,
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 500, color: UXP.ink1, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: UXP.ink3, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: 32, textAlign: 'center', fontSize: 12, color: UXP.ink3,
      background: UXP.cardBg, border: `0.5px dashed ${UXP.border}`,
      borderRadius: 8,
    }}>{children}</div>
  )
}

function th(width: number, left = false): React.CSSProperties {
  return {
    width, padding: '8px 10px',
    fontSize: 10, fontWeight: 600,
    color: UXP.ink3, textTransform: 'uppercase', letterSpacing: 0.4,
    textAlign: left ? 'left' as const : 'right' as const,
  }
}
function td(left = false): React.CSSProperties {
  return {
    padding: '6px 10px',
    fontSize: 12, color: UXP.ink1,
    textAlign: left ? 'left' as const : 'right' as const,
  }
}
function btnPrimary(): React.CSSProperties {
  return {
    padding: '6px 14px', fontSize: 12, fontWeight: 500,
    background: UXP.ink1, color: '#fff',
    border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
  }
}
function btnSecondary(): React.CSSProperties {
  return {
    padding: '6px 14px', fontSize: 12, fontWeight: 500,
    background: 'transparent', color: UXP.ink2,
    border: `0.5px solid ${UXP.border}`, borderRadius: 4,
    cursor: 'pointer', fontFamily: 'inherit',
  }
}

// ── Week helpers ──────────────────────────────────────────────────────
function buildWeeks(n: number): string[] {
  // Return n week-start dates (Mondays) starting with the current week, going back.
  const out: string[] = []
  const now = new Date()
  // Find current week's Monday (UTC).
  const day = now.getUTCDay()           // 0 = Sun, 1 = Mon … 6 = Sat
  const offsetToMon = (day === 0) ? -6 : (1 - day)
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() + offsetToMon)
  monday.setUTCHours(0, 0, 0, 0)
  for (let i = 0; i < n; i++) {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() - 7 * i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}
function weekLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  const day = d.getUTCDate()
  const month = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })
  return `${day} ${month}`
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}
