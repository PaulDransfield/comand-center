// @ts-nocheck
// lib/agents/live-api-prober.ts
// Live API Prober Agent
// Fires real HTTP requests with stored API keys across many possible endpoint + auth combinations
// Captures every response (even 401s and 404s tell us something)
// Lets Claude figure out the working pattern

import { createAdminClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export interface APIProbeResult {
  provider: string
  endpoint: string
  method: string
  auth_type: string
  headers: Record<string, string>
  request_body?: any
  status_code: number
  response_headers: Record<string, string>
  response_body: any
  response_time_ms: number
  error?: string
  success: boolean
  discovered_pattern?: string
}

export interface APIProviderConfig {
  provider: string
  base_url: string
  api_key?: string
  api_secret?: string
  username?: string
  password?: string
  client_id?: string
  client_secret?: string
  bearer_token?: string
  auth_methods: string[]
  common_endpoints: string[]
  common_headers: Record<string, string>
}

export interface APIProbeAnalysis {
  provider: string
  working_endpoints: Array<{
    endpoint: string
    method: string
    auth_type: string
    status_code: number
    response_pattern: string
    data_structure?: any
  }>
  auth_patterns: Array<{
    auth_type: string
    success_rate: number
    headers_pattern: string
  }>
  rate_limits?: {
    detected: boolean
    limit_header?: string
    remaining_header?: string
    reset_header?: string
  }
  data_schema?: {
    endpoints: Record<string, any>
    common_fields: string[]
    data_types: Record<string, string>
  }
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low'
    action: string
    expected_impact: string
  }>
}

// Common API providers and their configurations
const COMMON_PROVIDERS: APIProviderConfig[] = [
  {
    provider: 'fortnox',
    base_url: 'https://api.fortnox.se/3',
    auth_methods: ['bearer', 'basic', 'api_key'],
    common_endpoints: [
      '/customers',
      '/invoices',
      '/articles',
      '/orders',
      '/supplierinvoices',
      '/vouchers',
      '/financialyears'
    ],
    common_headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  },
  {
    provider: 'personalkollen',
    base_url: 'https://api.personalkollen.se',
    auth_methods: ['bearer', 'api_key'],
    common_endpoints: [
      '/employees',
      '/shifts',
      '/departments',
      '/costcenters',
      '/absences',
      '/salaries'
    ],
    common_headers: {
      'Content-Type': 'application/json'
    }
  },
  {
    provider: 'swess',
    base_url: 'https://api.swess.se',
    auth_methods: ['bearer', 'basic'],
    common_endpoints: [
      '/v1/orders',
      '/v1/products',
      '/v1/customers',
      '/v1/stock',
      '/v1/sales'
    ],
    common_headers: {
      'Content-Type': 'application/json'
    }
  },
  {
    provider: 'inzii',
    base_url: 'https://api.inzii.com',
    auth_methods: ['bearer', 'api_key'],
    common_endpoints: [
      '/api/v1/transactions',
      '/api/v1/products',
      '/api/v1/customers',
      '/api/v1/employees'
    ],
    common_headers: {
      'Content-Type': 'application/json'
    }
  },
  {
    provider: 'visma',
    base_url: 'https://eaccountingapi.vismaonline.com/v2',
    auth_methods: ['bearer', 'oauth2'],
    common_endpoints: [
      '/customers',
      '/suppliers',
      '/articles',
      '/invoices',
      '/vouchers'
    ],
    common_headers: {
      'Content-Type': 'application/json'
    }
  }
]

// HTTP client with timeout and error handling
async function makeRequest(
  url: string,
  method: string = 'GET',
  headers: Record<string, string> = {},
  body?: any,
  timeoutMs: number = 10000
): Promise<{
  status: number
  headers: Record<string, string>
  body: any
  responseTime: number
  error?: string
}> {
  const startTime = Date.now()
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    const options: RequestInit = {
      method,
      headers,
      signal: controller.signal,
      redirect: 'follow'
    }
    
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body)
    }
    
    const response = await fetch(url, options)
    clearTimeout(timeoutId)
    
    const responseTime = Date.now() - startTime
    
    // Try to parse response as JSON, fall back to text
    let responseBody
    const contentType = response.headers.get('content-type') || ''
    
    if (contentType.includes('application/json')) {
      try {
        responseBody = await response.json()
      } catch {
        responseBody = await response.text()
      }
    } else {
      responseBody = await response.text()
    }
    
    // Convert headers to plain object
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    
    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
      responseTime,
      error: response.ok ? undefined : `HTTP ${response.status}`
    }
  } catch (error: any) {
    const responseTime = Date.now() - startTime
    return {
      status: 0,
      headers: {},
      body: null,
      responseTime,
      error: error.message || 'Request failed'
    }
  }
}

// Generate auth headers based on auth type and credentials
function generateAuthHeaders(
  authType: string,
  credentials: any
): Record<string, string> {
  const headers: Record<string, string> = {}
  
  switch (authType) {
    case 'bearer':
      if (credentials.bearer_token) {
        headers['Authorization'] = `Bearer ${credentials.bearer_token}`
      }
      break
      
    case 'basic':
      if (credentials.username && credentials.password) {
        const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
        headers['Authorization'] = `Basic ${auth}`
      }
      break
      
    case 'api_key':
      if (credentials.api_key) {
        // Try different API key header formats
        headers['X-API-Key'] = credentials.api_key
        headers['API-Key'] = credentials.api_key
        headers['X-API-KEY'] = credentials.api_key
      }
      break
      
    case 'api_key_query':
      // This will be handled in URL construction
      break
      
    case 'oauth2':
      if (credentials.bearer_token) {
        headers['Authorization'] = `Bearer ${credentials.bearer_token}`
      }
      break
  }
  
  return headers
}

// Probe a single endpoint with different auth methods
async function probeEndpoint(
  providerConfig: APIProviderConfig,
  endpoint: string,
  credentials: any
): Promise<APIProbeResult[]> {
  const results: APIProbeResult[] = []
  const fullUrl = `${providerConfig.base_url}${endpoint}`
  
  // Test different HTTP methods
  const methods = ['GET', 'POST', 'PUT', 'DELETE']
  
  for (const method of methods) {
    // Skip POST/PUT/DELETE for discovery phase to avoid modifying data
    if (method !== 'GET' && providerConfig.provider !== 'test') {
      continue
    }
    
    // Test different auth types
    for (const authType of providerConfig.auth_methods) {
      const headers = {
        ...providerConfig.common_headers,
        ...generateAuthHeaders(authType, credentials)
      }
      
      // For API key in query param
      let url = fullUrl
      if (authType === 'api_key_query' && credentials.api_key) {
        url += `${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(credentials.api_key)}`
      }
      
      // Make the request
      const startTime = Date.now()
      const response = await makeRequest(url, method, headers)
      const responseTime = Date.now() - startTime
      
      results.push({
        provider: providerConfig.provider,
        endpoint,
        method,
        auth_type: authType,
        headers,
        status_code: response.status,
        response_headers: response.headers,
        response_body: response.body,
        response_time_ms: responseTime,
        error: response.error,
        success: response.status >= 200 && response.status < 300
      })
      
      // Be nice to the API - small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  
  return results
}

// Main function to probe APIs
export async function probeAPIs(
  provider?: string,
  credentials?: any
): Promise<{
  results: APIProbeResult[]
  analysis: APIProbeAnalysis[]
}> {
  const db = createAdminClient()
  const allResults: APIProbeResult[] = []
  const allAnalysis: APIProbeAnalysis[] = []
  
  // Get credentials from database if not provided
  let apiCredentials = credentials
  if (!apiCredentials) {
    const { data: storedCreds } = await db
      .from('api_credentials')
      .select('provider, credentials')
      .eq('status', 'active')
    
    if (storedCreds) {
      apiCredentials = storedCreds.reduce((acc: any, cred: any) => {
        acc[cred.provider] = cred.credentials
        return acc
      }, {})
    }
  }
  
  // Determine which providers to probe
  const providersToProbe = provider 
    ? COMMON_PROVIDERS.filter(p => p.provider === provider)
    : COMMON_PROVIDERS
  
  for (const providerConfig of providersToProbe) {
    console.log(`Probing ${providerConfig.provider} API...`)
    
    const providerCreds = apiCredentials?.[providerConfig.provider] || {}
    const providerResults: APIProbeResult[] = []
    
    // Probe each endpoint
    for (const endpoint of providerConfig.common_endpoints) {
      const endpointResults = await probeEndpoint(providerConfig, endpoint, providerCreds)
      providerResults.push(...endpointResults)
    }
    
    allResults.push(...providerResults)
    
    // Analyze results with Claude
    const analysis = await analyzeProbeResults(providerConfig.provider, providerResults)
    allAnalysis.push(analysis)
    
    // Store results in database
    await storeProbeResults(providerConfig.provider, providerResults, analysis)
  }
  
  return {
    results: allResults,
    analysis: allAnalysis
  }
}

// Analyze probe results with Claude
async function analyzeProbeResults(
  provider: string,
  results: APIProbeResult[]
): Promise<APIProbeAnalysis> {
  // Filter to successful requests for pattern analysis
  const successfulResults = results.filter(r => r.success && r.status_code === 200)
  const allResults = results
  
  // Prepare prompt for Claude
  const prompt = `
You are an API analysis expert. Analyze these API probe results for ${provider} and identify:

1. Working endpoints and their authentication patterns
2. Data structure of successful responses
3. Rate limiting patterns (from headers)
4. Recommendations for integration

API Probe Results:
${JSON.stringify(allResults.slice(0, 20), null, 2)}  // Limit to first 20 for token management

Successful Responses (200 OK):
${JSON.stringify(successfulResults.slice(0, 10), null, 2)}

Please provide a structured analysis with:
1. Working endpoints with their methods and auth types
2. Authentication patterns that work
3. Rate limit detection
4. Data schema inference
5. Integration recommendations
`

  try {
    const response = await anthropic.messages.create({
      // Route through AI_MODELS — the old CLAUDE_3_5_SONNET symbol never existed
      // on AI_MODELS (it's not in lib/ai/models.ts) so this was a silent ReferenceError
      // at runtime. Analysis is the right tier for deep API reasoning.
      model:      AI_MODELS.ANALYSIS,
      max_tokens: MAX_TOKENS.ASSISTANT,
      messages:   [{ role: 'user', content: prompt }]
    })
    
    // Parse Claude's response (simplified - in reality you'd want more structured parsing)
    const analysisText = response.content[0].text
    
    // Extract structured information from Claude's response
    // This is a simplified version - you'd want more sophisticated parsing
    const workingEndpointsMatch = analysisText.match(/Working endpoints:(.*?)(?=Auth patterns:|$)/s)
    const authPatternsMatch = analysisText.match(/Auth patterns:(.*?)(?=Rate limits:|$)/s)
    const recommendationsMatch = analysisText.match(/Recommendations:(.*?)$/s)
    
    return {
      provider,
      working_endpoints: extractWorkingEndpoints(analysisText, successfulResults),
      auth_patterns: extractAuthPatterns(analysisText, allResults),
      rate_limits: extractRateLimits(allResults),
      data_schema: extractDataSchema(successfulResults),
      recommendations: extractRecommendations(analysisText)
    }
  } catch (error) {
    console.error('Claude analysis failed:', error)
    
    // Fallback analysis
    return {
      provider,
      working_endpoints: successfulResults.map(r => ({
        endpoint: r.endpoint,
        method: r.method,
        auth_type: r.auth_type,
        status_code: r.status_code,
        response_pattern: 'success',
        data_structure: typeof r.response_body === 'object' ? r.response_body : undefined
      })),
      auth_patterns: analyzeAuthPatterns(allResults),
      rate_limits: extractRateLimits(allResults),
      recommendations: [
        {
          priority: 'medium',
          action: 'Review API documentation for proper authentication',
          expected_impact: 'Improve success rate of API calls'
        }
      ]
    }
  }
}

// Helper functions for analysis
function extractWorkingEndpoints(analysisText: string, results: APIProbeResult[]): any[] {
  // Simplified extraction - in reality you'd parse Claude's structured response
  const successful = results.filter(r => r.success)
  return successful.map(r => ({
    endpoint: r.endpoint,
    method: r.method,
    auth_type: r.auth_type,
    status_code: r.status_code,
    response_pattern: 'success',
    data_structure: typeof r.response_body === 'object' ? r.response_body : undefined
  }))
}

function extractAuthPatterns(analysisText: string, results: APIProbeResult[]): any[] {
  const patterns: any[] = []
  const authTypes = ['bearer', 'basic', 'api_key', 'oauth2']
  
  for (const authType of authTypes) {
    const authResults = results.filter(r => r.auth_type === authType)
    if (authResults.length > 0) {
      const successCount = authResults.filter(r => r.success).length
      patterns.push({
        auth_type: authType,
        success_rate: authResults.length > 0 ? (successCount / authResults.length) * 100 : 0,
        headers_pattern: 'Authorization header'
      })
    }
  }
  
  return patterns
}

function analyzeAuthPatterns(results: APIProbeResult[]): any[] {
  return extractAuthPatterns('', results)
}

function extractRateLimits(results: APIProbeResult[]): any {
  const rateLimitHeaders = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']
  const hasRateLimit = results.some(r => 
    Object.keys(r.response_headers).some(h => 
      rateLimitHeaders.includes(h.toLowerCase())
    )
  )
  
  if (hasRateLimit) {
    return {
      detected: true,
      limit_header: 'x-ratelimit-limit',
      remaining_header: 'x-ratelimit-remaining',
      reset_header: 'x-ratelimit-reset'
    }
  }
  
  return { detected: false }
}

function extractDataSchema(results: APIProbeResult[]): any {
  const successful = results.filter(r => r.success && r.status_code === 200)
  const schemas: Record<string, any> = {}
  const allFields = new Set<string>()
  const dataTypes: Record<string, string> = {}
  
  for (const result of successful) {
    if (typeof result.response_body === 'object' && result.response_body !== null) {
      schemas[result.endpoint] = result.response_body
      
      // Extract fields
      const fields = Object.keys(result.response_body)
      fields.forEach(field => allFields.add(field))
      
      // Infer data types
      for (const [field, value] of Object.entries(result.response_body)) {
        const type = typeof value
        if (!dataTypes[field] || dataTypes[field] === 'unknown') {
          dataTypes[field] = type
        } else if (dataTypes[field] !== type) {
          dataTypes[field] = 'mixed'
        }
      }
    }
  }
  
  return {
    endpoints: schemas,
    common_fields: Array.from(allFields),
    data_types: dataTypes
  }
}

function extractRecommendations(analysisText: string): Array<{
  priority: 'high' | 'medium' | 'low'
  action: string
  expected_impact: string
}> {
  // Simplified extraction - parse recommendations from Claude's response
  const recommendations: Array<{
    priority: 'high' | 'medium' | 'low'
    action: string
    expected_impact: string
  }> = []
  
  // Look for recommendation patterns
  const recommendationLines = analysisText.split('\n').filter(line => 
    line.includes('recommend') || line.includes('suggest') || line.includes('should')
  )
  
  for (const line of recommendationLines.slice(0, 5)) {
    let priority: 'high' | 'medium' | 'low' = 'medium'
    if (line.toLowerCase().includes('high priority') || line.includes('critical')) {
      priority = 'high'
    } else if (line.toLowerCase().includes('low priority')) {
      priority = 'low'
    }
    
    recommendations.push({
      priority,
      action: line.trim(),
      expected_impact: 'Improve API integration success'
    })
  }
  
  // Add default recommendations if none found
  if (recommendations.length === 0) {
    recommendations.push(
      {
        priority: 'high',
        action: 'Verify API credentials are correct and have proper permissions',
        expected_impact: 'Increase success rate of API calls'
      },
      {
        priority: 'medium',
        action: 'Check API documentation for correct endpoint URLs and parameters',
        expected_impact: 'Ensure proper endpoint discovery'
      },
      {
        priority: 'low',
        action: 'Implement retry logic for rate-limited endpoints',
        expected_impact: 'Improve reliability under load'
      }
    )
  }
  
  return recommendations
}

// Store probe results in database
async function storeProbeResults(
  provider: string,
  results: APIProbeResult[],
  analysis: APIProbeAnalysis
): Promise<void> {
  const db = createAdminClient()
  
  try {
    // Store raw results
    await db.from('api_probe_results').insert({
      provider,
      probe_date: new Date().toISOString(),
      results: results,
      analysis: analysis,
      summary: {
        total_requests: results.length,
        successful_requests: results.filter(r => r.success).length,
        success_rate: results.length > 0 ? (results.filter(r => r.success).length / results.length) * 100 : 0,
        average_response_time: results.reduce((sum, r) => sum + r.response_time_ms, 0) / results.length
      }
    })
    
    // Update API credentials with discovered patterns
    const workingAuth = analysis.auth_patterns
      .filter(p => p.success_rate > 50)
      .map(p => p.auth_type)
    
    if (workingAuth.length > 0) {
      await db.from('api_credentials')
        .update({
          discovered_auth_patterns: workingAuth,
          last_probe_date: new Date().toISOString(),
          probe_status: 'success'
        })
        .eq('provider', provider)
    }
    
    console.log(`Stored ${results.length} probe results for ${provider}`)
  } catch (error) {
    console.error(`Failed to store probe results for ${provider}:`, error)
  }
}

// Test function for manual testing
export async function testProbe(provider: string, testCredentials: any): Promise<APIProbeResult[]> {
  const providerConfig = COMMON_PROVIDERS.find(p => p.provider === provider)
  if (!providerConfig) {
    throw new Error(`Provider ${provider} not found`)
  }
  
  const results: APIProbeResult[] = []
  
  // Test just a couple of endpoints for quick testing
  const testEndpoints = providerConfig.common_endpoints.slice(0, 2)
  
  for (const endpoint of testEndpoints) {
    const endpointResults = await probeEndpoint(providerConfig, endpoint, testCredentials)
    results.push(...endpointResults)
  }
  
  return results
}

// Get probe history
export async function getProbeHistory(provider?: string, limit: number = 10): Promise<any[]> {
  const db = createAdminClient()
  
  let query = db.from('api_probe_results')
    .select('*')
    .order('probe_date', { ascending: false })
    .limit(limit)
  
  if (provider) {
    query = query.eq('provider', provider)
  }
  
  const { data } = await query
  return data || []
}

// Get working endpoints summary
export async function getWorkingEndpoints(provider?: string): Promise<any> {
  const db = createAdminClient()
  
  let query = db.from('api_probe_results')
    .select('provider, analysis')
    .order('probe_date', { ascending: false })
  
  if (provider) {
    query = query.eq('provider', provider)
  }
  
  const { data } = await query
  
  if (!data || data.length === 0) {
    return {}
  }
  
  // Get the latest analysis for each provider
  const latestByProvider: Record<string, any> = {}
  for (const result of data) {
    if (!latestByProvider[result.provider]) {
      latestByProvider[result.provider] = result.analysis
    }
  }
  
  return latestByProvider
}
