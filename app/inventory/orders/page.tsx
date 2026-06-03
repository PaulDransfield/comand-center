'use client'
// app/inventory/orders/page.tsx
//
// Order list — a smart shopping guide derived from prep sessions and
// pre-orders. The needed-qty column is a GUIDE only; the order qty is
// left empty by default for the chef to fill in based on what they
// already have and how much spare they want. No stock-on-hand math is
// done v1 — that's Phase 2 once we trust the stock signal.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { ProductThumb } from '@/components/ui/ProductThumb'
import { PageContainer } from '@/components/ui/Layout'
import { useViewport } from '@/lib/hooks/useViewport'

interface OrderItem {
  product_id:              string
  name:                    string | null
  category:                string | null
  needed_qty:              number
  unit:                    string
  pack_size:               number | null
  base_unit:               string | null
  invoice_unit:            string | null
  latest_supplier_name:    string | null
  latest_supplier_number:  string | null
  source_count:            number
}
interface PrepSessionStub { id: string; name: string | null; created_at: string; completed_at: string | null }
interface BuildResponse {
  items:         OrderItem[]
  uncertainties: Array<{ kind: string; reason: string }>
}
interface LocalRow {
  // Key: the product_id for catalogue items, a generated id for ad-hoc.
  key:                string
  is_custom:          boolean
  name:               string
  needed_qty:         number | null     // null for ad-hoc lines (no prep input)
  unit:               string
  pack_size:          number | null
  pack_unit:          string | null     // base_unit for catalogue items; just informational
  supplier:           string            // editable
  order_qty:          string            // text input (chef writes "2 jars", "10 kg" — kept loose)
  notes:              string
  removed:            boolean
}

function makeRowsFromBuild(b: BuildResponse | null): LocalRow[] {
  if (!b) return []
  return b.items.map(it => ({
    key:        it.product_id,
    is_custom:  false,
    name:       it.name ?? it.product_id.slice(0, 8),
    needed_qty: it.needed_qty,
    unit:       it.unit,
    pack_size:  it.pack_size,
    pack_unit:  it.base_unit ?? it.invoice_unit ?? null,
    supplier:   it.latest_supplier_name ?? '',
    order_qty:  '',          // ← Owner-mandated: empty default, chef fills.
    notes:      '',
    removed:    false,
  }))
}

const today = () => new Date().toISOString().slice(0, 10)
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}

export default function OrderListPage() {
  const [bizId, setBizId] = useState<string | null>(null)
  const [activeSessions, setActiveSessions] = useState<PrepSessionStub[]>([])
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState<string>(today())
  const [dateTo,   setDateTo]   = useState<string>(addDays(today(), 6))
  const [build, setBuild] = useState<BuildResponse | null>(null)
  const [rows, setRows] = useState<LocalRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Supplier-article thumbs — cross-customer cached images keyed by
  // product_id (LocalRow.key for catalogue items). Silent fallback when
  // none. Ad-hoc rows (is_custom) carry no product_id and get no thumb.
  const [imageByProduct, setImageByProduct] = useState<Record<string, string | null>>({})

  // Sidebar biz.
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

  // Load any active prep session(s) for this biz so chef can opt in.
  const loadSessions = useCallback(async () => {
    if (!bizId) return
    try {
      const r = await fetch(`/api/inventory/prep-sessions?business_id=${encodeURIComponent(bizId)}&active=1`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const { sessions } = await r.json()
      setActiveSessions(sessions ?? [])
      // Default-select the only active session if there is one.
      if ((sessions ?? []).length === 1) setSelectedSessionIds(new Set([sessions[0].id]))
    } catch (e: any) {
      setError(e.message)
    }
  }, [bizId])
  useEffect(() => { if (bizId) loadSessions() }, [bizId, loadSessions])

  const generate = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/inventory/orders/build', {
        method:  'POST',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          business_id:         bizId,
          prep_session_ids:    [...selectedSessionIds],
          pre_order_date_from: dateFrom,
          pre_order_date_to:   dateTo,
        }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const data = await r.json() as BuildResponse
      setBuild(data)
      setRows(makeRowsFromBuild(data))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [bizId, selectedSessionIds, dateFrom, dateTo])

  // Batch-fetch supplier-article thumbnails for catalogue rows in the
  // current build. One round-trip per build. is_custom rows skipped —
  // their `key` is a `custom-<rand>` synthetic, not a product_id.
  useEffect(() => {
    const ids = rows.filter(r => !r.is_custom).map(r => r.key)
    if (ids.length === 0) return
    const ctrl = new AbortController()
    fetch('/api/inventory/supplier-article/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_ids: ids }),
      cache: 'no-store',
      signal: ctrl.signal,
    })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!j?.by_product) return
        const next: Record<string, string | null> = {}
        for (const pid of ids) next[pid] = j.by_product[pid]?.image_url ?? null
        setImageByProduct(next)
      })
      .catch(() => {/* silent */})
    return () => ctrl.abort()
  }, [build])

  // Group rows by supplier for the rendered list.
  const visibleRows = rows.filter(r => !r.removed)
  const grouped = useMemo(() => {
    const m = new Map<string, LocalRow[]>()
    for (const r of visibleRows) {
      const sup = r.supplier?.trim() || 'No supplier'
      const list = m.get(sup) ?? []
      list.push(r)
      m.set(sup, list)
    }
    // Stable supplier order: alphabetical, "No supplier" last.
    return [...m.entries()].sort(([a], [b]) => {
      if (a === 'No supplier') return 1
      if (b === 'No supplier') return -1
      return a.localeCompare(b)
    })
  }, [visibleRows])

  const updateRow = (key: string, patch: Partial<LocalRow>) => {
    setRows(prev => prev.map(r => r.key === key ? { ...r, ...patch } : r))
  }
  const removeRow = (key: string) => updateRow(key, { removed: true })
  const addCustom = () => {
    const newKey = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setRows(prev => [...prev, {
      key:        newKey,
      is_custom:  true,
      name:       '',
      needed_qty: null,
      unit:       '',
      pack_size:  null,
      pack_unit:  null,
      supplier:   '',
      order_qty:  '',
      notes:      '',
      removed:    false,
    }])
  }

  // Copy a supplier's list to clipboard as plain text the chef can
  // paste into WhatsApp / email. Skips rows without order_qty filled.
  const copySupplier = (supplier: string, supplierRows: LocalRow[]) => {
    const lines = supplierRows
      .filter(r => r.order_qty.trim().length > 0)
      .map(r => {
        const noteStr = r.notes.trim() ? ` — ${r.notes.trim()}` : ''
        return `${r.order_qty.trim()} × ${r.name}${noteStr}`
      })
    if (lines.length === 0) {
      window.alert('Fill in order quantities first — empty lines are skipped from the copy.')
      return
    }
    const header = `Order for ${supplier}\n${'-'.repeat(20)}\n`
    navigator.clipboard.writeText(header + lines.join('\n'))
    // Quick feedback. Toast pattern not worth pulling in for one line.
    window.alert(`${lines.length} line(s) copied — paste into your supplier's chat or email.`)
  }

  return (
    <AppShell>
      <PageContainer>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
              Order list
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
              Aggregates raw ingredients from your prep session(s) and any pre-orders for the date range,
              groups them by the supplier you usually buy from. <strong>Needed is a guide, not a target</strong> —
              fill in the order quantity yourself based on what you already have and how much spare you want.
            </p>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {!bizId && (
          <div style={emptyCard}>Select a business in the sidebar to load order sources.</div>
        )}

        {bizId && (
          <>
            {/* Source picker — wraps to single column on mobile via flex */}
            <div style={{
              background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
              borderRadius: 8, padding: 14, marginBottom: 14,
              display: 'flex', flexWrap: 'wrap' as const, gap: 14, alignItems: 'flex-start',
            }}>
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={smallLabel}>Active prep session(s)</div>
                {activeSessions.length === 0 ? (
                  <div style={{ fontSize: 11, color: UXP.ink4 }}>
                    No active session. Build one on <a href="/inventory/recipes/prep" style={{ color: UXP.lavText }}>the prep page</a> first.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                    {activeSessions.map(s => {
                      const checked = selectedSessionIds.has(s.id)
                      return (
                        <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: UXP.ink2, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedSessionIds(prev => {
                                const next = new Set(prev)
                                if (checked) next.delete(s.id); else next.add(s.id)
                                return next
                              })
                            }}
                          />
                          {s.name || 'Today’s prep'} <span style={{ color: UXP.ink4 }}>· started {s.created_at.slice(0, 10)}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={smallLabel}>Pre-orders date range</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: UXP.ink3 }}>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                         style={{ ...inputStyle, fontSize: 11, padding: '4px 6px' }} />
                  <span>to</span>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                         style={{ ...inputStyle, fontSize: 11, padding: '4px 6px' }} />
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4 }}>
                  Default is today + 7 days.
                </div>
              </div>
              <button onClick={generate} disabled={loading} style={{
                ...primaryBtn,
                opacity: loading ? 0.6 : 1, cursor: loading ? 'wait' as const : 'pointer' as const,
                alignSelf: 'flex-end' as const,
              }}>
                {loading ? 'Generating…' : 'Generate list'}
              </button>
            </div>

            {/* Uncertainties surfaced loudly so chef knows what's missing. */}
            {build && build.uncertainties.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ ...smallLabel, color: UXP.coral }}>Flags · {build.uncertainties.length}</div>
                <div style={{
                  padding: '8px 12px', background: '#fef3e0',
                  border: `0.5px solid ${UXP.coral}33`, borderRadius: 6,
                  fontSize: 11, color: UXP.ink2, lineHeight: 1.5,
                }}>
                  {build.uncertainties.map((u, i) => <div key={i}>• {u.reason}</div>)}
                </div>
              </div>
            )}

            {/* Items list */}
            {build && rows.length === 0 && (
              <div style={emptyCard}>
                No items aggregated yet. Pick a prep session or set a date range, then click Generate.
              </div>
            )}
            {visibleRows.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16, marginBottom: 14 }}>
                {grouped.map(([supplier, supplierRows]) => (
                  <SupplierGroup
                    key={supplier}
                    supplier={supplier}
                    rows={supplierRows}
                    imageByProduct={imageByProduct}
                    onChange={updateRow}
                    onRemove={removeRow}
                    onCopy={() => copySupplier(supplier, supplierRows)}
                  />
                ))}
              </div>
            )}

            {build && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <button onClick={addCustom} style={secondaryBtn}>
                  + Add custom line
                </button>
                <div style={{ fontSize: 10, color: UXP.ink4 }}>
                  {visibleRows.length} item(s) · {grouped.length} supplier(s)
                </div>
              </div>
            )}
          </>
        )}
      </PageContainer>
    </AppShell>
  )
}

function SupplierGroup({
  supplier, rows, imageByProduct, onChange, onRemove, onCopy,
}: {
  supplier: string
  rows: LocalRow[]
  imageByProduct: Record<string, string | null>
  onChange: (key: string, patch: Partial<LocalRow>) => void
  onRemove: (key: string) => void
  onCopy: () => void
}) {
  const tier = useViewport()
  const isMobile = tier === 'mobile'
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 14px', background: UXP.subtleBg, borderBottom: `0.5px solid ${UXP.border}`,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: UXP.ink1 }}>{supplier}</div>
        <button onClick={onCopy} style={smallBtn} title="Copy filled order lines to clipboard">
          Copy for chat/email
        </button>
      </div>

      {/* Column headers only render on desktop/tablet — mobile cards label inline */}
      {!isMobile && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 80px 100px 100px 1fr 24px',
          gap: 8, padding: '6px 14px', fontSize: 9, color: UXP.ink4,
          fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' as const,
          background: UXP.cardBg, borderBottom: `0.5px solid ${UXP.border}`,
        }}>
          <div>Item</div>
          <div style={{ textAlign: 'right' as const }}>Need</div>
          <div>Pack</div>
          <div>Order</div>
          <div>Notes</div>
          <div />
        </div>
      )}

      {rows.map(r => isMobile ? (
        <OrderRowCard
          key={r.key}
          row={r}
          thumbUrl={imageByProduct[r.key]}
          onChange={onChange}
          onRemove={onRemove}
        />
      ) : (
        <div key={r.key} style={{
          display: 'grid', gridTemplateColumns: '1fr 80px 100px 100px 1fr 24px',
          gap: 8, padding: '8px 14px', alignItems: 'center',
          borderTop: `0.5px solid ${UXP.border}`,
        }}>
          {/* Name — editable for ad-hoc lines; static for catalogue items.
              Catalogue rows render the canonical supplier-article thumb
              left of the name when one is available. */}
          {r.is_custom ? (
            <input
              type="text"
              value={r.name}
              onChange={e => onChange(r.key, { name: e.target.value })}
              placeholder="Ingredient / item"
              style={{ ...inputStyle, fontSize: 11, padding: '4px 8px' }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <ProductThumb url={imageByProduct[r.key]} size="sm" />
              <div style={{ fontSize: 12, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}
                   title={r.name}>
                {r.name}
              </div>
            </div>
          )}

          {/* Need — read-only guide. Empty for ad-hoc lines. */}
          <div style={{ fontSize: 11, color: UXP.ink2, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>
            {r.needed_qty != null ? `${r.needed_qty} ${r.unit}` : '—'}
          </div>

          {/* Pack — informational hint. */}
          <div style={{ fontSize: 10, color: UXP.ink4 }}>
            {r.pack_size != null && r.pack_unit ? `${r.pack_size} ${r.pack_unit}` : ''}
          </div>

          {/* Order — loose text input (chef writes "2 jars" / "10 kg" / "1 box"). */}
          <input
            type="text"
            value={r.order_qty}
            onChange={e => onChange(r.key, { order_qty: e.target.value })}
            placeholder="—"
            style={{ ...inputStyle, fontSize: 11, padding: '4px 8px',
                     textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}
          />

          {/* Notes — supplier instructions, fridge constraints, etc. */}
          <input
            type="text"
            value={r.notes}
            onChange={e => onChange(r.key, { notes: e.target.value })}
            placeholder="Optional notes"
            style={{ ...inputStyle, fontSize: 11, padding: '4px 8px' }}
          />

          <button onClick={() => onRemove(r.key)}
                  style={{ background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontSize: 14, padding: 0 }}
                  aria-label="Remove">×</button>
        </div>
      ))}
    </div>
  )
}

// Mobile card: name on top with thumb + remove on right, then a 2-col
// grid for needed/pack/order/notes. Larger inputs since touch targets
// matter more than density here.
function OrderRowCard({ row, thumbUrl, onChange, onRemove }: {
  row:      LocalRow
  thumbUrl: string | null | undefined
  onChange: (key: string, patch: Partial<LocalRow>) => void
  onRemove: (key: string) => void
}) {
  return (
    <div style={{
      padding: 10, borderTop: `0.5px solid ${UXP.border}`,
      display: 'flex', flexDirection: 'column' as const, gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {!row.is_custom && <ProductThumb url={thumbUrl} size="sm" />}
        <div style={{ flex: 1, minWidth: 0 }}>
          {row.is_custom ? (
            <input
              type="text"
              value={row.name}
              onChange={e => onChange(row.key, { name: e.target.value })}
              placeholder="Ingredient / item"
              style={{ ...inputStyle, fontSize: 13, padding: '6px 10px' }}
            />
          ) : (
            <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1, wordBreak: 'break-word' as const }}>
              {row.name}
            </div>
          )}
        </div>
        <button onClick={() => onRemove(row.key)}
                style={{ background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontSize: 18, padding: '4px 8px' }}
                aria-label="Remove">×</button>
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: UXP.ink3 }}>
        <span><strong style={{ color: UXP.ink2 }}>Need:</strong> {row.needed_qty != null ? `${row.needed_qty} ${row.unit}` : '—'}</span>
        {row.pack_size != null && row.pack_unit && (
          <span><strong style={{ color: UXP.ink2 }}>Pack:</strong> {row.pack_size} {row.pack_unit}</span>
        )}
      </div>
      <div>
        <div style={{ ...smallLabel, marginBottom: 4 }}>Order qty</div>
        <input
          type="text"
          value={row.order_qty}
          onChange={e => onChange(row.key, { order_qty: e.target.value })}
          placeholder='e.g. "2 jars" / "10 kg" / "1 box"'
          style={{ ...inputStyle, fontSize: 13, padding: '6px 10px' }}
        />
      </div>
      <div>
        <div style={{ ...smallLabel, marginBottom: 4 }}>Notes</div>
        <input
          type="text"
          value={row.notes}
          onChange={e => onChange(row.key, { notes: e.target.value })}
          placeholder="Optional notes"
          style={{ ...inputStyle, fontSize: 13, padding: '6px 10px' }}
        />
      </div>
    </div>
  )
}

const smallLabel: React.CSSProperties = {
  fontSize: 10, color: UXP.ink4, fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6,
}
const emptyCard: React.CSSProperties = {
  padding: 24, textAlign: 'center' as const, background: UXP.subtleBg,
  border: `0.5px dashed ${UXP.border}`, borderRadius: 8,
  color: UXP.ink3, fontSize: 13,
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box' as const, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit',
  border: `0.5px solid ${UXP.border}`, borderRadius: 5, color: UXP.ink1, background: '#fff',
}
const secondaryBtn: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 500,
  background: 'transparent', color: UXP.ink3, border: `0.5px solid ${UXP.border}`,
  borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
const primaryBtn: React.CSSProperties = {
  padding: '6px 14px', fontSize: 12, fontWeight: 600,
  background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 5,
  cursor: 'pointer', fontFamily: 'inherit',
}
const smallBtn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 10, fontWeight: 500,
  background: UXP.lavFill, color: UXP.lavText, border: `0.5px solid ${UXP.lavMid}`,
  borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
}
