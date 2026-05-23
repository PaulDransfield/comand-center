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
import { UXP } from '@/lib/constants/tokens'
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
  const [creating,setCreating]= useState(false)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/recipes?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  const rows = data?.recipes ?? []

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
          <button onClick={() => setCreating(true)} style={primaryBtn}>
            {t('addRecipe')}
          </button>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <Stat label={t('kpiCount')}      value={String(data?.summary.count ?? 0)} />
          <Stat label={t('kpiAvgGp')}      value={data?.summary.avg_gp_pct != null ? `${data.summary.avg_gp_pct.toFixed(1)} %` : '—'} />
          <Stat label={t('kpiLowGp')}      value={String(data?.summary.low_gp_count ?? 0)}
                tone={(data?.summary.low_gp_count ?? 0) > 0 ? 'coral' : 'ink'} />
          <Stat label={t('kpiAvgPrice')}   value={data?.summary.avg_menu_price != null ? fmtKr(data.summary.avg_menu_price) : '—'} />
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}
        {loading && <Empty label={t('loading')} />}
        {!loading && rows.length === 0 && !error && <Empty label={t('empty')} />}

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
                    <td style={{ ...numTd(), color: r.gp_pct == null ? UXP.ink3 : gpColor(r.gp_pct), fontWeight: 500 }}>
                      {r.gp_pct != null ? `${r.gp_pct.toFixed(1)} %` : '—'}
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
      {openId && bizId && (
        <RecipeDrawer recipeId={openId} bizId={bizId} onClose={() => { setOpenId(null); load() }} />
      )}
    </AppShell>
  )
}

// ── Create modal ───────────────────────────────────────────────────────
function CreateModal({ bizId, onClose, onCreated }: { bizId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('operations.inventory.recipes')
  const [name,      setName]      = useState('')
  const [type,      setType]      = useState('main')
  const [menuPrice, setMenuPrice] = useState('')
  const [portions,  setPortions]  = useState('1')
  const [busy,      setBusy]      = useState(false)
  const [err,       setErr]       = useState<string | null>(null)

  async function save() {
    if (!name.trim()) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/inventory/recipes', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: bizId,
          name: name.trim(),
          type,
          menu_price: menuPrice ? Number(menuPrice) : null,
          portions: portions ? Number(portions) : 1,
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label={t('fieldMenuPrice')}>
            <input type="number" min="0" step="0.01" value={menuPrice} onChange={e => setMenuPrice(e.target.value)} disabled={busy} style={inputStyle} />
          </Field>
          <Field label={t('fieldPortions')}>
            <input type="number" min="1" step="1" value={portions} onChange={e => setPortions(e.target.value)} disabled={busy} style={inputStyle} />
          </Field>
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
  quantity: number; unit: string | null; notes: string | null; position: number
  invoice_unit: string | null; unit_price: number | null; line_cost: number | null
  unit_mismatch: boolean; no_price: boolean
  latest_line_id: string | null; latest_currency: string | null
  subrecipe_id: string | null; subrecipe_name: string | null
  is_subrecipe: boolean; cycle: boolean
}
interface DetailResponse {
  recipe: { id: string; name: string; type: string | null; menu_price: number | null; portions: number; notes: string | null; updated_at: string }
  summary: {
    food_cost: number; food_pct: number | null; gp_pct: number | null; gp_kr: number | null
    missing_prices: number; unit_mismatches: number
    ingredients: DetailIngredient[]
  }
}

function RecipeDrawer({ recipeId, bizId, onClose }: { recipeId: string; bizId: string; onClose: () => void }) {
  const t = useTranslations('operations.inventory.recipes')
  const [data,    setData]    = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)
  const [adding,  setAdding]  = useState(false)

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

  async function updateIngredient(ingId: string, patch: { quantity?: number; unit?: string | null }) {
    const r = await fetch(`/api/inventory/recipes/${recipeId}/ingredients/${ingId}`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    if (r.ok) load()
  }

  async function deleteRecipe() {
    if (!confirm(t('deleteRecipeConfirm'))) return
    const r = await fetch(`/api/inventory/recipes/${recipeId}`, { method: 'DELETE', cache: 'no-store' })
    if (r.ok) onClose()
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
                  <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                    {data.recipe.type ? t(`type.${data.recipe.type}`) : t('type.other')}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: UXP.ink1, marginTop: 2 }}>{data.recipe.name}</div>
                </div>
                <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 18 }}>×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 14 }}>
                <DrawerStat label={t('detail.menuPrice')} value={data.recipe.menu_price != null ? fmtKr(data.recipe.menu_price) : '—'} />
                <DrawerStat label={t('detail.foodCost')}  value={fmtKr(data.summary.food_cost)} />
                <DrawerStat label={t('detail.foodPct')}   value={data.summary.food_pct != null ? `${data.summary.food_pct.toFixed(1)} %` : '—'}
                            color={data.summary.food_pct != null ? foodPctColor(data.summary.food_pct) : undefined} />
                <DrawerStat label={t('detail.gpPct')}     value={data.summary.gp_pct != null ? `${data.summary.gp_pct.toFixed(1)} %` : '—'}
                            color={data.summary.gp_pct != null ? gpColor(data.summary.gp_pct) : undefined} />
              </div>
              {(data.summary.missing_prices > 0 || data.summary.unit_mismatches > 0) && (
                <div style={{ marginTop: 10, padding: '6px 10px', background: '#fef3e0',
                              color: UXP.coral, fontSize: 11, borderRadius: 5 }}>
                  {data.summary.missing_prices > 0 && <div>{t('detail.missingPricesWarn', { count: String(data.summary.missing_prices) })}</div>}
                  {data.summary.unit_mismatches > 0 && <div>{t('detail.unitMismatchWarn', { count: String(data.summary.unit_mismatches) })}</div>}
                </div>
              )}
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
              {data.summary.ingredients.map(ing => (
                <IngredientRow key={ing.id}
                  ing={ing}
                  onRemove={() => removeIngredient(ing.id)}
                  onChange={(patch) => updateIngredient(ing.id, patch)}
                  onProductEdit={load}
                />
              ))}
            </div>

            <div style={{ padding: '10px 20px', borderTop: `0.5px solid ${UXP.borderSoft}`, display: 'flex', justifyContent: 'space-between' }}>
              <button onClick={deleteRecipe} style={dangerBtn}>{t('deleteRecipe')}</button>
              <button onClick={onClose} style={secondaryBtn}>{t('done')}</button>
            </div>

            {adding && (
              <IngredientPicker bizId={bizId} recipeId={recipeId} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load() }} />
            )}
          </>
        )}
      </div>
    </Backdrop>
  )
}

function IngredientRow({ ing, onRemove, onChange, onProductEdit }: {
  ing: DetailIngredient
  onRemove: () => void
  onChange: (patch: { quantity?: number; unit?: string }) => void
  onProductEdit: () => void
}) {
  const t = useTranslations('operations.inventory.recipes')
  const [qty, setQty] = useState(String(ing.quantity))
  const [expanded, setExpanded] = useState(false)
  const [busy,   setBusy]   = useState(false)
  const [err,    setErr]    = useState<string | null>(null)
  useEffect(() => { setQty(String(ing.quantity)) }, [ing.quantity])

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
    <div style={{ borderBottom: `0.5px solid ${UXP.borderSoft}`, padding: '8px 0' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 80px 60px 90px auto auto', gap: 10,
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
                    ? `${ing.latest_currency && ing.latest_currency !== 'SEK' ? `${ing.unit_price.toFixed(2)} ${ing.latest_currency}` : fmtKr(ing.unit_price)}/${ing.invoice_unit ?? '?'}`
                    : t('detail.noPrice'))}
            {!ing.is_subrecipe && ing.unit_mismatch && (
              <span style={{ marginLeft: 6, color: UXP.coral, fontWeight: 500 }}>
                {t('detail.unitMismatchLabel', { recipe: ing.unit ?? '?', product: ing.invoice_unit ?? '?' })}
              </span>
            )}
          </div>
        </div>
        <input type="number" min="0" step="0.01" value={qty}
          onChange={e => setQty(e.target.value)}
          onBlur={() => { const v = Number(qty); if (Number.isFinite(v) && v > 0 && v !== ing.quantity) onChange({ quantity: v }) }}
          style={{ ...inputStyle, padding: '3px 6px', fontSize: 11, textAlign: 'right' as const }}
        />
        <div style={{ color: UXP.ink3, fontSize: 11 }}>{ing.unit ?? ing.invoice_unit ?? ''}</div>
        <div style={{ textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: ing.no_price ? UXP.ink4 : UXP.ink1, fontWeight: 500 }}>
          {ing.line_cost != null ? fmtKr(ing.line_cost) : '—'}
        </div>
        {ing.is_subrecipe ? (
          // Sub-recipe row: no "edit product" affordance. (Future: link to
          // the sub-recipe drawer so owner can jump straight to editing it.)
          <span style={{ width: 22 }} />
        ) : (
          <button onClick={() => setExpanded(v => !v)} aria-label={t('detail.editProduct')}
            title={t('detail.editProductHint')}
            style={{
              background: 'transparent', border: 'none', color: expanded ? UXP.lavDeep : UXP.ink4,
              cursor: 'pointer', padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
            }}>{expanded ? '▾' : '✎'}</button>
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
              {results.length === 0 && (
                <div style={{ padding: 14, color: UXP.ink4, fontSize: 12, textAlign: 'center' as const }}>
                  {tab === 'product' ? t('picker.noResults') : t('picker.noRecipeResults')}
                </div>
              )}
              {results.map((p: any) => (
                <button key={p.product_id ?? p.recipe_id}
                        onClick={() => {
                          if (tab === 'product') { setPicked(p); setUnit(p.invoice_unit ?? '') }
                          else if (!p.would_cycle) { setPicked(p); setUnit('portion') }
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
                <input type="text" value={unit} onChange={e => setUnit(e.target.value)} disabled={busy || tab === 'recipe'} style={inputStyle}
                       placeholder={tab === 'product' ? (picked.invoice_unit ?? '') : 'portion'} />
              </Field>
            </div>
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4 }}>
              {tab === 'product'
                ? t('picker.unitHint',    { unit: picked.invoice_unit ?? '?' })
                : t('picker.subRecipeHint')}
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
