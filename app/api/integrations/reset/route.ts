// @ts-nocheck
// Resets integration status from error back to connected and triggers sync

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { provider } = await req.json()
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 })

  const db = createAdminClient()

  await db.from('integrations')
    .update({ status: 'connected', last_error: null })
    .eq('org_id', auth.orgId)
    .eq('provider', provider)

  return NextResponse.json({ ok: true })
}
