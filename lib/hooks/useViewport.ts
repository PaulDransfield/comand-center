// lib/hooks/useViewport.ts
//
// Tells the component which viewport tier it's in. Updates on resize +
// rotate. SSR-safe — the first paint reads the true viewport width on
// the client (via useLayoutEffect, which runs before paint) so there's
// no visible flash from the SSR default flipping to the measured tier.

'use client'

import { useEffect, useLayoutEffect, useState } from 'react'
import { BP, tierFor, type Tier } from '@/lib/constants/breakpoints'

// useLayoutEffect runs synchronously after render and BEFORE the browser
// paints — so a state update inside it is applied in the same frame
// the user sees, eliminating the SSR-default-then-measure flash that
// useEffect would produce. On the server `useLayoutEffect` is a no-op
// and would warn — fall back to useEffect there. The function-typeof
// check is the standard SSR-safe pattern.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * `useViewport()` returns the current tier ('mobile' | 'tablet' | 'desktop').
 *
 * Use for layout decisions that can't be expressed in CSS media queries
 * (e.g. swap a 2-pane layout to a single-pane navigation; render a
 * card-list instead of a table on mobile). For pure layout grids prefer
 * the `<CardGrid>` primitive — no JS needed.
 *
 * SSR default is **'mobile'** so phones get the correct layout from
 * first paint. Desktop users get the same mobile-stacked initial paint
 * for one frame, then `useLayoutEffect` measures `window.innerWidth`
 * and updates the tier before the browser paints again — no visible
 * flash. The previous 'desktop' default caused mobile users to see a
 * broken overflowing layout for ~50ms while React hydrated, which is
 * the bug this rewrite fixes.
 */
export function useViewport(): Tier {
  const [tier, setTier] = useState<Tier>('mobile')
  useIsomorphicLayoutEffect(() => {
    function update() { setTier(tierFor(window.innerWidth)) }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return tier
}

/** Convenience predicates. */
export function useIsMobile():  boolean { return useViewport() === 'mobile' }
export function useIsTablet():  boolean { return useViewport() === 'tablet' }
export function useIsDesktop(): boolean { return useViewport() === 'desktop' }

/**
 * `useContainerWidth(ref)` returns the live pixel width of an element.
 * Used by `<ResponsiveChart>` to size a chart against its container
 * (instead of `window.innerWidth - 120`). Updates on container resize
 * via ResizeObserver.
 */
export function useContainerWidth(ref: React.RefObject<HTMLElement>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current; if (!el) return
    setW(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setW(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

export { BP }
