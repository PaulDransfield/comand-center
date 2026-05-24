'use client'
// app/inventory/items/[id]/page.tsx
//
// Per-product detail. Time-series sparkline of every observed price +
// table of every supplier invoice that contained this product. Aliases
// shown so the owner sees how the AI dedupes different descriptions.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Detail {
  product: {
    id:                              string
    name:                            string
    category:                        string
    default_supplier_name:           string | null
    default_supplier_fortnox_number: string | null
    invoice_unit:                    string | null
    count_unit:                      string | null
    pack_size:                       number | null
    base_unit:                       string | null
    source_recipe_id:                string | null
    price_override:                  number | null
    price_override_currency:         string | null
    price_override_set_at:           string | null
    archived_at:                     string | null
  }
  aliases: Array<{
    id:                       string
    alias_text:               string
    supplier_name:            string | null
    observation_count:        number | null
    first_seen_at:            string | null
    last_seen_at:             string | null
  }>
  history: Array<{
    id:                  string
    invoice_date:        string
    invoice_number:      string
    supplier:            string
    raw_description:     string
    quantity:            number | null
    unit:                string | null
    price_per_unit:      number | null
    total_excl_vat:      number | null
    vat_rate:            number | null
    currency:            string | null
    price_per_unit_sek:  number | null
    total_sek:           number | null
    fx_rate:             number | null
    fortnox_url:         string | null
    pdf_file_id:         string | null
    pdf_proxy_url:       string | null
  }>
  aggregates: {
    observation_count: number
    min_price:         number | null
    max_price:         number | null
    avg_price:         number | null
    latest_price:      number | null
    first_seen_date:   string | null
    last_seen_date:    string | null
    suppliers_seen:    string[]
  }
}

export default function ProductDetailPage() {
  const params = useParams() as { id: string }
  const router = useRouter()
  const [data,    setData]    = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  // Inline rename state
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // Inline PDF viewer state — opens when a history row's PDF button is clicked
  const [pdfModal, setPdfModal] = useState<{ url: string; title: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/inventory/items/${params.id}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [params.id])
  useEffect(() => { load() }, [load])

  async function saveRename() {
    if (!draft.trim() || !data) return
    setSaving(true); setSaveErr(null)
    try {
      const r = await fetch(`/api/inventory/items/${params.id}`, {
        method:  'PATCH',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: draft.trim() }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setData({ ...data, product: { ...data.product, name: j.product.name } })
      setEditing(false)
    } catch (err: any) {
      setSaveErr(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function patchProduct(patch: Record<string, any>) {
    if (!data) return
    setSaveErr(null)
    try {
      const r = await fetch(`/api/inventory/items/${params.id}`, {
        method:  'PATCH',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setData({ ...data, product: { ...data.product, ...j.product } })
    } catch (err: any) {
      setSaveErr(err.message)
    }
  }

  async function fetchAndApplyPackSuggestion() {
    if (!data) return
    try {
      const r = await fetch(`/api/inventory/items/${params.id}/pack-suggest`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (j.suggested && (!data.product.pack_size || !data.product.base_unit)) {
        await patchProduct({ pack_size: j.suggested.pack_size, base_unit: j.suggested.base_unit })
      }
    } catch { /* swallow */ }
  }

  async function patchLine(lineId: string, patch: Record<string, any>) {
    if (!data) return
    try {
      const r = await fetch(`/api/inventory/lines/${lineId}`, {
        method:  'PATCH',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      // Patch the row in place, then re-derive aggregates by reloading.
      load()
    } catch (err: any) {
      alert(err.message)
    }
  }

  if (loading || !data) return (
    <AppShell>
      <div style={{ padding: 30, color: UXP.ink3, fontSize: 13 }}>
        {error ? <span style={{ color: UXP.roseText }}>{error}</span> : 'Loading item…'}
      </div>
    </AppShell>
  )

  const { product, aliases, history, aggregates } = data

  // Sparkline points — chronological (oldest first)
  const sparkPoints = history
    .slice()
    .sort((a, b) => (a.invoice_date ?? '').localeCompare(b.invoice_date ?? ''))
    .map(h => ({ date: h.invoice_date, price: h.price_per_unit != null ? Number(h.price_per_unit) : null }))
    .filter(p => p.price != null) as Array<{ date: string; price: number }>

  return (
    <AppShell>
      <div style={{ maxWidth: 1100, padding: '20px 24px' }}>
        <button
          onClick={() => router.push('/inventory/items')}
          style={{ background: 'transparent', border: 'none', color: UXP.ink3,
                   fontSize: 12, cursor: 'pointer', marginBottom: 14, padding: 0 }}
        >← Back to catalogue</button>

        <div style={{ marginBottom: 18 }}>
          {editing ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const }}>
              <input
                type="text" value={draft} autoFocus disabled={saving}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveRename()
                  if (e.key === 'Escape') { setEditing(false); setSaveErr(null) }
                }}
                style={{
                  fontSize: 20, fontWeight: 600, color: UXP.ink1,
                  padding: '4px 10px', minWidth: 360, fontFamily: 'inherit',
                  border: `0.5px solid ${UXP.lavMid}`, borderRadius: 6,
                  background: '#fff', letterSpacing: '-0.01em',
                }}
              />
              <button
                type="button" onClick={saveRename} disabled={saving || !draft.trim()}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 600,
                  background: UXP.lavDeep, color: '#fff',
                  border: 'none', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button" onClick={() => { setEditing(false); setSaveErr(null) }}
                disabled={saving}
                style={{
                  padding: '6px 10px', fontSize: 12,
                  background: 'transparent', color: UXP.ink3,
                  border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}>
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
                {product.name}
              </h1>
              <button
                type="button"
                onClick={() => { setDraft(product.name); setEditing(true); setSaveErr(null) }}
                title="Rename product"
                style={{
                  padding: '3px 9px', fontSize: 11, fontWeight: 500,
                  background: 'transparent', color: UXP.ink3,
                  border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}>
                Rename
              </button>
            </div>
          )}
          {saveErr && (
            <div style={{
              marginTop: 8, padding: '6px 10px',
              background: UXP.roseFill, color: UXP.roseText,
              fontSize: 12, borderRadius: 5, maxWidth: 600,
            }}>
              {saveErr}
            </div>
          )}
          <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: UXP.ink3, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>Category</span>
              <select
                value={product.category}
                onChange={e => patchProduct({ category: e.target.value })}
                style={{
                  padding: '3px 6px', fontSize: 12,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit',
                }}>
                {['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other'].map(k => (
                  <option key={k} value={k}>{labelForCategory(k)}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>Invoice unit</span>
              <input
                type="text"
                defaultValue={product.invoice_unit ?? ''}
                onBlur={e => {
                  const v = e.target.value.trim()
                  if (v !== (product.invoice_unit ?? '')) patchProduct({ invoice_unit: v || null })
                }}
                placeholder="kg"
                style={{
                  padding: '3px 6px', fontSize: 12, width: 80,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit',
                }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}
                    title="How many base units (g / ml / st) in ONE invoice unit. Example: a 1kg bag of garlic priced per ST has pack size 1000.">
                Pack size
              </span>
              <input
                type="number" step="0.01" min="0"
                defaultValue={product.pack_size ?? ''}
                onBlur={e => {
                  const v = e.target.value === '' ? null : Number(e.target.value)
                  if (v !== product.pack_size) patchProduct({ pack_size: v })
                }}
                placeholder="1000"
                style={{
                  padding: '3px 6px', fontSize: 12, width: 80,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit',
                  textAlign: 'right' as const,
                }} />
              <select
                value={product.base_unit ?? ''}
                onChange={e => patchProduct({ base_unit: e.target.value || null })}
                style={{
                  padding: '3px 4px', fontSize: 12,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit',
                }}>
                <option value="">—</option>
                <option value="g">g</option>
                <option value="ml">ml</option>
                <option value="st">st</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}
                    title="Manual price override per invoice unit. Wins over invoice / recipe-derived price. Leave blank to use derived.">
                Price override
              </span>
              <input
                type="number" step="0.01" min="0"
                defaultValue={product.price_override ?? ''}
                onBlur={e => {
                  const v = e.target.value === '' ? null : Number(e.target.value)
                  if (v !== product.price_override) patchProduct({ price_override: v })
                }}
                placeholder="—"
                style={{
                  padding: '3px 6px', fontSize: 12, width: 80,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit',
                  textAlign: 'right' as const,
                }} />
              <select
                value={product.price_override_currency ?? 'SEK'}
                onChange={e => patchProduct({ price_override_currency: e.target.value })}
                style={{
                  padding: '3px 4px', fontSize: 12,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit',
                }}>
                {['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                Default supplier
              </span>
              <input
                type="text"
                defaultValue={product.default_supplier_name ?? ''}
                onBlur={e => {
                  const v = e.target.value.trim()
                  if (v !== (product.default_supplier_name ?? '')) patchProduct({ default_supplier_name: v || null })
                }}
                placeholder="—"
                style={{
                  padding: '3px 6px', fontSize: 12, width: 160,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit',
                }} />
            </label>
            <button onClick={() => {
              if (!confirm(product.archived_at ? 'Restore this product?' : 'Archive this product? It will be hidden from the catalogue and pickers. Recipes referencing it stay linked.')) return
              patchProduct({ archived: !product.archived_at })
            }}
              style={{
                padding: '4px 10px', fontSize: 11,
                background: 'transparent',
                color: product.archived_at ? UXP.greenDeep : UXP.roseText,
                border: `0.5px solid ${product.archived_at ? UXP.green : UXP.rose}`,
                borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}>
              {product.archived_at ? 'Restore' : 'Archive'}
            </button>
          </div>
        </div>

        {/* Auto-detect pack size suggestion when missing */}
        {(!product.pack_size || !product.base_unit) && (
          <div style={{
            padding: '8px 12px', marginBottom: 12,
            background: UXP.lavFill, border: `0.5px solid ${UXP.lavMid}`,
            borderRadius: 6, fontSize: 12, color: UXP.ink2,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          }}>
            <span>
              Pack size missing. Recipes using this product can't convert grams/ml correctly until you set it.
              We can try to detect it from the name "{product.name}".
            </span>
            <button onClick={fetchAndApplyPackSuggestion}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                background: UXP.lavDeep, color: '#fff',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap' as const,
              }}>
              Detect & apply
            </button>
          </div>
        )}

        {/* Aggregate tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
          <Stat label="Observations" value={String(aggregates.observation_count)} />
          <Stat label="Latest price" value={fmtKr(aggregates.latest_price)} bold />
          <Stat label="Lowest" value={fmtKr(aggregates.min_price)} />
          <Stat label="Highest" value={fmtKr(aggregates.max_price)} />
          <Stat label="Average" value={fmtKr(aggregates.avg_price)} />
        </div>

        {/* Sparkline */}
        {sparkPoints.length > 1 && (
          <div style={{
            background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
            borderRadius: 8, padding: 16, marginBottom: 16,
          }}>
            <div style={{ fontSize: 11, color: UXP.ink4, marginBottom: 8, fontWeight: 600,
                          letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
              Price trend
            </div>
            <Sparkline points={sparkPoints} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: UXP.ink4 }}>
              <span>{sparkPoints[0].date}</span>
              <span>{sparkPoints[sparkPoints.length - 1].date}</span>
            </div>
          </div>
        )}

        {/* Aliases */}
        {aliases.length > 1 && (
          <div style={{
            background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
            borderRadius: 8, padding: 14, marginBottom: 16,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink3, marginBottom: 8,
                          letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
              Aliases ({aliases.length}) — alternate descriptions the AI has seen
            </div>
            {aliases.map(a => (
              <div key={a.id} style={{ fontSize: 12, color: UXP.ink2, padding: '3px 0', display: 'flex', justifyContent: 'space-between' }}>
                <span>{a.alias_text}</span>
                <span style={{ color: UXP.ink4, fontSize: 11 }}>
                  {a.supplier_name ?? '?'} · {a.observation_count ?? 0}×
                </span>
              </div>
            ))}
          </div>
        )}

        {/* History table */}
        <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
                      borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: `0.5px solid ${UXP.borderSoft}`,
                        fontSize: 11, fontWeight: 600, color: UXP.ink3,
                        letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            Price history ({history.length} rows)
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 }}>
            <thead>
              <tr style={{ background: UXP.subtleBg }}>
                <th style={th()}>Date</th>
                <th style={th()}>Supplier</th>
                <th style={th()}>Invoice</th>
                <th style={th()}>Description</th>
                <th style={{ ...th(), textAlign: 'right' as const }}>Qty</th>
                <th style={th()}>Unit</th>
                <th style={{ ...th(), textAlign: 'right' as const }}>Unit price</th>
                <th style={{ ...th(), textAlign: 'right' as const }}>Total</th>
                <th style={th()}>Cur.</th>
                <th style={th()}></th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <HistoryRow key={h.id} h={h}
                  onPatch={(patch) => patchLine(h.id, patch)}
                  onOpenPdf={() => h.pdf_proxy_url && setPdfModal({ url: h.pdf_proxy_url, title: `Invoice #${h.invoice_number} — ${h.supplier}` })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pdfModal && <PdfModal url={pdfModal.url} title={pdfModal.title} onClose={() => setPdfModal(null)} />}
    </AppShell>
  )
}

// Editable price-history row. Each numeric cell is an inline input that
// commits on blur; if the value didn't change, no request is sent.
// Currency is a select. Description column stays read-only — fixing OCR
// text would require an alias-link reshuffle (out of scope).
function HistoryRow({ h, onPatch, onOpenPdf }: { h: any; onPatch: (patch: Record<string, any>) => void; onOpenPdf: () => void }) {
  const CURRENCIES = ['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP']
  const isNonSek = (h.currency ?? 'SEK') !== 'SEK'
  // Show SEK equivalent next to native amount when row currency != SEK.
  // Empty/null when no FX rate available (yet) — surfaces as a coral
  // warning rather than silently showing the native number as SEK.
  const sekPrice = h.price_per_unit_sek
  const sekTotal = h.total_sek
  const rowBg    = isNonSek ? '#fef9f0' : 'transparent'   // soft amber tint = non-SEK
  return (
    <tr style={{ borderTop: `0.5px solid ${UXP.borderSoft}`, background: rowBg }}>
      <td style={td()}>{h.invoice_date}</td>
      <td style={td()}>{h.supplier}</td>
      <td style={{ ...td(), fontFamily: 'ui-monospace, monospace' as const, color: UXP.ink3 }}>#{h.invoice_number}</td>
      <td style={{ ...td(), color: UXP.ink3 }}>{h.raw_description}</td>
      <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, padding: '4px 8px' }}>
        <input type="number" step="0.001" defaultValue={h.quantity ?? ''}
          onBlur={e => {
            const v = e.target.value === '' ? null : Number(e.target.value)
            if (v !== h.quantity) onPatch({ quantity: v })
          }}
          style={cellInput(60)}
        />
      </td>
      <td style={{ ...td(), padding: '4px 8px' }}>
        <input type="text" defaultValue={h.unit ?? ''}
          onBlur={e => {
            const v = e.target.value.trim()
            if (v !== (h.unit ?? '')) onPatch({ unit: v || null })
          }}
          style={cellInput(48)}
        />
      </td>
      <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, fontWeight: 500, padding: '4px 8px' }}>
        <input type="number" step="0.01" defaultValue={h.price_per_unit ?? ''}
          onBlur={e => {
            const v = e.target.value === '' ? null : Number(e.target.value)
            if (v !== h.price_per_unit) onPatch({ price_per_unit: v })
          }}
          style={cellInput(70, true)}
        />
        {isNonSek && (
          <div style={{ fontSize: 9, color: sekPrice != null ? UXP.ink4 : UXP.coral, marginTop: 2, textAlign: 'right' as const }}>
            {sekPrice != null ? `≈ ${sekPrice.toFixed(2)} kr` : 'no FX rate'}
          </div>
        )}
      </td>
      <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, padding: '4px 8px' }}>
        <input type="number" step="0.01" defaultValue={h.total_excl_vat ?? ''}
          onBlur={e => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v !== h.total_excl_vat) onPatch({ total_excl_vat: v })
          }}
          style={cellInput(80, true)}
        />
        {isNonSek && (
          <div style={{ fontSize: 9, color: sekTotal != null ? UXP.ink4 : UXP.coral, marginTop: 2, textAlign: 'right' as const }}>
            {sekTotal != null ? `≈ ${sekTotal.toFixed(2)} kr` : 'no FX rate'}
          </div>
        )}
      </td>
      <td style={{ ...td(), padding: '4px 8px' }}>
        <select defaultValue={h.currency ?? 'SEK'}
          onChange={e => { if (e.target.value !== h.currency) onPatch({ currency: e.target.value }) }}
          style={{ ...cellInput(56), padding: '2px 4px' }}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {isNonSek && h.fx_rate != null && (
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2 }}
               title={`1 ${h.currency} = ${h.fx_rate.toFixed(4)} SEK at ${h.invoice_date}`}>
            @ {h.fx_rate.toFixed(2)}
          </div>
        )}
      </td>
      <td style={{ ...td(), whiteSpace: 'nowrap' as const }}>
        {h.pdf_file_id && (
          <button onClick={onOpenPdf}
            title="View invoice PDF (inline)"
            style={{
              padding: '2px 8px', fontSize: 10, fontWeight: 600,
              background: UXP.lavFill, color: UXP.lavText,
              border: 'none', borderRadius: 4, cursor: 'pointer',
              fontFamily: 'inherit', marginRight: 4,
            }}>PDF</button>
        )}
        {h.fortnox_url && (
          <a href={h.fortnox_url} target="_blank" rel="noopener noreferrer"
             title="Open in Fortnox web app"
             style={{ fontSize: 10, color: UXP.ink3, textDecoration: 'none' }}>↗</a>
        )}
      </td>
    </tr>
  )
}

// Inline PDF viewer modal — embedded iframe of the Fortnox file proxy.
// Stays in-app per the brief. Footer has "Open in new tab" fallback
// for browsers that don't render PDFs in iframes (rare; some mobile
// Chrome versions).
function PdfModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose}
      style={{
        position: 'fixed' as const, inset: 0, background: 'rgba(20,18,40,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200, padding: 16,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: 'min(960px, 100%)', height: '90vh',
          background: '#fff', borderRadius: 8, overflow: 'hidden' as const,
          display: 'flex', flexDirection: 'column' as const,
          boxShadow: '0 20px 60px rgba(0,0,0,0.40)',
        }}>
        <div style={{
          padding: '10px 14px', borderBottom: `0.5px solid ${UXP.borderSoft}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
            {title}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <a href={url} target="_blank" rel="noopener noreferrer"
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 500,
                background: 'transparent', color: UXP.ink3,
                border: `0.5px solid ${UXP.border}`, borderRadius: 4,
                textDecoration: 'none', fontFamily: 'inherit',
              }}>Open in new tab ↗</a>
            <button onClick={onClose}
              style={{
                padding: '5px 12px', fontSize: 11, fontWeight: 600,
                background: UXP.ink1, color: '#fff',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}>Close (Esc)</button>
          </div>
        </div>
        <iframe src={url} title="Invoice PDF"
          style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }} />
      </div>
    </div>
  )
}

function cellInput(width: number, rightAlign = false): React.CSSProperties {
  return {
    width, padding: '3px 6px', fontSize: 11, fontFamily: 'inherit',
    border: `0.5px solid transparent`, borderRadius: 3,
    background: 'transparent', color: UXP.ink1,
    textAlign: rightAlign ? 'right' as const : 'left' as const,
  }
}

function Sparkline({ points }: { points: Array<{ date: string; price: number }> }) {
  const W = 1000
  const H = 80
  const padding = 6
  const prices = points.map(p => p.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || 1
  const stepX = (W - 2 * padding) / Math.max(1, points.length - 1)
  const path = points.map((p, i) => {
    const x = padding + i * stepX
    const y = padding + ((max - p.price) / range) * (H - 2 * padding)
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }} preserveAspectRatio="none">
      <path d={path} fill="none" stroke={UXP.lavDeep} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => {
        const x = padding + i * stepX
        const y = padding + ((max - p.price) / range) * (H - 2 * padding)
        return <circle key={i} cx={x} cy={y} r={2.5} fill={UXP.lavDeep} />
      })}
    </svg>
  )
}

function Stat({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{
      background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
      borderRadius: 8, padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600,
                    letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{ fontSize: bold ? 20 : 16, fontWeight: bold ? 600 : 500,
                    color: UXP.ink1, marginTop: 4,
                    fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}

function labelForCategory(c: string): string {
  return {
    food: 'Food', beverage: 'Beverage', alcohol: 'Alcohol',
    cleaning: 'Cleaning', takeaway_material: 'Take-away',
    disposables: 'Disposables', other: 'Other',
  }[c] ?? c
}

function th(): React.CSSProperties {
  return {
    padding: '6px 10px', fontSize: 10, fontWeight: 600, color: UXP.ink4,
    letterSpacing: '0.04em', textTransform: 'uppercase' as const, textAlign: 'left' as const,
  }
}
function td(): React.CSSProperties {
  return { padding: '6px 10px', fontSize: 11, color: UXP.ink2 }
}
