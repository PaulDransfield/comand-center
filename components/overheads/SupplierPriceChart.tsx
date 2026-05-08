'use client'
// components/overheads/SupplierPriceChart.tsx
//
// 12-month line chart of monthly invoice totals for a single
// (supplier, category). Plain inline SVG — matches the dashboard's chart
// pattern (no Recharts dependency).
//
// The trailing point (most recent) is highlighted red when it sits >50%
// above the prior 11-month average, since that's typically why the user
// is looking at a price-spike flag.

import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import { useMemo } from 'react'
import { useTranslations } from 'next-intl'

export interface HistoryPoint { year: number; month: number; amount: number }

interface Props {
  history:   HistoryPoint[]
  loading?:  boolean
  error?:    string | null
}

export default function SupplierPriceChart({ history, loading, error }: Props) {
  const t  = useTranslations('overheads.review.chart')
  const tM = useTranslations('overheads')
  const monthsShort: string[] = (tM.raw('months.short') as string[])
    ?? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  const wrapStyle: React.CSSProperties = {
    background:   UX.subtleBg,
    border:       `1px solid ${UX.borderSoft}`,
    borderRadius: 8,
    padding:      '16px 18px',
  }

  if (loading) {
    return <div style={{ ...wrapStyle, color: UX.ink4, fontSize: 12, textAlign: 'center' as const, padding: 32 }}>{t('loading')}</div>
  }
  if (error) {
    return <div style={{ ...wrapStyle, color: UX.redInk, fontSize: 12, textAlign: 'center' as const, padding: 32 }}>{error}</div>
  }

  const data = history.filter(h => Number.isFinite(h.amount))
  if (data.length === 0) {
    return <div style={{ ...wrapStyle, color: UX.ink4, fontSize: 12, textAlign: 'center' as const, padding: 32 }}>{t('noData')}</div>
  }

  // Average over the historical window EXCLUDING the trailing month — that
  // matches "prior 11-month average" in the AI explanation.
  const stats = useMemo(() => {
    const trail = data[data.length - 1]
    const prior = data.slice(0, -1).filter(d => d.amount > 0)
    const priorAvg = prior.length ? prior.reduce((s, d) => s + d.amount, 0) / prior.length : 0
    const max = Math.max(...data.map(d => d.amount), priorAvg)
    const min = Math.min(...data.map(d => d.amount), 0)
    const isSpike = priorAvg > 0 && trail.amount > priorAvg * 1.5
    return { trail, prior, priorAvg, max, min, isSpike }
  }, [data])

  // Layout
  const W = 600, H = 140
  const padL = 8, padR = 8, padT = 12, padB = 24
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const xs = (i: number) => padL + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW)
  const range = Math.max(stats.max - stats.min, 1)
  const ys = (v: number) => padT + innerH - ((v - stats.min) / range) * innerH

  const polyPoints = data.map((d, i) => `${xs(i)},${ys(d.amount)}`).join(' ')
  const trailIdx = data.length - 1
  const trail = data[trailIdx]
  const prevIdx = Math.max(0, trailIdx - 1)
  const trailX = xs(trailIdx)
  const trailY = ys(trail.amount)
  const prevX  = xs(prevIdx)
  const prevY  = ys(data[prevIdx].amount)
  const avgY   = stats.priorAvg > 0 ? ys(stats.priorAvg) : null

  // Bottom-axis ticks: show every other month for readability on narrow
  // viewports.
  const tickIndices = data.length <= 6
    ? data.map((_, i) => i)
    : data.map((_, i) => i).filter(i => i % 2 === 0 || i === trailIdx)

  return (
    <div style={wrapStyle}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 140, marginBottom: 12 }}>
        {/* Grid */}
        <defs>
          <pattern id="cc-overheads-grid" width="50" height="35" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 35" fill="none" stroke="#e8e8e2" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#cc-overheads-grid)" />

        {/* Average dashed line + label */}
        {avgY != null && (
          <>
            <line x1={padL} y1={avgY} x2={W - padR} y2={avgY}
                  stroke="#8d8f86" strokeWidth="1" strokeDasharray="3,4" />
            <text x={padL + 2} y={avgY - 4} fontFamily="Inter, sans-serif" fontSize="9" fill="#8d8f86">
              {t('avgLabel', { amount: fmtKr(stats.priorAvg) })}
            </text>
          </>
        )}

        {/* History polyline up to second-to-last point */}
        {data.length > 1 && (
          <polyline
            points={data.slice(0, -1).map((d, i) => `${xs(i)},${ys(d.amount)}`).join(' ')}
            stroke={UX.ink1}
            strokeWidth="2"
            fill="none"
            strokeLinejoin="round"
          />
        )}

        {/* Spike segment OR continuation segment */}
        {data.length > 1 && (
          <line
            x1={prevX} y1={prevY} x2={trailX} y2={trailY}
            stroke={stats.isSpike ? '#b8412e' : UX.ink1}
            strokeWidth={stats.isSpike ? 2.5 : 2}
          />
        )}

        {/* Trailing marker */}
        <circle cx={trailX} cy={trailY} r={5} fill={stats.isSpike ? '#b8412e' : UX.ink1} />
        {stats.isSpike && (
          <>
            <circle cx={trailX} cy={trailY} r={10} fill="#b8412e" opacity={0.18} />
            <text
              x={Math.min(trailX, W - 60)}
              y={Math.max(trailY - 10, 14)}
              fontFamily="Inter, sans-serif"
              fontSize="11"
              fill="#b8412e"
              fontWeight="700"
              textAnchor={trailX > W - 80 ? 'end' : 'start'}
            >
              {fmtKr(trail.amount)}
            </text>
          </>
        )}

        {/* X-axis month ticks */}
        {tickIndices.map(i => (
          <text
            key={i}
            x={xs(i)}
            y={H - 6}
            fontFamily="Inter, sans-serif"
            fontSize="9"
            fill={UX.ink4}
            textAnchor="middle"
          >
            {monthsShort[data[i].month - 1]?.[0] ?? '?'}
          </text>
        ))}
      </svg>

      <div style={{ display: 'flex', gap: 18, fontSize: 11, color: UX.ink3, flexWrap: 'wrap' as const }}>
        <span><LegendLine color={UX.ink1} /> {t('legendMonthly')}</span>
        <span><LegendLine color="#8d8f86" dashed /> {t('legendAvg', { amount: fmtKr(stats.priorAvg) })}</span>
        {stats.isSpike && <span><LegendLine color="#b8412e" /> {t('legendSpike')}</span>}
      </div>
    </div>
  )
}

function LegendLine({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span style={{
      display:    'inline-block',
      width:      14,
      height:     2,
      verticalAlign: 'middle',
      marginRight: 6,
      background: dashed
        ? `repeating-linear-gradient(90deg, ${color} 0, ${color} 3px, transparent 3px, transparent 6px)`
        : color,
    }} />
  )
}
