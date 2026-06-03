// lib/constants/breakpoints.ts
//
// 3-tier responsive breakpoints — single source of truth for the whole
// app. Every responsive primitive in components/ui/ references these.
// Pages should NEVER hardcode pixel widths in media queries; use the
// `<CardGrid columns={…}>` / `<PageContainer>` primitives instead.
//
// Tiers:
//   mobile   < 768   phones (portrait + landscape)
//   tablet  768-1023 tablets (incl. iPad portrait), small laptops in
//                   split-screen, foldables
//   desktop  ≥ 1024  full laptop / desktop
//
// The tablet tier is FIRST-CLASS — not "small desktop" or "big phone".
// Most pages should have a distinct 2-column tablet layout that sits
// between phone (1-col stack) and desktop (3-4 col).

export const BP = {
  mobile:  0,
  tablet:  768,
  desktop: 1024,
} as const

export type Tier = 'mobile' | 'tablet' | 'desktop'

/** Pixel width thresholds — use in `@media (min-width: …)` queries. */
export const MIN_PX = {
  tablet:  `${BP.tablet}px`,
  desktop: `${BP.desktop}px`,
} as const

/** Pixel width upper-bounds — use in `@media (max-width: …)` queries. */
export const MAX_PX = {
  mobile: `${BP.tablet - 1}px`,
  tablet: `${BP.desktop - 1}px`,
} as const

/** Resolve a viewport width to its tier. */
export function tierFor(widthPx: number): Tier {
  if (widthPx < BP.tablet)  return 'mobile'
  if (widthPx < BP.desktop) return 'tablet'
  return 'desktop'
}

/** Default page padding per tier (matches PageContainer). */
export const PAGE_PADDING = {
  mobile:  12,
  tablet:  20,
  desktop: 24,
} as const

/** Default max page width (desktop only; tablet+mobile go edge-to-edge). */
export const PAGE_MAX_WIDTH = 1280
