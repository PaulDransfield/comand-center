// app/api/inventory/waste/[id]/route.ts
// DELETE — remove a waste entry (typo / accidental).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: entry } = await db.from('waste_log').select('id, business_id').eq('id', params.id).maybeSingle()
  if (!entry) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, entry.business_id)
  if (forbidden) return forbidden

  const { error } = await db.from('waste_log').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
