# Customer Health Scoring Agent

## Agent Overview
**Priority**: 1 (High)  
**Target Audience**: Admin/Internal  
**Business Value**: Proactive customer success, identify at-risk accounts  
**AI Model**: Claude Haiku 4.5  
**Frequency**: Weekly (Monday 08:00 UTC)  
**Estimated Cost**: ~$0.25 per run

## Purpose
Automatically score customer health based on usage patterns, data completeness, and engagement metrics. This agent helps identify at-risk customers before they churn and enables proactive customer success interventions.

## Business Context
Restaurant owners using CommandCenter have varying levels of engagement and data completeness. Some actively use all features while others may struggle with setup or underutilize the platform. This agent provides:
- Early warning system for potential churn
- Insights into feature adoption gaps
- Data-driven customer success prioritization
- Retention risk predictions

## Data Sources
1. **Usage Logs** (`feature_usage` table - to be created)
   - Feature adoption rates
   - Page views and session duration
   - Last active date

2. **Integration Status** (`integrations` table)
   - Number of connected integrations
   - Sync success rates
   - Last successful sync timestamp

3. **Data Completeness** (derived from existing tables)
   - Revenue data coverage (days with data / total days)
   - Staff data coverage
   - Product/menu data availability

4. **Support Interactions** (`support_tickets` table - to be created)
   - Number of open tickets
   - Average resolution time
   - Ticket severity distribution

5. **Subscription & Billing** (`organisations` + Stripe)
   - Plan type (Starter, Pro, Group)
   - Payment status
   - Subscription age

## Scoring Algorithm
### Health Score Components (0-100)
1. **Usage Score** (30 points)
   - Active days in last 30 days: 15 points
   - Feature adoption rate: 10 points  
   - Session duration: 5 points

2. **Data Quality Score** (30 points)
   - Integration connectivity: 10 points
   - Data completeness: 15 points
   - Sync reliability: 5 points

3. **Engagement Score** (20 points)
   - Support ticket response time: 10 points
   - Feedback provided: 5 points
   - Onboarding completion: 5 points

4. **Business Value Score** (20 points)
   - Data volume (transactions/month): 10 points
   - Platform dependency: 5 points
   - Growth trajectory: 5 points

### Risk Factors
- **Critical Risk**: Score < 40, >30 days inactive, no integrations
- **High Risk**: Score 40-59, declining usage, sync failures
- **Medium Risk**: Score 60-79, partial feature adoption
- **Low Risk**: Score 80-100, active usage, complete data

## Output Structure
```typescript
interface CustomerHealthScore {
  org_id: string;
  business_id?: string;
  scored_at: Date;
  overall_score: number; // 0-100
  
  // Component scores
  usage_score: number;
  data_quality_score: number;
  engagement_score: number;
  business_value_score: number;
  
  // Risk assessment
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  risk_factors: string[]; // e.g., ["30+ days inactive", "No POS integration"]
  
  // Recommendations
  recommendations: {
    priority: 'high' | 'medium' | 'low';
    action: string;
    expected_impact: string;
  }[];
  
  // Trends
  score_trend: 'improving' | 'stable' | 'declining';
  previous_score?: number;
  days_since_last_improvement: number;
}
```

## Database Schema
```sql
-- Table: customer_health_scores
CREATE TABLE IF NOT EXISTS customer_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  
  -- Scores
  overall_score INTEGER NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  usage_score INTEGER NOT NULL,
  data_quality_score INTEGER NOT NULL,
  engagement_score INTEGER NOT NULL,
  business_value_score INTEGER NOT NULL,
  
  -- Risk assessment
  risk_level TEXT NOT NULL CHECK (risk_level IN ('critical', 'high', 'medium', 'low')),
  risk_factors JSONB DEFAULT '[]',
  
  -- Recommendations (AI-generated)
  recommendations JSONB DEFAULT '[]',
  
  -- Metadata
  score_trend TEXT NOT NULL CHECK (score_trend IN ('improving', 'stable', 'declining')),
  previous_score INTEGER,
  days_since_last_improvement INTEGER DEFAULT 0,
  
  -- Timestamps
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Indexes for performance
  UNIQUE(org_id, business_id, scored_at),
  INDEX idx_health_scores_org (org_id),
  INDEX idx_health_scores_risk (risk_level),
  INDEX idx_health_scores_date (scored_at DESC)
);

-- Table: feature_usage (if not exists)
CREATE TABLE IF NOT EXISTS feature_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  feature_name TEXT NOT NULL,
  action TEXT NOT NULL, -- 'view', 'click', 'use', 'configure'
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  INDEX idx_feature_usage_org (org_id),
  INDEX idx_feature_usage_feature (feature_name),
  INDEX idx_feature_usage_date (created_at DESC)
);
```

## AI Prompt Template
```text
You are a customer success analyst for CommandCenter, an AI-powered business intelligence platform for Swedish restaurants.

ANALYZE THIS CUSTOMER'S HEALTH:

Organization: {org_name}
Plan: {plan_type}
Subscription Age: {subscription_days} days
Customer Since: {created_at}

USAGE DATA (last 30 days):
- Active days: {active_days}/30
- Features used: {features_used}/{total_features}
- Average session duration: {avg_session_minutes} minutes
- Last active: {last_active_days_ago} days ago

INTEGRATION STATUS:
- Connected integrations: {connected_integrations}/{available_integrations}
- Sync success rate: {sync_success_rate}%
- Last successful sync: {last_sync_days_ago} days ago
- Data coverage: {data_coverage_percentage}% of expected days

SUPPORT INTERACTIONS:
- Open tickets: {open_tickets}
- Average resolution time: {avg_resolution_hours} hours
- Last ticket: {last_ticket_days_ago} days ago

SCORING INSTRUCTIONS:
1. Calculate overall health score (0-100) based on:
   - Usage (30 points): Activity frequency and depth
   - Data Quality (30 points): Integration health and completeness
   - Engagement (20 points): Support interactions and feedback
   - Business Value (20 points): Data volume and growth potential

2. Determine risk level:
   - Critical: <40, inactive, no integrations
   - High: 40-59, declining usage, sync issues
   - Medium: 60-79, partial adoption
   - Low: 80-100, active with complete data

3. Identify top 3 risk factors

4. Provide 2-3 actionable recommendations

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
}
```

## Implementation Files

### 1. API Route: `app/api/cron/customer-health-scoring/route.ts`
```typescript
// @ts-nocheck
// /api/cron/customer-health-scoring - Weekly customer health analysis
// Runs: Monday 08:00 UTC

import { NextRequest, NextResponse } from 'next/server'
import { analyzeCustomerHealth } from '@/lib/agents/customer-health-scoring'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // 2 minutes for processing all customers

export async function POST(req: NextRequest) {
  // Authorization
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const orgId = req.nextUrl.searchParams.get('org_id') // Optional: specific org
    const results = await analyzeCustomerHealth(orgId)
    
    return NextResponse.json({
      ok: true,
      orgs_analyzed: results.length,
      results,
      timestamp: new Date().toISOString()
    })
  } catch (error: any) {
    console.error('Customer health scoring failed:', error)
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}
```

### 2. Core Logic: `lib/agents/customer-health-scoring.ts`
```typescript
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
  
  // Implementation details would go here
  // This would query all the data sources mentioned above
  
  return {
    // Mock data structure
    usage: { active_days: 15, features_used: 8, avg_session_minutes: 12 },
    integrations: { connected: 2, total: 5, sync_success_rate: 95 },
    support: { open_tickets: 1, avg_resolution_hours: 24 },
    // ... more data
  }
}

function buildHealthAnalysisPrompt(org: any, data: any): string {
  // Build the prompt from template above
  return `You are a customer success analyst...` // Full prompt from template
}

async function saveHealthScore(analysis: CustomerHealthAnalysis) {
  const db = createAdminClient()
  
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
}
```

### 3. Test Script: `scripts/test-customer-health-scoring.ts`
```typescript
// scripts/test-customer-health-scoring.ts
// Test script for Customer Health Scoring Agent

import { analyzeCustomerHealth } from '../lib/agents/customer-health-scoring'

async function runTest() {
  console.log('🧪 Testing Customer Health Scoring Agent\n')
  
  try {
    // Test with a specific org or all orgs
    const results = await analyzeCustomerHealth() // Pass org ID for specific test
    
    console.log(`✅ Analysis complete for ${results.length} organizations`)
    
    results.forEach((result, i) => {
      console.log(`\n--- Organization ${i + 1} ---`)
      console.log(`Score: ${result.overall_score}/100 (${result.risk_level} risk)`)
      console.log(`Risk factors: ${result.risk_factors.join(', ')}`)
      console.log(`Recommendations:`)
      result.recommendations.forEach(rec => {
        console.log(`  ${rec.priority.toUpperCase()}: ${rec.action}`)
      })
    })
    
    console.log('\n🎯 Test Summary:')
    console.log(`- Average score: ${results.reduce((s, r) => s + r.overall_score, 0) / results.length}`)
    console.log(`- Critical risk: ${results.filter(r => r.risk_level === 'critical').length}`)
    console.log(`- High risk: ${results.filter(r => r.risk_level === 'high').length}`)
    console.log(`- Medium risk: ${results.filter(r => r.risk_level === 'medium').length}`)
    console.log(`- Low risk: ${results.filter(r => r.risk_level === 'low').length}`)
    
  } catch (error) {
    console.error('❌ Test failed:', error)
  }
}

runTest()
```

## Admin Panel Integration
Add to `app/admin/page.tsx`:
```typescript
// In the header buttons section:
<a href="/admin/customer-health" style={{ padding: '8px 16px', background: '#10b981', color: 'white', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
  Customer Health
</a>
```

Create `app/admin/customer-health/page.tsx`:
- Dashboard showing all organizations by health score
- Risk level filtering
- Trend charts
- Export functionality for customer success team

## Deployment Checklist
- [ ] Create database tables (SQL in MIGRATIONS.md)
- [ ] Implement `lib/agents/customer-health-scoring.ts`
- [ ] Create `app/api/cron/customer-health-scoring/route.ts`
- [ ] Add cron schedule to `vercel.json`
- [ ] Create test script
- [ ] Build admin panel page
- [ ] Test with sample data
- [ ] Deploy to Vercel
- [ ] Monitor first weekly run

## Success Metrics
- Health scores generated for 100% of active organizations
- Risk predictions with 80%+ accuracy
- Reduced churn rate by 15% through proactive interventions
- Customer success team adoption rate > 90%

## Notes for Claude Deployment
1. This agent follows the same pattern as existing agents (anomaly detection, etc.)
2. Use existing Supabase client patterns for data access
3. Follow the same error handling and logging patterns
4. Integrate with existing admin authentication
5. Add to the agent status dashboard in admin panel