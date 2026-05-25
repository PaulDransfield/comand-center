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

interface CatalogueItem {
  product_id:           string
  name:                 string
  category:             string
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
}

interface CatalogueResponse {
  counts:  Record<string, number>
  items:   CatalogueItem[]
  message?: string
}

// Category keys are kept here so the rest of the file iterates a stable list
// regardless of locale. Labels are resolved via useTranslations at render.
const CATEGORY_KEYS = [
  'all', 'food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other',
] as const

type SortKey = 'name' | 'latest_price' | 'change_pct' | 'observation_count' | 'latest_date'

export default function InventoryItemsPage() {
  const router = useRouter()
  const t = useTranslations('operations.inventory.items')
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [filter,   setFilter]   = useState<string>('all')
  const [data,     setData]     = useState<CatalogueResponse | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [sortKey,  setSortKey]  = useState<SortKey>('change_pct')
  const [sortDesc, setSortDesc] = useState(true)
  const [search,   setSearch]   = useState('')

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

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/inventory/items?business_id=${encodeURIComponent(bizId)}&category=${encodeURIComponent(filter)}`,
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

  const items = (data?.items ?? [])
    .filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()))
    .slice()
    .sort((a, b) => {
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
        </div>

        {/* KPI strip */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16,
        }}>
          <Stat label={t('kpiItems')} value={String(data?.counts?.all ?? 0)} />
          <Stat label={t('kpiObservations')} value={totalObservations.toLocaleString('en-GB')} />
          <Stat label={t('kpiLatestTotal')} value={fmtKr(totalRecent)} />
          <Stat label={t('kpiHikes')} value={String(creeping)}
                tone={creeping > 0 ? 'coral' : 'ink'} />
        </div>

        {/* Filters + search */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' as const, alignItems: 'center' }}>
          {CATEGORY_KEYS.map((key) => {
            const count = key === 'all' ? (data?.counts?.all ?? 0) : (data?.counts?.[key] ?? 0)
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
          <div style={{
            padding: 30, textAlign: 'center' as const, color: UXP.ink3,
            fontSize: 13, background: UXP.cardBg,
            border: `0.5px solid ${UXP.border}`, borderRadius: 8,
          }}>
            {data.message ?? t('empty')}
          </div>
        )}

        {!loading && items.length > 0 && (
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
                      onClick={() => router.push(`/inventory/items/${it.product_id}`)}
                      style={{ cursor: 'pointer', borderTop: `0.5px solid ${UXP.borderSoft}` }}
                      onMouseEnter={e => (e.currentTarget.style.background = UXP.subtleBg)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ ...td(), fontWeight: 500, color: UXP.ink1 }}>
                      {it.name}
                      {it.is_recipe_sourced && (
                        <span style={{
                          marginLeft: 6,
                          fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                          padding: '1px 6px', background: UXP.lavFill, color: UXP.lavText,
                          borderRadius: 3, textTransform: 'uppercase' as const,
                        }} title={t('recipeSourcedTooltip')}>
                          {t('recipeSourcedBadge')}
                        </span>
                      )}
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
      </div>
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
