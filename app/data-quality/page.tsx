'use client'
// @ts-nocheck
// app/data-quality/page.tsx — A1.9 drilldown
//
// Full breakdown of the dashboard's "Data trust" tile. Owners land here
// from the tile or from a low-score alert. Each dimension is a card with
// its score, count/total, owner-readable hint, and a CTA to the page
// where they can improve it (review queue, recipes, articles, etc.).
//
// Data source: GET /api/data-quality/score?business_id=…
// Renders pure UXP. Mobile-first stacking.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import { UXP } from '@/lib/constants/tokens'

interface Dimension {
  key:          string
  label:        string
  score:        number | null
  count:        number
  total:        number
  hint:         string
  action_label: string
  action_href:  string
}

interface Score {
  business_id:   string
  overall_score: number | null
  applicable:    number
  dimensions:    Dimension[]
  computed_at:   string
}

export default function DataQualityPage() {
  const [bizId, setBizId] = useState<string | null>(null)
  const [score, setScore] = useState<Score | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    setErr(null)
    fetch(`/api/data-quality/score?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (j?.error) setErr(j.error)
        else          setScore(j)
      })
      .catch(e => setErr(String(e?.message ?? e)))
      .finally(() => setLoading(false))
  }, [bizId])

  const overall = score?.overall_score
  const overallTone =
    overall == null    ? UXP.ink3
    : overall >= 80    ? UXP.green
    : overall >= 50    ? UXP.coral
    :                    UXP.rose
  const overallBg =
    overall == null    ? UXP.subtleBg
    : overall >= 80    ? UXP.greenFill
    : overall >= 50    ? UXP.lavFill
    :                    UXP.roseFill

  return (
    <AppShell>
      <PageContainer>
        <div style={{ display: 'grid', gap: 14, marginTop: 4 }}>

          {/* Header */}
          <div>
            <div style={{ fontSize: 11, color: UXP.ink4, letterSpacing: '0.06em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
              Data quality
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.02em', marginBottom: 4 }}>
              Can I trust these numbers?
            </div>
            <div style={{ fontSize: 13, color: UXP.ink3, lineHeight: 1.5, maxWidth: 640 }}>
              Each metric in CommandCenter depends on a few feeds. This page shows how complete each feed is — so you know whether the dashboard is giving you the full picture or just half of it.
            </div>
          </div>

          {/* Overall score card */}
          <div style={{
            background:    UXP.cardBg,
            border:        `0.5px solid ${UXP.border}`,
            borderRadius:  UXP.r_lg,
            padding:       '20px 22px',
            boxShadow:     UXP.shadowCard,
            display:       'grid',
            gridTemplateColumns: 'auto 1fr',
            gap:           22,
            alignItems:    'center',
          }}>
            <div style={{
              width:        96,
              height:       96,
              borderRadius: '50%',
              background:   overallBg,
              border:       `0.5px solid ${overallTone}33`,
              display:      'inline-flex',
              flexDirection: 'column' as const,
              alignItems:   'center',
              justifyContent: 'center',
            }}>
              <div style={{
                fontSize:       32,
                fontWeight:     600,
                color:          overallTone,
                letterSpacing:  '-0.02em',
                fontVariantNumeric: 'tabular-nums' as const,
                lineHeight:     1,
              }}>
                {loading ? '…' : (overall ?? '—')}
              </div>
              <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 4, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
                {overall == null ? 'n/a' : 'of 100'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: UXP.ink2, marginBottom: 4 }}>
                Overall data trust score
              </div>
              <div style={{ fontSize: 11, color: UXP.ink4 }}>
                {score
                  ? `Equal-weighted average of ${score.applicable} applicable dimensions. Last computed ${formatRelative(score.computed_at)}.`
                  : loading
                    ? 'Loading…'
                    : err
                      ? `Error: ${err}`
                      : 'No data yet.'}
              </div>
            </div>
          </div>

          {/* Per-dimension cards */}
          <div style={{ display: 'grid', gap: 10 }}>
            {(score?.dimensions ?? []).map((d) => {
              const applicable = d.total > 0 && d.score !== null
              const sc = d.score ?? 0
              const tone =
                !applicable     ? UXP.ink4
                : sc >= 80      ? UXP.green
                : sc >= 50      ? UXP.coral
                :                 UXP.rose
              const bg =
                !applicable     ? UXP.subtleBg
                : sc >= 80      ? UXP.greenFill
                : sc >= 50      ? UXP.lavFill
                :                 UXP.roseFill
              return (
                <div key={d.key} style={{
                  background:    UXP.cardBg,
                  border:        `0.5px solid ${UXP.border}`,
                  borderRadius:  UXP.r_lg,
                  padding:       '16px 18px',
                  display:       'grid',
                  gridTemplateColumns: 'auto 1fr auto',
                  gap:           16,
                  alignItems:    'center',
                  boxShadow:     UXP.shadowCard,
                }}>
                  {/* Score bubble */}
                  <div style={{
                    width:        56,
                    height:       56,
                    borderRadius: '50%',
                    background:   bg,
                    border:       `0.5px solid ${tone}22`,
                    display:      'inline-flex',
                    alignItems:   'center',
                    justifyContent: 'center',
                  }}>
                    <div style={{
                      fontSize:       16,
                      fontWeight:     600,
                      color:          tone,
                      letterSpacing:  '-0.02em',
                      fontVariantNumeric: 'tabular-nums' as const,
                    }}>
                      {applicable ? `${d.score}%` : 'n/a'}
                    </div>
                  </div>

                  {/* Label + count + hint */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1, marginBottom: 2 }}>
                      {d.label}
                    </div>
                    <div style={{ fontSize: 11, color: UXP.ink3, lineHeight: 1.5 }}>
                      {d.hint}
                    </div>
                    {applicable && (
                      <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>
                        {d.count} of {d.total}
                      </div>
                    )}
                  </div>

                  {/* CTA */}
                  <a href={d.action_href} style={{
                    padding:        '7px 14px',
                    background:     bg,
                    color:          tone,
                    border:         `0.5px solid ${tone}33`,
                    borderRadius:   999,
                    fontSize:       11,
                    fontWeight:     500,
                    textDecoration: 'none',
                    whiteSpace:     'nowrap' as const,
                  }}>
                    {d.action_label}
                  </a>
                </div>
              )
            })}
            {!loading && (score?.dimensions ?? []).length === 0 && (
              <div style={{ fontSize: 12, color: UXP.ink3, padding: '24px 0', textAlign: 'center' as const }}>
                Nothing to score yet. Connect Fortnox + Personalkollen to start populating data.
              </div>
            )}
          </div>

          {/* Footer note */}
          <div style={{ fontSize: 10, color: UXP.ink4, lineHeight: 1.5, marginTop: 8 }}>
            Honest-incomplete rule: a dimension marked &quot;n/a&quot; has zero in-scope items to score against (e.g. no dish recipes yet). It doesn&apos;t count toward the overall score until you populate it.
          </div>
        </div>
      </PageContainer>
    </AppShell>
  )
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'just now'
  const then = new Date(iso).getTime()
  const now  = Date.now()
  const sec  = Math.max(0, Math.round((now - then) / 1000))
  if (sec < 60)        return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60)        return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24)         return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}
