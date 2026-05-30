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
  // AI suggestions — keyed by group_key. Populated by the "AI sort" button.
  // confidence ∈ [0, 1]. action ∈ approve_existing|create_new|skip_non_inventory|review.
  type AISuggestion = {
    action: 'approve_existing' | 'create_new' | 'skip_non_inventory' | 'review'
    confidence: number
    product_id?: string | null
    suggested_name?: string | null
    suggested_category?: string | null
    reasoning?: string | null
  }
  const [ai, setAi] = useState<Record<string, AISuggestion>>({})
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSummary, setAiSummary] = useState<{ total: number; cached: boolean | 'partial' } | null>(null)

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

  // Load AI suggestions for the current needs_review queue. Cached 24h
  // server-side so repeat loads don't re-bill. force=true forces fresh.
  const loadAi = useCallback(async (force = false) => {
    if (!bizId) return
    setAiBusy(true)
    try {
      const r = await fetch('/api/inventory/review/ai-suggest', {
        method:  'POST',
        cache:   'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, force }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      const map: Record<string, AISuggestion> = {}
      for (const s of (j.suggestions ?? [])) {
        map[s.group_key] = {
          action:             s.action,
          confidence:         Number(s.confidence ?? 0),
          product_id:         s.product_id ?? null,
          suggested_name:     s.suggested_name ?? null,
          suggested_category: s.suggested_category ?? null,
          reasoning:          s.reasoning ?? null,
        }
      }
      setAi(map)
      setAiSummary({ total: (j.suggestions ?? []).length, cached: j.cached ?? false })
    } catch (e: any) {
      setError(`AI suggestions failed: ${e.message}`)
    } finally {
      setAiBusy(false)
    }
  }, [bizId])

  // Fire-and-forget outcome logger — captures what owner did vs what AI
  // suggested. Failures here MUST never block the owner action.
  function logOutcome(groupKey: string, ownerAction: string, ownerProductId?: string | null, ownerChosenName?: string | null) {
    if (!bizId) return
    fetch('/api/inventory/review/learn', {
      method:  'POST',
      cache:   'no-store',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        business_id:        bizId,
        group_key:          groupKey,
        ai_suggestion:      ai[groupKey] ?? null,
        owner_action:       ownerAction,
        owner_product_id:   ownerProductId ?? null,
        owner_chosen_name:  ownerChosenName ?? null,
      }),
    }).catch(() => { /* soft fail */ })
  }

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
      // Learning signal — log what AI suggested vs what owner did.
      // approve_existing if existing product was matched; create_new otherwise.
      logOutcome(
        group.group_key,
        j.was_existing ? 'approve_existing' : 'create_new',
        j.product_id ?? null,
        e.name.trim(),
      )
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
      logOutcome(group.group_key, 'skip_non_inventory')
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

        {/* Audit spot-check banner — soft, dismissible-for-the-day. Lives
            adjacent to review per LEARNING-LOOP-PHASE1-PLAN.md §2b UX
            note (audit must FEEL like a low-pressure spot-check, not
            another to-do queue). Hidden when nothing's pending or when
            the owner clicked "hide for today". */}
        <AuditBanner bizId={bizId} />

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

        {/* AI assist bar — sits below filters, above the bulk toolbar */}
        {!loading && visible.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
            padding: '8px 12px',
            background: Object.keys(ai).length > 0 ? UXP.lavFill : UXP.subtleBg,
            border: `0.5px solid ${Object.keys(ai).length > 0 ? UXP.lavMid : UXP.border}`,
            borderRadius: 8, fontSize: 11,
            flexWrap: 'wrap' as const,
          }}>
            <span style={{ fontSize: 10, color: UXP.lavText, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>AI</span>
            <button
              type="button"
              onClick={() => loadAi(Object.keys(ai).length > 0)}
              disabled={aiBusy}
              style={{
                padding: '5px 12px', fontSize: 11, fontWeight: 600,
                background: UXP.lavMid, color: '#fff',
                border: 'none', borderRadius: 6,
                cursor: aiBusy ? 'wait' : 'pointer', fontFamily: 'inherit',
                opacity: aiBusy ? 0.6 : 1,
              }}>
              {aiBusy
                ? 'AI thinking…'
                : Object.keys(ai).length > 0 ? 'Refresh AI suggestions' : 'AI sort (suggest actions)'}
            </button>
            {aiSummary && (
              <span style={{ color: UXP.ink3 }}>
                {aiSummary.total} suggestion{aiSummary.total === 1 ? '' : 's'}
                {aiSummary.cached === true && ' (cached)'}
                {aiSummary.cached === 'partial' && ' (partial cache)'}
              </span>
            )}
            {Object.keys(ai).length > 0 && (() => {
              // Threshold of 0.65 matches the AI's own self-imposed cutoff:
              // confidence < 0.65 gets classified as 'review' action (deferred
              // to owner). So anything NOT marked 'review' has the AI's own
              // signal that it's "fairly sure or better" — safe to bulk apply.
              const APPLY_THRESHOLD = 0.65
              const hiConf = visible.filter(g => !edits[g.group_key]?.done && !edits[g.group_key]?.skipped && ai[g.group_key] && ai[g.group_key].confidence >= APPLY_THRESHOLD && ai[g.group_key].action !== 'review')
              const hiConfApprove = hiConf.filter(g => ai[g.group_key].action === 'approve_existing' || ai[g.group_key].action === 'create_new')
              const hiConfSkip    = hiConf.filter(g => ai[g.group_key].action === 'skip_non_inventory')
              return (
                <>
                  <span style={{ color: UXP.ink3 }}>
                    · {hiConfApprove.length} approve · {hiConfSkip.length} skip · {hiConf.length} total ≥65%
                  </span>
                  {hiConf.length > 0 && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm(`Apply ${hiConf.length} AI suggestions? ${hiConfApprove.length} approve + ${hiConfSkip.length} skip.`)) return
                        setBulkBusy({ done: 0, total: hiConf.length })
                        for (let i = 0; i < hiConf.length; i++) {
                          const g = hiConf[i]
                          const s = ai[g.group_key]
                          // For approve_existing/create_new: set name/category from AI, then approve.
                          if (s.action === 'approve_existing' || s.action === 'create_new') {
                            if (s.suggested_name) {
                              setEdits(prev => ({ ...prev, [g.group_key]: {
                                ...prev[g.group_key],
                                name: s.suggested_name!,
                                category: s.suggested_category ?? prev[g.group_key]?.category ?? g.suggested_category,
                              } }))
                              // give React a tick to commit the state before approve() reads it
                              await new Promise(r => setTimeout(r, 0))
                            }
                            await approve(g)
                          } else if (s.action === 'skip_non_inventory') {
                            await skip(g)
                          }
                          setBulkBusy({ done: i + 1, total: hiConf.length })
                        }
                        setBulkBusy(null)
                      }}
                      style={{
                        marginLeft: 'auto',
                        padding: '5px 14px', fontSize: 11, fontWeight: 600,
                        background: UXP.ink1, color: '#fff',
                        border: 'none', borderRadius: 6,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}>
                      Apply all ≥85%
                    </button>
                  )}
                </>
              )
            })()}
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
                      {/* AI suggestion badge — only when an AI run has produced one for this group */}
                      {ai[g.group_key] && !isResolved && (() => {
                        const s = ai[g.group_key]
                        const conf = Math.round(s.confidence * 100)
                        const tone = s.confidence >= 0.85 ? 'high' : s.confidence >= 0.65 ? 'mid' : 'low'
                        const palette = tone === 'high'
                          ? { bg: UXP.lavFill, border: UXP.lavMid, fg: UXP.lavText }
                          : tone === 'mid'
                            ? { bg: UXP.subtleBg, border: UXP.border, fg: UXP.ink2 }
                            : { bg: UXP.subtleBg, border: UXP.border, fg: UXP.ink3 }
                        const label =
                          s.action === 'approve_existing'  ? `Link to existing product${s.suggested_name ? `: ${s.suggested_name}` : ''}`
                          : s.action === 'create_new'      ? `Add as "${s.suggested_name ?? '?'}" (${s.suggested_category ?? '?'})`
                          : s.action === 'skip_non_inventory' ? 'Skip — not inventory'
                          : 'Review'
                        const canApply = s.action !== 'review' && s.confidence >= 0.5
                        return (
                          <div style={{
                            marginTop: 8, padding: '5px 9px',
                            background: palette.bg, border: `0.5px solid ${palette.border}`,
                            borderRadius: 6, fontSize: 11, color: palette.fg,
                            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const,
                          }}>
                            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, color: palette.fg, opacity: 0.7 }}>AI</span>
                            <span style={{ fontWeight: 500 }}>{label}</span>
                            <span style={{ fontSize: 10, color: palette.fg, opacity: 0.75 }}>({conf}% confident)</span>
                            {s.reasoning && (
                              <span style={{ fontSize: 10, color: palette.fg, opacity: 0.7, fontStyle: 'italic' as const, marginLeft: 4 }} title={s.reasoning}>
                                · {s.reasoning.slice(0, 80)}
                              </span>
                            )}
                            {canApply && (
                              <button
                                type="button"
                                disabled={e.busy || !!bulkBusy}
                                onClick={async () => {
                                  if (s.action === 'approve_existing' || s.action === 'create_new') {
                                    if (s.suggested_name) {
                                      setEdits(prev => ({ ...prev, [g.group_key]: {
                                        ...prev[g.group_key],
                                        name: s.suggested_name!,
                                        category: s.suggested_category ?? prev[g.group_key]?.category ?? g.suggested_category,
                                      } }))
                                      await new Promise(r => setTimeout(r, 0))
                                    }
                                    await approve(g)
                                  } else if (s.action === 'skip_non_inventory') {
                                    await skip(g)
                                  }
                                }}
                                style={{
                                  marginLeft: 'auto',
                                  padding: '3px 10px', fontSize: 10, fontWeight: 600,
                                  background: tone === 'high' ? UXP.ink1 : 'transparent',
                                  color: tone === 'high' ? '#fff' : palette.fg,
                                  border: tone === 'high' ? 'none' : `0.5px solid ${palette.border}`,
                                  borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                                }}>
                                Apply
                              </button>
                            )}
                          </div>
                        )
                      })()}
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

// AuditBanner — soft adjacent surface on /inventory/review. Fetches the
// pending audit-queue count and shows a one-line link unless the owner
// dismissed it for the day. Quiet by design — frames as spot-check, not
// to-do. Per LEARNING-LOOP-PHASE1-PLAN.md §2b owner UX note.
function AuditBanner({ bizId }: { bizId: string | null }) {
  const [pending,   setPending]   = useState(0)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // localStorage key holds an ISO timestamp; banner hidden until then.
    try {
      const until = localStorage.getItem('cc_audit_banner_dismissed_until')
      if (until && new Date(until).getTime() > Date.now()) setDismissed(true)
    } catch {}
  }, [])

  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    fetch(`/api/inventory/audit?business_id=${encodeURIComponent(bizId)}&limit=1`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled) setPending(Number(j?.pending_count ?? 0)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bizId])

  if (dismissed || pending === 0 || !bizId) return null

  function hideForToday() {
    try {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      localStorage.setItem('cc_audit_banner_dismissed_until', until)
      setDismissed(true)
    } catch {}
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
      padding: '10px 14px',
      background: UXP.lavFill,
      border: `0.5px solid ${UXP.lavMid}`,
      borderRadius: 8,
      fontSize: 12,
    }}>
      <span style={{
        fontSize: 10, padding: '2px 8px',
        background: UXP.lavMid, color: '#fff',
        borderRadius: 999, fontWeight: 600, letterSpacing: '0.04em',
      }}>QUICK CHECK</span>
      <span style={{ color: UXP.ink2 }}>
        <strong style={{ color: UXP.ink1, fontWeight: 600 }}>{pending}</strong> auto-match{pending === 1 ? '' : 'es'} ready to spot-check.
      </span>
      <a href="/inventory/audit" style={{
        color: UXP.lavText, fontWeight: 600, textDecoration: 'none', marginLeft: 'auto',
      }}>
        Review →
      </a>
      <button onClick={hideForToday} style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: UXP.ink4, fontSize: 11, padding: '2px 6px', fontFamily: 'inherit',
      }}>
        Hide for today
      </button>
    </div>
  )
}
