'use client'
// components/inventory/PrepDishAccordion.tsx
//
// Shared prep-list layout used by BOTH the staff tick-off view and the
// owner/manager prep page, so the two never diverge again.
//
// Layout: one collapsible dropdown PER DISH. Click a dish to expand it and
// see everything for that dish together — sub-recipes to make AND raw
// ingredients to pull — instead of bouncing between "components" and
// "ingredients" tabs. A type pill (pizza / pasta / …) sits next to the dish
// name. A "Totals" tab still gives the summed pull-once view for bulk
// pulling / ordering.
//
// The parent owns the modal (staff = read-only method; owner = editor) and
// the toggle/waste endpoints — this component is pure layout + local UI
// state (which dishes are open, which waste form is showing).

import { useEffect, useMemo, useRef, useState } from 'react'
import { UXP } from '@/lib/constants/tokens'

export interface WasteEntry { line: PrepAccLine; qty: number; reason: string }

export interface PrepAccLine {
  id: string
  kind: 'component' | 'product'
  entity_id: string
  name_snapshot: string
  total_qty: number
  unit: string
  uncertain: null | string
  uncertain_reason?: string | null
  dish_recipe_id?: string | null
  dish_name_snapshot?: string | null
  dish_type?: string | null
  checked_at: string | null
  checked_by_name?: string | null
}

const WASTE_REASONS: { v: string; l: string }[] = [
  { v: 'spoilage',       l: 'Spoiled' },
  { v: 'overproduction', l: 'Over-prepped' },
  { v: 'spill',          l: 'Spill / drop' },
  { v: 'staff_meal',     l: 'Staff meal' },
  { v: 'other',          l: 'Other' },
]

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  pizza:    { bg: '#fdece4', fg: '#c0703a' },
  pasta:    { bg: '#fdf3da', fg: '#9a7b1f' },
  starter:  { bg: '#e9f5ec', fg: '#3f7d52' },
  main:     { bg: '#eae6f7', fg: '#6a5bd0' },
  side:     { bg: '#eef4f8', fg: '#3f6d8c' },
  dessert:  { bg: '#fbe9f1', fg: '#b1487f' },
  drink:    { bg: '#e6f3f5', fg: '#2f7d86' },
  cocktail: { bg: '#f0e9f7', fg: '#7e57c2' },
  sauce:    { bg: '#f4efe6', fg: '#8a6f45' },
}

function fmtQty(qty: number, unit: string): string {
  if (unit === 'g' && qty >= 1000)  return `${Math.round(qty / 100) / 10} kg`
  if (unit === 'ml' && qty >= 1000) return `${Math.round(qty / 100) / 10} l`
  return `${Math.round(qty * 10) / 10} ${unit}`
}

function TypePill({ type }: { type: string | null | undefined }) {
  if (!type) return null
  const c = TYPE_COLORS[type.toLowerCase()] ?? { bg: UXP.subtleBg, fg: UXP.ink3 }
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const,
      padding: '2px 7px', borderRadius: 999, background: c.bg, color: c.fg, whiteSpace: 'nowrap' as const,
    }}>{type}</span>
  )
}

export default function PrepDishAccordion({
  lines, completed, onToggle, onOpenLine, onLogWaste, onLogWasteBatch,
}: {
  lines: PrepAccLine[]
  completed: boolean
  onToggle: (line: PrepAccLine) => void
  onOpenLine: (line: PrepAccLine) => void
  onLogWaste?: (line: PrepAccLine, qty: number, reason: string) => Promise<void>
  // Batch waste — fired from the per-dish "anything go in the bin?" prompt
  // that pops when a dish is finished. When provided, completing a dish
  // opens that prompt.
  onLogWasteBatch?: (events: WasteEntry[]) => Promise<void>
}) {
  const [tab, setTab]           = useState<'dishes' | 'totals'>('dishes')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [wasteFor, setWasteFor] = useState<string | null>(null)
  const [wasted, setWasted]     = useState<Set<string>>(new Set())
  const [wasteDishKey, setWasteDishKey] = useState<string | null>(null)  // dish whose completion prompt is open
  const promptedRef = useRef<Set<string>>(new Set())
  const didInit = useRef(false)

  // Group by dish, preserving the stored (dish-by-dish, components-then-
  // products) order. Legacy aggregated lines (no dish) fall into one group.
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; type: string | null; lines: PrepAccLine[] }>()
    for (const l of lines) {
      const key = l.dish_recipe_id ?? '__all__'
      if (!m.has(key)) m.set(key, { key, name: l.dish_name_snapshot ?? 'All items', type: l.dish_type ?? null, lines: [] })
      m.get(key)!.lines.push(l)
    }
    return Array.from(m.values())
  }, [lines])

  // First load: expand everything when there's a single dish, else collapse
  // (a clean scannable dish list the chef drills into).
  useEffect(() => {
    if (didInit.current || groups.length === 0) return
    didInit.current = true
    setExpanded(groups.length === 1 ? new Set(groups.map(g => g.key)) : new Set())
  }, [groups])

  // When a dish becomes fully checked, pop the "anything go in the bin?"
  // prompt for THAT dish — once per completion. This replaces the old
  // end-of-session modal: waste is logged dish-by-dish, attributed to
  // whoever is logged in. Re-opening then re-completing a dish re-arms it.
  useEffect(() => {
    if (completed || !onLogWasteBatch) return
    for (const g of groups) {
      const allDone = g.lines.length > 0 && g.lines.every(l => l.checked_at != null)
      if (allDone && !promptedRef.current.has(g.key)) {
        promptedRef.current.add(g.key)
        setWasteDishKey(g.key)
        return
      }
      if (!allDone) promptedRef.current.delete(g.key)
    }
  }, [groups, completed, onLogWasteBatch])

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
    <div>
      {/* Dishes / Totals toggle */}
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

      {/* ── Dishes: one collapsible dropdown per dish ─────────────── */}
      {tab === 'dishes' && groups.map(group => {
        const open = expanded.has(group.key)
        const gDone = group.lines.filter(l => l.checked_at != null).length
        const gAll  = group.lines.length
        const allDone = gDone === gAll && gAll > 0
        const preppers = Array.from(new Set(group.lines.filter(l => l.checked_at && l.checked_by_name).map(l => l.checked_by_name as string)))
        return (
          <div key={group.key} style={{ marginBottom: 10, background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <button
              onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(group.key) ? n.delete(group.key) : n.add(group.key); return n })}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '12px 14px', background: open ? UXP.subtleBg : UXP.cardBg,
                border: 'none', borderBottom: open ? `0.5px solid ${UXP.border}` : 'none',
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' as const,
              }}>
              <span style={{ fontSize: 13, color: UXP.ink4, width: 14, flexShrink: 0, transition: 'transform 150ms', transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: UXP.ink1 }}>{group.name}</span>
              <TypePill type={group.type} />
              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: allDone ? UXP.greenDeep : UXP.ink3, whiteSpace: 'nowrap' as const }}>
                {allDone && preppers.length ? `Prepped by ${preppers.join(', ')}` : `${gDone}/${gAll}`}
              </span>
            </button>
            {open && group.lines.map(line => (
              <PrepRow key={line.id} line={line} completed={completed}
                wasted={wasted.has(line.id)}
                wasteOpen={wasteFor === line.id}
                onToggle={() => onToggle(line)}
                onOpenMethod={() => onOpenLine(line)}
                onOpenWaste={onLogWaste ? () => setWasteFor(wasteFor === line.id ? null : line.id) : undefined}
                onLogWaste={onLogWaste ? async (qty, reason) => { await onLogWaste(line, qty, reason); setWasted(p => new Set(p).add(line.id)); setWasteFor(null) } : undefined}
                onCancelWaste={() => setWasteFor(null)} />
            ))}
          </div>
        )
      })}

      {/* ── Totals: summed pull-once view (read-only) ─────────────── */}
      {tab === 'totals' && (
        <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '8px 14px', fontSize: 11, color: UXP.ink4 }}>
            Summed across all dishes — what to make / pull in total. Tick items off under each dish.
          </div>
          {totals.map(t => (
            <div key={t.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '11px 14px', borderTop: `0.5px solid ${UXP.borderSoft}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, color: UXP.ink1 }}>{t.name}</div>
                <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>{t.kind === 'component' ? 'make' : 'pull'}{t.dishes > 1 ? ` · ${t.dishes} dishes` : ''}</div>
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const }}>
                {t.uncertain ? '—' : fmtQty(t.total, t.unit)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-dish "anything go in the bin?" prompt, fired on dish completion */}
      {wasteDishKey && onLogWasteBatch && (() => {
        const g = groups.find(x => x.key === wasteDishKey)
        if (!g) return null
        return (
          <DishWasteModal
            dishName={g.name}
            lines={g.lines}
            onClose={() => setWasteDishKey(null)}
            onSubmit={async (events) => { await onLogWasteBatch(events); setWasteDishKey(null) }}
          />
        )
      })()}
    </div>
  )
}

function PrepRow({ line, completed, wasted, wasteOpen, onToggle, onOpenMethod, onOpenWaste, onLogWaste, onCancelWaste }: {
  line: PrepAccLine
  completed: boolean
  wasted: boolean
  wasteOpen: boolean
  onToggle: () => void
  onOpenMethod: () => void
  onOpenWaste?: () => void
  onLogWaste?: (qty: number, reason: string) => Promise<void>
  onCancelWaste: () => void
}) {
  const checked = line.checked_at != null
  const [qty, setQty]       = useState('')
  const [reason, setReason] = useState('spoilage')
  const [busy, setBusy]     = useState(false)
  const [wErr, setWErr]     = useState<string | null>(null)

  async function submit() {
    if (!onLogWaste) return
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
          style={{ height: 58, width: 52, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: completed ? 'default' : 'pointer' }}>
          <span style={{
            width: 24, height: 24, borderRadius: 6,
            border: `1.5px solid ${checked ? UXP.lavDeep : UXP.border}`,
            background: checked ? UXP.lavDeep : 'transparent', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
          }}>{checked ? '✓' : ''}</span>
        </button>
        <button onClick={onOpenMethod}
          style={{ textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '9px 4px 9px 0', fontFamily: 'inherit', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1, textDecoration: checked ? 'line-through' : 'none' }}>
            {line.name_snapshot}
            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 600, color: line.kind === 'component' ? UXP.lavText : UXP.ink4, background: line.kind === 'component' ? UXP.lavFill : UXP.subtleBg, padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' as const }}>
              {line.kind === 'component' ? 'make' : 'pull'}
            </span>
          </div>
          {checked && (
            <div style={{ fontSize: 10, color: UXP.greenDeep, marginTop: 2 }}>
              Done{line.checked_by_name ? ` by ${line.checked_by_name}` : ''}
              {line.checked_at ? ` · ${new Date(line.checked_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </div>
          )}
          {line.uncertain && (
            <div style={{ fontSize: 10, color: UXP.coral, marginTop: 2 }}>{line.uncertain_reason ?? 'Set yield to roll up'}</div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 3 }}>
            <span style={{ fontSize: 10, color: UXP.lavText }}>Tap for method →</span>
            {onOpenWaste && (
              <span onClick={(e) => { e.stopPropagation(); onOpenWaste() }}
                style={{ fontSize: 10, color: wasted ? UXP.coral : UXP.ink4, cursor: 'pointer', fontWeight: wasted ? 600 : 400 }}>
                {wasted ? 'waste logged ✓ · add more' : '+ log waste'}
              </span>
            )}
          </div>
        </button>
        <div style={{ padding: '9px 14px', textAlign: 'right', fontSize: 15, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
          {line.uncertain ? '—' : fmtQty(line.total_qty, line.unit)}
        </div>
      </div>

      {wasteOpen && onLogWaste && (
        <div style={{ padding: '8px 14px 12px 52px', display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
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
              style={{ padding: '8px 10px', fontSize: 12, background: 'transparent', color: UXP.ink3, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          </div>
          {wErr && <div style={{ fontSize: 11, color: UXP.roseText }}>{wErr}</div>}
        </div>
      )}
    </div>
  )
}

// Per-dish waste prompt, fired when a dish is finished. Lists the dish's
// prepped items; the cook enters a qty for anything that went in the bin
// (or skips). The qty is logged against whoever is signed in (created_by).
function DishWasteModal({ dishName, lines, onClose, onSubmit }: {
  dishName: string
  lines: PrepAccLine[]
  onClose: () => void
  onSubmit: (events: WasteEntry[]) => Promise<void>
}) {
  const [rows, setRows] = useState(() =>
    lines.filter(l => l.total_qty > 0).map(l => ({ line: l, qty: '', reason: 'overproduction' })))
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const filled = rows.filter(r => Number(r.qty) > 0)

  async function submit() {
    setBusy(true); setErr(null)
    try {
      await onSubmit(filled.map(r => ({ line: r.line, qty: Number(r.qty), reason: r.reason })))
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,18,40,0.55)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '14px 14px 0 0', width: 'min(640px, 100%)', maxHeight: '85vh', overflowY: 'auto', padding: 22, boxShadow: '0 -8px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: UXP.ink1 }}>{dishName} — anything go in the bin?</div>
        <p style={{ margin: '6px 0 14px', fontSize: 12, color: UXP.ink3, lineHeight: 1.5 }}>
          Log waste for any item below. Leave qty empty if nothing was wasted. Recorded against you, with the cost snapshotted so reports stay accurate.
        </p>
        {rows.map((r, i) => (
          <div key={r.line.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: i === 0 ? 'none' : `0.5px solid ${UXP.borderSoft}`, flexWrap: 'wrap' as const }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 13, color: UXP.ink1 }}>{r.line.name_snapshot}</div>
              <div style={{ fontSize: 10, color: UXP.ink4 }}>prepped {fmtQty(r.line.total_qty, r.line.unit)}</div>
            </div>
            <input type="number" min="0" step="0.01" inputMode="decimal" value={r.qty} placeholder="0"
              onChange={e => setRows(prev => prev.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
              style={{ width: 70, padding: '7px 9px', fontSize: 14, border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit' }} />
            <span style={{ fontSize: 12, color: UXP.ink3, width: 24 }}>{r.line.unit}</span>
            <select value={r.reason} onChange={e => setRows(prev => prev.map((x, j) => j === i ? { ...x, reason: e.target.value } : x))}
              style={{ padding: '7px 9px', fontSize: 12, border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit', background: '#fff' }}>
              {WASTE_REASONS.map(w => <option key={w.v} value={w.v}>{w.l}</option>)}
            </select>
          </div>
        ))}
        {err && <div style={{ fontSize: 11, color: UXP.roseText, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} disabled={busy}
            style={{ padding: '8px 14px', fontSize: 12, background: 'transparent', color: UXP.ink3, border: `0.5px solid ${UXP.border}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
            Skip
          </button>
          <button onClick={submit} disabled={busy}
            style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, background: filled.length > 0 ? UXP.coral : UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
            {busy ? 'Saving…' : filled.length > 0 ? `Log ${filled.length} waste & done` : 'Nothing wasted'}
          </button>
        </div>
      </div>
    </div>
  )
}
