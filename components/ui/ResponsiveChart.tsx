'use client'
// components/ui/ResponsiveChart.tsx
//
// Container-aware chart wrapper. Replaces the 8 instances of
// `width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}`
// scattered through the dashboards.
//
// Usage:
//   <ResponsiveChart minHeight={280}>
//     {(width) => <MyChart width={width} height={280} data={…} />}
//   </ResponsiveChart>
//
// The render-prop pattern keeps the chart library agnostic — works
// with OverviewChart, Recharts, vanilla SVG, anything that accepts a
// width number.

import { useRef, type ReactNode } from 'react'
import { useContainerWidth } from '@/lib/hooks/useViewport'

export interface ResponsiveChartProps {
  children:    (width: number) => ReactNode
  /** Reserve this height so the layout doesn't jump while we measure. */
  minHeight?:  number
  /** Maximum width to cap on ultra-wide screens (default 1280). */
  maxWidth?:   number
  /** Optional className for the wrapper. */
  className?:  string
}

export function ResponsiveChart({
  children, minHeight = 240, maxWidth = 1280, className,
}: ResponsiveChartProps) {
  const ref   = useRef<HTMLDivElement>(null)
  const width = useContainerWidth(ref)
  const capped = width > 0 ? Math.min(width, maxWidth) : 0
  return (
    <div ref={ref} className={className} style={{ width: '100%', minHeight }}>
      {capped > 0 && children(capped)}
    </div>
  )
}
