// @ts-nocheck
// /api/cron/customer-health-scoring - Weekly customer health analysis
// Runs: Monday 08:00 UTC

import { NextRequest, NextResponse } from 'next/server'
import { analyzeCustomerHealth } from '@/lib/agents/customer-health-scoring'
import { checkCronSecret }       from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // 2 minutes for processing all customers

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const orgId = req.nextUrl.searchParams.get('org_id') // Optional: specific org
    const results = await analyzeCustomerHealth(orgId)
    
    return NextResponse.json({
      ok: true,
      orgs_analyzed: results.length,
      results,
      timestamp: new Date().toISOString()
    })
  } catch (error: any) {
    console.error('Customer health scoring failed:', error)
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}

// Vercel Cron dispatches GET — delegate to the same handler.
export const GET = POST
