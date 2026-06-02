// components/EditItemModal.tsx
//
// Shared Edit-Item modal — mounted in both /inventory/recipes (in the
// IngredientRow expand) and /inventory/items (the article detail surface).
// One component, two mount points, single source of truth.
//
// PROPAGATION DESIGN (see docs/investigation/edit-item-modal-step1-propagation.md):
//
//   - Every cost reader in the platform calls getProductLatestPrices +
//     computeRecipeCost live on each request. No persisted recipe cost
//     anywhere outside intentional accounting snapshots (inventory_counts,
//     waste_log). So a price/waste edit propagates automatically on the
//     next render of any consumer.
//   - Article repoint is a single UPDATE on product_aliases.product_id.
//     supplier_invoice_lines link via product_alias_id; the alias→product
//     join resolves at read time. No synchronous cascade, no Save hang.
//
// HONEST-INCOMPLETE-STATE — first-class requirement (per addendum):
//   - reliability.reliable === false  → show the reason; never display a
//     confident number on top of an unreliable extraction.
//   - trend === null                  → render "ingen prishistorik", not "0,0%".

'use client'

import { useEffect, useState, useCallback } from 'react'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface EditContextResponse {
  product: {
    id: string
    name: string
    category: string | null
    invoice_unit: string | null
    pack_size: number | null
    base_unit: string | null
    default_supplier_name: string | null
    default_waste_pct: number
    price_override: number | null
    price_override_currency: string | null
    archived_at: string | null
  }
  latest_cost: {
    unit_price: number | null
    latest_price_sek: number | null
    invoice_unit: string | null
    pack_size: number | null
    base_unit: string | null
    cost_per_base_unit: number | null
    latest_date: string | null
    latest_currency: string | null
  } | null
  trend: {
    latest_price: number
    prev_price: number
    delta_pct: number
    latest_date: string
    prev_date: string
    window_days: number
    data_points: number
  } | null
  reliability: {
    reliable: boolean
    reason: string | null
    evidence: any
  }
  aliases: Array<{
    id: string
    supplier_name_snapshot: string | null
    article_number: string | null
    raw_description: string
    unit: string | null
    match_method: string
    seen_count: number
    last_seen_at: string
    latest_price: number | null
    latest_currency: string | null
    latest_date: string | null
    latest_invoice: string | null
  }>
  used_in_recipes: Array<{
    recipe_id: string
    name: string
    type: string | null
    portions: number
    direct: boolean
    direct_qty: number | null
    direct_unit: string | null
    direct_waste_pct: number | null
    transitive: boolean
  }>
}

const CATEGORIES = ['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other'] as const

export function EditItemModal({ productId, onClose, onSaved }: {
  productId: string
  onClose: () => void
  onSaved?: () => void   // called after a successful save so parent can refetch
}) {
  const [data, setData] = useState<EditContextResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/items/${productId}/edit-context`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setData(j); setEdits({})
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [productId])
  useEffect(() => { load() }, [load])

  async function save() {
    if (Object.keys(edits).length === 0) { onClose(); return }
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/items/${productId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      onSaved?.()
      onClose()
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  async function archive() {
    if (!confirm('Archive this item? Recipes that use it will show it as missing.')) return
    setBusy(true)
    try {
      await fetch(`/api/inventory/items/${productId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })
      onSaved?.()
      onClose()
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  async function disconnectAlias(aliasId: string) {
    if (!confirm('Disconnect this article? Future invoice lines from this supplier won\'t auto-link here.')) return
    try {
      const r = await fetch(`/api/inventory/product-aliases/${aliasId}/deactivate`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'owner_disconnected_via_edit_modal' }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      await load()
    } catch (e: any) { alert(e.message) }
  }

  // ── Link supplier article ────────────────────────────────────────
  // Open a sub-picker that searches supplier_invoice_lines at this
  // business and lets the owner attach one as the cost source for this
  // product. Two paths:
  //   - linkSupplierLine: line has NO alias yet — POST link-supplier-article
  //   - repointSupplierAlias: line is matched to a DIFFERENT product
  //     (duplicate-product consolidation) — POST /product-aliases/[id]/repoint
  const [linking, setLinking] = useState(false)
  async function linkSupplierLine(lineId: string) {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/items/${productId}/link-supplier-article`, {
        method:  'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ supplier_invoice_line_id: lineId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (j.error === 'alias_already_linked_to_other_product') {
          throw new Error('This supplier article is already linked to a different product. Edit that product and repoint its article first.')
        }
        throw new Error(j.error ?? `HTTP ${r.status}`)
      }
      setLinking(false)
      await load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function repointSupplierAlias(aliasId: string, fromProductName: string | null) {
    if (!confirm(`Move this supplier article from "${fromProductName ?? 'the other product'}" to this product?\n\nThe other product will lose this article's cost history. (You can repoint it back any time.)`)) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/product-aliases/${aliasId}/repoint`, {
        method:  'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ product_id: productId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setLinking(false)
      await load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const product = data?.product
  const current = { ...product, ...edits }
  const hasUnsaved = Object.keys(edits).length > 0

  return (
    <div style={backdrop} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={card}>
        {loading && <div style={{ padding: 40, color: UXP.ink3, fontSize: 13, textAlign: 'center' as const }}>Loading…</div>}
        {err && <div style={errBanner}>{err}</div>}
        {data && product && (
          <>
            <div style={{ padding: '16px 22px', borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                    {product.category ?? 'item'}
                  </div>
                  <input type="text" value={current.name ?? ''}
                    onChange={e => setEdits(p => ({ ...p, name: e.target.value }))}
                    style={{ ...nameInput, marginTop: 2 }} />
                </div>
                <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
              </div>

              {/* Cost + trend header — honest-incomplete-state baked in */}
              <CostHeader latest={data.latest_cost} trend={data.trend} reliability={data.reliability} />
            </div>

            {/* Supplier-article spec section (image + official supplier
                data — populated by the Playwright scraper that hits
                Martin Servera et al. and writes to supplier_articles).
                Silent when no scraped data exists yet. */}
            <SupplierArticleSection productId={productId} />

            <div style={{ flex: 1, overflowY: 'auto' as const, padding: '14px 22px' }}>
              {/* Two-column layout */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
                {/* LEFT — item details */}
                <div>
                  <SectionLabel>Item details</SectionLabel>
                  <Field label="Category">
                    <select value={current.category ?? 'other'}
                      onChange={e => setEdits(p => ({ ...p, category: e.target.value }))}
                      style={inputStyle}>
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="Invoice unit">
                    <input type="text" value={current.invoice_unit ?? ''}
                      onChange={e => setEdits(p => ({ ...p, invoice_unit: e.target.value }))}
                      style={inputStyle} placeholder="KG / STRYCK / L …" />
                  </Field>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <Field label="Pack size">
                      <input type="number" step="0.01" min="0" value={current.pack_size ?? ''}
                        onChange={e => setEdits(p => ({ ...p, pack_size: e.target.value === '' ? null : Number(e.target.value) }))}
                        style={inputStyle} />
                    </Field>
                    <Field label="Base unit">
                      <select value={current.base_unit ?? ''}
                        onChange={e => setEdits(p => ({ ...p, base_unit: e.target.value || null }))}
                        style={inputStyle}>
                        <option value="">—</option>
                        <option value="g">g</option>
                        <option value="ml">ml</option>
                        <option value="st">st</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="Default waste %">
                    <input type="number" step="1" min="0" max="95"
                      value={current.default_waste_pct ?? 0}
                      onChange={e => setEdits(p => ({ ...p, default_waste_pct: Number(e.target.value) }))}
                      style={inputStyle} />
                    <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 3, lineHeight: 1.4 }}>
                      Applies to NEW recipe lines added after this save. Existing recipe lines keep their own waste — change them per-line in the recipe drawer.
                    </div>
                  </Field>
                  <Field label="Price override (kr)">
                    <input type="number" step="0.01" min="0" value={current.price_override ?? ''}
                      onChange={e => setEdits(p => ({ ...p, price_override: e.target.value === '' ? null : Number(e.target.value) }))}
                      style={inputStyle} placeholder="leave empty = use supplier invoice" />
                  </Field>
                </div>

                {/* RIGHT — supplier articles + used-in-recipes */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <SectionLabel style={{ margin: 0 }}>Supplier articles ({data.aliases.length})</SectionLabel>
                    <button
                      onClick={() => setLinking(true)}
                      disabled={busy}
                      style={{
                        padding:      '3px 10px',
                        background:   UXP.lavFill,
                        color:        UXP.lavText,
                        border:       'none',
                        borderRadius: 999,
                        fontSize:     10,
                        fontWeight:   500,
                        cursor:       'pointer',
                        fontFamily:   'inherit',
                      }}
                    >+ Link article</button>
                  </div>
                  {data.aliases.length === 0 && (
                    <Empty>No supplier articles linked yet. Price comes from any override above, or stays empty until an invoice line matches. Use <strong>+ Link article</strong> to manually attach an existing supplier line.</Empty>
                  )}
                  {data.aliases.map(a => (
                    <div key={a.id} style={aliasCard}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                          {a.raw_description}
                        </div>
                        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
                          {a.supplier_name_snapshot ?? '?'} {a.article_number && `· ${a.article_number}`} · {a.match_method.replace(/_/g, ' ')} · seen {a.seen_count}×
                        </div>
                        {a.latest_price != null && (
                          <div style={{ fontSize: 10, color: UXP.ink3, marginTop: 1, fontVariantNumeric: 'tabular-nums' as const }}>
                            {fmtKr(a.latest_price)}/{a.unit ?? '?'} · last {a.latest_date}
                          </div>
                        )}
                      </div>
                      <button onClick={() => disconnectAlias(a.id)} title="Disconnect" style={tinyDangerBtn}>×</button>
                    </div>
                  ))}

                  <SectionLabel style={{ marginTop: 14 }}>Used in recipes ({data.used_in_recipes.length})</SectionLabel>
                  {data.used_in_recipes.length === 0 && (
                    <Empty>Not used in any recipe yet — no blast radius.</Empty>
                  )}
                  {data.used_in_recipes.map(u => (
                    <div key={u.recipe_id} style={recipeRow}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                          {u.name}
                          {u.transitive && !u.direct && <span style={subBadge}>via sub-recipe</span>}
                        </div>
                        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>
                          {u.type ?? 'recipe'} · {u.portions} portion{u.portions === 1 ? '' : 's'}
                          {u.direct && u.direct_qty != null && ` · ${u.direct_qty} ${u.direct_unit ?? ''}`}
                          {u.direct && (u.direct_waste_pct ?? 0) > 0 && ` · ${u.direct_waste_pct}% waste`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ padding: '10px 22px', borderTop: `0.5px solid ${UXP.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <button onClick={archive} disabled={busy} style={secondaryDangerBtn}>Archive item</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} disabled={busy} style={secondaryBtn}>Cancel</button>
                <button onClick={save} disabled={busy || !hasUnsaved} style={primaryBtn}>
                  {busy ? 'Saving…' : hasUnsaved ? 'Save changes' : 'Done'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {linking && data && (
        <LinkArticlePicker
          productId={productId}
          productName={data.product.name}
          onPick={linkSupplierLine}
          onRepoint={repointSupplierAlias}
          onClose={() => setLinking(false)}
        />
      )}
    </div>
  )
}

function CostHeader({ latest, trend, reliability }: {
  latest:      EditContextResponse['latest_cost']
  trend:       EditContextResponse['trend']
  reliability: EditContextResponse['reliability']
}) {
  // Reliability gate — if false, show the reason instead of a confident
  // number. This is the line that makes the modal honest during the
  // window where extractions are still being fixed.
  if (!reliability.reliable) {
    return (
      <div style={{ ...incompleteBox, marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: UXP.coral, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Incomplete cost
        </div>
        <div style={{ fontSize: 13, color: UXP.ink1, marginTop: 4 }}>
          {reliability.reason ?? 'Cost cannot be displayed reliably right now.'}
        </div>
      </div>
    )
  }
  // No latest cost at all — also honest absence
  if (!latest || latest.unit_price == null) {
    return (
      <div style={{ ...incompleteBox, marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink3, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          No price yet
        </div>
        <div style={{ fontSize: 13, color: UXP.ink2, marginTop: 4 }}>
          No matched supplier invoice or override. Set a price override or link an article.
        </div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 14 }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
          {fmtKr(latest.unit_price)}<span style={{ fontSize: 12, color: UXP.ink3, fontWeight: 400 }}>/{latest.invoice_unit ?? '?'}</span>
        </div>
        {latest.cost_per_base_unit != null && latest.base_unit && (
          <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2 }}>
            = {latest.cost_per_base_unit.toFixed(4)} kr/{latest.base_unit} (pack {latest.pack_size}{latest.base_unit})
          </div>
        )}
      </div>
      <div style={{ marginLeft: 'auto' }}>
        {/* Trend — null state shown as honest "ingen prishistorik" */}
        {trend ? (
          <div style={{
            fontSize: 11,
            color: trend.delta_pct > 0 ? UXP.coral : trend.delta_pct < 0 ? UXP.green : UXP.ink3,
            fontWeight: 500, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const,
          }}>
            {trend.delta_pct > 0 ? '↑' : trend.delta_pct < 0 ? '↓' : '→'} {Math.abs(trend.delta_pct).toFixed(1)}%
            <div style={{ fontSize: 9, color: UXP.ink4, fontWeight: 400 }}>vs {trend.prev_date}</div>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: UXP.ink4, fontStyle: 'italic' as const, textAlign: 'right' as const }}>
            ingen prishistorik
            <div style={{ fontSize: 9, color: UXP.ink4 }}>need 2+ purchases to compute trend</div>
          </div>
        )}
      </div>
    </div>
  )
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, color: UXP.ink3,
      letterSpacing: '0.04em', textTransform: 'uppercase' as const,
      marginBottom: 8, ...style,
    }}>{children}</div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, color: UXP.ink4, marginBottom: 3, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      {children}
    </div>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 10px', background: UXP.subtleBg, borderRadius: 6, fontStyle: 'italic' as const }}>{children}</div>
}

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
}
const card: React.CSSProperties = {
  background: '#fff', borderRadius: 12, width: 'min(880px, 100%)', maxHeight: '92vh',
  display: 'flex', flexDirection: 'column' as const, boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
  overflow: 'hidden',
}
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 22, padding: 0, lineHeight: 1 }
const errBanner: React.CSSProperties = { padding: '10px 14px', background: UXP.roseFill, color: UXP.roseText, fontSize: 12, borderRadius: 6, margin: 14 }
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12,
  background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
  borderRadius: 6, color: UXP.ink1, fontFamily: 'inherit', boxSizing: 'border-box' as const,
}
const nameInput: React.CSSProperties = {
  width: '100%', padding: '4px 0', fontSize: 18, fontWeight: 600,
  background: 'transparent', border: 'none', borderBottom: `0.5px solid transparent`,
  color: UXP.ink1, fontFamily: 'inherit', outline: 'none',
}
const incompleteBox: React.CSSProperties = {
  padding: '10px 14px', background: '#fef3e0',
  border: `0.5px solid ${UXP.coral}`, borderRadius: 8,
}
const aliasCard: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8,
  padding: '8px 10px', background: UXP.cardBg,
  border: `0.5px solid ${UXP.border}`, borderRadius: 6, marginBottom: 6,
}

// ── Link-supplier-article sub-picker ──────────────────────────────
// Owner searches supplier_invoice_lines at this business (returned
// grouped by raw_description+supplier in TWO buckets):
//   - unmatched_groups: no alias yet  → onPick → POST link-supplier-article
//   - matched_groups:   alias points at a DIFFERENT product (duplicate-
//                       product consolidation case, e.g. "Burrata 125g"
//                       vs "Mozzarella Burrata 8x125g" being two
//                       products that should be one) → onRepoint →
//                       POST /product-aliases/[id]/repoint
function LinkArticlePicker({ productId, productName, onPick, onRepoint, onClose }: {
  productId:   string
  productName: string
  onPick:      (lineId: string) => void
  onRepoint:   (aliasId: string, currentProductName: string | null) => void
  onClose:     () => void
}) {
  const [q, setQ]               = useState('')
  const [unmatched, setUnmatched] = useState<any[] | null>(null)
  const [matched,   setMatched]   = useState<any[] | null>(null)
  const [loading, setL]         = useState(false)
  const [err, setErr]           = useState<string | null>(null)

  const search = useCallback(async (query: string) => {
    setL(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/items/${productId}/link-search?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setUnmatched(Array.isArray(j.unmatched_groups) ? j.unmatched_groups : (Array.isArray(j.groups) ? j.groups : []))
      setMatched(Array.isArray(j.matched_groups) ? j.matched_groups : [])
    } catch (e: any) { setErr(e.message) } finally { setL(false) }
  }, [productId])

  // Initial search on open + on query change (debounced lightly).
  useEffect(() => {
    const t = setTimeout(() => search(q), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, search])

  const totalResults = (unmatched?.length ?? 0) + (matched?.length ?? 0)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(640px, 96vw)', maxHeight: '85vh', overflow: 'auto' as const,
        background: UXP.cardBg, borderRadius: 12, padding: 18,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: UXP.ink1 }}>Link supplier article</div>
            <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2 }}>
              Pick a supplier invoice line that represents <strong>{productName}</strong>. The link will back-fill every matching invoice line at this business so cost history populates immediately.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: UXP.ink3, fontSize: 18, cursor: 'pointer' }} aria-label="Close">×</button>
        </div>

        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search supplier invoice lines… (e.g. ruccola, parma, mozzarella)"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px',
            border: `1px solid ${UXP.border}`, borderRadius: 6, fontSize: 12, marginBottom: 10, fontFamily: 'inherit',
          }}
        />

        {loading && <div style={{ padding: 14, color: UXP.ink3, fontSize: 11 }}>Searching…</div>}
        {err && <div style={{ padding: 10, background: UXP.roseFill, color: UXP.roseText, borderRadius: 6, fontSize: 11, marginBottom: 8 }}>{err}</div>}

        {!loading && totalResults === 0 && (
          <div style={{ padding: 14, fontSize: 11, color: UXP.ink4 }}>
            No supplier lines {q ? `containing "${q}"` : ''} at this business. The supplier hasn't sent this article yet.
          </div>
        )}

        {/* Unmatched bucket — primary action: link */}
        {unmatched && unmatched.length > 0 && (
          <>
            <div style={pickerSectionLabel}>
              Unmatched · {unmatched.length} — link directly
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, marginBottom: 12 }}>
              {unmatched.map(g => (
                <button
                  key={g.group_key}
                  onClick={() => onPick(g.sample_line_id)}
                  style={pickerRowBtn}
                  onMouseEnter={e => (e.currentTarget.style.background = UXP.lavFill)}
                  onMouseLeave={e => (e.currentTarget.style.background = UXP.cardBg)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={pickerDesc}>{g.raw_description}</div>
                    <div style={pickerMeta}>
                      {g.supplier_name ?? '?'}{g.article_number && ` · ${g.article_number}`} · {g.line_count} line{g.line_count === 1 ? '' : 's'} · last {g.latest_invoice_date ?? '?'}
                    </div>
                  </div>
                  <div style={pickerPrice}>
                    {g.latest_price != null ? `${g.latest_price} kr/${g.unit ?? '?'}` : '—'}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Matched bucket — secondary action: repoint (steal from other product) */}
        {matched && matched.length > 0 && (
          <>
            <div style={pickerSectionLabel}>
              Currently linked to another product · {matched.length} — repoint to consolidate duplicates
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
              {matched.map(g => (
                <div
                  key={g.group_key}
                  style={{
                    ...pickerRowBtn,
                    cursor: 'default',
                    borderColor: '#fde68a',   // amber border (informational, not error)
                    background:  '#fef3c7',   // amber soft fill — UXP has no amber yet
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={pickerDesc}>{g.raw_description}</div>
                    <div style={pickerMeta}>
                      {g.supplier_name ?? '?'}{g.article_number && ` · ${g.article_number}`} · {g.line_count} line{g.line_count === 1 ? '' : 's'} · last {g.latest_invoice_date ?? '?'}
                    </div>
                    <div style={{ fontSize: 10, color: '#d97706', marginTop: 3, fontWeight: 600 }}>
                      Linked to: {g.current_product_name ?? '(unnamed product)'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', gap: 4 }}>
                    <div style={pickerPrice}>
                      {g.latest_price != null ? `${g.latest_price} kr/${g.unit ?? '?'}` : '—'}
                    </div>
                    {g.sample_alias_id && (
                      <button
                        onClick={() => onRepoint(g.sample_alias_id, g.current_product_name)}
                        style={{
                          padding: '5px 10px', fontSize: 10, fontWeight: 600,
                          background: '#d97706', color: '#fff',   // amber (informational)
                          border: 'none', borderRadius: 4, cursor: 'pointer',
                          fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
                        }}
                      >
                        Repoint to "{productName}" →
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 8, lineHeight: 1.5 }}>
              <strong>Repoint</strong> moves a supplier article from one product to another (used to consolidate duplicate products into one canonical entry). The other product loses this article's cost history; you can repoint back any time.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const pickerSectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: UXP.ink3,
  letterSpacing: '0.04em', textTransform: 'uppercase' as const,
  marginBottom: 6, padding: '0 2px',
}
const pickerRowBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 10,
  padding: '8px 10px', textAlign: 'left' as const,
  background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
  borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', width: '100%',
}
const pickerDesc: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: UXP.ink1,
  overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const,
}
const pickerMeta: React.CSSProperties = {
  fontSize: 10, color: UXP.ink4, marginTop: 2,
}
const pickerPrice: React.CSSProperties = {
  fontSize: 11, color: UXP.ink2,
  fontVariantNumeric: 'tabular-nums' as const,
  whiteSpace: 'nowrap' as const, alignSelf: 'center' as const,
}
const recipeRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '6px 0',
  borderBottom: `0.5px solid ${UXP.borderSoft}`,
}
const subBadge: React.CSSProperties = {
  marginLeft: 6, fontSize: 9, fontWeight: 600, padding: '1px 6px',
  background: UXP.lavFill, color: UXP.lavText, borderRadius: 3,
  textTransform: 'uppercase' as const, letterSpacing: '0.04em',
}
const primaryBtn: React.CSSProperties = {
  padding: '7px 16px', fontSize: 12, fontWeight: 600,
  background: UXP.lavMid, color: '#fff', border: 'none', borderRadius: 6,
  cursor: 'pointer', fontFamily: 'inherit',
}
const secondaryBtn: React.CSSProperties = {
  padding: '7px 16px', fontSize: 12, fontWeight: 500,
  background: 'transparent', color: UXP.ink2,
  border: `0.5px solid ${UXP.border}`, borderRadius: 6,
  cursor: 'pointer', fontFamily: 'inherit',
}
const secondaryDangerBtn: React.CSSProperties = {
  padding: '7px 14px', fontSize: 11, fontWeight: 500,
  background: 'transparent', color: UXP.coral,
  border: `0.5px solid ${UXP.coral}`, borderRadius: 6,
  cursor: 'pointer', fontFamily: 'inherit',
}
const tinyDangerBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: UXP.ink4,
  cursor: 'pointer', fontSize: 16, padding: '2px 6px', lineHeight: 1,
}

// ── Supplier-article spec section ─────────────────────────────────────
//
// Renders the official supplier data for this product if we've scraped
// it (image + spec table from the supplier_articles cross-customer
// catalogue). Silent when nothing exists yet. Cross-supplier-aware —
// if a product has aliases at multiple suppliers and we have data for
// more than one, shows the most-recently-fetched first with tabs.
function SupplierArticleSection({ productId }: { productId: string }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [pickedIdx, setPickedIdx] = useState(0)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/inventory/items/${productId}/supplier-article`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        setRows(Array.isArray(j.supplier_articles) ? j.supplier_articles : [])
      } catch { setRows([]) }
      if (!cancelled) setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [productId])
  if (!loaded || !rows || rows.length === 0) return null

  const a = rows[pickedIdx] ?? rows[0]
  const img = a.image_cached_url || a.image_url
  // Spec rows — only render the ones with values to avoid empty noise.
  const specs: Array<[string, string | null]> = [
    ['Brand',       a.brand],
    ['GTIN',        a.gtin],
    ['Brutto vikt', a.brutto_weight_g != null ? formatWeight(a.brutto_weight_g) : null],
    ['Netto vikt',  a.net_weight_g    != null ? formatWeight(a.net_weight_g)    : null],
    ['Enhet',       a.unit],
    ['Antal/enhet', a.units_per_pack_label],
    ['Antal per hel förpackning', a.packs_per_master != null ? String(a.packs_per_master) : null],
    ['Varutyp',     a.storage_type],
    ['Land',        a.country_origin],
    ['Art.nr',      a.article_number],
    ['Art.nr leverantör', a.supplier_internal_sku],
  ]
  const visibleSpecs = specs.filter(([, v]) => v != null && v !== '')

  return (
    <div style={{
      padding: '14px 22px', borderBottom: `0.5px solid ${UXP.borderSoft}`,
      background: UXP.subtleBg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Supplier article details
        </div>
        {rows.length > 1 && (
          <div style={{ display: 'flex', gap: 4 }}>
            {rows.map((r, i) => (
              <button key={i} onClick={() => setPickedIdx(i)} style={{
                padding: '2px 8px', fontSize: 10, fontWeight: 500,
                background: i === pickedIdx ? UXP.lavFill : 'transparent',
                color: i === pickedIdx ? UXP.lavText : UXP.ink3,
                border: `0.5px solid ${i === pickedIdx ? UXP.lavMid : UXP.border}`,
                borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}>
                Source {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: img ? '120px 1fr' : '1fr', gap: 14, alignItems: 'start' }}>
        {img && (
          <a href={img} target="_blank" rel="noopener noreferrer" style={{
            display: 'block', background: '#fff',
            border: `0.5px solid ${UXP.border}`, borderRadius: 8,
            padding: 6, lineHeight: 0,
          }}>
            <img src={img} alt={a.official_name ?? ''}
                 style={{ width: 108, height: 108, objectFit: 'contain' as const, display: 'block' }} />
          </a>
        )}
        <div>
          {a.official_name && (
            <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, marginBottom: 4 }}>
              {a.official_name}
            </div>
          )}
          {a.category_path && (
            <div style={{ fontSize: 10, color: UXP.ink4, marginBottom: 8 }}>
              {a.category_path}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px', fontSize: 11 }}>
            {visibleSpecs.map(([k, v]) => (
              <Fragment_ key={k}>
                <div style={{ color: UXP.ink4 }}>{k}</div>
                <div style={{ color: UXP.ink1, fontWeight: 500 }}>{v}</div>
              </Fragment_>
            ))}
          </div>
          {a.description && (
            <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 8, lineHeight: 1.5 }}>
              {a.description}
            </div>
          )}
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 8 }}>
            From {a.source === 'martinservera_scrape' ? 'martinservera.se' : a.source}
            {a.fetched_at && ` · scraped ${new Date(a.fetched_at).toLocaleDateString('sv-SE')}`}
          </div>
        </div>
      </div>
    </div>
  )
}
// React.Fragment alias for inline use in the grid above.
function Fragment_({ children }: { children: React.ReactNode }) { return <>{children}</> }
function formatWeight(g: number): string {
  if (g >= 1000) return `${(g / 1000).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kg`
  return `${g.toLocaleString('sv-SE')} g`
}
