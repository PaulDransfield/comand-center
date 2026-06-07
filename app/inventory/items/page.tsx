'use client'
// app/inventory/items/page.tsx
//
// Inventory catalogue — every product the matcher has built from
// supplier invoices. Replaces the prior MOCK_INVENTORY_ITEMS surface
// with live data from /api/inventory/items.
//
// Each row shows latest price + change vs the prior 90-day median, so
// the owner can spot price creep at a glance. Click → per-product
// detail page with full price history.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import { EditItemModal } from '@/components/EditItemModal'
import { ProductThumb } from '@/components/ui/ProductThumb'
import { PageContainer, MetricCardRow } from '@/components/ui/Layout'
import { EmptyState } from '@/components/ui/EmptyState'
import { SubCategoryPill } from '@/components/ui/SubCategoryPill'
import { StorageIcon } from '@/components/ui/StorageIcon'
import { subCategoriesForTop } from '@/lib/inventory/taxonomy'
import { useViewport } from '@/lib/hooks/useViewport'

interface CatalogueItem {
  product_id:           string
  name:                 string
  category:             string
  sub_category:         string | null     // M137
  storage_type:         string | null     // M137 — 'frozen' | 'refrigerated' | 'ambient'
  brand:                string | null     // M137
  classification_source:     string | null     // M137 — null until first classification run
  classification_confidence: number | null     // M137
  default_supplier:     string | null
  latest_price:         number | null
  latest_unit:          string | null
  latest_supplier:      string | null
  latest_date:          string | null
  prior_median_price:   number | null
  change_pct:           number | null
  observation_count:    number
  is_recipe_sourced:    boolean
  source_recipe_id:     string | null
  needs_attention:      boolean
  attention_reasons:    Array<'no_article' | 'no_price' | 'unreliable' | 'no_supplier'>
}

interface CatalogueResponse {
  counts:                 Record<string, number>
  items:                  CatalogueItem[]
  needs_attention_count:  number
  message?:               string
}

// Owner-facing labels for the "Needs attention" reason pills.
const REASON_LABEL: Record<CatalogueItem['attention_reasons'][number], string> = {
  no_article:  'no article',
  no_price:    'no price',
  unreliable:  'unreliable',
  no_supplier: 'no supplier',
}

// Category keys are kept here so the rest of the file iterates a stable list
// regardless of locale. Labels are resolved via useTranslations at render.
//
// 'sellable' is a VIRTUAL bundle = food + beverage + alcohol. The default
// because owners almost always want to look at things they cook or pour,
// not packaging / cleaning / disposables (the "rullbar" class the owner
// flagged 2026-06-02). Server doesn't know about it; client requests
// ?category=all and post-filters to the sellable set.
const SELLABLE_CATEGORIES = new Set(['food', 'beverage', 'alcohol'])
const CATEGORY_KEYS = [
  'sellable', 'all', 'food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other',
] as const

type SortKey = 'name' | 'latest_price' | 'change_pct' | 'observation_count' | 'latest_date'

export default function InventoryItemsPage() {
  const router = useRouter()
  const t = useTranslations('operations.inventory.items')
  const tier = useViewport()
  const isMobile = tier === 'mobile'
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [filter,   setFilter]   = useState<string>('sellable')
  const [data,     setData]     = useState<CatalogueResponse | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [sortKey,  setSortKey]  = useState<SortKey>('change_pct')
  const [sortDesc, setSortDesc] = useState(true)
  const [search,   setSearch]   = useState('')
  // Session 25 Part A — "Needs attention" filter. When on, restricts
  // the items list to rows with at least one signal and sorts by
  // reason-count desc so the worst offenders surface first.
  const [needsOnly, setNeedsOnly] = useState(false)
  // M137 Push 3 — sub-category filter (cascades from top-level category)
  // and "Needs classification" worklist (low-confidence + unclassified).
  const [subFilter, setSubFilter] = useState<string | null>(null)
  const [needsClassificationOnly, setNeedsClassificationOnly] = useState(false)
  // Supplier-article thumbnails — cross-customer cached images from the
  // shared catalogue. Silent fallback when no url. Map keyed by product_id.
  const [imageByProduct, setImageByProduct] = useState<Record<string, string | null>>({})
  // Part A2 — EditItemModal mount on the items list. Clicking a row
  // body opens the modal here instead of navigating to the detail
  // page. The detail page (/inventory/items/[id]) remains accessible
  // via a "Full history" link inside the modal for the full
  // per-product invoice-line table + sparkline.
  const [editingProductId, setEditingProductId] = useState<string | null>(null)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    // React to BizPicker switching the active business — without this
    // listener the page would only react on full reload.
    function onStorage() {
      const next = localStorage.getItem('cc_selected_biz')
      if (next) setBizId(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!bizId) return
    // Silent refresh skips the loading spinner so post-save reloads
    // don't flash the empty catalogue + scroll-jump. The page stays
    // usable while the new data swaps in.
    if (!silent) setLoading(true)
    setError(null)
    try {
      const serverCategory = filter === 'sellable' ? 'all' : filter
      const r = await fetch(`/api/inventory/items?business_id=${encodeURIComponent(bizId)}&category=${encodeURIComponent(serverCategory)}`,
                            { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [bizId, filter])

  useEffect(() => { if (bizId) load() }, [bizId, filter, load])
  // M137 Push 3 — clear sub-category filter when top-level changes,
  // otherwise an orphan sub-pill (e.g. "dairy_cheese" while filter is
  // "alcohol") would silently hide every row.
  useEffect(() => { setSubFilter(null) }, [filter])

  // Batch-fetch supplier-article thumbnails for the currently loaded
  // items. The batch endpoint caps at 500 product_ids per call to keep
  // payload bounded — for businesses with >500 sellable products
  // (Chicce ~844, Vero ~760), we have to chunk client-side or the tail
  // gets silently dropped (looked like "some thumbs load, some don't"
  // even when those tail products HAD matching supplier_articles rows).
  // Multiple in-flight chunks merged into one state update.
  useEffect(() => {
    const ids = (data?.items ?? []).map(i => i.product_id)
    if (ids.length === 0) return
    const ctrl = new AbortController()
    const CHUNK = 500
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
    Promise.all(chunks.map(c =>
      fetch('/api/inventory/supplier-article/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_ids: c }),
        cache: 'no-store',
        signal: ctrl.signal,
      })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    ))
      .then(results => {
        const next: Record<string, string | null> = {}
        for (const pid of ids) next[pid] = null
        for (const j of results) {
          if (!j?.by_product) continue
          for (const pid of Object.keys(j.by_product)) {
            next[pid] = j.by_product[pid]?.image_url ?? null
          }
        }
        setImageByProduct(next)
      })
    return () => ctrl.abort()
  }, [data])

  const items = (data?.items ?? [])
    // Virtual 'sellable' bundle = food + beverage + alcohol. Server
    // ignores this filter (we sent 'all'); applied here.
    .filter(i => filter !== 'sellable' || SELLABLE_CATEGORIES.has(i.category))
    .filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()))
    .filter(i => !needsOnly || i.needs_attention)
    // M137 Push 3 — sub-category filter (when a sub-pill is selected)
    .filter(i => !subFilter || i.sub_category === subFilter)
    // M137 Push 3 — "Needs classification" worklist: unclassified OR
    // low-confidence (< 0.7). Owner reviews + overrides to manual.
    .filter(i => !needsClassificationOnly || i.sub_category == null || (i.classification_confidence ?? 0) < 0.7)
    .slice()
    .sort((a, b) => {
      // When the Needs-attention filter is ON, sort by reason-count
      // desc first — the worst offenders bubble to the top — then by
      // the existing sortKey as the secondary criterion.
      if (needsOnly) {
        const rd = (b.attention_reasons?.length ?? 0) - (a.attention_reasons?.length ?? 0)
        if (rd !== 0) return rd
      }
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return sortDesc ? -cmp : cmp
    })

  const totalRecent = items.reduce((s, i) => s + (i.latest_price ?? 0), 0)
  const creeping = items.filter(i => (i.change_pct ?? 0) >= 0.05).length
  const totalObservations = items.reduce((s, i) => s + i.observation_count, 0)
  // M137 Push 3 — needs-classification count (across the full filtered
  // category, before sub-category filter applies; otherwise the pill
  // would disappear once you opened it).
  const needsClassificationCount = (data?.items ?? [])
    .filter(i => filter !== 'sellable' || SELLABLE_CATEGORIES.has(i.category))
    .filter(i => filter === 'sellable' || filter === 'all' || i.category === filter)
    .filter(i => i.sub_category == null || (i.classification_confidence ?? 0) < 0.7)
    .length
  // M137 Push 3 — which top-level category to render sub-category pills
  // for. We render the cascade ONLY when a real top-level is picked
  // (not 'all' or 'sellable' which span multiple tops).
  const topForSubCascade: string | null =
    filter === 'food' || filter === 'beverage' || filter === 'alcohol' ||
    filter === 'cleaning' || filter === 'takeaway_material' ||
    filter === 'disposables' || filter === 'other'
      ? filter
      : null
  const subCategoriesForCurrent = topForSubCascade ? subCategoriesForTop(topForSubCascade) : []

  async function backfillPackSize() {
    if (!bizId) return
    if (!confirm(t('backfillPackConfirm'))) return
    try {
      const r = await fetch('/api/inventory/items/backfill-pack-size', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      alert(t('backfillPackDone', { scanned: String(j.scanned), applied: String(j.applied) }))
      load()
    } catch (e: any) {
      alert(e.message)
    }
  }

  const [recatBusy, setRecatBusy] = useState(false)

  // Manual "add article" — for catalogues that can't be auto-built from
  // invoices (no line text), owners create products by hand here and while
  // counting stock.
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCat,  setAddCat]  = useState('food')
  const [addUnit, setAddUnit] = useState('')
  const [addPack, setAddPack] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addErr,  setAddErr]  = useState<string | null>(null)
  // Server-side dedupe response — when a chef tries to add a product
  // whose name matches an existing one (normalised or similar), the
  // server returns 200 with { ok:false, candidates:[...] } and we
  // surface those before letting the chef force-create.
  const [addCandidates, setAddCandidates] = useState<Array<{ product_id: string; name: string; category: string; default_supplier: string | null; similarity: number; via_line?: string }> | null>(null)

  const lbl: React.CSSProperties = {
    display: 'block', fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: UXP.ink4, margin: '10px 0 4px',
  }
  const inp: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 13, color: UXP.ink1,
    border: `1px solid ${UXP.border}`, borderRadius: 6, fontFamily: 'inherit',
    boxSizing: 'border-box',
  }

  async function addProduct(opts: { force?: boolean } = {}) {
    if (!bizId || !addName.trim()) { setAddErr('Name is required'); return }
    setAddBusy(true); setAddErr(null)
    try {
      const r = await fetch('/api/inventory/items', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id:  bizId,
          name:         addName.trim(),
          category:     addCat,
          unit:         addUnit.trim() || null,
          pack_size:    addPack.trim() || null,
          force_create: opts.force === true ? true : undefined,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      // Dedupe ladder hit — server returns 200 with ok:false + candidates.
      if (j.ok === false && j.error === 'similar_product_exists') {
        setAddCandidates(j.candidates ?? [])
        setAddBusy(false)
        return
      }
      setShowAdd(false); setAddName(''); setAddUnit(''); setAddPack(''); setAddCat('food'); setAddCandidates(null)
      load()
    } catch (e: any) {
      setAddErr(e.message)
    } finally {
      setAddBusy(false)
    }
  }

  // M137 — run the classification cascade across the catalogue.
  // Reads supplier_articles + cross-customer + LLM-from-name in priority
  // order and fills products.sub_category / storage_type / classification_*.
  const [classifyBusy, setClassifyBusy] = useState(false)
  async function runClassify() {
    if (!bizId || classifyBusy) return
    if (!confirm('Classify catalogue into sub-categories (dairy / meat / wine etc.)?\n\nUses supplier data first, then cross-customer matches, then AI from product names. Already-classified products are skipped.')) return
    setClassifyBusy(true)
    try {
      const r = await fetch('/api/inventory/classify/backfill', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      const by = j.by_source ?? {}
      alert(
        `Classified ${j.updated}/${j.total_candidates} products.\n\n` +
        `From supplier data: ${by.supplier_articles ?? 0}\n` +
        `From other customers: ${by.cross_customer ?? 0}\n` +
        `From OpenFoodFacts (GTIN): ${by.openfoodfacts ?? 0}\n` +
        `From web search + AI: ${by.web_llm ?? 0}\n` +
        `From AI (name only): ${by.name_llm ?? 0}\n` +
        `Couldn't classify: ${by.unclassified ?? 0}`,
      )
      load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setClassifyBusy(false)
    }
  }

  async function recategoriseOther() {
    if (!bizId || recatBusy) return
    const otherCount = data?.counts?.other ?? 0
    if (otherCount === 0) { alert('No products in "other"'); return }
    if (!confirm(`Reclassify ${otherCount} products from "other"? AI scans names + uses web search for unfamiliar items. Estimated ~$${(otherCount * 0.015).toFixed(2)}.`)) return
    setRecatBusy(true)
    try {
      const r = await fetch('/api/inventory/recategorise-other', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, use_web_search: true }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      const summary = Object.entries(j.summary ?? {})
        .map(([cat, n]) => `${cat}: ${n}`)
        .join(', ')
      alert(`Recategorised ${j.recategorised}/${j.total_products} products${j.escalated_to_sonnet ? ` (${j.escalated_to_sonnet} escalated to web search)` : ''}.\n\n${summary || 'no changes'}\n\nStill "other": ${j.still_other}\nCost: $${j.cost_usd}`)
      load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setRecatBusy(false)
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
            <button onClick={() => { setShowAdd(true); setAddErr(null) }}
              title="Create a product/article by hand"
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 600,
                background: UXP.lavDeep, color: '#fff',
                border: 'none', borderRadius: 5,
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
              }}>
              + Add article
            </button>
            <button onClick={recategoriseOther}
              disabled={recatBusy || (data?.counts?.other ?? 0) === 0}
              title="AI re-classifies products in 'other' by name + web search"
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 500,
                background: recatBusy ? UXP.subtleBg : UXP.lavFill,
                color: UXP.lavText,
                border: `0.5px solid ${UXP.lavMid}`, borderRadius: 5,
                cursor: recatBusy ? 'wait' : 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap' as const,
                opacity: ((data?.counts?.other ?? 0) === 0) ? 0.5 : 1,
              }}>
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', marginRight: 5 }}>AI</span>
              {recatBusy ? 'Sorting…' : `Sort "other" (${data?.counts?.other ?? 0})`}
            </button>
            <button onClick={backfillPackSize}
              title={t('backfillPackHint')}
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 500,
                background: 'transparent', color: UXP.ink2,
                border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                cursor: 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap' as const,
              }}>
              {t('backfillPack')}
            </button>
            <button onClick={runClassify}
              disabled={classifyBusy}
              title="Sort catalogue into sub-categories using supplier data + cross-customer + AI"
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 500,
                background: classifyBusy ? UXP.subtleBg : UXP.lavFill,
                color: UXP.lavText,
                border: `0.5px solid ${UXP.lavMid}`, borderRadius: 5,
                cursor: classifyBusy ? 'wait' : 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap' as const,
              }}>
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', marginRight: 5 }}>AI</span>
              {classifyBusy ? 'Classifying…' : 'Classify catalogue'}
            </button>
            <a href="/inventory/duplicates"
              title="Find products that share a supplier article code — same SKU per the supplier"
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 500,
                background: 'transparent', color: UXP.ink2,
                border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                cursor: 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap' as const,
                textDecoration: 'none' as const,
                display: 'inline-flex', alignItems: 'center',
              }}>
              Find duplicates
            </a>
          </div>
        </div>

        {/* Add-article modal */}
        {showAdd && (
          <>
            <div onClick={() => setShowAdd(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 199 }} />
            <div style={{
              position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              background: '#fff', borderRadius: 12, width: 420, maxWidth: '94vw', zIndex: 200,
              padding: 24, boxShadow: '0 25px 60px rgba(0,0,0,0.3)', border: `1px solid ${UXP.border}`,
            }}>
              <h2 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 600, color: UXP.ink1 }}>Add article</h2>
              <label style={lbl}>Name</label>
              <input autoFocus value={addName} onChange={e => setAddName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addProduct() }}
                placeholder="e.g. Tomater San Marzano 2.5kg" style={inp} />
              <label style={lbl}>Category</label>
              <select value={addCat} onChange={e => setAddCat(e.target.value)} style={inp}>
                {['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>Unit (optional)</label>
                  <input value={addUnit} onChange={e => setAddUnit(e.target.value)} placeholder="kg / l / st" style={inp} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>Pack size (optional)</label>
                  <input value={addPack} onChange={e => setAddPack(e.target.value)} placeholder="e.g. 2.5" style={inp} />
                </div>
              </div>
              {addCandidates && addCandidates.length > 0 && (
                <div style={{ marginTop: 10, padding: 10, background: '#fff7e0', border: '0.5px solid #f5d99a', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#7a5a00', marginBottom: 6 }}>
                    {addCandidates.length} similar product{addCandidates.length === 1 ? '' : 's'} already exist{addCandidates.length === 1 ? 's' : ''}
                  </div>
                  {addCandidates.map(c => (
                    <button key={c.product_id} type="button"
                      onClick={() => { setEditingProductId(c.product_id); setShowAdd(false); setAddCandidates(null); setAddName(''); setAddUnit(''); setAddPack(''); setAddCat('food') }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left' as const,
                        padding: '5px 8px', marginBottom: 2,
                        background: '#fff', border: `0.5px solid ${UXP.border}`, borderRadius: 4,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}>
                      <div style={{ fontSize: 11, color: UXP.ink1, fontWeight: 500 }}>{c.name}</div>
                      <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1 }}>
                        {c.category}{c.default_supplier ? ` · ${c.default_supplier}` : ''} · {Math.round(c.similarity * 100)}% match
                      </div>
                    </button>
                  ))}
                  <div style={{ fontSize: 10, color: UXP.ink3, marginTop: 6 }}>Click one to open it, or:</div>
                  <button type="button" onClick={() => addProduct({ force: true })} disabled={addBusy}
                    style={{
                      marginTop: 6, padding: '4px 10px',
                      background: 'transparent', color: '#7a5a00', border: '0.5px solid #f5d99a',
                      borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    }}>
                    No, mine's different — create "{addName.trim()}" anyway
                  </button>
                </div>
              )}
              {addErr && <div style={{ color: UXP.roseText, fontSize: 12, marginTop: 8 }}>{addErr}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button onClick={() => { setShowAdd(false); setAddCandidates(null) }}
                  style={{ padding: '7px 14px', fontSize: 12, background: 'transparent', color: UXP.ink2, border: `0.5px solid ${UXP.border}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Cancel
                </button>
                <button onClick={() => addProduct()} disabled={addBusy || !!addCandidates}
                  style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 6, cursor: addBusy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                  {addBusy ? 'Adding…' : 'Add article'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* KPI strip */}
        <MetricCardRow style={{ marginBottom: 16 }}>
          <Stat label={t('kpiItems')} value={String(data?.counts?.all ?? 0)} />
          <Stat label={t('kpiObservations')} value={totalObservations.toLocaleString('en-GB')} />
          <Stat label={t('kpiLatestTotal')} value={fmtKr(totalRecent)} />
          <Stat label={t('kpiHikes')} value={String(creeping)}
                tone={creeping > 0 ? 'coral' : 'ink'} />
        </MetricCardRow>

        {/* Filters + search */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' as const, alignItems: 'center' }}>
          {CATEGORY_KEYS.map((key) => {
            // 'sellable' is a client-side bundle — sum food + beverage + alcohol.
            const count = key === 'all'
              ? (data?.counts?.all ?? 0)
              : key === 'sellable'
                ? (data?.counts?.food ?? 0) + (data?.counts?.beverage ?? 0) + (data?.counts?.alcohol ?? 0)
                : (data?.counts?.[key] ?? 0)
            const active = filter === key
            return (
              <button
                key={key} onClick={() => setFilter(key)}
                style={{
                  padding: '6px 12px', fontSize: 11, fontWeight: 500,
                  background: active ? UXP.lavFill : 'transparent',
                  color: active ? UXP.lavText : UXP.ink3,
                  border: `0.5px solid ${active ? UXP.lavMid : UXP.border}`,
                  borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {t(`categories.${key}`)} <span style={{ color: active ? UXP.lavText : UXP.ink4, marginLeft: 4 }}>{count}</span>
              </button>
            )
          })}
          {/* Session 25 Part A1 — "Needs attention" worklist chip. Toggles
              alongside the category filter (independent boolean). Coral
              tint marks it as a worklist, not just a category. */}
          {(data?.needs_attention_count ?? 0) > 0 && (
            <button
              onClick={() => setNeedsOnly(v => !v)}
              title="Items missing a connected article, price, default supplier, or with an unreliable extraction. Fix from the modal to drop them off this list."
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 600,
                background:  needsOnly ? '#fef3e0' : 'transparent',
                color:       needsOnly ? UXP.coral : UXP.coral,
                border:      `0.5px solid ${needsOnly ? UXP.coral : UXP.coralLine}`,
                borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Needs attention <span style={{ marginLeft: 4 }}>{data?.needs_attention_count ?? 0}</span>
            </button>
          )}
          {/* M137 Push 3 — "Needs classification" worklist chip. Same
              tone idiom as needs-attention but for sub_category coverage. */}
          {needsClassificationCount > 0 && (
            <button
              onClick={() => setNeedsClassificationOnly(v => !v)}
              title="Products without a sub-category, or where the AI confidence is below 0.7. Open the modal to override; saved values are locked as 'owner' and never overwritten."
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 600,
                background:  needsClassificationOnly ? UXP.lavFill : 'transparent',
                color:       UXP.lavText,
                border:      `0.5px solid ${needsClassificationOnly ? UXP.lavDeep : UXP.lavMid}`,
                borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Needs classification <span style={{ marginLeft: 4 }}>{needsClassificationCount}</span>
            </button>
          )}
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            style={{
              marginLeft: 'auto', padding: '5px 10px', fontSize: 12,
              background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
              borderRadius: 6, color: UXP.ink1, fontFamily: 'inherit',
              minWidth: 200,
            }}
          />
        </div>

        {/* M137 Push 3 — sub-category cascade. Shown only when a real
            top-level category is picked. "All" sub-pill clears the
            sub-filter. Each pill carries the row count for that sub-cat
            within the current top-level filter. */}
        {subCategoriesForCurrent.length > 0 && (
          <div style={{
            display: 'flex', gap: 5, marginBottom: 14, flexWrap: 'wrap' as const,
            alignItems: 'center', paddingLeft: 4,
            borderLeft: `2px solid ${UXP.lavMid}`,
          }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                           color: UXP.ink4, textTransform: 'uppercase' as const,
                           marginRight: 4 }}>
              Sub-category
            </span>
            <button
              onClick={() => setSubFilter(null)}
              style={{
                padding: '4px 10px', fontSize: 10, fontWeight: 500,
                background: subFilter === null ? UXP.lavFill : 'transparent',
                color: subFilter === null ? UXP.lavText : UXP.ink3,
                border: `0.5px solid ${subFilter === null ? UXP.lavMid : UXP.border}`,
                borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
              }}>
              All
            </button>
            {subCategoriesForCurrent.map(s => {
              const count = (data?.items ?? []).filter(i => i.sub_category === s.key).length
              if (count === 0) return null
              const active = subFilter === s.key
              return (
                <button
                  key={s.key}
                  onClick={() => setSubFilter(active ? null : s.key)}
                  style={{
                    padding: '4px 10px', fontSize: 10, fontWeight: 500,
                    background: active ? UXP.lavFill : 'transparent',
                    color: active ? UXP.lavText : UXP.ink3,
                    border: `0.5px solid ${active ? UXP.lavMid : UXP.border}`,
                    borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                  {s.label} <span style={{ color: active ? UXP.lavText : UXP.ink4, marginLeft: 4 }}>{count}</span>
                </button>
              )
            })}
          </div>
        )}

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill,
                        border: `0.5px solid ${UXP.rose}`, borderRadius: 8,
                        color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}
        {loading && (
          <div style={{ padding: 30, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13 }}>
            {t('loading')}
          </div>
        )}

        {!loading && data && items.length === 0 && (
          <EmptyState
            badge="No articles yet"
            title="Your article catalogue will appear here."
            description="Articles are built automatically as Fortnox supplier invoices arrive and the matcher links each line to a product. If you've just connected Fortnox, give the first sync a few minutes."
            action={{ label: 'Connect Fortnox', href: '/integrations' }}
            secondary={{ label: 'Open review queue', href: '/inventory/review' }}
            style={{ marginTop: 16 }}
          />
        )}

        {!loading && items.length > 0 && isMobile && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map(it => (
              <ItemCard
                key={it.product_id}
                item={it}
                thumbUrl={imageByProduct[it.product_id]}
                onClick={() => setEditingProductId(it.product_id)}
              />
            ))}
          </div>
        )}

        {!loading && items.length > 0 && !isMobile && (
          <div style={{
            background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
            borderRadius: 8, overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <thead>
                <tr style={{ background: UXP.subtleBg }}>
                  <Th label={t('colItem')}     k="name"              sortKey={sortKey} sortDesc={sortDesc} onSort={setSorting(setSortKey, setSortDesc)} />
                  <Th label={t('colCategory')} k="name"              sortKey={sortKey} sortDesc={sortDesc} onSort={setSorting(setSortKey, setSortDesc)} noSort />
                  <Th label={t('colLastSeen')} k="latest_date"       sortKey={sortKey} sortDesc={sortDesc} onSort={setSorting(setSortKey, setSortDesc)} align="left" />
                  <Th label={t('colPrice')}    k="latest_price"      sortKey={sortKey} sortDesc={sortDesc} onSort={setSorting(setSortKey, setSortDesc)} align="right" />
                  <Th label={t('colVs90d')}    k="change_pct"        sortKey={sortKey} sortDesc={sortDesc} onSort={setSorting(setSortKey, setSortDesc)} align="right" />
                  <Th label={t('colObs')}      k="observation_count" sortKey={sortKey} sortDesc={sortDesc} onSort={setSorting(setSortKey, setSortDesc)} align="right" />
                  <Th label={t('colSupplier')} k="name"              sortKey={sortKey} sortDesc={sortDesc} onSort={setSorting(setSortKey, setSortDesc)} noSort />
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.product_id}
                      onClick={() => setEditingProductId(it.product_id)}
                      style={{ cursor: 'pointer', borderTop: `0.5px solid ${UXP.borderSoft}` }}
                      onMouseEnter={e => (e.currentTarget.style.background = UXP.subtleBg)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ ...td(), fontWeight: 500, color: UXP.ink1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
                        <ProductThumb url={imageByProduct[it.product_id]} size="md" />
                        <StorageIcon storage={it.storage_type} size={14} />
                        <span>{it.name}</span>
                        {it.brand && (
                          <span style={{ fontSize: 10, color: UXP.ink4, fontWeight: 400 }}>
                            · {it.brand}
                          </span>
                        )}
                        <SubCategoryPill
                          subCategory={it.sub_category}
                          confidence={it.classification_confidence}
                          source={it.classification_source}
                        />
                        {it.is_recipe_sourced && (
                          <span style={{
                            fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                            padding: '1px 6px', background: UXP.lavFill, color: UXP.lavText,
                            borderRadius: 3, textTransform: 'uppercase' as const,
                          }} title={t('recipeSourcedTooltip')}>
                            {t('recipeSourcedBadge')}
                          </span>
                        )}
                        {it.attention_reasons?.length > 0 && (
                          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' as const, verticalAlign: 'middle' }}>
                            {it.attention_reasons.map(r => (
                              <span key={r} style={{
                                fontSize: 9, fontWeight: 600,
                                padding: '1px 6px', background: '#fef3e0', color: UXP.coral,
                                borderRadius: 3, letterSpacing: '0.02em',
                              }}>
                                {REASON_LABEL[r]}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={td()}><CategoryTag c={it.category} /></td>
                    <td style={{ ...td(), color: UXP.ink3, fontSize: 11 }}>{it.latest_date ?? '—'}</td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>
                      {it.latest_price != null
                        ? <>{fmtKr(it.latest_price)}{it.latest_unit ? <span style={{ fontSize: 10, color: UXP.ink4 }}> /{it.latest_unit}</span> : null}</>
                        : '—'}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const,
                                color: changeColor(it.change_pct), fontWeight: 500 }}>
                      {it.change_pct != null ? `${it.change_pct >= 0 ? '+' : ''}${(it.change_pct * 100).toFixed(1)} %` : '—'}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, color: UXP.ink3 }}>
                      {it.observation_count}
                    </td>
                    <td style={{ ...td(), color: UXP.ink3 }}>
                      {it.latest_supplier ?? it.default_supplier ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageContainer>

      {/* Session 25 Part A2 — EditItemModal as the canonical row-click
          target. The same component the recipe drawer uses; opening from
          here exercises the same edit-context endpoint + save/connect/
          repoint/disconnect paths. On save, refresh the list so an item
          the owner just grounded drops off the Needs-attention filter
          immediately. The /inventory/items/[id] detail page is still
          reachable from inside the modal for the full invoice-line
          history + sparkline. */}
      {editingProductId && (
        <EditItemModal
          productId={editingProductId}
          onClose={() => setEditingProductId(null)}
          onSaved={() => { setEditingProductId(null); load({ silent: true }) }}
          onChange={() => load({ silent: true })}
        />
      )}
    </AppShell>
  )
}

function setSorting(setSortKey: (k: SortKey) => void, setSortDesc: (d: boolean | ((prev: boolean) => boolean)) => void) {
  return (k: SortKey) => {
    setSortKey(k)
    setSortDesc(prev => !prev)
  }
}

function Th({ label, k, sortKey, sortDesc, onSort, align = 'left', noSort = false }:
  { label: string; k: SortKey; sortKey: SortKey; sortDesc: boolean; onSort: (k: SortKey) => void; align?: 'left' | 'right'; noSort?: boolean }) {
  const isActive = !noSort && sortKey === k
  return (
    <th style={{
      padding: '8px 12px', fontSize: 10, fontWeight: 600,
      color: isActive ? UXP.ink2 : UXP.ink4, letterSpacing: '0.04em',
      textTransform: 'uppercase' as const, textAlign: align,
      cursor: noSort ? 'default' : 'pointer', userSelect: 'none' as const,
    }} onClick={() => !noSort && onSort(k)}>
      {label}{isActive ? (sortDesc ? ' ↓' : ' ↑') : ''}
    </th>
  )
}

// Mobile card render for one item row. Primary line = thumb + name (+
// recipe-sourced + needs-attention badges). Body shows price (with
// delta color), category, and supplier. Tap opens the same
// EditItemModal as the desktop row click. Last-seen date + observation
// count are intentionally dropped on mobile — they're audit numbers,
// not action-blockers.
function ItemCard({ item, thumbUrl, onClick }: {
  item:     CatalogueItem
  thumbUrl: string | null | undefined
  onClick:  () => void
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 10,
        background: UXP.cardBg,
        border: `0.5px solid ${UXP.border}`,
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex',
        gap: 10,
      }}
    >
      <ProductThumb url={thumbUrl} size="md" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontWeight: 600, color: UXP.ink1, fontSize: 13, lineHeight: 1.3, wordBreak: 'break-word', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const }}>
            <StorageIcon storage={item.storage_type} size={12} />
            <span>{item.name}</span>
            {item.brand && (
              <span style={{ fontSize: 10, color: UXP.ink4, fontWeight: 400 }}>
                · {item.brand}
              </span>
            )}
          </div>
          <div style={{
            fontSize: 13, fontWeight: 600,
            color: changeColor(item.change_pct),
            fontVariantNumeric: 'tabular-nums' as const,
            whiteSpace: 'nowrap' as const,
          }}>
            {item.latest_price != null ? fmtKr(item.latest_price) : '—'}
            {item.latest_unit && item.latest_price != null && (
              <span style={{ fontSize: 10, color: UXP.ink4 }}> /{item.latest_unit}</span>
            )}
          </div>
        </div>
        <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap' as const, gap: 6, alignItems: 'center' }}>
          <CategoryTag c={item.category} />
          <SubCategoryPill
            subCategory={item.sub_category}
            confidence={item.classification_confidence}
            source={item.classification_source}
            size="xs"
          />
          {item.change_pct != null && (
            <span style={{
              fontSize: 10, fontWeight: 500,
              color: changeColor(item.change_pct),
              fontVariantNumeric: 'tabular-nums' as const,
            }}>
              {item.change_pct >= 0 ? '+' : ''}{(item.change_pct * 100).toFixed(1)}%
            </span>
          )}
          {(item.latest_supplier ?? item.default_supplier) && (
            <span style={{ fontSize: 10, color: UXP.ink3 }}>
              · {item.latest_supplier ?? item.default_supplier}
            </span>
          )}
          {item.is_recipe_sourced && (
            <span style={{
              fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
              padding: '1px 6px', background: UXP.lavFill, color: UXP.lavText,
              borderRadius: 3, textTransform: 'uppercase' as const,
            }}>recipe</span>
          )}
          {item.attention_reasons?.map(r => (
            <span key={r} style={{
              fontSize: 9, fontWeight: 600,
              padding: '1px 6px', background: '#fef3e0', color: UXP.coral,
              borderRadius: 3, letterSpacing: '0.02em',
            }}>{REASON_LABEL[r]}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'ink' }: { label: string; value: string; tone?: 'ink' | 'coral' }) {
  return (
    <div style={{
      background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
      borderRadius: 8, padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600,
                    letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600,
                    color: tone === 'coral' ? UXP.coral : UXP.ink1,
                    marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}

function CategoryTag({ c }: { c: string }) {
  const t = useTranslations('operations.inventory.items.categories')
  // Soft-fail to the raw key if the translation namespace is missing
  // a value for this category (e.g. a custom future category added by
  // the matcher before we land its label).
  let label: string
  try { label = t(c) } catch { label = c }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      background: UXP.subtleBg, color: UXP.ink2,
      borderRadius: 6, fontSize: 10, fontWeight: 500,
      border: `0.5px solid ${UXP.border}`,
    }}>{label}</span>
  )
}

function sortValue(it: CatalogueItem, k: SortKey): number | string | null {
  switch (k) {
    case 'name': return it.name
    case 'latest_price': return it.latest_price
    case 'change_pct': return it.change_pct
    case 'observation_count': return it.observation_count
    case 'latest_date': return it.latest_date
  }
}

function changeColor(d: number | null): string {
  if (d == null) return UXP.ink3
  if (d >= 0.1)  return UXP.roseText
  if (d >= 0.05) return UXP.coral
  if (d <= -0.05) return UXP.greenDeep
  return UXP.ink2
}

function td(): React.CSSProperties {
  return { padding: '10px 12px', fontSize: 12, color: UXP.ink2 }
}
