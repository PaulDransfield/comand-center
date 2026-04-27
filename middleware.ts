// middleware.ts
//
// Edge-runtime auth gate for authenticated routes.
//
// What this does:
//   - Reads the Supabase session cookie (handles @supabase/ssr chunked storage)
//   - Validates JWT structure + exp claim (no crypto, no network)
//   - Redirects to /login when invalid or missing
//
// What this does NOT do:
//   - Cryptographic validation (handled by getRequestAuth on every API call)
//   - Org-membership check (handled by getRequestAuth)
//   - Authorisation / role checks (handled per-route)
//
// A forged cookie with a future exp passes middleware but fails the moment
// any API route tries to use it. Acceptable trade-off: middleware stays
// fast (~1 ms) and Edge-safe. The real gate is the API.
//
// Logging is deliberately absent — middleware runs on every navigation
// and Vercel charges per log line. Use Sentry from API routes instead.

import { NextResponse, type NextRequest } from 'next/server'
import {
  readSessionCookie,
  extractAccessToken,
  isJwtStructurallyValid,
} from '@/lib/auth/session-cookie'

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  // Read + structurally validate the session cookie
  const raw   = readSessionCookie(request.cookies)
  const token = raw ? extractAccessToken(raw) : null
  const valid = token ? isJwtStructurallyValid(token) : false

  // Logged-in users hitting the landing page → dashboard
  if (pathname === '/' && valid) {
    const dashUrl = request.nextUrl.clone()
    dashUrl.pathname = '/dashboard'
    return NextResponse.redirect(dashUrl)
  }

  // Logged-out users hitting an authenticated route → login
  if (!valid && isProtectedPath(pathname)) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('redirectTo', pathname + search)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

// Authenticated routes that need a session.
// Excludes:
//   /admin/*       — gated separately by ADMIN_SECRET
//   /login, /reset-password, /onboarding/* — auth flows themselves
//   /terms, /privacy, /security  — public legal pages
//   /api/*         — API routes do their own auth via getRequestAuth
//   /_next, static — handled by the matcher below
function isProtectedPath(pathname: string): boolean {
  const protectedPrefixes = [
    '/dashboard',
    '/staff',
    '/tracker',
    '/forecast',
    '/budget',
    '/alerts',
    '/financials',
    '/scheduling',
    '/departments',
    '/invoices',
    '/integrations',
    '/notebook',
    '/settings',
    '/group',
    '/overheads',
    '/revenue',
    '/weather',
    '/ai',
  ]
  return protectedPrefixes.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export const config = {
  matcher: [
    // Match everything except Next internals and static assets.
    // The route filter inside middleware decides what to actually gate.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)',
  ],
}
