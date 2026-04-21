// @ts-nocheck
// /api/cron/customer-health-scoring - Weekly customer health analysis
// Runs: Monday 08:00 UTC

import { NextRequest, NextResponse } from 'next/server'
import { analyzeCustomerHealth } from '@/lib/agents/customer-health-scoring'
import { checkCronSecret }       from '@/lib/admin/check-secret'
import { log }                   from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const orgId = req.nextUrl.searchParams.get('org_id')
    const results = await analyzeCustomerHealth(orgId)

    log.info('customer-health-scoring complete', {
      route:         'cron/customer-health-scoring',
      duration_ms:   Date.now() - started,
      orgs_analyzed: results.length,
      scope:         orgId ?? 'all',
      status:        'success',
    })
    return NextResponse.json({
      ok: true,
      orgs_analyzed: results.length,
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    log.error('customer-health-scoring failed', {
      route:       'cron/customer-health-scoring',
      duration_ms: Date.now() - started,
      error:       error?.message ?? String(error),
      status:      'error',
    })
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}

// Vercel Cron dispatches GET — delegate to the same handler.
export const GET = POST
