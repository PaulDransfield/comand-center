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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { ProductThumb } from '@/components/ui/ProductThumb'
import { PageContainer } from '@/components/ui/Layout'
import { PageErrorBoundary } from '@/components/ui/PageErrorBoundary'

interface DishRow {
  id:                  string
  name:                string
  type:                string | null
  menu_price:          number | null
  portions:            number
  ingredient_count:    number
  missing_prices:      number
  unit_mismatches:     number
  // M117 — per-dish mix share for the covers auto-fill. 0.15 = 15% of
  // covers order this dish. NULL when not set yet — that dish skips
  // the auto-fill until owner sets a share.
  portions_per_cover:  number | null
}

interface UseRef {
  ingredient_id: string
  recipe_id:     string
  recipe_name:   string | null
  notes:         string | null
  quantity:      number
  unit:          string | null
}
interface SubIngredient {
  ingredient_id: string
  product_id:    string | null
  product_name:  string | null
  quantity:      number
  unit:          string | null
  notes:         string | null
  position:      number
}
interface PrepComponentLine {
  subrecipe_id:     string
  name:             string | null
  total_qty:        number
  unit:             string
  source_recipes:   string[]
  uncertain:        null | 'sub_no_yield' | 'unit_mismatch' | 'cycle'
  uncertain_reason: string | null
  meta?: {
    method?:      string | null
    notes?:       string | null
    ingredients?: SubIngredient[]
  }
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
interface PreOrder {
  id:            string
  service_date:  string
  party_name:    string | null
  party_size:    number
  notes:         string | null
  items:         Array<{ recipe_id: string; qty: number }>
  created_at:    string
  updated_at:    string
}
interface DraftPreOrder {
  party_name:    string
  party_size:    string
  notes:         string
  items:         Record<string, number>   // recipe_id → qty
}

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
  // Server enrichment. Loaded live by the GET endpoint so owner edits
  // flow through immediately (text is read-side, not frozen).
  //   - component: method (with notes fallback), notes, ingredients
  //     (the sub-recipe's OWN recipe_ingredients rows so the modal can
  //     surface per-ingredient prep notes — even when the sub has no
  //     yield set and its ingredients don't appear as separate product
  //     lines on the prep list).
  //   - product: uses (recipes that consume this product, each with
  //     its own notes the chef can fill in).
  meta?: {
    method?:      string | null
    notes?:       string | null
    archived_at?: string | null     // H3 — sub-recipe archived after session save
    ingredients?: SubIngredient[]
    uses?:        UseRef[]
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
// Mirror /inventory/recipes/page.tsx — same buckets so Food/Drinks here lines
// up with what the owner picked on the list. Wine, beer, spirits etc. count
// as drinks even though they sit on the menu like a dish.
const DRINK_TYPES = new Set(['cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free'])
const typeLower = (r: any) => String(r?.type ?? '').toLowerCase()
const isDrink   = (r: any) => DRINK_TYPES.has(typeLower(r))
const isDish = (r: any) =>
  (r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
  || (r.menu_price != null && Number(r.menu_price) > 0)
  || (r.type && DISH_TYPES.has(String(r.type).toLowerCase()))

export default function PrepListPage() {
  // Wrapping the inner page in a PageErrorBoundary so a render-time
  // exception surfaces the actual error message in-page instead of
  // bubbling to the global "Something went wrong" fallback. Owner sees
  // a screenshot-able error; we get the stack in Sentry.
  return (
    <PageErrorBoundary surface="Prep list">
      <PrepListPageInner />
    </PageErrorBoundary>
  )
}

function PrepListPageInner() {
  const [bizId, setBizId] = useState<string | null>(null)
  const [dishes, setDishes] = useState<DishRow[]>([])
  const [loadingDishes, setLoadingDishes] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // selected = recipe_id → qty (covers/portions). 0 / missing = not in the list.
  const [selected, setSelected] = useState<Record<string, number>>({})
  // M117 — expected covers for auto-fill. Empty string when not in use.
  const [coversInput, setCoversInput] = useState<string>('')
  // The currently open line modal — works for both prep mode (taps a
  // session line) and create mode (taps a preview row). Holds the line
  // payload + an optional session_line_id so save handlers know whether
  // to write back into sessionLines (prep) or refetch the preview.
  const [openModal, setOpenModal] = useState<{
    line: PrepSessionLine
    session_line_id: string | null
  } | null>(null)
  // M4 — debounce the preview-mode "save in modal → recompute" path so
  // a chef typing fast across 5 ingredients in 5 seconds doesn't fire 5
  // back-to-back preview rebuilds. 400 ms quiet-period.
  const recomputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // M118 — pre-orders for the chosen service_date. Default service
  // date is tomorrow (most prep is done the day before).
  const [serviceDate, setServiceDate] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  })
  const [preOrders, setPreOrders] = useState<PreOrder[]>([])
  const [preOrdersLoading, setPreOrdersLoading] = useState(false)
  // The collapsible add-pre-order form state. Null when collapsed.
  const [draftPreOrder, setDraftPreOrder] = useState<DraftPreOrder | null>(null)
  const [result,   setResult]   = useState<PrepResult | null>(null)
  // Supplier-article thumbnails for prep row product cells (cross-customer
  // cached images from supplier_articles). Silent fallback for products
  // without scraped data.
  const [prepImages, setPrepImages] = useState<Record<string, { image_url: string }>>({})
  useEffect(() => {
    if (!result) { setPrepImages({}); return }
    const ids = (result.products ?? []).map(p => p.product_id).filter((x): x is string => !!x)
    if (ids.length === 0) { setPrepImages({}); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/inventory/supplier-article/batch', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: ids }),
        })
        const j = await r.json().catch(() => ({}))
        if (!cancelled) setPrepImages(j.by_product ?? {})
      } catch { if (!cancelled) setPrepImages({}) }
    })()
    return () => { cancelled = true }
  }, [result])
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

  // M117/M118 — apply covers + pre-orders to fill production.
  // Math:
  //   1. preOrderCovers = sum of party_size across pre-orders
  //   2. freeCovers = max(0, covers - preOrderCovers)
  //   3. for each dish with share > 0:
  //        share-driven qty = round(freeCovers × share)
  //   4. add pre-order qtys on top per dish (committed items)
  // Result: the prep list shows both predicted walk-in demand AND
  // the specific guaranteed pre-ordered items, without double-counting
  // the pre-ordered covers as predicted walk-ins. Chef can override.
  const applyCovers = useCallback(() => {
    const covers = Number(coversInput)
    if (!Number.isFinite(covers) || covers <= 0) return
    const preOrderCovers = preOrders.reduce((s, p) => s + p.party_size, 0)
    const freeCovers = Math.max(0, covers - preOrderCovers)
    const next: Record<string, number> = {}
    for (const d of dishes) {
      const share = d.portions_per_cover != null ? Number(d.portions_per_cover) : 0
      if (share > 0) {
        const qty = Math.round(freeCovers * share)
        if (qty > 0) next[d.id] = qty
      }
    }
    // Layer the committed pre-order items on top.
    for (const po of preOrders) {
      for (const it of po.items) {
        next[it.recipe_id] = (next[it.recipe_id] ?? 0) + it.qty
      }
    }
    setSelected(next)
  }, [coversInput, dishes, preOrders])

  // M118 — pre-orders loader. Fires on biz / service_date change.
  const loadPreOrders = useCallback(async () => {
    if (!bizId) { setPreOrders([]); return }
    setPreOrdersLoading(true)
    try {
      const r = await fetch(
        `/api/inventory/prep-pre-orders?business_id=${encodeURIComponent(bizId)}&service_date=${encodeURIComponent(serviceDate)}`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const { pre_orders } = await r.json()
      setPreOrders(pre_orders ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPreOrdersLoading(false)
    }
  }, [bizId, serviceDate])
  useEffect(() => { if (bizId) loadPreOrders() }, [bizId, serviceDate, loadPreOrders])

  // Create a pre-order from the draft form. Refreshes the list on
  // success and collapses the draft form.
  const createPreOrder = useCallback(async () => {
    if (!bizId || !draftPreOrder) return
    const items = Object.entries(draftPreOrder.items)
      .filter(([, qty]) => qty > 0)
      .map(([recipe_id, qty]) => ({ recipe_id, qty }))
    const partySize = Math.floor(Number(draftPreOrder.party_size))
    if (!Number.isFinite(partySize) || partySize <= 0) {
      setError('Party size must be a positive number'); return
    }
    try {
      const r = await fetch('/api/inventory/prep-pre-orders', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id:  bizId,
          service_date: serviceDate,
          party_name:   draftPreOrder.party_name.trim() || null,
          party_size:   partySize,
          notes:        draftPreOrder.notes.trim() || null,
          items,
        }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const { pre_order } = await r.json()
      setPreOrders(prev => [...prev, pre_order])
      setDraftPreOrder(null)
    } catch (e: any) {
      setError(e.message)
    }
  }, [bizId, draftPreOrder, serviceDate])

  const deletePreOrder = useCallback(async (id: string) => {
    if (!window.confirm('Remove this pre-order?')) return
    try {
      const r = await fetch(`/api/inventory/prep-pre-orders/${id}`, { method: 'DELETE', cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setPreOrders(prev => prev.filter(p => p.id !== id))
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  // Save a per-recipe mix share. Targets PATCH /api/inventory/recipes/[id]
  // so the value lives on the dish and persists across sessions.
  // Updates local state optimistically; rolls back on error.
  const saveDishShare = useCallback(async (recipeId: string, sharePct: number | null) => {
    const ppc = sharePct == null ? null : sharePct / 100
    const prevDishes = dishes
    setDishes(prev => prev.map(d => d.id === recipeId ? { ...d, portions_per_cover: ppc } : d))
    try {
      const r = await fetch(`/api/inventory/recipes/${recipeId}`, {
        method: 'PATCH',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portions_per_cover: ppc }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
    } catch (e: any) {
      setDishes(prevDishes)
      setError(e.message)
    }
  }, [dishes])

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
  //
  // M6 — capture the PRE-optimistic value from current state inside
  // setSessionLines, not from the `line` arg (which may already
  // include other optimistic patches from sibling toggles).
  const toggleLine = useCallback(async (line: PrepSessionLine) => {
    if (!activeSession) return
    const targetChecked = line.checked_at == null
    const newCheckedAt  = targetChecked ? new Date().toISOString() : null
    let prevValue: PrepSessionLine | null = null
    setSessionLines(prev => prev.map(l => {
      if (l.id !== line.id) return l
      prevValue = l                            // snapshot the actual current state
      return { ...l, checked_at: newCheckedAt }
    }))
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
      // Roll back to the captured pre-optimistic value (not the stale
      // `line` arg).
      if (prevValue) setSessionLines(prev => prev.map(l => l.id === line.id ? prevValue! : l))
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

  // M4 — debounced trigger for modal-side saves that need the preview
  // refreshed. Coalesces bursts of editor blurs into one rebuild.
  const scheduleRecompute = useCallback(() => {
    if (recomputeTimerRef.current) clearTimeout(recomputeTimerRef.current)
    recomputeTimerRef.current = setTimeout(() => { compute() }, 400)
  }, [compute])
  useEffect(() => () => {
    if (recomputeTimerRef.current) clearTimeout(recomputeTimerRef.current)
  }, [])

  // View toggle — Food / Drinks. Chef and bartender prep separately, so the
  // dish picker AND the aggregated prep output split by this. A line that
  // has contributing dishes in both buckets shows in BOTH views (with the
  // qty representing only that view's contribution to avoid double-prep).
  const [view, setView] = useState<'food' | 'drinks'>('food')

  const foodDishes  = useMemo(() => dishes.filter(d => !isDrink(d)), [dishes])
  const drinkDishes = useMemo(() => dishes.filter(d =>  isDrink(d)), [dishes])

  const filteredDishes = useMemo(() => {
    const bucket = view === 'drinks' ? drinkDishes : foodDishes
    const q = search.trim().toLowerCase()
    if (!q) return bucket
    return bucket.filter(d => d.name.toLowerCase().includes(q))
  }, [foodDishes, drinkDishes, view, search])

  const dishById = useMemo(() => {
    const m = new Map<string, DishRow>()
    for (const d of dishes) m.set(d.id, d)
    return m
  }, [dishes])

  // A prep line belongs to a view if ANY contributing dish is of that type.
  // Shared lines (e.g. simple syrup used by both desserts and cocktails)
  // appear in both views — better to show twice than miss it in one.
  function lineMatchesView(sourceIds: string[] | undefined, target: 'food' | 'drinks'): boolean {
    if (!sourceIds || sourceIds.length === 0) return target === 'food'   // safety: unknown source goes to Food
    for (const id of sourceIds) {
      const d = dishById.get(id)
      if (!d) continue
      if (target === 'drinks' && isDrink(d)) return true
      if (target === 'food'   && !isDrink(d)) return true
    }
    return false
  }

  // Split session lines by kind for the tabbed prep-mode display.
  // ALSO filter by the active view so the bar staff don't see kitchen
  // prep lines and vice versa.
  const sessionComponents = useMemo(
    () => sessionLines.filter(l => l.kind === 'component' && lineMatchesView(l.source_recipe_ids, view)),
    [sessionLines, dishById, view],
  )
  const sessionProducts   = useMemo(
    () => sessionLines.filter(l => l.kind === 'product'   && lineMatchesView(l.source_recipe_ids, view)),
    [sessionLines, dishById, view],
  )
  // Same filtering for the create-mode preview output (computed from
  // selected dishes, before a session is saved).
  const previewComponents = useMemo(
    () => (result?.components ?? []).filter(c => lineMatchesView(c.source_recipes, view)),
    [result, dishById, view],
  )
  const previewProducts   = useMemo(
    () => (result?.products ?? []).filter(p => lineMatchesView(p.source_recipes, view)),
    [result, dishById, view],
  )
  const totalLines        = sessionLines.length
  const doneLines         = useMemo(() => sessionLines.filter(l => l.checked_at != null).length, [sessionLines])
  const allDone           = totalLines > 0 && doneLines === totalLines

  return (
    <AppShell>
      <PageContainer>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
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

        {/* View toggle — separate Food and Drinks workflows for kitchen
            vs bar staff. Filters the dish picker AND the aggregated prep
            output. Counts reflect dishes per bucket so the chef sees
            how many of each kind of recipe is available. */}
        {bizId && !loadingDishes && dishes.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            <button
              onClick={() => setView('food')}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: view === 'food' ? 600 : 500,
                background: view === 'food' ? UXP.lavDeep : 'transparent',
                color: view === 'food' ? '#fff' : UXP.ink3,
                border: `0.5px solid ${view === 'food' ? UXP.lavDeep : UXP.border}`,
                borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Food <span style={{ opacity: 0.7, fontWeight: 400, marginLeft: 4 }}>{foodDishes.length}</span>
            </button>
            <button
              onClick={() => setView('drinks')}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: view === 'drinks' ? 600 : 500,
                background: view === 'drinks' ? UXP.lavDeep : 'transparent',
                color: view === 'drinks' ? '#fff' : UXP.ink3,
                border: `0.5px solid ${view === 'drinks' ? UXP.lavDeep : UXP.border}`,
                borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Drinks & alcohol <span style={{ opacity: 0.7, fontWeight: 400, marginLeft: 4 }}>{drinkDishes.length}</span>
            </button>
          </div>
        )}

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
                    const disabled = !!activeSession.completed_at
                    return (
                      <div
                        key={line.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '44px 1fr 130px',
                          alignItems: 'center',
                          gap: 0,
                          background: checked ? UXP.subtleBg : UXP.cardBg,
                          borderTop: `0.5px solid ${UXP.border}`,
                          opacity: checked ? 0.55 : 1,
                        }}
                      >
                        {/* Tap target 1: checkbox column. Toggles
                            check. Wide tap area (44px) for tablet. */}
                        <button
                          onClick={() => toggleLine(line)}
                          disabled={disabled}
                          aria-label={checked ? 'Uncheck' : 'Check'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            height: 56, width: 44, padding: 0,
                            background: 'transparent', border: 'none', cursor: 'pointer',
                          }}
                        >
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 22, height: 22, borderRadius: 5,
                            border: `1.5px solid ${checked ? UXP.lavDeep : UXP.border}`,
                            background: checked ? UXP.lavDeep : 'transparent',
                            color: '#fff', fontSize: 14, fontWeight: 700,
                          }}>
                            {checked ? 'OK' : ''}
                          </span>
                        </button>

                        {/* Tap target 2: row body. Opens the modal
                            with method + ingredients (for components)
                            or per-recipe notes (for products). */}
                        <button
                          onClick={() => setOpenModal({ line, session_line_id: line.id })}
                          disabled={disabled}
                          style={{
                            display: 'block', textAlign: 'left' as const,
                            width: '100%', minWidth: 0,
                            padding: '12px 14px 12px 4px',
                            background: 'transparent', border: 'none',
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
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
                          <div style={{ fontSize: 10, color: UXP.lavText, marginTop: 4 }}>
                            Tap for method &amp; ingredients →
                          </div>
                        </button>

                        {/* Qty column. Not a tap target. */}
                        <div style={{
                          padding: '12px 14px',
                          textAlign: 'right' as const,
                          fontSize: 14, fontWeight: 600, color: UXP.ink1,
                          fontVariantNumeric: 'tabular-nums' as const,
                        }}>
                          {line.uncertain ? '—' : `${f.qty} ${f.unit}`}
                        </div>
                      </div>
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
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>

            {/* ── LEFT: dish picker + qty inputs ───────────────────── */}
            <div style={{
              flex: '1 1 380px', minWidth: 0, maxWidth: 480,
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

              {/* M118 — pre-orders for the chosen service date. Each
                  is a party (size + optional name) with specific dish
                  commitments. They fold into Apply's math: free covers
                  = total − pre-order party sizes, distributed by mix
                  share; pre-order items added on top per dish. */}
              <div style={{
                background: UXP.subtleBg, border: `0.5px solid ${UXP.border}`,
                borderRadius: 6, padding: 8, marginBottom: 10,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600,
                                letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                    Pre-orders
                  </div>
                  <input
                    type="date"
                    value={serviceDate}
                    onChange={e => setServiceDate(e.target.value)}
                    style={{ ...inputStyle, padding: '2px 6px', fontSize: 10, width: 130 }}
                    aria-label="Service date"
                    title="Date these pre-orders are for"
                  />
                </div>
                {preOrdersLoading && (
                  <div style={{ fontSize: 10, color: UXP.ink4 }}>Loading…</div>
                )}
                {!preOrdersLoading && preOrders.length === 0 && !draftPreOrder && (
                  <div style={{ fontSize: 10, color: UXP.ink4, marginBottom: 6 }}>
                    No pre-orders for {serviceDate}.
                  </div>
                )}
                {preOrders.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                    {preOrders.map(po => (
                      <div key={po.id} style={{
                        padding: '4px 6px', background: UXP.cardBg,
                        border: `0.5px solid ${UXP.border}`, borderRadius: 4,
                        display: 'flex', justifyContent: 'space-between', gap: 6,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, color: UXP.ink1, fontWeight: 500, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                            {po.party_name || `Party of ${po.party_size}`} · {po.party_size}p
                          </div>
                          <div style={{ fontSize: 10, color: UXP.ink3, marginTop: 2 }}>
                            {po.items.map(it => {
                              const d = dishById.get(it.recipe_id)
                              return `${it.qty}× ${d?.name ?? '?'}`
                            }).join(' · ') || 'No items'}
                          </div>
                          {po.notes && (
                            <div style={{ fontSize: 10, color: UXP.ink4, fontStyle: 'italic' as const, marginTop: 2 }}>
                              {po.notes}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => deletePreOrder(po.id)}
                          style={{ background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontSize: 14, padding: 0 }}
                          aria-label="Remove pre-order"
                        >×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add-pre-order form */}
                {draftPreOrder ? (
                  <div style={{
                    background: UXP.lavFill, border: `0.5px solid ${UXP.lavMid}`,
                    borderRadius: 4, padding: 8, display: 'flex', flexDirection: 'column' as const, gap: 6,
                  }}>
                    <input
                      type="text" placeholder="Party name (optional, e.g. Sara's birthday)"
                      value={draftPreOrder.party_name}
                      onChange={e => setDraftPreOrder(d => d ? { ...d, party_name: e.target.value } : d)}
                      style={{ ...inputStyle, fontSize: 11, padding: '4px 8px' }}
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      <input
                        type="number" min={1} placeholder="Party size"
                        value={draftPreOrder.party_size}
                        onChange={e => setDraftPreOrder(d => d ? { ...d, party_size: e.target.value } : d)}
                        style={{ ...inputStyle, fontSize: 11, padding: '4px 8px' }}
                      />
                      <input
                        type="text" placeholder="Notes (allergies, table)"
                        value={draftPreOrder.notes}
                        onChange={e => setDraftPreOrder(d => d ? { ...d, notes: e.target.value } : d)}
                        style={{ ...inputStyle, fontSize: 11, padding: '4px 8px' }}
                      />
                    </div>
                    <div style={{ fontSize: 9, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginTop: 4 }}>
                      Items
                    </div>
                    {Object.entries(draftPreOrder.items).filter(([, q]) => q > 0).length === 0 && (
                      <div style={{ fontSize: 10, color: UXP.ink4 }}>
                        No items yet — tap a dish in the picker below to add it.
                      </div>
                    )}
                    {Object.entries(draftPreOrder.items).filter(([, q]) => q > 0).map(([rid, qty]) => {
                      const d = dishById.get(rid)
                      return (
                        <div key={rid} style={{
                          display: 'grid', gridTemplateColumns: '1fr 50px 20px',
                          alignItems: 'center', gap: 4,
                        }}>
                          <span style={{ fontSize: 11, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                            {d?.name ?? '?'}
                          </span>
                          <input
                            type="number" min={1} value={qty}
                            onChange={e => {
                              const n = Math.max(0, Math.floor(Number(e.target.value)))
                              setDraftPreOrder(d => d ? { ...d, items: { ...d.items, [rid]: n } } : d)
                            }}
                            style={{ ...inputStyle, fontSize: 11, padding: '2px 4px', textAlign: 'right' as const }}
                          />
                          <button
                            onClick={() => setDraftPreOrder(d => d ? { ...d, items: { ...d.items, [rid]: 0 } } : d)}
                            style={{ background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontSize: 14, padding: 0 }}
                          >×</button>
                        </div>
                      )
                    })}
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button onClick={() => setDraftPreOrder(null)} style={{ ...secondaryBtn, flex: 1, fontSize: 11, padding: '4px 8px' }}>
                        Cancel
                      </button>
                      <button onClick={createPreOrder}
                              disabled={Object.values(draftPreOrder.items).every(q => q <= 0) || !draftPreOrder.party_size}
                              style={{ ...primaryBtn, flex: 1, fontSize: 11, padding: '4px 8px',
                                       opacity: Object.values(draftPreOrder.items).every(q => q <= 0) || !draftPreOrder.party_size ? 0.4 : 1 }}>
                        Save pre-order
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setDraftPreOrder({ party_name: '', party_size: '', notes: '', items: {} })}
                    style={{ ...secondaryBtn, width: '100%', fontSize: 11, padding: '4px 8px' }}
                  >
                    + Add pre-order
                  </button>
                )}
              </div>

              {/* M117 — covers auto-fill. Owner enters expected covers
                  for tomorrow, clicks Apply, and every dish with a mix
                  share set populates at qty=round(covers × share).
                  Chef can edit individual qtys after. */}
              <div style={{
                background: UXP.subtleBg, border: `0.5px solid ${UXP.border}`,
                borderRadius: 6, padding: 8, marginBottom: 10,
              }}>
                <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600,
                              letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                  Auto-fill from covers
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="e.g. 200"
                    value={coversInput}
                    onChange={e => {
                      // Strip everything that isn't a digit or decimal sep
                      // so mobile autocomplete / voice input ("oak 200")
                      // can't smuggle non-numeric text into a value that
                      // the rest of the page treats as a Number.
                      const cleaned = e.target.value.replace(/[^0-9.]/g, '')
                      setCoversInput(cleaned)
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') applyCovers() }}
                    style={{
                      ...inputStyle, flex: 1, padding: '4px 8px', fontSize: 12,
                      textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const,
                    }}
                    aria-label="Expected covers"
                  />
                  <span style={{ fontSize: 10, color: UXP.ink4 }}>covers</span>
                  <button
                    type="button"
                    onClick={applyCovers}
                    disabled={!coversInput || Number(coversInput) <= 0}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      background: UXP.lavDeep, color: '#fff', border: 'none',
                      borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                      opacity: !coversInput || Number(coversInput) <= 0 ? 0.4 : 1,
                    }}
                  >
                    Apply
                  </button>
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4, lineHeight: 1.4 }}>
                  Sets portions from each dish&apos;s mix share (% of covers). Dishes without a share set are skipped — set one below.
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
                  {/* Column header so the number columns are self-explanatory. */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 60px 56px 20px',
                    alignItems: 'center', gap: 6,
                    padding: '0 8px 4px', fontSize: 9, color: UXP.ink4,
                    fontWeight: 600, letterSpacing: '0.06em',
                    textTransform: 'uppercase' as const,
                  }}>
                    <div>Dish</div>
                    <div style={{ textAlign: 'right' as const }}>Portions</div>
                    <div style={{ textAlign: 'right' as const }} title="Mix share — % of covers that order this dish. Drives the auto-fill.">% covers</div>
                    <div />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                    {selectedItems.map(({ recipe_id, qty }) => {
                      const d = dishById.get(recipe_id)
                      if (!d) return null
                      const sharePctStr = d.portions_per_cover != null ? String(Math.round(d.portions_per_cover * 1000) / 10) : ''
                      return (
                        <div key={recipe_id} style={{
                          display: 'grid', gridTemplateColumns: '1fr 60px 56px 20px',
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
                            step={1}
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={qty}
                            aria-label={`Portions of ${d.name}`}
                            onChange={e => {
                              const cleaned = e.target.value.replace(/[^0-9.]/g, '')
                              const n = cleaned === '' ? 0 : Number(cleaned)
                              setSelected(s => ({ ...s, [recipe_id]: Number.isFinite(n) && n >= 0 ? n : 0 }))
                            }}
                            style={{
                              ...inputStyle, padding: '4px 6px', fontSize: 11,
                              textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const,
                            }}
                          />
                          {/* Inline % editor. Shown as percentage
                              (15 → 15 %), stored as fraction (0.15)
                              under the hood. Autosaves on blur to
                              PATCH /recipes/[id]. key prop forces a
                              remount when the underlying value
                              changes elsewhere (auto-fill, other
                              device), so the defaultValue reflects
                              fresh data. */}
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            defaultValue={sharePctStr}
                            key={`pct-${recipe_id}-${sharePctStr}`}
                            placeholder="—"
                            aria-label={`Mix share % for ${d.name}`}
                            onBlur={e => {
                              const raw = e.target.value.trim()
                              if (raw === '' && d.portions_per_cover == null) return
                              if (raw === '') { saveDishShare(recipe_id, null); return }
                              const pct = Number(raw)
                              if (!Number.isFinite(pct) || pct < 0 || pct > 100) return
                              const currentPct = d.portions_per_cover != null ? d.portions_per_cover * 100 : null
                              if (currentPct != null && Math.abs(pct - currentPct) < 0.01) return
                              saveDishShare(recipe_id, pct)
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
                        onClick={() => {
                          // If a draft pre-order form is open, tapping
                          // a dish adds it to the draft. Otherwise add
                          // to the main selected production list.
                          if (draftPreOrder) {
                            setDraftPreOrder(d2 => d2 ? {
                              ...d2,
                              items: { ...d2.items, [d.id]: (d2.items[d.id] ?? 0) + 1 },
                            } : d2)
                          } else {
                            setSelected(s => ({ ...s, [d.id]: (s[d.id] ?? 0) + 1 || 1 }))
                          }
                        }}
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
            <div style={{ flex: '1 1 380px', minWidth: 0 }}>
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
                      {result && previewComponents.length === 0 && (
                        <Empty label={view === 'drinks' ? 'No drink sub-recipes in the selected dishes.' : 'None of the entered dishes use sub-recipes.'} />
                      )}
                      {result && previewComponents.length > 0 && (
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
                            {previewComponents.map(c => {
                              const f = formatPrepQty(c.total_qty, c.unit)
                              const sourceNames = c.source_recipes.map(rid => dishById.get(rid)?.name ?? '?')
                              return (
                                <tr key={c.subrecipe_id} style={{
                                  borderTop: `0.5px solid ${UXP.border}`,
                                  cursor: 'pointer',
                                }}
                                onClick={() => setOpenModal({
                                  line: previewComponentToSessionLine(c),
                                  session_line_id: null,
                                })}
                                title="Tap to view method & ingredients">
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
                      {result && previewProducts.length === 0 && (
                        <Empty label={view === 'drinks' ? 'No raw ingredients for drinks in the selected dishes yet.' : "No raw ingredients aggregated yet. If some components are flagged 'Set yield', their ingredients can't roll up until you fix that."} />
                      )}
                      {result && previewProducts.length > 0 && (
                        <table style={tableStyle}>
                          <thead>
                            <tr style={{ background: UXP.subtleBg }}>
                              <Th label="Ingredient" />
                              <Th label="Total to pull" align="right" />
                              <Th label="Sources" align="right" />
                            </tr>
                          </thead>
                          <tbody>
                            {previewProducts.map(p => {
                              const f = formatPrepQty(p.total_qty, p.unit)
                              const sourceNames = p.source_recipes.map(rid => dishById.get(rid)?.name ?? '?')
                              return (
                                <tr key={p.product_id} style={{
                                  borderTop: `0.5px solid ${UXP.border}`,
                                  cursor: 'pointer',
                                }}
                                onClick={() => setOpenModal({
                                  line: previewProductToSessionLine(p),
                                  session_line_id: null,
                                })}
                                title="Tap to add prep notes per recipe">
                                  <td style={td}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <ProductThumb url={prepImages[p.product_id]?.image_url} size="md" />
                                      <div style={{ minWidth: 0 }}>
                                        <div style={{ color: UXP.ink1, fontWeight: 500 }}>{p.name ?? '—'}</div>
                                        {p.category && (
                                          <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>{p.category}</div>
                                        )}
                                      </div>
                                    </div>
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
      </PageContainer>

      {/* Line-detail modal — works in BOTH prep mode (session line tap)
          and create mode (preview row tap). Shows method + ingredient
          list (component) or per-recipe uses (product). Edits autosave
          via the same PATCH endpoints regardless of mode.
          openModal.session_line_id: non-null = update sessionLines on
          save; null = preview mode, refetch the preview so subsequent
          opens see fresh data. */}
      {openModal && (() => {
        const { line, session_line_id } = openModal
        return (
          <LinePrepModal
            line={line}
            recipeNameById={dishById}
            onClose={() => setOpenModal(null)}
            onMethodSaved={(newValue) => {
              // Update modal-local view so re-opening shows the latest.
              setOpenModal(prev => prev ? {
                ...prev,
                line: { ...prev.line, meta: { ...(prev.line.meta ?? {}), method: newValue } },
              } : prev)
              if (session_line_id) {
                // Prep mode — write into sessionLines too.
                setSessionLines(prev => prev.map(l => l.id === session_line_id
                  ? { ...l, meta: { ...(l.meta ?? {}), method: newValue } }
                  : l))
              } else {
                // Preview mode — debounced recompute (M4) avoids 5
                // round-trips when chef edits 5 ingredients in a burst.
                scheduleRecompute()
              }
            }}
            onIngredientNoteSaved={(ingredientId, newNotes) => {
              setOpenModal(prev => {
                if (!prev) return prev
                const l = prev.line
                if (l.kind === 'component') {
                  const ings = (l.meta?.ingredients ?? []).map(i =>
                    i.ingredient_id === ingredientId ? { ...i, notes: newNotes } : i)
                  return { ...prev, line: { ...l, meta: { ...(l.meta ?? {}), ingredients: ings } } }
                }
                const uses = (l.meta?.uses ?? []).map(u =>
                  u.ingredient_id === ingredientId ? { ...u, notes: newNotes } : u)
                return { ...prev, line: { ...l, meta: { ...(l.meta ?? {}), uses } } }
              })
              if (session_line_id) {
                setSessionLines(prev => prev.map(l => {
                  if (l.id !== session_line_id) return l
                  if (l.kind === 'component') {
                    const ings = (l.meta?.ingredients ?? []).map(i =>
                      i.ingredient_id === ingredientId ? { ...i, notes: newNotes } : i)
                    return { ...l, meta: { ...(l.meta ?? {}), ingredients: ings } }
                  }
                  const uses = (l.meta?.uses ?? []).map(u =>
                    u.ingredient_id === ingredientId ? { ...u, notes: newNotes } : u)
                  return { ...l, meta: { ...(l.meta ?? {}), uses } }
                }))
              } else {
                scheduleRecompute()                        // M4
              }
            }}
          />
        )
      })()}
    </AppShell>
  )
}

// Adapt a create-mode preview row into the PrepSessionLine shape the
// modal already understands. id is empty (we use null session_line_id
// to mean "preview mode") and position is irrelevant for the modal.
// M5 — converters from preview-row shapes to the unified modal line
// shape (PrepSessionLine). Both meta types are subsets of
// PrepSessionLine.meta so the assignment is type-safe without casts;
// previously the `as any` hid the alignment.
function previewComponentToSessionLine(c: PrepComponentLine): PrepSessionLine {
  return {
    id:                '',
    kind:              'component',
    entity_id:         c.subrecipe_id,
    name_snapshot:     c.name ?? c.subrecipe_id.slice(0, 8),
    total_qty:         c.total_qty,
    unit:              c.unit,
    uncertain:         c.uncertain,
    uncertain_reason:  c.uncertain_reason,
    source_recipe_ids: c.source_recipes,
    checked_at:        null,
    position:          0,
    meta:              c.meta,
  }
}
function previewProductToSessionLine(p: PrepProductLine): PrepSessionLine {
  return {
    id:                '',
    kind:              'product',
    entity_id:         p.product_id,
    name_snapshot:     p.name ?? p.product_id.slice(0, 8),
    total_qty:         p.total_qty,
    unit:              p.unit,
    uncertain:         null,
    uncertain_reason:  null,
    source_recipe_ids: p.source_recipes,
    checked_at:        null,
    position:          0,
    meta:              p.meta,
  }
}

function LinePrepModal({
  line, recipeNameById, onClose, onMethodSaved, onIngredientNoteSaved,
}: {
  line: PrepSessionLine
  recipeNameById: Map<string, DishRow>
  onClose: () => void
  onMethodSaved: (v: string | null) => void
  onIngredientNoteSaved: (ingredientId: string, v: string | null) => void
}) {
  // Method fallback: prefer recipes.method, fall back to recipes.notes
  // when method is empty. Legacy / bulk-importer flows sometimes wrote
  // the cooking instructions to notes rather than method.
  const methodVal = line.meta?.method && line.meta.method.trim()
    ? line.meta.method
    : (line.meta?.notes && line.meta.notes.trim() ? line.meta.notes : null)

  return (
    <div
      role="dialog"
      onClick={onClose}
      style={{
        position: 'fixed' as const, inset: 0,
        background: 'rgba(20,18,40,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200, padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(600px, 100%)', maxHeight: '90vh', overflowY: 'auto' as const,
          background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
          borderRadius: 10, padding: 20,
          boxShadow: '0 12px 32px rgba(58,53,80,0.20)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: UXP.ink1 }}>
              {line.name_snapshot}
            </h2>
            <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 4 }}>
              {line.kind === 'component' ? 'Component to prep' : 'Ingredient to pull'}
              {!line.uncertain && (
                <span style={{ marginLeft: 8, color: UXP.ink1, fontWeight: 600 }}>
                  {(() => {
                    const f = formatPrepQty(line.total_qty, line.unit)
                    return `${f.qty} ${f.unit}`
                  })()}
                </span>
              )}
            </div>
            {line.uncertain && (
              <div style={{ fontSize: 11, color: UXP.coral, marginTop: 4 }}>
                {line.uncertain_reason}
              </div>
            )}
          </div>
          <button onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontSize: 22, padding: 0, lineHeight: 1 }}>
            ×
          </button>
        </div>

        {/* H3 — banner when the sub-recipe was archived after the
            session was saved. Chef sees stale-but-historical content
            and knows not to expect edits to it. */}
        {line.kind === 'component' && line.meta?.archived_at && (
          <div style={{
            margin: '8px 0 0', padding: '6px 10px',
            background: '#fef3e0', border: `0.5px solid ${UXP.coral}33`,
            borderRadius: 5, fontSize: 11, color: UXP.ink2,
          }}>
            This sub-recipe was archived after the prep session was created.
            What you see below reflects the recipe at the time of archive — edits won't surface in active recipe lists.
          </div>
        )}

        {/* COMPONENT: method + ingredients */}
        {line.kind === 'component' && (
          <>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
                Method
              </div>
              <InlineMethodEditor
                recipeId={line.entity_id}
                value={methodVal}
                onSaved={onMethodSaved}
              />
              {!line.meta?.method && line.meta?.notes && (
                <div style={{ fontSize: 10, color: UXP.ink4, fontStyle: 'italic' as const, marginTop: 4 }}>
                  Shown from recipe&apos;s Notes — edit above to save as the official Method.
                </div>
              )}
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
                Ingredients
              </div>
              {(line.meta?.ingredients ?? []).length === 0 && (
                <div style={{ fontSize: 11, color: UXP.ink4, fontStyle: 'italic' as const }}>
                  No ingredients recorded on this recipe yet.
                </div>
              )}
              {(line.meta?.ingredients ?? []).map(ing => (
                <SubIngredientRow
                  key={ing.ingredient_id}
                  recipeId={line.entity_id}
                  ing={ing}
                  onSaved={(v) => onIngredientNoteSaved(ing.ingredient_id, v)}
                />
              ))}
            </div>
          </>
        )}

        {/* PRODUCT: per-recipe prep notes */}
        {line.kind === 'product' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
              Used in
            </div>
            <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 8 }}>
              Write what to do with this ingredient against each recipe that uses it ({'"'}juice &amp; zest{'"'}, {'"'}quarter{'"'}, {'"'}dice{'"'}). Saves to that recipe&apos;s ingredient note.
            </div>
            {(line.meta?.uses ?? []).length === 0 && (
              <div style={{ fontSize: 11, color: UXP.ink4, fontStyle: 'italic' as const }}>
                Not used in any recipe yet.
              </div>
            )}
            {(line.meta?.uses ?? []).map(u => (
              <ProductUseRow
                key={u.ingredient_id}
                use={u}
                onSaved={(v) => onIngredientNoteSaved(u.ingredient_id, v)}
              />
            ))}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={primaryBtn}>Done</button>
        </div>
      </div>
    </div>
  )
}

function SubIngredientRow({
  recipeId, ing, onSaved,
}: {
  recipeId: string
  ing: SubIngredient
  onSaved: (v: string | null) => void
}) {
  const [draft, setDraft] = useState(ing.notes ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft(ing.notes ?? '') }, [ing.notes])

  const save = useCallback(async () => {
    const trimmed = draft.trim()
    const incoming = (ing.notes ?? '').trim()
    if (trimmed === incoming) return
    setSaving(true)
    try {
      const r = await fetch(
        `/api/inventory/recipes/${recipeId}/ingredients/${ing.ingredient_id}`,
        {
          method: 'PATCH', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: trimmed || null }),
        },
      )
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      onSaved(trimmed || null)
    } catch (e) {
      // Surface as a row-local error; full toast UI isn't worth it here.
      console.error(e)
    } finally {
      setSaving(false)
    }
  }, [draft, ing.notes, recipeId, ing.ingredient_id, onSaved])

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '160px 80px 1fr',
      alignItems: 'center', gap: 8,
      padding: '6px 0', borderTop: `0.5px solid ${UXP.border}`,
    }}>
      <span style={{ fontSize: 12, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
        {ing.product_name ?? '—'}
      </span>
      <span style={{ fontSize: 11, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
        {ing.quantity} {ing.unit ?? ''}
      </span>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        placeholder="e.g. juice & zest"
        disabled={saving}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '4px 8px',
          fontSize: 11, color: UXP.ink2,
          background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
          borderRadius: 4, fontFamily: 'inherit',
        }}
      />
    </div>
  )
}

function ProductUseRow({
  use, onSaved,
}: {
  use: UseRef
  onSaved: (v: string | null) => void
}) {
  const [draft, setDraft] = useState(use.notes ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft(use.notes ?? '') }, [use.notes])

  const save = useCallback(async () => {
    const trimmed = draft.trim()
    const incoming = (use.notes ?? '').trim()
    if (trimmed === incoming) return
    setSaving(true)
    try {
      const r = await fetch(
        `/api/inventory/recipes/${use.recipe_id}/ingredients/${use.ingredient_id}`,
        {
          method: 'PATCH', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: trimmed || null }),
        },
      )
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      onSaved(trimmed || null)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }, [draft, use.notes, use.recipe_id, use.ingredient_id, onSaved])

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '180px 1fr',
      alignItems: 'center', gap: 8,
      padding: '6px 0', borderTop: `0.5px solid ${UXP.border}`,
    }}>
      <span style={{ fontSize: 12, color: UXP.ink2, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
        {use.recipe_name ?? '—'}
      </span>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        placeholder="e.g. juice & zest"
        disabled={saving}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '4px 8px',
          fontSize: 11, color: UXP.ink2,
          background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
          borderRadius: 4, fontFamily: 'inherit',
        }}
      />
    </div>
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

  // M8 — server caps recipes.method at 20k chars; mirror client-side
  // with maxLength + a counter when close so a chef pasting a long
  // method doesn't suffer silent truncation on save.
  const METHOD_MAX = 20000
  const remaining  = METHOD_MAX - draft.length
  return (
    <div style={{ marginTop: 6 }} onClick={e => e.stopPropagation()}>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value.slice(0, METHOD_MAX))}
        onBlur={save}
        placeholder="Method — write how to make this. Saves automatically."
        rows={Math.max(2, Math.min(8, draft.split('\n').length + 1))}
        disabled={saving}
        maxLength={METHOD_MAX}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '6px 10px',
          fontSize: 11, color: UXP.ink2, lineHeight: 1.5,
          background: UXP.subtleBg, border: `0.5px solid ${UXP.border}`,
          borderRadius: 5, fontFamily: 'inherit', resize: 'vertical' as const,
          textDecoration: 'none' as const,
        }}
      />
      {/* M8 — counter only shows when getting close to the cap, to
          avoid clutter on small methods. */}
      {remaining < 500 && (
        <div style={{ fontSize: 10, color: remaining < 0 ? UXP.coral : UXP.ink4, marginTop: 4, textAlign: 'right' as const }}>
          {draft.length.toLocaleString()} / {METHOD_MAX.toLocaleString()} chars
        </div>
      )}
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
