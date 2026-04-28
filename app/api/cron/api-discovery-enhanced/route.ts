// app/api/cron/api-discovery-enhanced/route.ts
// Enhanced API Schema Discovery Agent with unused data analysis
// Features:
// 1. Generic analysis for any POS/staffing system
// 2. Identifies unused data and suggests how to use it
// 3. Provides business insights and implementation recommendations

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { analyzeGenericAPIEnhanced, analyzeProviderEndpoints, generateImplementationPlan, APIAnalysisRequest } from '@/lib/api-discovery/enhanced-analyzer'
import { checkCronSecret } from '@/lib/admin/check-secret'
import { log }             from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

// Common POS/staffing systems in Sweden
const KNOWN_PROVIDERS = {
  pos: ['iZettle', 'Lightspeed', 'Visma', 'Bokio', 'Fortnox Retail', 'Swess', 'Inzii', 'Unicenta', 'Square'],
  staffing: ['Personalkollen', 'Visma Lön', 'Bokio Lön', 'Fortnox Lön', 'TimeCare', 'Planful'],
  accounting: ['Fortnox', 'Visma', 'Bokio', 'QuickBooks', 'Xero'],
  inventory: ['Lightspeed Inventory', 'Visma Lager', 'Fortnox Lager']
}

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { withCronLog } = await import('@/lib/cron/log')
  return withCronLog('api-discovery-enhanced', async () => {

  const started = Date.now()
  log.info('api-discovery-enhanced start', { route: 'cron/api-discovery-enhanced' })
  const supabase = await createClient()
  
  try {
    // Get all active integrations that need enhanced discovery
    const { data: integrations } = await supabase
      .from('integrations')
      .select(`
        id, 
        org_id, 
        business_id, 
        provider, 
        provider_type,
        credentials_enc, 
        config,
        last_enhanced_discovery_at,
        api_endpoints_cache
      `)
      .eq('status', 'connected')
      .or('last_enhanced_discovery_at.is.null,last_enhanced_discovery_at.lt.now() - interval \'30 days\'')
      .limit(3) // Process max 3 integrations per run (more intensive analysis)

    if (!integrations || integrations.length === 0) {
      return NextResponse.json({ 
        ok: true, 
        message: 'No integrations need enhanced discovery',
        timestamp: new Date().toISOString()
      })
    }

    const results = []
    
    for (const integ of integrations) {
      try {
        console.log(`Starting enhanced discovery for ${integ.provider} (${integ.id})`)
        
        // Determine provider type if not set
        const providerType = integ.provider_type || determineProviderType(integ.provider)
        
        // Fetch sample data from the integration
        const sampleData = await fetchSampleData(integ, supabase)
        
        if (!sampleData || sampleData.length === 0) {
          console.warn(`No sample data available for ${integ.provider}`)
          // Stamp last_enhanced_discovery_at anyway so this integration drops out
          // of the candidate pool for 30 days — otherwise 6 Inzii integrations (no
          // live endpoint yet) would block the 2 PK ones from ever being picked.
          await supabase
            .from('integrations')
            .update({ last_enhanced_discovery_at: new Date().toISOString() })
            .eq('id', integ.id)
          results.push({
            integration_id: integ.id,
            provider: integ.provider,
            status: 'skipped',
            message: 'No sample data available for analysis'
          })
          continue
        }

        // Prepare analysis request
        const analysisRequest: APIAnalysisRequest = {
          provider: integ.provider,
          endpoint: getPrimaryEndpoint(integ),
          endpoint_description: `Primary data endpoint for ${integ.provider}`,
          sample_data: sampleData,
          api_documentation: getProviderDocumentation(integ.provider),
          provider_type: providerType as any,
          known_apis: getKnownSimilarAPIs(integ.provider, providerType)
        }

        // Perform enhanced analysis
        const enhancedResult = await analyzeGenericAPIEnhanced(analysisRequest)
        
        // Store enhanced discovery results
        await supabase
          .from('api_discoveries_enhanced')
          .upsert({
            integration_id: integ.id,
            org_id: integ.org_id,
            business_id: integ.business_id,
            provider: integ.provider,
            provider_type: providerType,
            analysis_result: enhancedResult,
            discovered_at: new Date().toISOString(),
            confidence_score: enhancedResult.confidence_score,
            data_type: enhancedResult.data_type,
            unused_fields_count: enhancedResult.unused_fields.length,
            business_insights_count: enhancedResult.business_insights.length
          }, { onConflict: 'integration_id' })

        // Generate and store implementation plan
        const implementationPlan = generateImplementationPlan([enhancedResult])
        
        await supabase
          .from('implementation_plans')
          .upsert({
            integration_id: integ.id,
            org_id: integ.org_id,
            provider: integ.provider,
            phase1_tasks: implementationPlan.phase1,
            phase2_tasks: implementationPlan.phase2,
            phase3_tasks: implementationPlan.phase3,
            estimated_timeline: implementationPlan.estimated_timeline,
            generated_at: new Date().toISOString()
          }, { onConflict: 'integration_id' })

        // Update last_enhanced_discovery_at timestamp
        await supabase
          .from('integrations')
          .update({ 
            last_enhanced_discovery_at: new Date().toISOString(),
            provider_type: providerType
          })
          .eq('id', integ.id)

        results.push({
          integration_id: integ.id,
          provider: integ.provider,
          provider_type: providerType,
          status: 'completed',
          confidence_score: enhancedResult.confidence_score,
          data_type: enhancedResult.data_type,
          field_mappings_count: enhancedResult.field_mappings.length,
          unused_fields_count: enhancedResult.unused_fields.length,
          business_insights_count: enhancedResult.business_insights.length,
          implementation_plan: {
            phase1_tasks: implementationPlan.phase1.length,
            phase2_tasks: implementationPlan.phase2.length,
            phase3_tasks: implementationPlan.phase3.length,
            estimated_timeline: implementationPlan.estimated_timeline
          }
        })

        console.log(`Enhanced discovery completed for ${integ.provider}: ${enhancedResult.confidence_score}% confidence`)

      } catch (error: any) {
        console.error(`Enhanced discovery failed for integration ${integ.id}:`, error)
        results.push({
          integration_id: integ.id,
          provider: integ.provider,
          status: 'error',
          error: error.message,
          stack: error.stack
        })
      }
    }

    const completed = results.filter(r => r.status === 'completed').length
    const errs      = results.filter(r => r.status === 'error').length
    log.info('api-discovery-enhanced complete', {
      route:                  'cron/api-discovery-enhanced',
      duration_ms:            Date.now() - started,
      integrations_processed: results.length,
      completed,
      errors:                 errs,
      status:                 errs === 0 ? 'success' : 'partial',
    })

    return NextResponse.json({
      ok: true,
      integrations_processed: results.length,
      results,
      timestamp: new Date().toISOString(),
      summary: {
        completed,
        skipped: results.filter(r => r.status === 'skipped').length,
        errors:  errs,
        average_confidence: results.filter(r => r.confidence_score !== undefined).length > 0
          ? Math.round(results.filter(r => r.confidence_score !== undefined).reduce((sum, r) => sum + (r.confidence_score || 0), 0) / results.filter(r => r.confidence_score !== undefined).length)
          : 0,
      },
    })

  } catch (error: any) {
    log.error('api-discovery-enhanced failed', {
      route:       'cron/api-discovery-enhanced',
      duration_ms: Date.now() - started,
      error:       error?.message ?? String(error),
      status:      'error',
    })
    return NextResponse.json({
      ok: false,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
  })
}

// Helper functions
function determineProviderType(provider: string): string {
  const providerLower = provider.toLowerCase()
  
  if (KNOWN_PROVIDERS.pos.some(p => providerLower.includes(p.toLowerCase()))) return 'pos'
  if (KNOWN_PROVIDERS.staffing.some(p => providerLower.includes(p.toLowerCase()))) return 'staffing'
  if (KNOWN_PROVIDERS.accounting.some(p => providerLower.includes(p.toLowerCase()))) return 'accounting'
  if (KNOWN_PROVIDERS.inventory.some(p => providerLower.includes(p.toLowerCase()))) return 'inventory'
  
  return 'other'
}

// Fetch a small sample of real records from the integration's API so Claude has
// real field shapes to analyse. Prefers a live API call (authoritative); falls
// back to whatever's cached on integrations.api_endpoints_cache. Any error at
// any stage returns [] so the outer loop marks the integration "skipped"
// instead of crashing the whole cron.
async function fetchSampleData(integration: any, supabase: any): Promise<any[]> {
  // 1) Live fetch — provider-specific
  try {
    const live = await fetchLiveSample(integration)
    if (live.length > 0) return live
  } catch (err: any) {
    console.warn(`[enhanced-discovery] live sample fetch failed for ${integration.provider}:`, err.message)
  }

  // 2) Fallback: use whatever's pre-populated in api_endpoints_cache
  if (integration.api_endpoints_cache) {
    try {
      const endpoints = JSON.parse(integration.api_endpoints_cache)
      const first = Array.isArray(endpoints) ? endpoints[0] : endpoints
      if (first?.sample_data) {
        return Array.isArray(first.sample_data)
          ? first.sample_data.slice(0, 5)
          : [first.sample_data]
      }
    } catch (err: any) {
      console.warn(`[enhanced-discovery] bad api_endpoints_cache for ${integration.id}:`, err.message)
    }
  }

  return []
}

// Fetch up to 5 sample records directly from the provider's API.
// PK has a confirmed endpoint today; Inzii and Fortnox are not yet probed —
// they return [] and the cron marks the integration "skipped" for now.
async function fetchLiveSample(integration: any): Promise<any[]> {
  const { decrypt } = await import('@/lib/integrations/encryption')
  const creds = decrypt(integration.credentials_enc)
  if (!creds) return []

  const provider = (integration.provider ?? '').toLowerCase()

  if (provider === 'personalkollen') {
    // Grab the last 7 days of /sales/ so Claude sees realistic sale objects
    const to   = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
    const url  = `https://personalkollen.se/api/sales/?sale_time__gte=${from}&sale_time__lte=${to}&page_size=5`
    const res  = await fetch(url, {
      headers: { Authorization: `Token ${creds}`, Accept: 'application/json' },
      signal:  AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`PK /sales/ returned ${res.status}`)
    const body = await res.json()
    return Array.isArray(body?.results) ? body.results.slice(0, 5) : []
  }

  // Inzii / Swess — endpoint not yet confirmed (see docs/commandcenter ROADMAP).
  // Fortnox — OAuth not yet approved.
  // Other providers — no live adapter. All fall through to [].
  return []
}

function getPrimaryEndpoint(integration: any): string {
  if (integration.config?.primary_endpoint) {
    return integration.config.primary_endpoint
  }
  
  // Default endpoints based on provider type
  switch (integration.provider_type || determineProviderType(integration.provider)) {
    case 'pos':
      return '/api/v1/transactions'
    case 'staffing':
      return '/api/v1/shifts'
    case 'accounting':
      return '/api/v1/invoices'
    case 'inventory':
      return '/api/v1/products'
    default:
      return '/api/v1/data'
  }
}

function getProviderDocumentation(provider: string): string {
  const docs: Record<string, string> = {
    'fortnox': 'Swedish accounting software with REST API for invoices, customers, suppliers',
    'personalkollen': 'Swedish staffing/payroll system with employee data, shifts, costs',
    'izettle': 'Mobile POS system with transaction data, products, payments',
    'lightspeed': 'Retail POS with inventory, sales, customer data',
    'visma': 'Swedish business software suite with accounting, payroll, inventory',
    'bokio': 'Swedish accounting software for small businesses',
    'swess': 'Swedish restaurant POS system with table management, orders',
    'inzii': 'Swedish restaurant POS with kitchen display, online orders'
  }
  
  return docs[provider.toLowerCase()] || `API documentation for ${provider}`
}

function getKnownSimilarAPIs(provider: string, providerType: string): string[] {
  const providerLower = provider.toLowerCase()
  const similarAPIs = new Set<string>()
  
  // Add the provider itself
  similarAPIs.add(provider)
  
  // Add known similar APIs based on type
  if (KNOWN_PROVIDERS[providerType as keyof typeof KNOWN_PROVIDERS]) {
    KNOWN_PROVIDERS[providerType as keyof typeof KNOWN_PROVIDERS].forEach(p => {
      if (p.toLowerCase() !== providerLower) {
        similarAPIs.add(p)
      }
    })
  }
  
  return Array.from(similarAPIs)
}

// GET endpoint to retrieve discovery results
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  
  try {
    const { searchParams } = new URL(req.url)
    const integrationId = searchParams.get('integration_id')
    
    let query = supabase
      .from('api_discoveries_enhanced')
      .select('*')
      .order('discovered_at', { ascending: false })
    
    if (integrationId) {
      query = query.eq('integration_id', integrationId)
    }
    
    const { data: discoveries, error } = await query.limit(10)
    
    if (error) throw error
    
    return NextResponse.json({ 
      ok: true, 
      discoveries,
      count: discoveries?.length || 0,
      timestamp: new Date().toISOString()
    })
    
  } catch (error: any) {
    console.error('Failed to fetch discovery results:', error)
    return NextResponse.json({ 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}