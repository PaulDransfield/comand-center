// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { business_id, name, city, type } = await req.json()
  if (!business_id) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { error } = await db.from('businesses')
    .update({ name, city, type })
    .eq('id', business_id)
    .eq('org_id', auth.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
