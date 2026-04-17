// lib/admin/oauth-link.ts
//
// Generates short-lived signed URLs that admins can hand to customers to start
// an OAuth flow on a specific org + business. Signed with ADMIN_SECRET via
// HMAC-SHA256; verified inside /api/integrations/<provider>?action=connect.
//
// Flow:
//   1. Admin clicks "Generate connect link" in /admin/customers/<orgId>
//   2. Backend calls signOauthConnectToken({ orgId, businessId, provider, ttlSeconds: 1800 })
//   3. Admin sends the URL to the customer
//   4. Customer clicks the URL → hits the provider connect route
//   5. Route calls verifyOauthConnectToken(); if valid, kicks off OAuth with those IDs
//
// Critical: the customer never authenticates as the admin. They authenticate
// directly with the third-party provider (Fortnox / Visma / Björn Lundén).

import { createHmac, timingSafeEqual } from 'crypto'

export interface OauthConnectPayload {
  orgId:      string
  businessId: string | null
  provider:   string   // 'fortnox' | 'visma' | 'bjorn_lunden' | etc.
  exp:        number   // unix seconds
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : ''
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function getSecret(): Buffer {
  const s = process.env.ADMIN_SECRET
  if (!s) throw new Error('ADMIN_SECRET not set — cannot sign OAuth connect tokens')
  return Buffer.from(s, 'utf8')
}

export function signOauthConnectToken(p: Omit<OauthConnectPayload, 'exp'> & { ttlSeconds?: number }): string {
  const payload: OauthConnectPayload = {
    orgId:      p.orgId,
    businessId: p.businessId,
    provider:   p.provider,
    exp:        Math.floor(Date.now() / 1000) + (p.ttlSeconds ?? 1800),
  }
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig  = base64url(createHmac('sha256', getSecret()).update(body).digest())
  return `${body}.${sig}`
}

export function verifyOauthConnectToken(token: string): OauthConnectPayload | null {
  try {
    const [body, sig] = token.split('.')
    if (!body || !sig) return null
    const expected = createHmac('sha256', getSecret()).update(body).digest()
    const given    = fromBase64url(sig)
    if (expected.length !== given.length) return null
    if (!timingSafeEqual(expected, given)) return null

    const payload: OauthConnectPayload = JSON.parse(fromBase64url(body).toString('utf8'))
    if (Math.floor(Date.now() / 1000) > payload.exp) return null
    return payload
  } catch {
    return null
  }
}
