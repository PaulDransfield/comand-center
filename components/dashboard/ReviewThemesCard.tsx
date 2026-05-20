'use client'
// components/dashboard/ReviewThemesCard.tsx
//
// Dashboard card surfacing the top review themes for the selected
// business over a 90-day rolling window. Sits alongside the attention
// panels — it's another "what's worth looking at this week" lens, but
// from the guest's point of view rather than the operator's.
//
// Hidden states:
//   - No google_place_id linked → render nothing (don't nag the owner)
//   - Sample size 0 (no reviews in window) → render nothing
//   - API error → render nothing (silent — this is supplementary signal)
//
// Visible state: top 3 themes ranked by weight (count × sentiment
// magnitude), one example pull-quote each. Click-through to /reviews.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { UX } from '@/lib/constants/tokens'

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
  sample_size:   number
  avg_rating:    number | null
  top_themes:    ThemeAgg[]
  window_days:   number
}

export default function ReviewThemesCard({ businessId }: { businessId: string | null }) {
  const [data, setData] = useState<ThemesResp | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!businessId) { setData(null); setLoaded(true); return }
    let cancelled = false
    setLoaded(false)
    fetch(`/api/reviews/themes?business_id=${businessId}&window=90`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(j => {
        if (!cancelled) {
          setData(j)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData(null)
          setLoaded(true)
        }
      })
    return () => { cancelled = true }
  }, [businessId])

  if (!loaded) return null
  if (!data) return null
  if (data.sample_size === 0) return null

  // Pick the top 3 themes by weight. If the top one is very positive,
  // we still include it — owners want to see strengths too, not just
  // complaints. The mix tells a fuller story.
  const top = data.top_themes.slice(0, 3)
  if (top.length === 0) return null

  return (
    <div style={{
      background:   UX.cardBg,
      border:       `1px solid ${UX.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginTop:    8,
    }}>
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'baseline',
        marginBottom:   10,
        gap:            8,
        flexWrap:       'wrap' as const,
      }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: UX.ink1, margin: 0 }}>
            What guests are saying
          </h2>
          <div style={{ fontSize: 11, color: UX.ink4, marginTop: 2 }}>
            {data.sample_size} review{data.sample_size === 1 ? '' : 's'} · last 90 days
            {data.avg_rating != null && (
              <span> · avg {data.avg_rating.toFixed(1)}★</span>
            )}
          </div>
        </div>
        <Link
          href="/reviews"
          style={{
            fontSize:       11,
            color:          UX.ink3,
            textDecoration: 'none',
            padding:        '3px 9px',
            background:     UX.pageBg,
            border:         `1px solid ${UX.border}`,
            borderRadius:   999,
          }}
        >
          View all →
        </Link>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {top.map(t => <ThemeRow key={t.category} theme={t} />)}
      </div>
    </div>
  )
}

function ThemeRow({ theme: t }: { theme: ThemeAgg }) {
  const tone: 'good' | 'warn' | 'bad' =
    t.net_sentiment > 0.3   ? 'good'
    : t.net_sentiment < -0.3 ? 'bad'
    : 'warn'
  const palette = {
    good: { fg: UX.greenInk, bg: UX.greenBg,  border: '#bbf7d0' },
    warn: { fg: UX.amberInk, bg: UX.amberBg, border: '#fde68a' },
    bad:  { fg: '#b91c1c',   bg: '#fef2f2',   border: '#fecaca' },
  }[tone]

  const arrow = tone === 'good' ? '↑' : tone === 'bad' ? '↓' : '·'
  const phrase = t.example_phrases[0] ?? null

  return (
    <div style={{
      display:        'grid',
      gridTemplateColumns: '120px 70px 1fr',
      gap:            10,
      alignItems:     'center',
      padding:        '8px 10px',
      background:     palette.bg,
      border:         `1px solid ${palette.border}`,
      borderRadius:   6,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: UX.ink1, display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ color: palette.fg }}>{arrow}</span>
        {CATEGORY_LABEL[t.category] ?? t.category}
      </div>
      <div style={{ fontSize: 10, color: UX.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
        <span style={{ color: UX.greenInk, fontWeight: 600 }}>+{t.positive_count}</span>
        {' / '}
        <span style={{ color: '#b91c1c', fontWeight: 600 }}>−{t.negative_count}</span>
      </div>
      <div style={{ fontSize: 11, color: UX.ink3, lineHeight: 1.45, fontStyle: 'italic' as const }}>
        {phrase ? `"${phrase}"` : <span style={{ color: UX.ink4, fontStyle: 'normal' as const }}>No quote yet</span>}
      </div>
    </div>
  )
}
