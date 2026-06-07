import type { Metadata } from 'next'
import './globals.css'
import CookieConsent from '@/components/CookieConsent'
import FragmentAuthRedirector from '@/components/FragmentAuthRedirector'
import VersionWatcher from '@/components/VersionWatcher'
import { SplashRemover } from '@/components/SplashRemover'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { Spline_Sans, Fraunces } from 'next/font/google'

// ── Cold-load brand splash ──────────────────────────────────────────────
// Rendered as inline HTML + CSS in the body BEFORE any React component
// so it's visible the moment the HTML lands — before the JS bundle
// downloads, before React hydrates. <SplashRemover> mounts inside the
// React tree and removes #cc-splash once the app is alive.
//
// Lives on first cold load, NOT on in-app navigation (which uses
// loading.tsx skeletons — see app/<segment>/loading.tsx). After React
// hydrates the splash is gone; subsequent route changes get the
// skeleton flow.
const SPLASH_CSS = `
#cc-splash {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #f1eff9;
  z-index: 99999;
  opacity: 1;
  transition: opacity 320ms ease;
  font-family: var(--font-display), 'Fraunces', 'Times New Roman', serif;
}
#cc-splash.cc-splash-done {
  opacity: 0;
  pointer-events: none;
}
#cc-splash .cc-splash-wordmark {
  font-size: 26px;
  font-weight: 500;
  color: #3a3550;
  letter-spacing: -0.01em;
  margin-bottom: 24px;
}
#cc-splash .cc-splash-bar {
  width: 200px;
  height: 2px;
  background: rgba(58,53,80,0.10);
  border-radius: 1px;
  overflow: hidden;
  position: relative;
}
#cc-splash .cc-splash-bar::after {
  content: '';
  position: absolute;
  top: 0;
  left: -40%;
  width: 40%;
  height: 100%;
  background: #7d6cc9;
  border-radius: 1px;
  animation: cc-splash-sweep 1100ms ease-in-out infinite;
}
@keyframes cc-splash-sweep {
  0%   { left: -40%; }
  100% { left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  #cc-splash .cc-splash-bar::after { animation: none; left: 0; width: 100%; }
}
`

// next/font/google bundles + self-hosts the fonts at build time and
// exposes them as CSS variables. Phase 1 of the UI overhaul — the
// redesigned app surfaces render in Spline Sans / Fraunces; the public
// landing page in app/page.tsx keeps its own DM Sans + Fraunces stack
// because its <style> block sets body{ font-family } after globals.css.
const fontSans = Spline_Sans({
  subsets:  ['latin', 'latin-ext'],
  weight:   ['300', '400', '500', '600', '700'],
  display:  'swap',
  variable: '--font-sans',
})
const fontDisplay = Fraunces({
  subsets:  ['latin', 'latin-ext'],
  weight:   ['300', '400', '500', '600'],
  display:  'swap',
  variable: '--font-display',
})

// next-intl resolves the locale from cookies/headers in i18n/request.ts,
// which makes the root layout inherently request-scoped. Static prerender
// has no request context, so the resolution throws — forcing dynamic
// rendering at the root makes every route opt out of prerender. Required
// pattern for cookie-based i18n without locale-prefixed routes.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: {
    default:  'CommandCenter',
    template: '%s - CommandCenter',
  },
  description: 'AI-powered business intelligence for Swedish restaurants',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // M044: read locale + messages on the server so the first paint is in
  // the user's chosen language. next-intl's request config (i18n/request.ts)
  // resolves locale from cookie / Accept-Language; the cookie is the
  // source of truth post-first-visit.
  //
  // Defensive fallback — getLocale()/getMessages() throw if the request
  // context isn't available (e.g. during ISR revalidation, or if the
  // next-intl plugin chain breaks for any reason). Falling back to en-GB
  // with empty messages keeps the page rendering instead of crashing into
  // global-error.tsx.
  let locale = 'en-GB'
  let messages: any = {}
  try {
    locale   = await getLocale()
    messages = await getMessages()
  } catch (err: any) {
    console.error('[layout] next-intl resolution failed:', err?.message ?? err, err?.stack)
  }

  return (
    <html lang={locale} className={`${fontSans.variable} ${fontDisplay.variable}`}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {/*
          Open the TLS handshake to Supabase during HTML parse so the first
          API call's network time drops by ~100–200 ms. dns-prefetch is the
          fallback for browsers that don't honour preconnect. URL is
          hardcoded to match lib/supabase/server.ts:56 and
          app/api/onboarding/setup-request/route.ts:78 — when the broader
          "derive project ref from NEXT_PUBLIC_SUPABASE_URL" cleanup happens
          (REVIEW.md §2.8), update all three places. FIXES §0aa.
        */}
        <link rel="preconnect" href="https://llzmixkrysduztsvmfzi.supabase.co" />
        <link rel="dns-prefetch" href="https://llzmixkrysduztsvmfzi.supabase.co" />
      </head>
      {/* Body font-family deliberately set via globals.css (not inline
          style), so the public landing page in app/page.tsx can override
          it via its own <style> block — inline style on <body> would beat
          any later CSS rule and lock the landing page to Spline Sans. */}
      <body style={{ margin: 0, padding: 0, background: '#f8f9fa' }}>
        {/* Cold-load splash — inline so it paints with first HTML and
            doesn't wait for the JS bundle. SplashRemover removes it
            once React hydrates. See SPLASH_CSS above. */}
        <style dangerouslySetInnerHTML={{ __html: SPLASH_CSS }} />
        <div id="cc-splash" aria-hidden="true">
          <div className="cc-splash-wordmark">CommandCenter</div>
          <div className="cc-splash-bar" />
        </div>
        {/*
          CookieConsent uses useTranslations() and MUST live inside the
          provider — when it was a sibling, the SSR render had no next-intl
          context and threw on every page (including /, /login, /privacy).
          The wrapper masked the error as `Error(void 0)` so the build's
          prerender pass died silently with "Error occurred prerendering"
          on every route. See the 2026-05-01 incident.
        */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SplashRemover />
          {/*
            Catches Supabase implicit-flow auth redirects (#access_token=...)
            that landed at the wrong path because the Site URL isn't the
            handler. Forwards to /auth/handle preserving the fragment.
            Cheap belt-and-braces — runs on every page, no-ops when there's
            no fragment.
          */}
          <FragmentAuthRedirector />
          {children}
          <CookieConsent />
          {/*
            VersionWatcher polls /api/version and compares against the
            SHA baked into this bundle (NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA).
            When a deploy lands while a tab is open, shows a "Reload"
            pill so users don't have to know to hard-refresh to pick up
            the new UI. Mounted here so every page benefits.
          */}
          <VersionWatcher />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
