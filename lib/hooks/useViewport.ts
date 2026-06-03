// lib/hooks/useViewport.ts
//
// Tells the component which viewport tier it's in. Updates on resize +
// rotate. SSR-safe: returns 'desktop' before hydration (the most common
// case), then re-renders client-side once the window is measurable.

'use client'

import { useEffect, useState } from 'react'
import { BP, tierFor, type Tier } from '@/lib/constants/breakpoints'

/**
 * `useViewport()` returns the current tier ('mobile' | 'tablet' | 'desktop').
 *
 * Use for layout decisions that can't be expressed in CSS media queries
 * (e.g. swap a 2-pane layout to a single-pane navigation; render a
 * card-list instead of a table on mobile). For pure layout grids prefer
 * the `<CardGrid>` primitive — no JS needed.
 */
export function useViewport(): Tier {
  const [tier, setTier] = useState<Tier>('desktop')
  useEffect(() => {
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
