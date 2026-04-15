// app/api/admin/trigger-enhanced-discovery/route.ts
// Manual trigger endpoint for Enhanced API Schema Discovery Agent
// This endpoint doesn't require the cron secret and is protected by Supabase auth

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { analyzeGenericAPIEnhanced, generateImplementationPlan, APIAnalysisRequest } from '@/lib/api-discovery/enhanced-analyzer'

export const dynamic = 'force-dynamic'
export const maxDuration = 300  // 5 minutes max for Vercel Hobby plan

// Common POS/staffing systems in Sweden
const KNOWN_PROVIDERS = {
  pos: ['iZettle', 'Lightspeed', 'Visma', 'Bokio', 'Fortnox Retail', 'Swess', 'Inzii', 'Unicenta', 'Square'],
  staffing: ['Personalkollen', 'Visma Lön', 'Bokio Lön', 'Fortnox Lön', 'TimeCare', 'Planful'],
  accounting: ['Fortnox', 'Visma', 'Bokio', 'QuickBooks', 'Xero'],
  inventory: ['Lightspeed Inventory', 'Visma Lager', 'Fortnox Lager']
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  
  // Check if user is authenticated (admin only)
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized - Please log in' }, { status: 401 })
  }
  
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
      .eq('status', 'active')
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

    return NextResponse.json({ 
      ok: true, 
      integrations_processed: results.length,
      results,
      timestamp: new Date().toISOString(),
      summary: {
        completed: results.filter(r => r.status === 'completed').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        errors: results.filter(r => r.status === 'error').length,
        average_confidence: results.filter(r => r.confidence_score !== undefined).length > 0 
          ? Math.round(results.filter(r => r.confidence_score !== undefined).reduce((sum, r) => sum + (r.confidence_score || 0), 0) / results.filter(r => r.confidence_score !== undefined).length)
          : 0
      }
    })
    
  } catch (error: any) {
    console.error('Enhanced API discovery failed:', error)
    return NextResponse.json({ 
      ok: false, 
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}

// Helper functions (same as in cron endpoint)
function determineProviderType(provider: string): string {
  const providerLower = provider.toLowerCase()
  
  if (KNOWN_PROVIDERS.pos.some(p => providerLower.includes(p.toLowerCase()))) return 'pos'
  if (KNOWN_PROVIDERS.staffing.some(p => providerLower.includes(p.toLowerCase()))) return 'staffing'
  if (KNOWN_PROVIDERS.accounting.some(p => providerLower.includes(p.toLowerCase()))) return 'accounting'
  if (KNOWN_PROVIDERS.inventory.some(p => providerLower.includes(p.toLowerCase()))) return 'inventory'
  
  return 'other'
}

async function fetchSampleData(integration: any, supabase: any): Promise<any[]> {
  try {
    // Try to get cached sample data from previous syncs
    const { data: recentData } = await supabase
      .from('sync_logs')
      .select('response_data')
      .eq('integration_id', integration.id)
      .eq('status', 'success')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (recentData?.response_data) {
      return Array.isArray(recentData.response_data) 
        ? recentData.response_data.slice(0, 5) 
        : [recentData.response_data]
    }

    // If no cached data, try to fetch from the integration's API endpoints cache
    if (integration.api_endpoints_cache) {
      const endpoints = JSON.parse(integration.api_endpoints_cache)
      if (endpoints.length > 0) {
        // Return sample from first endpoint
        const firstEndpoint = endpoints[0]
        if (firstEndpoint.sample_data) {
          return Array.isArray(firstEndpoint.sample_data)
            ? firstEndpoint.sample_data.slice(0, 3)
            : [firstEndpoint.sample_data]
        }
      }
    }

    // Return empty array if no sample data available
    return []
  } catch (error) {
    console.error(`Failed to fetch sample data for ${integration.provider}:`, error)
    return []
  }
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