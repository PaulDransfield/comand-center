'use client'
// components/RecipeEditor.tsx
//
// Full-page recipe editor. Re-houses the prior right-side drawer logic
// into a sectioned page with Items always-expanded and secondary
// sections collapsed.
//
// Single source for BOTH create and edit:
//   - Edit mode  → mounted at /inventory/recipes/[id]   (recipeId set)
//   - Create mode → mounted at /inventory/recipes/new   (recipeId = null)
//
// ALL data-flow logic is unchanged from the old RecipeDrawer:
//   - GET    /api/inventory/recipes/[id]          — load detail
//   - PATCH  /api/inventory/recipes/[id]          — header patch
//   - POST   /api/inventory/recipes               — create
//   - DELETE /api/inventory/recipes/[id]          — delete
//   - POST/DELETE /api/inventory/recipes/[id]/promote
//   - POST/PATCH/DELETE /api/inventory/recipes/[id]/ingredients[/:ingId]
//   - PATCH  /api/inventory/items/[productId]
//   - PATCH  /api/inventory/lines/[lineId]
//   - GET    /api/inventory/products/search
//   - GET    /api/inventory/recipes/search
//   - POST   /api/inventory/items
//
// Honest-incomplete, frozen-vs-live, M111 yield resolution, sub-recipe
// cycle guard, EditItemModal launch — all preserved verbatim from the
// drawer they came from.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { UXP } from '@/lib/constants/tokens'
import { Modal, overlayBtn } from '@/components/ui/Overlay'
import { EditItemModal } from '@/components/EditItemModal'
import { fmtKr } from '@/lib/format'
import { convertQuantity } from '@/lib/inventory/unit-conversion'

// ── Types — mirror the GET /api/inventory/recipes/[id] response ──────
interface DetailIngredient {
  id: string; product_id: string | null; product_name: string | null; category: string | null
  quantity: number; quantity_stated?: number; waste_pct?: number
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
    id: string; name: string; type: string | null
    menu_price: number | null
    selling_price_ex_vat: number | null
    vat_rate: number | null
    channel: string | null
    portions: number; notes: string | null; updated_at: string; source_product_id?: string | null
    yield_amount?: number | null
    yield_unit?:   string | null
    method?: string | null
  }
  summary: {
    food_cost: number; food_pct: number | null; gp_pct: number | null; gp_kr: number | null
    missing_prices: number; unit_mismatches: number
    ingredients: DetailIngredient[]
  }
}

const RECIPE_TYPES   = ['starter','main','pasta','pizza','dessert','drink','cocktail','side','sauce','other']
const VAT_RATES      = [6, 12, 25] as const
const UNIT_OPTIONS   = ['g','kg','ml','l','st','styck','msk','tsk','krm','knippe','klyfta','skiva','bunt','pkt','burk','flaska','portion'] as const
const PRODUCT_CATEGORIES = ['food','beverage','alcohol','disposables','takeaway_material','cleaning','other'] as const

const DISH_TYPES = new Set(['starter','main','pasta','pizza','dessert','drink','cocktail','side'])
const SUB_TYPES  = new Set(['sauce'])

// ── Component ─────────────────────────────────────────────────────────
export function RecipeEditor({ recipeId, bizId }: { recipeId: string | null; bizId: string }) {
  const router = useRouter()
  const t = useTranslations('operations.inventory.recipes')

  // ── Edit-mode state ─────────────────────────────────────────────────
  const [data,    setData]    = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(!!recipeId)
  const [err,     setErr]     = useState<string | null>(null)
  const [adding,  setAdding]  = useState(false)
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  const [highlightIngId, setHighlightIngId] = useState<string | null>(null)
  useEffect(() => {
    if (!highlightIngId) return
    const tmr = setTimeout(() => setHighlightIngId(null), 3000)
    return () => clearTimeout(tmr)
  }, [highlightIngId])

  // ── Section open-state ─────────────────────────────────────────────
  // Items section is ALWAYS expanded (the heart of the editor). Others
  // collapse / persist their state in localStorage so owners don't fight
  // it on every reload.
  const [openGeneral, setOpenGeneral] = useSectionState('general', false)
  const [openPrice,   setOpenPrice]   = useSectionState('price',   false)
  const [openMethod,  setOpenMethod]  = useSectionState('method',  false)
  const [openYield,   setOpenYield]   = useSectionState('yield',   false)
  const [openSales,   setOpenSales]   = useSectionState('sales',   false)
  const [openBreakdown, setOpenBreakdown] = useSectionState('breakdown', false)

  // ── Load detail (edit mode) ─────────────────────────────────────────
  const load = useCallback(async () => {
    if (!recipeId) { setLoading(false); return }
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/inventory/recipes/${recipeId}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [recipeId])
  useEffect(() => { if (recipeId) load() }, [recipeId, load])

  // ── Supplier-article thumbnails ─────────────────────────────────────
  // Batch-fetch image URLs for every product-linked ingredient. Cross-
  // customer cached images from supplier_articles. Silent fallback for
  // products without scraped data.
  const [imageByProduct, setImageByProduct] = useState<Record<string, { image_url: string; brand: string | null }>>({})
  useEffect(() => {
    if (!data) return
    const productIds = data.summary.ingredients
      .filter(i => !i.is_subrecipe && i.product_id)
      .map(i => i.product_id!) as string[]
    if (productIds.length === 0) { setImageByProduct({}); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/inventory/supplier-article/batch', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: productIds }),
        })
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        setImageByProduct(j.by_product ?? {})
      } catch { setImageByProduct({}) }
    })()
    return () => { cancelled = true }
  }, [data])

  // ── Mutators (edit mode) ────────────────────────────────────────────
  async function removeIngredient(ingId: string) {
    if (!recipeId) return
    if (!confirm(t('removeIngredientConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}/ingredients/${ingId}`, { method: 'DELETE', cache: 'no-store' })
    if (r.ok) load()
    else alert((await r.json().catch(() => ({}))).error ?? 'failed')
  }
  async function updateIngredient(ingId: string, patch: { quantity?: number; unit?: string | null; waste_pct?: number }) {
    if (!recipeId) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}/ingredients/${ingId}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    if (r.ok) load()
  }
  async function patchRecipe(patch: Record<string, any>) {
    if (!recipeId) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { alert(j.error ?? `HTTP ${r.status}`); return }
    load()
  }
  async function deleteRecipe() {
    if (!recipeId) return
    if (!confirm(t('deleteRecipeConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}`, { method: 'DELETE', cache: 'no-store' })
    if (r.ok) router.push('/inventory/recipes')
  }
  async function promote() {
    if (!recipeId) return
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
    if (!recipeId) return
    if (!confirm(t('unpromoteConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}/promote`, { method: 'DELETE', cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { alert(j.error ?? `HTTP ${r.status}`); return }
    load()
  }

  // ── Create mode ─────────────────────────────────────────────────────
  // Pre-focused on name. Empty defaults match the prior CreateModal.
  const [newName,     setNewName]     = useState('')
  const [newType,     setNewType]     = useState<string>('main')
  const [newExVat,    setNewExVat]    = useState('')
  const [newIncVat,   setNewIncVat]   = useState('')
  const [newVatRate,  setNewVatRate]  = useState<number>(12)
  const [newChannel,  setNewChannel]  = useState<'dine_in' | 'takeaway'>('dine_in')
  const [newPortions, setNewPortions] = useState('1')
  const [creating,    setCreating]    = useState(false)
  const [createErr,   setCreateErr]   = useState<string | null>(null)
  // Inc-VAT ↔ ex-VAT converter; ex-VAT is the stored truth.
  function onNewIncVatChange(raw: string) {
    setNewIncVat(raw)
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) {
      const ex = n / (1 + newVatRate / 100)
      setNewExVat((Math.round(ex * 100) / 100).toString())
    }
  }
  function onNewExVatChange(raw: string) {
    setNewExVat(raw)
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) setNewIncVat((Math.round(n * (1 + newVatRate / 100) * 100) / 100).toString())
    else setNewIncVat('')
  }
  function onNewVatRateChange(r: number) {
    setNewVatRate(r)
    const exN = Number(newExVat)
    const incN = Number(newIncVat)
    if (Number.isFinite(incN) && incN > 0) {
      const ex = incN / (1 + r / 100)
      setNewExVat((Math.round(ex * 100) / 100).toString())
    } else if (Number.isFinite(exN) && exN > 0) {
      const inc = exN * (1 + r / 100)
      setNewIncVat((Math.round(inc * 100) / 100).toString())
    }
  }
  async function saveNewRecipe() {
    if (!newName.trim()) { setCreateErr('Name required.'); return }
    setCreating(true); setCreateErr(null)
    try {
      const r = await fetch('/api/inventory/recipes', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id:          bizId,
          name:                 newName.trim(),
          type:                 newType,
          selling_price_ex_vat: newExVat ? Number(newExVat) : null,
          vat_rate:             newVatRate,
          channel:              newChannel,
          portions:             newPortions ? Number(newPortions) : 1,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      // Round-trip to the edit URL so the page now mounts in edit mode.
      router.replace(`/inventory/recipes/${j.recipe.id}`)
    } catch (e: any) { setCreateErr(e.message); setCreating(false) }
  }

  // ── Create-mode render ─────────────────────────────────────────────
  if (!recipeId) {
    return (
      <div style={pageWrap}>
        <BackLink router={router} />
        <h1 style={pageH1}>New recipe</h1>
        <p style={pageSub}>
          Set the name + price now to save the recipe; ingredients go in on the next screen.
          VAT rate and channel are independent — dine-in can be 12% OR 25% depending on the product.
        </p>
        <div style={{ ...sectionCard, marginTop: 18 }}>
          <SectionHeading title="Recipe header" subtitle="Required to create" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 14 }}>
            <Field label="Name">
              <input type="text" value={newName} autoFocus onChange={e => setNewName(e.target.value)} disabled={creating} style={inputStyle} />
            </Field>
            <Field label="Type">
              <select value={newType} onChange={e => setNewType(e.target.value)} disabled={creating} style={inputStyle}>
                {RECIPE_TYPES.map(k => <option key={k} value={k}>{t(`type.${k}`)}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14 }}>
            <Field label="Selling price ex-VAT (primary)">
              <input type="number" min="0" step="0.01" value={newExVat} onChange={e => onNewExVatChange(e.target.value)} disabled={creating} style={inputStyle} />
            </Field>
            <Field label="Or inc-VAT">
              <input type="number" min="0" step="0.01" value={newIncVat} onChange={e => onNewIncVatChange(e.target.value)} disabled={creating} style={inputStyle} />
            </Field>
            <Field label="VAT %">
              <select value={newVatRate} onChange={e => onNewVatRateChange(Number(e.target.value))} disabled={creating} style={inputStyle}>
                {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
              </select>
            </Field>
            <Field label="Channel">
              <select value={newChannel} onChange={e => setNewChannel(e.target.value as any)} disabled={creating} style={inputStyle}>
                <option value="dine_in">Dine-in</option>
                <option value="takeaway">Takeaway</option>
              </select>
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 14 }}>
            <Field label="Portions">
              <input type="number" min="1" step="1" value={newPortions} onChange={e => setNewPortions(e.target.value)} disabled={creating} style={inputStyle} />
            </Field>
          </div>
          {createErr && <div style={errBanner}>{createErr}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button onClick={() => router.push('/inventory/recipes')} disabled={creating} style={overlayBtn.secondary}>Cancel</button>
            <button onClick={saveNewRecipe} disabled={creating || !newName.trim()} style={overlayBtn.primary}>
              {creating ? 'Saving…' : 'Save & add ingredients →'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Edit-mode render ────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={pageWrap}>
        <BackLink router={router} />
        <div style={{ padding: 30, color: UXP.ink3, fontSize: 13 }}>{t('loading')}</div>
      </div>
    )
  }
  if (err) {
    return (
      <div style={pageWrap}>
        <BackLink router={router} />
        <div style={errBanner}>{err}</div>
      </div>
    )
  }
  if (!data) return null

  const { recipe, summary } = data
  const isIncomplete = summary.missing_prices > 0 || summary.unit_mismatches > 0
  const isSubRecipe = !(
    (recipe.selling_price_ex_vat != null && Number(recipe.selling_price_ex_vat) > 0) ||
    (recipe.menu_price != null && Number(recipe.menu_price) > 0) ||
    (recipe.type && DISH_TYPES.has(String(recipe.type).toLowerCase()))
  ) || (recipe.type != null && SUB_TYPES.has(String(recipe.type).toLowerCase()))

  function jumpTo(ingId: string) {
    const el = document.getElementById(`ing-row-${ingId}`)
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setHighlightIngId(ingId) }
  }

  const missingList  = summary.ingredients.filter(i => i.no_price && !i.is_subrecipe)
  const mismatchList = summary.ingredients.filter(i => i.unit_mismatch && !i.is_subrecipe)
  const suggested    = suggestYieldFromIngredients(summary.ingredients, recipe.portions)

  return (
    <div style={pageWrap}>
      <BackLink router={router} />

      {/* ── HEADER ──────────────────────────────────────────────────── */}
      <div style={headerCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <select
              value={recipe.type ?? ''}
              onChange={e => patchRecipe({ type: e.target.value || null })}
              style={typeChip}
              aria-label="Recipe type"
            >
              <option value="">—</option>
              {RECIPE_TYPES.map(k => <option key={k} value={k}>{t(`type.${k}`)}</option>)}
            </select>
            <InlineEditName name={recipe.name} onSave={(v) => patchRecipe({ name: v })} />
            <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 4 }}>
              {recipe.portions} portion{recipe.portions === 1 ? '' : 's'}
              {recipe.yield_amount && recipe.yield_unit && (
                <> · yields <strong>{recipe.yield_amount} {recipe.yield_unit}</strong> per portion</>
              )}
              {isSubRecipe && <> · sub-recipe</>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {recipe.source_product_id ? (
              <button onClick={unpromote} title={t('unpromoteHint')} style={promoteBadge}>{t('promotedBadge')}</button>
            ) : (
              <button onClick={promote} title={t('promoteHint')} style={promoteBtn}>{t('promote')}</button>
            )}
            <button onClick={deleteRecipe} style={overlayBtn.danger}>{t('deleteRecipe')}</button>
          </div>
        </div>

        {/* Live cost summary — always visible, never hidden behind an
            accordion. Incomplete-cost badge replaces the GP numbers
            when warnings fire (honest-incomplete rule). */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginTop: 16, padding: '14px 16px', background: UXP.subtleBg, borderRadius: 8 }}>
          <HeroStat label="Food cost"  value={fmtKr(summary.food_cost)} />
          <HeroStat label="Food %"     value={summary.food_pct != null ? `${summary.food_pct.toFixed(1)} %` : '—'}
                    color={summary.food_pct != null ? foodPctColor(summary.food_pct) : undefined} />
          <HeroStat label="GP %"
                    value={isIncomplete ? '—' : (summary.gp_pct != null ? `${summary.gp_pct.toFixed(1)} %` : '—')}
                    color={!isIncomplete && summary.gp_pct != null ? gpColor(summary.gp_pct) : undefined} />
          <HeroStat label="GP kr"      value={isIncomplete ? '—' : (summary.gp_kr != null ? fmtKr(summary.gp_kr) : '—')}
                    color={!isIncomplete && summary.gp_pct != null ? gpColor(summary.gp_pct) : undefined} />
          <HeroStat label="Menu price" value={recipe.menu_price != null ? fmtKr(recipe.menu_price) : '—'} />
        </div>

        {isIncomplete && (
          <div style={{ marginTop: 10 }}>
            <span style={incompleteBadge} title="One or more ingredients has no price or can't convert units. The GP number is hidden until the cost is grounded.">
              Incomplete cost — {summary.missing_prices + summary.unit_mismatches} ingredient{(summary.missing_prices + summary.unit_mismatches) === 1 ? '' : 's'} need attention
            </span>
          </div>
        )}

        {/* Warning cards — one per issue type. Jump-to-row from header. */}
        {(missingList.length > 0 || mismatchList.length > 0) && (
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
                title={`${mismatchList.length} ingredient${mismatchList.length === 1 ? '' : 's'} can't convert units`}
                detail="Recipe unit (e.g. g) doesn't match the supplier unit (e.g. KG) and the product has no pack info. Set pack size + base unit so the engine can convert."
                names={mismatchList.map(i => `${i.product_name ?? '?'} (recipe ${i.unit ?? '?'} vs invoice ${i.invoice_unit ?? '?'})`)}
                actionLabel="Jump & fix pack/base unit"
                onJump={() => jumpTo(mismatchList[0].id)}
              />
            )}
          </div>
        )}
      </div>

      {/* ── ITEMS — ALWAYS EXPANDED ─────────────────────────────────── */}
      <div style={sectionCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <SectionHeading
            title="Items & sub-recipes"
            subtitle={`${summary.ingredients.length} ingredient${summary.ingredients.length === 1 ? '' : 's'} · live cost recomputes on every edit`}
            inline
          />
          <button onClick={() => setAdding(true)} style={addRowBtn}>+ Add ingredient or sub-recipe</button>
        </div>

        {summary.ingredients.length === 0 && (
          <div style={{ padding: 30, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12, background: UXP.subtleBg, borderRadius: 8 }}>
            No ingredients yet. Click <strong>+ Add ingredient or sub-recipe</strong> to start.
          </div>
        )}

        {summary.ingredients.length > 0 && (
          <>
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
            {summary.ingredients.map(ing => (
              <IngredientRow key={ing.id}
                ing={ing}
                imageUrl={!ing.is_subrecipe && ing.product_id ? imageByProduct[ing.product_id]?.image_url : undefined}
                highlighted={highlightIngId === ing.id}
                onRemove={() => removeIngredient(ing.id)}
                onChange={(patch) => updateIngredient(ing.id, patch)}
                onProductEdit={load}
                onOpenSubrecipe={(id) => router.push(`/inventory/recipes/${id}`)}
                onOpenEditModal={(pid) => setEditingProductId(pid)}
              />
            ))}
          </>
        )}
      </div>

      {/* ── COLLAPSIBLE — General info ──────────────────────────────── */}
      <Collapsible
        open={openGeneral}
        onToggle={() => setOpenGeneral(v => !v)}
        title="General info"
        subtitle="Name, type, portions, notes"
      >
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="Name">
            <input type="text" defaultValue={recipe.name}
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== recipe.name) patchRecipe({ name: v }) }}
              style={inputStyle} />
          </Field>
          <Field label="Type">
            <select value={recipe.type ?? ''} onChange={e => patchRecipe({ type: e.target.value || null })} style={inputStyle}>
              <option value="">—</option>
              {RECIPE_TYPES.map(k => <option key={k} value={k}>{t(`type.${k}`)}</option>)}
            </select>
          </Field>
          <Field label="Portions">
            <input type="number" min="1" step="1" defaultValue={recipe.portions}
              onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0 && v !== recipe.portions) patchRecipe({ portions: v }) }}
              style={inputStyle} />
          </Field>
        </div>
        <Field label="Notes (free-form — not used in cost math)">
          <textarea defaultValue={recipe.notes ?? ''} rows={3} maxLength={2000}
            onBlur={e => { const v = e.target.value.trim(); if (v !== (recipe.notes ?? '')) patchRecipe({ notes: v || null }) }}
            style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' as const, padding: '8px 10px' }} />
        </Field>
      </Collapsible>

      {/* ── COLLAPSIBLE — Selling price & VAT ───────────────────────── */}
      <Collapsible
        open={openPrice}
        onToggle={() => setOpenPrice(v => !v)}
        title="Selling price & VAT"
        subtitle={recipe.selling_price_ex_vat != null
          ? `${fmtKr(recipe.selling_price_ex_vat)} ex-VAT @ ${recipe.vat_rate ?? 12}% · ${recipe.channel ?? 'dine_in'}`
          : 'Not set'}
      >
        <PriceVatEditor recipe={recipe} onSave={patchRecipe} />
        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 8, lineHeight: 1.5 }}>
          Ex-VAT is what's stored — margin is computed off it. Inc-VAT updates it via the rate.
          VAT rate and channel are <strong>independent</strong>: takeaway can be 6% OR 12% OR 25% depending on the product.
        </div>
      </Collapsible>

      {/* ── COLLAPSIBLE — Method / instructions ─────────────────────── */}
      <Collapsible
        open={openMethod}
        onToggle={() => setOpenMethod(v => !v)}
        title="Method / instructions"
        subtitle={recipe.method && recipe.method.trim()
          ? (recipe.method.trim().slice(0, 80) + (recipe.method.trim().length > 80 ? '…' : ''))
          : 'Not set'}
      >
        <MethodEditor recipe={recipe} onSave={patchRecipe} />
      </Collapsible>

      {/* ── COLLAPSIBLE — Yield (sub-recipe only) ───────────────────── */}
      <Collapsible
        open={openYield}
        onToggle={() => setOpenYield(v => !v)}
        title="Yield per portion"
        subtitle={recipe.yield_amount && recipe.yield_unit
          ? `${recipe.yield_amount} ${recipe.yield_unit} per portion`
          : 'Optional — set so other recipes can consume this by weight/volume'}
      >
        <YieldEditor recipe={recipe} suggestedYield={suggested} onSave={patchRecipe} />
      </Collapsible>

      {/* ── COLLAPSIBLE — Cost breakdown ────────────────────────────── */}
      <Collapsible
        open={openBreakdown}
        onToggle={() => setOpenBreakdown(v => !v)}
        title="Recipe cost breakdown"
        subtitle={`${fmtKr(summary.food_cost)} food cost · ${summary.food_pct != null ? `${summary.food_pct.toFixed(1)}% food` : '—'} · ${isIncomplete ? 'Incomplete' : (summary.gp_pct != null ? `${summary.gp_pct.toFixed(1)}% GP` : '—')}`}
      >
        <CostBreakdown summary={summary} recipe={recipe} />
      </Collapsible>

      {/* ── COLLAPSIBLE — Connected sales articles ──────────────────── */}
      <Collapsible
        open={openSales}
        onToggle={() => setOpenSales(v => !v)}
        title="Connected sales articles"
        subtitle={recipe.source_product_id
          ? 'Promoted to a sellable catalogue article'
          : 'Not promoted — owner can promote so this recipe is sellable as a single article'}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {recipe.source_product_id ? (
            <>
              <span style={{ fontSize: 12, color: UXP.greenDeep }}>
                ✓ Promoted as a catalogue article — POS can sell this recipe directly.
              </span>
              <button onClick={unpromote} style={overlayBtn.secondary}>Unpromote</button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12, color: UXP.ink3 }}>
                This recipe isn't sellable as a single article. Promote so POS can map a dish to it.
              </span>
              <button onClick={promote} style={overlayBtn.primary}>Promote</button>
            </>
          )}
        </div>
      </Collapsible>

      {/* ── Modals at page scope ────────────────────────────────────── */}
      {adding && (
        <IngredientPicker
          bizId={bizId}
          recipeId={recipe.id}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); load() }}
        />
      )}
      {editingProductId && (
        <EditItemModal
          productId={editingProductId}
          onClose={() => setEditingProductId(null)}
          onSaved={() => { setEditingProductId(null); load() }}
        />
      )}
    </div>
  )
}

// ── BackLink ──────────────────────────────────────────────────────────
function BackLink({ router }: { router: ReturnType<typeof useRouter> }) {
  return (
    <button onClick={() => router.push('/inventory/recipes')} style={{
      background: 'transparent', border: 'none', cursor: 'pointer',
      color: UXP.ink3, fontSize: 12, padding: 0, marginBottom: 10,
      fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      ← Back to recipes
    </button>
  )
}

// ── InlineEditName ────────────────────────────────────────────────────
function InlineEditName({ name, onSave }: { name: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [val,     setVal]     = useState(name)
  useEffect(() => setVal(name), [name])
  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { if (val.trim() && val.trim() !== name) onSave(val.trim()); setEditing(false) }}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') { setVal(name); setEditing(false) }
        }}
        style={{
          fontSize: 22, fontWeight: 600, color: UXP.ink1,
          border: `1px solid ${UXP.lavMid}`, borderRadius: 4,
          padding: '4px 8px', fontFamily: 'inherit', width: '100%',
        }}
      />
    )
  }
  return (
    <div
      onClick={() => setEditing(true)}
      title="Click to rename"
      style={{ fontSize: 22, fontWeight: 600, color: UXP.ink1, marginTop: 2, cursor: 'text', padding: '2px 0' }}
    >
      {name}
    </div>
  )
}

// ── Collapsible ────────────────────────────────────────────────────────
function Collapsible({ open, onToggle, title, subtitle, children }: {
  open: boolean
  onToggle: () => void
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div style={sectionCard}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          fontFamily: 'inherit', textAlign: 'left' as const,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, marginBottom: 2 }}>{title}</div>
          <div style={{ fontSize: 11, color: UXP.ink3 }}>{subtitle}</div>
        </div>
        <div style={{
          fontSize: 11, padding: '4px 10px',
          background: open ? UXP.lavFill : UXP.subtleBg,
          color: open ? UXP.lavText : UXP.ink4,
          borderRadius: 4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const,
        }}>
          {open ? '▾ Open' : '▸ Open'}
        </div>
      </button>
      {open && (
        <div style={{ marginTop: 16 }}>
          {children}
        </div>
      )}
    </div>
  )
}

// ── Section helpers ───────────────────────────────────────────────────
function SectionHeading({ title, subtitle, inline }: { title: string; subtitle?: string; inline?: boolean }) {
  return (
    <div style={{ marginBottom: inline ? 0 : 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, marginBottom: 2 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: UXP.ink3 }}>{subtitle}</div>}
    </div>
  )
}

function HeroStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: color ?? UXP.ink1, marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}

// ── CostBreakdown ─────────────────────────────────────────────────────
function CostBreakdown({ summary, recipe }: { summary: DetailResponse['summary']; recipe: DetailResponse['recipe'] }) {
  // Per-ingredient cost table (read-only — for inspection). Sorted by
  // line cost desc so the owner sees the biggest contributors first.
  const rows = [...summary.ingredients].sort((a, b) => (b.line_cost ?? 0) - (a.line_cost ?? 0))
  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 }}>
        <thead>
          <tr style={{ background: UXP.subtleBg }}>
            <th style={breakdownTh}>Ingredient</th>
            <th style={{ ...breakdownTh, textAlign: 'right' as const }}>Qty</th>
            <th style={{ ...breakdownTh, textAlign: 'right' as const }}>Unit cost</th>
            <th style={{ ...breakdownTh, textAlign: 'right' as const }}>Line cost</th>
            <th style={{ ...breakdownTh, textAlign: 'right' as const }}>% of food cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(ing => {
            const pct = (ing.line_cost != null && summary.food_cost > 0)
              ? (ing.line_cost / summary.food_cost) * 100
              : null
            const name = ing.is_subrecipe ? ing.subrecipe_name : ing.product_name
            return (
              <tr key={ing.id} style={{ borderTop: `0.5px solid ${UXP.borderSoft}` }}>
                <td style={breakdownTd}>
                  {ing.is_subrecipe && (
                    <span style={{
                      fontSize: 9, fontWeight: 600, padding: '1px 5px', marginRight: 6,
                      background: UXP.lavFill, color: UXP.lavText, borderRadius: 3,
                      textTransform: 'uppercase' as const,
                    }}>sub</span>
                  )}
                  {name ?? '?'}
                </td>
                <td style={{ ...breakdownTd, textAlign: 'right' as const }}>{ing.quantity_stated ?? ing.quantity} {ing.unit ?? ''}</td>
                <td style={{ ...breakdownTd, textAlign: 'right' as const, color: UXP.ink3 }}>
                  {ing.unit_price != null
                    ? `${fmtKr(ing.unit_price)}/${ing.is_subrecipe ? 'portion' : (ing.invoice_unit ?? '?')}`
                    : '—'}
                </td>
                <td style={{ ...breakdownTd, textAlign: 'right' as const, fontWeight: 500 }}>
                  {ing.line_cost != null ? fmtKr(ing.line_cost) : '—'}
                </td>
                <td style={{ ...breakdownTd, textAlign: 'right' as const, color: UXP.ink3 }}>
                  {pct != null ? `${pct.toFixed(1)}%` : '—'}
                </td>
              </tr>
            )
          })}
          <tr style={{ borderTop: `1px solid ${UXP.border}`, background: UXP.subtleBg, fontWeight: 600 }}>
            <td style={breakdownTd}>Total food cost</td>
            <td style={breakdownTd}></td>
            <td style={breakdownTd}></td>
            <td style={{ ...breakdownTd, textAlign: 'right' as const }}>{fmtKr(summary.food_cost)}</td>
            <td style={{ ...breakdownTd, textAlign: 'right' as const }}>100%</td>
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: 12, padding: 10, background: UXP.subtleBg, borderRadius: 6, fontSize: 11, color: UXP.ink3, lineHeight: 1.6 }}>
        Selling price ex-VAT: <strong>{recipe.selling_price_ex_vat != null ? fmtKr(recipe.selling_price_ex_vat) : '—'}</strong> ·
        Food cost: <strong>{fmtKr(summary.food_cost)}</strong> ·
        Food %: <strong>{summary.food_pct != null ? `${summary.food_pct.toFixed(1)}%` : '—'}</strong> ·
        GP %: <strong>{summary.gp_pct != null ? `${summary.gp_pct.toFixed(1)}%` : '—'}</strong> ·
        GP kr: <strong>{summary.gp_kr != null ? fmtKr(summary.gp_kr) : '—'}</strong>
      </div>
    </div>
  )
}

// ── localStorage-backed section state ────────────────────────────────
function useSectionState(key: string, initial: boolean): [boolean, (next: boolean | ((v: boolean) => boolean)) => void] {
  const storageKey = `cc_recipe_editor_section_${key}`
  const [val, setVal] = useState<boolean>(initial)
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey)
      if (v === '1') setVal(true)
      else if (v === '0') setVal(false)
    } catch {}
  }, [storageKey])
  const set = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    setVal(prev => {
      const resolved = typeof next === 'function' ? (next as (v: boolean) => boolean)(prev) : next
      try { localStorage.setItem(storageKey, resolved ? '1' : '0') } catch {}
      return resolved
    })
  }, [storageKey])
  return [val, set]
}

// ── suggestYieldFromIngredients (preserved from drawer) ───────────────
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

// ── MethodEditor (preserved — uses canonical Modal) ──────────────────
function MethodEditor({ recipe, onSave }: {
  recipe: DetailResponse['recipe']
  onSave: (patch: Record<string, any>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [val, setVal]   = useState(recipe.method ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setVal(recipe.method ?? '') }, [recipe.method])
  const dirty = (val ?? '') !== (recipe.method ?? '')

  async function commit() {
    if (!dirty) { setOpen(false); return }
    setBusy(true)
    try { await onSave({ method: val.trim() || null }); setOpen(false) }
    finally { setBusy(false) }
  }

  const preview = (recipe.method ?? '').trim()
  const previewShort = preview.length > 120 ? preview.slice(0, 120) + '…' : preview

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '10px 12px',
          textAlign: 'left' as const, fontFamily: 'inherit', fontSize: 12,
          color: preview ? UXP.ink2 : UXP.ink4,
          background: UXP.subtleBg, border: `1px solid ${UXP.border}`,
          borderRadius: 6, cursor: 'pointer', lineHeight: 1.5,
          display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center',
          minHeight: 50,
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden' as const }}>
          {previewShort || 'Click to write the method (cooking, preparation, plating)…'}
        </span>
        <span style={{ fontSize: 11, color: UXP.lavText, whiteSpace: 'nowrap' as const, fontWeight: 600 }}>
          {preview ? 'Edit →' : 'Add →'}
        </span>
      </button>

      <Modal
        open={open}
        onClose={() => !busy && commit()}
        size="lg"
        title="Method / instructions"
        subtitle={recipe.name}
        ariaLabel="Edit method"
        footer={
          <>
            <button type="button" onClick={() => { setVal(recipe.method ?? ''); setOpen(false) }} disabled={busy} style={overlayBtn.secondary}>Cancel</button>
            <button type="button" onClick={commit} disabled={busy} style={{ ...overlayBtn.primary, opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Saving…' : (dirty ? 'Save' : 'Done')}
            </button>
          </>
        }
      >
        <textarea
          value={val}
          onChange={e => setVal(e.target.value.slice(0, 20000))}
          autoFocus
          disabled={busy}
          maxLength={20000}
          placeholder="Cooking method, preparation, plating notes…"
          rows={14}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px',
            fontSize: 12, lineHeight: 1.6, border: `1px solid ${UXP.border}`,
            borderRadius: 6, fontFamily: 'inherit', resize: 'vertical' as const,
            color: UXP.ink1, minHeight: 240,
          }}
        />
        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 8, textAlign: 'right' as const }}>
          {val.length.toLocaleString()} / 20,000 chars
          {dirty && !busy && ' · unsaved'}
          {busy && ' · saving…'}
        </div>
      </Modal>
    </div>
  )
}

// ── YieldEditor (preserved from drawer) ───────────────────────────────
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
  const yieldUnitOptions = UNIT_OPTIONS.filter(u => u !== 'portion')
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="number" min="0" step="0.01" value={amt}
          onChange={e => setAmt(e.target.value)}
          placeholder="e.g. 250"
          disabled={busy}
          style={{ ...inputStyle, width: 110 }}
        />
        <select value={unit} onChange={e => setUnit(e.target.value)} disabled={busy} style={{ ...inputStyle, width: 90 }}>
          <option value="">—</option>
          {yieldUnitOptions.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <span style={{ fontSize: 11, color: UXP.ink4 }}>per portion</span>
        {dirty && (
          <button onClick={save} disabled={busy} style={{ ...overlayBtn.primary, padding: '6px 14px', fontSize: 11 }}>
            {busy ? '…' : 'Save'}
          </button>
        )}
      </div>
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
              marginTop: 8, fontSize: 10, padding: '4px 10px',
              border: `0.5px solid ${UXP.lav}`, background: UXP.lavFill, color: UXP.lavText,
              borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
            }}
            title={`Computed from ${suggestedYield.summed} ingredient${suggestedYield.summed === 1 ? '' : 's'}${suggestedYield.skipped > 0 ? ` (${suggestedYield.skipped} skipped — wrong unit or no data)` : ''}.`}
          >
            {label}
          </button>
        )
      })()}
      {err && <div style={{ fontSize: 10, color: UXP.coral, marginTop: 6 }}>{err}</div>}
      <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 8, lineHeight: 1.5 }}>
        Lets this recipe be consumed by weight/volume in other recipes (e.g. 30 g of sauce). Leave blank for portion-only. Owner overrides the auto-fill when there's cooking reduction (e.g. a sauce that boils down).
      </div>
    </div>
  )
}

// ── PriceVatEditor (preserved from drawer) ────────────────────────────
function PriceVatEditor({ recipe, onSave }: {
  recipe: DetailResponse['recipe']
  onSave: (patch: Record<string, any>) => Promise<void>
}) {
  const [exVat,   setExVat]   = useState(recipe.selling_price_ex_vat != null ? String(recipe.selling_price_ex_vat) : '')
  const [vatRate, setVatRate] = useState<number>(recipe.vat_rate != null ? Number(recipe.vat_rate) : 12)
  const [channel, setChannel] = useState<'dine_in' | 'takeaway'>(recipe.channel === 'takeaway' ? 'takeaway' : 'dine_in')
  const [busy,    setBusy]    = useState(false)
  useEffect(() => {
    setExVat(recipe.selling_price_ex_vat != null ? String(recipe.selling_price_ex_vat) : '')
    setVatRate(recipe.vat_rate != null ? Number(recipe.vat_rate) : 12)
    setChannel(recipe.channel === 'takeaway' ? 'takeaway' : 'dine_in')
  }, [recipe.selling_price_ex_vat, recipe.vat_rate, recipe.channel])
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 110px auto', gap: 10, alignItems: 'end' }}>
      <div>
        <div style={fieldLabelStyle}>Selling price ex-VAT (primary)</div>
        <input type="number" min="0" step="0.01" value={exVat}
          onChange={e => setExVat(e.target.value)}
          onBlur={commit}
          disabled={busy}
          style={inputStyle} />
        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4 }}>
          inc-VAT @ {vatRate}%: {incVatDisplay}
        </div>
      </div>
      <div>
        <div style={fieldLabelStyle}>VAT %</div>
        <select value={vatRate} onChange={e => setVatRate(Number(e.target.value))} onBlur={commit} disabled={busy} style={inputStyle}>
          {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
        </select>
      </div>
      <div>
        <div style={fieldLabelStyle}>Channel</div>
        <select value={channel} onChange={e => setChannel(e.target.value as any)} onBlur={commit} disabled={busy} style={inputStyle}>
          <option value="dine_in">Dine-in</option>
          <option value="takeaway">Takeaway</option>
        </select>
      </div>
      <button onClick={commit} disabled={busy} style={{ ...overlayBtn.primary, padding: '8px 14px' }}>
        {busy ? '…' : 'Save'}
      </button>
    </div>
  )
}

// ── IngredientRow (preserved verbatim from drawer — B1 green-tick) ────
function IngredientRow({ ing, imageUrl, highlighted, onRemove, onChange, onProductEdit, onOpenSubrecipe, onOpenEditModal }: {
  ing: DetailIngredient
  imageUrl?: string                  // optional supplier-article thumbnail
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
  const [justSaved, setJustSaved] = useState(false)
  const skipFirstSaveFlash = useRef(true)
  useEffect(() => { setQty(String(ing.quantity_stated ?? ing.quantity)) }, [ing.quantity, ing.quantity_stated])
  useEffect(() => { setWaste(String(ing.waste_pct ?? 0)) }, [ing.waste_pct])
  useEffect(() => {
    if (skipFirstSaveFlash.current) { skipFirstSaveFlash.current = false; return }
    setJustSaved(true)
    const id = setTimeout(() => setJustSaved(false), 1500)
    return () => clearTimeout(id)
  }, [ing.quantity, ing.waste_pct])
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
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Supplier-article thumbnail when available — silent fallback when not. */}
          {imageUrl && !ing.is_subrecipe && (
            <img src={imageUrl} alt="" loading="lazy" style={{
              width: 28, height: 28, objectFit: 'contain' as const,
              background: '#fff', border: `0.5px solid ${UXP.border}`,
              borderRadius: 4, flexShrink: 0,
            }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
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
        </div>
        <div style={{ position: 'relative' as const }}>
          <input type="number" min="0" step="0.01" value={qty}
            onChange={e => setQty(e.target.value)}
            onBlur={() => { const v = Number(qty); const cur = ing.quantity_stated ?? ing.quantity; if (Number.isFinite(v) && v > 0 && v !== cur) onChange({ quantity: v }) }}
            style={{ ...inputStyle, padding: '3px 6px', fontSize: 11, textAlign: 'right' as const }}
          />
          {justSaved && (
            <span style={{
              position: 'absolute' as const, right: -16, top: 4,
              color: UXP.green, fontSize: 12, fontWeight: 700,
              animation: 'cc-ing-saved-fade 1500ms ease-out forwards',
              pointerEvents: 'none' as const,
            }}
              aria-label="saved" title="Saved"
            >✓</span>
          )}
          <style>{`@keyframes cc-ing-saved-fade { 0% { opacity: 0; transform: translateX(-4px); } 15% { opacity: 1; transform: translateX(0); } 80% { opacity: 1; } 100% { opacity: 0; } }`}</style>
        </div>
        {ing.is_subrecipe && !ing.base_unit ? (
          <div style={{ color: UXP.ink3, fontSize: 11 }}
            title="This sub-recipe has no yield set. Open it and set a yield to consume it by weight/volume.">
            portion
          </div>
        ) : (() => {
          const current = ing.unit ?? ing.invoice_unit ?? (ing.is_subrecipe ? (ing.base_unit ?? 'portion') : 'g')
          const inList  = (UNIT_OPTIONS as readonly string[]).includes(current)
          return (
            <select
              value={current}
              onChange={e => { const v = e.target.value; if (v && v !== current) onChange({ unit: v }) }}
              style={{ ...inputStyle, padding: '3px 4px', fontSize: 11 }}
            >
              {!inList && <option value={current}>{current}</option>}
              {ing.is_subrecipe && <option value="portion">portion</option>}
              {UNIT_OPTIONS.filter(u => u !== 'portion' || !ing.is_subrecipe).map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          )
        })()}
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
          <button onClick={() => ing.subrecipe_id && onOpenSubrecipe(ing.subrecipe_id)}
            aria-label={t('detail.openSubrecipe')}
            title={t('detail.openSubrecipeHint')}
            style={{
              background: 'transparent', border: 'none', color: UXP.lavDeep,
              cursor: 'pointer', padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
            }}>→</button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
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
              {['SEK','EUR','USD','NOK','DKK','GBP'].map(c => <option key={c} value={c}>{c}</option>)}
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

// ── WarningCard (preserved from drawer) ───────────────────────────────
function WarningCard({ count, title, detail, names, actionLabel, onJump }: {
  count: number; title: string; detail: string; names: string[]; actionLabel: string; onJump: () => void
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
          <div style={{ fontSize: 12, fontWeight: 600, color: UXP.coral, marginBottom: 2 }}>{title}</div>
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

// ── IngredientPicker (preserved verbatim — modal at page scope now) ──
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
          business_id: bizId,
          name:        nm,
          category:    newCategory,
          unit:        newInvoiceUnit || null,
          base_unit:   newBaseUnit || null,
          pack_size:   newPackSize ? Number(newPackSize) : null,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setPicked({
        product_id:   j.product_id,
        name:         nm,
        category:     newCategory,
        invoice_unit: newInvoiceUnit || null,
        latest_price: null,
      })
      setUnit(newBaseUnit || newInvoiceUnit || 'g')
      setCreatingProduct(false)
      setNewName(''); setNewPackSize(''); setNewBaseUnit(''); setNewInvoiceUnit('')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

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
        payload.unit         = unit || 'portion'
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
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Add ingredient"
      ariaLabel="Add ingredient or sub-recipe"
    >
      {!picked && (
        <>
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
                  Skip if no price yet — you can set later.
                </div>
                {err && <div style={{ ...errBanner, marginTop: 6 }}>{err}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <button onClick={() => { setCreatingProduct(false); setErr(null) }} disabled={busy} style={overlayBtn.secondary}>Cancel</button>
                  <button onClick={createProduct} disabled={busy || !newName.trim()} style={overlayBtn.primary}>{busy ? 'Saving…' : 'Create product'}</button>
                </div>
              </div>
            )}
            {results.map((p: any) => (
              <button key={p.product_id ?? p.recipe_id}
                      onClick={() => {
                        if (tab === 'product') {
                          setPicked(p)
                          const def = p.base_unit ?? p.invoice_unit ?? ''
                          setUnit(String(def).toLowerCase())
                        } else if (!p.would_cycle) {
                          setPicked(p)
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
                    <span style={{ marginLeft: 6, fontSize: 10, color: UXP.coral, fontWeight: 500 }}>{t('picker.wouldCycle')}</span>
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
                ? <>Enter in <strong>{picked.base_unit}</strong> — pack is {picked.pack_size}{picked.base_unit} per {picked.invoice_unit ?? '?'}. Cost auto-converts.</>
                : <>No pack info set for this product. Enter in <strong>{picked.invoice_unit ?? '?'}</strong> or edit the product's pack/base unit first so g↔kg conversion works.</>
            ) : picked.yield_unit && picked.yield_amount ? (
              <>This sub-recipe yields <strong>{picked.yield_amount} {picked.yield_unit}</strong> per portion. Enter the amount you actually use — cost auto-converts via the yield.</>
            ) : (
              <>Quantity is in <strong>portions</strong> of the sub-recipe. To consume it by weight/volume, set the sub-recipe's yield on its own page.</>
            )}
          </div>
          {err && <div style={errBanner}>{err}</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <button onClick={() => setPicked(null)} disabled={busy} style={overlayBtn.secondary}>{t('picker.back')}</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onClose} disabled={busy} style={overlayBtn.secondary}>{t('cancel')}</button>
              <button onClick={add} disabled={busy || !qty} style={overlayBtn.primary}>{busy ? t('saving') : t('picker.add')}</button>
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

// ── Atoms ─────────────────────────────────────────────────────────────
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={fieldLabelStyle}>{label}</div>
      {children}
    </label>
  )
}

// ── Styles ────────────────────────────────────────────────────────────
const pageWrap: CSSProperties = {
  maxWidth: 1100, padding: '20px 24px 60px', margin: '0 auto',
}
const pageH1: CSSProperties = {
  margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em',
}
const pageSub: CSSProperties = {
  margin: '6px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5,
}
const headerCard: CSSProperties = {
  background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10,
  padding: '20px 22px', marginBottom: 12,
}
const sectionCard: CSSProperties = {
  background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10,
  padding: '18px 22px', marginBottom: 12,
}
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box' as const, padding: '7px 10px', fontSize: 12, fontFamily: 'inherit',
  border: `0.5px solid ${UXP.border}`, borderRadius: 5, color: UXP.ink1, background: '#fff',
}
const fieldLabelStyle: CSSProperties = {
  fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase' as const, marginBottom: 4,
}
const typeChip: CSSProperties = {
  fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' as const,
  color: UXP.ink4, background: 'transparent', border: 'none', padding: 0,
  cursor: 'pointer', fontFamily: 'inherit',
}
const promoteBtn: CSSProperties = {
  padding: '8px 14px', fontSize: 11, fontWeight: 500,
  background: 'transparent', color: UXP.ink2,
  border: `0.5px solid ${UXP.border}`, borderRadius: 5,
  cursor: 'pointer', fontFamily: 'inherit',
}
const promoteBadge: CSSProperties = {
  padding: '8px 14px', fontSize: 11, fontWeight: 500,
  background: UXP.greenFill, color: UXP.greenDeep,
  border: `0.5px solid ${UXP.green}`, borderRadius: 5,
  cursor: 'pointer', fontFamily: 'inherit',
}
const incompleteBadge: CSSProperties = {
  display: 'inline-block', padding: '4px 12px',
  background: '#fef3e0', color: UXP.coral,
  fontSize: 11, fontWeight: 600, borderRadius: 6, letterSpacing: '0.02em',
}
const addRowBtn: CSSProperties = {
  padding: '8px 14px', fontSize: 12, fontWeight: 600,
  background: UXP.lavDeep, color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
}
const errBanner: CSSProperties = {
  marginTop: 10, padding: '8px 12px',
  background: UXP.roseFill, color: UXP.roseText, fontSize: 11, borderRadius: 5,
}
const breakdownTh: CSSProperties = {
  padding: '8px 10px', fontSize: 10, fontWeight: 600, color: UXP.ink4,
  letterSpacing: '0.04em', textTransform: 'uppercase' as const, textAlign: 'left' as const,
}
const breakdownTd: CSSProperties = {
  padding: '8px 10px', fontSize: 11, color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const,
}

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
