// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

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
