// app/api/cron/anomaly-check/route.ts
// Runs daily at 06:00 UTC — detects anomalies and creates alerts

import { NextRequest, NextResponse } from 'next/server'
import { runAnomalyDetection }       from '@/lib/alerts/detector'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId  = req.nextUrl.searchParams.get('org_id') ?? undefined
  const alerts = await runAnomalyDetection(orgId)
  return NextResponse.json({ ok: true, alerts_created: alerts.length, alerts })
}
