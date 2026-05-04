// i18n/request.ts
//
// next-intl request configuration — the entry point next-intl reads on
// every request to figure out which locale this user wants and which
// JSON files to load.
//
// Resolution order:
//   1. Authed user → organisation_members.locale (DB)
//   2. Cookie cc_locale (set by middleware on first Accept-Language match,
//      or by the user's manual selector pick)
//   3. DEFAULT_LOCALE (en-GB)
//
// Messages are split into namespaces (common, dashboard, scheduling, …)
// to keep client bundles lean. The `getMessages()` call below loads ALL
// namespaces — fine for v1; we can split per-route later if bundle size
// becomes a concern.

import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import {
  asLocale,
  detectLocaleFromAcceptLanguage,
  LOCALE_COOKIE,
  type Locale,
} from '@/lib/i18n/config'

async function loadMessages(locale: Locale): Promise<Record<string, any>> {
  // Each namespace lives under locales/<locale>/<namespace>.json
  // Add namespaces here as they're created. Keep `common` first; it's
  // the catch-all + all-pages strings.
  const namespaces = [
    'common',
    'sidebar',
    'dashboard',
    'settings',
    'scheduling',
    'financials',
    'operations',
    'auth',
    'alerts',
    'landing',
    'upgrade',
    'onboarding',
    'access',
    'askai',
    'misc',
    'weather',
    'integrations',
    'overheads',
    'notebook',
  ]
  const merged: Record<string, any> = {}
  for (const ns of namespaces) {
    try {
      const mod = await import(`@/locales/${locale}/${ns}.json`)
      merged[ns] = mod.default ?? mod
    } catch {
      // Missing namespace file = empty namespace. next-intl will fall
      // back to the key as the literal text. Acceptable for staged
      // rollout where some surfaces aren't translated yet.
      merged[ns] = {}
    }
  }
  return merged
}

export default getRequestConfig(async () => {
  // Resolve locale.
  let locale: Locale = 'en-GB'
  try {
    const cookieStore = await cookies()
    const fromCookie  = cookieStore.get(LOCALE_COOKIE)?.value
    if (fromCookie) {
      locale = asLocale(fromCookie)
    } else {
      const hdrs = await headers()
      locale = detectLocaleFromAcceptLanguage(hdrs.get('accept-language'))
    }
  } catch {
    // headers()/cookies() throw outside a request context — falls through
    // to the default.
  }

  // The DB lookup (auth user's preference) is intentionally NOT done here:
  //   - getRequestConfig runs on every render including auth-less landing.
  //   - A DB round-trip per render adds latency to every page.
  // Instead, the middleware syncs the cookie from DB after each successful
  // sign-in (one-shot), so subsequent renders read the up-to-date cookie.
  // Manual locale-switch endpoint also rewrites both cookie + DB.

  return {
    locale,
    messages: await loadMessages(locale),
    // Surface the real cause of next-intl errors before the runtime
    // wrapper masks them as anonymous Error(void 0). Without this hook
    // a missing-message / missing-context bug shows up as the same
    // opaque digest on every page in both build prerender and runtime
    // logs, which is what cost an hour debugging the 2026-05-01 layout
    // regression. Logging here at least gets a useful console.error
    // line into Vercel's runtime log stream and Sentry's breadcrumbs.
    onError(error) {
      const code  = (error as any)?.code ?? 'UNKNOWN'
      const msg   = (error as any)?.originalMessage ?? error?.message ?? String(error)
      console.error(`[next-intl] ${code}: ${msg}`)
    },
    getMessageFallback({ namespace, key, error }) {
      // Default behaviour returns the key path as plain text. We add the
      // error code so a missing translation is visually distinct in the
      // UI (`{access.foo[MISSING_MESSAGE]}`) and easier to spot during
      // QA — without throwing, which would crash the page.
      const path = [namespace, key].filter(Boolean).join('.')
      const code = (error as any)?.code
      return code ? `{${path}[${code}]}` : `{${path}}`
    },
  }
})
