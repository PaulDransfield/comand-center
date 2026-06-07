// components/ui/Skeleton.tsx
//
// Loading skeleton primitives — UXP-palette consistent so the "loading"
// state lives inside the same visual system as the loaded surface.
// Three blocks: <Skeleton> (line / shape), <SkeletonCard> (card box),
// <SkeletonTable> (header + N rows).
//
// Used by:
//   - app/<segment>/loading.tsx — Next.js route-segment loading UI shown
//     during navigation + initial server render before client hydration.
//   - In-page loading branches when a client component is waiting on
//     fetch / SWR data — replaces the previous flash-of-empty.

import { UXP } from '@/lib/constants/tokens'

// Animated shimmer keyframes injected once into the document head — kept
// as a single global stylesheet so consumers don't need styled-components.
// Pulse animation is subtle (0.6 -> 0.95 alpha) so it doesn't feel like
// the page is broken / flashing.
const SHIMMER_STYLE = `
@keyframes cc-skel-pulse {
  0%, 100% { opacity: 0.65; }
  50%      { opacity: 0.95; }
}
.cc-skel { animation: cc-skel-pulse 1.6s ease-in-out infinite; }
`

let __injected = false
function ensureShimmerStyle() {
  if (__injected || typeof document === 'undefined') return
  __injected = true
  const s = document.createElement('style')
  s.textContent = SHIMMER_STYLE
  document.head.appendChild(s)
}

export interface SkeletonProps {
  width?:    number | string
  height?:   number | string
  radius?:   number
  inline?:   boolean        // render inline-block instead of block
  className?: string
  style?:    React.CSSProperties
}

export function Skeleton({
  width = '100%', height = 12, radius = 4, inline = false, style,
}: SkeletonProps) {
  if (typeof window !== 'undefined') ensureShimmerStyle()
  return (
    <div
      className="cc-skel"
      style={{
        display: inline ? 'inline-block' : 'block',
        width, height,
        background: 'rgba(58,53,80,0.08)',
        borderRadius: radius,
        ...style,
      }}
    />
  )
}

// Card-shaped skeleton — matches the resting card surface (cardBg + 0.5px
// border + 10px radius) so when real content arrives the box doesn't
// jump. Pass children to seed it with line skeletons; pass `lines` for
// a quick default.
export function SkeletonCard({
  height,
  lines = 3,
  showTitle = true,
  style,
  children,
}: {
  height?: number | string
  lines?:  number
  showTitle?: boolean
  style?:  React.CSSProperties
  children?: React.ReactNode
}) {
  return (
    <div style={{
      background: UXP.cardBg,
      border: `0.5px solid ${UXP.border}`,
      borderRadius: 10,
      padding: 16,
      height,
      ...style,
    }}>
      {children ? children : (
        <>
          {showTitle && (
            <Skeleton width={120} height={11} radius={3} style={{ marginBottom: 12 }} />
          )}
          {Array.from({ length: lines }).map((_, i) => (
            <Skeleton
              key={i}
              width={i === lines - 1 ? '60%' : '100%'}
              height={12}
              radius={3}
              style={{ marginBottom: i === lines - 1 ? 0 : 8 }}
            />
          ))}
        </>
      )}
    </div>
  )
}

// Table skeleton — column header strip + N row strips. Used by list
// surfaces (items, recipes, suppliers) so the table shape is locked in
// before data arrives.
export function SkeletonTable({
  rows = 6,
  columns = 5,
  showHeader = true,
}: {
  rows?:    number
  columns?: number
  showHeader?: boolean
}) {
  const colWidths = ['40%', '15%', '15%', '15%', '15%'].slice(0, columns)
  return (
    <div style={{
      background: UXP.cardBg,
      border: `0.5px solid ${UXP.border}`,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      {showHeader && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: colWidths.join(' '),
          gap: 12,
          padding: '12px 16px',
          background: UXP.subtleBg,
          borderBottom: `0.5px solid ${UXP.border}`,
        }}>
          {colWidths.map((_, i) => (
            <Skeleton key={i} width="60%" height={10} radius={2} />
          ))}
        </div>
      )}
      {Array.from({ length: rows }).map((_, ri) => (
        <div
          key={ri}
          style={{
            display: 'grid',
            gridTemplateColumns: colWidths.join(' '),
            gap: 12,
            padding: '14px 16px',
            borderBottom: ri === rows - 1 ? 'none' : `0.5px solid ${UXP.borderSoft}`,
          }}
        >
          {colWidths.map((_, ci) => (
            <Skeleton
              key={ci}
              width={ci === 0 ? '85%' : '50%'}
              height={12}
              radius={3}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// Page-frame skeleton — title + KPI strip + main card. The default
// "I don't know exactly what's on this page" loader for a route segment.
export function SkeletonPage({
  kpiCards = 3,
  bodyHeight = 320,
}: {
  kpiCards?:  number
  bodyHeight?: number
}) {
  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      <Skeleton width={200} height={20} radius={4} style={{ marginBottom: 4 }} />
      <Skeleton width={320} height={11} radius={3} style={{ marginBottom: 20 }} />
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${kpiCards}, 1fr)`,
        gap: 10,
        marginBottom: 14,
      }}>
        {Array.from({ length: kpiCards }).map((_, i) => (
          <SkeletonCard key={i} lines={1} showTitle style={{ height: 84, padding: 14 }}>
            <Skeleton width={70} height={9} radius={2} style={{ marginBottom: 10 }} />
            <Skeleton width={120} height={22} radius={4} />
          </SkeletonCard>
        ))}
      </div>
      <SkeletonCard height={bodyHeight} lines={6} />
    </div>
  )
}
