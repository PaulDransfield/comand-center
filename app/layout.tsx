import type { Metadata } from 'next'
import './globals.css'
import CookieConsent from '@/components/CookieConsent'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'

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
    <html lang={locale}>
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
      <body style={{ margin: 0, padding: 0, background: '#f8f9fa', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
        <CookieConsent />
      </body>
    </html>
  )
}
