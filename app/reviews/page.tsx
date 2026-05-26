'use client'
// app/reviews/page.tsx — full rebuild on the new system
//
// Same treatment as the other rebuilds. Down from 910 lines to ~660.
//
// Every surface lives on UXP + KpiCardUX / PairedBarChart /
// BreakdownTable. Legacy UX-token surfaces are gone: connect card,
// window toggle, sync button, themes panel, recent reviews list,
// and the bespoke banners + spinner were all on the navy/amber
// system. The connect flow + Google Places search + per-review
// classification chips are preserved verbatim.
//
// Data:
//   GET  /api/integrations/google-places?business_id  — connect status
//   POST /api/integrations/google-places              — search + confirm
//   GET  /api/reviews/themes?business_id&window       — themes + trend
//   GET  /api/reviews/list?business_id&limit          — classified review feed
//   POST /api/reviews/sync                            — pull latest from Google

export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState } from 'react'
import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'

const CATEGORY_LABEL: Record<string, string> = {
  food:        'Food',
  service:     'Service',
  atmosphere:  'Atmosphere',
  value:       'Value',
  wait:        'Wait times',
  cleanliness: 'Cleanliness',
  noise:       'Noise',
  booking:     'Booking',
  staff:       'Staff attitude',
}

interface ThemeAgg {
  category:        string
  positive_count:  number
  negative_count:  number
  mixed_count:     number
  total_count:     number
  net_sentiment:   number
  example_phrases: string[]
  weight:          number
}
interface ThemesResp {
  business_id:   string
  window_days:   number
  sample_size:   number
  avg_rating:    number | null
  top_themes:    ThemeAgg[]
  weekly_trend:  Array<{ week: string; avg_rating: number | null; avg_sentiment: number | null; sample_n: number }>
  latest_review: any
}
interface Review {
  external_id:  string
  rating:       number | null
  published_at: string
  themes:       Record<string, { polarity: '+' | '-' | '~'; confidence: number; phrase: string }>
  sentiment:    number | null
  key_phrase:   string | null
  language:     string | null
  llm_model:    string | null
  author_name:  string | null
  text:         string | null
  // Reply state (M077)
  replied_at:   string | null
  reply_text:   string | null
  reply_tone:   'warm' | 'professional' | 'apologetic' | null
}

// /api/reviews/summary (M077) — the real Google totals + reply KPIs.
interface SummaryShape {
  business_id:             string
  business_name:           string
  place_id_set:            boolean
  last_sync_at:            string | null
  overall_rating:          number | null
  total_reviews_on_google: number | null
  reviews_in_db:           number
  replied_count:           number
  needs_reply_count:       number
  avg_response_hours:      number | null
  star_distribution_in_db: Record<'1'|'2'|'3'|'4'|'5', number>
}

type PlatformKey = 'google'

interface PlatformOption {
  key:     PlatformKey | 'tripadvisor' | 'foodora' | 'ubereats'
  label:   string
  enabled: boolean
}

const PLATFORM_OPTIONS: PlatformOption[] = [
  { key: 'google',      label: 'Google Maps', enabled: true  },
  { key: 'tripadvisor', label: 'TripAdvisor', enabled: false },
  { key: 'foodora',     label: 'Foodora',     enabled: false },
  { key: 'ubereats',    label: 'Uber Eats',   enabled: false },
]

export default function ReviewsPage() {
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [bizName,    setBizName]    = useState<string>('')
  const [placeId,    setPlaceId]    = useState<string | null>(null)
  const [themes,     setThemes]     = useState<ThemesResp | null>(null)
  const [reviews,    setReviews]    = useState<Review[]>([])
  // Summary endpoint payload (M077). Carries the real total from Google
  // — separate from the per-review rows we ingested (capped at 5 by
  // Google Places' per-call limit).
  const [summary,    setSummary]    = useState<SummaryShape | null>(null)
  const [insights,   setInsights]   = useState<InsightsResp | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [windowDays, setWindowDays] = useState(365)
  const [platform,   setPlatform]   = useState<PlatformKey>('google')
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [syncing,    setSyncing]    = useState(false)
  const [syncMsg,    setSyncMsg]    = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  // BizPicker
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  async function loadStatus(business_id: string) {
    const r = await fetch(`/api/integrations/google-places?business_id=${business_id}`, { cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    if (r.ok) {
      setPlaceId(j.google_place_id ?? null)
      setBizName(j.business_name ?? '')
    }
  }

  async function loadData(business_id: string, win: number) {
    setLoading(true); setError('')
    try {
      const [tr, lr, sr] = await Promise.all([
        fetch(`/api/reviews/themes?business_id=${business_id}&window=${win}`, { cache: 'no-store' }),
        fetch(`/api/reviews/list?business_id=${business_id}&limit=30`,        { cache: 'no-store' }),
        fetch(`/api/reviews/summary?business_id=${business_id}`,              { cache: 'no-store' }),
      ])
      if (tr.ok) setThemes(await tr.json());        else setThemes(null)
      if (lr.ok) setReviews((await lr.json()).reviews ?? []); else setReviews([])
      if (sr.ok) setSummary(await sr.json());       else setSummary(null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // AI insight cards load separately so the themes render fast while the
  // (slower, AI) synthesis populates. Cached server-side 24h.
  async function loadInsights(business_id: string, win: number, force = false) {
    setInsightsLoading(true)
    try {
      const r = await fetch(`/api/reviews/insights?business_id=${business_id}&window=${win}${force ? '&force=1' : ''}`, { cache: 'no-store' })
      setInsights(r.ok ? await r.json() : null)
    } catch { setInsights(null) } finally { setInsightsLoading(false) }
  }

  useEffect(() => {
    if (!bizId) return
    loadStatus(bizId).then(() => loadData(bizId, windowDays))
    // Insights are holistic ("what customers tell you") — always use the full
    // available history (365d), not the page's recent-window toggle, since
    // reviews are sparse and patterns want all the data.
    loadInsights(bizId, 365)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizId, windowDays])

  async function syncNow() {
    if (!bizId || syncing) return
    setSyncing(true); setSyncMsg(null)
    try {
      const r = await fetch('/api/reviews/sync', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      await loadData(bizId, windowDays)
      const msg = j.classified > 0
        ? `Synced — ${j.classified} new review${j.classified === 1 ? '' : 's'} analysed.`
        : j.fetched_reviews > 0
          ? `Synced — no new reviews since last fetch (${j.fetched_reviews} already in cache).`
          : 'Synced — Google returned no reviews for this Place ID.'
      setSyncMsg({ tone: 'good', text: msg })
    } catch (e: any) {
      setSyncMsg({ tone: 'bad', text: e.message })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <AppShell>
      <div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>

        {error && <Banner tone="bad" text={error} />}

        {!bizId && (
          <Empty>Select a business in the top toolbar to view its reviews.</Empty>
        )}

        {bizId && !placeId && (
          <ConnectCard
            businessId={bizId}
            businessName={bizName}
            onLinked={(id) => { setPlaceId(id); loadData(bizId, windowDays) }}
          />
        )}

        {bizId && placeId && (
          <>
            {/* Toolbar — window + platform + sync */}
            <div style={{
              display:         'flex',
              justifyContent:  'space-between',
              alignItems:      'center',
              gap:             10,
              flexWrap:        'wrap' as const,
            }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <WindowToggle value={windowDays} onChange={setWindowDays} />
                <PlatformFilter value={platform} onChange={setPlatform} />
              </div>
              <SyncButton busy={syncing} onClick={syncNow} />
            </div>

            {syncMsg && <Banner tone={syncMsg.tone} text={syncMsg.text} />}

            {loading && (
              <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
                Loading review analysis…
              </div>
            )}

            {!loading && themes && themes.sample_size === 0 && reviews.length === 0 && (
              <Empty>No reviews analysed yet. Hit "Sync now" to fetch the latest from Google, or wait for the daily 04:20 UTC sync.</Empty>
            )}

            {!loading && summary && (
              <SummaryStrip summary={summary} />
            )}

            {!loading && themes && themes.sample_size > 0 && (
              <>
                <RatingTrendChart trend={themes.weekly_trend} />
                <StarDistribution reviews={reviews} />
                <ThemesPanel themes={themes.top_themes} />
              </>
            )}

            {!loading && (insightsLoading || insights) && (
              <InsightsCards
                insights={insights}
                loading={insightsLoading}
                onRefresh={() => bizId && loadInsights(bizId, 365, true)}
              />
            )}

            {!loading && reviews.length > 0 && bizId && (
              <RecentReviewsPanel
                reviews={reviews}
                businessId={bizId}
                onReplyMarked={() => bizId && loadData(bizId, windowDays)}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Connect flow
// ════════════════════════════════════════════════════════════════════

function ConnectCard({ businessId, businessName, onLinked }: {
  businessId:   string
  businessName: string
  onLinked:     (id: string) => void
}) {
  const [query,    setQuery]    = useState(businessName ? `${businessName} Stockholm` : '')
  const [candidate, setCandidate] = useState<{ place_id: string; display_name: string; formatted_address: string | null } | null>(null)
  const [busy,     setBusy]     = useState(false)
  const [err,      setErr]      = useState('')

  async function search() {
    setBusy(true); setErr(''); setCandidate(null)
    try {
      const r = await fetch('/api/integrations/google-places', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ business_id: businessId, query }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setCandidate(j.candidate)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!candidate) return
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/integrations/google-places', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ business_id: businessId, place_id: candidate.place_id }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      onLinked(candidate.place_id)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={cardStyle()}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500, color: UXP.ink1 }}>Connect Google Maps</h2>
      <p style={{ fontSize: 12, color: UXP.ink3, marginTop: 6, lineHeight: 1.5 }}>
        Find your restaurant on Google Maps — we'll fetch your reviews daily and analyse the themes. Nothing is published; this is your private dashboard.
      </p>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="e.g. Vero Italiano Stockholm"
          style={{
            flex: 1,
            padding:      '8px 12px',
            background:   UXP.subtleBg,
            color:        UXP.ink1,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: 8,
            fontSize:     13,
            fontFamily:   'inherit',
          }}
          onKeyDown={e => e.key === 'Enter' && search()}
        />
        <button
          type="button"
          onClick={search}
          disabled={busy || !query.trim()}
          style={{
            padding:      '8px 16px',
            background:   UXP.lavDeep,
            color:        '#fff',
            border:       'none',
            borderRadius: 8,
            fontSize:     12,
            fontWeight:   500,
            cursor:       busy ? 'not-allowed' : 'pointer',
            opacity:      busy ? 0.6 : 1,
            fontFamily:   'inherit',
          }}
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {err && <Banner tone="bad" text={err} />}

      {candidate && (
        <div style={{
          marginTop:    12,
          padding:      '12px 14px',
          background:   UXP.subtleBg,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: UXP.r_md,
        }}>
          <div style={{
            fontSize:      9,
            color:         UXP.ink4,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.06em',
            fontWeight:    600,
            marginBottom:  4,
          }}>Best match</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1 }}>{candidate.display_name}</div>
          {candidate.formatted_address && (
            <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2 }}>{candidate.formatted_address}</div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              style={{
                padding:      '7px 14px',
                background:   UXP.green,
                color:        '#fff',
                border:       'none',
                borderRadius: 999,
                fontSize:     11,
                fontWeight:   500,
                cursor:       'pointer',
                fontFamily:   'inherit',
              }}
            >
              {busy ? 'Connecting…' : 'Yes, this is my restaurant'}
            </button>
            <button
              type="button"
              onClick={() => setCandidate(null)}
              style={{
                padding:      '7px 14px',
                background:   UXP.cardBg,
                color:        UXP.ink2,
                border:       `0.5px solid ${UXP.border}`,
                borderRadius: 999,
                fontSize:     11,
                fontWeight:   500,
                cursor:       'pointer',
                fontFamily:   'inherit',
              }}
            >
              Search again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// Toolbar atoms
// ════════════════════════════════════════════════════════════════════

function WindowToggle({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const opts = [{ k: 30, lab: '30 days' }, { k: 90, lab: '90 days' }, { k: 365, lab: '12 months' }]
  return (
    <div style={{
      display:      'inline-flex',
      gap:          2,
      background:   UXP.cardBg,
      border:       `0.5px solid ${UXP.border}`,
      borderRadius: 7,
      padding:      2,
    }}>
      {opts.map(o => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          style={{
            padding:       '4px 12px',
            background:    value === o.k ? UXP.lavFill : 'transparent',
            color:         value === o.k ? UXP.lavText : UXP.ink3,
            border:        'none',
            borderRadius:  5,
            fontSize:      10,
            fontWeight:    500,
            fontFamily:    'inherit',
            cursor:        'pointer',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
          }}
        >{o.lab}</button>
      ))}
    </div>
  )
}

function PlatformFilter({ value, onChange }: { value: PlatformKey; onChange: (v: PlatformKey) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const current = PLATFORM_OPTIONS.find(o => o.key === value) ?? PLATFORM_OPTIONS[0]

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' as const }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display:      'inline-flex',
          alignItems:   'center',
          gap:          6,
          padding:      '5px 10px',
          background:   UXP.cardBg,
          color:        UXP.ink1,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: 7,
          fontSize:     11,
          fontFamily:   'inherit',
          cursor:       'pointer',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: UXP.green, display: 'inline-block' }} />
        {current.label}
        <span aria-hidden style={{ color: UXP.ink3, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position:     'absolute' as const,
          top:          'calc(100% + 4px)',
          left:         0,
          minWidth:     180,
          background:   UXP.cardBg,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: UXP.r_md,
          padding:      4,
          zIndex:       40,
          boxShadow:    '0 8px 24px rgba(58,53,80,0.12)',
        }}>
          {PLATFORM_OPTIONS.map(opt => (
            <button
              key={opt.key}
              type="button"
              disabled={!opt.enabled}
              onClick={() => {
                if (!opt.enabled) return
                onChange(opt.key as PlatformKey)
                setOpen(false)
              }}
              style={{
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'space-between',
                width:          '100%',
                textAlign:      'left' as const,
                padding:        '7px 9px',
                background:     opt.key === value ? UXP.lavFill : 'transparent',
                color:          opt.enabled ? (opt.key === value ? UXP.lavText : UXP.ink1) : UXP.ink4,
                border:         'none',
                borderRadius:   UXP.r_sm,
                cursor:         opt.enabled ? 'pointer' : 'not-allowed',
                fontSize:       11,
                fontFamily:     'inherit',
              }}
            >
              {opt.label}
              {!opt.enabled && (
                <span style={{ fontSize: 9, color: UXP.ink4, fontStyle: 'italic' as const }}>Snart</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SyncButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        padding:      '6px 14px',
        background:   busy ? UXP.lavMid : UXP.lavDeep,
        color:        '#fff',
        border:       'none',
        borderRadius: 999,
        fontSize:     11,
        fontWeight:   500,
        fontFamily:   'inherit',
        cursor:       busy ? 'not-allowed' : 'pointer',
        opacity:      busy ? 0.7 : 1,
        display:      'inline-flex',
        alignItems:   'center',
        gap:          6,
      }}
    >
      {busy ? (
        <>
          <Spinner />
          Syncing…
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-3-6.7" />
            <path d="M21 4v5h-5" />
          </svg>
          Sync now
        </>
      )}
    </button>
  )
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'ccrSpin 1s linear infinite' }}>
      <path d="M21 12a9 9 0 11-9-9" />
      <style>{'@keyframes ccrSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}'}</style>
    </svg>
  )
}

// ════════════════════════════════════════════════════════════════════
// KPI strip
// ════════════════════════════════════════════════════════════════════

// Phase 3 spec — four KpiCards: rating · replied · needs-reply · avg-response.
// `rating` is Google's overall average across ALL their reviews (not just
// the 5 we ingested); `replied` / `needs_reply` / `avg_response` are
// computed off the local review_themes rows.
function SummaryStrip({ summary }: { summary: SummaryShape }) {
  const rating = summary.overall_rating
  const total  = summary.total_reviews_on_google
  const replied = summary.replied_count
  const needs   = summary.needs_reply_count

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Average rating"
        value={rating != null ? rating.toFixed(1) + '★' : '—'}
        microLabel={total != null ? `Across ${total.toLocaleString('sv-SE')} reviews on Google` : 'Hit Sync now to populate'}
      />
      <KpiCardUX
        title="Replied"
        value={String(replied)}
        deltaGood
        microLabel={`Of ${summary.reviews_in_db} ingested`}
      />
      <KpiCardUX
        title="Needs reply"
        value={String(needs)}
        deltaGood={needs === 0}
        delta={needs > 0 ? `${needs} pending` : null}
        microLabel={needs > 0 ? 'Open the AI drafter on each' : 'All caught up'}
      />
      <KpiCardUX
        title="Avg response time"
        value={summary.avg_response_hours != null ? `${summary.avg_response_hours}h` : '—'}
        microLabel={summary.avg_response_hours != null ? 'From posted to replied' : 'Nothing replied yet'}
      />
    </div>
  )
}

// Honest callout for the Google Places API limit. Surfaced only when
// Google's total > the rows we have. Explains why the recent-reviews
// list doesn't match the headline number, so the owner doesn't think
// we dropped data.
function GoogleApiLimitCallout({ totalOnGoogle, inDb }: { totalOnGoogle: number; inDb: number }) {
  return (
    <div style={{
      background:   UXP.lavFill,
      border:       `0.5px solid ${UXP.lavMid}`,
      borderRadius: UXP.r_md,
      padding:      '10px 14px',
      fontSize:     12,
      color:        UXP.ink2,
      lineHeight:   1.6,
    }}>
      <strong style={{ color: UXP.lavText }}>You have {totalOnGoogle.toLocaleString('sv-SE')} reviews on Google</strong>
      {' '}— Google&apos;s public API only exposes the {inDb} most recent. The rating, theme analysis and reply-time KPIs above are based on what we have access to. To bring in full review history we&apos;d need a Google Business Profile connection (planned).
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// Rating trend (PairedBarChart)
// ════════════════════════════════════════════════════════════════════

function RatingTrendChart({ trend }: { trend: ThemesResp['weekly_trend'] }) {
  // Need at least 2 weekly points for a trend — a single week renders as one
  // meaningless bar ("one purple block"). Below that, show nothing; the star
  // distribution + themes + insight cards already cover sparse-review cases.
  if (!trend || trend.length < 2) return null
  const series = trend.slice(-12)
  const groups = series.map(w => formatWeekShort(w.week))
  const ratings = series.map(w => (w.avg_rating != null ? Number(w.avg_rating) : 0))
  const samples = series.map(w => w.sample_n)

  return (
    <div style={cardStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Rating over time</div>
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            Weekly average · last {series.length} {series.length === 1 ? 'week' : 'weeks'}
          </div>
        </div>
        <span style={{ fontSize: 10, color: UXP.ink4 }}>Scale 0–5</span>
      </div>
      <PairedBarChart
        groups={groups}
        series={[{ label: 'Rating', data: ratings, color: UXP.lav }]}
        lines={[{ label: 'Reviews', data: samples, color: UXP.coral, dashed: false }]}
        leftMax={5}
        leftAxisUnit="★"
        width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}
        height={200}
      />
    </div>
  )
}

function formatWeekShort(iso: string): string {
  const wMatch = iso.match(/-W?(\d{1,2})$/)
  if (wMatch) return `v.${wMatch[1]}`
  const dMatch = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dMatch) return `${dMatch[3]}/${dMatch[2]}`
  return iso.slice(-5)
}

// ════════════════════════════════════════════════════════════════════
// Star distribution (BreakdownTable)
// ════════════════════════════════════════════════════════════════════

function StarDistribution({ reviews }: { reviews: Review[] }) {
  const buckets = [5, 4, 3, 2, 1].map(stars => ({
    stars,
    count: reviews.filter(r => r.rating === stars).length,
  }))
  const total = buckets.reduce((s, b) => s + b.count, 0)
  if (total === 0) return null

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Star distribution</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {total} classified {total === 1 ? 'review' : 'reviews'}
        </div>
      </div>
      <BreakdownTable<{ stars: number; count: number }>
        columns={[
          { key: 'stars', header: 'Stars', align: 'left', render: (r) => (
            <span style={{ color: UXP.ink1, letterSpacing: '0.05em' }}>
              {'★'.repeat(r.stars)}
              <span style={{ color: UXP.ink4 }}>{'★'.repeat(5 - r.stars)}</span>
            </span>
          ) },
          { key: 'count', header: 'Count', align: 'right', render: (r) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
              <span style={{
                display: 'inline-block', width: 80, height: 4,
                background: UXP.lavFill, borderRadius: 2, overflow: 'hidden',
              }}>
                <span style={{
                  display: 'block', height: '100%',
                  width: `${total > 0 ? (r.count / total) * 100 : 0}%`,
                  background: r.stars >= 4 ? UXP.green : r.stars === 3 ? UXP.coral : UXP.rose,
                }} />
              </span>
              <span style={{
                fontVariantNumeric: 'tabular-nums' as const,
                color: UXP.ink1, minWidth: 28, textAlign: 'right' as const,
              }}>{r.count}</span>
            </span>
          ) },
          { key: 'share', header: '%', align: 'right', render: (r) => (
            <DeltaChip
              value={`${total > 0 ? ((r.count / total) * 100).toFixed(0) : 0}%`}
              positiveIsGood={r.stars >= 4}
            />
          ) },
        ]}
        sections={[{ rows: buckets }]}
        footer={{
          label: 'Total',
          cells: { count: String(total), share: '100%' },
        }}
        rowKey={(row) => String(row.stars)}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// Themes panel
// ════════════════════════════════════════════════════════════════════

// ── AI insight cards: 5 things to improve + 5 things customers love ──
interface InsightItem { title: string; detail: string }
interface InsightsResp { improvements: InsightItem[]; satisfactions: InsightItem[]; sample_size: number; message?: string; cached?: boolean }

function InsightsCards({ insights, loading, onRefresh }: { insights: InsightsResp | null; loading: boolean; onRefresh: () => void }) {
  const improvements  = insights?.improvements ?? []
  const satisfactions = insights?.satisfactions ?? []
  const hasItems = improvements.length > 0 || satisfactions.length > 0
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: UXP.ink1 }}>What customers are telling you</h3>
          <span title="AI-generated from your reviews" style={{ fontSize: 9, fontWeight: 600, padding: '1px 6px', background: UXP.lavFill, color: UXP.lavText, borderRadius: 6, letterSpacing: '0.04em' }}>✦ AI</span>
        </div>
        <button onClick={onRefresh} disabled={loading} style={{ fontSize: 11, fontWeight: 500, padding: '4px 10px', background: 'transparent', color: UXP.ink3, border: `0.5px solid ${UXP.border}`, borderRadius: 6, cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit' }}>{loading ? 'Analysing…' : 'Refresh'}</button>
      </div>

      {loading && !hasItems && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="cc-insights-grid">
          {[0, 1].map(i => <div key={i} style={{ height: 170, background: UXP.subtleBg, borderRadius: 12, border: `0.5px solid ${UXP.border}` }} />)}
        </div>
      )}
      {!loading && insights?.message && !hasItems && (
        <div style={{ padding: '12px 14px', fontSize: 12, color: UXP.ink3, background: UXP.subtleBg, borderRadius: 10 }}>{insights.message}</div>
      )}
      {hasItems && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="cc-insights-grid">
          <InsightColumn title="Improve to lift performance" items={improvements}  accent={UXP.coral}     fill="#fbeee6"        emptyText="No recurring complaints — nice." />
          <InsightColumn title="What customers love"          items={satisfactions} accent={UXP.greenDeep} fill={UXP.greenFill}  emptyText="Not enough praise signal yet." />
        </div>
      )}
      <style>{`@media (max-width:680px){.cc-insights-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  )
}

function InsightColumn({ title, items, accent, fill, emptyText }: { title: string; items: InsightItem[]; accent: string; fill: string; emptyText: string }) {
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: fill, color: accent, fontSize: 12, fontWeight: 600 }}>{title}</div>
      <div style={{ padding: '6px 14px 12px' }}>
        {items.length === 0 ? (
          <div style={{ fontSize: 12, color: UXP.ink3, padding: '8px 0' }}>{emptyText}</div>
        ) : items.map((it, i) => (
          <div key={i} style={{ padding: '9px 0', borderBottom: i < items.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: accent, fontWeight: 700, fontSize: 12, minWidth: 14 }}>{i + 1}</span>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: UXP.ink1, lineHeight: 1.4 }}>{it.title}</div>
                {it.detail && <div style={{ fontSize: 11.5, color: UXP.ink3, lineHeight: 1.45, marginTop: 2 }}>{it.detail}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ThemesPanel({ themes }: { themes: ThemeAgg[] }) {
  if (!themes || themes.length === 0) return null
  return (
    <div style={cardStyle()}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Top themes</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Categories ranked by mention count · positive vs negative count + a representative quote
        </div>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {themes.slice(0, 8).map(t => <ThemeRow key={t.category} theme={t} />)}
      </div>
    </div>
  )
}

function ThemeRow({ theme: t }: { theme: ThemeAgg }) {
  const tone: 'good' | 'warning' | 'bad' =
    t.net_sentiment >  0.3 ? 'good' :
    t.net_sentiment < -0.3 ? 'bad'  : 'warning'
  const palette = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep, bar: UXP.green },
    warning: { bg: UXP.lavFill,   fg: UXP.coral,     bar: UXP.coral },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText,  bar: UXP.rose  },
  }[tone]
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: '4px 140px 90px 1fr',
      gap:                 12,
      alignItems:          'center',
      padding:             '10px 12px',
      background:          palette.bg,
      borderRadius:        UXP.r_md,
    }}>
      <span style={{ width: 4, height: '100%', minHeight: 28, background: palette.bar, borderRadius: 2 }} />
      <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1 }}>
        {CATEGORY_LABEL[t.category] ?? t.category}
      </div>
      <div style={{ fontSize: 10, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
        <span style={{ color: UXP.greenDeep, fontWeight: 500 }}>+{t.positive_count}</span>
        <span style={{ color: UXP.ink4 }}> / </span>
        <span style={{ color: UXP.roseText,  fontWeight: 500 }}>−{t.negative_count}</span>
      </div>
      <div style={{ fontSize: 11, color: UXP.ink3, lineHeight: 1.45 }}>
        {t.example_phrases.length > 0
          ? t.example_phrases.map((p, i) => (
              <span key={i}>
                {i > 0 && <span style={{ color: UXP.ink4 }}> · </span>}
                <span style={{ fontStyle: 'italic' as const }}>"{p}"</span>
              </span>
            ))
          : <span style={{ color: UXP.ink4 }}>No representative quote yet</span>}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// Recent reviews list
// ════════════════════════════════════════════════════════════════════

function RecentReviewsPanel({
  reviews, businessId, onReplyMarked,
}: {
  reviews:       Review[]
  businessId:    string
  onReplyMarked: () => void
}) {
  if (reviews.length === 0) return null
  return (
    <div style={cardStyle()}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Recent reviews</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Latest {reviews.length} analysed · original text shown only for last 30 days (Google T&amp;Cs)
        </div>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {reviews.map(r => (
          <ReviewRow
            key={r.external_id}
            review={r}
            businessId={businessId}
            onReplyMarked={onReplyMarked}
          />
        ))}
      </div>
    </div>
  )
}

function ReviewRow({
  review: r, businessId, onReplyMarked,
}: {
  review:        Review
  businessId:    string
  onReplyMarked: () => void
}) {
  const [draftOpen,    setDraftOpen]    = useState(false)
  const [tone,         setTone]         = useState<'warm' | 'professional' | 'apologetic'>(
    r.rating != null && r.rating <= 3 ? 'apologetic' : 'warm'
  )
  const [draft,        setDraft]        = useState<string>(r.reply_text ?? '')
  const [drafting,     setDrafting]     = useState(false)
  const [draftError,   setDraftError]   = useState<string | null>(null)
  const [markBusy,     setMarkBusy]     = useState(false)
  const [copied,       setCopied]       = useState(false)

  const isReplied = !!r.replied_at

  const ratingTone = r.rating == null    ? UXP.ink4
                   : r.rating >= 4       ? UXP.greenDeep
                   : r.rating === 3      ? UXP.coral
                   :                       UXP.roseText
  const themeChips = Object.entries(r.themes || {})
    .filter(([_, v]) => v && v.polarity)
    .sort(([_a, a], [_b, b]) => Number((b as any).confidence ?? 0) - Number((a as any).confidence ?? 0))
    .slice(0, 4)

  async function generateDraft(nextTone?: 'warm' | 'professional' | 'apologetic') {
    setDrafting(true); setDraftError(null)
    try {
      const res = await fetch('/api/reviews/draft-reply', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          business_id: businessId,
          external_id: r.external_id,
          tone:        nextTone ?? tone,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`)
      setDraft(String(j.draft ?? ''))
      if (nextTone) setTone(nextTone)
    } catch (e: any) {
      setDraftError(e.message)
    } finally {
      setDrafting(false)
    }
  }

  async function copyDraft() {
    if (!draft) return
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  async function markReplied(undo = false) {
    setMarkBusy(true)
    try {
      await fetch('/api/reviews/mark-replied', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          business_id: businessId,
          external_id: r.external_id,
          reply_text:  undo ? null : (draft || null),
          reply_tone:  undo ? null : tone,
          undo,
        }),
      })
      onReplyMarked()
    } finally {
      setMarkBusy(false)
    }
  }

  return (
    <div style={{
      background:    isReplied ? UXP.greenFill : UXP.subtleBg,
      border:        `0.5px solid ${isReplied ? UXP.green : UXP.borderSoft}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 12px',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' as const }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: ratingTone, letterSpacing: '0.05em' }}>
            {r.rating != null ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : ''}
          </span>
          <span style={{ fontSize: 11, color: UXP.ink3 }}>{r.author_name ?? 'Anonymous'}</span>
          {r.language && r.language !== 'en' && (
            <span style={{
              fontSize:      9,
              fontWeight:    600,
              textTransform: 'uppercase' as const,
              padding:       '1px 5px',
              background:    UXP.lavFill,
              color:         UXP.lavText,
              borderRadius:  4,
            }}>{r.language}</span>
          )}
          {isReplied ? (
            <span style={{
              fontSize: 10, fontWeight: 600, color: UXP.greenDeep,
              background: 'white', border: `0.5px solid ${UXP.green}`,
              padding: '1px 6px', borderRadius: 999, letterSpacing: '0.03em',
            }}>
              ✓ Replied {r.replied_at ? fmtDate(r.replied_at) : ''}
            </span>
          ) : (
            <span style={{
              fontSize: 10, fontWeight: 600, color: UXP.coral,
              background: UXP.lavFill, border: `0.5px solid ${UXP.lavMid}`,
              padding: '1px 6px', borderRadius: 999, letterSpacing: '0.03em',
            }}>
              Needs reply
            </span>
          )}
        </div>
        <span style={{ fontSize: 10, color: UXP.ink4 }}>{fmtDate(r.published_at)}</span>
      </div>

      {r.key_phrase && (
        <div style={{ fontSize: 12, color: UXP.ink1, lineHeight: 1.5, fontWeight: 500, marginBottom: 6 }}>
          {r.key_phrase}
        </div>
      )}

      {themeChips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4, marginBottom: 6 }}>
          {themeChips.map(([cat, t]) => {
            const v = t as any
            const palette =
              v.polarity === '+' ? { bg: UXP.greenFill, fg: UXP.greenDeep } :
              v.polarity === '-' ? { bg: UXP.roseFill,  fg: UXP.roseText  } :
                                   { bg: UXP.lavFill,   fg: UXP.coral     }
            return (
              <span key={cat} style={{
                fontSize: 10,
                fontWeight: 500,
                padding: '2px 7px',
                borderRadius: 999,
                background: palette.bg,
                color: palette.fg,
              }}>
                {v.polarity}{CATEGORY_LABEL[cat] ?? cat}
              </span>
            )
          })}
        </div>
      )}

      {r.text && (
        <div style={{
          fontSize:    11,
          color:       UXP.ink3,
          lineHeight:  1.5,
          fontStyle:   'italic' as const,
          borderLeft:  `2px solid ${UXP.borderSoft}`,
          paddingLeft: 8,
          marginTop:   4,
        }}>
          {r.text.length > 280 ? r.text.slice(0, 280) + '…' : r.text}
        </div>
      )}

      {/* Action row */}
      <div style={{
        display:    'flex',
        gap:        6,
        marginTop:  8,
        paddingTop: 8,
        borderTop:  `0.5px dashed ${UXP.borderSoft}`,
        alignItems: 'center',
        flexWrap:   'wrap' as const,
      }}>
        {!draftOpen && !isReplied && (
          <button
            type="button"
            onClick={() => { setDraftOpen(true); if (!draft) generateDraft() }}
            style={primaryPillStyle()}
          >
            ✦ Draft a reply
          </button>
        )}
        {!draftOpen && isReplied && (
          <>
            <button type="button" onClick={() => setDraftOpen(true)} style={ghostPillStyle()}>
              View draft
            </button>
            <button
              type="button"
              onClick={() => markReplied(true)}
              disabled={markBusy}
              style={{ ...ghostPillStyle(), color: UXP.coral, opacity: markBusy ? 0.5 : 1 }}
            >
              Undo replied
            </button>
          </>
        )}
        {draftOpen && (
          <button
            type="button"
            onClick={() => setDraftOpen(false)}
            style={{ ...ghostPillStyle(), marginLeft: 'auto' }}
          >
            Close
          </button>
        )}
      </div>

      {/* Drafter panel */}
      {draftOpen && (
        <div style={{
          marginTop:    8,
          background:   'white',
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: UXP.r_md,
          padding:      10,
        }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' as const, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: UXP.ink3, marginRight: 4 }}>Tone:</span>
            {(['warm', 'professional', 'apologetic'] as const).map(tk => (
              <button
                key={tk}
                type="button"
                onClick={() => { setTone(tk); generateDraft(tk) }}
                disabled={drafting}
                style={{
                  ...togglePillStyle(tone === tk),
                  opacity: drafting ? 0.6 : 1,
                  textTransform: 'capitalize' as const,
                }}
              >
                {tk}
              </button>
            ))}
            <button
              type="button"
              onClick={() => generateDraft()}
              disabled={drafting}
              style={{ ...ghostPillStyle(), marginLeft: 'auto', opacity: drafting ? 0.6 : 1 }}
              title="Regenerate the draft"
            >
              {drafting ? 'Drafting…' : '↻ Regenerate'}
            </button>
          </div>

          {draftError && (
            <div style={{
              fontSize: 11, color: UXP.roseText,
              background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
              padding: '6px 10px', borderRadius: 6, marginBottom: 8,
            }}>{draftError}</div>
          )}

          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={drafting ? 'Drafting your reply…' : 'AI draft will appear here. Edit before copying.'}
            style={{
              width:        '100%',
              minHeight:    100,
              padding:      '8px 10px',
              border:       `0.5px solid ${UXP.border}`,
              borderRadius: 6,
              fontSize:     12,
              lineHeight:   1.5,
              fontFamily:   'inherit',
              color:        UXP.ink1,
              background:   UXP.subtleBg,
              resize:       'vertical' as const,
              boxSizing:    'border-box' as const,
            }}
          />

          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <button
              type="button"
              onClick={copyDraft}
              disabled={!draft.trim()}
              style={{ ...ghostPillStyle(), opacity: draft.trim() ? 1 : 0.4 }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            {!isReplied ? (
              <button
                type="button"
                onClick={() => markReplied(false)}
                disabled={markBusy || !draft.trim()}
                style={{ ...primaryPillStyle(), opacity: (markBusy || !draft.trim()) ? 0.5 : 1 }}
              >
                {markBusy ? 'Saving…' : 'Mark as replied'}
              </button>
            ) : (
              <span style={{ fontSize: 10, color: UXP.ink3 }}>
                Marked replied {r.replied_at ? `· ${fmtDate(r.replied_at)}` : ''}
              </span>
            )}
            <span style={{ fontSize: 10, color: UXP.ink4, marginLeft: 'auto' }}>
              Paste into Google Maps · this UI tracks state only
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function primaryPillStyle(): React.CSSProperties {
  return {
    fontSize:    11,
    fontWeight:  600,
    padding:     '5px 12px',
    background:  UXP.lavDeep,
    color:       'white',
    border:      'none',
    borderRadius: 999,
    cursor:      'pointer',
    fontFamily:  'inherit',
  }
}
function ghostPillStyle(): React.CSSProperties {
  return {
    fontSize:    11,
    fontWeight:  500,
    padding:     '5px 10px',
    background:  'transparent',
    color:       UXP.ink2,
    border:      `0.5px solid ${UXP.border}`,
    borderRadius: 999,
    cursor:      'pointer',
    fontFamily:  'inherit',
  }
}
function togglePillStyle(active: boolean): React.CSSProperties {
  return {
    fontSize:    10,
    fontWeight:  active ? 600 : 500,
    padding:     '4px 10px',
    background:  active ? UXP.lavFill : 'transparent',
    color:       active ? UXP.lavText : UXP.ink3,
    border:      `0.5px solid ${active ? UXP.lavMid : UXP.borderSoft}`,
    borderRadius: 999,
    cursor:      'pointer',
    fontFamily:  'inherit',
  }
}

// ════════════════════════════════════════════════════════════════════
// Atoms
// ════════════════════════════════════════════════════════════════════

function cardStyle(): React.CSSProperties {
  return {
    background:    UXP.cardBg,
    border:        `0.5px solid ${UXP.border}`,
    borderRadius:  UXP.r_lg,
    padding:       '14px 16px',
  }
}

function Banner({ tone, text }: { tone: 'good' | 'warning' | 'bad'; text: string }) {
  const palette = {
    good:    { bg: UXP.greenFill, border: UXP.green, fg: UXP.greenDeep },
    warning: { bg: UXP.lavFill,   border: UXP.lavMid, fg: UXP.lavText  },
    bad:     { bg: UXP.roseFill,  border: UXP.rose,  fg: UXP.roseText  },
  }[tone]
  return (
    <div style={{
      background:    palette.bg,
      border:        `0.5px solid ${palette.border}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 14px',
      fontSize:      12,
      color:         palette.fg,
    }}>{text}</div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding:       40,
      textAlign:     'center' as const,
      color:         UXP.ink4,
      fontSize:      12,
      background:    UXP.cardBg,
      borderRadius:  UXP.r_lg,
      border:        `0.5px solid ${UXP.border}`,
      maxWidth:      560,
      margin:        '0 auto',
    }}>{children}</div>
  )
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    const day = d.getDate()
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
    return `${day} ${month} ${d.getFullYear()}`
  } catch { return iso }
}
