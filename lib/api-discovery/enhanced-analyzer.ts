// lib/api-discovery/enhanced-analyzer.ts
// Enhanced API Schema Discovery Agent for multiple POS/staffing systems
// Features:
// 1. Generic API analysis for any provider
// 2. Identifies unused data fields and suggests how to use them
// 3. Provides actionable insights for data optimization
// 4. Generates comprehensive mapping recommendations

import Anthropic from '@anthropic-ai/sdk'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// Enhanced CommandCenter schema with business context
const ENHANCED_SCHEMA = `
CommandCenter Database Schema and Business Context:

CORE TABLES:
1. financial_logs - Financial transactions
   - Fields: amount, vat_amount, vendor_name, vendor_number, transaction_date, description
   - Purpose: Track expenses, invoices, payments

2. revenue_logs - Revenue/sales data
   - Fields: revenue, covers, revenue_per_cover, dine_in_revenue, takeaway_revenue, tip_revenue
   - Purpose: Track daily sales, customer counts, revenue streams

3. staff_logs - Staff hours and costs
   - Fields: staff_name, staff_id, hours_worked, hourly_rate, staff_cost, department
   - Purpose: Track labor costs, shift patterns, department allocation

4. products_logs - Product/service sales
   - Fields: product_name, product_code, quantity, unit_price, total_amount, category
   - Purpose: Track product sales, menu performance, inventory

5. tracker_data - Monthly P&L entries
   - Fields: month, revenue_actual, revenue_forecast, food_cost, staff_cost, rent_cost, other_costs
   - Purpose: Monthly financial tracking and forecasting

6. forecasts - Predicted revenue and costs
   - Fields: forecast_date, predicted_revenue, predicted_covers, confidence_score
   - Purpose: Revenue forecasting and planning

BUSINESS CONTEXT (What CommandCenter analyzes):
- Food cost percentage (target: 31%)
- Staff cost percentage (target: 40%)
- Rent cost percentage (target: 13%)
- Profit margin (target: 12%)
- Revenue per cover
- Department cost breakdown
- Anomaly detection (unusual costs/revenue)
- Forecasting accuracy
- Staff scheduling optimization

DATA TRANSFORMATIONS NEEDED:
- Swedish dates: "2026-03-15" → ISO format
- Swedish currency: "1 234,50 kr" → 1234.50
- Department mapping: "Kök" → "Kitchen", "Servering" → "Service"
- VAT handling: "moms 25%" → separate vat_amount field
- Time formats: "08:00-16:30" → hours_worked: 8.5
`

export interface APIAnalysisRequest {
  provider: string
  endpoint: string
  endpoint_description?: string
  sample_data: any[]
  api_documentation?: string
  provider_type: 'pos' | 'staffing' | 'accounting' | 'inventory' | 'other'
  known_apis?: string[] // e.g., ['Fortnox', 'Personalkollen', 'Visma', 'iZettle', 'Lightspeed', 'Bokio']
}

export interface EnhancedAnalysisResult {
  provider: string
  endpoint: string
  provider_type: string
  
  // Core analysis
  data_type: 'financial' | 'staff' | 'revenue' | 'product' | 'inventory' | 'mixed'
  primary_table: string
  confidence_score: number
  
  // Field mappings
  field_mappings: Array<{
    source_field: string
    source_type: string
    sample_value: any
    target_table: string
    target_field: string
    confidence: number
    transformation_needed: string[]
    reasoning: string
  }>
  
  // Unused data analysis
  unused_fields: Array<{
    field_path: string
    field_type: string
    sample_value: any
    potential_use: string
    business_value: 'high' | 'medium' | 'low'
    implementation_effort: 'low' | 'medium' | 'high'
    suggested_action: 'map_now' | 'future_feature' | 'ignore'
  }>
  
  // Data quality insights
  data_quality: {
    completeness_score: number
    consistency_score: number
    freshness_score: number
    issues: string[]
    recommendations: string[]
  }
  
  // Business insights
  business_insights: Array<{
    insight: string
    impact: 'revenue' | 'costs' | 'efficiency' | 'compliance' | 'customer_experience'
    priority: 'high' | 'medium' | 'low'
    suggested_implementation: string
  }>
  
  // Implementation recommendations
  implementation: {
    sync_frequency: 'daily' | 'weekly' | 'monthly' | 'realtime'
    rate_limit_handling: string[]
    error_handling: string[]
    data_retention: string
    estimated_monthly_rows: number
  }
  
  // Generated code snippets
  code_snippets: {
    sync_config: string
    transformation_functions: string[]
    validation_rules: string[]
  }
}

export async function analyzeGenericAPIEnhanced(request: APIAnalysisRequest): Promise<EnhancedAnalysisResult> {
  try {
    // Prepare the prompt for Claude
    const prompt = `
You are an expert API integration analyst for CommandCenter, a restaurant business intelligence platform.
Your task is to analyze a new API integration and provide comprehensive mapping recommendations.

API PROVIDER: ${request.provider}
PROVIDER TYPE: ${request.provider_type}
ENDPOINT: ${request.endpoint}
ENDPOINT DESCRIPTION: ${request.endpoint_description || 'Not provided'}
KNOWN SIMILAR APIS: ${request.known_apis?.join(', ') || 'None provided'}

SAMPLE DATA (first 3 items):
${JSON.stringify(request.sample_data.slice(0, 3), null, 2)}

API DOCUMENTATION EXCERPT:
${request.api_documentation || 'Not provided'}

${ENHANCED_SCHEMA}

ANALYSIS TASKS:

1. DATA TYPE IDENTIFICATION:
   - What type of data does this endpoint provide? (financial, staff, revenue, product, inventory, mixed)
   - Which CommandCenter table is the best fit?
   - Confidence score (0-100)

2. FIELD MAPPING ANALYSIS:
   For each field in the sample data:
   - Map to appropriate CommandCenter table/field
   - Note any transformations needed (date formats, currency, Swedish text, etc.)
   - Provide confidence score for each mapping
   - Explain reasoning

3. UNUSED DATA IDENTIFICATION:
   Identify fields that are NOT currently mapped to CommandCenter but could be valuable:
   - What business value could this data provide?
   - How difficult would it be to implement?
   - Suggest specific actions (map now, future feature, ignore)

4. DATA QUALITY ASSESSMENT:
   - Completeness: Are required fields present?
   - Consistency: Are data formats consistent?
   - Freshness: How current is the data?
   - Identify any data quality issues

5. BUSINESS INSIGHTS:
   - What insights could this data provide to restaurant owners?
   - How could it impact revenue, costs, or efficiency?
   - Prioritize implementation based on business value

6. IMPLEMENTATION RECOMMENDATIONS:
   - Optimal sync frequency
   - Rate limit handling
   - Error handling strategies
   - Data retention policies

RESPONSE FORMAT - return ONLY this JSON, no other text:
{
  "provider": "${request.provider}",
  "endpoint": "${request.endpoint}",
  "provider_type": "${request.provider_type}",
  "data_type": "financial|staff|revenue|product|inventory|mixed",
  "primary_table": "table_name",
  "confidence_score": 85,
  "field_mappings": [
    {
      "source_field": "field_name",
      "source_type": "string|number|date|boolean",
      "target_table": "table_name",
      "target_field": "field_name",
      "confidence": 90,
      "transformation_needed": ["parseDate"],
      "reasoning": "one sentence"
    }
  ],
  "unused_fields": [
    {
      "field_path": "field_name",
      "field_type": "string|number|date|boolean",
      "potential_use": "one sentence",
      "business_value": "high|medium|low",
      "implementation_effort": "low|medium|high",
      "suggested_action": "map_now|future_feature|ignore"
    }
  ],
  "data_quality": {
    "completeness_score": 85,
    "consistency_score": 90,
    "freshness_score": 95,
    "issues": ["issue 1"],
    "recommendations": ["recommendation 1"]
  },
  "business_insights": [
    {
      "insight": "one sentence insight",
      "impact": "revenue|costs|efficiency|compliance|customer_experience",
      "priority": "high|medium|low",
      "suggested_implementation": "one sentence"
    }
  ],
  "implementation": {
    "sync_frequency": "daily|weekly|monthly|realtime",
    "rate_limit_handling": ["strategy 1"],
    "error_handling": ["strategy 1"],
    "data_retention": "Keep 2 years",
    "estimated_monthly_rows": 1000
  },
  "code_snippets": {
    "sync_config": "",
    "transformation_functions": [],
    "validation_rules": []
  }
}

IMPORTANT: Return ONLY the JSON object. No markdown, no explanation before or after. Keep every string value under 10 words. Do not write code in code_snippets — leave those arrays empty.
`

    const response = await anthropic.messages.create({
      model: AI_MODELS.ANALYSIS,
      max_tokens: 4000, // Needs high limit — JSON response with field mappings can be 3000+ tokens
      messages: [{ role: 'user', content: prompt }],
    })

    const content = response.content[0]
    
    if (content.type !== 'text') {
      throw new Error('Claude returned non-text response')
    }

    // Extract JSON from Claude's response
    const text = content.text
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    
    if (!jsonMatch) {
      console.error('Could not extract JSON from Claude response:', text)
      throw new Error('Failed to parse Claude response as JSON')
    }

    try {
      const result = JSON.parse(jsonMatch[0]) as EnhancedAnalysisResult
      
      // Add timestamp and validation
      return {
        ...result,
        // Ensure all arrays exist
        field_mappings: result.field_mappings || [],
        unused_fields: result.unused_fields || [],
        business_insights: result.business_insights || [],
        data_quality: {
          completeness_score: result.data_quality?.completeness_score || 0,
          consistency_score: result.data_quality?.consistency_score || 0,
          freshness_score: result.data_quality?.freshness_score || 0,
          issues: result.data_quality?.issues || [],
          recommendations: result.data_quality?.recommendations || []
        },
        implementation: {
          sync_frequency: result.implementation?.sync_frequency || 'daily',
          rate_limit_handling: result.implementation?.rate_limit_handling || [],
          error_handling: result.implementation?.error_handling || [],
          data_retention: result.implementation?.data_retention || 'Keep 1 year',
          estimated_monthly_rows: result.implementation?.estimated_monthly_rows || 100
        },
        code_snippets: {
          sync_config: result.code_snippets?.sync_config || '// No sync config generated',
          transformation_functions: result.code_snippets?.transformation_functions || [],
          validation_rules: result.code_snippets?.validation_rules || []
        }
      }
    } catch (parseError) {
      console.error('Failed to parse Claude JSON:', parseError, 'Text:', text)
      throw new Error(`JSON parsing failed: ${parseError}`)
    }

  } catch (error: any) {
    console.error('Enhanced API analysis failed:', error)
    throw error
  }
}

// Helper function to analyze multiple endpoints from the same provider
export async function analyzeProviderEndpoints(
  provider: string,
  endpoints: Array<{
    path: string
    sample_data: any[]
    description?: string
  }>,
  provider_type: APIAnalysisRequest['provider_type']
): Promise<{
  provider: string
  overall_analysis: string
  endpoint_results: EnhancedAnalysisResult[]
  cross_endpoint_insights: string[]
  recommended_sync_strategy: string
}> {
  
  const endpointResults: EnhancedAnalysisResult[] = []
  
  for (const endpoint of endpoints) {
    try {
      const result = await analyzeGenericAPIEnhanced({
        provider,
        endpoint: endpoint.path,
        endpoint_description: endpoint.description,
        sample_data: endpoint.sample_data,
        provider_type,
        known_apis: ['Fortnox', 'Personalkollen', 'Visma', 'iZettle', 'Lightspeed', 'Bokio', 'Swess', 'Inzii']
      })
      endpointResults.push(result)
    } catch (error) {
      console.error(`Failed to analyze endpoint ${endpoint.path}:`, error)
    }
  }
  
  // Generate cross-endpoint insights
  const crossEndpointInsights = generateCrossEndpointInsights(endpointResults)
  
  return {
    provider,
    overall_analysis: `Analyzed ${endpointResults.length} endpoints for ${provider}. Found ${endpointResults.filter(r => r.confidence_score > 80).length} high-confidence mappings.`,
    endpoint_results: endpointResults,
    cross_endpoint_insights: crossEndpointInsights,
    recommended_sync_strategy: recommendSyncStrategy(endpointResults)
  }
}

function generateCrossEndpointInsights(results: EnhancedAnalysisResult[]): string[] {
  const insights: string[] = []
  
  // Group by data type
  const byDataType: Record<string, EnhancedAnalysisResult[]> = {}
  for (const result of results) {
    if (!byDataType[result.data_type]) {
      byDataType[result.data_type] = []
    }
    byDataType[result.data_type].push(result)
  }
  
  // Generate insights
  if (Object.keys(byDataType).length > 1) {
    insights.push(`Provider offers ${Object.keys(byDataType).length} data types: ${Object.keys(byDataType).join(', ')}. Consider implementing a unified sync strategy.`)
  }
  
  // Check for duplicate field mappings
  const allMappings = results.flatMap(r => r.field_mappings)
  const fieldCounts: Record<string, number> = {}
  for (const mapping of allMappings) {
    const key = `${mapping.target_table}.${mapping.target_field}`
    fieldCounts[key] = (fieldCounts[key] || 0) + 1
  }
  
  const duplicateFields = Object.entries(fieldCounts).filter(([_, count]) => count > 1)
  if (duplicateFields.length > 0) {
    insights.push(`Found ${duplicateFields.length} fields mapped from multiple endpoints. Consider data consolidation to avoid duplicates.`)
  }
  
  // Check for high-value unused fields
  const highValueUnused = results.flatMap(r => 
    r.unused_fields.filter(f => f.business_value === 'high' && f.implementation_effort === 'low')
  )
  if (highValueUnused.length > 0) {
    insights.push(`Found ${highValueUnused.length} high-value, low-effort unused fields. Consider implementing these for additional insights.`)
  }
  
  return insights
}

function recommendSyncStrategy(results: EnhancedAnalysisResult[]): string {
  const hasRealtimeData = results.some(r => 
    r.data_type === 'revenue' || r.implementation.sync_frequency === 'realtime'
  )
  
  const hasStaffData = results.some(r => r.data_type === 'staff')
  const hasFinancialData = results.some(r => r.data_type === 'financial')
  
  if (hasRealtimeData) {
    return 'Implement real-time webhooks for revenue data + daily batch sync for other data types'
  } else if (hasStaffData && hasFinancialData) {
    return 'Daily sync for all endpoints, with staff data prioritized in morning, financial data in evening'
  } else {
    return 'Daily batch sync during off-peak hours (02:00-04:00 local time)'
  }
}

// Generate implementation plan from analysis results
export function generateImplementationPlan(results: EnhancedAnalysisResult[]): {
  phase1: string[]
  phase2: string[]
  phase3: string[]
  estimated_timeline: string
} {
  const phase1: string[] = []
  const phase2: string[] = []
  const phase3: string[] = []
  
  for (const result of results) {
    // Phase 1: High-confidence, high-business-value mappings
    const highPriorityMappings = result.field_mappings.filter(m => 
      m.confidence >= 85 && 
      ['revenue', 'staff', 'financial'].includes(result.data_type)
    )
    
    if (highPriorityMappings.length > 0) {
      phase1.push(`Implement ${highPriorityMappings.length} high-confidence mappings from ${result.provider} ${result.endpoint} to ${result.primary_table}`)
    }
    
    // Phase 2: Medium-confidence mappings and high-value unused fields
    const mediumPriorityMappings = result.field_mappings.filter(m => 
      m.confidence >= 70 && m.confidence < 85
    )
    const highValueUnused = result.unused_fields.filter(f => 
      f.business_value === 'high' && f.implementation_effort === 'low'
    )
    
    if (mediumPriorityMappings.length > 0 || highValueUnused.length > 0) {
      phase2.push(`Add ${mediumPriorityMappings.length} medium-confidence mappings and ${highValueUnused.length} high-value unused fields from ${result.provider}`)
    }
    
    // Phase 3: Low-confidence mappings and complex implementations
    const lowPriorityMappings = result.field_mappings.filter(m => m.confidence < 70)
    const complexUnused = result.unused_fields.filter(f => 
      f.implementation_effort === 'high' || 
      (f.business_value === 'high' && f.implementation_effort === 'medium')
    )
    
    if (lowPriorityMappings.length > 0 || complexUnused.length > 0) {
      phase3.push(`Consider ${lowPriorityMappings.length} low-confidence mappings and ${complexUnused.length} complex unused fields from ${result.provider} for future enhancement`)
    }
  }
  
  // Estimate timeline based on complexity
  const totalPhase1Items = phase1.length
  const totalPhase2Items = phase2.length
  const totalPhase3Items = phase3.length
  
  let estimatedTimeline = '1-2 weeks'
  if (totalPhase1Items > 5 || totalPhase2Items > 3) {
    estimatedTimeline = '2-3 weeks'
  }
  if (totalPhase1Items > 10 || totalPhase2Items > 5) {
    estimatedTimeline = '3-4 weeks'
  }
  
  return {
    phase1,
    phase2,
    phase3,
    estimated_timeline: estimatedTimeline
  }
}
