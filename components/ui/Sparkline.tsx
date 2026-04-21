// components/ui/Sparkline.tsx
// Single-line SVG trend marker. No axes, no labels, no markers.
// For "no data" states render a single dashed horizontal line.
// Spec: DESIGN.md § Sparkline.

'use client'

import { UX } from '@/lib/constants/tokens'

export type SparklineTone = 'good' | 'bad' | 'warning' | 'neutral'

export interface SparklineProps {
  points:   number[]
  tone?:    SparklineTone
  width?:   number
  height?:  number
  dashed?:  boolean
}

const TONE_COLOUR: Record<SparklineTone, string> = {
  good:    UX.greenInk,
  bad:     UX.redInk,
  warning: UX.amberInk,
  neutral: UX.ink4,
}

export default function Sparkline({
  points,
  tone    = 'neutral',
  width   = 48,
  height  = 16,
  dashed,
}: SparklineProps) {
  const stroke = TONE_COLOUR[tone]

  // No data → single flat dashed line in ink5.
  if (!points || points.length === 0) {
    return (
      <svg width={width} height={height} role="img" aria-label="No trend data">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={UX.ink5}
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      </svg>
    )
  }

  // Normalise to the full vertical space with 1 px padding.
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const padY = 1
  const plotH = height - padY * 2
  const step = points.length > 1 ? width / (points.length - 1) : 0

  const d = points
    .map((p, i) => {
      const x = i * step
      const y = padY + plotH * (1 - (p - min) / span)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} role="img" aria-label="Trend sparkline">
      <path
        d={d}
        stroke={stroke}
        strokeWidth={1.3}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={dashed ? '2 2' : undefined}
        fill="none"
      />
    </svg>
  )
}
