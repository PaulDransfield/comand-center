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

interface PrepComponentLine {
  subrecipe_id:     string
  name:             string | null
  total_qty:        number
  unit:             string
  source_recipes:   string[]
  uncertain:        null | 'sub_no_yield' | 'unit_mismatch' | 'cycle'
  uncertain_reason: string | null
}
interface PrepProductLine {
  product_id:     string
  name:           string | null
  total_qty:      number
  unit:           string
  source_recipes: string[]
  category?:      string | null
}
interface PrepResult {
  components: PrepComponentLine[]
  products:   PrepProductLine[]
  flags:      Array<{ recipe_id: string; reason: string }>
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

  // selected = recipe_id → qty (covers). 0 / missing = not in the list.
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [result,   setResult]   = useState<PrepResult | null>(null)
  const [computing, setComputing] = useState(false)
  const [search, setSearch] = useState('')

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

  const selectedItems = useMemo(
    () => Object.entries(selected).filter(([, q]) => q > 0).map(([recipe_id, qty]) => ({ recipe_id, qty })),
    [selected],
  )

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
          {selectedItems.length > 0 && (
            <button
              onClick={() => { setSelected({}); setResult(null) }}
              style={secondaryBtn}
            >
              Clear all
            </button>
          )}
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
        {bizId && loadingDishes && <div style={emptyCard}>Loading dishes…</div>}
        {bizId && !loadingDishes && dishes.length === 0 && !error && (
          <div style={emptyCard}>
            No dishes found. Add or import dishes from <a href="/inventory/recipes" style={{ color: UXP.lavText }}>Recipes</a> first.
          </div>
        )}

        {bizId && !loadingDishes && dishes.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16, alignItems: 'start' }}>

            {/* ── LEFT: dish picker + qty inputs ───────────────────── */}
            <div style={{
              background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
              borderRadius: 8, padding: 14, position: 'sticky' as const, top: 16,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, marginBottom: 8 }}>
                Production
              </div>

              {/* Selected lines (top of the panel — these are what's
                  driving the result). */}
              {selectedItems.length === 0 && (
                <div style={{ fontSize: 11, color: UXP.ink4, marginBottom: 10 }}>
                  No dishes selected yet. Add one from the list below.
                </div>
              )}
              {selectedItems.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {selectedItems.map(({ recipe_id, qty }) => {
                    const d = dishById.get(recipe_id)
                    if (!d) return null
                    return (
                      <div key={recipe_id} style={{
                        display: 'grid', gridTemplateColumns: '1fr 60px 20px',
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

                  {/* Components / sub-recipes to prep. Highest aggregation
                      value goes first (most-shared subs). */}
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

                  {/* Products to pull. */}
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

                  {/* Flags surface any non-fatal anomalies — e.g. a product
                      used in both g + ml across dishes, or a cycle. */}
                  {result && result.flags.length > 0 && (
                    <Section
                      title="Flags"
                      subtitle="Aggregation skipped these — fix the underlying recipe to roll them in."
                    >
                      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
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
