// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
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

  const body = await req.json().catch(() => ({}))
  const { business_name, city, systems } = body

  const db = createAdminClient()
  await db.from('onboarding_progress').upsert({
    org_id:       auth.orgId,
    completed_at: new Date().toISOString(),
    step:         'completed',
  }, { onConflict: 'org_id' })

  // Fire confirmation email — non-blocking, don't fail if it errors
  try {
    const host = req.headers.get('host') ?? 'comandcenter.se'
    const proto = host.includes('localhost') ? 'http' : 'https'
    await fetch(`${proto}://${host}/api/onboarding/confirm-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: auth.orgId, business_name, city, systems }),
    })
  } catch (e) {
    console.error('Failed to send confirmation email:', e)
  }

  return NextResponse.json({ ok: true })
}
