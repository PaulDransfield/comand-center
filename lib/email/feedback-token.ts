// lib/email/feedback-token.ts
//
// Signs and verifies the tokens embedded in Monday-memo feedback email links.
// The email contains two links — up / down — each signed with HMAC over the
// briefing id + rating. Without a valid token the public endpoint refuses to
// record a vote, so only people who received the email can vote.
//
// Uses CRON_SECRET as the HMAC key so we don't need another env var; the
// cron-route already enforces its presence in prod.

import crypto from 'crypto'

function secret(): string {
  const s = process.env.CRON_SECRET
  if (!s) throw new Error('CRON_SECRET not set — cannot sign feedback tokens')
  return s
}

export function signFeedback(briefingId: string, rating: 'up' | 'down'): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${briefingId}|${rating}`)
    .digest('base64url')
    .slice(0, 24)
}

export function verifyFeedback(briefingId: string, rating: string, token: string): boolean {
  if (rating !== 'up' && rating !== 'down') return false
  if (!briefingId || !token) return false
  try {
    const expected = signFeedback(briefingId, rating as 'up' | 'down')
    const a = Buffer.from(expected)
    const b = Buffer.from(token)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}
