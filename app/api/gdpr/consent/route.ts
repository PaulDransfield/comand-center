// @ts-nocheck
// app/api/gdpr/consent/route.ts
// POST — record consent when user accepts privacy policy

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

async function getAuth(req: NextRequest) {
  const raw = req.cookies.get('sb-llzmixkrysduztsvmfzi-auth-token')?.value
  if (!raw) return null
  try {
    let token = raw
    try { const d = decodeURIComponent(raw); const p = JSON.parse(d); token = Array.isArray(p) ? p[0] : (p.access_token ?? raw) } catch {}
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(token)
    return user ?? null
  } catch { return null }
}

export async function POST(req: NextRequest) {
  const user = await getAuth(req)
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { version = '1.0', consent_type = 'privacy_policy' } = await req.json().catch(() => ({}))
  const db = createAdminClient()

  await db.from('gdpr_consents').upsert({
    user_id:      user.id,
    consent_type,
    version,
    ip_address:   req.headers.get('x-forwarded-for') ?? null,
    user_agent:   req.headers.get('user-agent') ?? null,
    consented_at: new Date().toISOString(),
    withdrawn_at: null,
  }, { onConflict: 'user_id,consent_type' })

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const user = await getAuth(req)
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data } = await db
    .from('gdpr_consents')
    .select('consent_type, version, consented_at, withdrawn_at')
    .eq('user_id', user.id)

  return NextResponse.json({ consents: data ?? [] })
}
