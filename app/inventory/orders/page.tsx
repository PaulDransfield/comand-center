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
import { useViewport, useIsMobile } from '@/lib/hooks/useViewport'
import { unitFamily, convertQuantity } from '@/lib/inventory/unit-conversion'

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
  // Mobile-first layout gate. Tablet/desktop (≥ 768) get the existing
  // two-pane source picker + table; mobile gets the redesigned column
  // (intro pill, compact generator card, supplier sections with
  // prominent Copy buttons, image-aligned rows with pack chips).
  const isMobile = useIsMobile()

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
    // Success feedback is rendered inline by the supplier card's
    // "Copied ✓" state — replaces the prior window.alert so the chef
    // isn't blocked by a dialog. The empty-state alert above stays
    // because it's a corrective warning, not a confirmation.
  }

  return (
    <AppShell>
      <PageContainer>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
              Order list
            </h1>
            {/* Mobile gets a one-line pill so the generator + supplier
                sections sit near the top without scrolling past the
                description. Tablet / desktop keep the full paragraph. */}
            {isMobile ? (
              <div style={{
                display: 'inline-flex', alignItems: 'center',
                marginTop: 6,
                padding: '4px 10px',
                background: UXP.lavFill,
                border: `0.5px solid ${UXP.lavMid}`,
                borderRadius: 999,
                fontSize: 11, color: UXP.lavText, fontWeight: 600,
              }}>
                Need is a guide, not a target — you decide
              </div>
            ) : (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
                Aggregates raw ingredients from your prep session(s) and any pre-orders for the date range,
                groups them by the supplier you usually buy from. <strong>Needed is a guide, not a target</strong> —
                fill in the order quantity yourself based on what you already have and how much spare you want.
              </p>
            )}
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
            {/* Source picker — wraps to single column on mobile via flex.
                On mobile we tighten the chrome (compact lavender card,
                12-px label hierarchy) so the generator + sources sit
                close to the top above the supplier sections. */}
            <div style={{
              background: isMobile ? UXP.lavFill : UXP.cardBg,
              border: `0.5px solid ${isMobile ? UXP.lavMid : UXP.border}`,
              borderRadius: isMobile ? UXP.r_lg : 8,
              padding: isMobile ? 12 : 14,
              marginBottom: 14,
              display: 'flex', flexWrap: 'wrap' as const,
              gap: isMobile ? 10 : 14,
              alignItems: 'flex-start',
              boxShadow: isMobile ? UXP.shadowSoft : undefined,
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
                ...(isMobile
                  ? {
                      flex: '1 1 100%',     // full-width on mobile
                      padding: '12px 16px',
                      fontSize: 14, fontWeight: 700,
                      minHeight: 48,
                    }
                  : {
                      alignSelf: 'flex-end' as const,
                    }),
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

  // Brief in-card "Copied ✓" feedback so the chef sees confirmation
  // without the disruptive window.alert that the desktop path uses. The
  // underlying copySupplier handler is unchanged.
  const [justCopied, setJustCopied] = useState(false)
  const handleCopy = () => {
    onCopy()
    setJustCopied(true)
    window.setTimeout(() => setJustCopied(false), 2000)
  }
  const itemCount = rows.length

  return (
    <div style={{
      background: UXP.cardBg,
      border: `0.5px solid ${UXP.border}`,
      borderRadius: isMobile ? UXP.r_lg : 8,
      boxShadow: isMobile ? UXP.shadowSoft : undefined,
      overflow: 'hidden' as const,
    }}>
      {/* Supplier header — name + item-count chip + prominent Copy button.
          On mobile the Copy button is sized for thumbs (≥ 44 px tall) and
          its "Copied ✓" state replaces the modal alert. */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 10,
        padding: isMobile ? '12px 14px' : '10px 14px',
        background: UXP.subtleBg,
        borderBottom: `0.5px solid ${UXP.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: isMobile ? 14 : 12,
            fontWeight: 600,
            color: UXP.ink1,
            overflowWrap: 'break-word' as const,
            minWidth: 0,
          }}>
            {supplier}
          </div>
          <div style={{ fontSize: 11, color: UXP.ink4, flexShrink: 0 }}>
            · {itemCount} item{itemCount === 1 ? '' : 's'}
          </div>
        </div>
        <button
          onClick={handleCopy}
          style={isMobile
            ? {
                padding: '10px 14px', minHeight: 44,
                fontSize: 13, fontWeight: 700,
                background: justCopied ? UXP.greenFill : UXP.lavDeep,
                color:      justCopied ? UXP.greenDeep : '#fff',
                border:     'none',
                borderRadius: UXP.r_md,
                cursor: 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap' as const,
                flexShrink: 0,
                transition: 'background-color 150ms ease, color 150ms ease',
              }
            : {
                ...smallBtn,
                background: justCopied ? UXP.greenFill : UXP.lavFill,
                color:      justCopied ? UXP.greenDeep : UXP.lavText,
                borderColor: justCopied ? UXP.green     : UXP.lavMid,
                transition: 'background-color 150ms ease, color 150ms ease',
              }
          }
          title="Copy filled order lines to clipboard"
        >
          {justCopied ? 'Copied ✓' : (isMobile ? 'Copy order' : 'Copy for chat/email')}
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

// Mobile card — redesign:
//   top row     thumbnail (40 px slot, always present) | name (full-wrap) | × remove
//   below name  "Need 4 kg · Pack 5 kg" reference line
//   order qty   free-text input (chef writes "2 jars" / "10 kg" / "1 box")
//   pack chips  ≈ N quick-fill tappable chips, ONLY when need/pack units are
//               comparable (mass↔mass / volume↔volume) via convertQuantity.
//               When they differ: "units differ — you decide", no chips.
//   notes       collapsed behind "+ Add note" so the card stays scannable.
function OrderRowCard({ row, thumbUrl, onChange, onRemove }: {
  row:      LocalRow
  thumbUrl: string | null | undefined
  onChange: (key: string, patch: Partial<LocalRow>) => void
  onRemove: (key: string) => void
}) {
  const [notesOpen, setNotesOpen] = useState(!!row.notes.trim())

  // Pack comparability — uses the canonical helper so semantics never
  // drift from the cost engine / prep engine.
  const pack = useMemo(() => {
    if (row.needed_qty == null || row.needed_qty <= 0) return { kind: 'no_need' as const }
    if (row.pack_size == null || row.pack_size <= 0 || !row.pack_unit) return { kind: 'no_pack' as const }
    const need = convertQuantity(row.needed_qty, row.unit, row.pack_unit)
    const sameFamily = unitFamily(row.unit) && unitFamily(row.unit) === unitFamily(row.pack_unit)
    if (need == null || !sameFamily) return { kind: 'unit_mismatch' as const }
    const n = Math.max(1, Math.ceil(need / row.pack_size))
    return { kind: 'ok' as const, n, packsLabelOne: `${n} packs`, packsLabelTwo: `${n + 1} packs` }
  }, [row.needed_qty, row.unit, row.pack_size, row.pack_unit])

  return (
    <div style={{
      padding: 12,
      borderTop: `0.5px solid ${UXP.border}`,
      display: 'flex', flexDirection: 'column' as const, gap: 10,
    }}>
      {/* Top row: thumbnail slot + name + remove */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <ThumbSlot url={row.is_custom ? null : thumbUrl} alt={row.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {row.is_custom ? (
            <input
              type="text"
              value={row.name}
              onChange={e => onChange(row.key, { name: e.target.value })}
              placeholder="Ingredient / item"
              style={{ ...inputStyle, fontSize: 15, padding: '10px 12px', minHeight: 44 }}
            />
          ) : (
            <div style={{
              fontSize: 15, fontWeight: 600, color: UXP.ink1, lineHeight: 1.3,
              overflowWrap: 'break-word' as const, wordBreak: 'break-word' as const,
            }}>
              {row.name}
            </div>
          )}
          {/* "Need 4 kg · Pack 5 kg" reference line */}
          {!row.is_custom && (
            <div style={{ fontSize: 12, color: UXP.ink3, marginTop: 4, lineHeight: 1.4 }}>
              {row.needed_qty != null
                ? <><span style={{ color: UXP.ink2 }}>Need </span><strong style={{ color: UXP.ink1, fontVariantNumeric: 'tabular-nums' }}>{row.needed_qty} {row.unit}</strong></>
                : <span>No prep input</span>}
              {row.pack_size != null && row.pack_unit && (
                <>
                  <span style={{ color: UXP.ink4 }}> · </span>
                  <span style={{ color: UXP.ink2 }}>Pack </span>
                  <strong style={{ color: UXP.ink1, fontVariantNumeric: 'tabular-nums' }}>{row.pack_size} {row.pack_unit}</strong>
                </>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => onRemove(row.key)}
          style={{
            background: 'none', border: 'none', color: UXP.ink3,
            cursor: 'pointer', fontSize: 22, padding: 0,
            minWidth: 36, minHeight: 36,
            flexShrink: 0,
            marginTop: -4,
          }}
          aria-label="Remove"
        >
          ×
        </button>
      </div>

      {/* Order qty — the line the chef actually fills in. */}
      <div>
        <div style={{ ...smallLabel, marginBottom: 6 }}>Order qty</div>
        <input
          type="text"
          value={row.order_qty}
          onChange={e => onChange(row.key, { order_qty: e.target.value })}
          placeholder='e.g. "2 jars" / "10 kg" / "1 box"'
          style={{ ...inputStyle, fontSize: 16, padding: '10px 12px', minHeight: 44 }}
        />
        {/* Pack quick-fill chips — only when units are comparable. Honest:
            when they differ we say so + show no chips so the chef isn't
            tempted to trust a fabricated conversion. */}
        {pack.kind === 'ok' && (
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: UXP.ink4 }}>≈</span>
            <button
              type="button"
              onClick={() => onChange(row.key, { order_qty: pack.packsLabelOne })}
              style={chipStyle}
            >
              {pack.packsLabelOne}
            </button>
            <button
              type="button"
              onClick={() => onChange(row.key, { order_qty: pack.packsLabelTwo })}
              style={chipStyle}
            >
              {pack.packsLabelTwo}
            </button>
          </div>
        )}
        {pack.kind === 'unit_mismatch' && (
          <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 8 }}>
            Need ({row.unit}) and pack ({row.pack_unit}) units differ — you decide.
          </div>
        )}
      </div>

      {/* Notes — collapsed behind "+ Add note" so the card stays scannable. */}
      {notesOpen ? (
        <div>
          <div style={{ ...smallLabel, marginBottom: 6 }}>Notes</div>
          <input
            type="text"
            value={row.notes}
            onChange={e => onChange(row.key, { notes: e.target.value })}
            placeholder="Optional notes"
            style={{ ...inputStyle, fontSize: 14, padding: '10px 12px', minHeight: 44 }}
            autoFocus={!row.notes.trim()}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setNotesOpen(true)}
          style={{
            alignSelf: 'flex-start' as const,
            background: 'transparent', border: 'none', padding: 0,
            fontFamily: 'inherit', cursor: 'pointer',
            fontSize: 12, color: UXP.lavText, fontWeight: 600,
          }}
        >
          + Add note
        </button>
      )}
    </div>
  )
}

// Always-present 40 px thumbnail slot. Renders the existing supplier-
// article image when the row has one (same URL source the desktop view
// uses), otherwise a neutral fallback tile with a muted package glyph.
// The slot's outer size never changes so rows align cleanly down the
// supplier card.
function ThumbSlot({ url, alt }: { url: string | null | undefined; alt: string }) {
  if (url) {
    return <ProductThumb url={url} size="md" alt={alt} />
  }
  return (
    <div
      style={{
        width: 40, height: 40,
        background:   UXP.subtleBg,
        border:       `0.5px solid ${UXP.border}`,
        borderRadius: 5,
        flexShrink:   0,
        display:      'flex',
        alignItems:   'center',
        justifyContent: 'center',
        color:        UXP.ink4,
      }}
      aria-hidden="true"
    >
      {/* Inline package SVG — neutral, no dependency on emoji rendering. */}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    </div>
  )
}

const chipStyle: React.CSSProperties = {
  padding: '6px 12px', minHeight: 32,
  background: UXP.lavFill,
  color: UXP.lavText,
  border: `0.5px solid ${UXP.lavMid}`,
  borderRadius: 999,
  fontSize: 12, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
  whiteSpace: 'nowrap' as const,
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
