// @ts-nocheck
// app/api/admin/auth/route.ts
// Admin login — password + TOTP when ADMIN_TOTP_SECRET is configured.
//
// Flow:
//   POST { password }               → if TOTP is configured, returns { totp_required: true }
//   POST { password, totp: '123456'} → if valid password+code, returns { ok: true }
//
// TOTP is optional. If ADMIN_TOTP_SECRET isn't set, we fall back to password-only
// (so existing deployments keep working until 2FA is enrolled).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { verifyTOTP }                from '@/lib/admin/totp'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { password, totp } = await req.json()
    const adminPassword = process.env.ADMIN_SECRET
    const totpSecret    = process.env.ADMIN_TOTP_SECRET

    if (!adminPassword) {
      return NextResponse.json({ ok: false, error: 'Server misconfiguration' }, { status: 500 })
    }
    if (password !== adminPassword) {
      return NextResponse.json({ ok: false, error: 'Wrong password' }, { status: 401 })
    }

    // 2FA enforced if secret is set
    if (totpSecret) {
      if (!totp) {
        return NextResponse.json({ ok: false, totp_required: true }, { status: 401 })
      }
      if (!verifyTOTP(String(totp), totpSecret)) {
        return NextResponse.json({ ok: false, error: 'Invalid 2FA code', totp_required: true }, { status: 401 })
      }
    }

    // Successful login — audit it.
    try {
      await recordAdminAction(createAdminClient(), {
        action:     ADMIN_ACTIONS.LOGIN,
        targetType: 'system',
        payload:    { totp_used: !!totpSecret },
        req,
      })
    } catch { /* non-fatal */ }

    return NextResponse.json({ ok: true, totp_used: !!totpSecret })
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 })
  }
}
