'use client'
// app/inventory/review/page.tsx
//
// Bulk-review queue — owner sees one row per (supplier, normalised
// description, unit) group of needs_review supplier_invoice_lines.
// Approving a group creates ONE product + alias and re-links every
// matching line in a single batch update.
//
// This is the catalogue seeding surface. The matcher only re-matches
// against existing products; without owner action here, the catalogue
// stays empty even when extractions complete.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface ReviewGroup {
  group_key:                string
  supplier_fortnox_number:  string
  supplier_name:            string | null
  suggested_name:           string
  sample_raw_description:   string
  unit:                     string | null
  line_count:               number
  invoice_count:            number
  total_kr:                 number
  latest_price:             number | null
  min_price:                number | null
  max_price:                number | null
  most_common_account:      string | null
  suggested_category:       string
  latest_invoice_date:      string | null
}

interface ReviewResponse {
  counts:        Record<string, number>
  groups:        ReviewGroup[]
  total_lines:   number
  total_groups:  number
}

const CATEGORY_KEYS = [
  'all', 'food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other',
] as const

export default function InventoryReviewPage() {
  const t = useTranslations('operations.inventory.review')
  const ct = useTranslations('operations.inventory.items.categories')
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [filter,   setFilter]   = useState<string>('all')
  const [data,     setData]     = useState<ReviewResponse | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [search,   setSearch]   = useState('')
  // per-row local state for the editable name + category + busy flag
  // `done` is set on success (Approve) and `skipped` on Skip.
  // `product_id` + `alias_id` are returned by the approve endpoint and
  // needed to drive Undo (delete-and-revert).
  const [edits, setEdits] = useState<Record<string, {
    name: string;
    category: string;
    busy?: boolean;
    done?: boolean;
    skipped?: boolean;
    was_existing?: boolean;     // approve linked to an existing product (idempotent)
    product_id?: string;
    alias_id?: string;
    err?: string;
  }>>({})
  // Bulk-action selection state
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/inventory/needs-review?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      const j = await r.json()
      setData(j)
      // seed edit state with suggested values
      const seed: typeof edits = {}
      for (const g of j.groups ?? []) {
        seed[g.group_key] = { name: g.suggested_name, category: g.suggested_category }
      }
      setEdits(seed)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [bizId])

  useEffect(() => { if (bizId) load() }, [bizId, load])

  async function approve(group: ReviewGroup) {
    if (!bizId) return
    const e = edits[group.group_key]
    if (!e?.name?.trim()) return
    setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: true, err: undefined } }))
    try {
      const r = await fetch('/api/inventory/needs-review/approve', {
        method:  'POST',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          business_id:  bizId,
          group_key:    group.group_key,
          product_name: e.name.trim(),
          category:     e.category,
        }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setEdits(prev => ({ ...prev, [group.group_key]: {
        ...prev[group.group_key],
        busy: false, done: true,
        product_id: j.product_id, alias_id: j.alias_id,
        was_existing: !!j.was_existing,
      } }))
    } catch (err: any) {
      setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: false, err: err.message } }))
    }
  }

  async function undoApprove(group: ReviewGroup) {
    if (!bizId) return
    const e = edits[group.group_key]
    if (!e?.product_id || !e?.alias_id) return
    setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: true, err: undefined } }))
    try {
      const r = await fetch('/api/inventory/needs-review/approve/undo', {
        method:  'POST',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, product_id: e.product_id, alias_id: e.alias_id }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setEdits(prev => ({ ...prev, [group.group_key]: {
        ...prev[group.group_key],
        busy: false, done: false, product_id: undefined, alias_id: undefined,
      } }))
    } catch (err: any) {
      setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: false, err: err.message } }))
    }
  }

  async function undoSkip(group: ReviewGroup) {
    if (!bizId) return
    setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: true, err: undefined } }))
    try {
      const r = await fetch('/api/inventory/needs-review/skip/undo', {
        method:  'POST',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, group_key: group.group_key }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: false, skipped: false } }))
    } catch (err: any) {
      setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: false, err: err.message } }))
    }
  }

  async function skip(group: ReviewGroup) {
    if (!bizId) return
    setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: true, err: undefined } }))
    try {
      const r = await fetch('/api/inventory/needs-review/skip', {
        method:  'POST',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, group_key: group.group_key }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: false, skipped: true } }))
    } catch (err: any) {
      setEdits(prev => ({ ...prev, [group.group_key]: { ...prev[group.group_key], busy: false, err: err.message } }))
    }
  }

  async function skipSupplier(group: ReviewGroup) {
    if (!bizId) return
    const supplierLabel = group.supplier_name ?? `#${group.supplier_fortnox_number}`
    const lineCount = allGroups
      .filter(x => x.supplier_fortnox_number === group.supplier_fortnox_number)
      .reduce((s, x) => s + x.line_count, 0)
    if (!confirm(t('skipSupplierConfirm', { supplier: supplierLabel, count: String(lineCount) }))) return

    // Mark every visible group for this supplier as busy so the UI freezes them.
    setEdits(prev => {
      const next = { ...prev }
      for (const g of allGroups) {
        if (g.supplier_fortnox_number === group.supplier_fortnox_number) {
          next[g.group_key] = { ...next[g.group_key], busy: true, err: undefined }
        }
      }
      return next
    })

    try {
      const r = await fetch('/api/inventory/needs-review/skip-supplier', {
        method:  'POST',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          business_id:             bizId,
          supplier_fortnox_number: group.supplier_fortnox_number,
          supplier_name:           group.supplier_name,
        }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      // Mark every group for this supplier as skipped.
      setEdits(prev => {
        const next = { ...prev }
        for (const g of allGroups) {
          if (g.supplier_fortnox_number === group.supplier_fortnox_number) {
            next[g.group_key] = { ...next[g.group_key], busy: false, skipped: true }
          }
        }
        return next
      })
    } catch (err: any) {
      setEdits(prev => {
        const next = { ...prev }
        for (const g of allGroups) {
          if (g.supplier_fortnox_number === group.supplier_fortnox_number) {
            next[g.group_key] = { ...next[g.group_key], busy: false, err: err.message }
          }
        }
        return next
      })
    }
  }

  const allGroups = data?.groups ?? []
  const visible = allGroups
    .filter(g => filter === 'all' || g.suggested_category === filter)
    .filter(g => !search ||
      g.suggested_name.toLowerCase().includes(search.toLowerCase()) ||
      (g.supplier_name ?? '').toLowerCase().includes(search.toLowerCase()))

  const totalKr   = visible.reduce((s, g) => s + g.total_kr, 0)
  const totalLines = visible.reduce((s, g) => s + g.line_count, 0)
  const doneCount = Object.values(edits).filter(e => e.done).length

  // Selection helpers — only "unresolved" rows can be selected
  function isSelectable(g: ReviewGroup) {
    const e = edits[g.group_key]
    return !e?.done && !e?.skipped && !e?.busy
  }
  const visibleSelectable = visible.filter(isSelectable)
  const selectedVisible = visibleSelectable.filter(g => selected.has(g.group_key))
  function toggle(groupKey: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey)
      return next
    })
  }
  function selectAllVisible() {
    setSelected(new Set([...selected, ...visibleSelectable.map(g => g.group_key)]))
  }
  function clearSelection() { setSelected(new Set()) }

  async function bulkApprove() {
    const items = visibleSelectable.filter(g => selected.has(g.group_key))
    if (items.length === 0) return
    if (!confirm(t('bulkApproveConfirm', { count: String(items.length) }))) return
    setBulkBusy({ done: 0, total: items.length })
    for (let i = 0; i < items.length; i++) {
      await approve(items[i])    // approve() already updates per-row state
      setBulkBusy({ done: i + 1, total: items.length })
    }
    setBulkBusy(null)
    clearSelection()
  }

  async function bulkSkip() {
    const items = visibleSelectable.filter(g => selected.has(g.group_key))
    if (items.length === 0) return
    if (!confirm(t('bulkSkipConfirm', { count: String(items.length) }))) return
    setBulkBusy({ done: 0, total: items.length })
    for (let i = 0; i < items.length; i++) {
      await skip(items[i])
      setBulkBusy({ done: i + 1, total: items.length })
    }
    setBulkBusy(null)
    clearSelection()
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 1280, padding: '20px 24px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
          {t('title')}
        </h1>
        <p style={{ margin: '4px 0 18px', fontSize: 12, color: UXP.ink3, maxWidth: 760, lineHeight: 1.5 }}>
          {t('subtitle')}
        </p>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <Stat label={t('kpiGroups')} value={String(data?.total_groups ?? 0)} />
          <Stat label={t('kpiLines')}  value={String(data?.total_lines  ?? 0)} />
          <Stat label={t('kpiSpend')}  value={fmtKr(totalKr)} />
          <Stat label={t('kpiApproved')} value={String(doneCount)} tone={doneCount > 0 ? 'green' : 'ink'} />
        </div>

        {/* Filters + search */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' as const, alignItems: 'center' }}>
          {CATEGORY_KEYS.map(key => {
            const count = key === 'all' ? (data?.counts?.all ?? 0) : (data?.counts?.[key] ?? 0)
            const active = filter === key
            let label: string
            try { label = ct(key) } catch { label = key }
            if (key === 'all') label = t('filterAll')
            return (
              <button key={key} onClick={() => setFilter(key)}
                style={{
                  padding: '6px 12px', fontSize: 11, fontWeight: 500,
                  background: active ? UXP.lavFill : 'transparent',
                  color: active ? UXP.lavText : UXP.ink3,
                  border: `0.5px solid ${active ? UXP.lavMid : UXP.border}`,
                  borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                }}>
                {label} <span style={{ color: active ? UXP.lavText : UXP.ink4, marginLeft: 4 }}>{count}</span>
              </button>
            )
          })}
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            style={{
              marginLeft: 'auto', padding: '5px 10px', fontSize: 12,
              background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
              borderRadius: 6, color: UXP.ink1, fontFamily: 'inherit',
              minWidth: 220,
            }} />
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

        {!loading && data && visible.length === 0 && (
          <div style={{
            padding: 30, textAlign: 'center' as const, color: UXP.ink3,
            fontSize: 13, background: UXP.cardBg,
            border: `0.5px solid ${UXP.border}`, borderRadius: 8,
          }}>
            {data.total_groups === 0 ? t('emptyAll') : t('emptyFiltered')}
          </div>
        )}

        {/* Bulk selection toolbar — only shown when there ARE selectable rows */}
        {!loading && visibleSelectable.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
            padding: '6px 12px', background: UXP.subtleBg,
            border: `0.5px solid ${UXP.border}`, borderRadius: 6, fontSize: 11,
          }}>
            <span style={{ color: UXP.ink3 }}>
              {t('bulkSelectedLabel', { selected: String(selectedVisible.length), visible: String(visibleSelectable.length) })}
            </span>
            <button onClick={selectAllVisible}
              disabled={selectedVisible.length === visibleSelectable.length}
              style={{
                padding: '2px 8px', fontSize: 11, background: 'transparent',
                color: UXP.lavText, border: `0.5px solid ${UXP.lavMid}`,
                borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}>
              {t('bulkSelectAll')}
            </button>
            {selectedVisible.length > 0 && (
              <button onClick={clearSelection}
                style={{
                  padding: '2px 8px', fontSize: 11, background: 'transparent',
                  color: UXP.ink3, border: `0.5px solid ${UXP.border}`,
                  borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                }}>
                {t('bulkClear')}
              </button>
            )}
          </div>
        )}

        {!loading && visible.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8, paddingBottom: selectedVisible.length > 0 ? 80 : 0 }}>
            {visible.map(g => {
              const e = edits[g.group_key] ?? { name: g.suggested_name, category: g.suggested_category }
              const isDone    = !!e.done
              const isSkipped = !!e.skipped
              const isResolved = isDone || isSkipped
              const cardBg = isDone ? UXP.greenFill : (isSkipped ? UXP.subtleBg : UXP.cardBg)
              const cardBorder = isDone ? UXP.green : (isSkipped ? UXP.border : UXP.border)
              return (
                <div key={g.group_key} style={{
                  background: cardBg,
                  border: `0.5px solid ${cardBorder}`,
                  borderRadius: 10, padding: '12px 14px',
                  opacity: isResolved ? 0.6 : 1,
                  transition: 'opacity 200ms, background 200ms',
                }}>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                    {/* Checkbox for bulk actions — disabled if already resolved or in flight */}
                    <input
                      type="checkbox"
                      checked={selected.has(g.group_key)}
                      disabled={isResolved || e.busy || !!bulkBusy}
                      onChange={() => toggle(g.group_key)}
                      style={{ marginTop: 8, cursor: isResolved || e.busy ? 'not-allowed' : 'pointer' }}
                    />
                    {/* LEFT: name + supplier + sample */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <input
                        type="text" value={e.name} disabled={isResolved || e.busy}
                        onChange={ev => setEdits(p => ({ ...p, [g.group_key]: { ...p[g.group_key], name: ev.target.value } }))}
                        style={{
                          width: '100%', padding: '4px 8px', fontSize: 13, fontWeight: 500,
                          background: isDone ? 'transparent' : '#fff',
                          border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                          color: UXP.ink1, fontFamily: 'inherit',
                        }} />
                      <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 5, lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 500, color: UXP.ink3 }}>{g.supplier_name ?? `#${g.supplier_fortnox_number}`}</span>
                        {g.unit && <span>· /{g.unit}</span>}
                        {g.most_common_account && <span>· BAS {g.most_common_account}</span>}
                        {!isResolved && !e.busy && (
                          <button
                            type="button"
                            onClick={() => skipSupplier(g)}
                            title={t('skipSupplierHint')}
                            style={{
                              padding: '1px 7px', fontSize: 9, fontWeight: 500,
                              background: 'transparent', color: UXP.ink3,
                              border: `0.5px solid ${UXP.border}`, borderRadius: 4,
                              cursor: 'pointer', fontFamily: 'inherit',
                              letterSpacing: '0.02em',
                            }}>
                            {t('skipSupplier')}
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2, fontStyle: 'italic' as const,
                                    overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                        {t('seenAs')} "{g.sample_raw_description}"
                      </div>
                    </div>

                    {/* MIDDLE: numeric facts */}
                    <div style={{ display: 'flex', gap: 14, fontSize: 11, color: UXP.ink2, alignItems: 'center', whiteSpace: 'nowrap' as const }}>
                      <Fact label={t('lines')}    value={`${g.line_count} / ${g.invoice_count}`} hint={t('linesHint')} />
                      <Fact label={t('totalKr')}  value={fmtKr(g.total_kr)} />
                      <Fact label={t('latestKr')} value={g.latest_price != null ? fmtKr(g.latest_price) : '—'} />
                      <Fact label={t('rangeKr')}  value={g.min_price != null && g.max_price != null
                        ? (g.min_price === g.max_price ? '—' : `${fmtKr(g.min_price)} – ${fmtKr(g.max_price)}`)
                        : '—'} />
                    </div>

                    {/* RIGHT: category + approve + skip */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select value={e.category} disabled={isResolved || e.busy}
                        onChange={ev => setEdits(p => ({ ...p, [g.group_key]: { ...p[g.group_key], category: ev.target.value } }))}
                        style={{
                          padding: '4px 6px', fontSize: 11,
                          background: '#fff', border: `0.5px solid ${UXP.border}`,
                          borderRadius: 5, color: UXP.ink1, fontFamily: 'inherit',
                        }}>
                        {(['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other'] as const).map(k => {
                          let l: string
                          try { l = ct(k) } catch { l = k }
                          return <option key={k} value={k}>{l}</option>
                        })}
                      </select>
                      <button
                        type="button"
                        onClick={() => approve(g)}
                        disabled={isResolved || e.busy || !e.name.trim()}
                        style={{
                          padding: '5px 14px', fontSize: 11, fontWeight: 600,
                          background: isDone ? UXP.green : (e.busy ? UXP.subtleBg : UXP.lavDeep),
                          color: '#fff',
                          border: 'none', borderRadius: 5,
                          cursor: isResolved || e.busy ? 'default' : 'pointer',
                          fontFamily: 'inherit',
                          minWidth: 80,
                        }}
                        title={isDone && e.was_existing ? t('linkedHint') : undefined}>
                        {isDone
                          ? (e.was_existing ? t('linked') : t('approved'))
                          : (e.busy ? t('approving') : t('approve'))}
                      </button>
                      <button
                        type="button"
                        onClick={() => skip(g)}
                        disabled={isResolved || e.busy}
                        title={t('skipHint')}
                        style={{
                          padding: '5px 10px', fontSize: 11, fontWeight: 500,
                          background: 'transparent',
                          color: isSkipped ? UXP.ink3 : UXP.ink2,
                          border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                          cursor: isResolved || e.busy ? 'default' : 'pointer',
                          fontFamily: 'inherit',
                          minWidth: 70,
                        }}>
                        {isSkipped ? t('skipped') : t('skip')}
                      </button>
                      {isResolved && !e.busy && (
                        <button
                          type="button"
                          onClick={() => (isDone ? undoApprove(g) : undoSkip(g))}
                          title={t('undoHint')}
                          style={{
                            padding: '5px 10px', fontSize: 11, fontWeight: 500,
                            background: 'transparent', color: UXP.ink2,
                            border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                            cursor: 'pointer', fontFamily: 'inherit',
                            minWidth: 60,
                          }}>
                          {t('undo')}
                        </button>
                      )}
                    </div>
                  </div>
                  {e.err && (
                    <div style={{
                      marginTop: 8, padding: '6px 10px',
                      background: UXP.roseFill, color: UXP.roseText,
                      fontSize: 11, borderRadius: 5,
                    }}>
                      {e.err}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Sticky bulk-action footer */}
      {(selectedVisible.length > 0 || bulkBusy) && (
        <div style={{
          position: 'fixed' as const, bottom: 0, left: 0, right: 0,
          background: '#fff', borderTop: `0.5px solid ${UXP.border}`,
          padding: '10px 24px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 14,
          boxShadow: '0 -4px 16px rgba(58,53,80,0.08)',
          zIndex: 50,
        }}>
          <div style={{ fontSize: 12, color: UXP.ink2 }}>
            {bulkBusy
              ? t('bulkInProgress', { done: String(bulkBusy.done), total: String(bulkBusy.total) })
              : t('bulkFooterLabel', { count: String(selectedVisible.length) })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={bulkSkip} disabled={!!bulkBusy}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 500,
                background: 'transparent', color: UXP.ink2,
                border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                cursor: bulkBusy ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
              {t('bulkSkip')}
            </button>
            <button onClick={bulkApprove} disabled={!!bulkBusy}
              style={{
                padding: '6px 18px', fontSize: 12, fontWeight: 600,
                background: UXP.lavDeep, color: '#fff',
                border: 'none', borderRadius: 5,
                cursor: bulkBusy ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
              {t('bulkApprove')}
            </button>
          </div>
        </div>
      )}
    </AppShell>
  )
}

function Stat({ label, value, tone = 'ink' }: { label: string; value: string; tone?: 'ink' | 'green' }) {
  return (
    <div style={{
      background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
      borderRadius: 8, padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600,
                    letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600,
                    color: tone === 'green' ? UXP.greenDeep : UXP.ink1,
                    marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end' }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.03em',
                    textTransform: 'uppercase' as const, fontWeight: 600 }}
           title={hint}>{label}</div>
      <div style={{ fontSize: 12, color: UXP.ink1, fontWeight: 500, fontVariantNumeric: 'tabular-nums' as const }}>
        {value}
      </div>
    </div>
  )
}
