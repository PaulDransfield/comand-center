// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function checkAuth(req: NextRequest): boolean {
  const secret = req.headers.get('x-admin-secret') ?? req.cookies.get('admin_secret')?.value
  return secret === process.env.ADMIN_SECRET
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { provider, api_key, org_id, business_id } = await req.json()
    if (!provider || !api_key) return NextResponse.json({ error: 'provider and api_key required' }, { status: 400 })

    await recordAdminAction(createAdminClient(), {
      action:     ADMIN_ACTIONS.INTEGRATION_TEST,
      orgId:      org_id ?? null,
      targetType: 'integration',
      payload:    { provider, business_id: business_id ?? null },
      req,
    })

    if (provider === 'personalkollen') {
      // Test connection
      const BASE = 'https://personalkollen.se/api'
      const headers = { Authorization: `Token ${api_key}`, Accept: 'application/json' }

      // Get workplaces
      const wpRes = await fetch(`${BASE}/workplaces/`, { headers })
      if (!wpRes.ok) throw new Error(`Invalid API key (${wpRes.status})`)
      const wpData = await wpRes.json()
      const workplaces = wpData.results ?? []
      if (!workplaces.length) throw new Error('No workplaces found for this API key')

      const workplace = workplaces[0]

      // Get earliest logged time to detect data range
      const earliest = await fetch(`${BASE}/logged-times/?limit=1&ordering=start`, { headers })
      const earliestData = await earliest.json()
      const firstRecord = earliestData.results?.[0]
      const earliestDate = firstRecord?.start ? firstRecord.start.slice(0, 10) : '2022-01-01'

      // Get count estimate
      const countRes = await fetch(`${BASE}/logged-times/?limit=1`, { headers })
      const countData = await countRes.json()
      const totalCount = countData.count ?? 0

      return NextResponse.json({
        ok:                true,
        workplace_name:    workplace.description ?? `Workplace ${workplace.short_identifier}`,
        workplace_id:      workplace.short_identifier,
        earliest_date:     earliestDate,
        estimated_records: totalCount,
      })
    }

    if (provider === 'inzii') {
      const { testInziiConnection } = await import('@/lib/pos/inzii')
      const result = await testInziiConnection(api_key)
      return NextResponse.json({
        ok:                result.ok,
        workplace_name:    result.message,
        earliest_date:     new Date(Date.now() - 2 * 365 * 86400000).toISOString().slice(0, 10),
        estimated_records: result.days_found,
      })
    }

    if (provider === 'onslip') {
      const { testOnslipConnection } = await import('@/lib/pos/onslip')
      // Onslip credential is a JSON blob (key_id, key, realm, env) — admin pastes it
      // into the API key field. Parse leniently.
      let creds: any
      try { creds = JSON.parse(api_key) }
      catch { throw new Error('Onslip credential must be JSON: {"key_id":"user+token@realm","key":"base64...","realm":"…","env":"prod"}') }
      if (!creds.key_id || !creds.key || !creds.realm) {
        throw new Error('Onslip credential missing key_id / key / realm')
      }
      const result = await testOnslipConnection(creds)
      return NextResponse.json({
        ok:             true,
        workplace_name: `Onslip realm ${result.realm} (${result.env})`,
        earliest_date:  new Date(Date.now() - 2 * 365 * 86400000).toISOString().slice(0, 10),
        total_records:  result.users_count,
      })
    }

    return NextResponse.json({ error: `Provider ${provider} test not implemented` }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
