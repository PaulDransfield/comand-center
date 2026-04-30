// lib/i18n/config.ts
//
// Single source of truth for the i18n configuration. Locale list, default,
// labels, and the helpers every other surface (middleware, server resolver,
// LanguageSelector component) reads from. Adding a fourth locale = one
// entry here + new files under `locales/<code>/`.

export const LOCALES = ['en-GB', 'sv', 'nb'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en-GB'

/** Cookie name the middleware + the locale-switch endpoint both read/write. */
export const LOCALE_COOKIE = 'cc_locale'

/** Display labels — what the user sees in the LanguageSelector dropdown. */
export const LOCALE_LABELS: Record<Locale, string> = {
  'en-GB': 'English',
  'sv':    'Svenska',
  'nb':    'Norsk',
}

/** Matching flag emoji for visual recognition. */
export const LOCALE_FLAGS: Record<Locale, string> = {
  'en-GB': '🇬🇧',
  'sv':    '🇸🇪',
  'nb':    '🇳🇴',
}

/**
 * Coerce any string to a supported locale, falling back to the default.
 * Used when reading cookies, DB rows, or Accept-Language matches that
 * could be anything.
 */
export function asLocale(input: string | null | undefined): Locale {
  if (!input) return DEFAULT_LOCALE
  const trimmed = String(input).trim()
  if ((LOCALES as readonly string[]).includes(trimmed)) return trimmed as Locale
  // Friendly aliases we might see from Accept-Language or legacy cookies.
  const aliasMap: Record<string, Locale> = {
    'en':    'en-GB',
    'en-US': 'en-GB',                // close enough for now; full en-US later
    'en-IE': 'en-GB',
    'sv-SE': 'sv',
    'no':    'nb',                   // generic Norwegian → Bokmål
    'nb-NO': 'nb',
    'nn':    'nb',                   // Nynorsk → Bokmål fallback (skip Nynorsk in v1)
    'nn-NO': 'nb',
  }
  return aliasMap[trimmed] ?? DEFAULT_LOCALE
}

/**
 * Pick the best supported locale from an Accept-Language header.
 * Used by the middleware on the user's first visit.
 */
export function detectLocaleFromAcceptLanguage(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE
  // Simple parse — Accept-Language is "en-GB,en;q=0.9,sv;q=0.7" etc.
  // We scan in order and return the first match.
  const candidates = header
    .split(',')
    .map(s => s.split(';')[0].trim())
    .filter(Boolean)
  for (const cand of candidates) {
    const matched = asLocale(cand)
    if (matched !== DEFAULT_LOCALE) return matched
    // Strict equality match on the default — let the next candidate
    // try if this one only resolved via fallback.
    if ((LOCALES as readonly string[]).includes(cand)) return cand as Locale
  }
  return DEFAULT_LOCALE
}
