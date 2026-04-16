// app/api/health/route.ts
//
// A simple "is everything working?" endpoint.
// Call this after setup to verify the database connection is live.
//
// Test it by visiting: http://localhost:3000/api/health
// You should see: { "status": "ok", "database": "connected" }

import { NextResponse }    from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET() {
  // DEVELOPMENT MODE: Return mock response for local development
  if (process.env.NODE_ENV === 'development' || 
      process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('mock-supabase-url-for-development')) {
    console.log('DEVELOPMENT MODE: Health check returning mock response')
    
    return NextResponse.json({
      status:    'ok',
      database:  'connected (mock)',
      orgs:      0,
      timestamp: new Date().toISOString(),
      version:   process.env.npm_package_version ?? '0.1.0',
      mode:      'development-mock'
    })
  }

  const supabase = createAdminClient()

  // Try to count rows in the organisations table
  // If this works, the database connection is healthy
  const { error, count } = await supabase
    .from('organisations')
    .select('id', { count: 'exact', head: true })  // head:true = don't return actual rows

  if (error) {
    console.error('Health check failed:', error.message)
    return NextResponse.json(
      { status: 'error', database: 'disconnected', detail: error.message },
      { status: 500 }
    )
  }

  return NextResponse.json({
    status:    'ok',
    database:  'connected',
    orgs:      count ?? 0,
    timestamp: new Date().toISOString(),
    version:   process.env.npm_package_version ?? '0.1.0',
  })
}
