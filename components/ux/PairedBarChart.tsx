'use client'
// components/ux/PairedBarChart.tsx
//
// Inline-SVG clustered-bar chart with optional 1–2 line overlays on a
// right axis. Phase 1 — presentational only.
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

import { UXP } from '@/lib/constants/tokens'
import { fmtNum } from '@/lib/format'

export interface ClusterSeries {
  label: string
  /** Value per group, in the same order as `groups`. */
  data:  number[]
  color: string   // override; defaults wrap on the lavender palette
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
  const yLeftFor  = (v: number) => PAD_T + innerH - (Math.max(0, v) / yLeftMax)  * innerH
  const yRightFor = (v: number) => PAD_T + innerH - (Math.max(0, v) / yRightMax) * innerH
  const xMidFor   = (gi: number) => PAD_L + gi * groupW + groupW / 2

  // Y-axis ticks — 4 evenly-spaced gridlines
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    yPx:    PAD_T + (1 - t) * innerH,
    left:   t * yLeftMax,
    right:  t * yRightMax,
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Bar chart"
        style={{ display: 'block', overflow: 'visible' as const }}
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
          const colour = s.color || LAV_PALETTE[si % LAV_PALETTE.length]
          return s.data.map((v, gi) => {
            const val = Number.isFinite(v) ? Math.max(0, v) : 0
            const yT  = yLeftFor(val)
            const h   = (PAD_T + innerH) - yT
            return (
              <rect
                key={`b-${si}-${gi}`}
                x={xFor(gi, si)} y={yT} width={barW} height={Math.max(0, h)}
                rx={3} ry={3} fill={colour}
              />
            )
          })
        })}

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
