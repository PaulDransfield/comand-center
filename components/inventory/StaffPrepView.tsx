'use client'
// components/inventory/StaffPrepView.tsx
//
// Focused prep screen for the `staff` role. Line cooks/bartenders work the
// list; this is built for many of them working it at once:
//
//   • Grouped PER DISH (M156) — each dish is a section showing its
//     sub-recipes + raw ingredients with THAT dish's share, so a chef can
//     take a dish and pull exactly what it needs. No more guessing what a
//     shared aggregate line is for. A "Totals" tab still shows the summed
//     pull-once quantities for bulk pulling / ordering.
//   • Tap-to-log waste PER LINE — a small "waste" affordance on each row,
//     tapped only when something was actually wasted (no end-of-list modal
//     that one chef has to fill in for everyone).
//   • Accountability — every check-off logs the person (M153); when a whole
//     dish is done we show who prepped it.
//
// No money anywhere; no create/edit affordances (those endpoints 403 for staff).

import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'

interface SubIngredient { product_name: string | null; quantity: number; unit: string | null; notes: string | null; position: number }
interface UseRef { recipe_name: string | null; notes: string | null; quantity: number; unit: string | null }
interface Line {
  id: string
  kind: 'component' | 'product'
  entity_id: string
  name_snapshot: string
  total_qty: number
  unit: string
  uncertain: null | string
  dish_recipe_id?: string | null
  dish_name_snapshot?: string | null
  checked_at: string | null
  checked_by_name?: string | null
  meta?: { method?: string | null; notes?: string | null; ingredients?: SubIngredient[]; uses?: UseRef[] }
}
interface SessionResp {
  session: { id: string; name: string | null; completed_at: string | null }
  lines: Line[]
}

// Chef-facing waste reasons (subset of the waste_log allow-list).
const WASTE_REASONS: { v: string; l: string }[] = [
  { v: 'spoilage',       l: 'Spoiled' },
  { v: 'overproduction', l: 'Over-prepped' },
  { v: 'spill',          l: 'Spill / drop' },
  { v: 'staff_meal',     l: 'Staff meal' },
  { v: 'other',          l: 'Other' },
]

function fmtQty(qty: number, unit: string): string {
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
  const [tab, setTab]       = useState<'dishes' | 'totals'>('dishes')
  const [wasteFor, setWasteFor]     = useState<string | null>(null)   // line id with the waste form open
  const [wastedLines, setWasted]    = useState<Set<string>>(new Set()) // logged-this-session, for UI feedback

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

  async function logWaste(line: Line, qty: number, reason: string) {
    if (!bizId || !data) return
    const body: any = {
      business_id:     bizId,
      prep_session_id: data.session.id,
      quantity:        qty,
      unit:            line.unit,
      reason,
    }
    if (line.kind === 'component') body.recipe_id = line.entity_id
    else                          body.product_id = line.entity_id
    const r = await fetch('/api/inventory/waste', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
    setWasted(prev => new Set(prev).add(line.id))
    setWasteFor(null)
  }

  const lines = data?.lines ?? []
  const done  = lines.filter(l => l.checked_at != null).length
  const completed = !!data?.session.completed_at

  // ── Group by dish (M156). Legacy aggregated lines (no dish) fall into a
  // single "All items" group so old sessions still render.
  const dishGroups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; lines: Line[] }>()
    for (const l of lines) {
      const key = l.dish_recipe_id ?? '__all__'
      const name = l.dish_name_snapshot ?? 'All items'
      if (!m.has(key)) m.set(key, { key, name, lines: [] })
      m.get(key)!.lines.push(l)
    }
    return Array.from(m.values())
  }, [lines])

  // ── Totals: sum each unique item across dishes (the old pull-once view).
  const totals = useMemo(() => {
    const m = new Map<string, { key: string; kind: 'component' | 'product'; name: string; unit: string; total: number; uncertain: boolean; dishes: number }>()
    for (const l of lines) {
      const key = `${l.kind}|${l.entity_id}|${l.unit}`
      if (!m.has(key)) m.set(key, { key, kind: l.kind, name: l.name_snapshot, unit: l.unit, total: 0, uncertain: false, dishes: 0 })
      const t = m.get(key)!
      t.total += Number(l.total_qty) || 0
      t.dishes += 1
      if (l.uncertain) t.uncertain = true
    }
    return Array.from(m.values()).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'component' ? -1 : 1))
  }, [lines])

  return (
    <AppShell>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '16px 14px 90px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1 }}>Prep list</h1>
        <p style={{ margin: '4px 0 14px', fontSize: 12, color: UXP.ink3 }}>
          {data?.session.name ? `${data.session.name} · ` : ''}Each dish is a section — take one and pull what it needs. Tap a row for the method.
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

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {([['dishes', 'Dishes'], ['totals', 'Totals']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)} style={{
                  padding: '7px 14px', fontSize: 12, fontWeight: 600,
                  background: tab === k ? UXP.lavFill : 'transparent',
                  color: tab === k ? UXP.lavText : UXP.ink3,
                  border: `0.5px solid ${tab === k ? UXP.lavMid : UXP.border}`,
                  borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                }}>{label}</button>
              ))}
            </div>

            {/* ── Dishes view ─────────────────────────────────────── */}
            {tab === 'dishes' && dishGroups.map(group => {
              const gDone = group.lines.filter(l => l.checked_at != null).length
              const gAll  = group.lines.length
              const allDone = gDone === gAll && gAll > 0
              const preppers = Array.from(new Set(group.lines.filter(l => l.checked_at && l.checked_by_name).map(l => l.checked_by_name as string)))
              return (
                <div key={group.key} style={{ marginBottom: 12, background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', background: UXP.subtleBg, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: UXP.ink1, textTransform: 'uppercase' as const, letterSpacing: '0.03em' }}>{group.name}</div>
                    <div style={{ fontSize: 11, color: allDone ? UXP.greenDeep : UXP.ink3, fontWeight: 600, whiteSpace: 'nowrap' as const }}>
                      {allDone && preppers.length > 0 ? `Prepped by ${preppers.join(', ')}` : `${gDone}/${gAll}`}
                    </div>
                  </div>
                  {group.lines.map(line => (
                    <PrepRow key={line.id} line={line} completed={completed}
                      wasted={wastedLines.has(line.id)}
                      wasteOpen={wasteFor === line.id}
                      onToggle={() => toggle(line)}
                      onOpenMethod={() => setModal(line)}
                      onOpenWaste={() => setWasteFor(wasteFor === line.id ? null : line.id)}
                      onLogWaste={(qty, reason) => logWaste(line, qty, reason)}
                      onCancelWaste={() => setWasteFor(null)} />
                  ))}
                </div>
              )
            })}

            {/* ── Totals view (read-only — bulk pull / ordering reference) ── */}
            {tab === 'totals' && (
              <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '8px 14px', fontSize: 11, color: UXP.ink4 }}>
                  Summed across all dishes — what to pull/make in total. Tick items off in the Dishes tab.
                </div>
                {totals.map(t => (
                  <div key={t.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '11px 14px', borderTop: `0.5px solid ${UXP.borderSoft}` }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, color: UXP.ink1 }}>{t.name}</div>
                      <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>
                        {t.kind === 'component' ? 'make' : 'pull'}{t.dishes > 1 ? ` · ${t.dishes} dishes` : ''}
                      </div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const }}>
                      {t.uncertain ? '—' : fmtQty(t.total, t.unit)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {modal && <MethodModal line={modal} onClose={() => setModal(null)} />}
    </AppShell>
  )
}

// ── One prep row: checkbox + name + qty + method + waste affordance ──────
function PrepRow({ line, completed, wasted, wasteOpen, onToggle, onOpenMethod, onOpenWaste, onLogWaste, onCancelWaste }: {
  line: Line
  completed: boolean
  wasted: boolean
  wasteOpen: boolean
  onToggle: () => void
  onOpenMethod: () => void
  onOpenWaste: () => void
  onLogWaste: (qty: number, reason: string) => Promise<void>
  onCancelWaste: () => void
}) {
  const checked = line.checked_at != null
  const [qty, setQty]       = useState('')
  const [reason, setReason] = useState('spoilage')
  const [busy, setBusy]     = useState(false)
  const [wErr, setWErr]     = useState<string | null>(null)

  async function submit() {
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) { setWErr('Enter a quantity'); return }
    setBusy(true); setWErr(null)
    try { await onLogWaste(n, reason); setQty('') }
    catch (e: any) { setWErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ borderTop: `0.5px solid ${UXP.borderSoft}`, background: checked ? UXP.subtleBg : UXP.cardBg }}>
      <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr auto', alignItems: 'center', opacity: checked ? 0.7 : 1 }}>
        <button onClick={onToggle} disabled={completed} aria-label={checked ? 'Uncheck' : 'Check'}
          style={{ height: 60, width: 52, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: completed ? 'default' : 'pointer' }}>
          <span style={{
            width: 26, height: 26, borderRadius: 6,
            border: `1.5px solid ${checked ? UXP.lavDeep : UXP.border}`,
            background: checked ? UXP.lavDeep : 'transparent', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
          }}>{checked ? '✓' : ''}</span>
        </button>
        <button onClick={onOpenMethod}
          style={{ textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 4px 10px 0', fontFamily: 'inherit', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1, textDecoration: checked ? 'line-through' : 'none' }}>
            {line.name_snapshot}
            {line.kind === 'component' && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 600, color: UXP.lavText, background: UXP.lavFill, padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' as const }}>make</span>}
          </div>
          {checked && (
            <div style={{ fontSize: 10, color: UXP.greenDeep, marginTop: 2 }}>
              Done{line.checked_by_name ? ` by ${line.checked_by_name}` : ''}
              {line.checked_at ? ` · ${new Date(line.checked_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <span style={{ fontSize: 10, color: UXP.lavText }}>Tap for method →</span>
            <span onClick={(e) => { e.stopPropagation(); onOpenWaste() }}
              style={{ fontSize: 10, color: wasted ? UXP.coral : UXP.ink4, cursor: 'pointer', fontWeight: wasted ? 600 : 400 }}>
              {wasted ? 'waste logged ✓ · add more' : '+ log waste'}
            </span>
          </div>
        </button>
        <div style={{ padding: '10px 14px', textAlign: 'right', fontSize: 15, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
          {line.uncertain ? '—' : fmtQty(line.total_qty, line.unit)}
        </div>
      </div>

      {/* Inline waste form — only when the chef taps "log waste" */}
      {wasteOpen && (
        <div style={{ padding: '8px 14px 12px 52px', display: 'flex', flexDirection: 'column' as const, gap: 8, background: UXP.cardBg }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <input type="number" min="0" step="0.01" inputMode="decimal" value={qty} autoFocus
              onChange={e => setQty(e.target.value)} placeholder="qty"
              style={{ width: 80, padding: '8px 10px', fontSize: 14, border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit' }} />
            <span style={{ fontSize: 12, color: UXP.ink3 }}>{line.unit}</span>
            <select value={reason} onChange={e => setReason(e.target.value)}
              style={{ padding: '8px 10px', fontSize: 13, border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit', background: '#fff' }}>
              {WASTE_REASONS.map(r => <option key={r.v} value={r.v}>{r.l}</option>)}
            </select>
            <button onClick={submit} disabled={busy}
              style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600, background: UXP.coral, color: '#fff', border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
              {busy ? 'Logging…' : 'Log waste'}
            </button>
            <button onClick={onCancelWaste} disabled={busy}
              style={{ padding: '8px 10px', fontSize: 12, background: 'transparent', color: UXP.ink3, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              Cancel
            </button>
          </div>
          {wErr && <div style={{ fontSize: 11, color: UXP.roseText }}>{wErr}</div>}
        </div>
      )}
    </div>
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
