'use client'
// app/inventory/recipes/prep/page.tsx
//
// Prep list — owner enters expected dishes × covers, system aggregates
// shared sub-recipes across them so the kitchen sees "prep 4 kg sauce"
// once, not "200 g + 180 g + …" scattered across each dish ticket.
//
// v1: manual covers. Demand-prediction (POS-driven) is the future seam.
// Honest-incomplete: a sub-recipe with no yield set surfaces uncertain
// rather than silently producing a wrong total.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'

interface DishRow {
  id:               string
  name:             string
  type:             string | null
  menu_price:       number | null
  portions:         number
  ingredient_count: number
  missing_prices:   number
  unit_mismatches:  number
}

interface UseRef {
  ingredient_id: string
  recipe_id:     string
  recipe_name:   string | null
  notes:         string | null
  quantity:      number
  unit:          string | null
}
interface PrepComponentLine {
  subrecipe_id:     string
  name:             string | null
  total_qty:        number
  unit:             string
  source_recipes:   string[]
  uncertain:        null | 'sub_no_yield' | 'unit_mismatch' | 'cycle'
  uncertain_reason: string | null
  meta?: { method?: string | null }
}
interface PrepProductLine {
  product_id:     string
  name:           string | null
  total_qty:      number
  unit:           string
  source_recipes: string[]
  category?:      string | null
  meta?: { uses?: UseRef[] }
}
interface PrepResult {
  components: PrepComponentLine[]
  products:   PrepProductLine[]
  flags:      Array<{ recipe_id: string; reason: string }>
}

// Active-session shape: persisted prep_session + its frozen lines.
// Loaded from /api/inventory/prep-sessions/[id] (or via the active=1 list).
interface PrepSession {
  id:           string
  name:         string | null
  inputs:       Array<{ recipe_id: string; qty: number }>
  created_at:   string
  completed_at: string | null
}
interface PrepSessionLine {
  id:                string
  kind:              'component' | 'product'
  entity_id:         string
  name_snapshot:     string
  total_qty:         number
  unit:              string
  uncertain:         null | 'sub_no_yield' | 'unit_mismatch' | 'cycle'
  uncertain_reason:  string | null
  source_recipe_ids: string[]
  checked_at:        string | null
  position:          number
  // Server enrichment. For component lines: meta.method (sub-recipe's
  // own method). For product lines: meta.uses (per-recipe ingredient
  // notes — "quarter the carciofi" etc.). Loaded live by the GET
  // endpoint so owner method edits flow through immediately. ingredient_id
  // is the recipe_ingredients row id — used by the inline-edit UI to
  // PATCH the right target when the chef writes a prep note.
  meta?: {
    method?: string | null
    uses?:   UseRef[]
  }
}

// Local copy of the kitchen-display formatter so we don't have to ship
// a server dependency to the client just for one helper. Keep in sync
// with lib/inventory/prep-list.ts::formatPrepQty.
function formatPrepQty(qty: number, unit: string): { qty: number; unit: string } {
  if (unit === 'g'  && qty >= 1000) return { qty: round2(qty / 1000), unit: 'kg' }
  if (unit === 'ml' && qty >= 1000) return { qty: round2(qty / 1000), unit: 'l'  }
  return { qty: round2(qty), unit }
}
function round2(n: number) { return Math.round(n * 100) / 100 }

const DISH_TYPES = new Set(['starter','main','pasta','pizza','dessert','drink','cocktail','side'])
const isDish = (r: any) =>
  (r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
  || (r.menu_price != null && Number(r.menu_price) > 0)
  || (r.type && DISH_TYPES.has(String(r.type).toLowerCase()))

export default function PrepListPage() {
  const [bizId, setBizId] = useState<string | null>(null)
  const [dishes, setDishes] = useState<DishRow[]>([])
  const [loadingDishes, setLoadingDishes] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // selected = recipe_id → qty (covers/portions). 0 / missing = not in the list.
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [result,   setResult]   = useState<PrepResult | null>(null)
  const [computing, setComputing] = useState(false)
  const [search, setSearch] = useState('')
  // Tab between the result lists so the page isn't a wall of tables.
  // Default is components (the higher-value aggregation) — owner can flip
  // to ingredients when they want to pull stock or write a shopping list.
  const [tab, setTab] = useState<'components' | 'ingredients' | 'flags'>('components')

  // v1.1 — active session. When set, the page renders prep-mode: frozen
  // summary + checkable rows. When null, create-mode: select dishes,
  // preview the aggregation, click "Save & start prep" to persist.
  const [activeSession, setActiveSession] = useState<PrepSession | null>(null)
  const [sessionLines,  setSessionLines]  = useState<PrepSessionLine[]>([])
  const [sessionLoading, setSessionLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Read the sidebar's selected biz from localStorage; mirror across tabs.
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

  // Fetch dishes for the dropdown. We pull the full recipe list and
  // filter dish-shape client-side (same isDish() rule as /inventory/recipes
  // so what the owner sees there matches what's pickable here).
  const loadDishes = useCallback(async () => {
    if (!bizId) { setLoadingDishes(false); return }
    setLoadingDishes(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/recipes?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const data = await r.json()
      const all: any[] = data.recipes ?? []
      setDishes(all.filter(isDish))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingDishes(false)
    }
  }, [bizId])
  useEffect(() => {
    if (bizId) loadDishes()
    else setLoadingDishes(false)
  }, [bizId, loadDishes])

  // Derived: items in the order the owner picked them.
  const selectedItems = useMemo(
    () => Object.entries(selected).filter(([, q]) => q > 0).map(([recipe_id, qty]) => ({ recipe_id, qty })),
    [selected],
  )

  // Active session loader. Looks up whether the business has an open
  // prep session and, if so, pulls its frozen lines. Runs on biz change
  // and on demand after create/complete/discard actions.
  const loadActiveSession = useCallback(async () => {
    if (!bizId) { setSessionLoading(false); return }
    setSessionLoading(true)
    try {
      const r = await fetch(`/api/inventory/prep-sessions?business_id=${encodeURIComponent(bizId)}&active=1`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const { sessions } = await r.json()
      const s = sessions?.[0]
      if (!s) { setActiveSession(null); setSessionLines([]); return }
      // Load the full session with lines.
      const r2 = await fetch(`/api/inventory/prep-sessions/${s.id}`, { cache: 'no-store' })
      if (!r2.ok) throw new Error((await r2.json().catch(() => ({}))).error ?? `HTTP ${r2.status}`)
      const { session, lines } = await r2.json()
      setActiveSession(session)
      setSessionLines(lines ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSessionLoading(false)
    }
  }, [bizId])
  useEffect(() => {
    if (bizId) loadActiveSession()
    else setSessionLoading(false)
  }, [bizId, loadActiveSession])

  // Persist the current preview as a session — lines are frozen at save
  // time (engine re-run server-side, materialised into prep_session_lines).
  const saveSession = useCallback(async () => {
    if (!bizId || selectedItems.length === 0) return
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/inventory/prep-sessions', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, items: selectedItems }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        if (r.status === 409 && b.error === 'active_session_exists') {
          // Refresh the active session — owner already had one going.
          await loadActiveSession()
          return
        }
        throw new Error(b.error ?? `HTTP ${r.status}`)
      }
      const { session, lines } = await r.json()
      setActiveSession(session)
      setSessionLines(lines ?? [])
      // Reset the create-mode state since we've transitioned to prep-mode.
      setSelected({})
      setResult(null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }, [bizId, selectedItems, loadActiveSession])

  // Toggle a single line's check state. Optimistic update so the
  // checkbox feels instant on a tablet; rolls back on error.
  const toggleLine = useCallback(async (line: PrepSessionLine) => {
    if (!activeSession) return
    const targetChecked = line.checked_at == null
    const newCheckedAt  = targetChecked ? new Date().toISOString() : null
    // Optimistic patch.
    setSessionLines(prev => prev.map(l => l.id === line.id ? { ...l, checked_at: newCheckedAt } : l))
    try {
      const r = await fetch(
        `/api/inventory/prep-sessions/${activeSession.id}/lines/${line.id}/toggle`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checked: targetChecked }),
        },
      )
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const { line: updated } = await r.json()
      setSessionLines(prev => prev.map(l => l.id === line.id ? updated : l))
    } catch (e: any) {
      // Roll back the optimistic patch.
      setSessionLines(prev => prev.map(l => l.id === line.id ? line : l))
      setError(e.message)
    }
  }, [activeSession])

  // Mark the whole session done.
  const completeSession = useCallback(async () => {
    if (!activeSession) return
    if (!window.confirm('Mark this prep list as complete? It moves to history and lines become read-only.')) return
    try {
      const r = await fetch(`/api/inventory/prep-sessions/${activeSession.id}`, {
        method: 'PATCH',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complete: 'now' }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setActiveSession(null)
      setSessionLines([])
    } catch (e: any) {
      setError(e.message)
    }
  }, [activeSession])

  // Discard — only works while not completed. Drops the session + lines.
  const discardSession = useCallback(async () => {
    if (!activeSession) return
    if (!window.confirm('Discard this prep list? All check progress will be lost.')) return
    try {
      const r = await fetch(`/api/inventory/prep-sessions/${activeSession.id}`, {
        method: 'DELETE',
        cache: 'no-store',
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setActiveSession(null)
      setSessionLines([])
    } catch (e: any) {
      setError(e.message)
    }
  }, [activeSession])

  const compute = useCallback(async () => {
    if (!bizId || selectedItems.length === 0) return
    setComputing(true); setError(null)
    try {
      const r = await fetch('/api/inventory/prep-list', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, items: selectedItems }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setResult(await r.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setComputing(false)
    }
  }, [bizId, selectedItems])

  // Auto-recompute whenever the selected set changes. Debounced lightly
  // so rapid keystrokes on quantity inputs don't fire a request per char.
  useEffect(() => {
    if (!bizId || selectedItems.length === 0) { setResult(null); return }
    const id = setTimeout(() => { compute() }, 350)
    return () => clearTimeout(id)
  }, [bizId, selectedItems, compute])

  const filteredDishes = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return dishes
    return dishes.filter(d => d.name.toLowerCase().includes(q))
  }, [dishes, search])

  const dishById = useMemo(() => {
    const m = new Map<string, DishRow>()
    for (const d of dishes) m.set(d.id, d)
    return m
  }, [dishes])

  // Split session lines by kind for the tabbed prep-mode display.
  const sessionComponents = useMemo(() => sessionLines.filter(l => l.kind === 'component'), [sessionLines])
  const sessionProducts   = useMemo(() => sessionLines.filter(l => l.kind === 'product'),   [sessionLines])
  const totalLines        = sessionLines.length
  const doneLines         = useMemo(() => sessionLines.filter(l => l.checked_at != null).length, [sessionLines])
  const allDone           = totalLines > 0 && doneLines === totalLines

  return (
    <AppShell>
      <div style={{ maxWidth: 1280, padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
              Prep list
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
              Enter the dishes you're prepping for and the quantity of each cover. We aggregate the shared
              sub-recipes and raw ingredients so the kitchen sees one prep line per component.
            </p>
          </div>
          {/* Header right-side actions differ by mode. Prep-mode: complete + discard.
              Create-mode (no active session): "Clear all" when something is picked. */}
          {activeSession ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={discardSession} style={secondaryBtn}>Discard</button>
              <button
                onClick={completeSession}
                style={{
                  ...primaryBtn,
                  background: allDone ? UXP.lavDeep : UXP.lavMid,
                }}
                title={allDone ? 'All lines done — close the session' : 'Mark the prep list as complete even with unchecked lines'}
              >
                Complete prep
              </button>
            </div>
          ) : selectedItems.length > 0 ? (
            <button
              onClick={() => { setSelected({}); setResult(null) }}
              style={secondaryBtn}
            >
              Clear all
            </button>
          ) : null}
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}
        {!bizId && !loadingDishes && (
          <div style={emptyCard}>
            Select a business in the sidebar to load its dishes.
          </div>
        )}
        {bizId && (loadingDishes || sessionLoading) && <div style={emptyCard}>Loading…</div>}
        {bizId && !loadingDishes && dishes.length === 0 && !error && (
          <div style={emptyCard}>
            No dishes found. Add or import dishes from <a href="/inventory/recipes" style={{ color: UXP.lavText }}>Recipes</a> first.
          </div>
        )}

        {/* ──────────────────────────────────────────────────────────────
            PREP MODE — an active session exists. Show progress + checkable
            rows; hide the dish picker (session is frozen). Owner uses the
            Complete / Discard buttons in the header to leave this mode.
            ────────────────────────────────────────────────────────────── */}
        {bizId && activeSession && (
          <>
            <div style={{
              background: UXP.lavFill, border: `0.5px solid ${UXP.lavMid}`,
              borderRadius: 8, padding: 14, marginBottom: 14,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: UXP.lavText, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                    Active prep session
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1 }}>
                    {activeSession.name || 'Today’s prep'}
                  </div>
                  <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 4 }}>
                    {activeSession.inputs.map(it => {
                      const d = dishById.get(it.recipe_id)
                      return `${it.qty}× ${d?.name ?? it.recipe_id.slice(0, 8)}`
                    }).join(' · ')}
                  </div>
                </div>
                <div style={{ textAlign: 'right' as const, minWidth: 140 }}>
                  <div style={{ fontSize: 20, fontWeight: 600, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
                    {doneLines} <span style={{ color: UXP.ink4, fontSize: 13, fontWeight: 400 }}>of {totalLines}</span>
                  </div>
                  <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>lines done</div>
                </div>
              </div>
              {/* Progress bar — fills lavender as lines tick off. */}
              <div style={{ marginTop: 10, height: 6, background: UXP.cardBg, borderRadius: 3, overflow: 'hidden' as const }}>
                <div style={{
                  height: '100%',
                  width: `${totalLines > 0 ? (doneLines / totalLines) * 100 : 0}%`,
                  background: UXP.lavDeep,
                  transition: 'width 200ms ease',
                }} />
              </div>
            </div>

            {/* Tab strip — same shape as create-mode. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
              <TabPill
                active={tab === 'components'} onClick={() => setTab('components')}
                label="Components to prep"
                count={sessionComponents.length}
              />
              <TabPill
                active={tab === 'ingredients'} onClick={() => setTab('ingredients')}
                label="Raw ingredients to pull"
                count={sessionProducts.length}
              />
            </div>

            <Section
              title={tab === 'components' ? 'Components to prep' : 'Raw ingredients to pull'}
              subtitle={tab === 'components'
                ? 'Tap each row when you’ve made the component.'
                : 'Tap each row when you’ve pulled the ingredient.'}
            >
              {(tab === 'components' ? sessionComponents : sessionProducts).length === 0 && (
                <Empty label={tab === 'components'
                  ? 'No sub-recipe components in this session.'
                  : 'No raw ingredients in this session (likely all components are flagged — fix yields then start a new session).'} />
              )}
              {(tab === 'components' ? sessionComponents : sessionProducts).length > 0 && (
                <div>
                  {(tab === 'components' ? sessionComponents : sessionProducts).map(line => {
                    const f = formatPrepQty(line.total_qty, line.unit)
                    const checked = line.checked_at != null
                    return (
                      <button
                        key={line.id}
                        onClick={() => toggleLine(line)}
                        disabled={!!activeSession.completed_at}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '28px 1fr 130px',
                          alignItems: 'flex-start',
                          gap: 10,
                          width: '100%',
                          padding: '12px 14px',
                          background: checked ? UXP.subtleBg : UXP.cardBg,
                          borderTop: `0.5px solid ${UXP.border}`,
                          border: 'none', borderRadius: 0,
                          textAlign: 'left' as const,
                          cursor: 'pointer', fontFamily: 'inherit',
                          opacity: checked ? 0.55 : 1,
                        }}
                      >
                        {/* Custom checkbox — big tap target for tablets. */}
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 22, height: 22, borderRadius: 5,
                          border: `1.5px solid ${checked ? UXP.lavDeep : UXP.border}`,
                          background: checked ? UXP.lavDeep : 'transparent',
                          color: '#fff', fontSize: 14, fontWeight: 700,
                          flexShrink: 0,
                        }}>
                          {checked ? 'OK' : ''}
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <div style={{
                            fontSize: 13, color: UXP.ink1, fontWeight: 500,
                            textDecoration: checked ? 'line-through' as const : 'none' as const,
                          }}>
                            {line.name_snapshot}
                          </div>
                          {line.uncertain && (
                            <div style={{ fontSize: 10, color: UXP.coral, marginTop: 2 }} title={line.uncertain_reason ?? ''}>
                              {line.uncertain_reason ?? 'Set yield to roll up'}
                            </div>
                          )}
                          {line.source_recipe_ids.length >= 2 && (
                            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
                              shared across {line.source_recipe_ids.length} dishes
                            </div>
                          )}

                          {/* COMPONENT method — sub-recipe's own
                              instructions. Inline-editable textarea
                              so the chef can fill missing methods
                              without leaving the prep page. Writes
                              target recipes.method on the sub-recipe;
                              autosaves on blur. */}
                          {line.kind === 'component' && (
                            <InlineMethodEditor
                              recipeId={line.entity_id}
                              value={line.meta?.method ?? null}
                              onSaved={(newValue) => {
                                setSessionLines(prev => prev.map(l => l.id === line.id
                                  ? { ...l, meta: { ...(l.meta ?? {}), method: newValue } }
                                  : l))
                              }}
                            />
                          )}

                          {/* PRODUCT per-recipe prep notes — one
                              editable row per recipe that uses this
                              product. Chef writes "juice & zest" /
                              "quarter" against each recipe. Writes
                              target recipe_ingredients.notes;
                              autosaves on blur. */}
                          {line.kind === 'product' && (
                            <InlineUsesEditor
                              uses={line.meta?.uses ?? []}
                              onSaved={(ingredientId, newNotes) => {
                                setSessionLines(prev => prev.map(l => {
                                  if (l.id !== line.id) return l
                                  const uses = (l.meta?.uses ?? []).map(u => u.ingredient_id === ingredientId ? { ...u, notes: newNotes } : u)
                                  return { ...l, meta: { ...(l.meta ?? {}), uses } }
                                }))
                              }}
                            />
                          )}
                        </span>
                        <span style={{
                          textAlign: 'right' as const,
                          fontSize: 14, fontWeight: 600, color: UXP.ink1,
                          fontVariantNumeric: 'tabular-nums' as const,
                        }}>
                          {line.uncertain ? '—' : `${f.qty} ${f.unit}`}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </Section>
          </>
        )}

        {/* ──────────────────────────────────────────────────────────────
            CREATE MODE — no active session. Pick dishes, preview the
            aggregation, "Save & start prep" persists it.
            ────────────────────────────────────────────────────────────── */}
        {bizId && !activeSession && !sessionLoading && !loadingDishes && dishes.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16, alignItems: 'start' }}>

            {/* ── LEFT: dish picker + qty inputs ───────────────────── */}
            <div style={{
              background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
              borderRadius: 8, padding: 14, position: 'sticky' as const, top: 16,
            }}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2 }}>
                  Production
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
                  Enter the number of <strong>portions</strong> you expect to make for each dish.
                </div>
              </div>

              {/* Selected lines (top of the panel — these are what's
                  driving the result). */}
              {selectedItems.length === 0 && (
                <div style={{ fontSize: 11, color: UXP.ink4, marginBottom: 10 }}>
                  No dishes selected yet. Add one from the list below.
                </div>
              )}
              {selectedItems.length > 0 && (
                <>
                  {/* Column header so the number column is self-explanatory. */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 70px 20px',
                    alignItems: 'center', gap: 6,
                    padding: '0 8px 4px', fontSize: 9, color: UXP.ink4,
                    fontWeight: 600, letterSpacing: '0.06em',
                    textTransform: 'uppercase' as const,
                  }}>
                    <div>Dish</div>
                    <div style={{ textAlign: 'right' as const }}>Portions</div>
                    <div />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                    {selectedItems.map(({ recipe_id, qty }) => {
                      const d = dishById.get(recipe_id)
                      if (!d) return null
                      return (
                        <div key={recipe_id} style={{
                          display: 'grid', gridTemplateColumns: '1fr 70px 20px',
                          alignItems: 'center', gap: 6,
                          padding: '6px 8px', background: UXP.lavFill,
                          border: `0.5px solid ${UXP.lavMid}`, borderRadius: 5,
                        }}>
                          <div style={{ fontSize: 11, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                            {d.name}
                          </div>
                          <input
                            type="number"
                            min={0}
                            value={qty}
                            aria-label={`Portions of ${d.name}`}
                            onChange={e => {
                              const n = Number(e.target.value)
                              setSelected(s => ({ ...s, [recipe_id]: Number.isFinite(n) ? n : 0 }))
                            }}
                            style={{
                              ...inputStyle, padding: '4px 6px', fontSize: 11,
                              textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const,
                            }}
                          />
                          <button
                            onClick={() => setSelected(s => { const c = { ...s }; delete c[recipe_id]; return c })}
                            style={{ background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontSize: 14, padding: 0 }}
                            aria-label="Remove"
                          >×</button>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Dish search/picker */}
              <div style={{ marginTop: 4, paddingTop: 12, borderTop: `0.5px solid ${UXP.border}` }}>
                <input
                  type="text"
                  placeholder="Search dishes…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ ...inputStyle, fontSize: 12 }}
                />
                <div style={{
                  marginTop: 8, maxHeight: 360, overflowY: 'auto' as const,
                  display: 'flex', flexDirection: 'column' as const, gap: 2,
                }}>
                  {filteredDishes.map(d => {
                    const inList = (selected[d.id] ?? 0) > 0
                    return (
                      <button
                        key={d.id}
                        onClick={() => setSelected(s => ({ ...s, [d.id]: (s[d.id] ?? 0) + 1 || 1 }))}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '6px 10px',
                          background: inList ? UXP.lavFill : 'transparent',
                          border: `0.5px solid ${inList ? UXP.lavMid : 'transparent'}`,
                          borderRadius: 5, fontSize: 11, color: UXP.ink2,
                          textAlign: 'left' as const, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        <span style={{ overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                          {d.name}
                        </span>
                        <span style={{ fontSize: 10, color: UXP.ink4, marginLeft: 8 }}>
                          {d.type ?? ''}
                        </span>
                      </button>
                    )
                  })}
                  {filteredDishes.length === 0 && (
                    <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 4px' }}>
                      No matches.
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── RIGHT: aggregated prep list ───────────────────────── */}
            <div>
              {selectedItems.length === 0 ? (
                <div style={emptyCard}>
                  Pick the dishes you're prepping for from the panel on the left and set the cover count. The
                  prep list will appear here as you go.
                </div>
              ) : (
                <>
                  {computing && (
                    <div style={{ fontSize: 11, color: UXP.ink4, marginBottom: 8 }}>Aggregating…</div>
                  )}

                  {/* CTA: persist the preview as an active session so the
                      kitchen can tick lines off. Appears as soon as the
                      preview has any content. */}
                  {result && (result.components.length > 0 || result.products.length > 0) && (
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      gap: 12, padding: '10px 14px', marginBottom: 12,
                      background: UXP.lavFill, border: `0.5px solid ${UXP.lavMid}`,
                      borderRadius: 8,
                    }}>
                      <div style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.4 }}>
                        Happy with the list? Save it so the kitchen can tick each line off as it's done.
                        Lines freeze at save — recipe edits after this won't change what's already in the list.
                      </div>
                      <button onClick={saveSession} disabled={saving} style={{
                        ...primaryBtn,
                        opacity: saving ? 0.6 : 1, cursor: saving ? 'wait' as const : 'pointer' as const,
                        whiteSpace: 'nowrap' as const,
                      }}>
                        {saving ? 'Saving…' : 'Save & start prep'}
                      </button>
                    </div>
                  )}

                  {/* Tabbed result — components is the primary view since
                      it's the aggregation payoff; ingredients is for the
                      pull/shopping pass; flags only if something needs
                      owner attention. */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
                    <TabPill
                      active={tab === 'components'} onClick={() => setTab('components')}
                      label="Components to prep"
                      count={result?.components.length ?? 0}
                    />
                    <TabPill
                      active={tab === 'ingredients'} onClick={() => setTab('ingredients')}
                      label="Raw ingredients to pull"
                      count={result?.products.length ?? 0}
                    />
                    {result && result.flags.length > 0 && (
                      <TabPill
                        active={tab === 'flags'} onClick={() => setTab('flags')}
                        label="Flags"
                        count={result.flags.length}
                        tone="coral"
                      />
                    )}
                  </div>

                  {tab === 'components' && (
                    <Section
                      title="Components to prep"
                      subtitle="Sub-recipes rolled up across the entered dishes. Make this much of each."
                    >
                      {result && result.components.length === 0 && (
                        <Empty label="None of the entered dishes use sub-recipes." />
                      )}
                      {result && result.components.length > 0 && (
                        <table style={tableStyle}>
                          <thead>
                            <tr style={{ background: UXP.subtleBg }}>
                              <Th label="Component" />
                              <Th label="Total to prep" align="right" />
                              <Th label="Used by" align="right" />
                              <Th label="Status" />
                            </tr>
                          </thead>
                          <tbody>
                            {result.components.map(c => {
                              const f = formatPrepQty(c.total_qty, c.unit)
                              const sourceNames = c.source_recipes.map(rid => dishById.get(rid)?.name ?? '?')
                              return (
                                <tr key={c.subrecipe_id} style={{ borderTop: `0.5px solid ${UXP.border}` }}>
                                  <td style={td}>
                                    <div style={{ color: UXP.ink1, fontWeight: 500 }}>{c.name ?? '—'}</div>
                                  </td>
                                  <td style={{ ...td, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>
                                    {c.uncertain ? '—' : `${f.qty} ${f.unit}`}
                                  </td>
                                  <td style={{ ...td, textAlign: 'right' as const, color: UXP.ink3, fontSize: 11 }}>
                                    <span title={sourceNames.join(', ')}>{c.source_recipes.length}</span>
                                  </td>
                                  <td style={td}>
                                    {c.uncertain ? (
                                      <span style={uncertainBadge} title={c.uncertain_reason ?? ''}>
                                        Set yield to roll up
                                      </span>
                                    ) : c.source_recipes.length >= 2 ? (
                                      <span style={sharedBadge}>SHARED</span>
                                    ) : null}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </Section>
                  )}

                  {tab === 'ingredients' && (
                    <Section
                      title="Raw ingredients to pull"
                      subtitle="Aggregated leaf ingredients across dishes and sub-recipes (where yields are set)."
                    >
                      {result && result.products.length === 0 && (
                        <Empty label="No raw ingredients aggregated yet. If some components are flagged 'Set yield', their ingredients can't roll up until you fix that." />
                      )}
                      {result && result.products.length > 0 && (
                        <table style={tableStyle}>
                          <thead>
                            <tr style={{ background: UXP.subtleBg }}>
                              <Th label="Ingredient" />
                              <Th label="Total to pull" align="right" />
                              <Th label="Sources" align="right" />
                            </tr>
                          </thead>
                          <tbody>
                            {result.products.map(p => {
                              const f = formatPrepQty(p.total_qty, p.unit)
                              const sourceNames = p.source_recipes.map(rid => dishById.get(rid)?.name ?? '?')
                              return (
                                <tr key={p.product_id} style={{ borderTop: `0.5px solid ${UXP.border}` }}>
                                  <td style={td}>
                                    <div style={{ color: UXP.ink1, fontWeight: 500 }}>{p.name ?? '—'}</div>
                                    {p.category && (
                                      <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>{p.category}</div>
                                    )}
                                  </td>
                                  <td style={{ ...td, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>
                                    {f.qty} {f.unit}
                                  </td>
                                  <td style={{ ...td, textAlign: 'right' as const, color: UXP.ink3, fontSize: 11 }}>
                                    <span title={sourceNames.join(', ')}>{p.source_recipes.length}</span>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </Section>
                  )}

                  {tab === 'flags' && result && result.flags.length > 0 && (
                    <Section
                      title="Flags"
                      subtitle="Aggregation skipped these — fix the underlying recipe to roll them in."
                    >
                      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, padding: 8 }}>
                        {result.flags.map((fl, i) => (
                          <div key={i} style={{
                            padding: '6px 10px', background: '#fef3e0',
                            border: `0.5px solid ${UXP.coral}33`, borderRadius: 5,
                            fontSize: 11, color: UXP.ink2,
                          }}>
                            {fl.reason}
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink1, letterSpacing: '0.02em' }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>{subtitle}</div>
        )}
      </div>
      <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Inline editors — autosave on blur. Both target the canonical source
// (recipes.method / recipe_ingredients.notes) so the data lives on the
// underlying recipe and benefits every future prep list. Stops the chef
// having to leave the prep flow to fix a missing description.

function InlineMethodEditor({
  recipeId, value, onSaved,
}: {
  recipeId: string
  value: string | null
  onSaved: (newValue: string | null) => void
}) {
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Keep draft in sync if the prop changes (e.g. another tab edited).
  useEffect(() => { setDraft(value ?? '') }, [value])

  const save = useCallback(async () => {
    const trimmed = draft.trim()
    const incoming = (value ?? '').trim()
    if (trimmed === incoming) return  // no-op
    setSaving(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/recipes/${recipeId}`, {
        method: 'PATCH',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: trimmed || null }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      onSaved(trimmed || null)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }, [draft, value, recipeId, onSaved])

  return (
    <div style={{ marginTop: 6 }} onClick={e => e.stopPropagation()}>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        placeholder="Method — write how to make this. Saves automatically."
        rows={Math.max(2, Math.min(8, draft.split('\n').length + 1))}
        disabled={saving}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '6px 10px',
          fontSize: 11, color: UXP.ink2, lineHeight: 1.5,
          background: UXP.subtleBg, border: `0.5px solid ${UXP.border}`,
          borderRadius: 5, fontFamily: 'inherit', resize: 'vertical' as const,
          textDecoration: 'none' as const,
        }}
      />
      {err && (
        <div style={{ fontSize: 10, color: UXP.coral, marginTop: 4 }}>{err}</div>
      )}
    </div>
  )
}

function InlineUsesEditor({
  uses, onSaved,
}: {
  uses: UseRef[]
  onSaved: (ingredientId: string, newNotes: string | null) => void
}) {
  return (
    <div style={{
      marginTop: 6, padding: '6px 10px',
      background: UXP.subtleBg, border: `0.5px solid ${UXP.border}`,
      borderRadius: 5, display: 'flex', flexDirection: 'column' as const, gap: 6,
      textDecoration: 'none' as const,
    }}
      onClick={e => e.stopPropagation()}
    >
      {uses.length === 0 && (
        <div style={{ fontSize: 10, color: UXP.ink4, fontStyle: 'italic' as const }}>
          Not used in any recipe yet.
        </div>
      )}
      {uses.map(u => (
        <InlineNoteEditor key={u.ingredient_id} use={u} onSaved={onSaved} />
      ))}
    </div>
  )
}

function InlineNoteEditor({
  use, onSaved,
}: {
  use: UseRef
  onSaved: (ingredientId: string, newNotes: string | null) => void
}) {
  const [draft, setDraft] = useState(use.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setDraft(use.notes ?? '') }, [use.notes])

  const save = useCallback(async () => {
    const trimmed = draft.trim()
    const incoming = (use.notes ?? '').trim()
    if (trimmed === incoming) return
    setSaving(true); setErr(null)
    try {
      const r = await fetch(
        `/api/inventory/recipes/${use.recipe_id}/ingredients/${use.ingredient_id}`,
        {
          method: 'PATCH',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: trimmed || null }),
        },
      )
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      onSaved(use.ingredient_id, trimmed || null)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }, [draft, use.notes, use.recipe_id, use.ingredient_id, onSaved])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 10, color: UXP.ink4, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
        {use.recipe_name ?? '—'}
      </span>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        placeholder="e.g. juice & zest / quarter / dice"
        disabled={saving}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '4px 8px',
          fontSize: 11, color: UXP.ink2,
          background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
          borderRadius: 4, fontFamily: 'inherit',
          textDecoration: 'none' as const,
        }}
        title={err ?? undefined}
      />
    </div>
  )
}

function TabPill({ active, onClick, label, count, tone = 'lav' }: {
  active: boolean; onClick: () => void; label: string; count: number; tone?: 'lav' | 'coral'
}) {
  const activeBg   = tone === 'coral' ? '#fef3e0'   : UXP.lavFill
  const activeFg   = tone === 'coral' ? UXP.coral   : UXP.lavText
  const activeBord = tone === 'coral' ? UXP.coral   : UXP.lav
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding:       '4px 12px',
        background:    active ? activeBg : UXP.cardBg,
        color:         active ? activeFg : UXP.ink2,
        border:        `0.5px solid ${active ? activeBord : UXP.border}`,
        borderRadius:  999,
        fontSize:      11,
        fontWeight:    500,
        fontFamily:    'inherit',
        cursor:        'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {label} <span style={{ color: active ? activeFg : UXP.ink4, marginLeft: 4, opacity: 0.75 }}>· {count}</span>
    </button>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div style={{ padding: 16, fontSize: 11, color: UXP.ink3, textAlign: 'center' as const }}>
      {label}
    </div>
  )
}
function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' | 'center' }) {
  return (
    <th style={{
      padding: '8px 12px', fontSize: 10, fontWeight: 600,
      color: UXP.ink4, letterSpacing: '0.04em',
      textTransform: 'uppercase' as const, textAlign: align,
    }}>{label}</th>
  )
}

const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: UXP.ink2 }
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }
const emptyCard: React.CSSProperties = {
  padding: 24, textAlign: 'center' as const, background: UXP.subtleBg,
  border: `0.5px dashed ${UXP.border}`, borderRadius: 8,
  color: UXP.ink3, fontSize: 13,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit',
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
const uncertainBadge: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px',
  background: '#fef3e0', color: UXP.coral, fontSize: 9,
  fontWeight: 700, letterSpacing: '0.04em',
  textTransform: 'uppercase' as const, borderRadius: 999,
}
const sharedBadge: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px',
  background: UXP.lavFill, color: UXP.lavText, fontSize: 9,
  fontWeight: 700, letterSpacing: '0.04em',
  textTransform: 'uppercase' as const, borderRadius: 999,
}
