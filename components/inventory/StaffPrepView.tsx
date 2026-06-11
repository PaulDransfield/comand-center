'use client'
// components/inventory/StaffPrepView.tsx
//
// Focused prep screen for the `staff` role (Phase 2c). The owner/manager prep
// page is built around CREATING and MANAGING sessions; line cooks just need
// "here's today's prep — tick it off." This is that view: load the active
// session, show its lines with a big tap target, complete them (logged to the
// person via M153), and read the method/ingredients in a read-only modal.
//
// No money anywhere; no create/edit affordances (those endpoints 403 for staff
// anyway). Routed to from the prep page when role === 'staff'.

import { useCallback, useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'

interface SubIngredient { product_name: string | null; quantity: number; unit: string | null; notes: string | null; position: number }
interface UseRef { recipe_name: string | null; notes: string | null; quantity: number; unit: string | null }
interface Line {
  id: string
  kind: 'component' | 'product'
  name_snapshot: string
  total_qty: number
  unit: string
  uncertain: null | string
  checked_at: string | null
  checked_by_name?: string | null
  meta?: { method?: string | null; notes?: string | null; ingredients?: SubIngredient[]; uses?: UseRef[] }
}
interface SessionResp {
  session: { id: string; name: string | null; completed_at: string | null; count_date?: string | null }
  lines: Line[]
}

function fmtQty(qty: number, unit: string): string {
  // Mirror of lib/inventory/prep-list.ts::formatPrepQty (kitchen-friendly).
  if (unit === 'g' && qty >= 1000)  return `${Math.round(qty / 100) / 10} kg`
  if (unit === 'ml' && qty >= 1000) return `${Math.round(qty / 100) / 10} l`
  return `${Math.round(qty * 10) / 10} ${unit}`
}

export default function StaffPrepView() {
  const [bizId, setBizId]   = useState<string | null>(null)
  const [data, setData]     = useState<SessionResp | null>(null)
  const [loading, setLoad]  = useState(true)
  const [error, setError]   = useState<string | null>(null)
  const [noSession, setNo]  = useState(false)
  const [modal, setModal]   = useState<Line | null>(null)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() { const n = localStorage.getItem('cc_selected_biz'); if (n) setBizId(n) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) { setLoad(false); return }
    setLoad(true); setError(null); setNo(false)
    try {
      const r = await fetch(`/api/inventory/prep-sessions?business_id=${encodeURIComponent(bizId)}&active=1`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      const active = (j.sessions ?? [])[0]
      if (!active) { setNo(true); setData(null); return }
      const r2 = await fetch(`/api/inventory/prep-sessions/${active.id}`, { cache: 'no-store' })
      const j2 = await r2.json()
      if (!r2.ok) throw new Error(j2.error ?? `HTTP ${r2.status}`)
      setData(j2)
    } catch (e: any) { setError(e.message) } finally { setLoad(false) }
  }, [bizId])
  useEffect(() => { if (bizId) load(); else setLoad(false) }, [bizId, load])

  async function toggle(line: Line) {
    if (!data) return
    const target = line.checked_at == null
    // Optimistic — instant feedback on the tablet.
    setData(d => d ? {
      ...d,
      lines: d.lines.map(l => l.id === line.id
        ? { ...l, checked_at: target ? new Date().toISOString() : null, checked_by_name: target ? 'You' : null }
        : l),
    } : d)
    try {
      const r = await fetch(`/api/inventory/prep-sessions/${data.session.id}/lines/${line.id}/toggle`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: target }),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      load()   // reconcile (accurate name + any concurrent changes)
    } catch (e: any) { setError(e.message); load() }
  }

  const lines = data?.lines ?? []
  const done  = lines.filter(l => l.checked_at != null).length
  const completed = !!data?.session.completed_at

  return (
    <AppShell>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '16px 14px 90px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1 }}>Prep list</h1>
        <p style={{ margin: '4px 0 14px', fontSize: 12, color: UXP.ink3 }}>
          {data?.session.name ? `${data.session.name} · ` : ''}Tap a row for the method. Tap the box to mark it done.
        </p>

        {!bizId && <Card>Select a business in the sidebar to load the prep list.</Card>}
        {error && <Card tone="bad">{error}</Card>}
        {bizId && loading && <Card>Loading…</Card>}
        {bizId && !loading && noSession && <Card>No prep list set for today yet — your manager creates it.</Card>}

        {data && lines.length > 0 && (
          <>
            {/* Progress */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: UXP.ink3, marginBottom: 4 }}>
                <span>{done} / {lines.length} done</span>
                {completed && <span style={{ color: UXP.greenDeep, fontWeight: 600 }}>COMPLETED</span>}
              </div>
              <div style={{ height: 5, background: UXP.subtleBg, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${lines.length ? (done / lines.length) * 100 : 0}%`, background: UXP.lavDeep, transition: 'width 200ms' }} />
              </div>
            </div>

            <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10, overflow: 'hidden' }}>
              {lines.map(line => {
                const checked = line.checked_at != null
                return (
                  <div key={line.id} style={{
                    display: 'grid', gridTemplateColumns: '52px 1fr auto', alignItems: 'center',
                    borderTop: `0.5px solid ${UXP.borderSoft}`,
                    background: checked ? UXP.subtleBg : UXP.cardBg, opacity: checked ? 0.6 : 1,
                  }}>
                    <button onClick={() => toggle(line)} disabled={completed} aria-label={checked ? 'Uncheck' : 'Check'}
                      style={{ height: 60, width: 52, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: completed ? 'default' : 'pointer' }}>
                      <span style={{
                        width: 26, height: 26, borderRadius: 6,
                        border: `1.5px solid ${checked ? UXP.lavDeep : UXP.border}`,
                        background: checked ? UXP.lavDeep : 'transparent', color: '#fff',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
                      }}>{checked ? '✓' : ''}</span>
                    </button>
                    <button onClick={() => setModal(line)}
                      style={{ textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 4px 10px 0', fontFamily: 'inherit', minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1, textDecoration: checked ? 'line-through' : 'none' }}>{line.name_snapshot}</div>
                      {checked && (
                        <div style={{ fontSize: 10, color: UXP.greenDeep, marginTop: 2 }}>
                          Done{line.checked_by_name ? ` by ${line.checked_by_name}` : ''}
                          {line.checked_at ? ` · ${new Date(line.checked_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}
                        </div>
                      )}
                      <div style={{ fontSize: 10, color: UXP.lavText, marginTop: 2 }}>Tap for method →</div>
                    </button>
                    <div style={{ padding: '10px 14px', textAlign: 'right', fontSize: 15, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' }}>
                      {line.uncertain ? '—' : fmtQty(line.total_qty, line.unit)}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {modal && <MethodModal line={modal} onClose={() => setModal(null)} />}
    </AppShell>
  )
}

function MethodModal({ line, onClose }: { line: Line; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const method = line.meta?.method || line.meta?.notes || null
  const ingredients = line.meta?.ingredients ?? []
  const uses = line.meta?.uses ?? []
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,18,40,0.5)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 0 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '14px 14px 0 0', width: 'min(720px, 100%)', maxHeight: '85vh', overflowY: 'auto', padding: 22, boxShadow: '0 -8px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: UXP.ink1 }}>{line.name_snapshot}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', fontSize: 22, color: UXP.ink3, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>

        {method && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: UXP.ink4, marginBottom: 6 }}>Method</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: UXP.ink1, whiteSpace: 'pre-wrap' }}>{method}</div>
          </div>
        )}

        {line.kind === 'component' && ingredients.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: UXP.ink4, marginBottom: 6 }}>Ingredients</div>
            {ingredients.map((i, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: `0.5px solid ${UXP.subtleBg}`, fontSize: 13 }}>
                <div>
                  <span style={{ color: UXP.ink1 }}>{i.product_name ?? 'Ingredient'}</span>
                  {i.notes && <span style={{ color: UXP.ink4 }}> — {i.notes}</span>}
                </div>
                <span style={{ color: UXP.ink2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{i.quantity} {i.unit ?? ''}</span>
              </div>
            ))}
          </div>
        )}

        {line.kind === 'product' && uses.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: UXP.ink4, marginBottom: 6 }}>Used in</div>
            {uses.map((u, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: `0.5px solid ${UXP.subtleBg}`, fontSize: 13 }}>
                <div>
                  <span style={{ color: UXP.ink1 }}>{u.recipe_name ?? 'Dish'}</span>
                  {u.notes && <span style={{ color: UXP.ink4 }}> — {u.notes}</span>}
                </div>
                <span style={{ color: UXP.ink2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{u.quantity} {u.unit ?? ''}</span>
              </div>
            ))}
          </div>
        )}

        {!method && ingredients.length === 0 && uses.length === 0 && (
          <div style={{ fontSize: 13, color: UXP.ink4 }}>No method recorded for this item yet.</div>
        )}
      </div>
    </div>
  )
}

function Card({ children, tone }: { children: React.ReactNode; tone?: 'bad' }) {
  return (
    <div style={{
      padding: '16px 18px', borderRadius: 10, fontSize: 13,
      background: tone === 'bad' ? UXP.roseFill : UXP.cardBg,
      border: `0.5px solid ${tone === 'bad' ? UXP.rose : UXP.border}`,
      color: tone === 'bad' ? UXP.roseText : UXP.ink3,
    }}>{children}</div>
  )
}
