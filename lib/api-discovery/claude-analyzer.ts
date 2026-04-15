// lib/api-discovery/claude-analyzer.ts
// Uses Claude to analyze API data structures and suggest mappings to CommandCenter schema

import Anthropic from '@anthropic-ai/sdk'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// CommandCenter schema knowledge for Claude
const COMMANDCENTER_SCHEMA = `
CommandCenter Database Schema (relevant tables):

1. financial_logs - Financial transactions (expenses, revenue)
   - id (UUID)
   - org_id (UUID)
   - business_id (UUID)
   - provider (string) - e.g., 'fortnox', 'personalkollen'
   - source_id (string) - Original ID from provider
   - log_type (string) - 'invoice', 'payment', 'expense', 'revenue'
   - amount (numeric) - Monetary amount
   - vat_amount (numeric) - VAT/tax amount
   - vendor_name (string) - Supplier/customer name
   - vendor_number (string) - Supplier/customer number
   - transaction_date (date)
   - period_year (integer)
   - period_month (integer)
   - description (text)

2. revenue_logs - Revenue/sales data
   - id (UUID)
   - org_id (UUID)
   - business_id (UUID)
   - provider (string)
   - source_id (string)
   - revenue_date (date)
   - revenue (numeric)
   - covers (integer) - Number of customers/guests
   - revenue_per_cover (numeric)
   - dine_in_revenue (numeric)
   - takeaway_revenue (numeric)
   - tip_revenue (numeric)
   - period_year (integer)
   - period_month (integer)

3. staff_logs - Staff hours and costs
   - id (UUID)
   - org_id (UUID)
   - business_id (UUID)
   - provider (string)
   - source_id (string)
   - staff_name (string)
   - staff_id (string) - External staff ID
   - shift_date (date)
   - hours_worked (numeric)
   - hourly_rate (numeric)
   - staff_cost (numeric)
   - department (string)
   - period_year (integer)
   - period_month (integer)

4. products_logs - Product/service sales
   - id (UUID)
   - org_id (UUID)
   - business_id (UUID)
   - provider (string)
   - source_id (string)
   - product_name (string)
   - product_code (string)
   - sale_date (date)
   - quantity (integer)
   - unit_price (numeric)
   - total_amount (numeric)
   - category (string)

Mapping Guidelines:
- Monetary amounts → amount, revenue, staff_cost, unit_price
- Dates → transaction_date, revenue_date, shift_date, sale_date
- Names → vendor_name, staff_name, product_name
- IDs → source_id, vendor_number, staff_id, product_code
- Quantities → covers, quantity, hours_worked
- Descriptions → description, category, department
`

export async function analyzeWithClaude(data: {
  endpoint: string
  description: string
  sample_item: any
  field_analysis: Array<{
    field_path: string
    field_type: string
    sample_value: any
  }>
}): Promise<{
  semantic_analysis: string
  suggested_mappings: Array<{
    fortnox_field: string
    commandcenter_table: string
    commandcenter_field: string
    confidence: number
    reasoning: string
  }>
  data_quality_notes: string[]
}> {
  try {
    // Prepare the prompt for Claude
    const prompt = `
You are an API schema analysis expert. Your task is to analyze data from a new API endpoint and suggest how it should map to the CommandCenter database schema.

API ENDPOINT: ${data.endpoint}
DESCRIPTION: ${data.description}

SAMPLE DATA (first item from the API):
${JSON.stringify(data.sample_item, null, 2)}

FIELD ANALYSIS:
${data.field_analysis.map(f => `- ${f.field_path} (${f.field_type}): ${JSON.stringify(f.sample_value)}`).join('\n')}

${COMMANDCENTER_SCHEMA}

ANALYSIS TASK:
1. Understand what this API endpoint provides (e.g., expenses, revenue, staff data, products)
2. For each relevant field in the sample data, suggest the best CommandCenter table and field to map to
3. Provide a confidence score (0-100) for each mapping suggestion
4. Explain your reasoning for each mapping
5. Note any data quality issues or special considerations

RESPONSE FORMAT (JSON):
{
  "semantic_analysis": "Brief analysis of what this endpoint provides",
  "suggested_mappings": [
    {
      "fortnox_field": "field.path.from.sample",
      "commandcenter_table": "table_name",
      "commandcenter_field": "field_name",
      "confidence": 85,
      "reasoning": "Why this mapping makes sense"
    }
  ],
  "data_quality_notes": [
    "Note 1 about data quality",
    "Note 2 about special handling needed"
  ]
}

IMPORTANT: Only suggest mappings for fields that are clearly relevant to CommandCenter. Skip fields that are internal IDs, metadata, or not useful for business analysis.
`

    const response = await anthropic.messages.create({
      model: AI_MODELS.ANALYSIS,
      max_tokens: MAX_TOKENS.AGENT_RECOMMENDATION,
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
      return {
        semantic_analysis: 'Failed to parse Claude response',
        suggested_mappings: [],
        data_quality_notes: ['Claude response parsing failed']
      }
    }

    try {
      const result = JSON.parse(jsonMatch[0])
      return result
    } catch (parseError) {
      console.error('Failed to parse Claude JSON:', parseError, 'Text:', text)
      return {
        semantic_analysis: 'JSON parsing failed',
        suggested_mappings: [],
        data_quality_notes: ['Failed to parse Claude JSON response']
      }
    }

  } catch (error: any) {
    console.error('Claude analysis failed:', error)
    return {
      semantic_analysis: `Analysis failed: ${error.message}`,
      suggested_mappings: [],
      data_quality_notes: [`Claude analysis error: ${error.message}`]
    }
  }
}

// Helper function for generic API analysis (not Fortnox-specific)
export async function analyzeGenericAPI(data: {
  provider: string
  endpoint: string
  sample_data: any
  api_documentation?: string
}): Promise<any> {
  const prompt = `
You are analyzing a new API integration for CommandCenter.

PROVIDER: ${data.provider}
ENDPOINT: ${data.endpoint}
API DOCUMENTATION: ${data.api_documentation || 'Not provided'}

SAMPLE DATA:
${JSON.stringify(data.sample_data, null, 2)}

${COMMANDCENTER_SCHEMA}

TASK:
1. Identify what type of data this endpoint provides
2. Suggest the best CommandCenter table to store this data
3. List the key fields that should be mapped
4. Note any transformations needed (e.g., date format conversion, currency handling)
5. Flag any potential issues (rate limits, data quality, missing fields)

Respond with a clear analysis and specific mapping recommendations.
`

  try {
    const response = await anthropic.messages.create({
      model: AI_MODELS.ANALYSIS,
      max_tokens: MAX_TOKENS.AGENT_RECOMMENDATION,
      messages: [{ role: 'user', content: prompt }],
    })

    const content = response.content[0]
    return content.type === 'text' ? content.text : 'Non-text response from Claude'
  } catch (error: any) {
    console.error('Generic API analysis failed:', error)
    return `Analysis failed: ${error.message}`
  }
}