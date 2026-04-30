// lib/email/i18n.ts
//
// Email-template i18n helper. Cron handlers can't use next-intl's request
// context (no request, no NextIntlClientProvider) so we load the locale
// JSON files directly and provide a small `t()` API matching the rest of
// the codebase.
//
// Usage:
//   const t = await getEmailMessages('sv')
//   const subject = t('weeklyDigest.subject', { weekLabel: 'Vecka 17 — …' })
//   const greeting = t('weeklyDigest.greeting')
//
// Number/date formatters are NOT included here — caller should format
// upstream and inject as already-formatted strings (matches the AI
// `localePromptFragment` rule of "echo numbers verbatim").

import { asLocale, type Locale, DEFAULT_LOCALE } from '@/lib/i18n/config'

type Messages = Record<string, any>

/** ICU-ish placeholder substitution: {key} → values[key]. Plurals not
 *  needed here yet — none of the email templates use them. Keep simple. */
function interpolate(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, key) => {
    const v = values[key]
    return v === undefined || v === null ? `{${key}}` : String(v)
  })
}

function readPath(messages: Messages, path: string): string | undefined {
  const parts = path.split('.')
  let cur: any = messages
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return typeof cur === 'string' ? cur : undefined
}

/**
 * Load the email namespace for a given locale. Falls back to en-GB if a
 * key is missing in the requested locale (defensive — protects against
 * an in-progress translation file).
 */
export async function getEmailMessages(rawLocale: string | null | undefined): Promise<(key: string, values?: Record<string, string | number>) => string> {
  const locale: Locale = asLocale(rawLocale)
  let primary: Messages = {}
  let fallback: Messages = {}
  try {
    primary = (await import(`@/locales/${locale}/email.json`)).default
  } catch {
    primary = {}
  }
  if (locale !== DEFAULT_LOCALE) {
    try {
      fallback = (await import(`@/locales/${DEFAULT_LOCALE}/email.json`)).default
    } catch {
      fallback = {}
    }
  }

  return (key: string, values?: Record<string, string | number>) => {
    const found = readPath(primary, key) ?? readPath(fallback, key)
    if (found === undefined) return key   // surface missing keys instead of silently dropping
    return interpolate(found, values)
  }
}
