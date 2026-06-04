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

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { Modal, overlayBtn } from '@/components/ui/Overlay'
import { PageContainer } from '@/components/ui/Layout'
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable'
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

export default function InventoryRecipesPage() {
  const router = useRouter()
  const t = useTranslations('operations.inventory.recipes')
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [data,    setData]    = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

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

  const allRows = data?.recipes ?? []
  const [viewFilter, setViewFilter] = useState<'dishes' | 'subrecipes' | 'all'>('dishes')
  const DISH_TYPES = new Set(['starter', 'main', 'pasta', 'pizza', 'dessert', 'drink', 'cocktail', 'side'])
  const isDish = (r: any) =>
    r.is_subrecipe === true ? false :
    (r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
    || (r.menu_price != null && Number(r.menu_price) > 0)
    || (r.type && DISH_TYPES.has(String(r.type).toLowerCase()))
  const rows = viewFilter === 'dishes'     ? allRows.filter(isDish)
            : viewFilter === 'subrecipes'  ? allRows.filter((r: any) => !isDish(r))
            :                                allRows
  const dishCount = allRows.filter(isDish).length
  const subCount  = allRows.length - dishCount
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

        {!loading && rows.length > 0 && (() => {
          const incomplete = (r: RecipeRow) => r.missing_prices > 0 || r.unit_mismatches > 0
          const cols: Array<DataTableColumn<RecipeRow>> = [
            { id: 'name',  header: t('colName'),  primary: true,
              cell: r => <span style={{ fontWeight: 500, color: UXP.ink1 }}>{r.name}</span> },
            { id: 'type',  header: t('colType'),
              cell: r => <span style={{ color: UXP.ink3 }}>{r.type ?? '—'}</span> },
            { id: 'ing',   header: t('colIngredients'), align: 'right' as const,
              cell: r => <span style={{ color: UXP.ink3 }}>{r.ingredient_count}</span> },
            { id: 'menu',  header: t('colMenuPrice'),   align: 'right' as const, hideOnMobile: true,
              cell: r => r.menu_price != null ? fmtKr(r.menu_price) : '—' },
            { id: 'food',  header: t('colFoodCost'),    align: 'right' as const, hideOnMobile: true,
              cell: r => fmtKr(r.food_cost) },
            { id: 'foodpct', header: t('colFoodPct'),   align: 'right' as const, hideOnMobile: true,
              cell: r => (
                <span style={{ color: r.food_pct == null ? UXP.ink3 : foodPctColor(r.food_pct) }}>
                  {r.food_pct != null ? `${r.food_pct.toFixed(1)} %` : '—'}
                </span>
              ) },
            // GP renders Incomplete badge on top — chef-readable. Shown on every tier.
            { id: 'gp',    header: t('colGp'),  align: 'right' as const,
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
                </span>
              ) : <span style={{ color: UXP.ink3 }}>—</span> },
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
          return (
            <DataTable<RecipeRow>
              columns={cols}
              data={rows}
              getKey={r => r.id}
              onRowClick={r => router.push(`/inventory/recipes/${r.id}`)}
              style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}
            />
          )
        })()}
      </PageContainer>

      {importing && bizId && (
        <BulkImportModal bizId={bizId} existingRecipes={allRows} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); load() }} />
      )}
    </AppShell>
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
    yield_amount:           number | null
    yield_unit:             string | null
    note:                   string | null
    method:                 string | null
    ingredients:            Ingredient[]
    // Duplicate-detection. Set after parse() matches the draft name
    // (case-insensitive, trimmed) against the existing recipe list.
    // skip=true on duplicates by default — owner unchecks to overwrite
    // (still doesn't overwrite ingredients, but updates name/notes).
    existing_recipe_id?:    string | null
    skip?:                  boolean
  }
  const [stage,   setStage]   = useState<'paste' | 'preview' | 'saving' | 'done'>('paste')
  const [text,    setText]    = useState('')
  const [files,   setFiles]   = useState<File[]>([])
  const [drafts,  setDrafts]  = useState<Draft[]>([])
  const [meta,    setMeta]    = useState<{ tokens_in: number; tokens_out: number; catalogue_size: number } | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [saveResults, setSaveResults] = useState<{ created: number; failed: { name: string; error: string }[] } | null>(null)

  async function parse() {
    if (!text.trim() && files.length === 0) { setErr('Paste some menu text or attach a file first.'); return }
    setBusy(true); setErr(null)
    try {
      let r: Response
      if (files.length > 0) {
        const fd = new FormData()
        fd.append('business_id', bizId)
        for (const f of files) fd.append('file', f)
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
          ? { ...d, existing_recipe_id: hit, skip: true }
          : { ...d, existing_recipe_id: null, skip: false }
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

    // Skip duplicates the owner left checked. Their existing recipe id
    // still seeds the sub-recipe name→id map so PARENT drafts that
    // reference these subs (by exact name) still resolve correctly.
    const willSave = drafts.filter(d => !d.skip)
    const subs    = willSave.filter(d => d.is_subrecipe)
    const parents = willSave.filter(d => !d.is_subrecipe)
    const nameToId = new Map<string, string>()
    for (const d of drafts) {
      if (d.skip && d.existing_recipe_id) {
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
            vat_rate:              12,
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

    for (const d of subs) {
      const id = await createOne(d)
      if (id) nameToId.set(d.name.trim().toLowerCase(), id)
    }
    for (const d of parents) await createOne(d)

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
      ? { ...d, name, existing_recipe_id: hit ?? null, skip: hit ? (d.skip ?? true) : false }
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
                  background:    d.existing_recipe_id && d.skip ? '#fef3e0' : d.is_subrecipe ? UXP.subtleBg : 'transparent',
                  opacity:       d.existing_recipe_id && d.skip ? 0.75 : 1,
                }}>
                  {d.existing_recipe_id && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
                      padding: '6px 8px', background: '#fef3e0', borderRadius: 4,
                      fontSize: 11, color: UXP.coral, fontWeight: 500,
                    }}>
                      <span>Already in your recipe book — {d.skip ? 'will be SKIPPED' : 'WILL OVERWRITE'}</span>
                      <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={d.skip === true}
                          onChange={e => setDrafts(prev => prev.map((x, i) => i === di ? { ...x, skip: e.target.checked } : x))}
                        />
                        Skip
                      </label>
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
              <button onClick={() => setStage('paste')} disabled={busy} style={overlayBtn.secondary}>← Back to paste</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} disabled={busy} style={overlayBtn.secondary}>Cancel</button>
                <button onClick={saveAll} disabled={busy || drafts.length === 0} style={overlayBtn.primary}>
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
