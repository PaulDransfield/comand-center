// @ts-nocheck
// app/api/integrations/generic/route.ts
//
// Generic connect handler for Caspeco, Ancon, Swess and similar
// API-key-with-optional-config integrations.
//
// 2026-06-09: hardened — surfaces Supabase errors instead of silently
// returning ok:true; takes optional `metadata` (e.g. caspeco companyid)
// to scope a single PAT across multiple businesses; restricts
// existing-row lookup to (org, provider, business_id) so each business
// gets its own row.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { requireBusinessAccess }    from '@/lib/auth/require-role'
import { encrypt }                   from '@/lib/integrations/encryption'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

const ALLOWED = ['caspeco', 'ancon', 'swess', 'quinyx', 'planday', 'trivec', 'zettle']

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const provider     = body.provider
  const api_key      = body.api_key
  const business_id  = body.business_id || null
  const metadata     = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}

  if (!provider || !api_key) {
    return NextResponse.json({ error: 'provider and api_key required' }, { status: 400 })
  }
  if (!ALLOWED.includes(provider)) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
  }

  if (business_id) {
    const forbidden = requireBusinessAccess(auth, business_id)
    if (forbidden) return forbidden
  }

  const db        = createAdminClient()
  const encrypted = encrypt(api_key)

  // Scope the existing-row lookup to the SAME business. Two businesses
  // in one org can each have their own Caspeco PAT pointing at a
  // different companyid (multi-tenant on the Caspeco side); the
  // previous code matched by (org, provider) only and overwrote the
  // first integration when a second business connected.
  let existingQ = db.from('integrations')
    .select('id, metadata')
    .eq('org_id', auth.orgId)
    .eq('provider', provider)
  if (business_id) existingQ = existingQ.eq('business_id', business_id)
  else             existingQ = existingQ.is('business_id', null)
  const { data: existing, error: lookupErr } = await existingQ.maybeSingle()
  if (lookupErr) {
    return NextResponse.json({
      error: `integrations lookup failed: ${lookupErr.message}`,
      code:  lookupErr.code ?? null,
    }, { status: 500 })
  }

  const mergedMetadata = existing?.metadata && typeof existing.metadata === 'object'
    ? { ...existing.metadata, ...metadata }
    : metadata

  const payload: any = {
    org_id:          auth.orgId,
    provider,
    status:          'connected',
    credentials_enc: encrypted,
    metadata:        mergedMetadata,
    updated_at:      new Date().toISOString(),
  }
  if (business_id) payload.business_id = business_id

  if (existing) {
    const { error: updErr } = await db.from('integrations').update(payload).eq('id', existing.id)
    if (updErr) {
      return NextResponse.json({
        error: `integrations update failed: ${updErr.message}`,
        code:  updErr.code ?? null,
      }, { status: 500 })
    }
  } else {
    const { error: insErr } = await db.from('integrations').insert({
      ...payload,
      connected_at: new Date().toISOString(),
    })
    if (insErr) {
      return NextResponse.json({
        error: `integrations insert failed: ${insErr.message}`,
        code:  insErr.code ?? null,
        hint:  insErr.hint  ?? null,
      }, { status: 500 })
    }
  }

  return NextResponse.json({
    ok:       true,
    provider,
    message:  `${provider} connected successfully`,
    metadata: mergedMetadata,
  })
}
