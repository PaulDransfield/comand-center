'use client'
// app/inventory/waste/page.tsx
//
// Manual waste log. Pick a product, type the qty + unit, choose a
// reason, save. Each entry snapshots the product's current cost.
// Later (with POS-recipe mapping) this feeds variance calc.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Entry {
  id:                  string
  product_id:          string
  product_name:        string
  category:            string | null
  waste_date:          string
  quantity:            number
  unit:                string
  unit_price_at_entry: number | null
  value_at_entry:      number | null
  reason:              string
  notes:               string | null
  created_at:          string
}
interface Summary {
  total_value: number
  by_reason:   Record<string, number>
  count:       number
}

const REASONS = [
  { value: 'spoilage',     label: 'Spoilage' },
  { value: 'spill',        label: 'Spill' },
  { value: 'over_portion', label: 'Over-portion' },
  { value: 'staff_meal',   label: 'Staff meal' },
  { value: 'comp',         label: 'Comp / re-fire' },
  { value: 'other',        label: 'Other' },
]
const UNIT_OPTIONS = ['g', 'kg', 'ml', 'cl', 'dl', 'l', 'st', 'portion']

export default function WastePage() {
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [adding,  setAdding]  = useState(false)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/waste?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const j = await r.json()
      setEntries(j.entries ?? [])
      setSummary(j.summary ?? null)
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  async function deleteEntry(id: string) {
    if (!confirm('Delete this waste entry?')) return
    const r = await fetch(`/api/inventory/waste/${id}`, { method: 'DELETE', cache: 'no-store' })
    if (r.ok) load()
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 1100, padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
              Waste log
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 640, lineHeight: 1.5 }}>
              Log what got thrown out, spilled, over-portioned, or comped. Each entry snapshots the cost at-time-of-waste. When POS-recipe mapping ships this feeds variance vs theoretical usage.
            </p>
          </div>
          <button onClick={() => setAdding(true)} disabled={!bizId} style={primaryBtn}>+ Log waste</button>
        </div>

        {summary && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <Stat label="Entries" value={String(summary.count)} />
            <Stat label="Total value" value={fmtKr(summary.total_value)} tone="coral" />
            <Stat label="Top reason" value={topReason(summary.by_reason)} />
            <Stat label="Avg per entry" value={summary.count > 0 ? fmtKr(summary.total_value / summary.count) : '—'} />
          </div>
        )}

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}
        {loading && <Empty label="Loading…" />}
        {!loading && entries.length === 0 && !error && (
          <Empty label="No waste logged yet. Click + Log waste to add the first entry." />
        )}

        {!loading && entries.length > 0 && (
          <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <thead>
                <tr style={{ background: UXP.subtleBg }}>
                  <Th label="Date" />
                  <Th label="Product" />
                  <Th label="Qty" align="right" />
                  <Th label="Reason" />
                  <Th label="Value" align="right" />
                  <Th label="" />
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} style={{ borderTop: `0.5px solid ${UXP.borderSoft}` }}>
                    <td style={{ ...td(), color: UXP.ink3, fontSize: 11 }}>{e.waste_date}</td>
                    <td style={{ ...td(), color: UXP.ink1, fontWeight: 500 }}>{e.product_name}
                      {e.notes && <span style={{ marginLeft: 6, fontSize: 10, color: UXP.ink4, fontStyle: 'italic' as const }}>· {e.notes}</span>}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink2 }}>
                      {e.quantity} {e.unit}
                    </td>
                    <td style={{ ...td(), color: UXP.ink3 }}>
                      {REASONS.find(r => r.value === e.reason)?.label ?? e.reason}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1, fontWeight: 500 }}>
                      {e.value_at_entry != null ? fmtKr(e.value_at_entry) : '—'}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const }}>
                      <button onClick={() => deleteEntry(e.id)} aria-label="Delete"
                        style={{ background: 'transparent', border: 'none', color: UXP.ink4, fontSize: 14, cursor: 'pointer', padding: '2px 6px' }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && bizId && (
        <WasteModal bizId={bizId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />
      )}
    </AppShell>
  )
}

function WasteModal({ bizId, onClose, onSaved }: { bizId: string; onClose: () => void; onSaved: () => void }) {
  const [q,         setQ]         = useState('')
  const [results,   setResults]   = useState<any[]>([])
  const [picked,    setPicked]    = useState<any | null>(null)
  const [qty,       setQty]       = useState('')
  const [unit,      setUnit]      = useState('')
  const [reason,    setReason]    = useState('spoilage')
  const [notes,     setNotes]     = useState('')
  const [date,      setDate]      = useState(new Date().toISOString().slice(0, 10))
  const [busy,      setBusy]      = useState(false)
  const [err,       setErr]       = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(async () => {
      const r = await fetch(`/api/inventory/products/search?business_id=${encodeURIComponent(bizId)}&q=${encodeURIComponent(q)}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setResults(j.products ?? [])
    }, 200)
    return () => clearTimeout(timer)
  }, [q, bizId])

  async function save() {
    if (!picked || !qty) return
    const qn = Number(qty)
    if (!Number.isFinite(qn) || qn <= 0) { setErr('Quantity must be > 0'); return }
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/inventory/waste', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: bizId,
          product_id:  picked.product_id,
          quantity:    qn,
          unit:        unit || picked.invoice_unit || 'st',
          reason, waste_date: date, notes,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      onSaved()
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed' as const, inset: 0, background: 'rgba(20,18,40,0.35)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(460px, 100%)', height: '100%', background: UXP.cardBg,
        borderLeft: `0.5px solid ${UXP.border}`, padding: '20px 24px', overflowY: 'auto' as const,
        boxShadow: '-8px 0 24px rgba(58,53,80,0.10)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: UXP.ink1, marginBottom: 14 }}>Log waste</div>

        {!picked && (
          <>
            <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>Product</div>
            <input type="text" value={q} onChange={e => setQ(e.target.value)} autoFocus
              placeholder="Search the catalogue…" style={inputStyle} />
            <div style={{ maxHeight: 240, overflowY: 'auto' as const, marginTop: 8, border: `0.5px solid ${UXP.border}`, borderRadius: 6 }}>
              {results.length === 0 && (
                <div style={{ padding: 14, color: UXP.ink4, fontSize: 12, textAlign: 'center' as const }}>No matches.</div>
              )}
              {results.map((p: any) => (
                <button key={p.product_id} onClick={() => { setPicked(p); setUnit(p.invoice_unit ?? '') }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left' as const,
                    padding: '8px 10px', background: 'transparent', border: 'none',
                    borderBottom: `0.5px solid ${UXP.borderSoft}`, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = UXP.subtleBg)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1 }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: UXP.ink4 }}>
                    {p.category ?? '?'} · {p.latest_price != null ? `${fmtKr(p.latest_price)}/${p.invoice_unit ?? '?'}` : 'no price'}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {picked && (
          <>
            <div style={{ padding: 10, background: UXP.subtleBg, borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 500, color: UXP.ink1 }}>{picked.name}</div>
              <button onClick={() => setPicked(null)} style={{
                background: 'transparent', border: 'none', color: UXP.ink3,
                fontSize: 10, cursor: 'pointer', padding: 0, marginTop: 4,
              }}>← change</button>
            </div>

            <Field label="Quantity"><div style={{ display: 'flex', gap: 6 }}>
              <input type="number" min="0" step="0.01" value={qty} autoFocus
                onChange={e => setQty(e.target.value)} disabled={busy}
                inputMode="decimal"
                style={{ ...inputStyle, flex: 1, textAlign: 'right' as const }} />
              <select value={unit} onChange={e => setUnit(e.target.value)} disabled={busy}
                style={{ ...inputStyle, minWidth: 80 }}>
                {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div></Field>

            <Field label="Reason">
              <select value={reason} onChange={e => setReason(e.target.value)} disabled={busy} style={inputStyle}>
                {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Field>

            <Field label="Date">
              <input type="date" value={date} onChange={e => setDate(e.target.value)} disabled={busy} style={inputStyle} />
            </Field>

            <Field label="Notes (optional)">
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)} disabled={busy} style={inputStyle}
                placeholder="e.g. 'Past best-before' or 'over-prepped Saturday'" />
            </Field>

            {err && <div style={{ marginTop: 8, padding: '6px 10px', background: UXP.roseFill, color: UXP.roseText, fontSize: 11, borderRadius: 5 }}>{err}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button onClick={onClose} disabled={busy} style={secondaryBtn}>Cancel</button>
              <button onClick={save} disabled={busy || !qty} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function topReason(by: Record<string, number>): string {
  let max = 0, key = '—'
  for (const [r, v] of Object.entries(by)) {
    if (v > max) { max = v; key = r }
  }
  return REASONS.find(r => r.value === key)?.label ?? key
}
function Stat({ label, value, tone = 'ink' }: { label: string; value: string; tone?: 'ink' | 'coral' }) {
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: tone === 'coral' ? UXP.coral : UXP.ink1,
                    marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}
function Empty({ label }: { label: string }) {
  return <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13,
                       background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8 }}>{label}</div>
}
function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600, color: UXP.ink4,
                      letterSpacing: '0.04em', textTransform: 'uppercase' as const, textAlign: align }}>{label}</th>
}
function td(): React.CSSProperties { return { padding: '10px 12px', fontSize: 12, color: UXP.ink2 } }
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  )
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit',
  border: `0.5px solid ${UXP.border}`, borderRadius: 5, color: UXP.ink1, background: '#fff',
}
const primaryBtn: React.CSSProperties = {
  padding: '8px 18px', fontSize: 12, fontWeight: 600,
  background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
const secondaryBtn: React.CSSProperties = {
  padding: '8px 14px', fontSize: 12, fontWeight: 500,
  background: 'transparent', color: UXP.ink3, border: `0.5px solid ${UXP.border}`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
