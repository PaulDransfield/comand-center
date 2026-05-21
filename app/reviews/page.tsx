'use client'
// app/reviews/page.tsx
//
// Review-intelligence surface. Three states:
//
//   1. No Place ID linked → onboarding card (search Google Maps for the
//      restaurant, owner confirms the match, we save the place_id)
//   2. Linked but no reviews yet → "waiting for first daily sync" notice
//   3. Has reviews → top themes panel + recent reviews list
//
// Source data:
//   - /api/reviews/themes  (rolling top categories + sentiment)
//   - /api/reviews/list    (recent classified reviews)
//   - /api/integrations/google-places (connect flow)

import { useEffect, useRef, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UX, UXP } from '@/lib/constants/tokens'
// Phase 3 — Insights pages onto the new system. SummaryStrip → KpiCardUX row.
// Phase 7.5 — adds the rating-over-time chart, star-distribution table, and
// platform filter the original §3 spec called for. Reply / response-time
// surfaces still defer (need new schema + an /api/reviews/draft-reply route).
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'

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
}

export default function ReviewsPage() {
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [bizName, setBizName] = useState<string>('')
  const [placeId, setPlaceId] = useState<string | null>(null)
  const [themes,  setThemes]  = useState<ThemesResp | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [windowDays, setWindowDays] = useState(90)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  // Phase 7.5 — platform filter. Google is the only live source today;
  // the other options surface as greyed-out "coming soon" items so the
  // operator sees where this is going. Selecting them is a no-op.
  const [platform, setPlatform] = useState<'google'>('google')

  // Read selected business id from the same key the sidebar uses
  useEffect(() => {
    try {
      const id = localStorage.getItem('cc_selected_biz')
      if (id) setBizId(id)
    } catch {}
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
    setLoading(true)
    setError('')
    try {
      const [tr, lr] = await Promise.all([
        fetch(`/api/reviews/themes?business_id=${business_id}&window=${win}`, { cache: 'no-store' }),
        fetch(`/api/reviews/list?business_id=${business_id}&limit=30`,        { cache: 'no-store' }),
      ])
      if (tr.ok) setThemes(await tr.json()); else setThemes(null)
      if (lr.ok) setReviews((await lr.json()).reviews ?? []); else setReviews([])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!bizId) return
    loadStatus(bizId).then(() => loadData(bizId, windowDays))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizId, windowDays])

  async function syncNow() {
    if (!bizId || syncing) return
    setSyncing(true)
    setSyncMsg(null)
    try {
      const r = await fetch('/api/reviews/sync', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      // Refresh data and surface a one-line summary
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
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '20px 24px 60px' }}>
        <div style={{ marginBottom: 14 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: UX.ink1, margin: 0 }}>Reviews</h1>
          <p style={{ fontSize: 13, color: UX.ink3, marginTop: 4, lineHeight: 1.5 }}>
            What your guests are actually saying. New Google Maps reviews are fetched daily and analysed by AI — food, service, atmosphere, value, and other themes are tracked over time so you can see what's improving and what's not.
          </p>
        </div>

        {error && <Banner tone="bad" text={error} />}

        {!bizId && <Empty text="Select a business in the sidebar to view its reviews." />}

        {bizId && !placeId && (
          <ConnectCard businessId={bizId} businessName={bizName} onLinked={(id) => { setPlaceId(id); loadData(bizId, windowDays) }} />
        )}

        {bizId && placeId && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' as const }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <WindowToggle value={windowDays} onChange={setWindowDays} />
                <PlatformFilter value={platform} onChange={setPlatform} />
              </div>
              <SyncButton onClick={syncNow} busy={syncing} />
            </div>

            {syncMsg && <Banner tone={syncMsg.tone} text={syncMsg.text} />}

            {loading && <Empty text="Loading review analysis…" />}

            {!loading && themes && themes.sample_size === 0 && reviews.length === 0 && (
              <Empty text="No reviews analysed yet. Hit “Sync now” above to fetch the latest from Google, or wait for the daily 04:20 UTC sync." />
            )}

            {!loading && themes && themes.sample_size === 0 && reviews.length > 0 && (
              <Banner
                tone="warn"
                text={`No reviews in the last ${windowDays} days, but ${reviews.length} older one${reviews.length === 1 ? '' : 's'} ${reviews.length === 1 ? 'is' : 'are'} on file. Switch to 12 months above to see themes, or scroll for the full list.`}
              />
            )}

            {!loading && themes && themes.sample_size > 0 && (
              <>
                <SummaryStrip themes={themes} />
                <RatingTrendChart trend={themes.weekly_trend} />
                <StarDistribution reviews={reviews} />
                <ThemesPanel themes={themes.top_themes} />
              </>
            )}

            {!loading && reviews.length > 0 && (
              <RecentReviewsPanel reviews={reviews} />
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

// ─── Connect flow ────────────────────────────────────────────────────

function ConnectCard({ businessId, businessName, onLinked }: { businessId: string; businessName: string; onLinked: (id: string) => void }) {
  const [query,   setQuery]   = useState(businessName ? `${businessName} Stockholm` : '')
  const [candidate, setCandidate] = useState<{ place_id: string; display_name: string; formatted_address: string | null } | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState('')

  async function search() {
    setBusy(true)
    setErr('')
    setCandidate(null)
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
    setBusy(true)
    setErr('')
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
    <div style={{
      background: UX.cardBg, border: `1px solid ${UX.border}`, borderRadius: 10,
      padding: '16px 18px',
    }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: UX.ink1, margin: 0 }}>Connect Google Maps</h2>
      <p style={{ fontSize: 12, color: UX.ink3, marginTop: 6, lineHeight: 1.5 }}>
        Find your restaurant on Google Maps — we'll fetch your reviews daily and analyse the themes. Nothing is published; this is your private dashboard.
      </p>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="e.g. Vero Italiano Stockholm"
          style={{
            flex: 1, padding: '8px 12px',
            border: `1px solid ${UX.border}`, borderRadius: 6,
            fontSize: 13, color: UX.ink1, background: UX.pageBg,
          }}
          onKeyDown={e => e.key === 'Enter' && search()}
        />
        <button
          onClick={search}
          disabled={busy || !query.trim()}
          style={{
            padding: '8px 16px', fontSize: 13, fontWeight: 500,
            background: UX.ink1, color: 'white',
            border: 'none', borderRadius: 6,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {err && <Banner tone="bad" text={err} />}

      {candidate && (
        <div style={{
          marginTop: 12, padding: '12px 14px',
          background: UX.pageBg, border: `1px solid ${UX.border}`, borderRadius: 8,
        }}>
          <div style={{ fontSize: 11, color: UX.ink4, textTransform: 'uppercase' as const, letterSpacing: '0.06em', fontWeight: 600, marginBottom: 4 }}>
            Best match
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: UX.ink1 }}>{candidate.display_name}</div>
          {candidate.formatted_address && (
            <div style={{ fontSize: 12, color: UX.ink3, marginTop: 2 }}>{candidate.formatted_address}</div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button
              onClick={confirm}
              disabled={busy}
              style={{
                padding: '7px 14px', fontSize: 12, fontWeight: 500,
                background: UX.greenInk, color: 'white',
                border: 'none', borderRadius: 6, cursor: 'pointer',
              }}
            >
              {busy ? 'Connecting…' : 'Yes, this is my restaurant'}
            </button>
            <button
              onClick={() => setCandidate(null)}
              style={{
                padding: '7px 14px', fontSize: 12, fontWeight: 500,
                background: 'transparent', color: UX.ink3,
                border: `1px solid ${UX.border}`, borderRadius: 6, cursor: 'pointer',
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

// ─── Window toggle ───────────────────────────────────────────────────

function WindowToggle({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const opts = [{ k: 30, lab: '30 days' }, { k: 90, lab: '90 days' }, { k: 365, lab: '12 months' }]
  return (
    <div style={{ display: 'inline-flex', gap: 2, background: UX.pageBg, padding: 3, borderRadius: 6, border: `1px solid ${UX.border}` }}>
      {opts.map(o => (
        <button
          key={o.k}
          onClick={() => onChange(o.k)}
          style={{
            padding: '5px 12px', fontSize: 11, fontWeight: 500,
            background: value === o.k ? UX.cardBg : 'transparent',
            color: value === o.k ? UX.ink1 : UX.ink3,
            border: 'none', borderRadius: 4, cursor: 'pointer',
            boxShadow: value === o.k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
          }}
        >
          {o.lab}
        </button>
      ))}
    </div>
  )
}

// ─── Sync button ─────────────────────────────────────────────────────

function SyncButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        padding:      '7px 14px',
        fontSize:     12,
        fontWeight:   500,
        background:   busy ? '#94a3b8' : UX.ink1,
        color:        'white',
        border:       'none',
        borderRadius: 6,
        cursor:       busy ? 'not-allowed' : 'pointer',
        display:      'inline-flex',
        alignItems:   'center',
        gap:          6,
        opacity:      busy ? 0.7 : 1,
        transition:   'opacity 0.15s',
      }}
    >
      {busy ? (
        <>
          <Spinner />
          Syncing…
        </>
      ) : (
        <>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-3-6.7"/>
            <path d="M21 4v5h-5"/>
          </svg>
          Sync now
        </>
      )}
    </button>
  )
}

function Spinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
      <path d="M21 12a9 9 0 11-9-9"/>
      <style>{'@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}'}</style>
    </svg>
  )
}

// ─── Platform filter ─────────────────────────────────────────────────
// Phase 7.5 — pill dropdown that lists Google (the live source today)
// plus the platforms we plan to add as future menu items. Selecting a
// "coming soon" option keeps the filter on Google so nothing on the
// page changes; the affordance signals product direction.

type PlatformKey = 'google'

interface PlatformOption {
  key:      PlatformKey | 'tripadvisor' | 'foodora' | 'ubereats'
  label:    string
  enabled:  boolean
}

const PLATFORM_OPTIONS: PlatformOption[] = [
  { key: 'google',      label: 'Google Maps', enabled: true  },
  { key: 'tripadvisor', label: 'TripAdvisor', enabled: false },
  { key: 'foodora',     label: 'Foodora',     enabled: false },
  { key: 'ubereats',    label: 'Uber Eats',   enabled: false },
]

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
          display:        'inline-flex',
          alignItems:     'center',
          gap:            6,
          padding:        '5px 10px',
          background:     UXP.cardBg,
          color:          UXP.ink1,
          border:         `0.5px solid ${UXP.border}`,
          borderRadius:   7,
          fontSize:       11,
          fontFamily:     'inherit',
          cursor:         'pointer',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: UXP.green, display: 'inline-block' }} />
        {current.label}
        <span aria-hidden style={{ color: UXP.ink3, fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
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
          }}
        >
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
                display:      'flex',
                alignItems:   'center',
                justifyContent: 'space-between',
                width:        '100%',
                textAlign:    'left' as const,
                padding:      '7px 9px',
                background:   opt.key === value ? UXP.lavFill : 'transparent',
                color:        opt.enabled ? (opt.key === value ? UXP.lavText : UXP.ink1) : UXP.ink4,
                border:       'none',
                borderRadius: UXP.r_sm,
                cursor:       opt.enabled ? 'pointer' : 'not-allowed',
                fontSize:     11,
                fontFamily:   'inherit',
              }}
            >
              {opt.label}
              {!opt.enabled && (
                <span style={{ fontSize: 9, color: UXP.ink4, fontStyle: 'italic' as const }}>
                  Snart
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Rating trend chart ──────────────────────────────────────────────
// Phase 7.5 — weekly rating + sample-size line overlay drawn through the
// canonical PairedBarChart. Uses themes.weekly_trend so no new API call.

function RatingTrendChart({ trend }: { trend: ThemesResp['weekly_trend'] }) {
  if (!trend || trend.length === 0) return null
  // Limit to the latest 12 weeks so the chart stays legible.
  const series = trend.slice(-12)
  const groups = series.map(w => formatWeekShort(w.week))
  const ratings = series.map(w => (w.avg_rating != null ? Number(w.avg_rating) : 0))
  const samples = series.map(w => w.sample_n)

  return (
    <div style={{
      background:   UXP.cardBg,
      border:       `0.5px solid ${UXP.border}`,
      borderRadius: UXP.r_lg,
      padding:      '14px 16px',
      marginBottom: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink3, fontWeight: 500 }}>Betyg över tid</div>
          <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
            Veckosnitt — senaste {series.length} {series.length === 1 ? 'vecka' : 'veckor'}
          </div>
        </div>
        <span style={{ fontSize: 10, color: UXP.ink4 }}>
          Skala 0-5
        </span>
      </div>
      <PairedBarChart
        groups={groups}
        series={[
          { label: 'Betyg', data: ratings, color: UXP.lav },
        ]}
        lines={[{
          label:  'Antal recensioner',
          data:   samples,
          color:  UXP.coral,
          dashed: false,
        }]}
        leftMax={5}
        leftAxisUnit="★"
        width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 900) : 900}
        height={200}
      />
    </div>
  )
}

function formatWeekShort(iso: string): string {
  // Input typically 'YYYY-WW' or 'YYYY-MM-DD'. Render as 'v.<num>' when
  // we can parse a week, else the last two characters as a fallback.
  const wMatch = iso.match(/-W?(\d{1,2})$/)
  if (wMatch) return `v.${wMatch[1]}`
  const dMatch = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dMatch) return `${dMatch[3]}/${dMatch[2]}`
  return iso.slice(-5)
}

// ─── Star distribution ───────────────────────────────────────────────
// Phase 7.5 — count of reviews per star (1-5) over the loaded review
// window. Renders via the canonical BreakdownTable with a horizontal
// share bar in the count column.

function StarDistribution({ reviews }: { reviews: Review[] }) {
  const buckets = [5, 4, 3, 2, 1].map(stars => ({
    stars,
    count: reviews.filter(r => r.rating === stars).length,
  }))
  const total = buckets.reduce((s, b) => s + b.count, 0)
  if (total === 0) return null

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink3, fontWeight: 500 }}>Stjärnfördelning</div>
        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
          {total} klassificerade {total === 1 ? 'recension' : 'recensioner'}
        </div>
      </div>
      <BreakdownTable<{ stars: number; count: number }>
        columns={[
          { key: 'stars', header: 'Stjärnor', align: 'left', render: (r) => (
            <span style={{ color: UXP.ink1, letterSpacing: '0.05em' }}>
              {'★'.repeat(r.stars)}
              <span style={{ color: UXP.ink4 }}>{'★'.repeat(5 - r.stars)}</span>
            </span>
          ) },
          { key: 'count', header: 'Antal', align: 'right', render: (r) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
              <span style={{
                display:      'inline-block',
                width:        80,
                height:       4,
                background:   UXP.lavFill,
                borderRadius: 2,
                overflow:     'hidden',
              }}>
                <span style={{
                  display: 'block',
                  height:  '100%',
                  width:   `${total > 0 ? (r.count / total) * 100 : 0}%`,
                  background: r.stars >= 4 ? UXP.green : r.stars === 3 ? UXP.coral : UXP.rose,
                }} />
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1, minWidth: 28, textAlign: 'right' as const }}>
                {r.count}
              </span>
            </span>
          ) },
          { key: 'share', header: '%',      align: 'right', render: (r) => (
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

// ─── Summary strip ───────────────────────────────────────────────────

function SummaryStrip({ themes }: { themes: ThemesResp }) {
  // Phase 3 — four KpiCardUX cards replace the bespoke StatTile strip. The
  // legacy StatTile component below is still used by other surfaces (kept
  // in-file) until later phases sweep it.
  const positiveCount = themes.top_themes.reduce((s, t) => s + t.positive_count, 0)
  const negativeCount = themes.top_themes.reduce((s, t) => s + t.negative_count, 0)
  const rating        = themes.avg_rating
  // Rating delta — distance from a 4.5★ target, in 0.1★ units. Treats "above
  // target" as the positive direction so deltaGood lights green when good.
  const ratingDelta   = rating != null
    ? (rating >= 4.5 ? '+' : '') + (rating - 4.5).toFixed(1) + '★'
    : null

  return (
    <div
      style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap:                 12,
        marginBottom:        14,
      }}
    >
      <KpiCardUX
        title="Average rating"
        value={rating != null ? rating.toFixed(1) + '★' : '—'}
        delta={ratingDelta}
        deltaGood
        microLabel={`${themes.window_days}-day window`}
      />
      <KpiCardUX
        title="Reviews analysed"
        value={themes.sample_size.toString()}
        microLabel={`${themes.window_days}-day window`}
      />
      <KpiCardUX
        title="Positive mentions"
        value={positiveCount.toString()}
        variant="stacked"
        stackedBars={[
          { label: 'Positive', value: positiveCount, max: Math.max(positiveCount + negativeCount, 1), color: UXP.green },
          { label: 'Negative', value: negativeCount, max: Math.max(positiveCount + negativeCount, 1), color: UXP.rose  },
        ]}
      />
      <KpiCardUX
        title="Negative mentions"
        value={negativeCount.toString()}
        deltaGood={false}
        delta={negativeCount > positiveCount ? '+ flagged' : null}
      />
    </div>
  )
}

function StatTile({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const fg = tone === 'good' ? UX.greenInk : tone === 'bad' ? '#b91c1c' : UX.ink1
  return (
    <div style={{
      background: UX.cardBg, border: `1px solid ${UX.border}`, borderRadius: 8,
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 10, color: UX.ink4, textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, color: fg }}>{value}</div>
    </div>
  )
}

// ─── Themes panel ────────────────────────────────────────────────────

function ThemesPanel({ themes }: { themes: ThemeAgg[] }) {
  if (themes.length === 0) {
    return null
  }
  return (
    <div style={{
      background: UX.cardBg, border: `1px solid ${UX.border}`, borderRadius: 10,
      padding: '14px 16px', marginBottom: 14,
    }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: UX.ink1, margin: 0 }}>Top themes</h2>
      <p style={{ fontSize: 11, color: UX.ink4, marginTop: 2, marginBottom: 12 }}>
        Categories ranked by mention count weighted by sentiment lean. Numbers in brackets show positive/negative mentions.
      </p>
      <div style={{ display: 'grid', gap: 6 }}>
        {themes.slice(0, 8).map(t => <ThemeRow key={t.category} theme={t} />)}
      </div>
    </div>
  )
}

function ThemeRow({ theme: t }: { theme: ThemeAgg }) {
  const tone: 'good' | 'warn' | 'bad' =
    t.net_sentiment > 0.3  ? 'good'
    : t.net_sentiment < -0.3 ? 'bad'
    : 'warn'
  const palette = {
    good: { fg: UX.greenInk, bg: UX.greenBg,  border: '#bbf7d0' },
    warn: { fg: UX.amberInk, bg: UX.amberBg, border: '#fde68a' },
    bad:  { fg: '#b91c1c',   bg: '#fef2f2',   border: '#fecaca' },
  }[tone]
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '140px 80px 1fr',
      gap: 12, alignItems: 'center',
      padding: '10px 12px',
      background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 6,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: UX.ink1 }}>
        {CATEGORY_LABEL[t.category] ?? t.category}
      </div>
      <div style={{ fontSize: 11, color: UX.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
        <span style={{ color: UX.greenInk, fontWeight: 600 }}>+{t.positive_count}</span>
        {' / '}
        <span style={{ color: '#b91c1c', fontWeight: 600 }}>−{t.negative_count}</span>
      </div>
      <div style={{ fontSize: 11, color: UX.ink3, lineHeight: 1.45 }}>
        {t.example_phrases.length > 0
          ? t.example_phrases.map((p, i) => (
              <span key={i}>
                {i > 0 && <span style={{ color: UX.ink4 }}> · </span>}
                <span style={{ fontStyle: 'italic' as const }}>"{p}"</span>
              </span>
            ))
          : <span style={{ color: UX.ink4 }}>No representative quote yet</span>
        }
      </div>
    </div>
  )
}

// ─── Recent reviews list ─────────────────────────────────────────────

function RecentReviewsPanel({ reviews }: { reviews: Review[] }) {
  if (reviews.length === 0) return null
  return (
    <div style={{
      background: UX.cardBg, border: `1px solid ${UX.border}`, borderRadius: 10,
      padding: '14px 16px',
    }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: UX.ink1, margin: 0 }}>Recent reviews</h2>
      <p style={{ fontSize: 11, color: UX.ink4, marginTop: 2, marginBottom: 12 }}>
        Latest {reviews.length} analysed. Original text shown for reviews from the last 30 days; older reviews show only the AI summary (Google's terms limit how long we can cache verbatim text).
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {reviews.map(r => <ReviewRow key={r.external_id} review={r} />)}
      </div>
    </div>
  )
}

function ReviewRow({ review: r }: { review: Review }) {
  const ratingTone = r.rating == null ? UX.ink4 : r.rating >= 4 ? UX.greenInk : r.rating === 3 ? UX.amberInk : '#b91c1c'
  const themeChips = Object.entries(r.themes || {})
    .filter(([_, v]) => v && v.polarity)
    .sort(([_a, a], [_b, b]) => Number((b as any).confidence ?? 0) - Number((a as any).confidence ?? 0))
    .slice(0, 4)
  return (
    <div style={{
      background: UX.pageBg, border: `0.5px solid ${UX.border}`, borderRadius: 6,
      padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: ratingTone }}>
            {r.rating != null ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : ''}
          </span>
          <span style={{ fontSize: 11, color: UX.ink3 }}>{r.author_name ?? 'Anonymous'}</span>
          {r.language && r.language !== 'en' && (
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, padding: '1px 5px', background: '#eef2ff', color: '#4338ca', borderRadius: 3 }}>
              {r.language}
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: UX.ink4 }}>{fmtDate(r.published_at)}</span>
      </div>

      {r.key_phrase && (
        <div style={{ fontSize: 12, color: UX.ink1, lineHeight: 1.5, fontWeight: 500, marginBottom: 6 }}>
          {r.key_phrase}
        </div>
      )}

      {themeChips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4, marginBottom: 6 }}>
          {themeChips.map(([cat, t]) => {
            const v = t as any
            const tone = v.polarity === '+' ? 'good' : v.polarity === '-' ? 'bad' : 'warn'
            const palette = {
              good: { bg: UX.greenBg, fg: UX.greenInk },
              warn: { bg: UX.amberBg, fg: UX.amberInk },
              bad:  { bg: '#fef2f2',  fg: '#b91c1c' },
            }[tone]
            return (
              <span key={cat} style={{
                fontSize: 10, fontWeight: 500,
                padding: '2px 7px', borderRadius: 999,
                background: palette.bg, color: palette.fg,
              }}>
                {v.polarity}{CATEGORY_LABEL[cat] ?? cat}
              </span>
            )
          })}
        </div>
      )}

      {r.text && (
        <div style={{ fontSize: 11, color: UX.ink3, lineHeight: 1.5, fontStyle: 'italic' as const, borderLeft: `2px solid ${UX.border}`, paddingLeft: 8, marginTop: 4 }}>
          {r.text.length > 280 ? r.text.slice(0, 280) + '…' : r.text}
        </div>
      )}
    </div>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' },
    warn: { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
    bad:  { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
    }}>{text}</div>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: 28, textAlign: 'center' as const, color: UX.ink4, fontSize: 12, background: UX.cardBg, border: `1px solid ${UX.border}`, borderRadius: 8 }}>{text}</div>
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    const day = d.getDate()
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
    return `${day} ${month} ${d.getFullYear()}`
  } catch { return iso }
}
