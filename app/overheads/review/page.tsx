'use client'
// app/overheads/review/page.tsx
//
// Two-pane (list + detail) overhead-review page. Replaces the legacy
// scrollable-list-of-cards layout. Right pane = "email client" detail
// view: AI explanation, 12-month price chart, period chips + invoice
// drilldown, related-periods card.
//
// The page is a thin orchestrator — fetches the flags list once, groups
// by `${supplier}::${category}`, and threads the selected group into
// FlagDetailPane. The detail pane fires its own follow-up requests for
// supplier-history and per-period drilldown.
//
// Mobile: at <880px the layout collapses to single-pane navigation
// (list → detail → back).

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import PageHero from '@/components/ui/PageHero'
import { UX } from '@/lib/constants/tokens'
import HeadlineStrip from '@/components/overheads/HeadlineStrip'
import FlagListPane  from '@/components/overheads/FlagListPane'
import FlagDetailPane from '@/components/overheads/FlagDetailPane'
import type { Flag, FlagGroup, FlagTypeFilter, CategoryFilter } from '@/components/overheads/types'

interface Business { id: string; name: string }

interface FlagsResponse {
  flags:                     Flag[]
  total_pending:             number
  total_monthly_savings_sek: number
  table_missing:             boolean
  stats?: {
    decided_last_90d:                number
    dismissed_savings_last_90d_sek:  number
  }
  note?: string
}

const MOBILE_BREAKPOINT = 880

export default function OverheadReviewPage() {
  const t  = useTranslations('overheads.review')

  // ── Business selection (mirrors legacy page) ──────────────────────────
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [bizId,      setBizId]      = useState<string | null>(null)
  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const id = (saved && data.find(b => b.id === saved)) ? saved : data[0].id
      setBizId(id)
    }).catch(() => {})
    const onStorage = () => {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // ── Data state ────────────────────────────────────────────────────────
  const [flags,        setFlags]        = useState<Flag[]>([])
  const [stats,        setStats]        = useState<FlagsResponse['stats']>()
  const [totalSavings, setTotalSavings] = useState<number>(0)
  const [loading,      setLoading]      = useState<boolean>(true)
  const [tableMissing, setTableMissing] = useState<boolean>(false)
  const [error,        setError]        = useState<string | null>(null)
  const [deciding,     setDeciding]     = useState<string | null>(null)

  // URL-persisted "+ Resolved" toggle so refresh preserves the view.
  const [includeResolved, setIncludeResolved] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('include_resolved') === '1'
  })

  // Filters — purely client-side (single fetch, multiple filters).
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(() => {
    if (typeof window === 'undefined') return 'all'
    try { return (sessionStorage.getItem('cc_overheads_review_filter') as any) || 'all' } catch { return 'all' }
  })
  const [flagTypeFilter, setFlagTypeFilter] = useState<FlagTypeFilter>('all')
  const [search, setSearch] = useState('')

  // Selected (supplier, category) group — by composite key.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  // Mobile (single-pane) detection.
  const [isMobile, setIsMobile] = useState<boolean>(false)
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list')

  // ── Data fetch ────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ business_id: bizId, stats: '1' })
      if (includeResolved) params.set('include_resolved', '1')
      const r = await fetch(`/api/overheads/flags?${params.toString()}`, { cache: 'no-store' })
      const j: FlagsResponse = await r.json()
      if (!r.ok) throw new Error((j as any)?.error ?? 'load_failed')
      setFlags(j.flags ?? [])
      setStats(j.stats)
      setTotalSavings(j.total_monthly_savings_sek ?? 0)
      setTableMissing(j.table_missing ?? false)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load flags')
      setFlags([])
    } finally {
      setLoading(false)
    }
  }, [bizId, includeResolved])
  useEffect(() => { load() }, [load])

  // Persist filters/toggles.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { sessionStorage.setItem('cc_overheads_review_filter', categoryFilter) } catch {}
  }, [categoryFilter])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const u = new URL(window.location.href)
    if (includeResolved) u.searchParams.set('include_resolved', '1')
    else u.searchParams.delete('include_resolved')
    window.history.replaceState(null, '', u.toString())
  }, [includeResolved])

  // ── Derived: groups (post-filter) ─────────────────────────────────────
  const allGroups = useMemo<FlagGroup[]>(() => groupFlags(flags), [flags])

  const filteredGroups = useMemo<FlagGroup[]>(() => {
    return allGroups.filter(g => {
      const cat = g.latest.category ?? 'other_cost'
      if (categoryFilter !== 'all' && cat !== categoryFilter) return false
      if (flagTypeFilter !== 'all' && g.latest.flag_type !== flagTypeFilter) return false
      return true
    })
  }, [allGroups, categoryFilter, flagTypeFilter])

  // Default-select first group whenever the list changes; clear when empty.
  useEffect(() => {
    if (filteredGroups.length === 0) { setSelectedKey(null); return }
    if (!filteredGroups.find(g => g.key === selectedKey)) {
      setSelectedKey(filteredGroups[0].key)
    }
  }, [filteredGroups])  // eslint-disable-line react-hooks/exhaustive-deps

  const selectedGroup = useMemo<FlagGroup | null>(() => {
    if (!selectedKey) return null
    return filteredGroups.find(g => g.key === selectedKey) ?? null
  }, [filteredGroups, selectedKey])

  // ── Headline-strip computed numbers ───────────────────────────────────
  const headline = useMemo(() => {
    const pending = flags.filter(f => f.resolution_status === 'pending')
    const groups  = groupFlags(pending)
    const supplierCount = groups.length
    const flagCount     = pending.length
    const spike       = pending.filter(f => f.flag_type === 'price_spike')
    const reappeared  = pending.filter(f => f.flag_type === 'dismissed_reappeared')
    return {
      totalSavings,
      supplierCount,
      flagCount,
      priceSpikeCount:    spike.length,
      priceSpikeSavings:  Math.round(spike.reduce((s, f) => s + Number(f.amount_sek ?? 0), 0)),
      reappearedCount:    reappeared.length,
      reappearedSavings:  Math.round(reappeared.reduce((s, f) => s + Number(f.amount_sek ?? 0), 0)),
      decidedLast90d:     stats?.decided_last_90d ?? null,
      dismissedSavings90d:stats?.dismissed_savings_last_90d_sek ?? 0,
    }
  }, [flags, totalSavings, stats])

  // ── Decision handlers ────────────────────────────────────────────────
  async function decide(flagId: string, decision: 'essential' | 'dismissed' | 'deferred', reason?: string) {
    if (deciding) return
    setDeciding(flagId)
    setError(null)

    // Optimistic local removal — same scope as the existing endpoint:
    //   deferred  → snoozes only THIS flag (per-flag)
    //   essential / dismissed → bulk-resolves every pending flag for the
    //                            (supplier_normalised, category) group.
    const flag = flags.find(f => f.id === flagId)
    if (decision === 'deferred') {
      setFlags(prev => prev.filter(f => f.id !== flagId))
      if (flag) setTotalSavings(s => Math.max(0, s - Number(flag.amount_sek)))
    } else if (flag) {
      const fcat = flag.category ?? 'other_cost'
      const removed = flags.filter(f => f.supplier_name_normalised === flag.supplier_name_normalised && (f.category ?? 'other_cost') === fcat)
      const removedAmount = removed.reduce((s, f) => s + Number(f.amount_sek ?? 0), 0)
      setFlags(prev => prev.filter(f => !(f.supplier_name_normalised === flag.supplier_name_normalised && (f.category ?? 'other_cost') === fcat)))
      setTotalSavings(s => Math.max(0, s - removedAmount))
    }

    try {
      const r = await fetch(`/api/overheads/flags/${flagId}/decide`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ decision, reason: reason ?? null }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${r.status}`)
      }
      // Mobile: jump back to list after a successful bulk decide so the user
      // sees the next item.
      if (isMobile) setMobileView('list')
    } catch (e: any) {
      setError(e?.message ?? 'Decision failed')
      load()  // restore truth
    } finally {
      setDeciding(null)
    }
  }

  async function reexplain(flagId: string) {
    setError(null)
    const r = await fetch(`/api/overheads/explain/${flagId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      setError(j?.error ?? `HTTP ${r.status}`)
      return
    }
    setFlags(prev => prev.map(f => f.id === flagId
      ? { ...f, ai_explanation: j.ai_explanation, ai_confidence: j.ai_confidence }
      : f))
  }

  // ── Selection handler — switches to detail view on mobile ────────────
  function handleSelect(key: string) {
    setSelectedKey(key)
    if (isMobile) setMobileView('detail')
  }

  // ── Render ────────────────────────────────────────────────────────────
  const showListPane   = !isMobile || mobileView === 'list'
  const showDetailPane = !isMobile || mobileView === 'detail'

  return (
    <AppShell>
      <PageHero
        eyebrow={t('eyebrow')}
        headline={
          tableMissing
            ? t('headlineMissing')
            : allGroups.length === 0
              ? t('headlineEmpty')
              : t('headlinePending', { count: filteredGroups.length, amount: '' })
        }
      />

      <div style={{
        padding:   '0 24px 40px',
        maxWidth:  1500,
        margin:    '0 auto',
        // Final-line-of-defence: clip any horizontal overflow rather than
        // let it widen the page. Anything inside that wants to be wider
        // than the viewport gets cut off — the page itself stays put.
        width:     '100%',
        overflowX: 'hidden',
        boxSizing: 'border-box',
      }}>
        {error && <Banner tone="bad" text={error} />}
        {tableMissing && <Banner tone="warn" text={t('tableMissingBanner')} />}

        {!tableMissing && !loading && allGroups.length > 0 && (
          <HeadlineStrip
            totalSavings={headline.totalSavings}
            supplierCount={headline.supplierCount}
            flagCount={headline.flagCount}
            priceSpikeCount={headline.priceSpikeCount}
            priceSpikeSavings={headline.priceSpikeSavings}
            reappearedCount={headline.reappearedCount}
            reappearedSavings={headline.reappearedSavings}
            decidedLast90d={headline.decidedLast90d}
            dismissedSavings90d={headline.dismissedSavings90d}
          />
        )}

        {/* Category filter row — preserved from legacy page */}
        {!tableMissing && allGroups.length > 0 && (
          <CategoryRow
            value={categoryFilter}
            onChange={setCategoryFilter}
            counts={{
              all:        allGroups.length,
              other_cost: allGroups.filter(g => (g.latest.category ?? 'other_cost') === 'other_cost').length,
              food_cost:  allGroups.filter(g => g.latest.category === 'food_cost').length,
            }}
          />
        )}

        {loading && allGroups.length === 0 && (
          <Empty text={t('loadingFlags')} />
        )}
        {!loading && !tableMissing && allGroups.length === 0 && (
          <Empty text={t('emptyStable')} />
        )}

        {!loading && !tableMissing && allGroups.length > 0 && (
          <div style={panesStyle(isMobile)}>
            {showListPane && (
              <div style={isMobile
                ? { width: '100%', minWidth: 0 }
                : { width: 380, flex: '0 0 380px', minWidth: 0 }
              }>
                <FlagListPane
                  groups={filteredGroups}
                  rawFlags={flags}
                  selectedKey={selectedKey}
                  onSelect={handleSelect}
                  search={search}
                  onSearch={setSearch}
                  flagTypeFilter={flagTypeFilter}
                  onFlagType={setFlagTypeFilter}
                  includeResolved={includeResolved}
                  onToggleResolved={() => setIncludeResolved(v => !v)}
                  totalGroupCount={allGroups.length}
                />
              </div>
            )}

            {showDetailPane && bizId && (
              <div style={isMobile
                ? { width: '100%', minWidth: 0 }
                : { flex: '1 1 0', minWidth: 0, overflow: 'hidden' }
              }>
                {selectedGroup ? (
                  <FlagDetailPane
                    group={selectedGroup}
                    bizId={bizId}
                    busy={deciding != null}
                    onEssential={(id) => decide(id, 'essential')}
                    onPlanCancel={(id, r) => decide(id, 'dismissed', r)}
                    onDefer={(id) => decide(id, 'deferred')}
                    onReexplain={reexplain}
                    onBack={isMobile ? () => setMobileView('list') : undefined}
                  />
                ) : (
                  <DetailEmpty />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  )
}

// ────────────────────────────────────────────────────────────────────────
//   helpers
// ────────────────────────────────────────────────────────────────────────

function groupFlags(flags: Flag[]): FlagGroup[] {
  const map = new Map<string, FlagGroup>()
  for (const f of flags) {
    const cat = f.category ?? 'other_cost'
    const key = `${f.supplier_name_normalised}::${cat}`
    const periodKey = f.period_year * 100 + f.period_month
    const cur = map.get(key)
    if (!cur) {
      map.set(key, {
        key,
        latest:       f,
        others:       [],
        latestKey:    periodKey,
        pendingCount: f.resolution_status === 'pending' ? 1 : 0,
        totalAmount:  f.resolution_status === 'pending' ? Number(f.amount_sek ?? 0) : 0,
      })
    } else {
      if (periodKey > cur.latestKey) {
        cur.others.push(cur.latest)
        cur.latest = f
        cur.latestKey = periodKey
      } else {
        cur.others.push(f)
      }
      if (f.resolution_status === 'pending') {
        cur.pendingCount += 1
        cur.totalAmount  += Number(f.amount_sek ?? 0)
      }
    }
  }
  return Array.from(map.values())
    .sort((a, b) => Number(b.latest.amount_sek ?? 0) - Number(a.latest.amount_sek ?? 0))
}

function panesStyle(isMobile: boolean): React.CSSProperties {
  // Flexbox instead of CSS Grid — the previous `minmax(0, 1fr)` track
  // STILL let intrinsic-content widths bubble up under specific layouts
  // and widened the list-pane visually between selections. Flex with
  // explicit pixel widths on the pane wrappers (380px hard, flex:1 for
  // the rest) is fully deterministic.
  return {
    display:        isMobile ? 'block' : 'flex',
    flexDirection:  'row',
    gap:            14,
    minHeight:      isMobile ? undefined : 600,
    minWidth:       0,
    width:          '100%',
    alignItems:     'stretch',
  }
}

// ────────────────────────────────────────────────────────────────────────
//   small components (banners, empty, category row)
// ────────────────────────────────────────────────────────────────────────

function Banner({ tone, text }: { tone: 'bad' | 'warn' | 'ok'; text: string }) {
  const palette = tone === 'bad'
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' }
    : tone === 'warn'
    ? { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' }
    : { bg: '#ecfdf5', border: '#a7f3d0', fg: '#065f46' }
  return (
    <div style={{
      background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg,
      borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12,
    }}>
      {text}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{
      background: 'white', border: `1px solid ${UX.borderSoft}`, borderRadius: 10,
      padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: 13,
    }}>
      {text}
    </div>
  )
}

function CategoryRow({ value, onChange, counts }: {
  value:    CategoryFilter
  onChange: (v: CategoryFilter) => void
  counts:   { all: number; other_cost: number; food_cost: number }
}) {
  const t = useTranslations('overheads.review.filter')
  if (counts.other_cost === 0 && counts.food_cost === 0) return null
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' as const }}>
      <CatBtn active={value === 'all'} onClick={() => onChange('all')}>
        {t('all')} <Pill>{counts.all}</Pill>
      </CatBtn>
      {counts.other_cost > 0 && (
        <CatBtn active={value === 'other_cost'} onClick={() => onChange('other_cost')}>
          {t('overheads')} <Pill>{counts.other_cost}</Pill>
        </CatBtn>
      )}
      {counts.food_cost > 0 && (
        <CatBtn active={value === 'food_cost'} onClick={() => onChange('food_cost')}>
          {t('food')} <Pill>{counts.food_cost}</Pill>
        </CatBtn>
      )}
    </div>
  )
}

function CatBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding:      '6px 12px',
        background:   active ? UX.ink1 : 'white',
        color:        active ? 'white' : UX.ink2,
        border:       `1px solid ${active ? UX.ink1 : UX.borderSoft}`,
        borderRadius: 999,
        fontSize:     12,
        fontWeight:   active ? 600 : 500,
        cursor:       'pointer',
        display:      'inline-flex',
        alignItems:   'center',
        gap:          6,
      }}
    >
      {children}
    </button>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      padding: '1px 6px', borderRadius: 999,
      background: 'rgba(255,255,255,0.18)', color: 'inherit',
    }}>
      {children}
    </span>
  )
}

function DetailEmpty() {
  const t = useTranslations('overheads.review.detail')
  return (
    <div style={{
      background:    'white',
      border:        `1px solid ${UX.border}`,
      borderRadius:  UX.r_lg,
      display:       'grid',
      placeItems:    'center',
      padding:       48,
      textAlign:     'center' as const,
    }}>
      <div>
        <div style={{ fontSize: 36, color: UX.ink4, opacity: 0.4, marginBottom: 12 }}>○</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: UX.ink3, marginBottom: 4 }}>
          {t('emptyTitle')}
        </div>
        <div style={{ fontSize: 13, color: UX.ink4, maxWidth: 320 }}>
          {t('emptyBody')}
        </div>
      </div>
    </div>
  )
}
