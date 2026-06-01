'use client'
// app/inventory/recipes/page.tsx
//
// Live recipes — list of every recipe for the selected business with
// food cost / food % / GP computed from latest invoice prices, plus a
// create modal + detail drawer for editing ingredients.
//
// Replaces the prior mock-only surface. Cost calc lives server-side in
// lib/inventory/recipe-cost.ts so it's identical across list + detail.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { convertQuantity } from '@/lib/inventory/unit-conversion'
import { UXP } from '@/lib/constants/tokens'
import { EditItemModal } from '@/components/EditItemModal'
import { fmtKr } from '@/lib/format'

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
}

interface ListResponse {
  recipes: RecipeRow[]
  summary: { count: number; avg_gp_pct: number | null; low_gp_count: number; avg_menu_price: number | null }
}

const RECIPE_TYPES = ['starter', 'main', 'pasta', 'pizza', 'dessert', 'drink', 'cocktail', 'side', 'sauce', 'other']

export default function InventoryRecipesPage() {
  const t = useTranslations('operations.inventory.recipes')
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [data,    setData]    = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [openId,  setOpenId]  = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  // Drill-down back-stack: when you click "Open" on a sub-recipe row, the
  // parent's id pushes onto the stack. The drawer's back arrow pops it.
  const [drillStack, setDrillStack] = useState<string[]>([])
  const [creating,setCreating]= useState(false)

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
    if (!bizId) { setLoading(false); return }   // Don't lie about loading when there's nothing to load.
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/recipes?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])
  useEffect(() => {
    if (bizId) load()
    else setLoading(false)   // No biz selected yet — stop the loading spinner and surface the empty-biz state.
  }, [bizId, load])

  const allRows = data?.recipes ?? []
  // Phase 1 menu-engineering filter. A "dish" has a selling price set
  // (ex-VAT canonical, or legacy menu_price). A "sub-recipe" doesn't —
  // it's a yield batch consumed by other recipes. Default view is
  // dishes-only so the margin numbers aren't drowned by zero-priced
  // sub-recipes that legitimately have no GP%.
  const [viewFilter, setViewFilter] = useState<'dishes' | 'subrecipes' | 'all'>('dishes')
  // A recipe is a "dish" when it has either:
  //   - a selling price set (owner explicitly listed it on the menu), OR
  //   - a dish-shaped type (starter/main/pasta/pizza/dessert/drink/
  //     cocktail/side) — this catches AI-imported dishes that didn't
  //     have a price in the source but ARE menu items.
  // Sub-recipes are the leftover: no price AND no dish-shaped type
  // (sauce/other/null land here).
  const DISH_TYPES = new Set(['starter', 'main', 'pasta', 'pizza', 'dessert', 'drink', 'cocktail', 'side'])
  const isDish = (r: any) =>
    (r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
    || (r.menu_price != null && Number(r.menu_price) > 0)
    || (r.type && DISH_TYPES.has(String(r.type).toLowerCase()))
  const rows = viewFilter === 'dishes'     ? allRows.filter(isDish)
            : viewFilter === 'subrecipes'  ? allRows.filter((r: any) => !isDish(r))
            :                                allRows
  const dishCount = allRows.filter(isDish).length
  const subCount  = allRows.length - dishCount
  // Phase 1 KPI strip should reflect what's actually on screen.
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

  return (
    <AppShell>
      <div style={{ maxWidth: 1280, padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
              {t('title')}
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
              {t('subtitle')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setImporting(true)} disabled={!bizId}
              title={!bizId ? 'Select a business in the sidebar first' : 'Bulk-import recipes from your menu text — Sonnet drafts ingredients from your catalogue'}
              style={{ ...secondaryBtn, opacity: bizId ? 1 : 0.5, cursor: bizId ? 'pointer' : 'not-allowed' }}>
              Bulk import
            </button>
            <button onClick={() => setCreating(true)} disabled={!bizId}
              title={!bizId ? 'Select a business in the sidebar first' : undefined}
              style={{ ...primaryBtn, opacity: bizId ? 1 : 0.5, cursor: bizId ? 'pointer' : 'not-allowed' }}>
              {t('addRecipe')}
            </button>
          </div>
        </div>

        {/* KPI strip — reflects the visible filter (dishes / sub-recipes / all). */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
          <Stat label={t('kpiCount')}      value={String(visibleSummary.count)} />
          <Stat label={t('kpiAvgGp')}      value={visibleSummary.avg_gp_pct != null ? `${visibleSummary.avg_gp_pct.toFixed(1)} %` : '—'} />
          <Stat label={t('kpiLowGp')}      value={String(visibleSummary.low_gp_count)}
                tone={visibleSummary.low_gp_count > 0 ? 'coral' : 'ink'} />
          <Stat label={t('kpiAvgPrice')}   value={visibleSummary.avg_menu_price != null ? fmtKr(visibleSummary.avg_menu_price) : '—'} />
        </div>

        {/* Phase 1 view filter. Defaults to dishes — the menu-engineering
            view. Sub-recipes are accessible via their own pill for
            authoring; "All" exposes the legacy combined list. */}
        {bizId && allRows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <ViewPill active={viewFilter === 'dishes'}     onClick={() => setViewFilter('dishes')}     label="Dishes"      count={dishCount} />
            <ViewPill active={viewFilter === 'subrecipes'} onClick={() => setViewFilter('subrecipes')} label="Sub-recipes" count={subCount} />
            <ViewPill active={viewFilter === 'all'}        onClick={() => setViewFilter('all')}        label="All"         count={allRows.length} />
            {visibleSummary.incomplete_count > 0 && (
              <span style={{
                marginLeft: 'auto', fontSize: 10, padding: '3px 9px',
                background: '#fef3e0', color: UXP.coral, fontWeight: 600,
                borderRadius: 999, letterSpacing: '0.02em',
              }}
              title="Dishes with unmapped or missing-cost ingredients. Their GP% is shown as 'Incomplete cost' until the gap is fixed.">
                {visibleSummary.incomplete_count} incomplete cost
              </span>
            )}
          </div>
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
        {bizId && !loading && rows.length === 0 && !error && <Empty label={t('empty')} />}

        {!loading && rows.length > 0 && (
          <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <thead>
                <tr style={{ background: UXP.subtleBg }}>
                  <Th label={t('colName')} />
                  <Th label={t('colType')} />
                  <Th label={t('colIngredients')} align="right" />
                  <Th label={t('colMenuPrice')} align="right" />
                  <Th label={t('colFoodCost')} align="right" />
                  <Th label={t('colFoodPct')} align="right" />
                  <Th label={t('colGp')} align="right" />
                  <Th label={t('colWarnings')} align="center" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}
                      onClick={() => setOpenId(r.id)}
                      style={{ cursor: 'pointer', borderTop: `0.5px solid ${UXP.borderSoft}` }}
                      onMouseEnter={e => (e.currentTarget.style.background = UXP.subtleBg)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ ...td(), fontWeight: 500, color: UXP.ink1 }}>{r.name}</td>
                    <td style={{ ...td(), color: UXP.ink3 }}>{r.type ?? '—'}</td>
                    <td style={{ ...td(), textAlign: 'right' as const, color: UXP.ink3 }}>{r.ingredient_count}</td>
                    <td style={numTd()}>{r.menu_price != null ? fmtKr(r.menu_price) : '—'}</td>
                    <td style={numTd()}>{fmtKr(r.food_cost)}</td>
                    <td style={{ ...numTd(), color: r.food_pct == null ? UXP.ink3 : foodPctColor(r.food_pct) }}>
                      {r.food_pct != null ? `${r.food_pct.toFixed(1)} %` : '—'}
                    </td>
                    {/* Phase 1 honest-incomplete rule: when warnings fire,
                        replace the (likely confident-but-wrong) GP% with
                        an "Incomplete cost" badge. Owner sees the same
                        warning count chip on the far right but the margin
                        cell never lies. GP kr sits under GP% as the
                        secondary number (ratio first, money second). */}
                    <td style={{ ...numTd(), fontWeight: 500 }}>
                      {(r.missing_prices > 0 || r.unit_mismatches > 0) ? (
                        <span style={{
                          display:       'inline-block',
                          padding:       '2px 8px',
                          background:    '#fef3e0',
                          color:         UXP.coral,
                          fontSize:      10,
                          fontWeight:    600,
                          borderRadius:  6,
                          letterSpacing: '0.02em',
                        }}>Incomplete cost</span>
                      ) : r.gp_pct != null ? (
                        <span style={{ color: gpColor(r.gp_pct) }}>
                          {r.gp_pct.toFixed(1)} %
                          {r.gp_kr != null && (
                            <span style={{ display: 'block', fontSize: 10, color: UXP.ink4, fontWeight: 400, marginTop: 1 }}>
                              {fmtKr(r.gp_kr)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: UXP.ink3 }}>—</span>
                      )}
                    </td>
                    <td style={{ ...td(), textAlign: 'center' as const }}>
                      {(r.missing_prices > 0 || r.unit_mismatches > 0) && (
                        <span style={{
                          display: 'inline-block', padding: '1px 7px',
                          background: '#fef3e0', color: UXP.coral,
                          fontSize: 10, fontWeight: 600, borderRadius: 4,
                        }} title={t('warningsTooltip', { missing: String(r.missing_prices), mismatch: String(r.unit_mismatches) })}>
                          {r.missing_prices + r.unit_mismatches}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && bizId && (
        <CreateModal bizId={bizId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); load() }} />
      )}
      {importing && bizId && (
        <BulkImportModal bizId={bizId} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); load() }} />
      )}
      {openId && bizId && (
        <RecipeDrawer
          recipeId={openId}
          bizId={bizId}
          canGoBack={drillStack.length > 0}
          onBack={() => {
            const prev = drillStack[drillStack.length - 1]
            setDrillStack(s => s.slice(0, -1))
            setOpenId(prev)
          }}
          onOpenSubrecipe={(id) => {
            setDrillStack(s => [...s, openId])
            setOpenId(id)
          }}
          onClose={() => { setOpenId(null); setDrillStack([]); load() }}
        />
      )}
    </AppShell>
  )
}

// ── Create modal ───────────────────────────────────────────────────────
// VAT_RATES — the three Swedish food-service rates owners actually see.
// Listed explicitly so the dropdown can't mis-pair channel with rate
// (channel is independent — a takeaway pinsa is 6%, an alcoholic drink is
// 25% regardless of channel). Keep in sync with lib/sweden/vat.ts.
const VAT_RATES = [6, 12, 25] as const

// Common recipe units. Owners enter what the kitchen actually measures
// in — usually grams/ml even when the supplier ships in kg or styck.
// The cost engine converts via product.base_unit + pack_size, so g↔kg /
// ml↔l are automatic. Includes Swedish kitchen units (knippe, klyfta,
// burk) so dropdown covers real recipe writing.
const UNIT_OPTIONS = [
  'g', 'kg', 'ml', 'l',
  'st', 'styck',
  'msk', 'tsk', 'krm',
  'knippe', 'klyfta', 'skiva', 'bunt',
  'pkt', 'burk', 'flaska',
  'portion',
] as const

const PRODUCT_CATEGORIES = ['food', 'beverage', 'alcohol', 'disposables', 'takeaway_material', 'cleaning', 'other'] as const

// Bulk import — owner pastes a menu, Sonnet drafts recipes drawn from
// the existing catalogue, owner reviews + saves all in one go. Saves
// via the existing /api/inventory/recipes POST + /[id]/ingredients POST
// endpoints; no schema change.
//
// Two-stage modal: PASTE → PREVIEW. Owner can edit any draft (rename,
// remove ingredients, edit quantities) before committing. Cancel at
// either stage discards everything; only the explicit "Create N
// recipes" button writes.
function BulkImportModal({ bizId, onClose, onSaved }: { bizId: string; onClose: () => void; onSaved: () => void }) {
  // Two ingredient shapes coming back from import-parse:
  //   - product: linked to an existing catalogue product
  //   - sub:     references another draft in THIS batch by name; the
  //              save flow resolves to subrecipe_id after the sub is
  //              created (sub-recipes process first, build a
  //              name→id map, parents reference into it).
  type Ingredient =
    | { kind: 'product'; product_id: string; product_name: string; quantity: number; unit: string }
    | { kind: 'sub';     sub_name:   string; quantity: number; unit: string }
  type Draft = {
    name:                   string
    type:                   string | null
    is_subrecipe:           boolean
    portions:               number
    selling_price_inc_vat:  number | null
    yield_amount:           number | null
    yield_unit:             string | null
    note:                   string | null
    method:                 string | null
    ingredients:            Ingredient[]
  }
  const [stage,   setStage]   = useState<'paste' | 'preview' | 'saving' | 'done'>('paste')
  const [text,    setText]    = useState('')
  const [file,    setFile]    = useState<File | null>(null)
  const [drafts,  setDrafts]  = useState<Draft[]>([])
  const [meta,    setMeta]    = useState<{ tokens_in: number; tokens_out: number; catalogue_size: number } | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [saveResults, setSaveResults] = useState<{ created: number; failed: { name: string; error: string }[] } | null>(null)

  async function parse() {
    if (!text.trim() && !file) { setErr('Paste some menu text or attach a file first.'); return }
    setBusy(true); setErr(null)
    try {
      let r: Response
      if (file) {
        // Multipart upload — endpoint detects PDF / Word / image by
        // mime + extension and handles each accordingly server-side.
        const fd = new FormData()
        fd.append('business_id', bizId)
        fd.append('file', file)
        r = await fetch('/api/inventory/recipes/import-parse', {
          method: 'POST', cache: 'no-store', body: fd,
        })
      } else {
        r = await fetch('/api/inventory/recipes/import-parse', {
          method:  'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ business_id: bizId, menu_text: text }),
        })
      }
      const j = await r.json()
      if (!r.ok) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
      if (!Array.isArray(j.drafts) || j.drafts.length === 0) {
        throw new Error('AI returned no dishes — try rephrasing the input or attaching a clearer source.')
      }
      setDrafts(j.drafts)
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

    // Two-pass: sub-recipes first so their IDs exist when parent
    // dishes reference them. Within each pass, drafts are independent
    // so order doesn't matter.
    const subs    = drafts.filter(d => d.is_subrecipe)
    const parents = drafts.filter(d => !d.is_subrecipe)
    // name → id map. Lowercased trimmed keys to forgive case
    // mismatches between Sonnet's parent ref and sub name.
    const nameToId = new Map<string, string>()

    async function createOne(d: Draft): Promise<string | null> {
      try {
        // 1. Create recipe header.
        const r = await fetch('/api/inventory/recipes', {
          method:  'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            business_id:           bizId,
            name:                  d.name,
            type:                  d.type,                  // Sonnet-inferred dish type; null for sub-recipes
            menu_price_inc_vat:    d.selling_price_inc_vat ?? null,
            vat_rate:              12,            // owner edits in drawer; 12% safe default for dine-in
            channel:               'dine_in',
            portions:              d.portions,
            notes:                 d.note ? `AI DRAFT — ${d.note}` : 'AI DRAFT — review quantities before trusting cost.',
            method:                d.method ?? null,
            yield_amount:          d.yield_amount,
            yield_unit:            d.yield_unit,
          }),
        })
        const j = await r.json()
        if (!r.ok) {
          // 23505 name conflict — link to existing instead of failing the whole import.
          if (j.error && /already exists/i.test(j.error)) {
            // Best-effort lookup by name to get the existing id.
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

        // 2. Append ingredients. Resolve sub references via nameToId.
        for (let pos = 0; pos < d.ingredients.length; pos++) {
          const g = d.ingredients[pos]
          const payload: any = { quantity: g.quantity, unit: g.unit, position: pos }
          if (g.kind === 'product') {
            payload.product_id = g.product_id
          } else {
            // Sub-recipe reference. Resolve by lowercased trimmed name.
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

    // Phase 1 — create sub-recipes, populate the name map BEFORE any
    // parent tries to resolve a sub reference.
    for (const d of subs) {
      const id = await createOne(d)
      if (id) nameToId.set(d.name.trim().toLowerCase(), id)
    }
    // Phase 2 — create parent dishes, resolving sub references.
    for (const d of parents) await createOne(d)

    setSaveResults(results)
    setStage('done')
    setBusy(false)
  }

  // Only qty + unit are edit-targets in the preview UI; the discriminator
  // (kind/product_id/sub_name) is fixed at parse time. Narrowing patch to
  // { quantity?: number; unit?: string } keeps the union honest.
  function editIngredient(di: number, ii: number, patch: { quantity?: number; unit?: string }) {
    setDrafts(prev => {
      const next = prev.slice()
      const draft = { ...next[di] }
      draft.ingredients = draft.ingredients.slice()
      const existing = draft.ingredients[ii]
      // Preserve the existing union variant by re-applying it after spread.
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
  function removeDraft(di: number) {
    setDrafts(prev => prev.filter((_, i) => i !== di))
  }
  function editDraftName(di: number, name: string) {
    setDrafts(prev => prev.map((d, i) => i === di ? { ...d, name } : d))
  }
  function editDraftPrice(di: number, price: string) {
    const v = price === '' ? null : Number(price)
    setDrafts(prev => prev.map((d, i) => i === di ? { ...d, selling_price_inc_vat: v != null && Number.isFinite(v) && v > 0 ? v : null } : d))
  }

  return (
    <Backdrop onClose={onClose}>
      <div style={{ width: 'min(820px, 96vw)', maxHeight: '90vh', overflow: 'auto' as const, background: UXP.cardBg, borderRadius: 12, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: UXP.ink1 }}>Bulk import recipes from menu</div>
            <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2, maxWidth: 560 }}>
              Paste your menu text (one dish per line works well). Sonnet drafts each recipe using your existing catalogue. Review + edit before saving.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 18 }} aria-label="Close">×</button>
        </div>

        {stage === 'paste' && (
          <>
            {/* File upload — PDF / Word / image. Wins precedence over
                pasted text when both are set so owner doesn't have to
                clear the textarea after picking a file. */}
            <div style={{
              border: `1px dashed ${UXP.border}`, borderRadius: 6,
              padding: '12px 14px', marginBottom: 10,
              background: file ? UXP.lavFill : UXP.subtleBg,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, marginBottom: 6 }}>
                Attach a file (PDF, Word .docx, or image)
              </div>
              <input
                type="file"
                accept=".pdf,.docx,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={e => { setFile(e.target.files?.[0] ?? null); setErr(null) }}
                disabled={busy}
                style={{ fontSize: 11, fontFamily: 'inherit' }}
              />
              {file && (
                <div style={{ marginTop: 6, fontSize: 11, color: UXP.lavText }}>
                  {file.name} · {(file.size / 1024).toFixed(0)} KB
                  <button onClick={() => setFile(null)} disabled={busy}
                    style={{ marginLeft: 8, background: 'none', border: 'none', color: UXP.ink3, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, textDecoration: 'underline' }}>
                    clear
                  </button>
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
              rows={file ? 5 : 12}
              disabled={busy || !!file}
              style={{
                width: '100%', boxSizing: 'border-box', padding: 10,
                fontFamily: 'inherit', fontSize: 12, borderRadius: 6,
                border: `1px solid ${UXP.border}`, resize: 'vertical' as const,
                opacity: file ? 0.4 : 1,
              }}
            />
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 6 }}>
              {file ? `File attached — text input disabled.` : `${text.length}/8000 chars`} · Each parse uses one Sonnet call (~$0.10 per typical menu / ~$0.25 with vision) and counts toward your daily AI quota.
            </div>
            {err && <div style={{ marginTop: 8, fontSize: 11, color: UXP.roseText, background: UXP.roseFill, padding: '8px 10px', borderRadius: 6 }}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 8 }}>
              <button onClick={onClose} disabled={busy} style={secondaryBtn}>Cancel</button>
              <button onClick={parse} disabled={busy || (!text.trim() && !file)} style={primaryBtn}>
                {busy ? 'Drafting…' : 'Draft recipes'}
              </button>
            </div>
          </>
        )}

        {stage === 'preview' && (
          <>
            <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 10, padding: '8px 10px', background: UXP.subtleBg, borderRadius: 6 }}>
              Sonnet drafted <strong>{drafts.length}</strong> dish{drafts.length === 1 ? '' : 'es'} from <strong>{meta?.catalogue_size}</strong> products in your catalogue. Review + edit; quantities are AI estimates and should be confirmed by the chef. Anything you can't find here — set the yield and ingredients later from the recipe drawer.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
              {drafts.map((d, di) => (
                <div key={di} style={{
                  border:        `1px solid ${d.is_subrecipe ? UXP.lavMid : UXP.border}`,
                  borderRadius:  8,
                  padding:       '10px 12px',
                  background:    d.is_subrecipe ? UXP.subtleBg : 'transparent',
                }}>
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
                    {/* Sub-recipes don't sell directly — hide price field. */}
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
                        AI couldn't find matching products in your catalogue. Add ingredients manually from the recipe drawer after save.
                      </div>
                    )}
                    {d.ingredients.map((g, ii) => (
                      <div key={ii} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 50px 24px', gap: 6, alignItems: 'center' }}>
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
                        <button onClick={() => removeIngredient(di, ii)} aria-label="Remove ingredient" style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink4, fontSize: 14 }}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {err && <div style={{ marginTop: 8, fontSize: 11, color: UXP.roseText, background: UXP.roseFill, padding: '8px 10px', borderRadius: 6 }}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 8 }}>
              <button onClick={() => setStage('paste')} disabled={busy} style={secondaryBtn}>← Back to paste</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} disabled={busy} style={secondaryBtn}>Cancel</button>
                <button onClick={saveAll} disabled={busy || drafts.length === 0} style={primaryBtn}>
                  {busy ? 'Saving…' : `Create ${drafts.length} recipe${drafts.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
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
              <button onClick={onSaved} style={primaryBtn}>Done</button>
            </div>
          </>
        )}
      </div>
    </Backdrop>
  )
}

function CreateModal({ bizId, onClose, onCreated }: { bizId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('operations.inventory.recipes')
  const [name,      setName]      = useState('')
  const [type,      setType]      = useState('main')
  // Ex-VAT is the canonical truth (per resolveRecipePriceFields). Inc-VAT
  // is a convenience converter: typing here populates ex-VAT live, then
  // ex-VAT is what's sent on save. Ex-VAT field is primary (focus, larger).
  const [exVat,     setExVat]     = useState('')
  const [incVat,    setIncVat]    = useState('')
  const [vatRate,   setVatRate]   = useState<number>(12)
  const [channel,   setChannel]   = useState<'dine_in' | 'takeaway'>('dine_in')
  const [portions,  setPortions]  = useState('1')
  const [busy,      setBusy]      = useState(false)
  const [err,       setErr]       = useState<string | null>(null)

  // Inc-VAT → ex-VAT converter. Updates ex-VAT live when owner types in the
  // inc-VAT helper field. Never the reverse — ex-VAT remains the source.
  function onIncVatChange(raw: string) {
    setIncVat(raw)
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) {
      const ex = n / (1 + vatRate / 100)
      setExVat((Math.round(ex * 100) / 100).toString())
    }
  }
  // When VAT rate changes, re-derive ex-VAT from inc-VAT IF inc-VAT is set,
  // otherwise re-derive inc-VAT from ex-VAT. Either way the two stay in sync.
  function onVatRateChange(r: number) {
    setVatRate(r)
    const exN = Number(exVat)
    const incN = Number(incVat)
    if (Number.isFinite(incN) && incN > 0) {
      const ex = incN / (1 + r / 100)
      setExVat((Math.round(ex * 100) / 100).toString())
    } else if (Number.isFinite(exN) && exN > 0) {
      const inc = exN * (1 + r / 100)
      setIncVat((Math.round(inc * 100) / 100).toString())
    }
  }

  async function save() {
    if (!name.trim()) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/inventory/recipes', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id:          bizId,
          name:                 name.trim(),
          type,
          selling_price_ex_vat: exVat ? Number(exVat) : null,
          vat_rate:             vatRate,
          channel,
          portions:             portions ? Number(portions) : 1,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      onCreated(j.recipe.id)
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <Backdrop onClose={onClose}>
      <div style={modalCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: UXP.ink1, marginBottom: 14 }}>{t('newRecipe')}</div>
        <Field label={t('fieldName')}>
          <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus disabled={busy} style={inputStyle} />
        </Field>
        <Field label={t('fieldType')}>
          <select value={type} onChange={e => setType(e.target.value)} disabled={busy} style={inputStyle}>
            {RECIPE_TYPES.map(k => <option key={k} value={k}>{t(`type.${k}`)}</option>)}
          </select>
        </Field>
        {/* Price block — ex-VAT primary, inc-VAT as helper converter. */}
        <Field label="Selling price ex-VAT (kr) — primary">
          <input type="number" min="0" step="0.01" value={exVat}
            onChange={e => { setExVat(e.target.value); /* clear inc to avoid stale conflict; user can re-type or it's recomputed on rate change */
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n > 0) setIncVat((Math.round(n * (1 + vatRate / 100) * 100) / 100).toString())
              else setIncVat('')
            }}
            disabled={busy} style={inputStyle} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Field label="Or inc-VAT (kr)">
            <input type="number" min="0" step="0.01" value={incVat} onChange={e => onIncVatChange(e.target.value)} disabled={busy} style={inputStyle} />
          </Field>
          <Field label="VAT rate (%)">
            <select value={vatRate} onChange={e => onVatRateChange(Number(e.target.value))} disabled={busy} style={inputStyle}>
              {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
            </select>
          </Field>
          <Field label="Channel">
            <select value={channel} onChange={e => setChannel(e.target.value as 'dine_in' | 'takeaway')} disabled={busy} style={inputStyle}>
              <option value="dine_in">Dine-in</option>
              <option value="takeaway">Takeaway</option>
            </select>
          </Field>
        </div>
        <Field label={t('fieldPortions')}>
          <input type="number" min="1" step="1" value={portions} onChange={e => setPortions(e.target.value)} disabled={busy} style={inputStyle} />
        </Field>
        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4, lineHeight: 1.4 }}>
          Ex-VAT is what's stored — margin is computed off it. Inc-VAT updates it via the rate.
          VAT rate and channel are independent: takeaway can be 6% OR 12% OR 25% depending on the product.
        </div>
        {err && <div style={errBanner}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} disabled={busy} style={secondaryBtn}>{t('cancel')}</button>
          <button onClick={save} disabled={busy || !name.trim()} style={primaryBtn}>{busy ? t('saving') : t('create')}</button>
        </div>
      </div>
    </Backdrop>
  )
}

// ── Recipe detail drawer ──────────────────────────────────────────────
interface DetailIngredient {
  id: string; product_id: string | null; product_name: string | null; category: string | null;
  quantity: number; quantity_stated?: number; waste_pct?: number;
  unit: string | null; notes: string | null; position: number
  invoice_unit: string | null; unit_price: number | null; line_cost: number | null
  unit_mismatch: boolean; no_price: boolean
  latest_line_id: string | null; latest_currency: string | null
  subrecipe_id: string | null; subrecipe_name: string | null
  is_subrecipe: boolean; cycle: boolean
  pack_size: number | null; base_unit: string | null
  cost_per_base_unit: number | null; pack_auto_detected: boolean
}
interface DetailResponse {
  recipe: {
    id: string; name: string; type: string | null;
    menu_price: number | null;
    selling_price_ex_vat: number | null;
    vat_rate: number | null;
    channel: string | null;
    portions: number; notes: string | null; updated_at: string; source_product_id?: string | null
    // M111 — sub-recipe yield (weight/volume per portion). Both null
    // for legacy / portion-only recipes; both set for sub-recipes that
    // can be consumed by weight in other recipes.
    yield_amount?: number | null
    yield_unit?:   string | null
    // M114 — chef method / cooking instructions. Owner-editable in
    // the drawer; AI bulk importer auto-populates from Word docs.
    method?: string | null
  }
  summary: {
    food_cost: number; food_pct: number | null; gp_pct: number | null; gp_kr: number | null
    missing_prices: number; unit_mismatches: number
    ingredients: DetailIngredient[]
  }
}

function RecipeDrawer({ recipeId, bizId, onClose, onOpenSubrecipe, onBack, canGoBack }: {
  recipeId: string
  bizId: string
  onClose: () => void
  onOpenSubrecipe: (id: string) => void
  onBack: () => void
  canGoBack: boolean
}) {
  const t = useTranslations('operations.inventory.recipes')
  const [data,    setData]    = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)
  const [adding,  setAdding]  = useState(false)
  // Edit-Item modal target — clicking the new ⚙ button on an ingredient row
  // sets this to the product_id; the modal mounts at drawer scope so it
  // renders above the drawer backdrop.
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  // When the missing-prices / unit-mismatch banner is clicked, this gets
  // the offending ingredient id. IngredientRow with that id auto-expands
  // its inline edit panel + flashes a soft highlight so the owner sees
  // where to fix the cost. Clears 2s after first use.
  const [highlightIngId, setHighlightIngId] = useState<string | null>(null)
  useEffect(() => {
    if (!highlightIngId) return
    const tmr = setTimeout(() => setHighlightIngId(null), 3000)
    return () => clearTimeout(tmr)
  }, [highlightIngId])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/recipes/${recipeId}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [recipeId])
  useEffect(() => { load() }, [load])

  async function removeIngredient(ingId: string) {
    if (!confirm(t('removeIngredientConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}/ingredients/${ingId}`, { method: 'DELETE', cache: 'no-store' })
    if (r.ok) load()
    else alert((await r.json().catch(() => ({}))).error ?? 'failed')
  }

  async function updateIngredient(ingId: string, patch: { quantity?: number; unit?: string | null; waste_pct?: number }) {
    const r = await fetch(`/api/inventory/recipes/${recipeId}/ingredients/${ingId}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    if (r.ok) load()
  }

  // Patch recipe header (name + price/VAT/channel/portions). Used by the
  // inline price editor; saves and re-loads so margin re-computes off the
  // new ex_vat value immediately.
  async function patchRecipe(patch: Record<string, any>) {
    const r = await fetch(`/api/inventory/recipes/${recipeId}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { alert(j.error ?? `HTTP ${r.status}`); return }
    load()
  }

  async function deleteRecipe() {
    if (!confirm(t('deleteRecipeConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}`, { method: 'DELETE', cache: 'no-store' })
    if (r.ok) onClose()
  }

  async function promote() {
    if (!confirm(t('promoteConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}/promote`, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: data?.recipe.type === 'drink' || data?.recipe.type === 'cocktail' ? 'beverage' : 'food' }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { alert(j.error ?? `HTTP ${r.status}`); return }
    load()
  }

  async function unpromote() {
    if (!confirm(t('unpromoteConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}/promote`, { method: 'DELETE', cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { alert(j.error ?? `HTTP ${r.status}`); return }
    load()
  }

  return (
    <Backdrop onClose={onClose}>
      <div style={{ ...drawerCard, padding: 0, overflow: 'hidden' }}>
        {loading && <div style={{ padding: 30, color: UXP.ink3, fontSize: 13 }}>{t('loading')}</div>}
        {err && <div style={{ padding: 14, color: UXP.roseText, fontSize: 12 }}>{err}</div>}
        {data && (
          <>
            {/* Header */}
            <div style={{ padding: '16px 20px', borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {canGoBack && (
                    <button onClick={onBack}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: UXP.ink3, fontSize: 11, padding: 0, marginBottom: 4,
                        fontFamily: 'inherit',
                      }}>
                      ← {t('detail.back')}
                    </button>
                  )}
                  {/* Type is editable inline — bulk-import sets it to NULL
                      since the AI doesn't know the dish category, and
                      owners want to fix it later without re-opening the
                      whole recipe. PATCH supports type:null already, so
                      "—" sends null. */}
                  <select
                    value={data.recipe.type ?? ''}
                    onChange={e => patchRecipe({ type: e.target.value || null })}
                    style={{
                      fontSize:      10,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase' as const,
                      color:         UXP.ink4,
                      background:    'transparent',
                      border:        'none',
                      padding:       0,
                      cursor:        'pointer',
                      fontFamily:    'inherit',
                    }}
                  >
                    <option value="">—</option>
                    {RECIPE_TYPES.map(k => (
                      <option key={k} value={k}>{t(`type.${k}`)}</option>
                    ))}
                  </select>
                  <div style={{ fontSize: 18, fontWeight: 600, color: UXP.ink1, marginTop: 2 }}>{data.recipe.name}</div>
                </div>
                <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 18 }}>×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 14 }}>
                <DrawerStat label="GP %" value={data.summary.gp_pct != null ? `${data.summary.gp_pct.toFixed(1)} %` : '—'}
                            color={data.summary.gp_pct != null ? gpColor(data.summary.gp_pct) : undefined} />
                <DrawerStat label="GP kr" value={data.summary.gp_kr != null ? fmtKr(data.summary.gp_kr) : '—'}
                            color={data.summary.gp_pct != null ? gpColor(data.summary.gp_pct) : undefined} />
                <DrawerStat label={t('detail.foodCost')}  value={fmtKr(data.summary.food_cost)} />
                <DrawerStat label={t('detail.foodPct')}   value={data.summary.food_pct != null ? `${data.summary.food_pct.toFixed(1)} %` : '—'}
                            color={data.summary.food_pct != null ? foodPctColor(data.summary.food_pct) : undefined} />
              </div>
              {/* Inline price + VAT + channel editor — owner-set, independent
                  fields. ex-VAT is the primary stored truth; inc-VAT input
                  acts as a converter that derives ex-VAT via the owner-set
                  rate (NEVER inferred from channel). */}
              <PriceVatEditor recipe={data.recipe} onSave={patchRecipe} />
              <div style={{ marginTop: 4, fontSize: 10, color: UXP.ink4 }}>
                {data.recipe.portions} portion{data.recipe.portions === 1 ? '' : 's'}
              </div>
              {/* M111 — sub-recipe yield (weight/volume per portion).
                  Setting this lets the recipe be consumed by weight in
                  other recipes (e.g. "30 g of White Sauce"). Optional;
                  recipes without yield can still be consumed in portions.
                  Empty + empty = clears both (DB CHECK enforces).
                  Auto-fill suggestion is computed from the current
                  ingredient list — sum of grams ÷ portions. */}
              <YieldEditor
                recipe={data.recipe}
                suggestedYield={suggestYieldFromIngredients(data.summary.ingredients, data.recipe.portions)}
                onSave={patchRecipe}
              />
              {/* M114 — chef method / cooking instructions. Free-form
                  text editable inline. Saves on blur when the value
                  actually changed. Owner can paste long-form Word
                  document text here. */}
              <MethodEditor recipe={data.recipe} onSave={patchRecipe} />
              {(data.summary.missing_prices > 0 || data.summary.unit_mismatches > 0) && (() => {
                // Warning cards — one per issue type, each a discrete
                // clickable card with title + action affordance. Replaces
                // the prior clumped paragraph that was visually noisy.
                const missingList    = data.summary.ingredients.filter(i => i.no_price       && !i.is_subrecipe)
                const mismatchList   = data.summary.ingredients.filter(i => i.unit_mismatch  && !i.is_subrecipe)
                function jumpTo(ingId: string) {
                  const el = document.getElementById(`ing-row-${ingId}`)
                  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setHighlightIngId(ingId) }
                }
                return (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                    {missingList.length > 0 && (
                      <WarningCard
                        count={missingList.length}
                        title={`${missingList.length} ingredient${missingList.length === 1 ? '' : 's'} missing a supplier price`}
                        detail="Cost is understated until you set a price. Click below to jump to the first one."
                        names={missingList.map(i => i.product_name ?? '?')}
                        actionLabel="Jump & set price"
                        onJump={() => jumpTo(missingList[0].id)}
                      />
                    )}
                    {mismatchList.length > 0 && (
                      <WarningCard
                        count={mismatchList.length}
                        title={`${mismatchList.length} ingredient${mismatchList.length === 1 ? '' : 's'} can’t convert units`}
                        detail="Recipe unit (e.g. g) doesn’t match the supplier unit (e.g. KG) and the product has no pack info. Set pack size + base unit so the engine can convert."
                        names={mismatchList.map(i => `${i.product_name ?? '?'} (recipe ${i.unit ?? '?'} vs invoice ${i.invoice_unit ?? '?'})`)}
                        actionLabel="Jump & fix pack/base unit"
                        onJump={() => jumpTo(mismatchList[0].id)}
                      />
                    )}
                  </div>
                )
              })()}
            </div>

            {/* Ingredients */}
            <div style={{ padding: '14px 20px', flex: 1, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink3, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                  {t('detail.ingredients')} ({data.summary.ingredients.length})
                </div>
                <button onClick={() => setAdding(true)} style={smallBtn}>{t('addIngredient')}</button>
              </div>
              {data.summary.ingredients.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12 }}>
                  {t('detail.noIngredients')}
                </div>
              )}
              {/* Column header — makes "Waste %" explicit (owner kept asking
                  if that column was "5 grams or 5 percent"). Inner padding
                  on the right-aligned columns matches the input padding
                  in IngredientRow so headers sit directly above the numbers. */}
              {data.summary.ingredients.length > 0 && (
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 80px 60px 60px 90px 56px 28px', gap: 10,
                  padding: '4px 0', fontSize: 9, color: UXP.ink4,
                  letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600,
                  borderBottom: `0.5px solid ${UXP.border}`,
                }}>
                  <div>Ingredient</div>
                  <div style={{ textAlign: 'right' as const, paddingRight: 6 }}>Qty</div>
                  <div>Unit</div>
                  <div style={{ textAlign: 'right' as const, paddingRight: 6 }}>Waste %</div>
                  <div style={{ textAlign: 'right' as const }}>Line cost</div>
                  <div></div>
                  <div></div>
                </div>
              )}
              {data.summary.ingredients.map(ing => (
                <IngredientRow key={ing.id}
                  ing={ing}
                  highlighted={highlightIngId === ing.id}
                  onRemove={() => removeIngredient(ing.id)}
                  onChange={(patch) => updateIngredient(ing.id, patch)}
                  onProductEdit={load}
                  onOpenSubrecipe={onOpenSubrecipe}
                  onOpenEditModal={(pid) => setEditingProductId(pid)}
                />
              ))}
            </div>

            <div style={{ padding: '10px 20px', borderTop: `0.5px solid ${UXP.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <button onClick={deleteRecipe} style={dangerBtn}>{t('deleteRecipe')}</button>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {data.recipe.source_product_id ? (
                  <button onClick={unpromote} title={t('unpromoteHint')} style={{
                    padding: '6px 12px', fontSize: 11, fontWeight: 500,
                    background: UXP.greenFill, color: UXP.greenDeep,
                    border: `0.5px solid ${UXP.green}`, borderRadius: 5,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}>{t('promotedBadge')}</button>
                ) : (
                  <button onClick={promote} title={t('promoteHint')} style={{
                    padding: '6px 12px', fontSize: 11, fontWeight: 500,
                    background: 'transparent', color: UXP.ink2,
                    border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}>{t('promote')}</button>
                )}
                <button onClick={onClose} style={secondaryBtn}>{t('done')}</button>
              </div>
            </div>

            {adding && (
              <IngredientPicker bizId={bizId} recipeId={recipeId} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load() }} />
            )}
            {editingProductId && (
              <EditItemModal
                productId={editingProductId}
                onClose={() => setEditingProductId(null)}
                onSaved={() => { setEditingProductId(null); load() }}
              />
            )}
          </>
        )}
      </div>
    </Backdrop>
  )
}

// Compute a yield suggestion from the recipe's ingredients. The idea:
// the kitchen-yield of a sub-recipe is usually just the sum of what
// went in (in grams) divided by portions. Cooking reduction (sauces
// boiling down, stock concentrating) is the exception — and the owner
// catches that by overriding the suggested value.
//
// Convention:
//   - Sum each ingredient's quantity_stated (pre-waste — yield is the
//     finished weight from what actually goes in the pot).
//   - Convert to g where possible; treat ml as g (water density ≈ 1
//     close enough for cooking suggestions).
//   - Ingredients in 'st' or with unit_mismatch get skipped + counted
//     so the UI can disclose partial coverage.
//   - Sub-recipe ingredients that already have yield set contribute
//     their resolved gram weight; without yield they're skipped.
//   - Returns null when nothing summable exists or portions is 0.
function suggestYieldFromIngredients(
  ingredients: DetailIngredient[] | undefined,
  portions: number,
): { amount: number; unit: 'g'; summed: number; skipped: number } | null {
  if (!ingredients || ingredients.length === 0 || portions <= 0) return null
  let totalG = 0
  let summed = 0
  let skipped = 0
  for (const ing of ingredients) {
    if (ing.unit_mismatch || ing.cycle) { skipped++; continue }
    const q = Number(ing.quantity_stated ?? ing.quantity ?? 0)
    if (!Number.isFinite(q) || q <= 0) { skipped++; continue }
    const unit = ing.unit ?? ing.invoice_unit ?? ''
    // Try mass first; fall back to volume (cooking ≈ 1:1).
    const inG  = convertQuantity(q, unit, 'g')
    const inMl = inG == null ? convertQuantity(q, unit, 'ml') : null
    const contribution = inG ?? inMl
    if (contribution == null) { skipped++; continue }
    totalG += contribution
    summed++
  }
  if (summed === 0 || totalG <= 0) return null
  return {
    amount:  Math.round((totalG / portions) * 10) / 10,
    unit:    'g',
    summed,
    skipped,
  }
}

// M114 — inline editor for the recipe's free-form method / cooking
// instructions. Owner pastes long-form text (typical Word document
// converted by mammoth). Saves on blur when the value actually
// changed — no explicit Save button to avoid friction on long edits.
function MethodEditor({ recipe, onSave }: {
  recipe: DetailResponse['recipe']
  onSave: (patch: Record<string, any>) => Promise<void>
}) {
  const [val, setVal]   = useState(recipe.method ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setVal(recipe.method ?? '') }, [recipe.method])
  const dirty = (val ?? '') !== (recipe.method ?? '')
  async function commit() {
    if (!dirty) return
    setBusy(true)
    try { await onSave({ method: val.trim() || null }) } finally { setBusy(false) }
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600, marginBottom: 4 }}>
        Method / instructions
      </div>
      <textarea
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        disabled={busy}
        placeholder="Cooking method, preparation, plating notes…"
        rows={Math.max(3, Math.min(10, (val.match(/\n/g)?.length ?? 0) + 2))}
        style={{
          width:       '100%',
          boxSizing:   'border-box',
          padding:     '6px 8px',
          fontSize:    11,
          lineHeight:  1.5,
          border:      `1px solid ${UXP.border}`,
          borderRadius: 6,
          fontFamily:  'inherit',
          resize:      'vertical' as const,
          color:       UXP.ink2,
        }}
      />
      <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2 }}>
        {val.length} char{val.length === 1 ? '' : 's'}{dirty && !busy && ' · click out to save'}{busy && ' · saving…'}
      </div>
    </div>
  )
}

// Inline yield editor for sub-recipes (M111). Optional pair of fields:
// amount + unit. When BOTH are set, parent recipes can consume this
// recipe in any unit family-compatible with the yield_unit (g↔kg,
// ml↔l). When EITHER is cleared, both clear (DB CHECK enforces the
// pair invariant) — so the sub-recipe falls back to portion-only.
// Honest-incomplete: a half-set yield never saves.
//
// `suggestedYield` is computed from the recipe's ingredients by the
// parent (RecipeDrawer) and shown as a one-click apply chip when no
// yield is set. Reduction recipes (sauces boiling down) override
// manually.
function YieldEditor({ recipe, suggestedYield, onSave }: {
  recipe: DetailResponse['recipe']
  suggestedYield: { amount: number; unit: 'g'; summed: number; skipped: number } | null
  onSave: (patch: Record<string, any>) => Promise<void>
}) {
  const [amt,  setAmt]  = useState(recipe.yield_amount != null ? String(recipe.yield_amount) : '')
  const [unit, setUnit] = useState(recipe.yield_unit ?? '')
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState<string | null>(null)
  useEffect(() => { setAmt(recipe.yield_amount != null ? String(recipe.yield_amount) : '') }, [recipe.yield_amount])
  useEffect(() => { setUnit(recipe.yield_unit ?? '') }, [recipe.yield_unit])
  const dirty = (amt !== (recipe.yield_amount != null ? String(recipe.yield_amount) : ''))
             || (unit !== (recipe.yield_unit ?? ''))
  async function save() {
    setBusy(true); setErr(null)
    try {
      const trimmedAmt = amt.trim()
      if (trimmedAmt === '' && unit === '') {
        await onSave({ yield_amount: null, yield_unit: null })
        return
      }
      const n = Number(trimmedAmt)
      if (!Number.isFinite(n) || n <= 0) throw new Error('Yield amount must be > 0')
      if (!unit) throw new Error('Pick a yield unit')
      await onSave({ yield_amount: n, yield_unit: unit })
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  // Sub-recipe yield units intentionally exclude 'portion' — yield is
  // a description of weight/volume per portion, never portions.
  const yieldUnitOptions = UNIT_OPTIONS.filter(u => u !== 'portion')
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>
        Yield per portion (optional, for sub-recipes)
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="number" min="0" step="0.01" value={amt}
          onChange={e => setAmt(e.target.value)}
          placeholder="e.g. 250"
          disabled={busy}
          style={{ ...inputStyle, width: 90 }}
        />
        <select value={unit} onChange={e => setUnit(e.target.value)} disabled={busy} style={{ ...inputStyle, width: 80 }}>
          <option value="">—</option>
          {yieldUnitOptions.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <span style={{ fontSize: 10, color: UXP.ink4 }}>per portion</span>
        {dirty && (
          <button onClick={save} disabled={busy} style={{ ...primaryBtn, padding: '4px 10px', fontSize: 11 }}>
            {busy ? '…' : 'Save'}
          </button>
        )}
      </div>
      {/* Auto-fill suggestion. Shows when there's a summable ingredient
          list AND either the field is empty or the saved value differs
          from the suggestion by >5% (the override is meaningful). */}
      {(() => {
        if (!suggestedYield) return null
        const savedAmt = Number(amt)
        const isEmpty = amt === '' && unit === ''
        const driftPct = savedAmt > 0
          ? Math.abs(savedAmt - suggestedYield.amount) / suggestedYield.amount
          : null
        const showDrift = driftPct != null && driftPct > 0.05 && unit === suggestedYield.unit
        if (!isEmpty && !showDrift) return null
        const label = isEmpty
          ? `Auto-fill: ${suggestedYield.amount} ${suggestedYield.unit} / portion`
          : `Ingredients sum to ${suggestedYield.amount} ${suggestedYield.unit} — your yield differs by ${((driftPct as number) * 100).toFixed(0)}% (cooking reduction?)`
        return (
          <button
            type="button"
            onClick={() => { setAmt(String(suggestedYield.amount)); setUnit(suggestedYield.unit) }}
            disabled={busy}
            style={{
              alignSelf:    'flex-start' as const,
              fontSize:     10,
              padding:      '3px 9px',
              border:       `0.5px solid ${UXP.lav}`,
              background:   UXP.lavFill,
              color:        UXP.lavText,
              borderRadius: 999,
              cursor:       'pointer',
              fontFamily:   'inherit',
            }}
            title={`Computed from ${suggestedYield.summed} ingredient${suggestedYield.summed === 1 ? '' : 's'}${suggestedYield.skipped > 0 ? ` (${suggestedYield.skipped} skipped — wrong unit or no data)` : ''}.`}
          >
            {label}
          </button>
        )
      })()}
      {err && <div style={{ fontSize: 10, color: UXP.coral }}>{err}</div>}
      <div style={{ fontSize: 9, color: UXP.ink4, lineHeight: 1.4 }}>
        Lets this recipe be consumed by weight/volume in other recipes (e.g. 30 g of sauce). Leave blank for portion-only. Owner overrides the auto-fill when there's cooking reduction (e.g. a sauce that boils down).
      </div>
    </div>
  )
}

// Inline price + VAT + channel editor for the recipe header. Ex-VAT is the
// canonical truth; inc-VAT input is a converter. VAT rate + channel are
// independent (no cross-inference). Saves via the patchRecipe callback,
// which round-trips through resolveRecipePriceFields so menu_price and
// selling_price_ex_vat can't drift.
function PriceVatEditor({ recipe, onSave }: {
  recipe: DetailResponse['recipe']
  onSave: (patch: Record<string, any>) => Promise<void>
}) {
  // Use the stored ex-VAT if present; for legacy rows (ex-VAT null,
  // menu_price set), display the legacy menu_price as ex-VAT placeholder
  // and let the owner re-state it explicitly on first edit (don't auto-
  // infer the rate — that's the VAT-misrouting trap).
  const [exVat,   setExVat]   = useState(recipe.selling_price_ex_vat != null ? String(recipe.selling_price_ex_vat) : '')
  const [vatRate, setVatRate] = useState<number>(recipe.vat_rate != null ? Number(recipe.vat_rate) : 12)
  const [channel, setChannel] = useState<'dine_in' | 'takeaway'>(recipe.channel === 'takeaway' ? 'takeaway' : 'dine_in')
  const [busy,    setBusy]    = useState(false)

  // Re-sync local state when the recipe prop changes (after a save reload).
  useEffect(() => {
    setExVat(recipe.selling_price_ex_vat != null ? String(recipe.selling_price_ex_vat) : '')
    setVatRate(recipe.vat_rate != null ? Number(recipe.vat_rate) : 12)
    setChannel(recipe.channel === 'takeaway' ? 'takeaway' : 'dine_in')
  }, [recipe.selling_price_ex_vat, recipe.vat_rate, recipe.channel])

  // Derived inc-VAT for display (read-only here; CreateModal has the
  // bidirectional input. Drawer keeps it simple: ex-VAT is the input,
  // inc-VAT is the derived display so the owner can sanity-check what
  // the menu would say).
  const exVatNum = Number(exVat)
  const incVatDisplay = Number.isFinite(exVatNum) && exVatNum > 0
    ? fmtKr(Math.round(exVatNum * (1 + vatRate / 100) * 100) / 100)
    : '—'

  async function commit() {
    if (busy) return
    const exN = Number(exVat)
    const patch: Record<string, any> = {
      selling_price_ex_vat: exVat === '' ? null : (Number.isFinite(exN) && exN >= 0 ? exN : null),
      vat_rate:             vatRate,
      channel,
    }
    setBusy(true)
    try { await onSave(patch) } finally { setBusy(false) }
  }

  return (
    <div style={{
      marginTop: 12, padding: '8px 10px', background: UXP.subtleBg,
      border: `0.5px solid ${UXP.border}`, borderRadius: 6,
      display: 'grid', gridTemplateColumns: '1fr 80px 90px auto', gap: 8, alignItems: 'end',
    }}>
      <div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginBottom: 2, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>Selling price ex-VAT (primary)</div>
        <input type="number" min="0" step="0.01" value={exVat}
          onChange={e => setExVat(e.target.value)}
          onBlur={commit}
          disabled={busy}
          style={{ ...inputStyle, padding: '4px 8px', fontSize: 13 }} />
        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
          inc-VAT @ {vatRate}%: {incVatDisplay}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginBottom: 2, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>VAT %</div>
        <select value={vatRate} onChange={e => setVatRate(Number(e.target.value))} onBlur={commit} disabled={busy}
          style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}>
          {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
        </select>
      </div>
      <div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginBottom: 2, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>Channel</div>
        <select value={channel} onChange={e => setChannel(e.target.value as 'dine_in' | 'takeaway')} onBlur={commit} disabled={busy}
          style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}>
          <option value="dine_in">Dine-in</option>
          <option value="takeaway">Takeaway</option>
        </select>
      </div>
      <button onClick={commit} disabled={busy} style={{
        padding: '5px 10px', fontSize: 11, fontWeight: 500,
        background: UXP.lavMid, color: '#fff', border: 'none', borderRadius: 5,
        cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
      }}>{busy ? '…' : 'Save'}</button>
    </div>
  )
}

function IngredientRow({ ing, highlighted, onRemove, onChange, onProductEdit, onOpenSubrecipe, onOpenEditModal }: {
  ing: DetailIngredient
  highlighted?: boolean
  onRemove: () => void
  onChange: (patch: { quantity?: number; unit?: string; waste_pct?: number }) => void
  onProductEdit: () => void
  onOpenSubrecipe: (id: string) => void
  onOpenEditModal?: (productId: string) => void
}) {
  const t = useTranslations('operations.inventory.recipes')
  const [qty, setQty] = useState(String(ing.quantity_stated ?? ing.quantity))
  const [waste, setWaste] = useState(String(ing.waste_pct ?? 0))
  const [expanded, setExpanded] = useState(false)
  const [busy,   setBusy]   = useState(false)
  const [err,    setErr]    = useState<string | null>(null)
  useEffect(() => { setQty(String(ing.quantity_stated ?? ing.quantity)) }, [ing.quantity, ing.quantity_stated])
  useEffect(() => { setWaste(String(ing.waste_pct ?? 0)) }, [ing.waste_pct])
  // When the parent banner click flagged this row, auto-expand the inline
  // edit panel (pack/base/price) so the owner lands on the fix UI.
  useEffect(() => { if (highlighted && !ing.is_subrecipe) setExpanded(true) }, [highlighted, ing.is_subrecipe])

  async function patchProduct(patch: Record<string, any>) {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/items/${ing.product_id}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      onProductEdit()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function patchLatestLine(patch: Record<string, any>) {
    if (!ing.latest_line_id) { setErr(t('detail.noPriceLineErr')); return }
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/lines/${ing.latest_line_id}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      onProductEdit()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const displayName = ing.is_subrecipe ? (ing.subrecipe_name ?? '?') : (ing.product_name ?? '?')

  return (
    <div id={`ing-row-${ing.id}`}
      style={{
        borderBottom: `0.5px solid ${UXP.borderSoft}`, padding: '8px 0',
        background: highlighted ? UXP.lavFill : 'transparent',
        transition: 'background 400ms ease',
        borderRadius: highlighted ? 4 : 0,
      }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 80px 60px 60px 90px 56px 28px', gap: 10,
        alignItems: 'center', fontSize: 12,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: UXP.ink1, fontWeight: 500, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', gap: 6 }}>
            {ing.is_subrecipe && (
              <span style={{
                fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                padding: '1px 6px', background: UXP.lavFill, color: UXP.lavText,
                borderRadius: 3, textTransform: 'uppercase' as const,
              }}>{t('detail.subrecipeBadge')}</span>
            )}
            <span>{displayName}</span>
          </div>
          <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>
            {ing.cycle
              ? <span style={{ color: UXP.coral, fontWeight: 500 }}>{t('detail.cycleLabel')}</span>
              : ing.is_subrecipe
                ? (ing.unit_price != null
                    ? `${fmtKr(ing.unit_price)}/portion`
                    : t('detail.noPrice'))
                : (ing.unit_price != null
                    ? (ing.cost_per_base_unit != null && ing.base_unit
                        // Show per-base-unit when pack conversion is in play
                        ? `${ing.cost_per_base_unit.toFixed(4)} ${ing.latest_currency && ing.latest_currency !== 'SEK' ? ing.latest_currency : 'kr'}/${ing.base_unit} (pack ${ing.pack_size}${ing.base_unit}${ing.pack_auto_detected ? ' · auto' : ''})`
                        : `${ing.latest_currency && ing.latest_currency !== 'SEK' ? `${ing.unit_price.toFixed(2)} ${ing.latest_currency}` : fmtKr(ing.unit_price)}/${ing.invoice_unit ?? '?'}`)
                    : t('detail.noPrice'))}
            {!ing.is_subrecipe && ing.unit_mismatch && (
              <span style={{ marginLeft: 6, color: UXP.coral, fontWeight: 500 }}>
                {t('detail.unitMismatchLabel', { recipe: ing.unit ?? '?', product: ing.invoice_unit ?? '?' })}
              </span>
            )}
            {!ing.is_subrecipe && ing.pack_auto_detected && !ing.unit_mismatch && (
              <span style={{ marginLeft: 6, color: UXP.lavText, fontWeight: 500 }}
                    title="Pack size parsed from product name. Save it on the catalogue page to make it persistent.">
                · pack auto-detected
              </span>
            )}
          </div>
        </div>
        <input type="number" min="0" step="0.01" value={qty}
          onChange={e => setQty(e.target.value)}
          onBlur={() => { const v = Number(qty); const cur = ing.quantity_stated ?? ing.quantity; if (Number.isFinite(v) && v > 0 && v !== cur) onChange({ quantity: v }) }}
          style={{ ...inputStyle, padding: '3px 6px', fontSize: 11, textAlign: 'right' as const }}
        />
        {/* Unit is editable per-line. Picking the wrong unit silently bloats
            the line cost (e.g. "30 st" of a 580g pack scales by 580; "30 g"
            doesn't). Owner needs to fix this without deleting + re-adding the
            ingredient.
            For sub-recipes: editable only when the sub-recipe has a yield set
            (engine passes yield_unit through as ing.base_unit). Without a
            yield the sub-recipe can only be consumed in 'portion' — show
            plain text + a hint to set the yield. */}
        {ing.is_subrecipe && !ing.base_unit ? (
          <div
            style={{ color: UXP.ink3, fontSize: 11 }}
            title="This sub-recipe has no yield set (e.g. '250 g per portion'). Open it and set a yield to consume it by weight/volume in other recipes."
          >
            portion
          </div>
        ) : (() => {
          const current = ing.unit ?? ing.invoice_unit ?? (ing.is_subrecipe ? (ing.base_unit ?? 'portion') : 'g')
          const inList  = (UNIT_OPTIONS as readonly string[]).includes(current)
          return (
            <select
              value={current}
              onChange={e => { const v = e.target.value; if (v && v !== current) onChange({ unit: v }) }}
              title={ing.is_subrecipe
                ? `Sub-recipe yield is ${ing.pack_size} ${ing.base_unit} per portion — consume in any unit family-compatible with ${ing.base_unit}, or in portions directly.`
                : "Recipe unit. Must match what the engine can convert from the product's pack/base unit — mismatches show in the cost row above."}
              style={{ ...inputStyle, padding: '3px 4px', fontSize: 11 }}
            >
              {!inList && <option value={current}>{current}</option>}
              {ing.is_subrecipe && <option value="portion">portion</option>}
              {UNIT_OPTIONS.filter(u => u !== 'portion' || !ing.is_subrecipe).map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          )
        })()}
        {/* Waste % per line — yield-loss inflation applied in loadRecipeIndex
            so engine math stays pure (per recipe-authoring-tool-prompt review).
            Default 0 = no-op. Bounded 0..<100 (CHECK + clamp). Muted display
            when 0, bold lavender when set so the owner sees which lines have
            an applied yield. */}
        <input type="number" min="0" max="95" step="1" value={waste}
          onChange={e => setWaste(e.target.value)}
          onBlur={() => { const v = Number(waste); const cur = ing.waste_pct ?? 0; if (Number.isFinite(v) && v >= 0 && v < 100 && v !== cur) onChange({ waste_pct: v }) }}
          title="Waste % — kitchen yield loss. The cost-quantity is inflated by 1/(1−waste). 0 = no-op."
          style={{ ...inputStyle, padding: '3px 6px', fontSize: 11, textAlign: 'right' as const,
            color: Number(waste) > 0 ? UXP.lavText : UXP.ink4,
            fontWeight: Number(waste) > 0 ? 600 : 400,
          }}
        />
        <div style={{ textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: ing.no_price ? UXP.ink4 : UXP.ink1, fontWeight: 500 }}>
          {ing.line_cost != null ? fmtKr(ing.line_cost) : '—'}
        </div>
        {ing.is_subrecipe ? (
          // Sub-recipe row: "Open" jumps into the sub-recipe's own drawer
          // with a back-stack so closing returns here.
          <button onClick={() => ing.subrecipe_id && onOpenSubrecipe(ing.subrecipe_id)}
            aria-label={t('detail.openSubrecipe')}
            title={t('detail.openSubrecipeHint')}
            style={{
              background: 'transparent', border: 'none', color: UXP.lavDeep,
              cursor: 'pointer', padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
            }}>→</button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {/* Full edit modal — opens the shared EditItemModal at drawer scope.
                Quick inline pack/base/price edit (✎) below stays as-is. */}
            {onOpenEditModal && ing.product_id && (
              <button onClick={() => onOpenEditModal(ing.product_id!)}
                aria-label="Edit item (full)" title="Edit item — cost, articles, used-in-recipes"
                style={{
                  background: 'transparent', border: 'none', color: UXP.lavText,
                  cursor: 'pointer', padding: '2px 4px', fontSize: 11, fontFamily: 'inherit',
                }}>⚙</button>
            )}
            <button onClick={() => setExpanded(v => !v)} aria-label={t('detail.editProduct')}
              title={t('detail.editProductHint')}
              style={{
                background: 'transparent', border: 'none', color: expanded ? UXP.lavDeep : UXP.ink4,
                cursor: 'pointer', padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
              }}>{expanded ? '▾' : '✎'}</button>
          </div>
        )}
        <button onClick={onRemove} aria-label="Remove" style={{
          background: 'transparent', border: 'none', color: UXP.ink4, cursor: 'pointer',
          padding: '2px 6px', fontSize: 14,
        }}>×</button>
      </div>

      {expanded && (
        <div style={{
          marginTop: 8, padding: 10,
          background: UXP.subtleBg, borderRadius: 6,
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8,
        }}>
          <Field label={t('detail.editName')}>
            <input type="text" defaultValue={ing.product_name ?? ''} disabled={busy}
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== ing.product_name) patchProduct({ name: v }) }}
              style={{ ...inputStyle, padding: '3px 6px', fontSize: 11 }} />
          </Field>
          <Field label={t('detail.editInvoiceUnit')}>
            <input type="text" defaultValue={ing.invoice_unit ?? ''} disabled={busy}
              onBlur={e => { const v = e.target.value.trim(); if (v !== (ing.invoice_unit ?? '')) patchProduct({ invoice_unit: v || null }) }}
              style={{ ...inputStyle, padding: '3px 6px', fontSize: 11 }} />
          </Field>
          <Field label="Pack size">
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="number" min="0" step="0.01" defaultValue={ing.pack_size ?? ''} disabled={busy}
                onBlur={e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== ing.pack_size) patchProduct({ pack_size: v }) }}
                style={{ ...inputStyle, padding: '3px 6px', fontSize: 11, flex: 1 }} placeholder="1000" />
              <select defaultValue={ing.base_unit ?? ''} disabled={busy}
                onChange={e => { if (e.target.value !== (ing.base_unit ?? '')) patchProduct({ base_unit: e.target.value || null }) }}
                style={{ ...inputStyle, padding: '3px 4px', fontSize: 11, width: 56 }}>
                <option value="">—</option>
                <option value="g">g</option>
                <option value="ml">ml</option>
                <option value="st">st</option>
              </select>
            </div>
          </Field>
          <Field label={t('detail.editPrice')}>
            <input type="number" min="0" step="0.01" defaultValue={ing.unit_price ?? ''} disabled={busy || !ing.latest_line_id}
              onBlur={e => {
                const v = e.target.value === '' ? null : Number(e.target.value)
                if (v !== ing.unit_price) patchLatestLine({ price_per_unit: v })
              }}
              style={{ ...inputStyle, padding: '3px 6px', fontSize: 11, textAlign: 'right' as const }} />
          </Field>
          <Field label={t('detail.editCurrency')}>
            <select defaultValue={ing.latest_currency ?? 'SEK'} disabled={busy || !ing.latest_line_id}
              onChange={e => { if (e.target.value !== ing.latest_currency) patchLatestLine({ currency: e.target.value }) }}
              style={{ ...inputStyle, padding: '3px 6px', fontSize: 11 }}>
              {['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          {err && <div style={{ ...errBanner, gridColumn: '1 / -1' }}>{err}</div>}
          {!ing.latest_line_id && (
            <div style={{ gridColumn: '1 / -1', fontSize: 10, color: UXP.ink4, fontStyle: 'italic' as const }}>
              {t('detail.noPriceToEdit')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Ingredient picker (modal-in-drawer) ────────────────────────────────
function IngredientPicker({ bizId, recipeId, onClose, onAdded }: { bizId: string; recipeId: string; onClose: () => void; onAdded: () => void }) {
  const t = useTranslations('operations.inventory.recipes')
  const [tab,       setTab]       = useState<'product' | 'recipe'>('product')
  const [q,         setQ]         = useState('')
  const [results,   setResults]   = useState<any[]>([])
  const [picked,    setPicked]    = useState<any | null>(null)
  const [qty,       setQty]       = useState('')
  const [unit,      setUnit]      = useState('')
  const [busy,      setBusy]      = useState(false)
  const [err,       setErr]       = useState<string | null>(null)
  // Inline product creation when the catalogue doesn't have the ingredient
  // yet (recipe written before the first purchase, or supplier hasn't been
  // matched). Three fields: name (from search query by default), category,
  // optional pack/base for the cost engine. POSTs to /api/inventory/items,
  // then immediately picks the new product so the owner can set qty/unit
  // without a context switch.
  const [creatingProduct, setCreatingProduct] = useState(false)
  const [newName, setNewName]                 = useState('')
  const [newCategory, setNewCategory]         = useState<typeof PRODUCT_CATEGORIES[number]>('food')
  const [newPackSize, setNewPackSize]         = useState('')
  const [newBaseUnit, setNewBaseUnit]         = useState<'g' | 'ml' | 'st' | ''>('')
  const [newInvoiceUnit, setNewInvoiceUnit]   = useState('')

  async function createProduct() {
    const nm = newName.trim()
    if (!nm) { setErr('Product name required.'); return }
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/inventory/items', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id:  bizId,
          name:         nm,
          category:     newCategory,
          unit:         newInvoiceUnit || null,
          base_unit:    newBaseUnit || null,
          pack_size:    newPackSize ? Number(newPackSize) : null,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      // Slot into the picker as if it had been picked from search results.
      setPicked({
        product_id:   j.product_id,
        name:         nm,
        category:     newCategory,
        invoice_unit: newInvoiceUnit || null,
        latest_price: null,
      })
      setUnit(newBaseUnit || newInvoiceUnit || 'g')
      setCreatingProduct(false)
      // Reset for next time.
      setNewName(''); setNewPackSize(''); setNewBaseUnit(''); setNewInvoiceUnit('')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  // Debounced search — switches endpoint based on the active tab.
  useEffect(() => {
    const timer = setTimeout(async () => {
      const path = tab === 'product'
        ? `/api/inventory/products/search?business_id=${encodeURIComponent(bizId)}&q=${encodeURIComponent(q)}`
        : `/api/inventory/recipes/search?business_id=${encodeURIComponent(bizId)}&q=${encodeURIComponent(q)}&exclude_recipe_id=${encodeURIComponent(recipeId)}`
      const r = await fetch(path, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setResults(tab === 'product' ? (j.products ?? []) : (j.recipes ?? []))
    }, 200)
    return () => clearTimeout(timer)
  }, [q, bizId, recipeId, tab])

  function switchTab(next: 'product' | 'recipe') {
    setTab(next); setQ(''); setResults([]); setPicked(null); setErr(null); setUnit(''); setQty('')
  }

  async function add() {
    if (!picked || !qty) return
    const qn = Number(qty)
    if (!Number.isFinite(qn) || qn <= 0) { setErr(t('picker.qtyInvalid')); return }
    setBusy(true); setErr(null)
    try {
      const payload: any = { quantity: qn }
      if (tab === 'product') {
        payload.product_id = picked.product_id
        payload.unit       = unit || picked.invoice_unit
      } else {
        payload.subrecipe_id = picked.recipe_id
        payload.unit         = 'portion'
      }
      const r = await fetch(`/api/inventory/recipes/${recipeId}/ingredients`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      onAdded()
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <Backdrop onClose={onClose}>
      <div style={{ ...modalCard, width: 'min(520px, 100%)' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: UXP.ink1, marginBottom: 10 }}>{t('picker.title')}</div>
        {!picked && (
          <>
            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: 0, marginBottom: 10, borderBottom: `0.5px solid ${UXP.border}` }}>
              <TabBtn active={tab === 'product'} onClick={() => switchTab('product')}>{t('picker.tabProduct')}</TabBtn>
              <TabBtn active={tab === 'recipe'}  onClick={() => switchTab('recipe')}>{t('picker.tabRecipe')}</TabBtn>
            </div>
            <input type="text" value={q} onChange={e => setQ(e.target.value)} autoFocus
                   placeholder={tab === 'product' ? t('picker.search') : t('picker.searchRecipes')} style={inputStyle} />
            <div style={{ maxHeight: 280, overflowY: 'auto' as const, marginTop: 8, border: `0.5px solid ${UXP.border}`, borderRadius: 6 }}>
              {results.length === 0 && !creatingProduct && (
                <div style={{ padding: 14, color: UXP.ink4, fontSize: 12, textAlign: 'center' as const }}>
                  {tab === 'product' ? t('picker.noResults') : t('picker.noRecipeResults')}
                  {tab === 'product' && q.trim() && (
                    <div style={{ marginTop: 10 }}>
                      <button onClick={() => { setNewName(q.trim()); setCreatingProduct(true); setErr(null) }}
                        style={{
                          padding: '5px 12px', fontSize: 11, fontWeight: 600,
                          background: UXP.lavMid, color: '#fff', border: 'none',
                          borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                        }}>
                        + Create new product "{q.trim()}"
                      </button>
                    </div>
                  )}
                </div>
              )}
              {creatingProduct && (
                <div style={{ padding: 14, fontSize: 11 }}>
                  <div style={{ fontWeight: 600, color: UXP.ink1, marginBottom: 8 }}>New product</div>
                  <Field label="Name">
                    <input type="text" value={newName} onChange={e => setNewName(e.target.value)} autoFocus disabled={busy} style={inputStyle} />
                  </Field>
                  <Field label="Category">
                    <select value={newCategory} onChange={e => setNewCategory(e.target.value as any)} disabled={busy} style={inputStyle}>
                      {PRODUCT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <Field label="Pack size">
                      <input type="number" min="0" step="0.01" value={newPackSize} onChange={e => setNewPackSize(e.target.value)}
                        placeholder="e.g. 2550" disabled={busy} style={inputStyle} />
                    </Field>
                    <Field label="Base unit">
                      <select value={newBaseUnit} onChange={e => setNewBaseUnit(e.target.value as any)} disabled={busy} style={inputStyle}>
                        <option value="">—</option>
                        <option value="g">g</option>
                        <option value="ml">ml</option>
                        <option value="st">st</option>
                      </select>
                    </Field>
                    <Field label="Invoice unit">
                      <input type="text" value={newInvoiceUnit} onChange={e => setNewInvoiceUnit(e.target.value)}
                        placeholder="STRYCK / KG …" disabled={busy} style={inputStyle} />
                    </Field>
                  </div>
                  <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, lineHeight: 1.4 }}>
                    Pack + base unit lets the cost engine convert recipe grams → supplier kg automatically.
                    E.g. a 2550 g tomato can: pack=2550, base=g, invoice=STRYCK. Skip if no price yet — you can set later.
                  </div>
                  {err && <div style={{ ...errBanner, marginTop: 6 }}>{err}</div>}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                    <button onClick={() => { setCreatingProduct(false); setErr(null) }} disabled={busy} style={secondaryBtn}>Cancel</button>
                    <button onClick={createProduct} disabled={busy || !newName.trim()} style={primaryBtn}>{busy ? 'Saving…' : 'Create product'}</button>
                  </div>
                </div>
              )}
              {results.map((p: any) => (
                <button key={p.product_id ?? p.recipe_id}
                        onClick={() => {
                          if (tab === 'product') {
                            setPicked(p)
                            // Default to base_unit when pack info exists (the
                            // unit the kitchen actually measures in); fall
                            // back to invoice_unit (the supplier unit, e.g.
                            // KG). Always lowercased for the dropdown match.
                            const def = p.base_unit ?? p.invoice_unit ?? ''
                            setUnit(String(def).toLowerCase())
                          }
                          else if (!p.would_cycle) {
                            setPicked(p)
                            // M111 — default to the sub-recipe's yield unit
                            // when set; lets the owner type a gram amount
                            // immediately without flipping the dropdown.
                            // Falls back to 'portion' for legacy sub-recipes.
                            setUnit(p.yield_unit ?? 'portion')
                          }
                        }}
                        disabled={tab === 'recipe' && p.would_cycle}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left' as const,
                          padding: '8px 10px', background: 'transparent', border: 'none',
                          borderBottom: `0.5px solid ${UXP.borderSoft}`,
                          cursor: (tab === 'recipe' && p.would_cycle) ? 'not-allowed' : 'pointer',
                          fontFamily: 'inherit',
                          opacity: (tab === 'recipe' && p.would_cycle) ? 0.5 : 1,
                        }}
                        onMouseEnter={e => { if (!(tab === 'recipe' && p.would_cycle)) e.currentTarget.style.background = UXP.subtleBg }}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1 }}>
                    {p.name}
                    {tab === 'recipe' && p.would_cycle && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: UXP.coral, fontWeight: 500 }}>
                        {t('picker.wouldCycle')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>
                    {tab === 'product'
                      ? <>{p.category ?? '?'} · {p.latest_price != null ? `${fmtKr(p.latest_price)}/${p.invoice_unit ?? '?'}` : t('picker.noPrice')}{p.supplier && <> · {p.supplier}</>}</>
                      : <>{p.type ?? '—'} · {p.portions} portions · {p.cost_per_portion != null ? `${fmtKr(p.cost_per_portion)}/portion` : '—'}</>
                    }
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        {picked && (
          <>
            <div style={{ padding: 10, background: UXP.subtleBg, borderRadius: 6, fontSize: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 500, color: UXP.ink1 }}>{picked.name}</div>
              <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
                {tab === 'product'
                  ? (picked.latest_price != null ? `${fmtKr(picked.latest_price)}/${picked.invoice_unit ?? '?'}` : t('picker.noPrice'))
                  : `${picked.portions} portions · ${picked.cost_per_portion != null ? `${fmtKr(picked.cost_per_portion)}/portion` : '—'}`}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label={t('picker.qty')}>
                <input type="number" min="0" step="0.01" value={qty} autoFocus onChange={e => setQty(e.target.value)} disabled={busy} style={inputStyle} />
              </Field>
              <Field label={t('picker.unit')}>
                {/* M111 — sub-recipes can be consumed by weight/volume when
                    they have a yield set. If yield is null we fall back to
                    portion-only (current legacy behaviour). */}
                <select
                  value={unit}
                  onChange={e => setUnit(e.target.value)}
                  disabled={busy || (tab === 'recipe' && !picked?.yield_unit)}
                  style={inputStyle}
                >
                  {tab === 'recipe' && (
                    <>
                      <option value="portion">portion</option>
                      {picked?.yield_unit && UNIT_OPTIONS
                        .filter(u => u !== 'portion')
                        .map(u => <option key={u} value={u}>{u}</option>)}
                    </>
                  )}
                  {tab === 'product' && UNIT_OPTIONS.map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4 }}>
              {tab === 'product' ? (
                picked.base_unit && picked.pack_size
                  // Product has pack/base info — recommend entering in the
                  // base unit (g/ml/st). Cost converts automatically.
                  ? <>Enter in <strong>{picked.base_unit}</strong> — pack is {picked.pack_size}{picked.base_unit} per {picked.invoice_unit ?? '?'}. Cost auto-converts.</>
                  // No pack data — owner must enter in the invoice unit OR
                  // edit the product to add pack/base info first.
                  : <>No pack info set for this product. Enter in <strong>{picked.invoice_unit ?? '?'}</strong> or edit the product's pack/base unit first so g↔kg conversion works.</>
              ) : picked.yield_unit && picked.yield_amount ? (
                <>This sub-recipe yields <strong>{picked.yield_amount} {picked.yield_unit}</strong> per portion. Enter the amount you actually use — cost auto-converts via the yield.</>
              ) : (
                <>Quantity is in <strong>portions</strong> of the sub-recipe. To consume it by weight/volume in this recipe, set the sub-recipe's yield (e.g. "1 portion = 250 g") on its own page.</>
              )}
            </div>
            {err && <div style={errBanner}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
              <button onClick={() => setPicked(null)} disabled={busy} style={secondaryBtn}>{t('picker.back')}</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} disabled={busy} style={secondaryBtn}>{t('cancel')}</button>
                <button onClick={add} disabled={busy || !qty} style={primaryBtn}>{busy ? t('saving') : t('picker.add')}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </Backdrop>
  )
}

// Discrete warning card — title row + a few names + a single jump action.
// Designed so the owner can scan multiple warnings at a glance without
// them collapsing into one wall of text.
function WarningCard({ count, title, detail, names, actionLabel, onJump }: {
  count: number
  title: string
  detail: string
  names: string[]
  actionLabel: string
  onJump: () => void
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column' as const, gap: 6,
      padding: '10px 12px', background: '#fef3e0',
      border: `0.5px solid ${UXP.coral}`, borderRadius: 6,
      fontSize: 11, color: UXP.ink1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: UXP.coral, marginBottom: 2 }}>
            {title}
          </div>
          <div style={{ color: UXP.ink2, lineHeight: 1.4 }}>{detail}</div>
          {names.length > 0 && (
            <ul style={{ margin: '6px 0 0', padding: '0 0 0 18px', color: UXP.ink2, fontSize: 10, lineHeight: 1.5 }}>
              {names.slice(0, 3).map((n, i) => <li key={i}>{n}</li>)}
              {names.length > 3 && <li style={{ color: UXP.ink4 }}>… and {names.length - 3} more</li>}
            </ul>
          )}
        </div>
        <button onClick={onJump} style={{
          flexShrink: 0, padding: '6px 12px', fontSize: 11, fontWeight: 600,
          background: UXP.coral, color: '#fff', border: 'none', borderRadius: 5,
          cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
        }}>{actionLabel} →</button>
      </div>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '6px 14px', fontSize: 12, fontWeight: 500,
      background: 'transparent', color: active ? UXP.ink1 : UXP.ink3,
      border: 'none',
      borderBottom: active ? `2px solid ${UXP.lavDeep}` : '2px solid transparent',
      cursor: 'pointer', fontFamily: 'inherit',
    }}>{children}</button>
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
function DrawerStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: color ?? UXP.ink1, marginTop: 3, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
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
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  )
}
function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div role="dialog" onClick={onClose}
         style={{
           position: 'fixed' as const, inset: 0, background: 'rgba(20,18,40,0.35)',
           display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', zIndex: 100,
         }}>
      <div onClick={e => e.stopPropagation()} style={{ height: '100%', display: 'flex', alignItems: 'stretch' }}>
        {children}
      </div>
    </div>
  )
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit',
  border: `0.5px solid ${UXP.border}`, borderRadius: 5, color: UXP.ink1, background: '#fff',
}
const primaryBtn: React.CSSProperties = {
  padding: '6px 14px', fontSize: 12, fontWeight: 600,
  background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
const secondaryBtn: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 500,
  background: 'transparent', color: UXP.ink3, border: `0.5px solid ${UXP.border}`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
const dangerBtn: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 500,
  background: 'transparent', color: UXP.roseText, border: `0.5px solid ${UXP.rose}`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
const smallBtn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, fontWeight: 500,
  background: UXP.lavFill, color: UXP.lavText, border: `0.5px solid ${UXP.lavMid}`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
}
const modalCard: React.CSSProperties = {
  width: 'min(460px, 100%)', height: '100%', background: UXP.cardBg,
  borderLeft: `0.5px solid ${UXP.border}`, padding: '20px 24px', overflowY: 'auto' as const,
  boxShadow: '-8px 0 24px rgba(58,53,80,0.10)',
}
const drawerCard: React.CSSProperties = {
  width: 'min(560px, 100%)', height: '100%', background: UXP.cardBg,
  borderLeft: `0.5px solid ${UXP.border}`, display: 'flex', flexDirection: 'column' as const,
  boxShadow: '-8px 0 24px rgba(58,53,80,0.10)',
}
const errBanner: React.CSSProperties = {
  marginTop: 8, padding: '6px 10px',
  background: UXP.roseFill, color: UXP.roseText, fontSize: 11, borderRadius: 5,
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
