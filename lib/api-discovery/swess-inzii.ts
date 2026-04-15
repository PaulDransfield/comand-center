// lib/api-discovery/swess-inzii.ts
// Swess/Inzii POS API Schema Discovery — analyzes POS system connected to Vero Italiano

import { decrypt } from '@/lib/integrations/encryption'
import { createClient } from '@/lib/supabase/server'
import { analyzeWithClaude } from './claude-analyzer'
import { analyzeGenericAPI } from './claude-analyzer'

// Common POS endpoints (Swess/Inzii specific - these would need to be verified)
const SWESS_INZII_ENDPOINTS = [
  { path: '/api/sales', method: 'GET', description: 'Sales transactions' },
  { path: '/api/products', method: 'GET', description: 'Product catalog' },
  { path: '/api/categories', method: 'GET', description: 'Product categories' },
  { path: '/api/tables', method: 'GET', description: 'Table/seat management' },
  { path: '/api/orders', method: 'GET', description: 'Order history' },
  { path: '/api/payments', method: 'GET', description: 'Payment transactions' },
  { path: '/api/staff', method: 'GET', description: 'Staff/users' },
  { path: '/api/shifts', method: 'GET', description: 'Shift reports' },
]

interface SwessInziiDiscovery {
  endpoint: string
  description: string
  sample_data: any
  field_analysis: Array<{
    field_path: string
    field_type: string
    sample_value: any
  }>
  potential_mappings: Array<{
    pos_field: string
    commandcenter_table: string
    commandcenter_field: string
    confidence: number
    reasoning: string
  }>
}

export async function analyzeSwessInziiAPI(integration: any): Promise<any> {
  const supabase = await createClient()
  
  try {
    // Decrypt credentials
    const creds = JSON.parse(decrypt(integration.credentials_enc) ?? '{}')
    
    // Swess/Inzii might use API key, OAuth, or basic auth
    const apiKey = creds.api_key || creds.access_token
    const username = creds.username
    const password = creds.password
    
    if (!apiKey && !username) {
      throw new Error('No Swess/Inzii credentials available')
    }

    // Base URL would be configured per integration
    const baseUrl = creds.base_url || 'https://api.swess.se' // Default, should be configurable
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }
    
    // Add authentication
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    } else if (username && password) {
      headers['Authorization'] = `Basic ${btoa(`${username}:${password}`)}`
    }

    const discoveries: SwessInziiDiscovery[] = []
    const suggestedMappings: any[] = []

    // Explore each endpoint
    for (const endpoint of SWESS_INZII_ENDPOINTS) {
      try {
        console.log(`Exploring Swess/Inzii endpoint: ${endpoint.path}`)
        
        // Fetch sample data with date range for time-based endpoints
        let url = `${baseUrl}${endpoint.path}`
        
        // Add query parameters for time-based data
        if (endpoint.path.includes('sales') || endpoint.path.includes('orders') || endpoint.path.includes('payments')) {
          const today = new Date()
          const sevenDaysAgo = new Date(today)
          sevenDaysAgo.setDate(today.getDate() - 7)
          
          const fromDate = sevenDaysAgo.toISOString().slice(0, 10)
          const toDate = today.toISOString().slice(0, 10)
          
          // Different POS systems use different parameter names
          url += `?from=${fromDate}&to=${toDate}&limit=10`
        } else {
          url += '?limit=10'
        }

        const response = await fetch(url, { headers })
        
        if (!response.ok) {
          console.log(`Endpoint ${endpoint.path} returned ${response.status}`)
          continue
        }

        const data = await response.json()
        
        // Extract items - POS responses vary widely
        const items = extractItemsFromPOSResponse(data, endpoint.path)
        
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

        // Transform mappings to match Swess/Inzii interface
        const transformedMappings = (claudeAnalysis.suggested_mappings || []).map(mapping => ({
          pos_field: mapping.fortnox_field,
          commandcenter_table: mapping.commandcenter_table,
          commandcenter_field: mapping.commandcenter_field,
          confidence: mapping.confidence || 0,
          reasoning: mapping.reasoning || ''
        }))

        const discovery: SwessInziiDiscovery = {
          endpoint: endpoint.path,
          description: endpoint.description,
          sample_data: sampleItem,
          field_analysis: fieldAnalysis,
          potential_mappings: transformedMappings
        }

        discoveries.push(discovery)
        
        // Add to suggested mappings
        if (claudeAnalysis.suggested_mappings) {
          suggestedMappings.push(...claudeAnalysis.suggested_mappings.map((m: any) => ({
            pos_field: m.fortnox_field, // Rename field for POS
            commandcenter_table: m.commandcenter_table,
            commandcenter_field: m.commandcenter_field,
            confidence: m.confidence,
            reasoning: m.reasoning,
            endpoint: endpoint.path,
            provider: 'swess-inzii'
          })))
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300))

      } catch (error: any) {
        console.error(`Error exploring ${endpoint.path}:`, error.message)
        // Continue with other endpoints
      }
    }

    // Generate POS-specific recommendations
    const recommendations = generatePOSRecommendations(discoveries, integration)

    return {
      status: 'completed',
      provider: 'swess-inzii',
      integration_id: integration.id,
      endpoints_explored: discoveries.length,
      discoveries,
      suggested_mappings: suggestedMappings,
      recommendations,
      summary: `Discovered ${discoveries.length} Swess/Inzii endpoints with ${suggestedMappings.length} potential mappings`
    }

  } catch (error: any) {
    console.error('Swess/Inzii API discovery failed:', error)
    return {
      status: 'error',
      provider: 'swess-inzii',
      integration_id: integration.id,
      error: error.message
    }
  }
}

// Extract items from various POS response formats
function extractItemsFromPOSResponse(data: any, endpoint: string): any[] {
  // Try common POS response structures
  
  // 1. Direct array
  if (Array.isArray(data)) {
    return data
  }
  
  // 2. Object with 'data' array
  if (data.data && Array.isArray(data.data)) {
    return data.data
  }
  
  // 3. Object with 'items' array
  if (data.items && Array.isArray(data.items)) {
    return data.items
  }
  
  // 4. Object with 'results' array (common in REST APIs)
  if (data.results && Array.isArray(data.results)) {
    return data.results
  }
  
  // 5. Object with endpoint-specific key
  const keys = Object.keys(data)
  for (const key of keys) {
    if (Array.isArray(data[key]) && key.toLowerCase().includes('sale') || key.toLowerCase().includes('product')) {
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
        sample_value: value.slice(0, 3)
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

// Generate POS-specific recommendations
function generatePOSRecommendations(discoveries: SwessInziiDiscovery[], integration: any): any[] {
  const recommendations = []
  
  const discoveredEndpoints = discoveries.map(d => d.endpoint)
  const department = integration.department || 'main'
  
  // Check for sales data
  if (discoveredEndpoints.some(e => e.includes('sales') || e.includes('orders'))) {
    recommendations.push({
      type: 'revenue_tracking',
      priority: 'high',
      reasoning: 'POS sales data provides real-time revenue tracking',
      business_value: 'Live revenue monitoring and daily sales analysis',
      suggested_table: 'revenue_logs',
      mapping_focus: ['transaction_date', 'revenue', 'covers', 'payment_method']
    })
  }
  
  // Check for product data
  if (discoveredEndpoints.some(e => e.includes('product') || e.includes('categor'))) {
    recommendations.push({
      type: 'product_analysis',
      priority: 'medium',
      reasoning: 'Product catalog enables menu/item-level profitability analysis',
      business_value: 'Identify best-selling and most profitable items',
      suggested_table: 'products_logs',
      mapping_focus: ['product_name', 'product_code', 'category', 'price']
    })
  }
  
  // Check for table/seat data
  if (discoveredEndpoints.some(e => e.includes('table'))) {
    recommendations.push({
      type: 'capacity_optimization',
      priority: 'medium',
      reasoning: 'Table data enables turnover rate and capacity analysis',
      business_value: 'Optimize table allocation and reservation management',
      suggested_table: 'operations_logs',
      mapping_focus: ['table_number', 'seat_count', 'turnover_time', 'reservation_status']
    })
  }
  
  // Department-specific recommendations
  if (department !== 'main') {
    recommendations.push({
      type: 'department_sync',
      priority: 'high',
      reasoning: `POS data from ${department} department needs separate tracking`,
      business_value: 'Department-level P&L analysis',
      implementation_note: 'Use department field in revenue_logs table'
    })
  }
  
  // Vero Italiano integration note
  recommendations.push({
    type: 'accounting_integration',
    priority: 'low',
    reasoning: 'Swess/Inzii connects to Vero Italiano accounting system',
    business_value: 'Potential for automated accounting reconciliation',
    follow_up: 'Explore Vero Italiano API for direct accounting sync'
  })
  
  return recommendations
}

// Helper to detect POS system type and capabilities
export function detectPOSCapabilities(discoveries: SwessInziiDiscovery[]): any {
  const capabilities = {
    has_sales_data: false,
    has_product_catalog: false,
    has_table_management: false,
    has_staff_tracking: false,
    has_shift_reports: false,
    has_payment_details: false,
    real_time_available: false,
    historical_data_depth: 'unknown' // 'day', 'week', 'month', 'year'
  }
  
  for (const discovery of discoveries) {
    if (discovery.endpoint.includes('sales') || discovery.endpoint.includes('orders')) {
      capabilities.has_sales_data = true
      
      // Check if sales data has timestamps for real-time capability
      const hasTimestamp = discovery.field_analysis.some(f => 
        f.field_path.includes('time') || f.field_path.includes('timestamp') || f.field_path.includes('created')
      )
      if (hasTimestamp) capabilities.real_time_available = true
    }
    
    if (discovery.endpoint.includes('product')) capabilities.has_product_catalog = true
    if (discovery.endpoint.includes('table')) capabilities.has_table_management = true
    if (discovery.endpoint.includes('staff')) capabilities.has_staff_tracking = true
    if (discovery.endpoint.includes('shift')) capabilities.has_shift_reports = true
    if (discovery.endpoint.includes('payment')) capabilities.has_payment_details = true
  }
  
  return capabilities
}