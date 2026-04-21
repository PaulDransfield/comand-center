// @ts-nocheck
// app/api/cron/live-api-prober/route.ts
// Cron job for Live API Prober Agent
// Runs periodically to probe APIs and discover working endpoints

import { NextRequest, NextResponse } from 'next/server'
import { probeAPIs } from '@/lib/agents/live-api-prober'
import { checkCronSecret } from '@/lib/admin/check-secret'

export const runtime     = 'nodejs'
export const maxDuration = 300 // 5 minutes for extensive probing
export const dynamic     = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!checkCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    console.log('Starting Live API Prober cron job...')
    
    // Get provider from query param if specified
    const url = new URL(request.url)
    const provider = url.searchParams.get('provider') || undefined
    
    // Run the probe
    const { results, analysis } = await probeAPIs(provider)
    
    // Generate summary
    const summary = {
      total_providers: analysis.length,
      total_requests: results.length,
      successful_requests: results.filter(r => r.success).length,
      success_rate: results.length > 0 
        ? (results.filter(r => r.success).length / results.length) * 100 
        : 0,
      providers: analysis.map(a => ({
        provider: a.provider,
        working_endpoints: a.working_endpoints.length,
        success_rate: a.auth_patterns.length > 0 
          ? Math.max(...a.auth_patterns.map(p => p.success_rate))
          : 0
      }))
    }
    
    console.log('Live API Prober completed:', summary)
    
    return NextResponse.json({
      status: 'success',
      message: 'Live API Prober completed',
      summary,
      analysis_count: analysis.length,
      results_count: results.length,
      timestamp: new Date().toISOString()
    })
    
  } catch (error: any) {
    console.error('Live API Prober failed:', error)
    
    return NextResponse.json(
      {
        status: 'error',
        message: 'Live API Prober failed',
        error: error.message,
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

// Manual trigger endpoint (admin only)
export async function POST(request: NextRequest) {
  // Verify admin secret
  const authHeader = request.headers.get('authorization')
  const adminSecret = process.env.ADMIN_SECRET
  
  if (!adminSecret || authHeader !== `Bearer ${adminSecret}`) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }
  
  try {
    const body = await request.json()
    const { provider, credentials, test_mode } = body
    
    console.log('Manual Live API Prober triggered:', { provider, test_mode })
    
    if (test_mode) {
      // Test mode - just probe a couple of endpoints
      const { results, analysis } = await probeAPIs(provider, credentials)
      
      return NextResponse.json({
        status: 'success',
        message: 'Test probe completed',
        test_mode: true,
        results_sample: results.slice(0, 5),
        analysis: analysis,
        timestamp: new Date().toISOString()
      })
    } else {
      // Full probe
      const { results, analysis } = await probeAPIs(provider, credentials)
      
      return NextResponse.json({
        status: 'success',
        message: 'Full probe completed',
        results_count: results.length,
        analysis_count: analysis.length,
        providers: analysis.map(a => a.provider),
        timestamp: new Date().toISOString()
      })
    }
    
  } catch (error: any) {
    console.error('Manual Live API Prober failed:', error)
    
    return NextResponse.json(
      {
        status: 'error',
        message: 'Manual probe failed',
        error: error.message,
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}