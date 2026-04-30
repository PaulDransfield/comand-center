// app/api/overheads/reconciliation/route.ts
// Active reconciliation findings for the selected business.
import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const bizForbidden = requireBusinessAccess(auth, businessId); if (bizForbidden) return bizForbidden

  const db = createAdminClient()
  const { data, error } = await db
    .from('reconciliation_findings')
    .select('id, kind, tone, entity, message, generated_at')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .is('dismissed_at', null)
    .order('generated_at', { ascending: false })
    .limit(20)

  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      return NextResponse.json({ items: [], empty: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    items: (data ?? []).map(r => ({ tone: r.tone, entity: r.entity, message: r.message })),
    raw: data ?? [],
  })
}
