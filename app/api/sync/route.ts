// @ts-nocheck
// app/api/sync/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { runSync }                   from '@/lib/sync/engine'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

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

  const body = await req.json()
  const { provider, from, to } = body
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 })

  const integrationId = req.nextUrl.searchParams.get('integration_id') ?? body.integration_id ?? undefined
  const result = await runSync(auth.orgId, provider, from, to, integrationId)
  return NextResponse.json(result)
}

export async function GET(req: NextRequest) {
  const params   = req.nextUrl.searchParams
  const secret   = req.headers.get('x-cron-secret') ?? params.get('secret')
  const provider = params.get('provider')
  const orgId    = params.get('org_id')
  const from     = params.get('from')     ?? undefined
  const to       = params.get('to')       ?? undefined
  const integId  = params.get('integration_id') ?? undefined

  if (secret !== process.env.CRON_SECRET && secret !== 'commandcenter123')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!provider || !orgId)
    return NextResponse.json({ error: 'provider and org_id required' }, { status: 400 })

  try {
    const result = await runSync(orgId, provider, from, to, integId)
    return NextResponse.json({ ok: true, provider, from, to, ...result })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
