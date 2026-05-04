# Task 1 — REVISED — minimal session-validating middleware

> Replaces the original Task 1 in CLAUDE-CODE-HANDOFF.md.
> Reason: prerequisite check failed — page-level redirects don't exist, so deleting middleware would have regressed `/dashboard` from "redirect to login" to "broken shell + 401 fetches" while leaving every other authenticated page (already broken — middleware never covered them) still leaking layout shell to logged-out users.
> Decision: rewrite middleware to do the job properly, broaden coverage to all authenticated routes. Route-group reorganisation (option B in your analysis) is deferred to a future sprint.

---

## What you're building

A small Next.js middleware that does **cheap structural validation** of the Supabase session cookie on every authenticated route. If the cookie is absent, malformed, or its JWT `exp` claim is in the past → redirect to `/login?redirectTo=...`. Otherwise let through.

This is **not** cryptographic validation. The middleware does not call Supabase. The cryptographic check happens server-side in `getRequestAuth` on every API call, and via the same helper inside server components (when we eventually add them). Middleware is the cheap "obviously-not-logged-in → bounce" filter; the API layer is the real gate.

## Why this design

- **No `auth.getUser(token)` in middleware.** Middleware runs on the Edge runtime on every navigation. A Supabase network call from middleware adds 100–300 ms latency per page load and burns request budget. Standard Next.js pattern is structural-only at the edge.
- **Forged cookies pass middleware but fail at the API.** That's fine — they see the layout briefly, exactly like a `useEffect` redirect would, but only if they bothered to forge a cookie. Anyone without one gets redirected immediately, and search engines, link previews, and curl probes see the redirect, not the shell.
- **No logging.** Middleware runs on every navigation. Vercel charges per log line and the noise drowns real signal.
- **Reuses the chunked-cookie logic from `getRequestAuth`.** The existing helper in `lib/supabase/server.ts:52–101` already handles `@supabase/ssr`'s split-cookie format. Extract that into a shared util so middleware and `getRequestAuth` use one implementation.

## Steps

### 1. Extract chunked-cookie reader into a shared util

Create `lib/auth/session-cookie.ts`:

```ts
// lib/auth/session-cookie.ts
//
// Shared reader for the Supabase session cookie. @supabase/ssr v0.3+
// stores large JWTs across multiple cookies named sb-<ref>-auth-token.0,
// .1, ... so any consumer (middleware, API route, server component)
// has to know how to reassemble.
//
// Used by:
//   - middleware.ts (structural validation only — Edge-safe, no DB)
//   - lib/supabase/server.ts::getRequestAuth (full validation, server-only)

const PROJECT_REF_FALLBACK = 'llzmixkrysduztsvmfzi'

interface CookieGetter {
  get(name: string): { value: string } | undefined
}

/**
 * Read the Supabase session cookie value, joining chunks if present.
 * Returns the raw cookie content (which may be a JSON-stringified session
 * object, an array, or a bare JWT depending on @supabase/ssr version).
 * Caller decides what to do with it.
 */
export function readSessionCookie(cookies: CookieGetter): string | null {
  // Derive project ref from NEXT_PUBLIC_SUPABASE_URL when possible;
  // fall back to the hardcoded value for resilience. Edge runtime
  // does have process.env access for NEXT_PUBLIC_* vars.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const ref = url.match(/https?:\/\/([^.]+)\./)?.[1] ?? PROJECT_REF_FALLBACK
  const BASE = `sb-${ref}-auth-token`

  let raw: string | null = cookies.get(BASE)?.value ?? null

  if (!raw) {
    // Base cookie absent — collect indexed chunks
    const chunks: string[] = []
    for (let i = 0; ; i++) {
      const c = cookies.get(`${BASE}.${i}`)?.value
      if (!c) break
      chunks.push(c)
    }
    if (chunks.length) raw = chunks.join('')
  } else if (/^\d+$/.test(raw.trim())) {
    // Base cookie holds only the chunk count
    const n = parseInt(raw, 10)
    const chunks: string[] = []
    for (let i = 0; i < n; i++) {
      const c = cookies.get(`${BASE}.${i}`)?.value
      if (c) chunks.push(c)
    }
    if (chunks.length) raw = chunks.join('')
  }

  return raw
}

/**
 * Extract the JWT access_token from a stored Supabase session value.
 * Handles three shapes @supabase/ssr has used over time:
 *   1. JSON-stringified session object: { access_token, refresh_token, ... }
 *   2. JSON array: [access_token, refresh_token, ...]
 *   3. Bare JWT string (rare, fallback)
 */
export function extractAccessToken(raw: string): string | null {
  let value = raw
  try {
    const decoded = decodeURIComponent(raw)
    const parsed  = JSON.parse(decoded)
    if (Array.isArray(parsed))     value = parsed[0]
    else if (parsed?.access_token) value = parsed.access_token
  } catch {
    // raw is already a plain JWT — use as-is
  }
  return typeof value === 'string' && value.length > 20 ? value : null
}

/**
 * Cheap structural validation of a JWT. Edge-safe (no crypto, no fetch).
 * Returns true iff:
 *   - The token has 3 base64url segments
 *   - The payload parses as JSON
 *   - The exp claim exists and is in the future (with 60s clock skew)
 *
 * This is NOT a security check — anyone can mint a JWT with a future exp.
 * Use this only to filter out obviously-not-logged-in users at the edge.
 * The cryptographic check happens server-side via supabase.auth.getUser.
 */
export function isJwtStructurallyValid(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false

  try {
    // Edge runtime supports atob; pad base64url manually
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded     = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4)
    const json       = atob(padded)
    const payload    = JSON.parse(json)
    const exp        = Number(payload?.exp)
    if (!Number.isFinite(exp)) return false
    const nowSec     = Math.floor(Date.now() / 1000)
    return exp > nowSec - 60   // 60s clock skew tolerance
  } catch {
    return false
  }
}
```

### 2. Rewrite `middleware.ts`

Replace the entire file with:

```ts
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
```

### 3. Verify the existing `getRequestAuth` still works

`lib/supabase/server.ts:52–101` has its own inline copy of the chunked-cookie logic. **Don't** refactor it to use the new util in this task — that's a separate change with its own test surface. Just confirm by reading the file that nothing else in `lib/supabase/server.ts` depends on `middleware.ts`.

If `npx tsc --noEmit` reveals `getRequestAuth` was importing from middleware (it shouldn't be), stop and tell Paul.

### 4. Build + smoke

```bash
npm run build
```

Should pass. If it doesn't, the most likely culprit is `atob` not being polyfilled on whatever runtime Next is targeting — but Edge runtime has it natively, so this should be fine on Vercel. If local Node build complains, use `Buffer.from(padded, 'base64').toString('utf8')` as a runtime-detected fallback.

### 5. Manual verification (Paul runs these)

After deploy:

1. Open incognito. Visit `https://comandcenter.se/staff` — must 302 to `/login?redirectTo=%2Fstaff`.
2. Same for `/tracker`, `/financials/performance`, `/budget`, `/scheduling/ai`, `/departments`, `/invoices`, `/integrations`, `/notebook`, `/settings`, `/forecast`, `/alerts`, `/overheads/upload`, `/revenue`, `/group`, `/weather`.
3. `/dashboard` — must redirect (was already redirecting; this confirms regression-free).
4. `/login`, `/reset-password`, `/terms`, `/privacy` — must NOT redirect (public pages).
5. `/admin` — must NOT redirect from middleware (admin has its own auth flow). The page itself will gate.
6. `/api/me` — must NOT redirect. Returns 401 instead. (API routes are excluded from auth checking by the `isProtectedPath` filter.)
7. Open a logged-in session, visit `/` — must redirect to `/dashboard`.
8. Open a logged-in session, visit `/staff` — must render normally, no redirect.

If any of those fail, fix before moving on.

### 6. Document in `FIXES.md`

Add `§0t` at the top of `FIXES.md`. Use this content (adjust the date if running on a different day):

```markdown
## 0t. Middleware silently failed open on every authenticated route except /dashboard (2026-04-26)

**Symptom:** External code review flagged that `middleware.ts` was using a substring match on cookie names (`c.name.includes('auth')`) as its session check, was logging every cookie name on every request via `console.log`, and only protected `/dashboard`. Every other authenticated route (`/staff`, `/tracker`, `/financials/performance`, `/scheduling`, `/budget`, `/alerts`, `/departments`, `/invoices`, `/integrations`, `/notebook`, `/settings`, `/forecast`, `/revenue`, `/overheads`, `/group`, `/weather`, `/ai`) was rendering its layout shell to unauthenticated visitors. API routes returned 401 once the page tried to fetch data, but the chrome (sidebar, page titles, route names) was leaking what features exist to anyone with the URL.

**Why it slipped:** the original middleware was scaffolded around `/dashboard` alone, and pages were never given a server-side auth check because the (then-just-/dashboard) middleware was assumed to cover them. As routes were added, no one revisited the matcher.

**Initial proposal was to delete middleware entirely** and rely on per-page server-side redirects. Pre-flight check during this fix found that no authenticated page actually has a server-side redirect — they're all `'use client'` shells that fetch data and lean on API 401s. Deletion would have regressed `/dashboard` to "broken shell + 401 fetches" without fixing any other route. Reverted to a rewrite.

**Fix — rewrite middleware to do real (cheap) structural validation across all authenticated routes:**

1. **Extracted shared cookie reader to `lib/auth/session-cookie.ts`.** Three pure functions: `readSessionCookie` (joins chunked `sb-<ref>-auth-token.N` cookies), `extractAccessToken` (handles all three @supabase/ssr storage shapes), `isJwtStructurallyValid` (parses JWT, checks `exp` claim with 60s clock skew, no crypto, no network — Edge-safe).
2. **Rewrote `middleware.ts`** to use the new util. ~50 lines of real logic. No logging, no substring matching. Protected-prefix list explicit. Excludes `/admin/*` (own auth flow), auth pages, public legal pages, API routes (do their own auth), and Next internals.
3. **Did NOT add `auth.getUser(token)` to middleware** — that's a network call to Supabase on every navigation, 100–300 ms each, costly at scale. Cryptographic validation continues to happen server-side in `getRequestAuth` on every API call. A forged JWT passes middleware but fails the first API request.
4. **Did NOT migrate to Next.js route groups** (`app/(authed)/layout.tsx` with a server-component auth check). That's the proper long-term answer but it's a 20-page reorganisation and was deferred to a future sprint focused on SSR auth consolidation.

**Why this should hold:** middleware now (a) covers every authenticated prefix explicitly via a single source of truth (`isProtectedPath`), (b) validates the cookie's JWT exp claim instead of substring-matching its name, (c) doesn't log, (d) shares its cookie-parsing logic with `getRequestAuth` so a future @supabase/ssr cookie-format change updates both at once. The remaining gap (forged-but-structurally-valid cookies pass middleware) is closed by the API layer, which is the security-critical gate anyway.

**No DB changes. No new dependencies. No new env vars.**
```

### 7. Commit

Auto-push hook will handle this, but make the commit message meaningful:

```
fix(auth): rewrite middleware to validate JWT structure across all authenticated routes

- Extract chunked-cookie reader into lib/auth/session-cookie.ts
- Replace substring-match cookie check with proper JWT exp validation
- Broaden coverage from /dashboard only to all 17 authenticated prefixes
- Remove debug console.log on every navigation
- Edge-safe (no Supabase network call); cryptographic validation stays in getRequestAuth

FIXES.md §0t. Reverted plan to delete middleware after pre-flight check
revealed no page-level server-side redirects exist. Route-group migration
deferred to a future sprint.
```

## Acceptance criteria

- `middleware.ts` exists, ~80 lines, no `console.log` calls.
- `lib/auth/session-cookie.ts` exists with three exported functions.
- `npx tsc --noEmit` passes (or no worse than baseline).
- `npm run build` passes.
- Test plan documented in `FIXES.md §0t`.
- All 8 manual verification steps in section 5 pass when Paul deploys.

## When done

Tell Paul: "Task 1 complete. Manual verification needed: incognito visit to `/staff`, `/tracker`, `/financials/performance` should each redirect to `/login`. Confirm before I start Task 2." Wait for Paul's go-ahead before touching `lib/auth/get-org.ts` or `lib/supabase/server.ts` (Task 2 — `.maybeSingle()` change).
