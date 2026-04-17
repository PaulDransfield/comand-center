// lib/admin/totp.ts
//
// RFC 6238 TOTP verification — zero dependencies, stdlib-only.
// Compatible with Google Authenticator, 1Password, Authy, Bitwarden, etc.
//
// Usage:
//   1. Generate a base32 secret once: node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"
//      then convert to base32 (see QR helper below).
//   2. Set ADMIN_TOTP_SECRET=<base32> in env.
//   3. Scan the otpauth://... URL into an authenticator app.
//   4. Every admin login must supply a valid 6-digit code from the app.

import { createHmac } from 'crypto'

// ---- Base32 (RFC 4648) decode ------------------------------------------------
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const val = ALPHABET.indexOf(ch)
    if (val < 0) throw new Error('Invalid base32 character: ' + ch)
    buffer = (buffer << 5) | val
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

// ---- TOTP --------------------------------------------------------------------
function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8)
  // Write 64-bit counter big-endian
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter & 0xffffffff, 4)

  const hmac = createHmac('sha1', secret).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
     (hmac[offset + 3] & 0xff)
  ) % (10 ** digits)
  return code.toString().padStart(digits, '0')
}

/** Generate the expected code for the current 30s window. Primarily for testing. */
export function totpNow(secret: string, period = 30, digits = 6): string {
  const buf = base32Decode(secret)
  return hotp(buf, Math.floor(Date.now() / 1000 / period), digits)
}

/**
 * Verify a user-supplied 6-digit code against the secret.
 * Accepts the current window plus one window before/after to tolerate clock skew.
 */
export function verifyTOTP(token: string, secret: string, period = 30, digits = 6): boolean {
  if (!/^\d{6}$/.test(token)) return false
  try {
    const buf = base32Decode(secret)
    const now = Math.floor(Date.now() / 1000 / period)
    for (const offset of [-1, 0, 1]) {
      if (hotp(buf, now + offset, digits) === token) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Build the otpauth:// URL for QR-code enrolment.
 * Paste the returned string into any QR generator (or the /admin/2fa-setup page).
 */
export function otpauthUrl(secret: string, label = 'CommandCenter', issuer = 'CommandCenter'): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits:    '6',
    period:    '30',
  })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`
}
