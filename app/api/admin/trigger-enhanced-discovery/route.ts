// @ts-nocheck
// app/api/admin/trigger-enhanced-discovery/route.ts
// Manual trigger endpoint for Enhanced API Schema Discovery Agent
// Protected by ADMIN_SECRET Bearer token — same pattern as all other admin routes

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
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
  // Protect with ADMIN_SECRET Bearer token — same pattern as cron routes
  const authHeader = req.headers.get('authorization')
  if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  try {
    // Get all active integrations that need enhanced discovery
    const { data: integrations, error: integrationsError } = await supabase
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
      .limit(3)

    // Surface DB errors clearly instead of silently returning empty
    if (integrationsError) {
      console.error('Failed to query integrations:', integrationsError)
      return NextResponse.json({
        ok: false,
        error: `Database error: ${integrationsError.message}`,
        hint: 'Run M007 migration in Supabase — missing columns: last_enhanced_discovery_at, provider_type, api_endpoints_cache',
        timestamp: new Date().toISOString()
      }, { status: 500 })
    }

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
  const provider = (integration.provider || '').toLowerCase()
  const bizId = integration.business_id

  try {
    // Personalkollen — pull from staff_logs (what we've already synced)
    if (provider.includes('personalkollen')) {
      const { data } = await supabase
        .from('staff_logs')
        .select('staff_name, staff_group, hours_worked, cost_actual, estimated_salary, ob_supplement_kr, ob_type, is_late, late_minutes, costgroup_name, shift_date, real_start, real_stop')
        .eq('business_id', bizId)
        .order('shift_date', { ascending: false })
        .limit(5)
      if (data && data.length > 0) return data
    }

    // Swess / Inzii — pull from revenue_logs
    if (provider.includes('swess') || provider.includes('inzii')) {
      const { data } = await supabase
        .from('revenue_logs')
        .select('revenue_date, revenue, covers, revenue_per_cover, food_revenue, drink_revenue, tip_revenue, dine_in_revenue, takeaway_revenue')
        .eq('business_id', bizId)
        .order('revenue_date', { ascending: false })
        .limit(5)
      if (data && data.length > 0) return data
    }

    // Fortnox — pull from tracker_data as a proxy for financial data
    if (provider.includes('fortnox')) {
      const { data } = await supabase
        .from('tracker_data')
        .select('period_year, period_month, revenue, staff_cost, food_cost, drink_cost, rent, other_costs, net_profit')
        .eq('business_id', bizId)
        .order('period_year', { ascending: false })
        .limit(5)
      if (data && data.length > 0) return data
    }

    // Generic fallback — try staff_logs then revenue_logs
    const { data: staffData } = await supabase
      .from('staff_logs')
      .select('staff_name, staff_group, hours_worked, cost_actual, ob_type, costgroup_name, shift_date')
      .eq('business_id', bizId)
      .limit(5)
    if (staffData && staffData.length > 0) return staffData

    const { data: revenueData } = await supabase
      .from('revenue_logs')
      .select('revenue_date, revenue, covers, revenue_per_cover, food_revenue, drink_revenue')
      .eq('business_id', bizId)
      .limit(5)
    if (revenueData && revenueData.length > 0) return revenueData

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