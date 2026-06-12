// app/api/auth/resend-verification/route.ts
//
// POST { email } — resend the signup confirmation email for the "check your
// inbox" screen when the first one didn't arrive. Public + rate-limited.
// Never reveals whether an account exists / is already confirmed: always
// returns { ok: true } and only actually sends for a known, unconfirmed user.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { rateLimit } from '@/lib/middleware/rate-limit'
import { sendVerifyEmail } from '@/lib/email/sendVerifyEmail'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  noStore()
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  let body: any
  try { body = await req.json() } catch { body = {} }
  const email = String(body?.email ?? '').trim().toLowerCase()
  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
  }

  // Rate-limit per email + per IP — resend-abuse + enumeration guard. On
  // throttle return the same generic shape so timing/responses don't leak.
  const perEmail = rateLimit(`resend-verify:${email}`, { windowMs: 15 * 60_000, max: 3 })
  const perIp    = rateLimit(`resend-verify-ip:${ip}`,  { windowMs: 15 * 60_000, max: 10 })
  if (!perEmail.allowed || !perIp.allowed) {
    return NextResponse.json({ ok: true })
  }

  const supabase = createAdminClient()

  // Only send for an account that actually exists in our users mirror (written
  // at signup). This avoids generateLink('signup') creating a ghost user for an
  // unknown email. If the account is already confirmed, generateLink errors and
  // sendVerifyEmail soft-fails — no email goes out, and we still return ok.
  try {
    const { data: u } = await supabase
      .from('users')
      .select('full_name, email')
      .eq('email', email)
      .maybeSingle()
    if (u) {
      const acceptLang = req.headers.get('accept-language')?.split(',')[0]?.split(';')[0]?.trim() ?? null
      const proto = req.headers.get('x-forwarded-proto') ?? 'https'
      const host  = req.headers.get('host') ?? 'comandcenter.se'
      const result = await sendVerifyEmail({
        supabaseAdmin: supabase,
        email,
        fullName: (u as any).full_name ?? null,
        locale: acceptLang,
        appOrigin: `${proto}://${host}`,
      })
      if (!result.ok) console.warn('[resend-verification] send failed:', result.error)
    }
  } catch (e: any) {
    console.warn('[resend-verification] lookup/send threw:', e?.message ?? e)
  }

  return NextResponse.json({ ok: true })
}
