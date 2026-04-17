// @ts-nocheck
// app/api/admin/2fa-setup/route.ts
//
// Helper for first-time 2FA enrolment. Generates a random base32 secret and
// the otpauth:// URL to scan. Does NOT persist anything — the admin copies the
// secret into ADMIN_TOTP_SECRET env var, redeploys, then scans the QR.

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes }               from 'crypto'
import { otpauthUrl, totpNow }       from '@/lib/admin/totp'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

// Base32 encode (RFC 4648) — keep this inline so lib/admin/totp.ts stays decode-only.
function base32Encode(buf: Buffer): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0, output = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const label  = searchParams.get('label')  || 'admin@comandcenter.se'
  const issuer = searchParams.get('issuer') || 'CommandCenter'

  // If a secret is already configured, return its otpauth URL so admin can re-scan.
  const existing = process.env.ADMIN_TOTP_SECRET
  if (existing) {
    return NextResponse.json({
      secret:      existing,
      otpauth_url: otpauthUrl(existing, label, issuer),
      configured:  true,
      current_code: totpNow(existing),
      note:        'This secret is already in ADMIN_TOTP_SECRET. Use ?reset=1 to generate a fresh one (you will have to redeploy).',
    })
  }

  const raw = randomBytes(20)  // 160-bit, RFC 6238 recommended length
  const secret = base32Encode(raw)
  return NextResponse.json({
    secret,
    otpauth_url:  otpauthUrl(secret, label, issuer),
    configured:   false,
    current_code: totpNow(secret),
    instructions: [
      '1. Copy the secret into your Vercel env var: ADMIN_TOTP_SECRET',
      '2. Redeploy so the server picks it up',
      '3. Scan the otpauth_url with Google Authenticator / 1Password / Authy',
      '4. Verify the authenticator shows the same current_code as above',
      '5. Next admin login will require the 6-digit TOTP',
    ],
  })
}
