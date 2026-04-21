// @ts-nocheck
'use client'
// app/group/page.tsx
//
// Phase 2 of the UX redesign — per DESIGN.md § 2 Group.
// Structure:
//   PageHero   → eyebrow + outlier-framed headline + group margin right
//   Primary    → location-card grid (name · status pill · revenue · delta ·
//                sparkline · 2×2 meta)
//   Supporting → AI Group Manager card styled as an AttentionPanel with
//                bullets (parsed from the narrative paragraph).
//
// Data untouched — same /api/group/overview endpoint, same shape.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
import StatusPill from '@/components/ui/StatusPill'
import Sparkline from '@/components/ui/Sparkline'
import { UX } from '@/lib/constants/tokens'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
const fmtPct = (n: number | null) => n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1) + '%'
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return {
    from:  localDate(d),
    to:    localDate(last),
    label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  }
}

export default function GroupPage() {
  const router = useRouter()
  const [monthOffset, setMonthOffset] = useState(0)
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const period = getMonthBounds(monthOffset)

  useEffect(() => {
    setLoading(true); setError('')
    fetch(`/api/group/overview?from=${period.from}&to=${period.to}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setData(j) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthOffset])

  function openBusiness(id: string) {
    localStorage.setItem('cc_selected_biz', id)
    window.dispatchEvent(new Event('storage'))
    router.push('/dashboard')
  }

  const businesses = data?.businesses ?? []
  const summary    = data?.summary ?? null
  const narrative  = data?.narrative ?? null

  // Outlier detection for hero framing + per-card pills.
  const withRev = businesses.filter((b: any) => Number(b.revenue ?? 0) > 0 || Number(b.staff_cost ?? 0) > 0)
  const byMargin = [...withRev].sort((a, b) => (a.margin_pct ?? 1e9) - (b.margin_pct ?? 1e9))
  const worst = byMargin[0] ?? null
  const best  = byMargin[byMargin.length - 1] ?? null
  const draining = worst && worst.revenue === 0 && worst.staff_cost > 0  // hours with no revenue

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>

        {/* Minimal period navigator above the hero (page-local, not a TopBar
            since there's only one crumb).  */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, gap: 4, alignItems: 'center' }}>
          <button onClick={() => setMonthOffset(o => o - 1)} style={navBtn} aria-label="Previous month">‹</button>
          <div style={{ minWidth: 140, textAlign: 'center' as const, fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: UX.ink1 }}>
            {period.label}
          </div>
          <button
            onClick={() => setMonthOffset(o => Math.min(o + 1, 0))}
            disabled={monthOffset === 0}
            aria-label="Next month"
            style={{ ...navBtn, color: monthOffset === 0 ? UX.ink5 : UX.ink2, cursor: monthOffset === 0 ? 'not-allowed' : 'pointer' }}
          >›</button>
        </div>

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading group data…</div>
        ) : error ? (
          <div style={{ background: UX.redSoft, border: `1px solid ${UX.redBorder}`, borderRadius: UX.r_lg, padding: '12px 16px', fontSize: UX.fsBody, color: UX.redInk }}>{error}</div>
        ) : businesses.length === 0 ? (
          <EmptyCard
            title="No businesses yet"
            body="Add businesses from Settings — the group view lights up as soon as you have two or more."
          />
        ) : businesses.length === 1 ? (
          <EmptyCard
            title="Only one business"
            body={<>The group view is for comparing multiple locations. You have one — use <a href="/dashboard" style={{ color: UX.indigo }}>Dashboard</a> for single-business detail.</>}
          />
        ) : (
          <>
            {/* ─── PageHero ────────────────────────────────────────────── */}
            <PageHero
              eyebrow={`GROUP STATUS — ${period.label.toUpperCase()}`}
              headline={<HeroHeadline worst={worst} best={best} draining={draining} />}
              context={buildContext(summary, businesses, worst)}
              right={summary ? (
                <SupportingStats
                  items={[
                    {
                      label: 'Revenue',
                      value: fmtKr(summary.total_revenue),
                      sub:   `${businesses.length} locations`,
                    },
                    {
                      label: 'Labour %',
                      value: fmtPct(summary.group_labour_pct),
                      sub:   'group avg',
                      deltaTone: summary.group_labour_pct != null && summary.group_labour_pct <= 40 ? 'good' : 'bad' as const,
                    },
                    {
                      label: 'Margin',
                      value: fmtPct(summary.group_margin_pct),
                      sub:   'after labour',
                      deltaTone: summary.group_margin_pct != null && summary.group_margin_pct >= 45 ? 'good' : 'bad' as const,
                    },
                  ]}
                />
              ) : undefined}
            />

            {/* ─── Location card grid (primary) ─────────────────────────── */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 10,
              marginBottom: 14,
            }}>
              {businesses.map((b: any) => {
                const margin     = Number(b.revenue ?? 0) - Number(b.staff_cost ?? 0)
                const marginPct  = b.margin_pct
                const isBest     = best && b.id === best.id && marginPct != null && marginPct >= 45
                const isWorst    = worst && b.id === worst.id && (marginPct != null && marginPct < 30 || draining)
                const noData     = !Number(b.revenue ?? 0) && !Number(b.staff_cost ?? 0)

                const pill:
                  | { tone: 'good' | 'warning' | 'bad' | 'neutral' | 'info'; label: string }
                  | null =
                    isWorst ? { tone: 'bad',  label: 'OUTLIER' }
                  : isBest  ? { tone: 'good', label: 'BEST' }
                  : noData  ? { tone: 'neutral', label: 'NO DATA' }
                  : null

                const tone: 'good' | 'bad' | 'warning' | 'neutral' =
                    marginPct == null ? 'neutral'
                  : marginPct >= 55   ? 'good'
                  : marginPct >= 30   ? 'warning'
                  :                     'bad'

                // Card surface shading — worst gets a subtle red wash, best a green border
                const cardBg = isWorst ? UX.redSoft   : UX.cardBg
                const cardBr = isWorst ? UX.redBorder : isBest ? UX.greenBorder : UX.border

                return (
                  <button
                    key={b.id}
                    onClick={() => openBusiness(b.id)}
                    style={{
                      background:   cardBg,
                      border:       `0.5px solid ${cardBr}`,
                      borderRadius: UX.r_lg,
                      padding:      '14px 14px 12px',
                      textAlign:    'left' as const,
                      cursor:       'pointer',
                      transition:   'transform .12s ease, box-shadow .12s ease',
                      minWidth:     0,
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)'
                      ;(e.currentTarget as HTMLButtonElement).style.boxShadow = UX.shadowPop
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLButtonElement).style.transform = 'none'
                      ;(e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'
                    }}
                  >
                    {/* Card header — name + status */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: b.colour ?? UX.ink4, flexShrink: 0, display: 'inline-block' }} />
                          <div style={{ fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: UX.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                            {b.name}
                          </div>
                        </div>
                        {b.city && <div style={{ fontSize: UX.fsMicro, color: UX.ink4, marginLeft: 12 }}>{b.city}</div>}
                      </div>
                      {pill && <StatusPill tone={pill.tone}>{pill.label}</StatusPill>}
                    </div>

                    {/* Revenue headline + delta */}
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                      <div style={{ fontSize: 18, fontWeight: UX.fwMedium, color: UX.ink1, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' as const }}>
                        {b.revenue > 0 ? fmtKr(b.revenue) : '—'}
                      </div>
                      {b.revenue_delta_pct != null && (
                        <div style={{ fontSize: UX.fsMicro, fontWeight: UX.fwMedium, color: b.revenue_delta_pct >= 0 ? UX.greenInk : UX.redInk }}>
                          {b.revenue_delta_pct >= 0 ? '↑' : '↓'} {Math.abs(b.revenue_delta_pct)}%
                        </div>
                      )}
                    </div>

                    {/* Sparkline — dashed placeholder (no per-biz time series fetched here) */}
                    <div style={{ margin: '6px 0 8px' }}>
                      <Sparkline points={[]} tone={tone} dashed width={160} height={14} />
                    </div>

                    {/* 2×2 meta grid */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '6px 10px',
                      fontSize: UX.fsMicro,
                      color: UX.ink3,
                    }}>
                      <Meta label="Labour"    value={b.staff_cost > 0 ? fmtKr(b.staff_cost) : '—'} />
                      <Meta label="Labour %"  value={fmtPct(b.labour_pct)} tone={b.labour_pct != null && b.labour_pct > (b.target_staff_pct ?? 40) ? 'bad' : 'good'} />
                      <Meta label="Margin"    value={fmtPct(marginPct)}    tone={tone} />
                      <Meta label="Rev/hour"  value={b.rev_per_hour ? fmtKr(b.rev_per_hour) : '—'} />
                    </div>
                  </button>
                )
              })}
            </div>

            {/* ─── AI Group Manager as AttentionPanel-style card ──────── */}
            <AttentionPanel
              title="AI Group Manager"
              rightSlot={
                <span style={{ fontSize: UX.fsMicro, color: UX.ink4 }}>
                  Based on {businesses.length} locations · {period.label}
                </span>
              }
              items={narrativeToItems(narrative, businesses)}
            />
          </>
        )}
      </div>

      <AskAI
        page="group"
        context={summary ? [
          `Period: ${period.label} (${period.from} to ${period.to})`,
          `${summary.business_count} locations · revenue ${fmtKr(summary.total_revenue)} · labour ${fmtKr(summary.total_staff_cost)} (${fmtPct(summary.group_labour_pct)}) · margin ${fmtPct(summary.group_margin_pct)}`,
          businesses.map((b: any) => `${b.name}: ${fmtKr(b.revenue)} rev · ${fmtPct(b.labour_pct)} labour · ${fmtPct(b.margin_pct)} margin · ${b.hours}h`).join('\n'),
        ].join('\n') : 'No data yet'}
      />
    </AppShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero headline — names the worst outlier if one exists, else the best.
// Kept to one sentence under the 14-word spec where possible.
// ─────────────────────────────────────────────────────────────────────────────
function HeroHeadline({ worst, best, draining }: any) {
  if (!worst && !best) {
    return <>No group data yet for this period.</>
  }
  if (draining && worst) {
    return (
      <>
        <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{worst.name} is draining the group</span>
        {' '}— {Math.round(Number(worst.hours ?? 0))} labour hours on zero revenue.
      </>
    )
  }
  if (worst && worst.margin_pct != null && worst.margin_pct < 30) {
    return (
      <>
        <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{worst.name} off target</span>
        {' '}at {fmtPct(worst.margin_pct)} margin
        {best && best.id !== worst.id && best.margin_pct != null && (
          <> — <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{best.name} carrying at {fmtPct(best.margin_pct)}</span>.</>
        )}
        {(!best || best.id === worst.id || best.margin_pct == null) && '.'}
      </>
    )
  }
  if (best && best.margin_pct != null) {
    return (
      <>
        <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{best.name} leading the group</span>
        {' '}at {fmtPct(best.margin_pct)} margin.
      </>
    )
  }
  return <>Group running across all locations.</>
}

function buildContext(summary: any, businesses: any[], worst: any): string {
  if (!summary) return ''
  const parts: string[] = []
  parts.push(`${businesses.length} locations · ${fmtKr(summary.total_revenue)} total · labour ${fmtPct(summary.group_labour_pct)}`)
  if (worst && Number(worst.revenue ?? 0) > 0 && worst.margin_pct != null && worst.margin_pct < 45) {
    parts.push(`${worst.name} margin ${fmtPct(worst.margin_pct)}`)
  }
  return parts.join(' · ')
}

// Split the Claude-written narrative into a few short AttentionPanel items.
// If the narrative is structured as sentences, take the first 2–3; otherwise
// collapse it to a single bullet.
function narrativeToItems(narrative: string | null, businesses: any[]): AttentionItem[] {
  if (!narrative) return []
  const sentences = narrative
    .split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ])/)
    .map(s => s.trim())
    .filter(s => s.length > 5)
    .slice(0, 3)
  if (!sentences.length) return [{ tone: 'warning', entity: 'AI', message: narrative.slice(0, 200) }]
  return sentences.map((msg, i) => ({
    // First sentence = verdict (warning/bad), following = supporting/actions (good).
    tone:    (i === 0 ? 'warning' : 'good') as 'good' | 'warning' | 'bad',
    entity:  i === 0 ? 'Verdict' : i === 1 ? 'Why' : 'Do this',
    message: msg,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline helpers
// ─────────────────────────────────────────────────────────────────────────────
function Meta({ label, value, tone }: any) {
  const color =
    tone === 'good'    ? UX.greenInk :
    tone === 'bad'     ? UX.redInk   :
    tone === 'warning' ? UX.amberInk :
                         UX.ink2
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1, minWidth: 0 }}>
      <span style={{ fontSize: 9, color: UX.ink4, letterSpacing: '.05em', textTransform: 'uppercase' as const, fontWeight: UX.fwMedium }}>{label}</span>
      <span style={{ fontSize: UX.fsLabel, color, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>{value}</span>
    </div>
  )
}

function EmptyCard({ title, body }: any) {
  return (
    <div style={{ background: UX.cardBg, border: `0.5px solid ${UX.border}`, borderRadius: UX.r_lg, padding: 48, textAlign: 'center' as const }}>
      <div style={{ fontSize: 15, fontWeight: UX.fwMedium, color: UX.ink1, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: UX.fsBody, color: UX.ink3, maxWidth: 440, margin: '0 auto' }}>{body}</div>
    </div>
  )
}

const navBtn = {
  width: 28, height: 28, borderRadius: UX.r_md, border: `0.5px solid ${UX.border}`,
  background: UX.cardBg, cursor: 'pointer', fontSize: 14,
  display: 'flex', alignItems: 'center', justifyContent: 'center', color: UX.ink2,
} as const
