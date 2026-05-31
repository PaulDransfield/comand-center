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
          <button onClick={() => setCreating(true)} disabled={!bizId}
            title={!bizId ? 'Select a business in the sidebar first' : undefined}
            style={{ ...primaryBtn, opacity: bizId ? 1 : 0.5, cursor: bizId ? 'pointer' : 'not-allowed' }}>
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
                  <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                    {data.recipe.type ? t(`type.${data.recipe.type}`) : t('type.other')}
                  </div>
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
              {(data.summary.missing_prices > 0 || data.summary.unit_mismatches > 0) && (
                <div style={{ marginTop: 10, padding: '6px 10px', background: '#fef3e0',
                              color: UXP.coral, fontSize: 11, borderRadius: 5 }}>
                  {data.summary.missing_prices > 0 && (
                    <button onClick={() => {
                      const first = data.summary.ingredients.find(i => i.no_price && !i.is_subrecipe)
                      if (first) {
                        const el = document.getElementById(`ing-row-${first.id}`)
                        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setHighlightIngId(first.id) }
                      }
                    }} style={{
                      display: 'block', width: '100%', textAlign: 'left' as const,
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: UXP.coral, fontSize: 11, fontFamily: 'inherit',
                      textDecoration: 'underline', textUnderlineOffset: 2,
                    }}>
                      {t('detail.missingPricesWarn', { count: String(data.summary.missing_prices) })}
                      <span style={{ marginLeft: 6, color: UXP.coral, opacity: 0.8 }}>— click to jump &amp; edit</span>
                    </button>
                  )}
                  {data.summary.unit_mismatches > 0 && (
                    <button onClick={() => {
                      const first = data.summary.ingredients.find(i => i.unit_mismatch && !i.is_subrecipe)
                      if (first) {
                        const el = document.getElementById(`ing-row-${first.id}`)
                        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setHighlightIngId(first.id) }
                      }
                    }} style={{
                      display: 'block', width: '100%', textAlign: 'left' as const,
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: UXP.coral, fontSize: 11, fontFamily: 'inherit',
                      textDecoration: 'underline', textUnderlineOffset: 2,
                    }}>
                      {t('detail.unitMismatchWarn', { count: String(data.summary.unit_mismatches) })}
                      <span style={{ marginLeft: 6, color: UXP.coral, opacity: 0.8 }}>— click to jump &amp; fix pack/base unit</span>
                    </button>
                  )}
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
              {/* Column header — makes "Waste %" explicit (owner kept asking
                  if that column was "5 grams or 5 percent"). */}
              {data.summary.ingredients.length > 0 && (
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 80px 60px 60px 90px auto auto', gap: 10,
                  padding: '4px 0', fontSize: 9, color: UXP.ink4,
                  letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600,
                  borderBottom: `0.5px solid ${UXP.border}`,
                }}>
                  <div>Ingredient</div>
                  <div style={{ textAlign: 'right' as const }}>Qty</div>
                  <div>Unit</div>
                  <div style={{ textAlign: 'right' as const }}>Waste %</div>
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
          </>
        )}
      </div>
    </Backdrop>
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

function IngredientRow({ ing, highlighted, onRemove, onChange, onProductEdit, onOpenSubrecipe }: {
  ing: DetailIngredient
  highlighted?: boolean
  onRemove: () => void
  onChange: (patch: { quantity?: number; unit?: string; waste_pct?: number }) => void
  onProductEdit: () => void
  onOpenSubrecipe: (id: string) => void
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
        display: 'grid', gridTemplateColumns: '1fr 80px 60px 60px 90px auto auto', gap: 10,
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
        <div style={{ color: UXP.ink3, fontSize: 11 }}>{ing.unit ?? ing.invoice_unit ?? ''}</div>
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
                <select value={unit} onChange={e => setUnit(e.target.value)} disabled={busy || tab === 'recipe'} style={inputStyle}>
                  {/* Pre-select what the product expects (base_unit if pack
                      is set, else invoice_unit) — owner can override. */}
                  {tab === 'recipe' && <option value="portion">portion</option>}
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
              ) : t('picker.subRecipeHint')}
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
