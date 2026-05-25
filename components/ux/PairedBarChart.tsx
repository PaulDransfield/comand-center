'use client'
// components/ux/PairedBarChart.tsx
//
// Inline-SVG clustered-bar chart with optional 1–2 line overlays on a
// right axis. Presentational + hover tooltip.
//
// Critical fidelity rules (verbatim from the Phase 1 prompt):
//   • viewBox width = render width 1:1 so SVG strokes stay crisp
//   • Bars: rx=3
//   • Cluster colours: #a99ce6 / #c4b8ec / #d8d2f0 (lav / lavMid / lavPale)
//   • Line overlays: #c0703a solid + #e7a37e dashed, stroke-width 2
//   • Axis ticks: fontSize 7, rgba(58,53,80,0.45)
//   • Legend: fontSize 9
//
// All numeric figures consuming this chart should be fmtKr / fmtNum
// outputs — never raw template-literal " kr" suffixes.

import { useState } from 'react'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtNum } from '@/lib/format'

export interface ClusterSeries {
  label: string
  /** Value per group, in the same order as `groups`. */
  data:  number[]
  color: string   // override; defaults wrap on the lavender palette
  /**
   * Optional per-bar colour overrides — same length as `data`. A non-null
   * value at index `i` replaces the series default for that bar only.
   * Used to paint today's in-progress labour bar a distinct pastel.
   */
  colorOverrides?: (string | null)[]
  /**
   * Optional per-bar stroke colour — same length as `data`. Lets the
   * caller add a definition outline around specific bars without
   * affecting the rest of the series.
   */
  strokeOverrides?: (string | null)[]
}

export interface LineOverlay {
  label:  string
  /** Value per group, on the right axis. */
  data:   (number | null)[]
  color:  string
  dashed?: boolean
}

export interface PairedBarChartProps {
  /** Group labels along the X-axis. */
  groups:        string[]
  series:        ClusterSeries[]    // 1–3 clustered bars per group
  lines?:        LineOverlay[]      // 0–2 lines on the right axis
  /** Bar height = leftMax. Default: auto-derived from series. */
  leftMax?:      number
  rightMax?:     number
  /** Currency unit for left axis labels. Default: "kr". */
  leftAxisUnit?: string
  width?:        number   // default 640
  height?:       number   // default 220
  /** Show the legend below the chart. Default true. */
  legend?:       boolean
}

const LAV_PALETTE = ['#a99ce6', '#c4b8ec', '#d8d2f0']  // UXP.lav / lavMid / lavPale

export default function PairedBarChart({
  groups, series, lines = [],
  leftMax, rightMax,
  leftAxisUnit = 'kr',
  width = 640, height = 220, legend = true,
}: PairedBarChartProps) {
  const PAD_L = 38   // left axis labels
  const PAD_R = lines.length > 0 ? 38 : 12
  const PAD_T = 10
  const PAD_B = 24

  const innerW = width - PAD_L - PAD_R
  const innerH = height - PAD_T - PAD_B

  // Y-max calculations
  const autoLeftMax = Math.max(1, ...series.flatMap(s => s.data.filter(v => Number.isFinite(v))))
  const yLeftMax = leftMax ?? roundUpNice(autoLeftMax)
  const autoRightMax = lines.length === 0
    ? 1
    : Math.max(1, ...lines.flatMap(l => l.data.filter((v): v is number => Number.isFinite(v as any))))
  const yRightMax = rightMax ?? roundUpNice(autoRightMax)

  // Geometry
  const groupCount  = Math.max(1, groups.length)
  const groupW      = innerW / groupCount
  const clusterGap  = Math.min(8, groupW * 0.12)
  const innerClusterW = groupW - clusterGap
  const seriesCount = Math.max(1, series.length)
  const barW        = Math.max(2, (innerClusterW - (seriesCount - 1) * 2) / seriesCount)

  const xFor = (gi: number, si: number) =>
    PAD_L + gi * groupW + clusterGap / 2 + si * (barW + 2)
  // Clamp both axes to [0, max] so a value outside the visible range
  // (e.g. labour% = 500% on a closed day) tops out at the chart ceiling
  // instead of producing a negative y that bleeds above the SVG.
  const yLeftFor  = (v: number) => PAD_T + innerH - (Math.min(yLeftMax,  Math.max(0, v)) / yLeftMax ) * innerH
  const yRightFor = (v: number) => PAD_T + innerH - (Math.min(yRightMax, Math.max(0, v)) / yRightMax) * innerH
  const xMidFor   = (gi: number) => PAD_L + gi * groupW + groupW / 2

  // Y-axis ticks — 4 evenly-spaced gridlines
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    yPx:    PAD_T + (1 - t) * innerH,
    left:   t * yLeftMax,
    right:  t * yRightMax,
  }))

  // ── Hover tooltip ─────────────────────────────────────────────
  // Pure-presentational: we track which group index the cursor is
  // over and render a small fixed-position pill next to it. The
  // hover surface is an invisible <rect> per group spanning the full
  // chart height so the user can hover anywhere in the column.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' as const }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Bar chart"
        // Belt-and-braces with the clamp above: even if a future change
        // forgets to clamp a value, hidden overflow keeps the SVG from
        // spilling onto sibling elements (Vero dashboard bug 2026-05-21
        // — labour% line drew above the KPI strip).
        style={{ display: 'block', overflow: 'hidden' as const }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Gridlines + left + right axis ticks */}
        {yTicks.map(t => (
          <g key={t.yPx}>
            <line x1={PAD_L} x2={width - PAD_R} y1={t.yPx} y2={t.yPx}
                  stroke={UXP.borderSoft} strokeWidth={0.5} />
            <text x={PAD_L - 4} y={t.yPx + 2.5} fontSize={7}
                  fill="rgba(58,53,80,0.45)" textAnchor="end">
              {fmtNum(Math.round(t.left))}{leftAxisUnit ? ` ${leftAxisUnit}` : ''}
            </text>
            {lines.length > 0 && (
              <text x={width - PAD_R + 4} y={t.yPx + 2.5} fontSize={7}
                    fill="rgba(58,53,80,0.45)" textAnchor="start">
                {Math.round(t.right)}
              </text>
            )}
          </g>
        ))}

        {/* Group labels along X */}
        {groups.map((g, gi) => (
          <text key={`xl-${gi}`}
                x={xMidFor(gi)} y={height - PAD_B + 12}
                fontSize={7} fill="rgba(58,53,80,0.45)"
                textAnchor="middle">
            {g}
          </text>
        ))}

        {/* Clustered bars */}
        {series.map((s, si) => {
          const defaultColour = s.color || LAV_PALETTE[si % LAV_PALETTE.length]
          return s.data.map((v, gi) => {
            const val = Number.isFinite(v) ? Math.max(0, v) : 0
            const yT  = yLeftFor(val)
            const h   = (PAD_T + innerH) - yT
            const colour = s.colorOverrides?.[gi] || defaultColour
            const stroke = s.strokeOverrides?.[gi]
            return (
              <rect
                key={`b-${si}-${gi}`}
                x={xFor(gi, si)} y={yT} width={barW} height={Math.max(0, h)}
                rx={3} ry={3} fill={colour}
                stroke={stroke || 'none'}
                strokeWidth={stroke ? 0.8 : 0}
              />
            )
          })
        })}

        {/* Hover-target columns — invisible rectangles that span the
            full chart height so the user can hover anywhere in a
            group's column. Sits beneath the line overlays so the
            line markers still receive their own pointer events when
            the cursor lands on a circle. */}
        {groups.map((_g, gi) => {
          const x = PAD_L + gi * groupW
          return (
            <rect
              key={`hover-${gi}`}
              x={x} y={PAD_T} width={groupW} height={innerH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(gi)}
              onMouseMove={() => setHoverIdx(gi)}
            />
          )
        })}

        {/* Vertical hover guide */}
        {hoverIdx != null && (
          <line
            x1={xMidFor(hoverIdx)} x2={xMidFor(hoverIdx)}
            y1={PAD_T} y2={PAD_T + innerH}
            stroke={UXP.lavMid} strokeWidth={0.5}
            pointerEvents="none"
          />
        )}

        {/* Line overlays */}
        {lines.map((line, li) => {
          const pts: Array<{ x: number; y: number }> = []
          line.data.forEach((v, gi) => {
            if (!Number.isFinite(v as any)) return
            pts.push({ x: xMidFor(gi), y: yRightFor(v as number) })
          })
          if (pts.length < 2) return null
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
          return (
            <g key={`ln-${li}`}>
              <path d={d}
                    fill="none"
                    stroke={line.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={line.dashed ? '4,3' : undefined} />
              {pts.map((p, i) => (
                <circle key={`lnp-${li}-${i}`} cx={p.x} cy={p.y} r={2.5} fill={line.color} />
              ))}
            </g>
          )
        })}
      </svg>

      {/* Hover tooltip — absolute, positioned by the hovered group's
          centre in % of chart width so the pill follows the SVG
          even when the container scales. */}
      {hoverIdx != null && (
        <div
          style={{
            position:    'absolute' as const,
            top:         8,
            left:        `${((xMidFor(hoverIdx)) / width) * 100}%`,
            transform:   hoverIdx > groupCount / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
            background:  UXP.cardBg,
            border:      `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_md,
            padding:     '8px 10px',
            boxShadow:   '0 8px 24px rgba(58,53,80,0.12)',
            fontSize:    10,
            color:       UXP.ink1,
            pointerEvents: 'none' as const,
            zIndex:      5,
            minWidth:    120,
            display:     'grid',
            gap:         3,
          }}
        >
          <div style={{ fontSize: 9, color: UXP.ink3, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            {groups[hoverIdx]}
          </div>
          {series.map((s, si) => {
            const v = s.data[hoverIdx]
            const color = s.color || LAV_PALETTE[si % LAV_PALETTE.length]
            return (
              <div key={`tt-s-${si}`} style={{ display: 'grid', gridTemplateColumns: '8px 1fr auto', gap: 6, alignItems: 'center' }}>
                <span style={{ width: 6, height: 6, borderRadius: 2, background: color }} />
                <span style={{ color: UXP.ink2 }}>{s.label}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1, fontWeight: 500 }}>
                  {Number.isFinite(v) && v !== 0
                    ? (leftAxisUnit === 'kr' ? fmtKr(Math.round(Number(v))) : fmtNum(Math.round(Number(v))))
                    : '—'}
                </span>
              </div>
            )
          })}
          {lines.map((l, li) => {
            const v = l.data[hoverIdx]
            return (
              <div key={`tt-l-${li}`} style={{ display: 'grid', gridTemplateColumns: '8px 1fr auto', gap: 6, alignItems: 'center' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: l.color }} />
                <span style={{ color: UXP.ink2 }}>{l.label}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1, fontWeight: 500 }}>
                  {v != null && Number.isFinite(v) ? `${Math.round(Number(v))}` : '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Legend */}
      {legend && (
        <div style={{
          display: 'flex', gap: 14, flexWrap: 'wrap' as const,
          fontSize: 9, color: UXP.ink3,
        }}>
          {series.map((s, si) => (
            <span key={`sl-${si}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 9, height: 4, borderRadius: 2, background: s.color || LAV_PALETTE[si % LAV_PALETTE.length] }} />
              {s.label}
            </span>
          ))}
          {lines.map((l, li) => (
            <span key={`ll-${li}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                width: 12, height: 2, background: l.color,
                borderTop: l.dashed ? `2px dashed ${l.color}` : 'none',
                ...(l.dashed ? { background: 'transparent' } : {}),
              }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// Round up to a "nice" axis ceiling (1/2/5 × 10^n) so labels are tidy.
function roundUpNice(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}
