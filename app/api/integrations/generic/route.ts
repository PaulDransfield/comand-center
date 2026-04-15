// @ts-nocheck
// app/api/integrations/generic/route.ts
// Generic connect handler for Caspeco, Ancon, Swess

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { encrypt }                   from '@/lib/integrations/encryption'

export const dynamic = 'force-dynamic'

async function getAuth(req: NextRequest) {
  const raw = req.cookies.get('sb-llzmixkrysduztsvmfzi-auth-token')?.value
  if (!raw) return null
  try {
    let token = raw
    try { const d = decodeURIComponent(raw); const p = JSON.parse(d); token = Array.isArray(p) ? p[0] : (p.access_token ?? raw) } catch {}
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(token)
    if (!user) return null
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', user.id).single()
    return m ? { userId: user.id, orgId: m.org_id } : null
  } catch { return null }
}

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { provider, api_key, business_id } = await req.json()
  if (!provider || !api_key) return NextResponse.json({ error: 'provider and api_key required' }, { status: 400 })

  const ALLOWED = ['caspeco', 'ancon', 'swess', 'quinyx', 'planday', 'trivec', 'zettle']
  if (!ALLOWED.includes(provider)) return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })

  const db        = createAdminClient()
  const encrypted = encrypt(api_key)
  const bizId     = business_id || null

  // Check if exists
  const { data: existing } = await db.from('integrations')
    .select('id')
    .eq('org_id', auth.orgId)
    .eq('provider', provider)
    .maybeSingle()

  const payload = {
    org_id:          auth.orgId,
    provider,
    status:          'connected',
    credentials_enc: encrypted,
    updated_at:      new Date().toISOString(),
    ...(bizId ? { business_id: bizId } : {}),
  }

  if (existing) {
    await db.from('integrations').update(payload).eq('id', existing.id)
  } else {
    await db.from('integrations').insert({ ...payload, connected_at: new Date().toISOString() })
  }

  return NextResponse.json({ ok: true, message: `${provider} connected successfully` })
}
