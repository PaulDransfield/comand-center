// @ts-nocheck
// app/api/admin/oauth-link/route.ts
//
// POST { provider, org_id, business_id? } → { url, expires_at }
// Admin-only. Returns a short-lived signed URL the customer can click to
// authorise a specific OAuth provider (Fortnox, Visma, Björn Lundén) for
// a specific org+business. Logged to admin_audit_log.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { signOauthConnectToken }     from '@/lib/admin/oauth-link'
import { recordAdminAction }         from '@/lib/admin/audit'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

const OAUTH_PROVIDERS = ['fortnox', 'visma', 'bjorn_lunden', 'zettle'] as const

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { provider, org_id, business_id, ttl_seconds } = await req.json().catch(() => ({}))
  if (!provider || !org_id) {
    return NextResponse.json({ error: 'provider and org_id required' }, { status: 400 })
  }
  if (!OAUTH_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `Provider ${provider} is not an OAuth provider` }, { status: 400 })
  }

  const ttl   = Math.min(Math.max(parseInt(ttl_seconds ?? 1800) || 1800, 300), 86400)
  const token = signOauthConnectToken({
    orgId:      org_id,
    businessId: business_id ?? null,
    provider,
    ttlSeconds: ttl,
  })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
  const url    = `${appUrl}/api/integrations/${provider}?action=connect&token=${encodeURIComponent(token)}`

  await recordAdminAction(createAdminClient(), {
    action:     'oauth_link_generated',
    orgId:      org_id,
    targetType: 'integration',
    payload:    { provider, business_id: business_id ?? null, ttl_seconds: ttl },
    req,
  })

  return NextResponse.json({
    ok:         true,
    url,
    provider,
    org_id,
    business_id: business_id ?? null,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    expires_in_minutes: Math.round(ttl / 60),
  })
}
