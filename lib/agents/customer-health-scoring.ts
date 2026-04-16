// @ts-nocheck
// lib/agents/customer-health-scoring.ts
// Core logic for customer health scoring

import { createAdminClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { AI_MODELS } from '@/lib/ai/models'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export interface CustomerHealthAnalysis {
  org_id: string
  business_id?: string
  overall_score: number
  usage_score: number
  data_quality_score: number
  engagement_score: number
  business_value_score: number
  risk_level: 'critical' | 'high' | 'medium' | 'low'
  risk_factors: string[]
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low'
    action: string
    expected_impact: string
  }>
  score_trend: 'improving' | 'stable' | 'declining'
  previous_score?: number
  days_since_last_improvement: number
}

export async function analyzeCustomerHealth(specificOrgId?: string): Promise<CustomerHealthAnalysis[]> {
  const db = createAdminClient()
  const results: CustomerHealthAnalysis[] = []
  
  // Get all active organizations
  let query = db.from('organisations').select('id, name, created_at, plan_type')
  if (specificOrgId) {
    query = query.eq('id', specificOrgId)
  }
  
  const { data: orgs } = await query
  
  if (!orgs || orgs.length === 0) {
    return results
  }
  
  // Process each organization
  for (const org of orgs) {
    try {
      // Gather data for this org
      const orgData = await gatherOrgData(org.id)
      
      // Prepare prompt for Claude
      const prompt = buildHealthAnalysisPrompt(org, orgData)
      
      // Call Claude
      const response = await anthropic.messages.create({
        model: AI_MODELS.AGENT, // Haiku 4.5
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      })
      
      // Parse response
      const content = response.content[0]
      if (content.type !== 'text') {
        throw new Error('Claude returned non-text response')
      }
      
      const analysis = JSON.parse(content.text) as CustomerHealthAnalysis
      analysis.org_id = org.id
      
      // Save to database
      await saveHealthScore(analysis)
      
      results.push(analysis)
      
    } catch (error) {
      console.error(`Failed to analyze org ${org.id}:`, error)
      // Continue with other orgs
    }
  }
  
  return results
}

async function gatherOrgData(orgId: string) {
  const db = createAdminClient()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  
  // Get organization details
  const { data: org } = await db
    .from('organisations')
    .select('name, created_at, plan_type')
    .eq('id', orgId)
    .single()
  
  // Get businesses for this org
  const { data: businesses } = await db
    .from('businesses')
    .select('id, name')
    .eq('org_id', orgId)
  
  // Get integrations status
  const { data: integrations } = await db
    .from('integrations')
    .select('provider, status, last_sync_at')
    .eq('org_id', orgId)
  
  // Get recent usage data (simplified - would need actual usage tracking)
  const { data: recentLogins } = await db
    .from('auth.sessions')
    .select('created_at')
    .eq('user_id', (await db.auth.getUser()).data.user?.id) // Simplified
    .gte('created_at', thirtyDaysAgo.toISOString())
  
  // Get support tickets if table exists
  let supportTickets = []
  try {
    const { data: tickets } = await db
      .from('support_tickets')
      .select('status, created_at, resolved_at')
      .eq('org_id', orgId)
      .gte('created_at', thirtyDaysAgo.toISOString())
    supportTickets = tickets || []
  } catch (error) {
    // Table might not exist yet
    console.log('Support tickets table not found')
  }
  
  // Calculate metrics
  const activeDays = new Set(recentLogins?.map(l => new Date(l.created_at).toDateString())).size
  const connectedIntegrations = integrations?.filter(i => i.status === 'connected').length || 0
  const totalIntegrations = integrations?.length || 0
  const openTickets = supportTickets.filter(t => t.status !== 'resolved').length
  const resolvedTickets = supportTickets.filter(t => t.status === 'resolved').length
  const avgResolutionHours = resolvedTickets > 0 ? 
    supportTickets
      .filter(t => t.resolved_at && t.created_at)
      .map(t => {
        const created = new Date(t.created_at)
        const resolved = new Date(t.resolved_at!)
        return (resolved.getTime() - created.getTime()) / (1000 * 60 * 60)
      })
      .reduce((a, b) => a + b, 0) / resolvedTickets : 0
  
  return {
    org: {
      name: org?.name || 'Unknown',
      created_at: org?.created_at || new Date().toISOString(),
      plan_type: org?.plan_type || 'starter',
      subscription_days: org?.created_at ? 
        Math.floor((Date.now() - new Date(org.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 0
    },
    usage: {
      active_days: activeDays,
      total_businesses: businesses?.length || 0,
      last_active_days_ago: recentLogins && recentLogins.length > 0 ? 
        Math.floor((Date.now() - new Date(recentLogins[0].created_at).getTime()) / (1000 * 60 * 60 * 24)) : 30
    },
    integrations: {
      connected: connectedIntegrations,
      total: totalIntegrations,
      sync_success_rate: integrations && integrations.length > 0 ? 
        (integrations.filter(i => i.last_sync_at && 
          new Date(i.last_sync_at).getTime() > Date.now() - 24 * 60 * 60 * 1000).length / integrations.length) * 100 : 0
    },
    support: {
      open_tickets: openTickets,
      resolved_tickets: resolvedTickets,
      avg_resolution_hours: avgResolutionHours,
      last_ticket_days_ago: supportTickets.length > 0 ? 
        Math.floor((Date.now() - new Date(supportTickets[0].created_at).getTime()) / (1000 * 60 * 60 * 24)) : 30
    }
  }
}

function buildHealthAnalysisPrompt(org: any, data: any): string {
  return `You are a customer success analyst for CommandCenter, an AI-powered business intelligence platform for Swedish restaurants.

ANALYZE THIS CUSTOMER'S HEALTH:

Organization: ${data.org.name}
Plan: ${data.org.plan_type}
Subscription Age: ${data.org.subscription_days} days
Customer Since: ${new Date(data.org.created_at).toLocaleDateString('sv-SE')}

USAGE DATA (last 30 days):
- Active days: ${data.usage.active_days}/30
- Businesses managed: ${data.usage.total_businesses}
- Last active: ${data.usage.last_active_days_ago} days ago

INTEGRATION STATUS:
- Connected integrations: ${data.integrations.connected}/${data.integrations.total}
- Sync success rate: ${data.integrations.sync_success_rate.toFixed(1)}%
- Last sync check: Within 24 hours for ${Math.round(data.integrations.sync_success_rate)}% of integrations

SUPPORT INTERACTIONS:
- Open tickets: ${data.support.open_tickets}
- Resolved tickets: ${data.support.resolved_tickets}
- Average resolution time: ${data.support.avg_resolution_hours.toFixed(1)} hours
- Last ticket: ${data.support.last_ticket_days_ago} days ago

SCORING INSTRUCTIONS:
1. Calculate overall health score (0-100) based on:
   - Usage (30 points): Activity frequency and business setup
   - Data Quality (30 points): Integration health and data completeness
   - Engagement (20 points): Support interactions and responsiveness
   - Business Value (20 points): Platform adoption and growth potential

2. Determine risk level:
   - Critical: <40, >14 days inactive, no integrations
   - High: 40-59, declining usage, sync issues
   - Medium: 60-79, partial adoption, some engagement
   - Low: 80-100, active with complete data setup

3. Identify top 3 risk factors

4. Provide 2-3 actionable recommendations

5. Determine trend based on previous data (assume stable if no previous data)

RESPONSE FORMAT (JSON only):
{
  "overall_score": 85,
  "usage_score": 25,
  "data_quality_score": 28,
  "engagement_score": 18,
  "business_value_score": 14,
  "risk_level": "medium",
  "risk_factors": ["Only using 2/5 available features", "No POS integration connected"],
  "recommendations": [
    {
      "priority": "high",
      "action": "Schedule onboarding call to connect Inzii POS",
      "expected_impact": "Increase data completeness from 60% to 95%"
    },
    {
      "priority": "medium", 
      "action": "Send feature highlight email about staff scheduling",
      "expected_impact": "Improve usage score by 10 points"
    }
  ],
  "score_trend": "stable",
  "previous_score": 83,
  "days_since_last_improvement": 14
}`
}

async function saveHealthScore(analysis: CustomerHealthAnalysis) {
  const db = createAdminClient()
  
  // Check for previous score to calculate trend
  const { data: previousScores } = await db
    .from('customer_health_scores')
    .select('overall_score, scored_at')
    .eq('org_id', analysis.org_id)
    .order('scored_at', { ascending: false })
    .limit(1)
  
  const previousScore = previousScores && previousScores.length > 0 ? previousScores[0].overall_score : undefined
  
  // Calculate trend
  let scoreTrend: 'improving' | 'stable' | 'declining' = 'stable'
  if (previousScore !== undefined) {
    if (analysis.overall_score > previousScore + 5) {
      scoreTrend = 'improving'
    } else if (analysis.overall_score < previousScore - 5) {
      scoreTrend = 'declining'
    }
  }
  
  // Calculate days since last improvement
  let daysSinceLastImprovement = 0
  if (scoreTrend === 'improving') {
    daysSinceLastImprovement = 0
  } else if (previousScores && previousScores.length > 0) {
    const lastImprovement = previousScores.find(s => s.overall_score > (previousScore || 0))
    if (lastImprovement) {
      daysSinceLastImprovement = Math.floor((Date.now() - new Date(lastImprovement.scored_at).getTime()) / (1000 * 60 * 60 * 24))
    }
  }
  
  // Update analysis with calculated values
  analysis.score_trend = scoreTrend
  analysis.previous_score = previousScore
  analysis.days_since_last_improvement = daysSinceLastImprovement
  
  // Save to database
  await db.from('customer_health_scores').insert({
    org_id: analysis.org_id,
    business_id: analysis.business_id,
    overall_score: analysis.overall_score,
    usage_score: analysis.usage_score,
    data_quality_score: analysis.data_quality_score,
    engagement_score: analysis.engagement_score,
    business_value_score: analysis.business_value_score,
    risk_level: analysis.risk_level,
    risk_factors: analysis.risk_factors,
    recommendations: analysis.recommendations,
    score_trend: analysis.score_trend,
    previous_score: analysis.previous_score,
    days_since_last_improvement: analysis.days_since_last_improvement,
    scored_at: new Date().toISOString(),
  })
  
  console.log(`Saved health score for org ${analysis.org_id}: ${analysis.overall_score}/100 (${analysis.risk_level} risk)`)
}
