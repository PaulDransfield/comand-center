'use client'
// components/SplashRemover.tsx
//
// Fires once on first React mount. Adds the `cc-splash-done` class to
// the inline #cc-splash element baked into the root layout's body,
// which triggers the CSS fade-out + removes the splash from the
// document.
//
// The splash itself is plain inline HTML in app/layout.tsx so it
// renders the instant the HTML lands (before the JS bundle downloads,
// before React hydrates). This component is the only thing that knows
// React is alive and the page is ready to take over.

import { useEffect } from 'react'

export function SplashRemover() {
  useEffect(() => {
    // requestAnimationFrame x2 gives the actual page content one paint
    // cycle to land before we start fading the splash. Without this the
    // fade can race the first content paint and you see a flicker.
    let cleanup = false
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cleanup) return
        const el = document.getElementById('cc-splash')
        if (!el) return
        el.classList.add('cc-splash-done')
        // Remove from DOM entirely after the CSS transition completes
        // (350ms in the inline stylesheet). Don't trust transitionend —
        // it doesn't always fire on display-none ancestors.
        window.setTimeout(() => { el.remove() }, 400)
      })
    })
    return () => { cleanup = true }
  }, [])
  return null
}
