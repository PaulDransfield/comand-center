// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'

export const dynamic = 'force-dynamic'

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

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db   = createAdminClient()
  const year = new Date().getFullYear()

  // Get our generated forecasts
  const { data: forecasts } = await db
    .from('forecasts')
    .select('*')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .in('period_year', [year, year + 1])
    .order('period_year')
    .order('period_month')

  // Get actuals from tracker
  const { data: actuals } = await db
    .from('tracker_data')
    .select('period_month, period_year, revenue, staff_cost, food_cost, net_profit, margin_pct')
    .eq('business_id', businessId)
    .in('period_year', [year, year + 1])
    .order('period_year')
    .order('period_month')

  // Get Personalkollen sale forecasts if connected
  let pkForecasts: any[] = []
  const { data: integ } = await db
    .from('integrations')
    .select('credentials_enc')
    .eq('org_id', auth.orgId)
    .eq('provider', 'personalkollen')
    .eq('status', 'connected')
    .maybeSingle()

  if (integ?.credentials_enc) {
    try {
      const { getSaleForecast } = await import('@/lib/pos/personalkollen')
      const token = decrypt(integ.credentials_enc)
      const now   = new Date()
      const from  = `${year}-${String(now.getMonth() + 1).padStart(2,'0')}-01`
      const to    = `${year}-12-31`
      pkForecasts = await getSaleForecast(token, from, to)
    } catch {}
  }

  return NextResponse.json({ forecasts: forecasts ?? [], actuals: actuals ?? [], pk_forecasts: pkForecasts })
}
