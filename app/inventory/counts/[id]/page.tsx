'use client'
// app/inventory/counts/[id]/page.tsx
//
// Mobile-first count walk. Designed for a phone in one hand and a
// shelf in the other:
//   · Big tap targets (44px+ inputs)
//   · One row per product, full-width
//   · Quantity input → unit dropdown side-by-side
//   · Save-on-blur per row (no submit button per row)
//   · Sticky footer with progress: lines counted / total products + total value
//   · Category sections collapsible so you can focus on one shelf
//
// Both cost-at-time-of-count AND current cost shown — when they differ
// the row highlights so owner can spot recent price moves.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Row {
  product_id:             string
  product_name:           string
  category:               string
  invoice_unit:           string | null
  base_unit:              string | null
  pack_size:              number | null
  default_supplier:       string | null
  is_recipe_sourced:      boolean
  current_unit_price_sek: number | null
  saved: {
    line_id:                string
    quantity:               number
    unit:                   string
    unit_price_at_count:    number | null
    line_value_at_count:    number | null
    invoice_unit_at_count:  string | null
    pack_size_at_count:     number | null
    base_unit_at_count:     string | null
    notes:                  string | null
    updated_at:             string
    current_line_value:     number | null
  } | null
}

interface DetailResponse {
  count: {
    id:                   string
    business_id:          string
    count_date:           string
    location_id:          string | null
    location_name:        string | null
    notes:                string | null
    completed_at:         string | null
    total_value_at_count: number | null
    total_lines:          number
  }
  rows:   Row[]
  totals: {
    snapshot_value: number
    current_value:  number
    lines_counted:  number
    products_total: number
  }
}

// Unit options per row — owner can switch. Per req: "let owner switch unit per row"
const UNIT_OPTIONS = ['g', 'kg', 'ml', 'cl', 'dl', 'l', 'st', 'portion', 'pack', 'paket', 'frp']

export default function CountDetailPage() {
  const params  = useParams() as { id: string }
  const router  = useRouter()
  const [data,    setData]    = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<'all' | 'unsaved' | 'saved'>('all')
  const [search,  setSearch]  = useState('')
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({})

  // Add-article-while-counting: create a product not yet in the catalogue
  // without leaving the count. Reuses POST /api/inventory/items; the count
  // GET returns ALL products, so a reload surfaces the new one ready to count.
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCat,  setAddCat]  = useState('food')
  const [addUnit, setAddUnit] = useState('')
  const [addPack, setAddPack] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addErr,  setAddErr]  = useState<string | null>(null)

  const lbl: React.CSSProperties = {
    display: 'block', fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: UXP.ink4, margin: '10px 0 4px',
  }
  const inp: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 13, color: UXP.ink1,
    border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit',
    boxSizing: 'border-box',
  }

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/counts/${params.id}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [params.id])
  useEffect(() => { load() }, [load])

  async function patchLine(productId: string, patch: { quantity?: number; unit?: string; delete?: boolean }) {
    const r = await fetch(`/api/inventory/counts/${params.id}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: { product_id: productId, ...patch } }),
    })
    if (!r.ok) { alert((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return }
    load()
  }

  async function complete() {
    if (!data) return
    const unsaved = data.totals.products_total - data.totals.lines_counted
    if (unsaved > 0) {
      if (!confirm(`Complete this count? ${unsaved} product(s) have no count yet — they'll be excluded from the snapshot value. You can re-open by creating a new count later.`)) return
    } else {
      if (!confirm('Complete this count? After completion lines are locked.')) return
    }
    const r = await fetch(`/api/inventory/counts/${params.id}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complete: true }),
    })
    if (!r.ok) { alert((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return }
    load()
  }

  async function addProduct() {
    const bizId = data?.count.business_id
    if (!bizId || !addName.trim()) { setAddErr('Name is required'); return }
    setAddBusy(true); setAddErr(null)
    try {
      const r = await fetch('/api/inventory/items', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: bizId,
          name:        addName.trim(),
          category:    addCat,
          unit:        addUnit.trim() || null,
          pack_size:   addPack.trim() || null,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setShowAdd(false); setAddName(''); setAddUnit(''); setAddPack(''); setAddCat('food')
      load()   // new product shows up in the rows, ready to count
    } catch (e: any) {
      setAddErr(e.message)
    } finally {
      setAddBusy(false)
    }
  }

  async function archive() {
    if (!confirm('Archive this count? It hides from the list (lines stay in DB for audit).')) return
    const r = await fetch(`/api/inventory/counts/${params.id}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archive: true }),
    })
    if (!r.ok) { alert((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return }
    router.push('/inventory/counts')
  }

  const filteredRows = useMemo(() => {
    if (!data) return []
    let rows = data.rows
    if (filter === 'unsaved') rows = rows.filter(r => !r.saved)
    if (filter === 'saved')   rows = rows.filter(r => r.saved)
    if (search) {
      const s = search.toLowerCase()
      rows = rows.filter(r => r.product_name.toLowerCase().includes(s))
    }
    return rows
  }, [data, filter, search])

  // Group by category for shelf-walking
  const byCategory = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of filteredRows) {
      const cat = r.category ?? 'other'
      if (!m.has(cat)) m.set(cat, [])
      m.get(cat)!.push(r)
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [filteredRows])

  if (loading) return <AppShell><div style={{ padding: 30, color: UXP.ink3 }}>Loading…</div></AppShell>
  if (error)   return <AppShell><div style={{ padding: 30, color: UXP.roseText }}>{error}</div></AppShell>
  if (!data)   return null

  const { count, totals } = data
  const completed = !!count.completed_at
  const progressPct = totals.products_total > 0 ? (totals.lines_counted / totals.products_total) * 100 : 0

  return (
    <AppShell>
      <div style={{ maxWidth: 760, padding: '12px 14px', paddingBottom: 120 }}>
        {/* Header */}
        <button onClick={() => router.push('/inventory/counts')}
          style={{ background: 'transparent', border: 'none', color: UXP.ink3, fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: 10 }}>
          ← Back to counts
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>
              {count.location_name ?? 'Global count'} · {count.count_date}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: UXP.ink1, marginTop: 2 }}>
              Stock count
              {completed && <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 8px', background: UXP.greenFill, color: UXP.greenDeep, borderRadius: 4, fontWeight: 600, letterSpacing: '0.04em' }}>COMPLETED</span>}
            </div>
          </div>
          {!completed && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setShowAdd(true); setAddErr(null) }} style={{
                padding: '6px 10px', fontSize: 11, fontWeight: 600,
                background: UXP.lavDeep, color: '#fff',
                border: 'none', borderRadius: 5,
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
              }}>+ Add article</button>
              <button onClick={archive} style={{
                padding: '6px 10px', fontSize: 11, fontWeight: 500,
                background: 'transparent', color: UXP.roseText,
                border: `0.5px solid ${UXP.rose}`, borderRadius: 5,
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
              }}>Discard</button>
            </div>
          )}
        </div>

        {/* Add-article modal */}
        {showAdd && (
          <>
            <div onClick={() => setShowAdd(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 199 }} />
            <div style={{
              position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              background: '#fff', borderRadius: 12, width: 400, maxWidth: '94vw', zIndex: 200,
              padding: 22, boxShadow: '0 25px 60px rgba(0,0,0,0.3)', border: `1px solid ${UXP.border}`,
            }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: UXP.ink1 }}>Add article</h2>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: UXP.ink3 }}>Adds it to the catalogue and this count.</p>
              <label style={lbl}>Name</label>
              <input autoFocus value={addName} onChange={e => setAddName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addProduct() }}
                placeholder="e.g. Olivolja extra virgin 5l" style={inp} />
              <label style={lbl}>Category</label>
              <select value={addCat} onChange={e => setAddCat(e.target.value)} style={inp}>
                {['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>Unit (optional)</label>
                  <input value={addUnit} onChange={e => setAddUnit(e.target.value)} placeholder="kg / l / st" style={inp} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>Pack size (optional)</label>
                  <input value={addPack} onChange={e => setAddPack(e.target.value)} placeholder="e.g. 5" style={inp} />
                </div>
              </div>
              {addErr && <div style={{ color: UXP.roseText, fontSize: 12, marginTop: 8 }}>{addErr}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button onClick={() => setShowAdd(false)}
                  style={{ padding: '7px 14px', fontSize: 12, background: 'transparent', color: UXP.ink2, border: `0.5px solid ${UXP.border}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Cancel
                </button>
                <button onClick={addProduct} disabled={addBusy}
                  style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 6, cursor: addBusy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                  {addBusy ? 'Adding…' : 'Add article'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Progress bar */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: UXP.ink3, marginBottom: 4 }}>
            <span>{totals.lines_counted} / {totals.products_total} counted</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(completed ? (count.total_value_at_count ?? 0) : totals.snapshot_value)}</span>
          </div>
          <div style={{ height: 4, background: UXP.subtleBg, borderRadius: 2, overflow: 'hidden' as const }}>
            <div style={{ height: '100%', width: `${progressPct}%`, background: UXP.lavDeep, transition: 'width 200ms' }} />
          </div>
        </div>

        {/* Filter chips + search */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' as const, alignItems: 'center' }}>
          {(['all', 'unsaved', 'saved'] as const).map(k => (
            <button key={k} onClick={() => setFilter(k)} style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 500,
              background: filter === k ? UXP.lavFill : 'transparent',
              color: filter === k ? UXP.lavText : UXP.ink3,
              border: `0.5px solid ${filter === k ? UXP.lavMid : UXP.border}`,
              borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
            }}>
              {k === 'all' ? `All (${data.rows.length})`
               : k === 'unsaved' ? `Not counted (${data.rows.filter(r => !r.saved).length})`
               : `Counted (${totals.lines_counted})`}
            </button>
          ))}
          <input type="search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Filter…"
            style={{
              marginLeft: 'auto', padding: '6px 10px', fontSize: 12,
              background: '#fff', border: `0.5px solid ${UXP.border}`,
              borderRadius: 6, color: UXP.ink1, fontFamily: 'inherit',
              minWidth: 140,
            }} />
        </div>

        {/* Category sections */}
        {byCategory.map(([cat, rows]) => {
          const isOpen = openCats[cat] !== false  // default open
          return (
            <div key={cat} style={{ marginBottom: 12, background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <button onClick={() => setOpenCats(o => ({ ...o, [cat]: !isOpen }))}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', padding: '10px 14px',
                  background: UXP.subtleBg, border: 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: UXP.ink2,
                  letterSpacing: '0.04em', textTransform: 'uppercase' as const,
                }}>
                <span>{cat} · {rows.length}</span>
                <span style={{ fontSize: 14, color: UXP.ink4 }}>{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && rows.map(r => (
                <CountRow key={r.product_id} row={r} disabled={completed} onPatch={(p) => patchLine(r.product_id, p)} />
              ))}
            </div>
          )
        })}

        {filteredRows.length === 0 && (
          <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13,
                        background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8 }}>
            {search || filter !== 'all' ? 'No matching products.' : 'No products in catalogue yet.'}
          </div>
        )}
      </div>

      {/* Sticky footer — totals + complete button */}
      <div style={{
        position: 'fixed' as const, bottom: 0, left: 0, right: 0,
        background: '#fff', borderTop: `0.5px solid ${UXP.border}`,
        padding: '12px 16px',
        boxShadow: '0 -4px 16px rgba(58,53,80,0.08)',
        zIndex: 50,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            Snapshot
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
            {fmtKr(completed ? (count.total_value_at_count ?? 0) : totals.snapshot_value)}
          </div>
          {!completed && (
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
              Live: <span style={{ color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(totals.current_value)}</span>
            </div>
          )}
        </div>
        {!completed && (
          <button onClick={complete} disabled={totals.lines_counted === 0}
            style={{
              padding: '12px 24px', fontSize: 13, fontWeight: 600,
              background: totals.lines_counted === 0 ? UXP.subtleBg : UXP.lavDeep,
              color: totals.lines_counted === 0 ? UXP.ink4 : '#fff',
              border: 'none', borderRadius: 5,
              cursor: totals.lines_counted === 0 ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}>
            Complete count
          </button>
        )}
      </div>
    </AppShell>
  )
}

// ── Single product row — mobile-first ─────────────────────────────────
function CountRow({ row, disabled, onPatch }: {
  row: Row
  disabled: boolean
  onPatch: (p: { quantity?: number; unit?: string; delete?: boolean }) => void
}) {
  const initialUnit = row.saved?.unit ?? row.invoice_unit ?? 'st'
  const [qty,  setQty]  = useState(row.saved?.quantity != null ? String(row.saved.quantity) : '')
  const [unit, setUnit] = useState(initialUnit)
  useEffect(() => {
    setQty(row.saved?.quantity != null ? String(row.saved.quantity) : '')
    setUnit(row.saved?.unit ?? row.invoice_unit ?? 'st')
  }, [row.saved?.quantity, row.saved?.unit, row.invoice_unit])

  function saveIfChanged() {
    const trimmed = qty.trim()
    if (trimmed === '' && row.saved) {
      onPatch({ delete: true })
      return
    }
    if (trimmed === '') return
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    if (n === row.saved?.quantity && unit === row.saved.unit) return
    onPatch({ quantity: n, unit })
  }

  const isCounted = !!row.saved
  const drift = row.saved?.line_value_at_count != null && row.saved?.current_line_value != null
    ? Math.abs(row.saved.current_line_value - row.saved.line_value_at_count)
    : 0
  const driftSignificant = drift > 0.5  // 50 öre

  return (
    <div style={{
      padding: '12px 14px',
      borderTop: `0.5px solid ${UXP.borderSoft}`,
      background: isCounted ? UXP.cardBg : '#fff',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>
            {row.product_name}
            {row.is_recipe_sourced && (
              <span style={{
                marginLeft: 6, fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                padding: '1px 6px', background: UXP.lavFill, color: UXP.lavText,
                borderRadius: 3, textTransform: 'uppercase' as const,
              }}>RECIPE</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
            {row.current_unit_price_sek != null
              ? `${fmtKr(row.current_unit_price_sek)}/${row.invoice_unit ?? '?'}${row.pack_size ? ` · ${row.pack_size}${row.base_unit ?? ''}/pack` : ''}`
              : 'no price yet'}
          </div>
        </div>
        {isCounted && (
          <div style={{ textAlign: 'right' as const, minWidth: 80 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
              {row.saved?.line_value_at_count != null ? fmtKr(row.saved.line_value_at_count) : '—'}
            </div>
            {driftSignificant && row.saved?.current_line_value != null && (
              <div style={{ fontSize: 9, color: UXP.coral, fontVariantNumeric: 'tabular-nums' as const, marginTop: 1 }}
                   title={`Current price would value this at ${fmtKr(row.saved.current_line_value)}`}>
                live: {fmtKr(row.saved.current_line_value)}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input type="number" min="0" step="0.001"
          value={qty} disabled={disabled}
          onChange={e => setQty(e.target.value)}
          onBlur={saveIfChanged}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          inputMode="decimal"
          placeholder="0"
          style={{
            flex: 1, padding: '10px 14px',
            fontSize: 16, fontFamily: 'inherit',
            border: `0.5px solid ${isCounted ? UXP.lavMid : UXP.border}`,
            borderRadius: 6, color: UXP.ink1, background: '#fff',
            textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const,
            minHeight: 44,
          }} />
        <select value={unit} disabled={disabled}
          onChange={e => { setUnit(e.target.value); if (qty.trim()) onPatch({ quantity: Number(qty), unit: e.target.value }) }}
          style={{
            padding: '10px 8px',
            fontSize: 14, fontFamily: 'inherit',
            border: `0.5px solid ${UXP.border}`, borderRadius: 6,
            background: '#fff', color: UXP.ink1,
            minWidth: 80, minHeight: 44,
          }}>
          {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
    </div>
  )
}
