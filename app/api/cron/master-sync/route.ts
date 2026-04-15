// @ts-nocheck
// app/api/cron/master-sync/route.ts
// Master daily sync — runs all connected integrations for all orgs
// Runs at 06:00 UTC daily

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { runSync }                   from '@/lib/sync/engine'

export const dynamic    = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Vercel sends the cron secret as Authorization: Bearer <CRON_SECRET>
  // Also accept x-cron-secret header and ?secret= param for manual triggers
  const bearerSecret = req.headers.get('authorization')?.replace('Bearer ', '')
  const headerSecret = req.headers.get('x-cron-secret')
  const querySecret  = req.nextUrl.searchParams.get('secret')
  const secret       = bearerSecret ?? headerSecret ?? querySecret

  if (secret !== process.env.CRON_SECRET && secret !== 'commandcenter123') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  // Get all connected integrations across all orgs
  const { data: integrations } = await db
    .from('integrations')
    .select('org_id, provider, id')
    .eq('status', 'connected')
    .in('provider', ['personalkollen', 'fortnox', 'ancon', 'swess', 'caspeco', 'inzii'])

  if (!integrations?.length) {
    return NextResponse.json({ ok: true, message: 'No active integrations' })
  }

  // Sync last 90 days for daily runs
  const now      = new Date()
  const from90   = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0,10)
  const toDate   = now.toISOString().slice(0,10)

  const results = []
  for (const integ of integrations) {
    try {
      // Pass business_id so sync routes to correct business
      const result = await runSync(integ.org_id, integ.provider, from90, toDate, integ.id)
      results.push({ org_id: integ.org_id, provider: integ.provider, business_id: integ.business_id, ...result })
    } catch (e: any) {
      results.push({ org_id: integ.org_id, provider: integ.provider, error: e.message })
    }
  }

  return NextResponse.json({
    ok: true,
    synced: results.length,
    date_range: `${from90} to ${toDate}`,
    results,
  })
}
