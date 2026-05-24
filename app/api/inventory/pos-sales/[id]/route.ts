// app/api/inventory/pos-sales/[id]/route.ts — delete a single pos_sales row

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
  const { data: row } = await db.from('pos_sales').select('id, business_id').eq('id', params.id).maybeSingle()
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, row.business_id)
  if (forbidden) return forbidden
  const { error } = await db.from('pos_sales').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
