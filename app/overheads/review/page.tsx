'use client'
// app/overheads/review/page.tsx
//
// Owner-facing review queue for overhead flags. One card per supplier
// (not per flag) — decisions are supplier-wide so showing five Lokalhyra
// rows from five different months would mean five clicks for one
// decision. The card surfaces the LATEST period's data plus a
// "also flagged in: …" footer if the supplier appears in multiple
// periods.
//
// FIXES.md §0ap (initial), §0aq (real-data fixes).

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import PageHero from '@/components/ui/PageHero'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Business { id: string; name: string }
interface Flag {
  id:                       string
  supplier_name:            string
  supplier_name_normalised: string
  category:                 'other_cost' | 'food_cost'
  flag_type:                'new_supplier' | 'price_spike' | 'dismissed_reappeared' | 'one_off_high' | 'duplicate_supplier'
  reason:                   string | null
  amount_sek:               number
  prior_avg_sek:            number | null
  period_year:              number
  period_month:             number
  ai_explanation:           string | null
  ai_confidence:            number | null
}

const CATEGORY_TONE: Record<string, { bg: string; fg: string; labelKey: 'overhead' | 'food' }> = {
  other_cost: { bg: '#f3f4f6', fg: '#374151', labelKey: 'overhead' },
  food_cost:  { bg: '#fef3c7', fg: '#92400e', labelKey: 'food' },
}

interface FlagsResponse {
  flags:                     Flag[]
  total_pending:             number
  total_monthly_savings_sek: number
  table_missing:             boolean
  note?:                     string
}

const FLAG_TONE: Record<string, { bg: string; fg: string; toneKey: 'new' | 'priceTpl' | 'reappeared' | 'oneOff' | 'duplicate' }> = {
  new_supplier:         { bg: '#eff6ff', fg: '#1e40af', toneKey: 'new' },
  price_spike:          { bg: '#fef3c7', fg: '#92400e', toneKey: 'priceTpl' },
  dismissed_reappeared: { bg: '#fee2e2', fg: '#991b1b', toneKey: 'reappeared' },
  one_off_high:         { bg: '#f3f4f6', fg: '#374151', toneKey: 'oneOff' },
  duplicate_supplier:   { bg: '#f5f3ff', fg: '#6b21a8', toneKey: 'duplicate' },
}

export default function OverheadReviewPage() {
  const t  = useTranslations('overheads.review')
  const tM = useTranslations('overheads')
  const monthsShort: string[] = (tM.raw('months.short') as string[]) ?? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [flags,      setFlags]      = useState<Flag[]>([])
  const [totalSavings, setTotalSavings] = useState<number>(0)
  const [loading,    setLoading]    = useState<boolean>(true)
  const [tableMissing, setTableMissing] = useState<boolean>(false)
  const [error,      setError]      = useState<string | null>(null)
  const [deciding,   setDeciding]   = useState<string | null>(null)
  // Category filter — Food / Overheads / All. Persists per session.
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'other_cost' | 'food_cost'>(() => {
    if (typeof window === 'undefined') return 'all'
    try { return (sessionStorage.getItem('cc_overheads_review_filter') as any) || 'all' } catch { return 'all' }
  })
  // Backfill state — only show banner for businesses that have line items
  // but no classifications yet (the "first-time owner" case).
  const [showBackfillBanner, setShowBackfillBanner] = useState<boolean>(false)
  const [backfilling, setBackfilling] = useState<boolean>(false)
  const [backfillResult, setBackfillResult] = useState<{ marked: number; resolved: number } | null>(null)

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

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/overheads/flags?business_id=${bizId}`, { cache: 'no-store' })
      const j: FlagsResponse = await r.json()
      if (!r.ok) throw new Error((j as any)?.error ?? 'load_failed')
      setFlags(j.flags ?? [])
      setTotalSavings(j.total_monthly_savings_sek ?? 0)
      setTableMissing(j.table_missing ?? false)

      // Decide backfill-banner visibility: only show when there are pending
      // flags AND the owner hasn't started classifying yet. We approximate
      // "hasn't classified" by asking the projection endpoint — if it
      // reports zero from-pending savings while flags exist, that's not it;
      // we want zero classifications. Simpler: if pending count is high
      // (>10) and no flag has been resolved yet, show the banner. Tunable.
      if (!j.table_missing) {
        const includeAll = await fetch(`/api/overheads/flags?business_id=${bizId}&include_resolved=1`, { cache: 'no-store' })
        const allJ = await includeAll.json()
        const totalEver = (allJ.flags ?? []).length
        const anyResolved = (allJ.flags ?? []).some((f: any) => f.resolution_status !== 'pending')
        setShowBackfillBanner(totalEver > 10 && !anyResolved && (j.flags?.length ?? 0) > 0)
      } else {
        setShowBackfillBanner(false)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load flags')
      setFlags([])
    } finally {
      setLoading(false)
    }
  }, [bizId])

  useEffect(() => { load() }, [load])

  async function decide(flagId: string, decision: 'essential' | 'dismissed' | 'deferred', reason?: string) {
    if (deciding) return
    setDeciding(flagId)
    setError(null)
    const flag = flags.find(f => f.id === flagId)
    // Optimistic: 'deferred' removes only this flag (per-flag snooze).
    // 'essential' / 'dismissed' bulk-resolve every pending flag for the
    // supplier — mirror that in local state so the UI doesn't lag.
    if (decision === 'deferred') {
      setFlags(prev => prev.filter(f => f.id !== flagId))
      if (flag) setTotalSavings(s => Math.max(0, s - Number(flag.amount_sek)))
    } else if (flag) {
      // Bulk-resolve scoped to (supplier, category) — matches the decide
      // endpoint's category-aware bulk update.
      const flagCategory = flag.category ?? 'other_cost'
      const removedAmount = flags
        .filter(f => f.supplier_name_normalised === flag.supplier_name_normalised
                  && (f.category ?? 'other_cost') === flagCategory)
        .reduce((s, f) => s + Number(f.amount_sek), 0)
      setFlags(prev => prev.filter(f => !(f.supplier_name_normalised === flag.supplier_name_normalised
                                       && (f.category ?? 'other_cost') === flagCategory)))
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
    } catch (e: any) {
      setError(e?.message ?? 'Decision failed')
      // Re-load to restore truth.
      load()
    } finally {
      setDeciding(null)
    }
  }

  async function reexplain(flagId: string) {
    setError(null)
    try {
      const r = await fetch(`/api/overheads/explain/${flagId}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      // Patch the local flag with the fresh explanation so the card updates
      // immediately without a full reload.
      setFlags(prev => prev.map(f => f.id === flagId
        ? { ...f, ai_explanation: j.ai_explanation, ai_confidence: j.ai_confidence }
        : f))
    } catch (e: any) {
      setError(e?.message ?? 'Re-explain failed')
    }
  }

  async function runBackfill() {
    if (!bizId || backfilling) return
    setBackfilling(true)
    setError(null)
    try {
      const r = await fetch('/api/overheads/backfill', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, months: 12 }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      setBackfillResult({ marked: j.suppliers_marked_essential ?? 0, resolved: j.flags_resolved ?? 0 })
      setShowBackfillBanner(false)
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Backfill failed')
    } finally {
      setBackfilling(false)
    }
  }

  // Group flags by supplier_name_normalised. Decisions are supplier-wide,
  // so showing N cards for N months of the same supplier creates N×decision
  // fatigue. The grouped card surfaces the LATEST period's flag data with
  // the absolute amount + a footer listing other periods this supplier
  // showed up in.
  const grouped = useMemo(() => {
    const map = new Map<string, { latest: Flag; others: Flag[]; latestKey: number }>()
    for (const f of flags) {
      // Apply the category filter BEFORE grouping so a filtered-out flag
      // doesn't pollute the latest-period selection for its supplier-group.
      const cat = f.category ?? 'other_cost'
      if (categoryFilter !== 'all' && cat !== categoryFilter) continue

      // Key by (supplier, category) — M041 made decisions category-scoped,
      // so a supplier appearing in both food_cost and other_cost should
      // surface as two separate cards.
      const key = `${f.supplier_name_normalised}::${cat}`
      const periodKey = f.period_year * 100 + f.period_month  // sortable
      const cur = map.get(key)
      if (!cur || periodKey > cur.latestKey) {
        const others = cur ? [...cur.others, cur.latest] : []
        map.set(key, { latest: f, others, latestKey: periodKey })
      } else {
        cur.others.push(f)
      }
    }
    // Order by latest amount desc — biggest savings opportunities first.
    return Array.from(map.values())
      .sort((a, b) => Number(b.latest.amount_sek) - Number(a.latest.amount_sek))
  }, [flags, categoryFilter])

  // Persist the filter so it survives a refresh.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { sessionStorage.setItem('cc_overheads_review_filter', categoryFilter) } catch {}
  }, [categoryFilter])

  // Per-category counts for the filter buttons (compute from raw flags so
  // the active filter doesn't hide the unread counts).
  const categoryCounts = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const f of flags) {
      const cat = f.category ?? 'other_cost'
      const key = `${f.supplier_name_normalised}::${cat}`
      if (!map.has(cat)) map.set(cat, new Set())
      map.get(cat)!.add(key)
    }
    return {
      all:        Array.from(map.values()).reduce((s, set) => s + set.size, 0),
      other_cost: map.get('other_cost')?.size ?? 0,
      food_cost:  map.get('food_cost')?.size ?? 0,
    }
  }, [flags])

  // "At stake" = sum of LATEST amount per unique supplier. Showing the raw
  // sum across all periods would multi-count Lokalhyra appearing 5 months in
  // a row.
  const dedupedAtStake = useMemo(
    () => grouped.reduce((s, g) => s + Number(g.latest.amount_sek), 0),
    [grouped],
  )

  // Period summary — flags can span multiple months when the worker was
  // first kicked off across a year of historical data. Show range or single.
  const periodLabel = useMemo(() => {
    if (grouped.length === 0) return ''
    const periods = grouped.map(g => g.latestKey)
    const earliestKey = Math.min(...periods)
    const latestKey   = Math.max(...periods)
    const earliest = `${monthsShort[(earliestKey % 100) - 1]} ${Math.floor(earliestKey / 100)}`
    const latest   = `${monthsShort[(latestKey   % 100) - 1]} ${Math.floor(latestKey   / 100)}`
    return earliest === latest ? latest : `${earliest} – ${latest}`
  }, [grouped, monthsShort])

  return (
    <AppShell>
      <PageHero
        eyebrow={t('eyebrow')}
        headline={
          grouped.length > 0
            ? t('headlinePending', { count: grouped.length, amount: fmtKr(dedupedAtStake) })
            : tableMissing
              ? t('headlineMissing')
              : t('headlineEmpty')
        }
        context={grouped.length > 0
          ? t('context', { count: flags.length, period: periodLabel })
          : undefined}
      />

      <div style={{ padding: '0 24px 40px', maxWidth: 960, margin: '0 auto' }}>
        {error && <Banner tone="bad" text={error} />}
        {tableMissing && (
          <Banner tone="warn" text={t('tableMissingBanner')} />
        )}

        {showBackfillBanner && !backfillResult && (
          <BackfillBanner
            onConfirm={runBackfill}
            onDismiss={() => setShowBackfillBanner(false)}
            busy={backfilling}
          />
        )}

        {backfillResult && (
          <Banner
            tone="ok"
            text={t('backfillResult', { marked: backfillResult.marked, resolved: backfillResult.resolved })}
          />
        )}

        {/* Category filter — only render once we know there are categorised
            flags (avoids confusing a fresh-empty user with three buttons). */}
        {(categoryCounts.other_cost > 0 || categoryCounts.food_cost > 0) && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' as const }}>
            <CategoryButton active={categoryFilter === 'all'}        onClick={() => setCategoryFilter('all')}>
              {t('filter.all')} <Count>{categoryCounts.all}</Count>
            </CategoryButton>
            {categoryCounts.other_cost > 0 && (
              <CategoryButton active={categoryFilter === 'other_cost'} onClick={() => setCategoryFilter('other_cost')}>
                {t('filter.overheads')} <Count>{categoryCounts.other_cost}</Count>
              </CategoryButton>
            )}
            {categoryCounts.food_cost > 0 && (
              <CategoryButton active={categoryFilter === 'food_cost'}  onClick={() => setCategoryFilter('food_cost')}>
                {t('filter.food')} <Count>{categoryCounts.food_cost}</Count>
              </CategoryButton>
            )}
          </div>
        )}

        {loading && grouped.length === 0 && (
          <Empty text={t('loadingFlags')} />
        )}

        {!loading && !tableMissing && grouped.length === 0 && (
          <Empty text={t('emptyStable')} />
        )}

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
          {grouped.map(g => (
            <FlagCard
              key={g.latest.id}
              flag={g.latest}
              otherPeriods={g.others}
              busy={deciding === g.latest.id}
              onEssential={() => decide(g.latest.id, 'essential')}
              onDismiss={(reason) => decide(g.latest.id, 'dismissed', reason)}
              onDefer={() => decide(g.latest.id, 'deferred')}
              onReexplain={() => reexplain(g.latest.id)}
            />
          ))}
        </div>
      </div>
    </AppShell>
  )
}

// ────────────────────────────────────────────────────────────────────
//   FlagCard
// ────────────────────────────────────────────────────────────────────

function FlagCard({ flag, otherPeriods, busy, onEssential, onDismiss, onDefer, onReexplain }: {
  flag:         Flag
  otherPeriods: Flag[]
  busy:         boolean
  onEssential: () => void
  onDismiss:   (reason?: string) => void
  onDefer:     () => void
  onReexplain: () => Promise<void>
}) {
  const t  = useTranslations('overheads.review')
  const tCat = useTranslations('overheads.categories')
  const tM = useTranslations('overheads')
  const monthsShort: string[] = (tM.raw('months.short') as string[]) ?? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [showDismissModal, setShowDismissModal] = useState<boolean>(false)
  const [dismissReason,    setDismissReason]    = useState<string>('')
  const [reexplaining,     setReexplaining]     = useState<boolean>(false)

  const tone = FLAG_TONE[flag.flag_type] ?? FLAG_TONE.new_supplier
  // Sign-correct % for PRICE flags. The bug was: prepending "+" then letting
  // a negative pct render as "+-43%". Render the sign from the number itself.
  let label: string
  if (tone.toneKey === 'priceTpl') {
    const pct = flag.prior_avg_sek
      ? Math.round(((flag.amount_sek - flag.prior_avg_sek) / flag.prior_avg_sek) * 100)
      : 0
    label = t('flagTones.priceTpl', { sign: pct >= 0 ? '+' : '', pct })
  } else {
    label = t(`flagTones.${tone.toneKey}`)
  }
  const periodLabel = `${monthsShort[flag.period_month - 1]} ${flag.period_year}`

  // Confidence interpretation: <0.5 = low (we'd rather not pretend),
  // 0.5-0.79 = medium (no badge), >=0.8 = high (no badge — assumed quality).
  const conf = typeof flag.ai_confidence === 'number' ? flag.ai_confidence : null
  const showLowConfBadge = conf !== null && conf < 0.5

  async function handleReexplain() {
    if (reexplaining) return
    setReexplaining(true)
    try {
      await onReexplain()
    } finally {
      setReexplaining(false)
    }
  }

  return (
    <div style={{
      background:   'white',
      border:       `1px solid ${UX.borderSoft}`,
      borderRadius: 10,
      padding:      16,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: UX.ink1 }}>{flag.supplier_name}</span>
            <span style={{
              padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              background: tone.bg, color: tone.fg,
            }}>{label}</span>
            {(() => {
              const cat = CATEGORY_TONE[flag.category] ?? CATEGORY_TONE.other_cost
              return (
                <span style={{
                  padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                  background: cat.bg, color: cat.fg,
                }}>{tCat(cat.labelKey)}</span>
              )
            })()}
            <span style={{ fontSize: 11, color: UX.ink4, fontWeight: 500 }}>{periodLabel}</span>
          </div>
          <div style={{ fontSize: 12, color: UX.ink3, lineHeight: 1.5 }}>
            {flag.reason ?? '—'}
            {flag.ai_explanation && (
              <span style={{ display: 'block', marginTop: 4, color: UX.ink4, fontStyle: 'italic' as const }}>
                {flag.ai_explanation}
                {showLowConfBadge && (
                  <span style={{
                    marginLeft: 6, padding: '1px 6px', borderRadius: 999,
                    background: '#f3f4f6', color: '#6b7280',
                    fontSize: 9, fontWeight: 600, fontStyle: 'normal' as const,
                  }}>
                    {t('card.lowConfidence')}
                  </span>
                )}
                <button
                  onClick={handleReexplain}
                  disabled={reexplaining}
                  style={{
                    marginLeft: 6, background: 'transparent', border: 'none',
                    fontSize: 10, color: UX.ink4, cursor: reexplaining ? 'wait' : 'pointer',
                    fontStyle: 'normal' as const, textDecoration: 'underline' as const,
                  }}
                  title={t('card.reexplainTitle')}
                >
                  {reexplaining ? t('card.reexplaining') : t('card.reexplain')}
                </button>
              </span>
            )}
            {!flag.ai_explanation && (
              <button
                onClick={handleReexplain}
                disabled={reexplaining}
                style={{
                  marginTop: 4, background: 'transparent', border: 'none', padding: 0,
                  fontSize: 11, color: UX.ink4, cursor: reexplaining ? 'wait' : 'pointer',
                  textDecoration: 'underline' as const, display: 'block',
                }}
              >
                {reexplaining ? t('card.generating') : t('card.generateExplanation')}
              </button>
            )}
            {otherPeriods.length > 0 && (
              <span style={{ display: 'block', marginTop: 6, fontSize: 11, color: UX.ink4 }}>
                {t('card.alsoFlaggedIn', {
                  periods: otherPeriods
                    .sort((a, b) => (b.period_year * 100 + b.period_month) - (a.period_year * 100 + a.period_month))
                    .slice(0, 4)
                    .map(o => `${monthsShort[o.period_month - 1]} ${o.period_year}`)
                    .join(', '),
                })}
                {otherPeriods.length > 4 && t('card.alsoMore', { count: otherPeriods.length - 4 })}
                <span style={{ color: UX.ink4 }}>{t('card.oneDecision')}</span>
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
          <div style={{ fontSize: 18, fontWeight: 500, color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
            {fmtKr(flag.amount_sek)}
          </div>
          <div style={{ fontSize: 11, color: UX.ink4 }}>{periodLabel}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button onClick={onDefer} disabled={busy} style={btnGhost(busy)}>{t('card.defer')}</button>
        <button onClick={() => setShowDismissModal(true)} disabled={busy} style={btnDanger(busy)}>{t('card.planCancel')}</button>
        <button onClick={onEssential} disabled={busy} style={btnPrimary(busy)}>{t('card.essential')}</button>
      </div>

      {showDismissModal && (
        <DismissModal
          supplierName={flag.supplier_name}
          reason={dismissReason}
          setReason={setDismissReason}
          busy={busy}
          onCancel={() => { setShowDismissModal(false); setDismissReason('') }}
          onConfirm={() => {
            const r = dismissReason.trim() || null
            setShowDismissModal(false)
            onDismiss(r ?? undefined)
            setDismissReason('')
          }}
        />
      )}
    </div>
  )
}

function DismissModal({ supplierName, reason, setReason, busy, onCancel, onConfirm }: {
  supplierName: string
  reason: string
  setReason: (s: string) => void
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useTranslations('overheads.review.dismissModal')
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed' as const, inset: 0, background: 'rgba(17, 24, 39, 0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20,
      }}
    >
      <div style={{ background: 'white', borderRadius: 12, padding: 20, width: 460, maxWidth: '100%' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: UX.ink1, margin: '0 0 6px 0' }}>
          {t('title', { supplier: supplierName })}
        </h2>
        <p style={{ fontSize: 12, color: UX.ink3, margin: '0 0 14px 0' }}>
          {t('body')}
        </p>
        <label style={{ fontSize: 11, fontWeight: 600, color: UX.ink2, display: 'block', marginBottom: 4 }}>
          {t('notes')}
        </label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder={t('placeholder')}
          rows={3}
          maxLength={1000}
          style={{
            width: '100%', padding: 10, border: `1px solid ${UX.borderSoft}`, borderRadius: 7,
            fontSize: 13, fontFamily: 'inherit', color: UX.ink1, resize: 'vertical' as const,
            boxSizing: 'border-box' as const, lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} disabled={busy} style={btnGhost(busy)}>{t('cancel')}</button>
          <button onClick={onConfirm} disabled={busy} style={btnDanger(busy)}>
            {busy ? t('saving') : t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   BackfillBanner — first-run UX
// ────────────────────────────────────────────────────────────────────

function BackfillBanner({ onConfirm, onDismiss, busy }: { onConfirm: () => void; onDismiss: () => void; busy: boolean }) {
  const t = useTranslations('overheads.review.backfillBanner')
  // Body uses <b>essential</b> markup. next-intl supports rich text via t.rich,
  // but for a single tag the simpler split-on-marker approach keeps this
  // banner readable. The string in JSON uses <b>…</b> as a literal marker.
  const body = t('body')
  return (
    <div style={{
      background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
      padding: 16, marginBottom: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1e3a8a', marginBottom: 4 }}>
        {t('title')}
      </div>
      <div style={{ fontSize: 12, color: '#1e40af', lineHeight: 1.5, marginBottom: 12 }}
           dangerouslySetInnerHTML={{ __html: body }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onDismiss} disabled={busy} style={btnGhost(busy)}>{t('decline')}</button>
        <button onClick={onConfirm} disabled={busy} style={btnPrimary(busy)}>
          {busy ? t('marking') : t('confirm')}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   small UI
// ────────────────────────────────────────────────────────────────────

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

function CategoryButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px',
        background: active ? UX.ink1 : 'white',
        color:      active ? 'white' : UX.ink2,
        border:     `1px solid ${active ? UX.ink1 : UX.borderSoft}`,
        borderRadius: 999,
        fontSize:    12,
        fontWeight:  active ? 600 : 500,
        cursor:      'pointer',
        display:     'inline-flex',
        alignItems:  'center',
        gap:         6,
      }}
    >
      {children}
    </button>
  )
}

function Count({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      padding: '1px 6px', borderRadius: 999,
      background: 'rgba(255,255,255,0.18)',
      color: 'inherit',
    }}>
      {children}
    </span>
  )
}

function btnPrimary(busy: boolean): React.CSSProperties {
  return { padding: '7px 14px', background: busy ? UX.ink4 : UX.ink1, color: 'white', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer' }
}
function btnDanger(busy: boolean): React.CSSProperties {
  return { padding: '7px 14px', background: 'white', border: `1px solid ${busy ? UX.borderSoft : '#fecaca'}`, color: busy ? UX.ink4 : '#991b1b', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer' }
}
function btnGhost(busy: boolean): React.CSSProperties {
  return { padding: '7px 14px', background: 'transparent', border: 'none', color: busy ? UX.ink4 : UX.ink3, fontSize: 12, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer' }
}
