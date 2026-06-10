'use client'
// app/inventory/recipes/page.tsx
//
// Live recipes — list of every recipe for the selected business with
// food cost / food % / GP computed from latest invoice prices.
//
// EDITING + CREATION live in the full-page editor at
// /inventory/recipes/[id] and /inventory/recipes/new — this page only
// lists + navigates. Bulk-import stays as a modal here since it's a
// list-level operation that produces many recipes at once.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { Modal, overlayBtn } from '@/components/ui/Overlay'
import { PageContainer } from '@/components/ui/Layout'
import { EmptyState } from '@/components/ui/EmptyState'
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable'
import { fmtKr } from '@/lib/format'
import { FOOD_TYPES, DRINK_TYPES, categoryToken } from '@/lib/categoryColors'
import { CategoryPill } from '@/components/ui/CategoryPill'

interface RecipeRow {
  id:               string
  name:             string
  type:             string | null
  menu_price:       number | null
  portions:         number
  notes:            string | null
  food_cost:        number
  food_pct:         number | null
  gp_pct:           number | null
  gp_kr:            number | null
  ingredient_count: number
  missing_prices:   number
  unit_mismatches:  number
  updated_at:       string
  is_subrecipe?:    boolean
  // M089 promotion — true when this recipe is a live catalogue item
  // (countable in stock takes). product_id is the linked products row.
  promoted?:        boolean
  product_id?:      string | null
  // M111 yield — true when this sub-recipe can be counted by weight/volume.
  has_yield?:       boolean
  yield_unit?:      string | null
  image_url:        string | null
  fallback_product_id: string | null
  glass_price:      number | null
  glass_cost:       number | null
  glass_cost_pct:   number | null
  glass_gp_pct:     number | null
  glass_gp_kr:      number | null
}

interface ListResponse {
  recipes: RecipeRow[]
  summary: { count: number; avg_gp_pct: number | null; low_gp_count: number; avg_menu_price: number | null }
}

export default function InventoryRecipesPage() {
  const router = useRouter()
  const t = useTranslations('operations.inventory.recipes')
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [data,    setData]    = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null)
  // Single-ingredient recipes (wines, beer, spirits) — batch-fetch supplier_article
  // thumbs and use them as a fallback when recipe.image_url is null. Same pattern
  // as the recipe editor's RecipeImageEditor auto-fallback.
  const [fallbackThumb, setFallbackThumb] = useState<Record<string, string | null>>({})
  // M139 (A2.1) — per-recipe waste totals over last 30 days. Map
  // recipe_id → { count, qty, value_sek }. Surface as a small badge so
  // owners spot the "this pizza wastes 8% of cost" leak.
  const [wasteByRecipe, setWasteByRecipe] = useState<Record<string, { count: number; qty: number; value_sek: number }>>({})

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

  const load = useCallback(async () => {
    if (!bizId) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/recipes?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])
  useEffect(() => {
    if (bizId) load()
    else setLoading(false)
  }, [bizId, load])

  // Fetch waste rollup whenever the business changes. Best-effort —
  // failure leaves the badge column empty.
  useEffect(() => {
    if (!bizId) { setWasteByRecipe({}); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/inventory/waste/rollup?business_id=${encodeURIComponent(bizId)}&days=30`, { cache: 'no-store' })
        if (!r.ok) return
        const j = await r.json()
        if (!cancelled) setWasteByRecipe(j.by_recipe ?? {})
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [bizId])

  // After recipes load: collect the fallback_product_ids and batch-fetch thumbs.
  useEffect(() => {
    const ids = (data?.recipes ?? [])
      .filter(r => !r.image_url && r.fallback_product_id)
      .map(r => r.fallback_product_id!) as string[]
    if (ids.length === 0) { setFallbackThumb({}); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/inventory/supplier-article/batch', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: ids }),
        })
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        const map: Record<string, string | null> = {}
        for (const pid of ids) map[pid] = j.by_product?.[pid]?.image_url ?? null
        setFallbackThumb(map)
      } catch { setFallbackThumb({}) }
    })()
    return () => { cancelled = true }
  }, [data])

  const allRows = data?.recipes ?? []
  // Restore the user's last tab from the URL — set when they navigate
  // INTO a recipe (`?view=drinks`) so the back link returns them here
  // with the same filter active.
  const searchParams = useSearchParams()
  const initialView  = (() => {
    const v = searchParams?.get('view')
    return v === 'drinks' || v === 'subrecipes' || v === 'all' || v === 'food' ? v : 'food'
  })()
  const [viewFilter, setViewFilter] = useState<'food' | 'drinks' | 'subrecipes' | 'all'>(initialView)
  const [typeFilter, setTypeFilter] = useState<string>('')   // empty = all types
  const [search, setSearch] = useState<string>('')
  // Sub-recipe → inventory selection. Set of recipe ids ticked in the
  // Sub-recipes view; drives the bulk "Add to inventory" action bar.
  const [selectedSub, setSelectedSub] = useState<Set<string>>(new Set())
  const [promoting, setPromoting] = useState(false)
  const [promoteMsg, setPromoteMsg] = useState<string | null>(null)
  // Clear the selection whenever the view or business changes so a stale
  // tick from another tab can't get acted on.
  useEffect(() => { setSelectedSub(new Set()); setPromoteMsg(null) }, [viewFilter, bizId])
  // Click-to-sort column. null = default (alphabetical by name from API).
  const [sortKey, setSortKey] = useState<'type'|'menu_price'|'food_cost'|'food_pct'|'gp_pct'|null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  function toggleSort(k: typeof sortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('asc') }
  }
  // FOOD_TYPES / DRINK_TYPES imported from lib/categoryColors.ts (single source of truth).
  const typeLower = (r: any) => String(r.type ?? '').toLowerCase()
  // Sub-recipe owner-toggle wins. Otherwise a recipe is food/drink based on
  // its type, falling back to "food" when type is null but the row has a
  // selling price (legacy bulk-imported items without explicit type).
  const isSub  = (r: any) => r.is_subrecipe === true
  const isFood = (r: any) => !isSub(r) && (FOOD_TYPES.has(typeLower(r))
                                          || (!typeLower(r) && (r.selling_price_ex_vat || r.menu_price)))
  const isDrink = (r: any) => !isSub(r) && DRINK_TYPES.has(typeLower(r))
  // Reset type filter when switching to a view where it doesn't apply
  useEffect(() => { if ((viewFilter !== 'food' && viewFilter !== 'drinks') && typeFilter) setTypeFilter('') }, [viewFilter, typeFilter])
  // When the active view changes, the type-filter set changes too — clear
  // it so a 'pizza' filter doesn't silently linger on the drinks tab.
  useEffect(() => { setTypeFilter('') }, [viewFilter])
  const baseRows = viewFilter === 'food'       ? allRows.filter(isFood)
                : viewFilter === 'drinks'      ? allRows.filter(isDrink)
                : viewFilter === 'subrecipes'  ? allRows.filter(isSub)
                :                                allRows
  const typedRows = typeFilter && (viewFilter === 'food' || viewFilter === 'drinks')
    ? baseRows.filter((r: any) => typeLower(r) === typeFilter)
    : baseRows
  // Search by recipe name (case-insensitive substring)
  const q = search.trim().toLowerCase()
  const searchedRows = q
    ? typedRows.filter((r: any) => String(r.name ?? '').toLowerCase().includes(q))
    : typedRows
  // Apply click-to-sort. Nulls sink to the bottom regardless of direction
  // so the chef always sees the populated rows together.
  const rows = sortKey == null ? searchedRows : [...searchedRows].sort((a: any, b: any) => {
    const av = sortKey === 'type' ? String(a.type ?? '').toLowerCase() : (a[sortKey] ?? null)
    const bv = sortKey === 'type' ? String(b.type ?? '').toLowerCase() : (b[sortKey] ?? null)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })
  const foodCount  = allRows.filter(isFood).length
  const drinkCount = allRows.filter(isDrink).length
  const subCount   = allRows.filter(isSub).length
  // Counts per type within the current Food / Drinks bucket
  const bucketRows = viewFilter === 'food' ? allRows.filter(isFood)
                   : viewFilter === 'drinks' ? allRows.filter(isDrink)
                   : []
  const typeCountFor = (t: string) => bucketRows.filter((r: any) => typeLower(r) === t).length
  const visibleSummary = (() => {
    const visGp = rows.filter((r: any) => r.gp_pct != null && r.missing_prices === 0 && r.unit_mismatches === 0) as any[]
    const avgGp = visGp.length ? visGp.reduce((s: number, r: any) => s + r.gp_pct, 0) / visGp.length : null
    const lowGp = visGp.filter((r: any) => r.gp_pct < 65).length
    const visPrice = rows.filter((r: any) => r.menu_price != null && r.menu_price > 0) as any[]
    const avgPrice = visPrice.length ? visPrice.reduce((s: number, r: any) => s + r.menu_price, 0) / visPrice.length : null
    return {
      count:           rows.length,
      avg_gp_pct:      avgGp != null ? Math.round(avgGp * 10) / 10 : null,
      low_gp_count:    lowGp,
      avg_menu_price:  avgPrice != null ? Math.round(avgPrice) : null,
      incomplete_count: rows.filter((r: any) => r.missing_prices > 0 || r.unit_mismatches > 0).length,
    }
  })()

  // ── Sub-recipe → inventory selection helpers ─────────────────────────
  // Selection is scoped to the rows currently visible in the Sub-recipes
  // view (after search). Select-all ticks exactly those.
  const selectableIds = viewFilter === 'subrecipes' ? rows.map(r => r.id) : []
  const allSelected   = selectableIds.length > 0 && selectableIds.every(id => selectedSub.has(id))
  const someSelected  = selectableIds.some(id => selectedSub.has(id)) && !allSelected
  function toggleOne(id: string) {
    setSelectedSub(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelectedSub(prev => {
      if (selectableIds.every(id => prev.has(id))) return new Set()   // all → none
      return new Set(selectableIds)                                    // some/none → all
    })
  }
  // Count how many of the current selection are / aren't already in inventory.
  const selectedRows       = rows.filter(r => selectedSub.has(r.id))
  const selectedUnpromoted = selectedRows.filter(r => !r.promoted)
  const selectedPromoted   = selectedRows.filter(r => r.promoted)
  // Sub-recipes the owner is adding that have no yield set — they can only
  // be counted in portions (pieces), not by weight. Surface so the owner
  // can set a yield first if they want kg/l counting.
  const selectedNoYield    = selectedUnpromoted.filter(r => !r.has_yield)

  async function runPromote(action: 'add' | 'remove') {
    if (!bizId || selectedSub.size === 0) return
    setPromoting(true); setPromoteMsg(null)
    try {
      const r = await fetch('/api/inventory/recipes/promote-bulk', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, recipe_ids: Array.from(selectedSub), action, category: 'food' }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setPromoteMsg(j.error ?? `HTTP ${r.status}`); return }
      const t = j.tally ?? {}
      if (action === 'add') {
        const parts = [`${t.promoted ?? 0} added to inventory`]
        if (t.already)  parts.push(`${t.already} already there`)
        if (t.errors)   parts.push(`${t.errors} failed`)
        setPromoteMsg(parts.join(' · '))
      } else {
        const parts = [`${t.removed ?? 0} removed from inventory`]
        if (t.in_use)       parts.push(`${t.in_use} still used in recipes (kept)`)
        if (t.not_promoted) parts.push(`${t.not_promoted} weren't in inventory`)
        if (t.errors)       parts.push(`${t.errors} failed`)
        setPromoteMsg(parts.join(' · '))
      }
      setSelectedSub(new Set())
      await load()   // refresh promotion badges
    } catch (e: any) {
      setPromoteMsg(e?.message ?? String(e))
    } finally {
      setPromoting(false)
    }
  }

  return (
    <AppShell>
      <PageContainer>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
              {t('title')}
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
              {t('subtitle')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <BulkAiFillButton bizId={bizId} onDone={() => router.refresh()} />
            <button onClick={() => setImporting(true)} disabled={!bizId}
              title={!bizId ? 'Select a business in the sidebar first' : 'Bulk-import recipes from your menu text — Sonnet drafts ingredients from your catalogue'}
              style={{ ...secondaryBtn, opacity: bizId ? 1 : 0.5, cursor: bizId ? 'pointer' : 'not-allowed' }}>
              Bulk import
            </button>
            <button onClick={() => router.push('/inventory/recipes/new')} disabled={!bizId}
              title={!bizId ? 'Select a business in the sidebar first' : undefined}
              style={{ ...primaryBtn, opacity: bizId ? 1 : 0.5, cursor: bizId ? 'pointer' : 'not-allowed' }}>
              {t('addRecipe')}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
          <Stat label={t('kpiCount')}      value={String(visibleSummary.count)} />
          <Stat label={t('kpiAvgGp')}      value={visibleSummary.avg_gp_pct != null ? `${visibleSummary.avg_gp_pct.toFixed(1)} %` : '—'} />
          <Stat label={t('kpiLowGp')}      value={String(visibleSummary.low_gp_count)}
                tone={visibleSummary.low_gp_count > 0 ? 'coral' : 'ink'} />
          <Stat label={t('kpiAvgPrice')}   value={visibleSummary.avg_menu_price != null ? fmtKr(visibleSummary.avg_menu_price) : '—'} />
        </div>

        {bizId && allRows.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
              <ViewPill active={viewFilter === 'food'}       onClick={() => setViewFilter('food')}       label="Food"        count={foodCount} />
              <ViewPill active={viewFilter === 'drinks'}     onClick={() => setViewFilter('drinks')}     label="Drinks"      count={drinkCount} />
              <ViewPill active={viewFilter === 'subrecipes'} onClick={() => setViewFilter('subrecipes')} label="Sub-recipes" count={subCount} />
              <ViewPill active={viewFilter === 'all'}        onClick={() => setViewFilter('all')}        label="All"         count={allRows.length} />
              <input
                type="text"
                placeholder="Search recipes…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  marginLeft: 'auto', minWidth: 180, padding: '6px 10px', fontSize: 12,
                  border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit',
                  background: UXP.cardBg, color: UXP.ink1,
                }}
              />
              {visibleSummary.incomplete_count > 0 && (
                <span style={{
                  fontSize: 10, padding: '3px 9px',
                  background: '#fef3e0', color: UXP.coral, fontWeight: 600,
                  borderRadius: 999, letterSpacing: '0.02em',
                }}
                title="Recipes with unmapped or missing-cost ingredients. Their GP% is shown as 'Incomplete cost' until the gap is fixed.">
                  {visibleSummary.incomplete_count} incomplete cost
                </span>
              )}
            </div>

            {viewFilter === 'food' && foodCount > 0 && (
              <div style={{ display: 'flex', gap: 5, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <span style={{ fontSize: 10, color: UXP.ink4, marginRight: 2 }}>Type:</span>
                <TypePill active={typeFilter === ''} onClick={() => setTypeFilter('')} label="All" count={foodCount} />
                {['starter','pasta','pizza','main','side','dessert','other'].map(t => {
                  const c = typeCountFor(t)
                  if (c === 0) return null
                  return <TypePill key={t} typeKey={t} active={typeFilter === t} onClick={() => setTypeFilter(t)} label={t[0].toUpperCase() + t.slice(1)} count={c} />
                })}
              </div>
            )}
            {viewFilter === 'drinks' && drinkCount > 0 && (
              <div style={{ display: 'flex', gap: 5, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <span style={{ fontSize: 10, color: UXP.ink4, marginRight: 2 }}>Type:</span>
                <TypePill active={typeFilter === ''} onClick={() => setTypeFilter('')} label="All" count={drinkCount} />
                {[
                  { k: 'cocktail',     l: 'Cocktail' },
                  { k: 'wine',         l: 'Wine' },
                  { k: 'beer',         l: 'Beer' },
                  { k: 'spirit',       l: 'Spirit' },
                  { k: 'cider',        l: 'Cider' },
                  { k: 'softdrink',    l: 'Soft drink' },
                  { k: 'alcohol_free', l: 'Alcohol-free' },
                  { k: 'drink',        l: 'Other' },
                ].map(t => {
                  const c = typeCountFor(t.k)
                  if (c === 0) return null
                  return <TypePill key={t.k} typeKey={t.k} active={typeFilter === t.k} onClick={() => setTypeFilter(t.k)} label={t.l} count={c} />
                })}
              </div>
            )}
          </>
        )}

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}
        {!bizId && !loading && (
          <div style={{ padding: '24px', textAlign: 'center' as const, background: UXP.subtleBg,
                        border: `0.5px dashed ${UXP.border}`, borderRadius: 8,
                        color: UXP.ink3, fontSize: 13 }}>
            Select a business in the sidebar to load its recipes.
          </div>
        )}
        {bizId && loading && <Empty label={t('loading')} />}
        {bizId && !loading && rows.length === 0 && !error && (
          <EmptyState
            badge="No recipes yet"
            title="Start by creating your first dish."
            description="Add recipes one-by-one in the editor, or paste your whole menu PDF/Word/image and the importer will draft them all in one go. You'll get live food cost and GP% per dish."
            action={{ label: 'Create a recipe', href: '/inventory/recipes/new' }}
            secondary={{ label: 'Bulk import a menu', href: '/inventory/recipes?import=1' }}
            style={{ marginTop: 16 }}
          />
        )}

        {viewFilter === 'subrecipes' && !loading && rows.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const,
            padding: '10px 14px', marginBottom: 10,
            background: selectedSub.size > 0 ? UXP.lavFill : UXP.subtleBg,
            border: `0.5px solid ${selectedSub.size > 0 ? UXP.lav : UXP.border}`,
            borderRadius: 8,
          }}>
            <div style={{ fontSize: 12, color: UXP.ink2, lineHeight: 1.5, flex: '1 1 260px', minWidth: 0 }}>
              {selectedSub.size > 0 ? (
                <strong style={{ color: UXP.ink1 }}>{selectedSub.size} selected</strong>
              ) : (
                <>Tick sub-recipes to <strong style={{ color: UXP.ink1 }}>add them to inventory</strong> — they become countable items in stock takes, counted by <strong style={{ color: UXP.ink1 }}>weight</strong> (kg / g / l) and valued at their live recipe cost. Edit a sub-recipe later and the next count uses the new value (past counts keep theirs). Weight counting needs a yield set on the recipe.</>
              )}
              {selectedSub.size > 0 && (
                <span style={{ color: UXP.ink4 }}>
                  {' '}· {selectedUnpromoted.length} to add{selectedPromoted.length > 0 ? ` · ${selectedPromoted.length} already in inventory` : ''}
                </span>
              )}
              {selectedNoYield.length > 0 && (
                <div style={{ marginTop: 4, color: UXP.coral, fontSize: 11 }}>
                  {selectedNoYield.length} of these have no yield set — they'll be counted in portions, not weight. Set a yield (e.g. 1 portion = 250 g) on the recipe to count them by weight.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
              {selectedSub.size > 0 && (
                <button type="button" onClick={() => setSelectedSub(new Set())}
                  style={{ ...secondaryBtn, opacity: promoting ? 0.5 : 1 }} disabled={promoting}>
                  Clear
                </button>
              )}
              {selectedPromoted.length > 0 && (
                <button type="button" onClick={() => runPromote('remove')}
                  disabled={promoting}
                  title="Remove the selected sub-recipes from the stocktake catalogue. Kept if still used as an ingredient in another recipe."
                  style={{ ...secondaryBtn, color: UXP.coral, borderColor: UXP.coral, opacity: promoting ? 0.5 : 1, cursor: promoting ? 'not-allowed' : 'pointer' }}>
                  {promoting ? 'Working…' : `Remove from inventory (${selectedPromoted.length})`}
                </button>
              )}
              <button type="button" onClick={() => runPromote('add')}
                disabled={promoting || selectedUnpromoted.length === 0}
                title={selectedUnpromoted.length === 0 ? 'Tick at least one sub-recipe that is not already in inventory' : 'Add the selected sub-recipes to the stocktake catalogue'}
                style={{ ...primaryBtn, opacity: (promoting || selectedUnpromoted.length === 0) ? 0.5 : 1, cursor: (promoting || selectedUnpromoted.length === 0) ? 'not-allowed' : 'pointer' }}>
                {promoting ? 'Adding…' : `Add to inventory${selectedUnpromoted.length > 0 ? ` (${selectedUnpromoted.length})` : ''}`}
              </button>
            </div>
            {promoteMsg && (
              <div style={{ flexBasis: '100%', fontSize: 11, color: UXP.ink3 }}>{promoteMsg}</div>
            )}
          </div>
        )}

        {!loading && rows.length > 0 && (() => {
          const incomplete = (r: RecipeRow) => r.missing_prices > 0 || r.unit_mismatches > 0
          // Sortable header helper — clickable label + tiny arrow when active.
          // Keyboard-accessible via tabIndex/onKeyDown.
          function SortHdr({ k, children }: { k: NonNullable<typeof sortKey>, children: React.ReactNode }) {
            const active = sortKey === k
            return (
              <span
                role="button" tabIndex={0}
                onClick={(e) => { e.stopPropagation(); toggleSort(k) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(k) } }}
                style={{
                  cursor: 'pointer', userSelect: 'none' as const,
                  color: active ? UXP.lavText : 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
                title="Click to sort"
              >
                {children}
                {active && <span style={{ fontSize: 9 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </span>
            )
          }
          const cols: Array<DataTableColumn<RecipeRow>> = [
            { id: 'img', header: '',
              cell: r => {
                const fallback = r.fallback_product_id ? fallbackThumb[r.fallback_product_id] ?? null : null
                const url = r.image_url ?? fallback
                if (!url) return (
                  <div style={{
                    width: 36, height: 36, borderRadius: 5,
                    background: UXP.subtleBg, border: `0.5px dashed ${UXP.border}`,
                  }} />
                )
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt="" loading="lazy"
                    onClick={e => { e.stopPropagation(); setLightbox({ url, name: r.name }) }}
                    title="Click to enlarge"
                    style={{
                      width: 36, height: 36, borderRadius: 5,
                      objectFit: r.image_url ? 'cover' : 'contain',
                      padding: r.image_url ? 0 : 2,
                      border: `0.5px solid ${UXP.border}`, background: '#fff', display: 'block',
                      cursor: 'zoom-in',
                    }} />
                )
              } },
            { id: 'name',  header: t('colName'),  primary: true,
              cell: r => <span style={{ fontWeight: 500, color: UXP.ink1 }}>{r.name}</span> },
            { id: 'type',  header: <SortHdr k="type">{t('colType')}</SortHdr>,
              cell: r => <InlineType recipeId={r.id} value={r.type} onSaved={load} /> },
            { id: 'ing',   header: t('colIngredients'), align: 'right' as const,
              cell: r => <span style={{ color: UXP.ink3 }}>{r.ingredient_count}</span> },
            { id: 'menu',  header: <SortHdr k="menu_price">{t('colMenuPrice')}</SortHdr>,   align: 'right' as const, hideOnMobile: true,
              cell: r => <InlineMenuPrice recipeId={r.id} value={r.menu_price} onSaved={load} /> },
            { id: 'food',  header: <SortHdr k="food_cost">{viewFilter === 'drinks' ? 'Cost' : t('colFoodCost')}</SortHdr>,    align: 'right' as const, hideOnMobile: true,
              cell: r => (
                <span>
                  {fmtKr(r.food_cost)}
                  {r.glass_cost != null && (
                    <span style={{ display: 'block', fontSize: 10, color: UXP.ink4, marginTop: 1 }}>
                      glass {fmtKr(r.glass_cost)}
                    </span>
                  )}
                </span>
              ) },
            { id: 'foodpct', header: <SortHdr k="food_pct">{viewFilter === 'drinks' ? 'Cost %' : t('colFoodPct')}</SortHdr>,   align: 'right' as const, hideOnMobile: true,
              cell: r => (
                <span style={{ color: r.food_pct == null ? UXP.ink3 : foodPctColor(r.food_pct) }}>
                  {r.food_pct != null ? `${r.food_pct.toFixed(1)} %` : '—'}
                  {r.glass_cost_pct != null && (
                    <span style={{ display: 'block', fontSize: 10, color: UXP.ink4, marginTop: 1, fontWeight: 400 }}>
                      glass {r.glass_cost_pct.toFixed(1)} %
                    </span>
                  )}
                </span>
              ) },
            // GP renders Incomplete badge on top — chef-readable. Shown on every tier.
            { id: 'gp',    header: <SortHdr k="gp_pct">{t('colGp')}</SortHdr>,  align: 'right' as const,
              cell: r => incomplete(r) ? (
                <span style={{
                  display: 'inline-block', padding: '2px 8px',
                  background: '#fef3e0', color: UXP.coral,
                  fontSize: 10, fontWeight: 600, borderRadius: 6, letterSpacing: '0.02em',
                }}>Incomplete cost</span>
              ) : r.gp_pct != null ? (
                <span style={{ color: gpColor(r.gp_pct), fontWeight: 500 }}>
                  {r.gp_pct.toFixed(1)} %
                  {r.gp_kr != null && (
                    <span style={{ display: 'block', fontSize: 10, color: UXP.ink4, fontWeight: 400, marginTop: 1 }}>
                      {fmtKr(r.gp_kr)}
                    </span>
                  )}
                  {r.glass_gp_pct != null && (
                    <span style={{ display: 'block', fontSize: 10, color: gpColor(r.glass_gp_pct), fontWeight: 500, marginTop: 3 }}>
                      glass {r.glass_gp_pct.toFixed(1)} %
                      {r.glass_gp_kr != null && (
                        <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, fontWeight: 400 }}>
                          {fmtKr(r.glass_gp_kr)}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              ) : <span style={{ color: UXP.ink3 }}>—</span> },
            { id: 'waste', header: 'Waste 30d', align: 'right' as const, hideOnMobile: true,
              cell: r => {
                const w = wasteByRecipe[r.id]
                if (!w || w.value_sek === 0) return <span style={{ color: UXP.ink4, fontSize: 10 }}>—</span>
                // Show value in SEK + a small "X events" microcopy.
                // A "high waste" flag fires when waste cost > 5% of
                // a single portion's food_cost × estimated daily portions.
                // For v1 we just show the raw money so owners get the
                // signal without a threshold call.
                const hi = r.food_cost > 0 && w.value_sek > r.food_cost * 5
                return (
                  <span style={{
                    color: hi ? UXP.rose : UXP.ink2,
                    fontWeight: hi ? 600 : 400,
                    fontVariantNumeric: 'tabular-nums' as const,
                  }} title={`${w.count} waste ${w.count === 1 ? 'event' : 'events'} in the last 30 days`}>
                    {fmtKr(w.value_sek)}
                  </span>
                )
              } },
            { id: 'warn',  header: t('colWarnings'), align: 'center' as const, hideOnMobile: true,
              cell: r => incomplete(r) ? (
                <span style={{
                  display: 'inline-block', padding: '1px 7px',
                  background: '#fef3e0', color: UXP.coral,
                  fontSize: 10, fontWeight: 600, borderRadius: 4,
                }} title={t('warningsTooltip', { missing: String(r.missing_prices), mismatch: String(r.unit_mismatches) })}>
                  {r.missing_prices + r.unit_mismatches}
                </span>
              ) : null },
          ]
          // Sub-recipes view: prepend a selection checkbox column and
          // append an inventory-status column so the owner can pick
          // sub-recipes and add them to the stocktake catalogue.
          if (viewFilter === 'subrecipes') {
            cols.unshift({
              id: 'sel', width: 34,
              header: <SelectCheckbox checked={allSelected} indeterminate={someSelected} onToggle={toggleAll} ariaLabel="Select all sub-recipes" />,
              cell: r => <SelectCheckbox checked={selectedSub.has(r.id)} onToggle={() => toggleOne(r.id)} ariaLabel={`Select ${r.name}`} />,
            })
            cols.push({
              id: 'inv', header: 'Inventory', align: 'center' as const,
              cell: r => r.promoted ? (
                <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px',
                    background: UXP.greenFill, color: UXP.greenDeep,
                    fontSize: 10, fontWeight: 600, borderRadius: 6, letterSpacing: '0.02em',
                  }} title="This sub-recipe is a catalogue item — it shows up in stock counts and is valued at its live recipe cost.">In inventory</span>
                  <span style={{ fontSize: 9, color: r.has_yield ? UXP.ink4 : UXP.coral }}
                    title={r.has_yield ? 'Counted by weight/volume in stock takes.' : 'No yield set — counted in portions. Set a yield to count by weight.'}>
                    {r.has_yield ? 'by weight' : 'by portion'}
                  </span>
                </span>
              ) : <span style={{ color: UXP.ink4, fontSize: 11 }}>—</span>,
            })
          }
          return (
            <DataTable<RecipeRow>
              columns={cols}
              data={rows}
              getKey={r => r.id}
              onRowClick={r => router.push(`/inventory/recipes/${r.id}?view=${viewFilter}`)}
              style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}
            />
          )
        })()}
      </PageContainer>

      {importing && bizId && (
        <BulkImportModal bizId={bizId} existingRecipes={allRows} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); load() }} />
      )}
      {lightbox && (
        <ImageLightbox url={lightbox.url} name={lightbox.name} onClose={() => setLightbox(null)} />
      )}
    </AppShell>
  )
}

// ── ImageLightbox ─────────────────────────────────────────────────────
// Click-to-enlarge dish photo. Used by service chefs to reference
// plating. Click backdrop or press Esc to close.
function ImageLightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-label={`Image: ${name}`}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, cursor: 'zoom-out',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, maxWidth: '100%', maxHeight: '100%' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={name}
          onClick={e => e.stopPropagation()}
          style={{
            maxWidth: '100%', maxHeight: 'calc(100vh - 100px)',
            objectFit: 'contain', borderRadius: 6, background: '#fff',
            cursor: 'default',
          }}
        />
        <div style={{ color: '#fff', fontSize: 14, fontWeight: 500, textAlign: 'center' as const }}>{name}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{
          position: 'absolute', top: 16, right: 16,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.15)', border: '0.5px solid rgba(255,255,255,0.2)',
          color: '#fff', fontSize: 18, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, fontFamily: 'inherit',
        }}
      >×</button>
    </div>
  )
}

// ── InlineMenuPrice ───────────────────────────────────────────────────
// Click-to-edit menu price on the recipe list row. Stops row navigation
// while focused so the user can type a number without being routed to
// the editor. PATCHes menu_price (legacy passthrough — the resolver
// stores it as-is; owner refines VAT in the editor if needed).
// Click-to-edit type dropdown on the recipe-list row. PATCHes recipes.type.
//
// Pill + transparent-select overlay pattern: the visible CategoryPill carries
// the canonical category colour; an invisible native <select> sits on top
// (opacity:0, inset:0) so every click target — pointer, keyboard, screen
// reader — still hits a real <select> element. No custom popover, no a11y
// regression, native open behaviour preserved across desktop + mobile.
function InlineType({ recipeId, value, onSaved }: { recipeId: string; value: string | null; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const ALL_TYPES = [
    { v: '',             l: '—' },
    { v: 'starter',      l: 'Starter' },
    { v: 'pasta',        l: 'Pasta' },
    { v: 'pizza',        l: 'Pizza' },
    { v: 'main',         l: 'Main' },
    { v: 'side',         l: 'Side' },
    { v: 'dessert',      l: 'Dessert' },
    { v: 'sauce',        l: 'Sauce (sub-recipe)' },
    { v: 'cocktail',     l: 'Cocktail' },
    { v: 'wine',         l: 'Wine' },
    { v: 'beer',         l: 'Beer' },
    { v: 'spirit',       l: 'Spirit' },
    { v: 'cider',        l: 'Cider' },
    { v: 'softdrink',    l: 'Soft drink' },
    { v: 'alcohol_free', l: 'Alcohol-free' },
    { v: 'drink',        l: 'Other drink' },
    { v: 'other',        l: 'Other' },
  ]
  async function change(next: string) {
    if ((next || null) === (value || null)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/inventory/recipes/${recipeId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: next || null }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(j.error ?? `HTTP ${r.status}`)
      } else { onSaved() }
    } finally { setBusy(false) }
  }
  return (
    <span
      style={{
        position:    'relative',
        display:     'inline-flex',
        alignItems:  'center',
        gap:         3,
        cursor:      'pointer',
        opacity:     busy ? 0.5 : 1,
      }}
      onClick={e => e.stopPropagation()}
    >
      <CategoryPill type={value} showEmpty />
      <span style={{ color: UXP.ink4, fontSize: 9, lineHeight: 1, paddingTop: 1 }}>▾</span>
      <select
        value={value ?? ''}
        onClick={e => e.stopPropagation()}
        onChange={e => { e.stopPropagation(); void change(e.target.value) }}
        disabled={busy}
        aria-label="Recipe type"
        style={{
          position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer',
          width: '100%', height: '100%', fontFamily: 'inherit',
        }}
      >
        {ALL_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
      </select>
    </span>
  )
}

function InlineMenuPrice({ recipeId, value, onSaved }: { recipeId: string; value: number | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState(value != null ? String(value) : '')
  const [busy, setBusy]       = useState(false)
  useEffect(() => { setVal(value != null ? String(value) : '') }, [value])

  async function save() {
    const trimmed = val.trim()
    const num     = trimmed === '' ? null : Number(trimmed)
    if (trimmed !== '' && (!Number.isFinite(num) || (num as number) <= 0)) {
      setVal(value != null ? String(value) : ''); setEditing(false); return
    }
    if (num === value) { setEditing(false); return }
    setBusy(true)
    try {
      const r = await fetch(`/api/inventory/recipes/${recipeId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menu_price: num }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(j.error ?? `HTTP ${r.status}`)
        setVal(value != null ? String(value) : '')
      } else {
        onSaved()
      }
    } finally { setBusy(false); setEditing(false) }
  }

  if (!editing) {
    return (
      <span
        onClick={e => { e.stopPropagation(); setEditing(true) }}
        title="Click to edit"
        style={{
          display: 'inline-block', minWidth: 56, padding: '2px 6px',
          borderRadius: 4, cursor: 'pointer',
          color: value != null ? UXP.ink1 : UXP.ink4,
        }}
      >
        {value != null ? fmtKr(value) : '—'}
      </span>
    )
  }
  return (
    <input
      autoFocus
      type="number"
      step="1"
      min="0"
      value={val}
      disabled={busy}
      onClick={e => e.stopPropagation()}
      onChange={e => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
        if (e.key === 'Escape') { setVal(value != null ? String(value) : ''); setEditing(false) }
      }}
      style={{
        width: 78, padding: '2px 6px', fontSize: 12, fontFamily: 'inherit',
        textAlign: 'right' as const, border: `1px solid ${UXP.lav}`,
        borderRadius: 4, background: '#fff', color: UXP.ink1,
      }}
    />
  )
}

// ── Bulk import modal ─────────────────────────────────────────────────
// Preserved here verbatim — list-level surface that creates many
// recipes at once. Save flow loops the same /api/inventory/recipes POST
// the editor uses.
function BulkImportModal({ bizId, existingRecipes, onClose, onSaved }: { bizId: string; existingRecipes: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  type Ingredient =
    | { kind: 'product'; product_id: string; product_name: string; quantity: number; unit: string }
    | { kind: 'sub';     sub_name:   string; quantity: number; unit: string }
  type Draft = {
    name:                   string
    type:                   string | null
    is_subrecipe:           boolean
    portions:               number
    selling_price_inc_vat:  number | null
    glass_price_inc_vat?:   number | null
    yield_amount:           number | null
    yield_unit:             string | null
    note:                   string | null
    method:                 string | null
    ingredients:            Ingredient[]
    // Duplicate-detection. Set after parse() matches the draft name
    // (case-insensitive, trimmed) against the existing recipe list.
    // action defaults to 'skip' on duplicates; owner can switch to
    // 'replace' which clears the existing recipe's ingredients +
    // updates its metadata in place (same recipe_id preserved, so
    // prep_session_lines etc. that referenced it still resolve).
    existing_recipe_id?:    string | null
    action?:                'skip' | 'replace'
  }
  const [stage,   setStage]   = useState<'paste' | 'preview' | 'saving' | 'done'>('paste')
  const [text,    setText]    = useState('')
  const [files,   setFiles]   = useState<File[]>([])
  const [drafts,  setDrafts]  = useState<Draft[]>([])
  const [meta,    setMeta]    = useState<{ tokens_in: number; tokens_out: number; catalogue_size: number } | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [saveResults, setSaveResults] = useState<{ created: number; failed: { name: string; error: string }[] } | null>(null)
  // M127 — food vs drinks parsing modes. Drinks knows about the
  // wine/cocktail/beer menu format including glass/bottle dual pricing.
  const [category, setCategory] = useState<'food' | 'drinks'>('food')

  async function parse() {
    if (!text.trim() && files.length === 0) { setErr('Paste some menu text or attach a file first.'); return }
    setBusy(true); setErr(null)
    try {
      let r: Response
      if (files.length > 0) {
        const fd = new FormData()
        fd.append('business_id', bizId)
        fd.append('category',    category)
        for (const f of files) fd.append('file', f)
        r = await fetch('/api/inventory/recipes/import-parse', {
          method: 'POST', cache: 'no-store', body: fd,
        })
      } else {
        r = await fetch('/api/inventory/recipes/import-parse', {
          method:  'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ business_id: bizId, menu_text: text, category }),
        })
      }
      const j = await r.json()
      if (!r.ok) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
      if (!Array.isArray(j.drafts) || j.drafts.length === 0) {
        throw new Error('AI returned no dishes — try rephrasing the input or attaching a clearer source.')
      }
      // Duplicate-detection against the recipe book. Match by trimmed
      // lowercased name — same key the DB UNIQUE constraint enforces
      // (case-insensitive collation isn't on, so we match what would
      // collide). On a hit, default skip=true so the kitchen doesn't
      // double-create — owner unchecks if they really want to re-import.
      const existingByName = new Map<string, string>(
        existingRecipes.map(r => [String(r.name).trim().toLowerCase(), r.id])
      )
      const annotated: Draft[] = j.drafts.map((d: Draft) => {
        const hit = existingByName.get(String(d.name).trim().toLowerCase())
        return hit
          ? { ...d, existing_recipe_id: hit, action: 'skip' as const }
          : { ...d, existing_recipe_id: null, action: undefined }
      })
      setDrafts(annotated)
      setMeta({ tokens_in: j.tokens_in, tokens_out: j.tokens_out, catalogue_size: j.catalogue_size })
      setStage('preview')
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveAll() {
    setBusy(true); setErr(null); setStage('saving')
    const results = { created: 0, failed: [] as { name: string; error: string }[] }

    // Three classes of draft:
    //   - new (no existing_recipe_id)         → createOne
    //   - duplicate with action='skip'        → ignored, existing id still
    //                                            seeds nameToId for sub refs
    //   - duplicate with action='replace'     → replaceOne (PATCH + clear +
    //                                            re-add ingredients in place)
    const willSave = drafts.filter(d => d.action !== 'skip')
    const subs    = willSave.filter(d => d.is_subrecipe)
    const parents = willSave.filter(d => !d.is_subrecipe)
    const nameToId = new Map<string, string>()
    for (const d of drafts) {
      if (d.action === 'skip' && d.existing_recipe_id) {
        nameToId.set(d.name.trim().toLowerCase(), d.existing_recipe_id)
      }
    }

    async function createOne(d: Draft): Promise<string | null> {
      try {
        const r = await fetch('/api/inventory/recipes', {
          method:  'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            business_id:           bizId,
            name:                  d.name,
            type:                  d.type,
            menu_price_inc_vat:    d.selling_price_inc_vat ?? null,
            glass_price:           d.glass_price_inc_vat ?? null,
            // Wines + spirits are 25% VAT, soft drinks + alcohol-free are 12%,
            // food is 12%, takeaway-shifted items 6%. The Sonnet draft only
            // gives us the type — apply Sweden's standard rate per category.
            vat_rate:              d.type === 'wine' || d.type === 'beer' || d.type === 'spirit' || d.type === 'cocktail' || d.type === 'cider' ? 25 : 12,
            channel:               'dine_in',
            portions:              d.portions,
            notes:                 d.note ? `AI DRAFT — ${d.note}` : 'AI DRAFT — review quantities before trusting cost.',
            method:                d.method ?? null,
            yield_amount:          d.yield_amount,
            yield_unit:            d.yield_unit,
            is_subrecipe:          d.is_subrecipe === true,
          }),
        })
        const j = await r.json()
        if (!r.ok) {
          if (j.error && /already exists/i.test(j.error)) {
            const search = await fetch(`/api/inventory/recipes/search?business_id=${encodeURIComponent(bizId)}&q=${encodeURIComponent(d.name)}`, { cache: 'no-store' })
            const sj = await search.json().catch(() => ({}))
            const existing = Array.isArray(sj.recipes) ? sj.recipes.find((rr: any) => String(rr.name ?? '').toLowerCase() === d.name.toLowerCase()) : null
            if (existing?.recipe_id) {
              results.failed.push({ name: d.name, error: 'A recipe with this name already exists — using the existing one; not overwriting ingredients.' })
              return existing.recipe_id
            }
          }
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        const recipeId = j.recipe?.id ?? j.id
        if (!recipeId) throw new Error('No recipe id returned')

        for (let pos = 0; pos < d.ingredients.length; pos++) {
          const g = d.ingredients[pos]
          const payload: any = { quantity: g.quantity, unit: g.unit, position: pos }
          if (g.kind === 'product') {
            payload.product_id = g.product_id
          } else {
            const key  = g.sub_name.trim().toLowerCase()
            const subId = nameToId.get(key)
            if (!subId) {
              results.failed.push({ name: d.name, error: `Sub-recipe "${g.sub_name}" not found among created sub-recipes — skipped` })
              continue
            }
            payload.subrecipe_id = subId
          }
          const ar = await fetch(`/api/inventory/recipes/${recipeId}/ingredients`, {
            method:  'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
          })
          if (!ar.ok) {
            const j2 = await ar.json().catch(() => ({}))
            const label = g.kind === 'product' ? g.product_name : `sub: ${g.sub_name}`
            results.failed.push({ name: d.name, error: `${label}: ${j2.error ?? 'HTTP ' + ar.status}` })
          }
        }
        results.created++
        return recipeId
      } catch (e: any) {
        results.failed.push({ name: d.name, error: String(e?.message ?? e).slice(0, 200) })
        return null
      }
    }

    async function replaceOne(d: Draft): Promise<string | null> {
      const recipeId = d.existing_recipe_id
      if (!recipeId) return createOne(d)
      try {
        // 1. PATCH the metadata. Notes get appended-prefix to surface the
        // re-import in audit; method / yield / price / portions / type
        // overwrite. is_subrecipe + price flow through the same resolver
        // the editor uses.
        const patchBody: any = {
          name:                  d.name,
          type:                  d.type,
          portions:              d.portions,
          notes:                 d.note ? `AI DRAFT (re-imported) — ${d.note}` : 'AI DRAFT (re-imported) — review quantities before trusting cost.',
          method:                d.method ?? null,
          yield_amount:          d.yield_amount,
          yield_unit:            d.yield_unit,
          is_subrecipe:          d.is_subrecipe === true,
        }
        if (d.selling_price_inc_vat != null) {
          patchBody.menu_price_inc_vat = d.selling_price_inc_vat
          patchBody.vat_rate = 12
          patchBody.channel  = 'dine_in'
        }
        const pr = await fetch(`/api/inventory/recipes/${recipeId}`, {
          method: 'PATCH', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        })
        if (!pr.ok) {
          const j = await pr.json().catch(() => ({}))
          throw new Error(j.error ?? `PATCH HTTP ${pr.status}`)
        }

        // 2. Fetch + DELETE existing ingredients so we start fresh.
        const gr = await fetch(`/api/inventory/recipes/${recipeId}`, { cache: 'no-store' })
        const gj = await gr.json().catch(() => ({}))
        const existingIngs: { id: string }[] = gj?.summary?.ingredients ?? []
        for (const ing of existingIngs) {
          await fetch(`/api/inventory/recipes/${recipeId}/ingredients/${ing.id}`, {
            method: 'DELETE', cache: 'no-store',
          })
        }

        // 3. Re-add the draft's ingredients (same path as createOne).
        for (let pos = 0; pos < d.ingredients.length; pos++) {
          const g = d.ingredients[pos]
          const payload: any = { quantity: g.quantity, unit: g.unit, position: pos }
          if (g.kind === 'product') {
            payload.product_id = g.product_id
          } else {
            const subId = nameToId.get(g.sub_name.trim().toLowerCase())
            if (!subId) {
              results.failed.push({ name: d.name, error: `Sub-recipe "${g.sub_name}" not found — skipped` })
              continue
            }
            payload.subrecipe_id = subId
          }
          const ar = await fetch(`/api/inventory/recipes/${recipeId}/ingredients`, {
            method:  'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
          })
          if (!ar.ok) {
            const j2 = await ar.json().catch(() => ({}))
            const label = g.kind === 'product' ? g.product_name : `sub: ${g.sub_name}`
            results.failed.push({ name: d.name, error: `${label}: ${j2.error ?? 'HTTP ' + ar.status}` })
          }
        }
        results.created++
        return recipeId
      } catch (e: any) {
        results.failed.push({ name: d.name, error: `replace: ${String(e?.message ?? e).slice(0, 200)}` })
        return null
      }
    }

    async function saveOne(d: Draft): Promise<string | null> {
      return d.action === 'replace' ? replaceOne(d) : createOne(d)
    }

    for (const d of subs) {
      const id = await saveOne(d)
      if (id) nameToId.set(d.name.trim().toLowerCase(), id)
    }
    for (const d of parents) await saveOne(d)

    setSaveResults(results)
    setStage('done')
    setBusy(false)
  }

  function editIngredient(di: number, ii: number, patch: { quantity?: number; unit?: string }) {
    setDrafts(prev => {
      const next = prev.slice()
      const draft = { ...next[di] }
      draft.ingredients = draft.ingredients.slice()
      const existing = draft.ingredients[ii]
      draft.ingredients[ii] = (
        existing.kind === 'product'
          ? { ...existing, quantity: patch.quantity ?? existing.quantity, unit: patch.unit ?? existing.unit }
          : { ...existing, quantity: patch.quantity ?? existing.quantity, unit: patch.unit ?? existing.unit }
      )
      next[di] = draft
      return next
    })
  }
  function removeIngredient(di: number, ii: number) {
    setDrafts(prev => {
      const next = prev.slice()
      const draft = { ...next[di] }
      draft.ingredients = draft.ingredients.filter((_, i) => i !== ii)
      next[di] = draft
      return next
    })
  }
  function replaceIngredient(di: number, ii: number, product: { product_id: string; name: string; invoice_unit?: string | null }) {
    setDrafts(prev => {
      const next = prev.slice()
      const draft = { ...next[di] }
      draft.ingredients = draft.ingredients.slice()
      const existing = draft.ingredients[ii]
      draft.ingredients[ii] = {
        kind:         'product',
        product_id:   product.product_id,
        product_name: product.name,
        quantity:     existing.quantity,
        unit:         existing.unit || product.invoice_unit || 'g',
      }
      next[di] = draft
      return next
    })
  }

  // Picker state for the ingredient-replace flow.
  const [picker, setPicker] = useState<{ di: number; ii: number; q: string; results: Array<{ product_id: string; name: string; invoice_unit?: string | null }> } | null>(null)
  useEffect(() => {
    if (!picker) return
    const timer = setTimeout(async () => {
      const r = await fetch(`/api/inventory/products/search?business_id=${encodeURIComponent(bizId)}&q=${encodeURIComponent(picker.q)}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setPicker(p => p ? { ...p, results: j.products ?? [] } : p)
    }, 200)
    return () => clearTimeout(timer)
  }, [picker?.q, picker?.di, picker?.ii, bizId])
  function removeDraft(di: number) {
    setDrafts(prev => prev.filter((_, i) => i !== di))
  }
  function editDraftName(di: number, name: string) {
    // Re-check duplicate status against the existing book — owner may
    // have renamed to break a collision (or introduced a new one).
    const existingByName = new Map<string, string>(
      existingRecipes.map(r => [String(r.name).trim().toLowerCase(), r.id])
    )
    const hit = existingByName.get(name.trim().toLowerCase())
    setDrafts(prev => prev.map((d, i) => i === di
      ? {
          ...d, name,
          existing_recipe_id: hit ?? null,
          action: hit ? (d.action ?? 'skip') : undefined,
        }
      : d))
  }
  function editDraftPrice(di: number, price: string) {
    const v = price === '' ? null : Number(price)
    setDrafts(prev => prev.map((d, i) => i === di ? { ...d, selling_price_inc_vat: v != null && Number.isFinite(v) && v > 0 ? v : null } : d))
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Bulk import recipes from menu"
      subtitle="Paste your menu text (one dish per line works well). Sonnet drafts each recipe using your existing catalogue. Review + edit before saving."
      ariaLabel="Bulk import recipes"
    >
      <div>
        {stage === 'paste' && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: UXP.ink3, marginRight: 4 }}>Mode:</span>
              {(['food','drinks'] as const).map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  style={{
                    padding: '4px 12px', fontSize: 11, fontFamily: 'inherit', fontWeight: 500,
                    background: category === c ? UXP.lavFill : 'transparent',
                    color: category === c ? UXP.lavText : UXP.ink2,
                    border: `0.5px solid ${category === c ? UXP.lav : UXP.border}`,
                    borderRadius: 999, cursor: 'pointer',
                  }}
                >
                  {c === 'food' ? 'Food' : 'Drinks (wine / beer / cocktail)'}
                </button>
              ))}
              <span style={{ fontSize: 10, color: UXP.ink4, marginLeft: 8 }}>
                {category === 'drinks'
                  ? 'Drinks mode understands wine vintages, glass/bottle prices, and cocktail ingredient lists.'
                  : 'Food mode handles dishes, sub-recipes, and ingredient quantities.'}
              </span>
            </div>
            <div style={{
              border: `1px dashed ${UXP.border}`, borderRadius: 6,
              padding: '12px 14px', marginBottom: 10,
              background: files.length > 0 ? UXP.lavFill : UXP.subtleBg,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, marginBottom: 6 }}>
                Attach files (PDF, Word .docx, image — up to 10 / 25 MB total)
              </div>
              <input
                type="file"
                multiple
                accept=".pdf,.docx,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={e => {
                  const picked = Array.from(e.target.files ?? [])
                  const next = [...files, ...picked].slice(0, 10)
                  const totalBytes = next.reduce((s, f) => s + f.size, 0)
                  if (totalBytes > 25 * 1024 * 1024) {
                    setErr('Total upload size exceeds 25 MB — pick a smaller set.')
                    return
                  }
                  setFiles(next)
                  setErr(null)
                  e.target.value = ''
                }}
                disabled={busy}
                style={{ fontSize: 11, fontFamily: 'inherit' }}
              />
              {files.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: UXP.lavText }}>
                      <span style={{ flex: 1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                        {f.name}
                      </span>
                      <span style={{ color: UXP.ink4, fontSize: 10, whiteSpace: 'nowrap' as const }}>{(f.size / 1024).toFixed(0)} KB</span>
                      <button
                        onClick={() => setFiles(files.filter((_, j) => j !== i))}
                        disabled={busy}
                        style={{ background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, padding: 0 }}
                        aria-label={`Remove ${f.name}`}
                      >×</button>
                    </div>
                  ))}
                  <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 4 }}>
                    {files.length} file{files.length === 1 ? '' : 's'} · {(files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(0)} KB total
                    {files.length > 1 && ' · Sub-recipes referenced across files will resolve automatically'}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 6, lineHeight: 1.5 }}>
                Word documents get text-extracted on the server. PDFs and images go to Sonnet vision directly. Method/instructions in the source are captured per dish.
              </div>
            </div>

            <div style={{ fontSize: 10, color: UXP.ink4, marginBottom: 4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>
              Or paste menu text
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={'e.g.\nPinsa Margherita — pomodoro, mozzarella, basilika, olivolja  — 195 kr\nPinsa Chevre — chèvre, honung, valnötter, ruccola — 219 kr\nMargherita — pizzatomater, mozzarella, basilika — 165 kr'}
              rows={files.length > 0 ? 5 : 12}
              disabled={busy || files.length > 0}
              style={{
                width: '100%', boxSizing: 'border-box', padding: 10,
                fontFamily: 'inherit', fontSize: 12, borderRadius: 6,
                border: `1px solid ${UXP.border}`, resize: 'vertical' as const,
                opacity: files.length > 0 ? 0.4 : 1,
              }}
            />
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 6 }}>
              {files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'} attached — text input disabled.` : `${text.length}/8000 chars`} · One Sonnet call per import (~$0.10 text-only / ~$0.25–$0.50 with files) — quota-counted.
            </div>
            {err && <div style={{ marginTop: 8, fontSize: 11, color: UXP.roseText, background: UXP.roseFill, padding: '8px 10px', borderRadius: 6 }}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 8 }}>
              <button onClick={onClose} disabled={busy} style={overlayBtn.secondary}>Cancel</button>
              <button onClick={parse} disabled={busy || (!text.trim() && files.length === 0)} style={overlayBtn.primary}>
                {busy ? 'Drafting…' : 'Draft recipes'}
              </button>
            </div>
          </>
        )}

        {stage === 'preview' && (
          <>
            <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 10, padding: '8px 10px', background: UXP.subtleBg, borderRadius: 6 }}>
              Sonnet drafted <strong>{drafts.length}</strong> dish{drafts.length === 1 ? '' : 'es'} from <strong>{meta?.catalogue_size}</strong> products in your catalogue. Review + edit; quantities are AI estimates and should be confirmed by the chef. Anything you can't find here — set the yield and ingredients later from the recipe page.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
              {drafts.map((d, di) => (
                <div key={di} style={{
                  border:        `1px solid ${d.existing_recipe_id ? UXP.coral : d.is_subrecipe ? UXP.lavMid : UXP.border}`,
                  borderRadius:  8,
                  padding:       '10px 12px',
                  background:    d.existing_recipe_id && d.action === 'skip' ? '#fef3e0' : d.is_subrecipe ? UXP.subtleBg : 'transparent',
                  opacity:       d.existing_recipe_id && d.action === 'skip' ? 0.75 : 1,
                }}>
                  {d.existing_recipe_id && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
                      padding: '6px 8px', background: '#fef3e0', borderRadius: 4,
                      fontSize: 11, color: UXP.coral, fontWeight: 500,
                    }}>
                      <span style={{ flex: 1 }}>
                        Already in your recipe book — {d.action === 'replace' ? 'WILL REPLACE existing' : 'will be SKIPPED'}
                      </span>
                      <div style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden', border: `0.5px solid ${UXP.coral}` }}>
                        <button
                          type="button"
                          onClick={() => setDrafts(prev => prev.map((x, i) => i === di ? { ...x, action: 'skip' as const } : x))}
                          style={{
                            padding: '4px 10px', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
                            background: d.action === 'skip' ? UXP.coral : 'transparent',
                            color: d.action === 'skip' ? '#fff' : UXP.coral,
                            border: 'none', cursor: 'pointer',
                          }}
                        >Skip</button>
                        <button
                          type="button"
                          onClick={() => setDrafts(prev => prev.map((x, i) => i === di ? { ...x, action: 'replace' as const } : x))}
                          style={{
                            padding: '4px 10px', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
                            background: d.action === 'replace' ? UXP.coral : 'transparent',
                            color: d.action === 'replace' ? '#fff' : UXP.coral,
                            border: 'none', borderLeft: `0.5px solid ${UXP.coral}`, cursor: 'pointer',
                          }}
                        >Replace</button>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    {d.is_subrecipe && (
                      <span style={{
                        fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                        padding: '2px 6px', background: UXP.lavFill, color: UXP.lavText,
                        borderRadius: 3, textTransform: 'uppercase' as const, whiteSpace: 'nowrap' as const,
                      }}>Sub</span>
                    )}
                    <input
                      value={d.name}
                      onChange={e => editDraftName(di, e.target.value)}
                      style={{ flex: 1, padding: '4px 8px', fontSize: 13, fontWeight: 500, border: `1px solid ${UXP.border}`, borderRadius: 4, fontFamily: 'inherit' }}
                    />
                    {!d.is_subrecipe && (
                      <input
                        type="number" min="0" step="1" placeholder="price inc VAT"
                        value={d.selling_price_inc_vat ?? ''}
                        onChange={e => editDraftPrice(di, e.target.value)}
                        style={{ width: 110, padding: '4px 8px', fontSize: 12, border: `1px solid ${UXP.border}`, borderRadius: 4, fontFamily: 'inherit' }}
                      />
                    )}
                    {d.is_subrecipe && d.yield_amount && d.yield_unit && (
                      <span style={{ fontSize: 10, color: UXP.ink4, whiteSpace: 'nowrap' as const }}>
                        yields {d.yield_amount} {d.yield_unit}/portion
                      </span>
                    )}
                    <button onClick={() => removeDraft(di)} title="Drop this recipe" style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink4, fontSize: 16 }}>×</button>
                  </div>
                  {d.note && <div style={{ fontSize: 10, color: UXP.ink4, marginBottom: 6 }}>{d.note}</div>}
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                    {d.ingredients.length === 0 && (
                      <div style={{ fontSize: 11, color: UXP.ink4, padding: '4px 6px', fontStyle: 'italic' }}>
                        AI couldn't find matching products in your catalogue. Add ingredients manually from the recipe page after save.
                      </div>
                    )}
                    {d.ingredients.map((g, ii) => (
                      <div key={ii} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 50px 24px 24px', gap: 6, alignItems: 'center' }}>
                        <div style={{ fontSize: 11, color: UXP.ink2, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', gap: 5 }}
                             title={g.kind === 'product' ? g.product_name : `sub-recipe: ${g.sub_name}`}>
                          {g.kind === 'sub' && (
                            <span style={{
                              fontSize: 8, fontWeight: 600, padding: '1px 4px',
                              background: UXP.lavFill, color: UXP.lavText,
                              borderRadius: 2, textTransform: 'uppercase' as const, flexShrink: 0,
                            }}>sub</span>
                          )}
                          {g.kind === 'product' ? g.product_name : g.sub_name}
                        </div>
                        <input
                          type="number" min="0" step="0.01" value={g.quantity}
                          onChange={e => editIngredient(di, ii, { quantity: Number(e.target.value) })}
                          style={{ padding: '3px 6px', fontSize: 11, border: `1px solid ${UXP.border}`, borderRadius: 4, fontFamily: 'inherit', textAlign: 'right' as const }}
                        />
                        <input
                          value={g.unit}
                          onChange={e => editIngredient(di, ii, { unit: e.target.value })}
                          style={{ padding: '3px 6px', fontSize: 11, border: `1px solid ${UXP.border}`, borderRadius: 4, fontFamily: 'inherit' }}
                        />
                        {g.kind === 'product' ? (
                          <button
                            onClick={() => setPicker({ di, ii, q: '', results: [] })}
                            aria-label="Swap product"
                            title="Replace with a different catalogue product"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.lavText, fontSize: 12 }}
                          >⇄</button>
                        ) : <span />}
                        <button onClick={() => removeIngredient(di, ii)} aria-label="Remove ingredient" style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink4, fontSize: 14 }}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {err && <div style={{ marginTop: 8, fontSize: 11, color: UXP.roseText, background: UXP.roseFill, padding: '8px 10px', borderRadius: 6 }}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 8 }}>
              <button onClick={() => setStage('paste')} disabled={busy} style={overlayBtn.secondary}>← Back to paste</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} disabled={busy} style={overlayBtn.secondary}>Cancel</button>
                <button onClick={saveAll} disabled={busy || drafts.length === 0} style={overlayBtn.primary}>
                  {busy ? 'Saving…' : `Create ${drafts.length} recipe${drafts.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>

            {/* ── Product-swap picker overlay ─────────────────────────── */}
            {picker && (
              <div
                onClick={() => setPicker(null)}
                style={{
                  position: 'fixed', inset: 0, zIndex: 1000,
                  background: 'rgba(58, 53, 80, 0.45)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 20,
                }}
              >
                <div
                  onClick={e => e.stopPropagation()}
                  style={{
                    width: 'min(560px, 100%)', background: UXP.cardBg,
                    border: `0.5px solid ${UXP.border}`, borderRadius: 8,
                    padding: 16, boxShadow: '0 10px 32px rgba(0,0,0,0.2)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Replace with catalogue product</h3>
                    <button onClick={() => setPicker(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 18 }}>×</button>
                  </div>
                  <input
                    autoFocus
                    type="text"
                    placeholder="Search products…"
                    value={picker.q}
                    onChange={e => setPicker(p => p ? { ...p, q: e.target.value } : p)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit', marginBottom: 8 }}
                  />
                  <div style={{ maxHeight: 320, overflowY: 'auto' as const, border: `0.5px solid ${UXP.border}`, borderRadius: 6 }}>
                    {picker.results.length === 0 ? (
                      <div style={{ padding: 14, textAlign: 'center' as const, fontSize: 12, color: UXP.ink4 }}>
                        {picker.q.trim() ? 'No matches.' : 'Start typing to search the catalogue.'}
                      </div>
                    ) : picker.results.map(p => (
                      <div
                        key={p.product_id}
                        onClick={() => { replaceIngredient(picker.di, picker.ii, p); setPicker(null) }}
                        style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: `0.5px solid ${UXP.borderSoft}`, fontSize: 12, color: UXP.ink1 }}
                        onMouseEnter={e => (e.currentTarget.style.background = UXP.lavFill)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <div style={{ fontWeight: 500 }}>{p.name}</div>
                        {p.invoice_unit && <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>{p.invoice_unit}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {stage === 'saving' && (
          <div style={{ textAlign: 'center' as const, padding: 30, color: UXP.ink3, fontSize: 12 }}>
            Saving {drafts.length} recipes…
          </div>
        )}

        {stage === 'done' && saveResults && (
          <>
            <div style={{ padding: '10px 12px', background: UXP.greenFill, color: UXP.greenDeep, borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
              Created {saveResults.created} of {drafts.length} recipes.
              {saveResults.failed.length > 0 && (
                <> {saveResults.failed.length} ingredient/recipe issues — see below.</>
              )}
            </div>
            {saveResults.failed.length > 0 && (
              <div style={{ maxHeight: 200, overflow: 'auto' as const, fontSize: 11, marginBottom: 10 }}>
                {saveResults.failed.map((f, i) => (
                  <div key={i} style={{ padding: '4px 8px', borderBottom: `0.5px solid ${UXP.borderSoft}`, color: UXP.ink3 }}>
                    <strong>{f.name}:</strong> {f.error}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onSaved} style={overlayBtn.primary}>Done</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

// ── Atoms / styles ─────────────────────────────────────────────────────
function Stat({ label, value, tone = 'ink' }: { label: string; value: string; tone?: 'ink' | 'coral' }) {
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: tone === 'coral' ? UXP.coral : UXP.ink1, marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}
// Checkbox that supports the indeterminate (partial-selection) visual.
// stopPropagation keeps a tick from triggering row navigation.
function SelectCheckbox({ checked, indeterminate, onToggle, ariaLabel }: {
  checked: boolean; indeterminate?: boolean; onToggle: () => void; ariaLabel: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onClick={e => e.stopPropagation()}
      onChange={e => { e.stopPropagation(); onToggle() }}
      style={{ cursor: 'pointer', width: 15, height: 15, accentColor: UXP.lavDeep }}
    />
  )
}
function ViewPill({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding:       '4px 12px',
        background:    active ? UXP.lavFill : UXP.cardBg,
        color:         active ? UXP.lavText : UXP.ink2,
        border:        `0.5px solid ${active ? UXP.lav : UXP.border}`,
        borderRadius:  999,
        fontSize:      11,
        fontWeight:    500,
        fontFamily:    'inherit',
        cursor:        'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {label} <span style={{ color: UXP.ink4, marginLeft: 4 }}>· {count}</span>
    </button>
  )
}
function TypePill({ typeKey, active, onClick, label, count }: { typeKey?: string; active: boolean; onClick: () => void; label: string; count: number }) {
  // Smaller, denser variant — sits under the main Dishes/Sub-recipes row.
  //
  // When ACTIVE and a category key is supplied, the pill takes that
  // category's colour (per the canonical map in lib/categoryColors.ts).
  // The "All" pill omits typeKey so it falls back to the generic lavender
  // active state — preserving its meaning as "no filter applied".
  const { ink, fill } = typeKey ? categoryToken(typeKey) : { ink: UXP.lavText, fill: UXP.lavFill }
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding:       '2px 9px',
        background:    active ? fill          : 'transparent',
        color:         active ? ink           : UXP.ink3,
        border:        `0.5px solid ${active ? ink : UXP.border}`,
        borderRadius:  999,
        fontSize:      10,
        fontWeight:    500,
        fontFamily:    'inherit',
        cursor:        'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {label} <span style={{ color: UXP.ink4, marginLeft: 3 }}>{count}</span>
    </button>
  )
}
function Empty({ label }: { label: string }) {
  return (
    <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13,
                  background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8 }}>
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
const primaryBtn: React.CSSProperties = {
  padding: '6px 14px', fontSize: 12, fontWeight: 600,
  background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
const secondaryBtn: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 500,
  background: 'transparent', color: UXP.ink3, border: `0.5px solid ${UXP.border}`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
function td(): React.CSSProperties { return { padding: '10px 12px', fontSize: 12, color: UXP.ink2 } }
function numTd(): React.CSSProperties { return { ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1 } }
function foodPctColor(p: number): string {
  if (p >= 35) return UXP.roseText
  if (p >= 30) return UXP.coral
  if (p <= 22) return UXP.greenDeep
  return UXP.ink2
}
function gpColor(p: number): string {
  if (p < 60) return UXP.roseText
  if (p < 65) return UXP.coral
  if (p >= 75) return UXP.greenDeep
  return UXP.ink2
}

// ── BulkAiFillButton ──────────────────────────────────────────────────
// One-shot AI-fill across every product referenced by a recipe at this
// business. Calls /api/inventory/items/ai-fill-bulk in 25-product passes
// until remaining hits 0, surfacing the running tally so the chef can
// watch progress. Auto-applies suggestions where confidence >= 0.85;
// lower-confidence ones come back in the review list so the owner can
// open the per-item modal and decide.
function BulkAiFillButton({ bizId, onDone }: { bizId: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ processed: number; applied: number; remaining: number; review: number; no_source: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (!bizId) return
    setBusy(true); setError(null)
    let processed = 0, applied = 0, review = 0, noSource = 0
    try {
      // Drain loop — each call processes up to 25 products. Stop when
      // remaining hits 0 OR the server reports 0 processed (defensive,
      // catches empty-state).
      for (let pass = 0; pass < 40; pass++) {       // safety cap: 40 × 25 = 1000 products max
        const r = await fetch('/api/inventory/items/ai-fill-bulk', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_id: bizId, scope: 'recipes_only', max: 25, confidence_threshold: 0.85 }),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { setError(j.error ?? `HTTP ${r.status}`); break }
        processed += j.processed ?? 0
        applied   += j.applied   ?? 0
        review    += (j.queued_for_review?.length ?? 0)
        noSource  += (j.no_source?.length ?? 0)
        const remaining = j.remaining ?? 0
        setProgress({ processed, applied, remaining, review, no_source: noSource })
        if ((j.processed ?? 0) === 0 || remaining === 0) break
      }
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        onClick={run}
        disabled={!bizId || busy}
        title={!bizId ? 'Select a business in the sidebar first' : 'Auto-fill pack size / base unit / weight / category for every recipe ingredient using supplier catalogue data. Auto-applies high-confidence suggestions; low-confidence ones go to a review list.'}
        style={{
          padding: '6px 12px', fontSize: 12, fontWeight: 500,
          background: 'transparent', color: UXP.ink3, border: `0.5px solid ${UXP.border}`, borderRadius: 5,
          cursor: bizId && !busy ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
          opacity: bizId ? 1 : 0.5,
        }}
      >
        {busy ? 'Filling…' : 'AI-fill articles'}
      </button>
      {progress && (
        <div style={{ fontSize: 10, color: UXP.ink4, lineHeight: 1.4, textAlign: 'right' as const }}>
          {progress.processed} processed · {progress.applied} applied
          {progress.review > 0 ? ` · ${progress.review} review` : ''}
          {progress.no_source > 0 ? ` · ${progress.no_source} no source` : ''}
          {progress.remaining > 0 ? ` · ${progress.remaining} remaining` : ''}
        </div>
      )}
      {error && <div style={{ fontSize: 10, color: UXP.coral, lineHeight: 1.4, textAlign: 'right' as const }}>Error: {error}</div>}
    </div>
  )
}
