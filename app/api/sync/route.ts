// @ts-nocheck
// app/api/sync/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { runSync }                   from '@/lib/sync/engine'
import { checkCronSecret }           from '@/lib/admin/check-secret'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const getAuth = getRequestAuth

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
  // FIXES §0ee (Sprint 2 Task 8): switched from hand-rolled secret check
  // to checkCronSecret. The previous code accepted a hardcoded fallback
  // 'commandcenter123' — same string was killed across admin routes on
  // 2026-04-22 (FIXES §0g) but this caller was missed. Anyone who had
  // ever read the source could trigger a sync without auth.
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params   = req.nextUrl.searchParams
  const provider = params.get('provider')
  const orgId    = params.get('org_id')
  const from     = params.get('from')     ?? undefined
  const to       = params.get('to')       ?? undefined
  const integId  = params.get('integration_id') ?? undefined
  if (!provider || !orgId)
    return NextResponse.json({ error: 'provider and org_id required' }, { status: 400 })

  try {
    const result = await runSync(orgId, provider, from, to, integId)
    return NextResponse.json({ ok: true, provider, from, to, ...result })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
