// lib/ai/locale.ts
//
// Locale resolution for AI surfaces — every Claude-calling route that
// produces user-facing text reads the locale here and threads the prompt
// fragment into its system prompt so the response lands in the user's
// chosen language.
//
// Resolution order (fast → slow):
//   1. cookie cc_locale — set by /api/auth/locale + next-intl middleware,
//      readable from `req.cookies` in any route handler. Covers anonymous
//      visitors + signed-in users on a refresh-cached cookie.
//   2. organisation_members.locale (DB) — only consulted when the cookie
//      is missing for an authenticated user. The /api/auth/locale endpoint
//      writes both, so this is a defence-in-depth fallback.
//   3. DEFAULT_LOCALE — en-GB.
//
// Why a prompt fragment, not a flag passed into the SDK call:
//   Anthropic's API takes a single system prompt; localising the *content*
//   of that prompt is how we steer Claude's output language. We append a
//   short, deterministic line that tells the model both the target locale
//   and the conventions to follow (decimal separator, currency symbol).

import type { NextRequest } from 'next/server'
import { LOCALE_COOKIE, asLocale, type Locale, DEFAULT_LOCALE } from '@/lib/i18n/config'

/**
 * Read the locale from a NextRequest. Cookie-only path — synchronous, no
 * DB round-trip. Use `resolveLocaleForOrg()` below when the cookie may not
 * be set (cron jobs, scheduled agents).
 */
export function getLocaleFromRequest(req: NextRequest): Locale {
  const raw = req.cookies.get(LOCALE_COOKIE)?.value
  return asLocale(raw)
}

/**
 * Async resolver that consults the DB if the cookie is missing. Use from
 * cron jobs or any context without a request — pass the org_id so we look
 * up the OWNER row's locale (managers may have different prefs but the
 * org-level digest etc. should follow the owner).
 *
 * Caller passes a Supabase client (admin or anon) so this module stays
 * import-free of supabase wiring.
 */
export async function resolveLocaleForOrg(
  db: any,
  orgId: string,
): Promise<Locale> {
  try {
    const { data } = await db
      .from('organisation_members')
      .select('locale')
      .eq('org_id', orgId)
      .eq('role', 'owner')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    return asLocale(data?.locale)
  } catch {
    return DEFAULT_LOCALE
  }
}

/**
 * The prompt fragment Claude reads. Appended to every user-facing AI
 * surface's system prompt. Kept terse so it doesn't bloat the prompt.
 *
 * Conventions per locale:
 *   - en-GB: English, comma decimal grouping (1,234.56), £ for GBP
 *     but kr/SEK stays as `kr` since this is a Swedish-restaurant SaaS.
 *   - sv:    Swedish, space grouping (1 234,56 kr).
 *   - nb:    Norwegian Bokmål, space grouping (1 234,56 kr).
 *
 * Numbers and dates the prompt INJECTS as values (e.g. fmtKr already
 * returns "1 234 kr") should not be re-formatted by Claude — we tell it
 * "echo numeric values verbatim" so the locale-aware formatting we did
 * upstream survives. Without that instruction Claude has been observed
 * "translating" formatted numbers back to its training-default style.
 */
export function localePromptFragment(locale: Locale): string {
  switch (locale) {
    case 'sv':
      return [
        '',
        'IMPORTANT — RESPOND IN SWEDISH (svenska).',
        'Use Swedish business idiom for restaurants. Decimal separator: comma. Thousands grouping: space (e.g. 12 345,60).',
        'Currency stays as "kr" or "SEK" (do NOT translate to "krona"/"kronor" in metric contexts).',
        'Echo numeric values exactly as provided in the prompt — do not re-format them.',
      ].join('\n')
    case 'nb':
      return [
        '',
        'IMPORTANT — RESPOND IN NORWEGIAN BOKMÅL (norsk bokmål).',
        'Use Norwegian business idiom for restaurants. Decimal separator: comma. Thousands grouping: space (e.g. 12 345,60).',
        'Currency stays as "kr" or "NOK" (do NOT translate to "krone"/"kroner" in metric contexts).',
        'Echo numeric values exactly as provided in the prompt — do not re-format them.',
      ].join('\n')
    case 'en-GB':
    default:
      return [
        '',
        'Respond in British English (en-GB).',
        'Decimal separator: full stop. Thousands grouping: comma OR space (match what the user data uses).',
        'Currency stays as the symbol/code provided in the data (kr / SEK / £).',
        'Echo numeric values exactly as provided in the prompt — do not re-format them.',
      ].join('\n')
  }
}

/**
 * Convenience: read locale from request + return both the locale and
 * its prompt fragment in one call. Most AI routes just need this.
 */
export function aiLocaleFromRequest(req: NextRequest): {
  locale: Locale
  promptFragment: string
} {
  const locale = getLocaleFromRequest(req)
  return { locale, promptFragment: localePromptFragment(locale) }
}
