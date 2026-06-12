'use client'
// components/inventory/StaffPrepView.tsx
//
// Focused prep screen for the `staff` role. Uses the SHARED
// <PrepDishAccordion> (same layout the owner/manager page uses) so the two
// never diverge: one collapsible dropdown per dish, both sub-recipes and raw
// ingredients inside, a type pill, per-line tap-to-log waste, and per-dish
// "Prepped by" accountability. This file owns only the data load, the toggle,
// the waste POST, and the read-only method modal.

import { useCallback, useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import PrepDishAccordion, { type PrepAccLine, type WasteEntry } from '@/components/inventory/PrepDishAccordion'

interface SubIngredient { product_name: string | null; quantity: number; unit: string | null; notes: string | null; position: number }
interface UseRef { recipe_name: string | null; notes: string | null; quantity: number; unit: string | null }
interface Line extends PrepAccLine {
  meta?: { method?: string | null; notes?: string | null; ingredients?: SubIngredient[]; uses?: UseRef[] }
}
interface SessionResp {
  session: { id: string; name: string | null; completed_at: string | null }
  lines: Line[]
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

  async function toggle(line: PrepAccLine) {
    if (!data) return
    const target = line.checked_at == null
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
      load()
    } catch (e: any) { setError(e.message); load() }
  }

  async function logWaste(line: PrepAccLine, qty: number, reason: string) {
    if (!bizId || !data) return
    const body: any = { business_id: bizId, prep_session_id: data.session.id, quantity: qty, unit: line.unit, reason }
    if (line.kind === 'component') body.recipe_id = line.entity_id
    else                          body.product_id = line.entity_id
    const r = await fetch('/api/inventory/waste', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
  }

  // Batch waste from the per-dish "anything go in the bin?" prompt.
  async function logWasteBatch(events: WasteEntry[]) {
    if (!bizId || !data || events.length === 0) return
    const body = {
      business_id: bizId,
      events: events.map(e => ({
        ...(e.line.kind === 'component' ? { recipe_id: e.line.entity_id } : { product_id: e.line.entity_id }),
        quantity: e.qty, unit: e.line.unit, reason: e.reason, prep_session_id: data.session.id,
      })),
    }
    const r = await fetch('/api/inventory/waste', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
  }

  const lines = data?.lines ?? []
  const done  = lines.filter(l => l.checked_at != null).length
  const completed = !!data?.session.completed_at

  return (
    <AppShell>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '16px 14px 90px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1 }}>Prep list</h1>
        <p style={{ margin: '4px 0 14px', fontSize: 12, color: UXP.ink3 }}>
          {data?.session.name ? `${data.session.name} · ` : ''}Tap a dish to open it — everything to make and pull is inside.
        </p>

        {!bizId && <Card>Select a business in the sidebar to load the prep list.</Card>}
        {error && <Card tone="bad">{error}</Card>}
        {bizId && loading && <Card>Loading…</Card>}
        {bizId && !loading && noSession && <Card>No prep list set for today yet — your manager creates it.</Card>}

        {data && lines.length > 0 && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: UXP.ink3, marginBottom: 4 }}>
                <span>{done} / {lines.length} done</span>
                {completed && <span style={{ color: UXP.greenDeep, fontWeight: 600 }}>COMPLETED</span>}
              </div>
              <div style={{ height: 5, background: UXP.subtleBg, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${lines.length ? (done / lines.length) * 100 : 0}%`, background: UXP.lavDeep, transition: 'width 200ms' }} />
              </div>
            </div>

            <PrepDishAccordion
              lines={lines}
              completed={completed}
              onToggle={toggle}
              onOpenLine={(l) => setModal(l as Line)}
              onLogWaste={logWaste}
              onLogWasteBatch={logWasteBatch}
            />
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
