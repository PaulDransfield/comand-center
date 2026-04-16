// @ts-nocheck
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

const getAuth = getRequestAuth

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const body = await req.json()
    const { id, permanent } = body
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    const db = createAdminClient()
    const { data: biz } = await db.from('businesses').select('id, name').eq('id', id).eq('org_id', auth.orgId).maybeSingle()
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })
    if (permanent) {
      const tables = ['tracker_data', 'covers', 'staff_logs', 'revenue_logs', 'forecasts', 'budgets', 'pk_sale_forecasts', 'financial_logs', 'anomaly_alerts']
      for (const table of tables) {
        await db.from(table).delete().eq('business_id', id).then(() => {}).catch(() => {})
      }
      await db.from('integrations').update({ business_id: null }).eq('business_id', id).then(() => {}).catch(() => {})
      await db.from('businesses').delete().eq('id', id)
      return NextResponse.json({ ok: true, deleted: true })
    } else {
      await db.from('businesses').update({ is_active: false }).eq('id', id)
      return NextResponse.json({ ok: true, deactivated: true })
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Unknown error' }, { status: 500 })
  }
}