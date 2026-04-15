// app/api/cron/api-discovery/route.ts
// API Schema Discovery Agent — analyzes new API integrations and suggests mappings
// Can be triggered manually or run weekly to discover new endpoints

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { analyzeFortnoxAPI } from '@/lib/api-discovery/fortnox'
import { analyzePersonalkollenAPI } from '@/lib/api-discovery/personalkollen'
import { analyzeSwessInziiAPI } from '@/lib/api-discovery/swess-inzii'

export const dynamic = 'force-dynamic'
export const maxDuration = 300  // 5 minutes for deep API exploration

export async function POST(req: NextRequest) {
  // Check cron secret for authorization
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createClient()
  
  try {
    // Get all active integrations that need discovery
    const { data: integrations } = await supabase
      .from('integrations')
      .select('id, org_id, business_id, provider, credentials_enc, last_discovery_at')
      .eq('status', 'active')
      .or('last_discovery_at.is.null,last_discovery_at.lt.now() - interval \'7 days\'')
      .limit(5) // Process max 5 integrations per run

    if (!integrations || integrations.length === 0) {
      return NextResponse.json({ 
        ok: true, 
        message: 'No integrations need discovery',
        timestamp: new Date().toISOString()
      })
    }

    const results = []
    
    for (const integ of integrations) {
      try {
        let discoveryResult
        
        // Route to appropriate analyzer based on provider
        switch (integ.provider) {
          case 'fortnox':
            discoveryResult = await analyzeFortnoxAPI(integ)
            break
          case 'personalkollen':
            discoveryResult = await analyzePersonalkollenAPI(integ)
            break
          case 'swess':
          case 'inzii':
            discoveryResult = await analyzeSwessInziiAPI(integ)
            break
          default:
            discoveryResult = { provider: integ.provider, status: 'skipped', message: 'No analyzer available for this provider' }
        }

        // Store discovery results
        if (discoveryResult.status === 'completed' && discoveryResult.discoveries) {
          await supabase
            .from('api_discoveries')
            .upsert({
              integration_id: integ.id,
              org_id: integ.org_id,
              provider: integ.provider,
              discoveries: discoveryResult.discoveries,
              suggested_mappings: discoveryResult.suggested_mappings,
              discovered_at: new Date().toISOString()
            }, { onConflict: 'integration_id' })

          // Update last_discovery_at timestamp
          await supabase
            .from('integrations')
            .update({ last_discovery_at: new Date().toISOString() })
            .eq('id', integ.id)
        }

        results.push({
          integration_id: integ.id,
          provider: integ.provider,
          ...discoveryResult
        })

      } catch (error: any) {
        console.error(`Discovery failed for integration ${integ.id}:`, error)
        results.push({
          integration_id: integ.id,
          provider: integ.provider,
          status: 'error',
          error: error.message
        })
      }
    }

    return NextResponse.json({ 
      ok: true, 
      integrations_processed: results.length,
      results,
      timestamp: new Date().toISOString()
    })
    
  } catch (error: any) {
    console.error('API discovery cron failed:', error)
    return NextResponse.json({ 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}