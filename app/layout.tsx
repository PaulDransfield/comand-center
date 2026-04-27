import type { Metadata } from 'next'
import './globals.css'
import CookieConsent from '@/components/CookieConsent'

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
        {children}
        <CookieConsent />
      </body>
    </html>
  )
}
