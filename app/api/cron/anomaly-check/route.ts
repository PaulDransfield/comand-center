// app/api/cron/anomaly-check/route.ts
// Runs daily at 06:00 UTC — detects anomalies and creates alerts
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { runAnomalyDetection }       from '@/lib/alerts/detector'
import { checkCronSecret }           from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'
export const maxDuration = 60  // Allow up to 60 seconds for processing

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const orgId = req.nextUrl.searchParams.get('org_id') ?? undefined
    const alerts = await runAnomalyDetection(orgId)
    
    return NextResponse.json({ 
      ok: true, 
      alerts_created: alerts.length, 
      alerts,
      timestamp: new Date().toISOString()
    })
  } catch (error: any) {
    console.error('Anomaly detection cron failed:', error)
    return NextResponse.json({ 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}