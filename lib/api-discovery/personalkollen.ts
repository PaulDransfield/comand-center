// lib/api-discovery/personalkollen.ts
// Personalkollen API Schema Discovery — analyzes Personalkollen API endpoints

import { decrypt } from '@/lib/integrations/encryption'
import { createClient } from '@/lib/supabase/server'
import { analyzeWithClaude } from './claude-analyzer'

// Known Personalkollen endpoints to explore
const PERSONALKOLLEN_ENDPOINTS = [
  { path: '/staffs/', method: 'GET', description: 'Staff members and details' },
  { path: '/workplaces/', method: 'GET', description: 'Workplaces/locations' },
  { path: '/logged-times/', method: 'GET', description: 'Logged work hours' },
  { path: '/sales/', method: 'GET', description: 'Sales data' },
  { path: '/work-periods/', method: 'GET', description: 'Scheduled work periods' },
  { path: '/cost-groups/', method: 'GET', description: 'Cost groups/departments' },
  { path: '/shifts/', method: 'GET', description: 'Shift schedules' },
  { path: '/absences/', method: 'GET', description: 'Absence records' },
]

interface PersonalkollenDiscovery {
  endpoint: string
  description: string
  sample_data: any
  field_analysis: Array<{
    field_path: string
    field_type: string
    sample_value: any
  }>
  potential_mappings: Array<{
    personalkollen_field: string
    commandcenter_table: string
    commandcenter_field: string
    confidence: number
    reasoning: string
  }>
}

export async function analyzePersonalkollenAPI(integration: any): Promise<any> {
  const supabase = await createClient()
  
  try {
    // Decrypt credentials
    const token = decrypt(integration.credentials_enc)
    if (!token) {
      throw new Error('No Personalkollen API token available')
    }

    const baseUrl = 'https://personalkollen.se/api'
    const headers = {
      'Authorization': `Token ${token}`,
      'Accept': 'application/json',
    }

    const discoveries: PersonalkollenDiscovery[] = []
    const suggestedMappings: any[] = []

    // Explore each endpoint
    for (const endpoint of PERSONALKOLLEN_ENDPOINTS) {
      try {
        console.log(`Exploring Personalkollen endpoint: ${endpoint.path}`)
        
        // Fetch sample data
        let url = `${baseUrl}${endpoint.path}?limit=10`
        
        // Add date filters for time-based endpoints
        if (endpoint.path.includes('logged-times') || endpoint.path.includes('sales') || endpoint.path.includes('work-periods')) {
          const today = new Date()
          const thirtyDaysAgo = new Date(today)
          thirtyDaysAgo.setDate(today.getDate() - 30)
          
          const fromDate = thirtyDaysAgo.toISOString().slice(0, 10)
          const toDate = today.toISOString().slice(0, 10)
          url += `&date_from=${fromDate}&date_to=${toDate}`
        }

        const response = await fetch(url, { headers })
        
        if (!response.ok) {
          console.log(`Endpoint ${endpoint.path} returned ${response.status}`)
          continue
        }

        const data = await response.json()
        
        // Personalkollen uses paginated responses with 'results' array
        const items = data.results || []
        
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

        const discovery: PersonalkollenDiscovery = {
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
            personalkollen_field: m.fortnox_field, // Rename field for Personalkollen
            commandcenter_table: m.commandcenter_table,
            commandcenter_field: m.commandcenter_field,
            confidence: m.confidence,
            reasoning: m.reasoning,
            endpoint: endpoint.path,
            provider: 'personalkollen'
          })))
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500))

      } catch (error: any) {
        console.error(`Error exploring ${endpoint.path}:`, error.message)
        // Continue with other endpoints
      }
    }

    // Generate recommendations
    const recommendations = generatePersonalkollenRecommendations(discoveries)

    return {
      status: 'completed',
      provider: 'personalkollen',
      integration_id: integration.id,
      endpoints_explored: discoveries.length,
      discoveries,
      suggested_mappings: suggestedMappings,
      recommendations,
      summary: `Discovered ${discoveries.length} Personalkollen endpoints with ${suggestedMappings.length} potential mappings`
    }

  } catch (error: any) {
    console.error('Personalkollen API discovery failed:', error)
    return {
      status: 'error',
      provider: 'personalkollen',
      integration_id: integration.id,
      error: error.message
    }
  }
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

// Generate recommendations for Personalkollen
function generatePersonalkollenRecommendations(discoveries: PersonalkollenDiscovery[]): any[] {
  const recommendations = []
  
  const discoveredEndpoints = discoveries.map(d => d.endpoint)
  
  // Check if we're missing important endpoints
  if (discoveredEndpoints.includes('/cost-groups/') && !discoveredEndpoints.includes('/logged-times/')) {
    recommendations.push({
      type: 'endpoint_relationship',
      endpoint: '/cost-groups/',
      related_endpoint: '/logged-times/',
      priority: 'medium',
      reasoning: 'Cost groups provide department categorization that should be linked to logged times',
      business_value: 'Better department-level cost analysis'
    })
  }
  
  // Check for sales data availability
  if (discoveredEndpoints.includes('/sales/')) {
    recommendations.push({
      type: 'data_enhancement',
      endpoint: '/sales/',
      priority: 'high',
      reasoning: 'Sales data combined with staff data enables revenue-per-employee analysis',
      business_value: 'Understand staff productivity and revenue contribution'
    })
  }
  
  // Check for shift vs logged time comparison
  if (discoveredEndpoints.includes('/shifts/') && discoveredEndpoints.includes('/logged-times/')) {
    recommendations.push({
      type: 'analysis_opportunity',
      endpoints: ['/shifts/', '/logged-times/'],
      priority: 'high',
      reasoning: 'Compare scheduled shifts vs actual logged times for variance analysis',
      business_value: 'Identify scheduling inefficiencies and overtime patterns'
    })
  }
  
  return recommendations
}

// Helper to extract Personalkollen-specific insights
export function extractPersonalkollenInsights(discoveries: PersonalkollenDiscovery[]): any {
  const insights = {
    staff_data_available: false,
    time_tracking_available: false,
    sales_data_available: false,
    scheduling_data_available: false,
    department_structure_available: false
  }
  
  for (const discovery of discoveries) {
    if (discovery.endpoint.includes('staff')) insights.staff_data_available = true
    if (discovery.endpoint.includes('logged-times')) insights.time_tracking_available = true
    if (discovery.endpoint.includes('sales')) insights.sales_data_available = true
    if (discovery.endpoint.includes('shift') || discovery.endpoint.includes('work-period')) {
      insights.scheduling_data_available = true
    }
    if (discovery.endpoint.includes('cost-group')) insights.department_structure_available = true
  }
  
  return insights
}