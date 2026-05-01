'use client'
// @ts-nocheck
// app/departments/page.tsx — Phase 9 of the UX redesign, per DESIGN.md § 9.
//
// Structure:
//   PageHero   eyebrow + best/worst margin contrast headline + 3 SupportingStats
//              (Revenue / Profit / Rev/hour).
//   Primary    single department table — status dot, name (+ inline NEEDS
//              ACTION pill when margin < 0), revenue, profit, GP%, labour%,
//              30d sparkline. Total row pinned at the bottom.
//   Supporting AttentionPanel — 3 bullets max (worst dept + trending-down +
//              anomaly).
export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
import StatusPill from '@/components/ui/StatusPill'
import Sparkline from '@/components/ui/Sparkline'
import SegmentedToggle from '@/components/ui/SegmentedToggle'
import TopBar from '@/components/ui/TopBar'
import { UX } from '@/lib/constants/tokens'
import { deptColor } from '@/lib/constants/colors'
import { fmtKr, fmtPct } from '@/lib/format'
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - day)
  const y1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - y1.getTime()) / 86400000 + 1) / 7)
}
function getWeekBounds(offset = 0) {
  const today = new Date(), dow = today.getDay()
  const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7); mon.setHours(0,0,0,0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  return { from: localDate(mon), to: localDate(sun), weekNum: getISOWeek(mon), label: mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}` }
}
function getMonthBounds(offset = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + offset, 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: localDate(d), to: localDate(last), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` }
}

export default function DepartmentsPage() {
  const router  = useRouter()
  const t       = useTranslations('operations.departments')
  const tCrumbs = useTranslations('operations.crumbs')
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('month')
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync(); window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    fetch(`/api/departments?from=${curr.from}&to=${curr.to}&business_id=${bizId}`)
      .then(r => r.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [bizId, weekOffset, monthOffset, viewMode])

  const depts: any[]  = data?.departments ?? []
  const summary: any  = data?.summary ?? {}
  const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel = viewMode === 'week' ? `Week ${(curr as any).weekNum}` : curr.label

  // Filter out rows with no revenue AND no labour — those were rendering as
  // all-em-dash rows with a green status dot, which read as "active but
  // blank" (FIX-PROMPT § Phase 9 Q2). A department only shows up in the
  // table when it has real activity.
  const activeDepts = depts.filter(d => Number(d.revenue ?? 0) > 0 || Number(d.staff_cost ?? 0) > 0)
  const hasAnyActivity = activeDepts.length > 0

  // Rank by margin %
  const withGP = activeDepts.filter(d => d.gp_pct != null && d.revenue > 0)
  const sortedByGP = [...withGP].sort((a, b) => Number(b.gp_pct) - Number(a.gp_pct))
  const best  = sortedByGP[0] ?? null
  const worst = sortedByGP[sortedByGP.length - 1] ?? null

  // Hero headline — resolves the contradiction where the old copy said
  // "No department data" while the table still listed a dept row
  // (FIX-PROMPT § Phase 9 Q1). Three states:
  //   - truly empty         → explicit empty state, no table below
  //   - activity w/o margin → name the active dept(s), explain data gap
  //   - best/worst spread   → original contrast headline
  const headline = (() => {
    if (loading) return <>{t('loading')}</>
    if (!hasAnyActivity) {
      return <>{t('hero.noActivity', { period: periodLabel })}</>
    }
    if (withGP.length === 0) {
      const names = activeDepts.slice(0, 3).map(d => d.name).filter(Boolean).join(', ')
      return <>{t('hero.noSplit', { names })}</>
    }
    if (best && worst && best !== worst) {
      return <span>{t('hero.spread', {
        bestName:  best.name,
        bestPct:   fmtPct(best.gp_pct),
        worstName: worst.name,
        worstPct:  fmtPct(worst.gp_pct),
      })}</span>
    }
    if (best) {
      return <span>{t('hero.soloActive', { name: best.name, pct: fmtPct(best.gp_pct) })}</span>
    }
    return <>{t('hero.noMargin')}</>
  })()

  const heroContext = (() => {
    if (!hasAnyActivity) return undefined
    const parts: string[] = []
    if (summary.total_revenue > 0) parts.push(t('hero.ctxTotal',     { amount: fmtKr(summary.total_revenue) }))
    if (summary.labour_pct != null) parts.push(t('hero.ctxAvgLabour', { pct: fmtPct(summary.labour_pct) }))
    if (worst && Number(worst.revenue ?? 0) - Number(worst.staff_cost ?? 0) < 0) {
      parts.push(t('hero.ctxAtLoss', { name: worst.name }))
    }
    return parts.length ? parts.join(' · ') : undefined
  })()

  // Build attention items
  const attention: AttentionItem[] = []
  for (const d of sortedByGP.slice().reverse().slice(0, 2)) {
    const profit = Number(d.revenue ?? 0) - Number(d.staff_cost ?? 0)
    if (profit < 0) {
      attention.push({
        tone:    'bad',
        entity:  d.name,
        message: t('attention.atLoss', { amount: fmtKr(Math.abs(profit)) }),
      })
    } else if (d.gp_pct != null && d.gp_pct < 30) {
      attention.push({
        tone:    'warning',
        entity:  d.name,
        message: t('attention.lowMargin', { pct: fmtPct(d.gp_pct) }),
      })
    }
  }
  // Anomaly: very-high-margin dept with no labour allocation (data gap)
  for (const d of activeDepts) {
    if (d.gp_pct != null && d.gp_pct > 95 && Number(d.staff_cost ?? 0) === 0 && Number(d.revenue ?? 0) > 1000) {
      if (attention.length < 3) {
        attention.push({
          tone:    'warning',
          entity:  d.name,
          message: t('attention.noLabour'),
        })
      }
    }
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>

        {/* TopBar — breadcrumb + period nav + W/M toggle in the right slot */}
        <TopBar
          crumbs={[
            { label: tCrumbs('operations') },
            { label: tCrumbs('departments'), active: true },
          ]}
          rightSlot={
            <>
              {viewMode === 'week' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => setWeekOffset(o => o - 1)} style={deptNavBtn}>‹</button>
                  <div style={{ minWidth: 120, textAlign: 'center' as const, fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: UX.ink1 }}>
                    {t('weekLabel', { num: (curr as any).weekNum, range: curr.label })}
                  </div>
                  <button onClick={() => setWeekOffset(o => Math.min(o + 1, 0))} disabled={weekOffset === 0} style={{ ...deptNavBtn, color: weekOffset === 0 ? UX.ink5 : UX.ink2, cursor: weekOffset === 0 ? 'not-allowed' : 'pointer' }}>›</button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => setMonthOffset(o => o - 1)} style={deptNavBtn}>‹</button>
                  <div style={{ minWidth: 120, textAlign: 'center' as const, fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: UX.ink1 }}>{curr.label}</div>
                  <button onClick={() => setMonthOffset(o => Math.min(o + 1, 0))} disabled={monthOffset === 0} style={{ ...deptNavBtn, color: monthOffset === 0 ? UX.ink5 : UX.ink2, cursor: monthOffset === 0 ? 'not-allowed' : 'pointer' }}>›</button>
                </div>
              )}
              <SegmentedToggle
                options={[{ value: 'week', label: 'W' }, { value: 'month', label: 'M' }]}
                value={viewMode}
                onChange={(v) => setViewMode(v as 'week' | 'month')}
              />
            </>
          }
        />

        {/* PageHero — SupportingStats only rendered when there's real
            activity, so we don't prominently display "0 kr · 0 dept"
            next to an empty-state headline. */}
        <PageHero
          eyebrow={t('eyebrow', { period: periodLabel.toUpperCase() })}
          headline={headline}
          context={heroContext}
          right={hasAnyActivity ? (
            <SupportingStats
              items={[
                {
                  label: t('stats.revenue'),
                  value: fmtKr(summary.total_revenue ?? 0),
                  sub:   t('stats.departments', { count: activeDepts.length }),
                },
                {
                  label: t('stats.profit'),
                  value: fmtKr(Math.max(0, (summary.total_revenue ?? 0) - (summary.total_staff_cost ?? 0))),
                  sub:   summary.gp_pct != null ? t('stats.groupGP', { pct: fmtPct(summary.gp_pct) }) : undefined,
                  deltaTone: summary.gp_pct != null && summary.gp_pct >= 45 ? 'good' : 'bad' as const,
                },
                {
                  label: t('stats.revPerHour'),
                  value: summary.rev_per_hour ? fmtKr(summary.rev_per_hour) : '—',
                  sub:   summary.total_hours ? t('stats.hoursWorked', { hours: Math.round(summary.total_hours) }) : undefined,
                },
              ]}
            />
          ) : undefined}
        />

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>{t('loadingPanel')}</div>
        ) : !hasAnyActivity ? (
          // Explicit empty state per FIX-PROMPT § Phase 9 Q1 — hide the
          // table entirely rather than render a grid of em-dashes.
          <div style={{
            background:   UX.cardBg,
            border:       `0.5px solid ${UX.border}`,
            borderRadius: UX.r_lg,
            padding:      48,
            textAlign:    'center' as const,
          }}>
            <div style={{ fontSize: 15, fontWeight: UX.fwMedium, color: UX.ink1, marginBottom: 8 }}>
              {t('empty.title', { period: periodLabel })}
            </div>
            <div style={{ fontSize: UX.fsBody, color: UX.ink3, maxWidth: 440, margin: '0 auto' }}>
              {t('empty.body')}
            </div>
          </div>
        ) : (
          <>
            {/* ─── Primary: single table ─────────────────────────────────── */}
            <div style={{
              background:   UX.cardBg,
              border:       `0.5px solid ${UX.border}`,
              borderRadius: UX.r_lg,
              overflow:     'hidden' as const,
              marginBottom: 12,
            }}>
              <div style={{ overflowX: 'auto' as const }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: UX.fsBody }}>
                  <thead>
                    <tr style={{ background: UX.subtleBg }}>
                      {[
                        { key: 'spacer',     label: '' },
                        { key: 'department', label: t('table.department') },
                        { key: 'revenue',    label: t('table.revenue') },
                        { key: 'profit',     label: t('table.profit') },
                        { key: 'gpPct',      label: t('table.gpPct') },
                        { key: 'labourPct',  label: t('table.labourPct') },
                        { key: 'trend',      label: t('table.trend') },
                      ].map((h, i) => (
                        <th
                          key={h.key}
                          style={{
                            padding:       '10px 14px',
                            textAlign:     i <= 1 ? 'left' as const : 'right' as const,
                            fontSize:      UX.fsMicro,
                            fontWeight:    UX.fwMedium,
                            color:         UX.ink4,
                            letterSpacing: '.06em',
                            textTransform: 'uppercase' as const,
                            width:         i === 0 ? 24 : undefined,
                          }}
                        >
                          {h.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...activeDepts].sort((a: any, b: any) => (Number(b?.revenue) || 0) - (Number(a?.revenue) || 0)).map((d: any) => {
                      const rev    = Number(d?.revenue ?? 0)
                      const cost   = Number(d?.staff_cost ?? 0)
                      const profit = rev - cost
                      const noData = rev === 0 && cost === 0  // kept for safety; activeDepts already excludes these
                      const marginTone: 'good' | 'bad' | 'warning' | 'neutral' =
                          d?.gp_pct == null ? 'neutral'
                        : d.gp_pct >= 55 ? 'good'
                        : d.gp_pct >= 30 ? 'warning'
                        :                  'bad'
                      const labourTone: 'good' | 'warning' | 'bad' | 'neutral' =
                          d?.labour_pct == null ? 'neutral'
                        : d.labour_pct <= 40 ? 'good'
                        : d.labour_pct <= 70 ? 'warning'
                        :                      'bad'
                      const dotColour = d?.color ?? deptColor(d?.name ?? '') ?? UX.ink4
                      const rowBg = profit < 0 ? UX.redSoft : 'transparent'
                      return (
                        <tr
                          key={d.name}
                          onClick={() => d?.name && router.push(`/departments/${encodeURIComponent(d.name)}`)}
                          style={{
                            borderTop:    `0.5px solid ${UX.borderSoft}`,
                            cursor:       'pointer',
                            background:   rowBg,
                            opacity:      noData ? 0.55 : 1,
                          }}
                          onMouseEnter={e => { if (!noData) (e.currentTarget as HTMLTableRowElement).style.background = UX.subtleBg }}
                          onMouseLeave={e => { if (!noData) (e.currentTarget as HTMLTableRowElement).style.background = rowBg }}
                        >
                          <td style={{ padding: '10px 14px', textAlign: 'center' as const }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColour, display: 'inline-block' }} />
                          </td>
                          <td style={{ padding: '10px 14px', color: UX.ink1, fontWeight: UX.fwMedium }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                              {d?.name || '—'}
                              {profit < 0 && <StatusPill tone="bad">NEEDS ACTION</StatusPill>}
                            </span>
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, color: rev > 0 ? UX.ink1 : UX.ink5, fontVariantNumeric: 'tabular-nums' as const }}>
                            {rev > 0 ? fmtKr(rev) : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontWeight: UX.fwMedium, color: profit > 0 ? UX.greenInk : profit < 0 ? UX.redInk : UX.ink5, fontVariantNumeric: 'tabular-nums' as const }}>
                            {profit !== 0 ? (profit < 0 ? '−' : '') + fmtKr(Math.abs(profit)) : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color:
                              marginTone === 'good'    ? UX.greenInk
                            : marginTone === 'warning' ? UX.amberInk
                            : marginTone === 'bad'     ? UX.redInk
                            :                            UX.ink5,
                              fontWeight: UX.fwMedium,
                          }}>
                            {d?.gp_pct != null ? fmtPct(d.gp_pct) : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const }}>
                            {d?.labour_pct != null ? (
                              <span style={{
                                fontSize: UX.fsMicro,
                                fontWeight: UX.fwMedium,
                                padding: '2px 7px',
                                borderRadius: UX.r_sm,
                                background:
                                  labourTone === 'good'    ? UX.greenBg
                                : labourTone === 'warning' ? UX.amberBg
                                : labourTone === 'bad'     ? UX.redBg
                                :                            UX.borderSoft,
                                color:
                                  labourTone === 'good'    ? UX.greenInk
                                : labourTone === 'warning' ? UX.amberInk2
                                : labourTone === 'bad'     ? UX.redInk2
                                :                            UX.ink3,
                              }}>
                                {fmtPct(d.labour_pct)}
                              </span>
                            ) : <span style={{ color: UX.ink5 }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const }}>
                            <Sparkline points={[]} tone={marginTone} dashed width={60} height={14} />
                          </td>
                        </tr>
                      )
                    })}

                    {/* Total row pinned */}
                    {summary && (
                      <tr style={{ background: UX.subtleBg, borderTop: `1px solid ${UX.border}` }}>
                        <td />
                        <td style={{ padding: '10px 14px', fontWeight: UX.fwMedium, color: UX.ink1 }}>Total</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontWeight: UX.fwMedium, color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
                          {fmtKr(summary.total_revenue ?? 0)}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontWeight: UX.fwMedium, color: UX.greenInk, fontVariantNumeric: 'tabular-nums' as const }}>
                          {fmtKr(Math.max(0, (summary.total_revenue ?? 0) - (summary.total_staff_cost ?? 0)))}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontWeight: UX.fwMedium, color: UX.greenInk, fontVariantNumeric: 'tabular-nums' as const }}>
                          {fmtPct(summary.gp_pct)}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontWeight: UX.fwMedium, color: summary.labour_pct != null && summary.labour_pct <= 40 ? UX.greenInk : UX.redInk, fontVariantNumeric: 'tabular-nums' as const }}>
                          {fmtPct(summary.labour_pct)}
                        </td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ─── Supporting: AttentionPanel ───────────────────────────── */}
            {attention.length > 0 && (
              <AttentionPanel
                items={attention}
                maxItems={3}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

const deptNavBtn = {
  width: 28, height: 28, borderRadius: UX.r_md, border: `0.5px solid ${UX.border}`,
  background: UX.cardBg, cursor: 'pointer', fontSize: 14,
  display: 'flex', alignItems: 'center', justifyContent: 'center', color: UX.ink2,
} as const
