// lib/api-discovery/fortnox.ts
// Fortnox API Schema Discovery — analyzes Fortnox API endpoints and suggests mappings

import { decrypt } from '@/lib/integrations/encryption'
import { createClient } from '@/lib/supabase/server'
import { analyzeWithClaude } from './claude-analyzer'
import { generateSyncEngineConfig, generateSyncEngineCode, generateTableSQL } from './mapping-generator'

// Known Fortnox endpoints to explore
const FORTNOX_ENDPOINTS = [
  { path: '/supplierinvoices', method: 'GET', description: 'Supplier invoices (expenses)' },
  { path: '/invoices', method: 'GET', description: 'Customer invoices (revenue)' },
  { path: '/vouchers', method: 'GET', description: 'Accounting vouchers' },
  { path: '/articles', method: 'GET', description: 'Products/services' },
  { path: '/customers', method: 'GET', description: 'Customer database' },
  { path: '/suppliers', method: 'GET', description: 'Supplier database' },
  { path: '/orders', method: 'GET', description: 'Sales orders' },
  { path: '/offers', method: 'GET', description: 'Quotes/offers' },
]

interface FortnoxDiscovery {
  endpoint: string
  description: string
  sample_data: any
  field_analysis: Array<{
    field_path: string
    field_type: string
    sample_value: any
    semantic_meaning?: string
  }>
  potential_mappings: Array<{
    fortnox_field: string
    commandcenter_table: string
    commandcenter_field: string
    confidence: number
    reasoning: string
  }>
}

export async function analyzeFortnoxAPI(integration: any): Promise<any> {
  const supabase = await createClient()
  
  try {
    // Decrypt credentials
    const creds = JSON.parse(decrypt(integration.credentials_enc) ?? '{}')
    if (!creds.access_token) {
      throw new Error('No Fortnox access token available')
    }

    const baseUrl = 'https://api.fortnox.se/3'
    const headers = {
      'Authorization': `Bearer ${creds.access_token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }

    const discoveries: FortnoxDiscovery[] = []
    const suggestedMappings: any[] = []

    // Explore each endpoint
    for (const endpoint of FORTNOX_ENDPOINTS) {
      try {
        console.log(`Exploring Fortnox endpoint: ${endpoint.path}`)
        
        // Fetch sample data (last 30 days)
        const today = new Date()
        const thirtyDaysAgo = new Date(today)
        thirtyDaysAgo.setDate(today.getDate() - 30)
        
        const fromDate = thirtyDaysAgo.toISOString().slice(0, 10)
        const toDate = today.toISOString().slice(0, 10)
        
        let url = `${baseUrl}${endpoint.path}`
        
        // Add date filters for endpoints that support them
        if (endpoint.path.includes('invoice') || endpoint.path === '/vouchers') {
          url += `?fromdate=${fromDate}&todate=${toDate}&limit=10`
        } else {
          url += '?limit=10'
        }

        const response = await fetch(url, { headers })
        
        if (!response.ok) {
          console.log(`Endpoint ${endpoint.path} returned ${response.status}`)
          continue
        }

        const data = await response.json()
        
        // Extract the actual array of items
        const items = extractItemsFromResponse(data, endpoint.path)
        
        if (!items || items.length === 0) {
          console.log(`No data found for endpoint ${endpoint.path}`)
          continue
        }

        // Analyze the first item's structure
        const sampleItem = items[0]
        const fieldAnalysis = analyzeFields(sampleItem)
        
        // Use Claude to understand semantic meaning and suggest mappings
        const claudeAnalysis = await analyzeWithClaude({
          endpoint: endpoint.path,
          description: endpoint.description,
          sample_item: sampleItem,
          field_analysis: fieldAnalysis
        })

        const discovery: FortnoxDiscovery = {
          endpoint: endpoint.path,
          description: endpoint.description,
          sample_data: sampleItem,
          field_analysis: fieldAnalysis,
          potential_mappings: claudeAnalysis.suggested_mappings || []
        }

        discoveries.push(discovery)
        
        // Add to suggested mappings
        if (claudeAnalysis.suggested_mappings) {
          suggestedMappings.push(...claudeAnalysis.suggested_mappings.map((m: any) => ({
            ...m,
            endpoint: endpoint.path,
            provider: 'fortnox'
          })))
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500))

      } catch (error: any) {
        console.error(`Error exploring ${endpoint.path}:`, error.message)
        // Continue with other endpoints
      }
    }

    // Analyze current sync configuration vs discovered endpoints
    const currentConfig = await analyzeCurrentSyncConfig(integration.id)
    const recommendations = generateRecommendations(discoveries, currentConfig)
    
    // Generate sync engine configuration
    const syncEngineConfig = generateSyncEngineConfig(suggestedMappings)
    const syncEngineCode = generateSyncEngineCode(syncEngineConfig)
    const tableSQL = generateTableSQL(syncEngineConfig)

    return {
      status: 'completed',
      provider: 'fortnox',
      integration_id: integration.id,
      endpoints_explored: discoveries.length,
      discoveries,
      suggested_mappings: suggestedMappings,
      recommendations,
      sync_engine_config: syncEngineConfig,
      generated_code: syncEngineCode,
      table_sql: tableSQL,
      summary: `Discovered ${discoveries.length} Fortnox endpoints with ${suggestedMappings.length} potential mappings`
    }

  } catch (error: any) {
    console.error('Fortnox API discovery failed:', error)
    return {
      status: 'error',
      provider: 'fortnox',
      integration_id: integration.id,
      error: error.message
    }
  }
}

// Helper function to extract items from Fortnox response
function extractItemsFromResponse(data: any, endpoint: string): any[] {
  // Fortnox responses are typically wrapped in a singular key
  // e.g., { "SupplierInvoices": [...] } or { "Invoices": [...] }
  const keys = Object.keys(data)
  if (keys.length === 1 && Array.isArray(data[keys[0]])) {
    return data[keys[0]]
  }
  
  // Try to find any array in the response
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) {
      return data[key]
    }
  }
  
  return []
}

// Analyze fields in a sample item
function analyzeFields(item: any, prefix = ''): Array<{
  field_path: string
  field_type: string
  sample_value: any
}> {
  const fields: Array<{
    field_path: string
    field_type: string
    sample_value: any
  }> = []

  for (const [key, value] of Object.entries(item)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key
    
    if (value === null || value === undefined) {
      fields.push({
        field_path: fieldPath,
        field_type: 'null',
        sample_value: null
      })
    } else if (Array.isArray(value)) {
      fields.push({
        field_path: fieldPath,
        field_type: 'array',
        sample_value: value.slice(0, 3) // First 3 items
      })
    } else if (typeof value === 'object') {
      // Recursively analyze nested objects
      fields.push(...analyzeFields(value, fieldPath))
    } else {
      fields.push({
        field_path: fieldPath,
        field_type: typeof value,
        sample_value: value
      })
    }
  }

  return fields
}

// Analyze current sync configuration
async function analyzeCurrentSyncConfig(integrationId: string): Promise<any> {
  const supabase = await createClient()
  
  // Check what we're currently syncing
  const { data: currentMappings } = await supabase
    .from('api_discoveries')
    .select('suggested_mappings')
    .eq('integration_id', integrationId)
    .order('discovered_at', { ascending: false })
    .limit(1)
    .single()

  return currentMappings?.suggested_mappings || []
}

// Generate recommendations based on discoveries
function generateRecommendations(discoveries: FortnoxDiscovery[], currentConfig: any[]): any[] {
  const recommendations = []
  
  // Check if we're missing important endpoints
  const discoveredEndpoints = discoveries.map(d => d.endpoint)
  const currentEndpoints = currentConfig.map((c: any) => c.endpoint).filter(Boolean)
  
  // Recommend adding customer invoices if not already synced
  if (discoveredEndpoints.includes('/invoices') && !currentEndpoints.includes('/invoices')) {
    recommendations.push({
      type: 'new_endpoint',
      endpoint: '/invoices',
      priority: 'high',
      reasoning: 'Customer invoices provide revenue data, currently only syncing supplier invoices (expenses)',
      business_value: 'Complete financial picture with both revenue and expenses'
    })
  }
  
  // Recommend adding articles for product-level analysis
  if (discoveredEndpoints.includes('/articles') && !currentEndpoints.includes('/articles')) {
    recommendations.push({
      type: 'new_endpoint',
      endpoint: '/articles',
      priority: 'medium',
      reasoning: 'Articles provide product/service level data for granular sales analysis',
      business_value: 'Understand which products/services are most profitable'
    })
  }
  
  // Check for unused fields in existing endpoints
  for (const discovery of discoveries) {
    if (currentEndpoints.includes(discovery.endpoint)) {
      const currentFields = currentConfig
        .filter((c: any) => c.endpoint === discovery.endpoint)
        .map((c: any) => c.fortnox_field)
      
      const newFields = discovery.field_analysis
        .filter(f => !currentFields.includes(f.field_path))
        .filter(f => isPotentiallyUsefulField(f))
      
      if (newFields.length > 0) {
        recommendations.push({
          type: 'additional_fields',
          endpoint: discovery.endpoint,
          fields: newFields.map(f => f.field_path),
          priority: 'low',
          reasoning: `Found ${newFields.length} potentially useful fields not currently mapped`
        })
      }
    }
  }
  
  return recommendations
}

// Determine if a field is potentially useful
function isPotentiallyUsefulField(field: any): boolean {
  const usefulPatterns = [
    /date/i, /amount/i, /price/i, /cost/i, /revenue/i, /profit/i,
    /quantity/i, /total/i, /vat/i, /tax/i, /discount/i,
    /name/i, /description/i, /comment/i, /note/i,
    /customer/i, /supplier/i, /vendor/i, /client/i,
    /product/i, /article/i, /service/i, /item/i,
    /category/i, /type/i, /class/i, /group/i
  ]
  
  return usefulPatterns.some(pattern => pattern.test(field.field_path))
}