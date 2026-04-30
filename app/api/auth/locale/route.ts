// app/api/auth/locale/route.ts
//
// User flips their language. POST { locale: 'en-GB' | 'sv' | 'nb' }.
//
// Writes:
//   - Cookie cc_locale (so anonymous + this-tab next-intl reads it on the
//     very next render — no full page refresh required)
//   - organisation_members.locale (when authenticated, so the choice
//     survives across devices and sessions)
//
// Auth-optional: anonymous landing-page visitors can also flip languages
// without signing in. Their pick is cookie-only until they sign up.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { LOCALE_COOKIE, asLocale, LOCALES } from '@/lib/i18n/config'

export const dynamic = 'force-dynamic'

const ONE_YEAR_SEC = 365 * 24 * 60 * 60

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch {}

  const requested = String(body?.locale ?? '').trim()
  if (!(LOCALES as readonly string[]).includes(requested)) {
    return NextResponse.json({
      error: `locale must be one of: ${LOCALES.join(', ')}`,
    }, { status: 400 })
  }
  const locale = asLocale(requested)

  // If signed in, persist on the membership row so the choice survives
  // across devices. Best-effort — anonymous users still get the cookie.
  const auth = await getRequestAuth(req).catch(() => null)
  if (auth) {
    try {
      const db = createAdminClient()
      await db
        .from('organisation_members')
        .update({ locale })
        .eq('org_id', auth.orgId)
        .eq('user_id', auth.userId)
    } catch (e: any) {
      console.warn('[auth/locale] DB write failed:', e?.message)
    }
  }

  const res = NextResponse.json({ ok: true, locale })
  res.cookies.set(LOCALE_COOKIE, locale, {
    path:     '/',
    maxAge:   ONE_YEAR_SEC,
    sameSite: 'lax',
    httpOnly: false,                    // readable by client for instant render
    secure:   process.env.NODE_ENV === 'production',
  })
  return res
}
