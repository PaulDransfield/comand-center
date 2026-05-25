// app/api/scheduling/sync-now/route.ts
//
// Owner-callable: fires syncScheduleFromPK on demand for one business.
// Used by the "Sync from PK" button on /scheduling/grid when the owner
// wants to pull the latest roster without waiting for the nightly cron.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { decrypt }              from '@/lib/integrations/encryption'
import { syncScheduleFromPK }   from '@/lib/scheduling/pk-sync'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  const { data: integ } = await db
    .from('integrations')
    .select('credentials_enc, status')
    .eq('business_id', businessId)
    .eq('provider', 'personalkollen')
    .in('status', ['connected', 'warning'])
    .maybeSingle()
  if (!integ?.credentials_enc) {
    return NextResponse.json({ error: 'Personalkollen not connected for this business' }, { status: 404 })
  }

  const decoded = decrypt(integ.credentials_enc) ?? ''
  let token: string | undefined
  try {
    const o: any = JSON.parse(decoded)
    token = o.access_token ?? o.api_key ?? o.token
    if (typeof o === 'string') token = o
  } catch {
    token = decoded
  }
  if (!token) return NextResponse.json({ error: 'PK token unavailable' }, { status: 500 })

  try {
    const result = await syncScheduleFromPK(db, businessId, token)
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'sync failed' }, { status: 500 })
  }
}
