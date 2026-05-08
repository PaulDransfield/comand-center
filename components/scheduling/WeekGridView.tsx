'use client'
// components/scheduling/WeekGridView.tsx
//
// Three-row weekly scheduling grid: demand forecast / scheduled hours / AI
// suggested. New default view on /scheduling. Pairs with the existing
// AiHoursReductionMap (the "Day-by-day list" toggle) — both consume the same
// /api/scheduling/ai-suggestion payload, neither modifies the agent.
//
// Visual spec: scheduling-page-v4.html. Values come from the API; the mockup
// values are illustrative. See computeWeekStats.ts for the math.
//
// Click any green AI-suggested cell → reasoning panel opens below the grid.
// Click again to close. Apply / Decline buttons in the panel call the
// existing /api/scheduling/accept-day endpoint via the parent's onAcceptDay
// callback (matching the pattern AiHoursReductionMap already uses).

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { UX } from '@/lib/constants/tokens'
import {
  computeWeekStats,
  pctIfDayApplied,
  type DayRow,
  type WeekStats,
  type WeekStatsInput,
} from './computeWeekStats'

// ── Bucket → emoji icon. Mirrors the dashboard demand widget so visual ──────
// language is consistent across the app.
const BUCKET_ICON: Record<string, string> = {
  clear:    '☀️',
  mild:     '⛅',
  cold_dry: '🌬',
  wet:      '🌧',
  snow:     '❄️',
  freezing: '🥶',
  hot:      '🔥',
  thunder:  '⛈',
}

interface AcceptRow {
  date:            string
  ai_hours:        number
  ai_cost_kr:      number
  current_hours:   number
  current_cost_kr: number
  est_revenue_kr:  number | null
}

interface Props {
  loading:       boolean
  error:         string
  data:          (WeekStatsInput & { week_from?: string; week_to?: string }) | null
  rangeLabel:    string
  acceptances:   Record<string, any>
  onAcceptDay:   (row: AcceptRow) => Promise<void> | void
  fmt:           (n: number | null | undefined) => string
  fmtHrs:        (n: number | null | undefined) => string
}

export default function WeekGridView({
  loading, error, data, rangeLabel,
  acceptances, onAcceptDay, fmt, fmtHrs,
}: Props) {
  const t = useTranslations('scheduling.weekGrid')
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [decidingDate, setDecidingDate] = useState<string | null>(null)

  // ── Derived stats ───────────────────────────────────────────────────────
  const stats: WeekStats | null = useMemo(() => {
    if (!data) return null
    return computeWeekStats({
      current:     data.current ?? [],
      suggested:   data.suggested ?? [],
      summary:     data.summary  ?? { saving_kr: 0, current_hours: 0, suggested_hours: 0 },
      acceptances,
    })
  }, [data, acceptances])

  // Empty / loading / error states ────────────────────────────────────────
  if (loading) {
    return (
      <div style={containerCard}>
        <div style={{ padding: 40, textAlign: 'center', color: UX.ink4, fontSize: 13 }}>
          {t('loading')}
        </div>
      </div>
    )
  }
  if (error) {
    return (
      <div style={containerCard}>
        <div style={{ padding: 16, fontSize: 13, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, margin: 18 }}>
          {error}
        </div>
      </div>
    )
  }
  if (!data || !stats || stats.rows.length === 0) {
    return (
      <div style={containerCard}>
        <div style={{ padding: 40, textAlign: 'center', color: UX.ink4, fontSize: 13 }}>
          <div style={{ fontWeight: 600, color: UX.ink2, marginBottom: 6 }}>{t('emptyTitle')}</div>
          <div>{t('emptyBody')}</div>
        </div>
      </div>
    )
  }

  const selectedRow: DayRow | null = selectedIdx != null ? stats.rows[selectedIdx] ?? null : null
  const dateRangeLabel = data.week_from && data.week_to
    ? `${formatRangeLabel(data.week_from)} — ${formatRangeLabel(data.week_to, true)}`
    : rangeLabel

  // Group rows by ISO week. For 7-day ranges this collapses to a single
  // group (no visual change). For 14/28/~30-day ranges this stacks weeks
  // vertically with a divider strip between each, so the 7-column grid
  // shape stays clean instead of overflowing or wrapping unpredictably.
  const weekGroups = groupByIsoWeek(stats.rows)

  // ── Grid render ─────────────────────────────────────────────────────────
  return (
    <>
      <div style={containerCard}>
        {/* Card head */}
        <div style={{
          padding:       '14px 22px',
          borderBottom:  `1px solid ${UX.borderSoft}`,
          display:       'flex',
          alignItems:    'center',
          justifyContent:'space-between',
          gap:           12,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: UX.ink1 }}>
              {dateRangeLabel}
            </div>
            <div style={{ fontSize: 11, color: UX.ink4, marginTop: 2 }}>
              {weekGroups.length > 1
                ? t('headSubtitleMulti', { count: weekGroups.length })
                : t('headSubtitle')}
            </div>
          </div>
        </div>

        {/* One block per ISO week, stacked vertically. Single-week ranges
            render exactly one block (no divider). Multi-week ranges get a
            week-label strip between blocks. */}
        <div style={{ padding: '16px 22px 20px' }}>
          {weekGroups.map((group, groupIdx) => (
            <div key={`week-${group.year}-${group.weekNum}`} style={{ marginTop: groupIdx === 0 ? 0 : 22 }}>
              {/* Week divider strip — shows the week number + date range.
                  Hidden for single-week ranges (the card-head already names
                  the period). */}
              {weekGroups.length > 1 && (
                <div style={weekDividerStrip}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: UX.ink2, letterSpacing: '0.04em' }}>
                    {t('weekLabel', { num: group.weekNum })}
                  </div>
                  <div style={{ fontSize: 11, color: UX.ink4 }}>
                    {formatRangeLabel(group.weekStart, true)} — {formatRangeLabel(group.weekEnd, true)}
                  </div>
                </div>
              )}

              {/* The actual 3-row × N-column mini-grid */}
              <div style={{ overflowX: 'auto' }}>
                <div style={gridTableFor(group.days.length)}>
                  {/* Top-left empty cell */}
                  <div />
                  {/* Column headers */}
                  {group.days.map(r => {
                    const date = new Date(r.date)
                    const isToday = sameYmd(r.date, new Date())
                    const dayAbbrev = ABBREV[(date.getUTCDay() + 6) % 7]
                    const dayNum = date.getUTCDate()
                    return (
                      <div key={`hdr-${r.date}`} style={{ padding: '4px 4px 10px', textAlign: 'center' }}>
                        <div style={{
                          fontSize:      10,
                          color:         isToday ? UX.greenInk : UX.ink4,
                          textTransform: 'uppercase' as const,
                          letterSpacing: '0.06em',
                          fontWeight:    500,
                          marginBottom:  2,
                        }}>{dayAbbrev}</div>
                        <div style={{
                          fontSize:   17,
                          fontWeight: 700,
                          color:      isToday ? UX.greenInk : UX.ink1,
                          lineHeight: 1,
                        }}>{dayNum}</div>
                      </div>
                    )
                  })}

                  {/* Row 1 — Demand forecast */}
                  <RowLabel name={t('row.forecast')} sub={t('row.forecastSub')} />
                  {group.days.map(r => (
                    <ForecastCell key={`fcst-${r.date}`} row={r} fmt={fmt} t={t} />
                  ))}

                  {/* Row 2 — You scheduled */}
                  <RowLabel name={t('row.scheduled')} sub={t('row.scheduledSub')} />
                  {group.days.map(r => (
                    <ScheduledCell key={`cur-${r.date}`} row={r} fmt={fmt} fmtHrs={fmtHrs} t={t} />
                  ))}

                  {/* Row 3 — AI suggests */}
                  <RowLabel name={t('row.aiSuggests')} sub={t('row.aiSuggestsSub')} />
                  {group.days.map(r => (
                    <SuggestedCell
                      key={`sug-${r.date}`}
                      row={r}
                      isSelected={selectedIdx === r.index}
                      onClick={() => {
                        if (r.status !== 'green') return
                        setSelectedIdx(prev => prev === r.index ? null : r.index)
                      }}
                      fmt={fmt}
                      fmtHrs={fmtHrs}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Reasoning panel — opens when a green day is selected */}
      {selectedRow && (
        <ReasoningPanel
          row={selectedRow}
          stats={stats}
          deciding={decidingDate === selectedRow.date}
          onClose={() => setSelectedIdx(null)}
          onApply={async () => {
            setDecidingDate(selectedRow.date)
            try {
              await onAcceptDay({
                date:            selectedRow.date,
                ai_hours:        selectedRow.aiHours,
                ai_cost_kr:      Math.round(selectedRow.aiCost),
                current_hours:   selectedRow.curHours,
                current_cost_kr: Math.round(selectedRow.curCost),
                est_revenue_kr:  selectedRow.estRevenue || null,
              })
              setSelectedIdx(null)
            } finally {
              setDecidingDate(null)
            }
          }}
          fmt={fmt}
          fmtHrs={fmtHrs}
          t={t}
        />
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────────────────────
//  Sub-components
// ────────────────────────────────────────────────────────────────────────────

function RowLabel({ name, sub }: { name: string; sub: string }) {
  return (
    <div style={{
      padding:        '12px 8px 12px 0',
      display:        'flex',
      flexDirection:  'column' as const,
      justifyContent: 'center',
      borderRight:    `1px solid ${UX.borderSoft}`,
    }}>
      <div style={{ fontSize: 12, color: UX.ink1, fontWeight: 600, lineHeight: 1.25 }}>{name}</div>
      <div style={{ fontSize: 10, color: UX.ink4, marginTop: 2, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{sub}</div>
    </div>
  )
}

function ForecastCell({ row, fmt, t }: {
  row: DayRow
  fmt: (n: number | null | undefined) => string
  t:   (key: string, vars?: any) => string
}) {
  const icon = row.weather ? (BUCKET_ICON[row.weather.bucket] ?? '·') : '·'
  const tempLabel = row.weather
    ? `${Math.round(row.weather.temp_min)}°/${Math.round(row.weather.temp_max)}°${row.weather.precip_mm > 0.5 ? ' · rain' : ''}`
    : '—'
  return (
    <div style={cellForecast}>
      <div style={{ fontSize: 14, fontWeight: 700, color: UX_INFO_INK, lineHeight: 1 }}>
        {row.estRevenue > 0 ? fmt(row.estRevenue) : '—'}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1 }}>{icon}</div>
      <div style={{ fontSize: 10, color: UX_INFO_INK, opacity: 0.85 }}>{tempLabel}</div>
    </div>
  )
}

function ScheduledCell({ row, fmt, fmtHrs, t }: {
  row:    DayRow
  fmt:    (n: number | null | undefined) => string
  fmtHrs: (n: number | null | undefined) => string
  t:      (key: string, vars?: any) => string
}) {
  return (
    <div style={cellScheduled}>
      <div style={{ fontSize: 17, fontWeight: 700, color: UX.ink1, lineHeight: 1 }}>
        {fmtHrs(row.curHours)}
      </div>
      <div style={{ fontSize: 11, color: UX.ink4, fontWeight: 500 }}>{fmt(row.curCost)}</div>
      <div style={dayPctQuiet}>
        {t('cell.dayPct')} · <span style={dayPctNum}>{row.curDayPct != null ? `${Math.round(row.curDayPct)}%` : '—'}</span>
      </div>
    </div>
  )
}

function SuggestedCell({ row, isSelected, onClick, fmt, fmtHrs, t }: {
  row:        DayRow
  isSelected: boolean
  onClick:    () => void
  fmt:        (n: number | null | undefined) => string
  fmtHrs:     (n: number | null | undefined) => string
  t:          (key: string, vars?: any) => string
}) {
  const isGreen = row.status === 'green' && !row.isAccepted
  const isSame  = !isGreen
  const baseStyle = isSelected ? cellSuggestedSelected : isSame ? cellSuggestedSame : cellSuggested

  const hoursColor = isSelected ? '#fff' : isSame ? UX.ink3 : UX.greenInk
  const deltaText = (() => {
    if (row.isAccepted) return t('cell.applied')
    if (row.status === 'green') return t('cell.cutSave', { hrs: fmtHrs(row.deltaHours), kr: fmt(row.savingKr) })
    if (row.status === 'amber')         return t('cell.amber')
    if (row.status === 'gray-closed')   return t('cell.closed')
    return t('cell.onTarget')
  })()

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isGreen}
      style={{
        ...baseStyle,
        cursor: isGreen ? 'pointer' : 'default',
        fontFamily: 'inherit',
      }}
      title={isGreen ? t('cell.clickHint') : undefined}
    >
      <div style={{ fontSize: 17, fontWeight: 700, color: hoursColor, lineHeight: 1 }}>
        {fmtHrs(row.aiHours)}
      </div>
      <div style={{
        fontSize:   11,
        fontWeight: 600,
        color:      isSelected ? 'rgba(255,255,255,0.85)' : isSame ? UX.ink4 : UX.greenInk,
        textAlign:  'center' as const,
      }}>
        {deltaText}
      </div>
      <div style={{
        ...dayPctQuiet,
        color:           isSelected ? 'rgba(255,255,255,0.7)' : isGreen ? UX.greenInk : UX.ink4,
        borderTopColor:  isSelected ? 'rgba(255,255,255,0.2)' : isGreen ? '#c5e3d2' : UX.borderSoft,
      }}>
        {t('cell.dayPct')} ·{' '}
        <span style={{
          ...dayPctNum,
          color: isSelected ? '#fff' : isGreen ? UX.greenInk : UX.ink3,
        }}>
          {row.aiDayPct != null ? `${Math.round(row.aiDayPct)}%` : '—'}
        </span>
      </div>
    </button>
  )
}

function ReasoningPanel({ row, stats, deciding, onClose, onApply, fmt, fmtHrs, t }: {
  row:      DayRow
  stats:    WeekStats
  deciding: boolean
  onClose:  () => void
  onApply:  () => void | Promise<void>
  fmt:      (n: number | null | undefined) => string
  fmtHrs:   (n: number | null | undefined) => string
  t:        (key: string, vars?: any) => string
}) {
  const pctNow      = stats.weekLabourPctCurrent
  const pctIfDay    = pctIfDayApplied(stats, row.index)
  const pctIfAll    = stats.weekLabourPctProjected
  const dayPctCur   = row.curDayPct
  const dayPctAi    = row.aiDayPct
  const dateLabel   = formatRangeLabel(row.date, true)
  const fullWeekday = WEEKDAY_FULL[(new Date(row.date).getUTCDay() + 6) % 7]

  // Department breakdown — pull from the input row in computeWeekStats's
  // source data (we don't carry it on DayRow to keep the type tight).
  // Render at most the top 4 departments by hours; the rest collapse into
  // an aggregate "Others" line so the panel doesn't blow vertically on a
  // big restaurant.
  const dept = (row as any).deptBreakdown ?? null

  return (
    <div style={reasoningPanel}>
      <button onClick={onClose} style={reasoningClose} title={t('panel.close')}>×</button>

      {/* Left column — narrative + actions */}
      <div>
        <div style={{ fontSize: 11, color: UX.ink4, textTransform: 'uppercase' as const, letterSpacing: '0.08em', fontWeight: 500, marginBottom: 8 }}>
          {fullWeekday} {dateLabel} · {t('panel.selected')}
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: UX.ink1, lineHeight: 1.3, marginBottom: 12 }}>
          {t('panel.headline', {
            hrs:       fmtHrs(row.deltaHours),
            day:       fullWeekday,
            pctCur:    pctNow != null ? `${Math.round(pctNow)}%` : '—',
            pctIfDay:  pctIfDay != null ? `${Math.round(pctIfDay)}%` : '—',
          })}
        </h3>
        <p style={reasoningBody}>{row.reasoning}</p>

        <div style={reasoningStats}>
          <div>
            <div style={rstatLabel}>{t('panel.weekImpact')}</div>
            <div style={rstatValueGreen}>
              {pctNow != null ? `${Math.round(pctNow)}%` : '—'}{' → '}
              {pctIfDay != null ? `${Math.round(pctIfDay)}%` : '—'}
            </div>
          </div>
          <div>
            <div style={rstatLabel}>{t('panel.saves')}</div>
            <div style={rstatValueGreen}>{fmt(row.savingKr)}</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onApply} disabled={deciding} style={btnPrimary(deciding)}>
            {deciding ? t('panel.applying') : t('panel.applyDay', { day: fullWeekday })}
          </button>
          <button onClick={onClose} style={btnDecline}>{t('panel.decline')}</button>
        </div>
      </div>

      {/* Right column — week-impact compounding + dept breakdown */}
      <div>
        <div style={reasoningDetailH}>{t('panel.compoundingTitle')}</div>
        <div style={weekImpactCard}>
          <div style={weekImpactRow}>
            <span style={weekImpactLabel}>{t('panel.compounding.scheduled')}</span>
            <span style={weekImpactValue}>{pctNow != null ? `${Math.round(pctNow)}%` : '—'}</span>
          </div>
          <div style={weekImpactRow}>
            <span style={weekImpactLabel}>{t('panel.compounding.ifDayApplied', { day: fullWeekday })}</span>
            <span style={weekImpactValue}>{pctIfDay != null ? `${Math.round(pctIfDay)}%` : '—'}</span>
          </div>
          <div style={{ height: 1, background: UX.borderSoft, margin: '6px 0' }} />
          <div style={weekImpactRow}>
            <span style={weekImpactLabel}>{t('panel.compounding.ifAllApplied')}</span>
            <span style={weekImpactValueImproved}>{pctIfAll != null ? `${Math.round(pctIfAll)}%` : '—'}</span>
          </div>
        </div>

        {dept && Object.keys(dept).length > 0 && (
          <>
            <div style={reasoningDetailH}>{t('panel.deptTitle')}</div>
            <DeptList deptBreakdown={dept} fmtHrs={fmtHrs} />
          </>
        )}
      </div>
    </div>
  )
}

function DeptList({ deptBreakdown, fmtHrs }: {
  deptBreakdown: Record<string, { hours: number; cost: number }>
  fmtHrs:        (n: number | null | undefined) => string
}) {
  const entries = Object.entries(deptBreakdown)
    .sort(([, a], [, b]) => b.hours - a.hours)
    .slice(0, 4)
  const maxH = Math.max(...entries.map(([, v]) => v.hours), 1)
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {entries.map(([name, info]) => (
        <li key={name} style={{
          display:             'grid',
          gridTemplateColumns: '1fr 80px 64px',
          gap:                 10,
          padding:             '8px 0',
          borderBottom:        `1px solid ${UX.borderSoft}`,
          alignItems:          'center',
          fontSize:            13,
        }}>
          <div style={{ color: UX.ink1, fontWeight: 500 }}>{name}</div>
          <div style={{ background: '#e9eae5', height: 6, borderRadius: 100, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(info.hours / maxH) * 100}%`, background: UX.ink4, borderRadius: 100 }} />
          </div>
          <div style={{ fontSize: 12, color: UX.ink1, textAlign: 'right' as const, fontWeight: 600 }}>{fmtHrs(info.hours)}</div>
        </li>
      ))}
    </ul>
  )
}

// ────────────────────────────────────────────────────────────────────────────
//  Style maps — kept inline rather than inventing a CSS module pattern that
//  the rest of the codebase doesn't use. Tokens come from lib/constants/tokens
//  and a few hex values that the mockup defines (info-bg, green-bg etc.) are
//  borrowed locally.
// ────────────────────────────────────────────────────────────────────────────

const UX_INFO_INK    = '#3a6f9a'
const UX_INFO_BG     = '#ebf2f8'
const UX_INFO_LINE   = '#cfdce9'
const UX_GREEN_BG    = '#e8f3ec'
const UX_GREEN_LINE  = '#c5e3d2'

const containerCard: React.CSSProperties = {
  background:   'white',
  border:       `1px solid ${UX.borderSoft}`,
  borderRadius: 10,
  overflow:     'hidden' as const,
  marginBottom: 18,
}

/**
 * Build the gridTemplateColumns for an N-day week. Used so partial weeks
 * (e.g. the first/last week of a "Next month" range) render with the right
 * number of columns instead of stretching 7 cells over fewer days.
 */
function gridTableFor(dayCount: number): React.CSSProperties {
  return {
    display:             'grid',
    gridTemplateColumns: `100px repeat(${dayCount}, minmax(110px, 1fr))`,
    gap:                 4,
    // minWidth scales with day count so a 5-day partial week doesn't
    // force horizontal scroll the way a full 7-day week needs to on
    // narrow viewports.
    minWidth:            100 + dayCount * 110,
  }
}

const weekDividerStrip: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'center',
  padding:        '8px 12px',
  marginBottom:   10,
  background:     '#f3f4f0',
  border:         `1px solid ${UX.borderSoft}`,
  borderRadius:   6,
}

const cellForecast: React.CSSProperties = {
  background:    UX_INFO_BG,
  border:        `1px solid ${UX_INFO_LINE}`,
  borderRadius:  8,
  padding:       '10px 8px',
  textAlign:     'center',
  minHeight:     90,
  display:       'flex',
  flexDirection: 'column' as const,
  justifyContent:'center',
  gap:           4,
}

const cellScheduled: React.CSSProperties = {
  background:    'white',
  border:        `1px solid ${UX.borderSoft}`,
  borderRadius:  8,
  padding:       '11px 8px',
  textAlign:     'center',
  minHeight:     90,
  display:       'flex',
  flexDirection: 'column' as const,
  justifyContent:'center',
  gap:           4,
}

const cellSuggested: React.CSSProperties = {
  background:    UX_GREEN_BG,
  border:        `1px solid ${UX_GREEN_LINE}`,
  borderRadius:  8,
  padding:       '11px 8px',
  textAlign:     'center',
  minHeight:     90,
  display:       'flex',
  flexDirection: 'column' as const,
  justifyContent:'center',
  gap:           4,
  position:      'relative',
  transition:    'all 0.15s',
  fontFamily:    'inherit',
}
const cellSuggestedSame: React.CSSProperties = {
  ...cellSuggested,
  background:   'white',
  borderColor:  UX.borderSoft,
}
const cellSuggestedSelected: React.CSSProperties = {
  ...cellSuggested,
  background:   UX.greenInk,
  borderColor:  UX.greenInk,
}

const dayPctQuiet: React.CSSProperties = {
  marginTop:     4,
  paddingTop:    6,
  borderTop:     `1px dashed ${UX.borderSoft}`,
  fontSize:      10,
  color:         UX.ink4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
}
const dayPctNum: React.CSSProperties = {
  fontWeight:    700,
  color:         UX.ink3,
  textTransform: 'none' as const,
  letterSpacing: 0,
  fontSize:      11,
}

const reasoningPanel: React.CSSProperties = {
  background:          'white',
  border:              `1px solid ${UX.borderSoft}`,
  borderLeft:          `4px solid ${UX.greenInk}`,
  borderRadius:        10,
  padding:             '22px 26px',
  marginBottom:        18,
  display:             'grid',
  gridTemplateColumns: '1.2fr 1fr',
  gap:                 32,
  position:            'relative',
}
const reasoningClose: React.CSSProperties = {
  position:     'absolute' as const,
  top:          14,
  right:        14,
  background:   '#f3f4f0',
  border:       `1px solid ${UX.borderSoft}`,
  color:        UX.ink3,
  width:        28,
  height:       28,
  borderRadius: 6,
  cursor:       'pointer',
  fontSize:     14,
  display:      'grid',
  placeItems:   'center',
}
const reasoningBody: React.CSSProperties = {
  fontSize:     13,
  lineHeight:   1.6,
  color:        UX.ink2,
  marginBottom: 14,
}
const reasoningStats: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: '1fr 1fr',
  gap:                 14,
  padding:             '14px 0',
  borderTop:           `1px solid ${UX.borderSoft}`,
  borderBottom:        `1px solid ${UX.borderSoft}`,
  marginBottom:        16,
}
const rstatLabel: React.CSSProperties = {
  fontSize:      10,
  color:         UX.ink4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  fontWeight:    500,
  marginBottom:  4,
}
const rstatValueGreen: React.CSSProperties = {
  fontSize:   17,
  fontWeight: 700,
  color:      UX.greenInk,
}
const reasoningDetailH: React.CSSProperties = {
  fontSize:      11,
  color:         UX.ink4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  fontWeight:    500,
  marginBottom:  10,
}
const weekImpactCard: React.CSSProperties = {
  background:   '#f3f4f0',
  border:       `1px solid ${UX.borderSoft}`,
  borderRadius: 8,
  padding:      '14px 18px',
  marginBottom: 18,
}
const weekImpactRow: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'baseline',
  padding:        '4px 0',
}
const weekImpactLabel: React.CSSProperties = { fontSize: 12, color: UX.ink3 }
const weekImpactValue: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: UX.ink1 }
const weekImpactValueImproved: React.CSSProperties = { ...weekImpactValue, color: UX.greenInk }

function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    background:   disabled ? '#9ca3af' : UX.greenInk,
    color:        'white',
    border:       'none',
    padding:      '10px 18px',
    borderRadius: 100,
    fontSize:     13,
    fontWeight:   600,
    cursor:       disabled ? 'wait' : 'pointer',
    fontFamily:   'inherit',
  }
}
const btnDecline: React.CSSProperties = {
  background:   'white',
  color:        UX.ink3,
  border:       `1px solid ${UX.borderSoft}`,
  padding:      '10px 18px',
  borderRadius: 100,
  fontSize:     13,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}

// ────────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────────

const ABBREV       = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatRangeLabel(iso: string, includeMonth = false): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const day = d.getUTCDate()
  const mon = MONTHS_SHORT[d.getUTCMonth()] ?? ''
  return includeMonth ? `${mon} ${day}` : `${mon} ${day}`
}

function sameYmd(iso: string, d: Date): boolean {
  return iso === `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

interface WeekGroup {
  year:      number
  weekNum:   number       // ISO 8601 week number
  weekStart: string       // YYYY-MM-DD of Monday (or first day in group if range starts mid-week)
  weekEnd:   string       // YYYY-MM-DD of Sunday (or last day in group)
  days:      DayRow[]     // chronologically ordered, length 1-7
}

/**
 * Group rows by ISO 8601 week. Preserves chronological order. Partial weeks
 * (range starts mid-week or ends mid-week) render with fewer columns rather
 * than padding — the user sees what's actually in their range.
 */
function groupByIsoWeek(rows: DayRow[]): WeekGroup[] {
  const out: WeekGroup[] = []
  let current: WeekGroup | null = null
  for (const r of rows) {
    const d = new Date(r.date + 'T00:00:00Z')
    const { year, week } = isoYearAndWeek(d)
    if (!current || current.year !== year || current.weekNum !== week) {
      current = { year, weekNum: week, weekStart: r.date, weekEnd: r.date, days: [] }
      out.push(current)
    }
    current.days.push(r)
    current.weekEnd = r.date  // last seen date in this group
  }
  return out
}

/**
 * ISO 8601 year + week number for a date. Same algorithm as the existing
 * getISOWeek() helper on app/scheduling/page.tsx — duplicated here so this
 * component stays self-contained (no cross-import to a page-level helper).
 */
function isoYearAndWeek(d: Date): { year: number; week: number } {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // Move to the nearest Thursday (ISO weeks are anchored to Thursday)
  const dayNum = dt.getUTCDay() || 7
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return { year: dt.getUTCFullYear(), week }
}
