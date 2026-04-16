# Menu Performance Optimizer Agent

## Agent Overview
**Priority**: 2 (High)  
**Target Audience**: Restaurant Owners/Customers  
**Business Value**: Increase profitability through menu optimization  
**AI Model**: Claude Sonnet 4-6  
**Frequency**: Weekly (Sunday 20:00 UTC)  
**Estimated Cost**: ~$1.50 per run per restaurant

## Purpose
Analyze POS data to identify best/worst performing menu items, provide actionable insights for menu optimization, and suggest pricing adjustments to maximize profitability.

## Business Context
Restaurant profitability heavily depends on menu performance. Typical challenges:
- 20-30% of menu items generate 70-80% of revenue
- Poorly performing items tie up inventory and kitchen capacity
- Suboptimal pricing leaves money on the table
- Seasonal trends are often missed without data analysis

This agent helps restaurant owners:
- Identify star products and underperformers
- Optimize pricing based on demand elasticity
- Reduce food waste by focusing on popular items
- Increase average check size through smart upselling

## Data Sources
1. **POS Sales Data** (`revenue_logs` + `inzii_products` tables)
   - Item-level sales volume and revenue
   - Time of day/day of week patterns
   - Combo/upsell patterns
   - Returns and modifications

2. **Cost Data** (`product_costs` table - to be created)
   - Ingredient costs per menu item
   - Preparation time/labor cost
   - Waste and spoilage rates

3. **Customer Feedback** (if available)
   - Review mentions of specific dishes
   - Social media sentiment
   - Direct customer feedback

4. **Seasonal & External Factors**
   - Weather data (temperature, precipitation)
   - Local events and holidays
   - Competitor menu changes

## Analysis Framework

### 1. Menu Item Classification (BCG Matrix)
- **Stars**: High growth, high market share - invest
- **Cash Cows**: Low growth, high market share - maintain
- **Question Marks**: High growth, low market share - evaluate
- **Dogs**: Low growth, low market share - eliminate/revamp

### 2. Profitability Metrics
- **Gross Profit Margin**: (Selling Price - Food Cost) / Selling Price
- **Contribution Margin**: Revenue - Variable Costs
- **Profit per Serving**: Net profit per unit sold
- **Turnover Rate**: Sales volume relative to inventory

### 3. Demand Analysis
- **Price Elasticity**: How demand changes with price
- **Cross-Elasticity**: How items affect each other's sales
- **Seasonality**: Weekly, monthly, seasonal patterns
- **Daypart Performance**: Breakfast vs lunch vs dinner

## Output Structure
```typescript
interface MenuPerformanceAnalysis {
  restaurant_id: string;
  analyzed_period: {
    start_date: string;
    end_date: string;
    total_days: number;
  };
  
  // Overall metrics
  total_revenue: number;
  total_items_sold: number;
  average_profit_margin: number;
  menu_coverage_index: number; // How well menu items cover costs
  
  // Item-level analysis
  items: Array<{
    item_id: string;
    item_name: string;
    category: string;
    
    // Sales metrics
    units_sold: number;
    revenue: number;
    average_selling_price: number;
    
    // Cost metrics
    food_cost: number;
    labor_cost: number;
    total_cost: number;
    
    // Profit metrics
    gross_profit: number;
    profit_margin: number; // percentage
    profit_per_serving: number;
    
    // Classification
    classification: 'star' | 'cash_cow' | 'question_mark' | 'dog';
    recommendation: 'increase_price' | 'decrease_price' | 'promote' | 'reformulate' | 'remove';
    
    // Trends
    trend: 'growing' | 'stable' | 'declining';
    week_over_week_growth: number;
    
    // Insights
    best_selling_times: string[]; // e.g., ["Friday dinner", "Sunday brunch"]
    common_modifications: string[];
    suggested_price_adjustment?: number; // percentage
  }>;
  
  // Category analysis
  categories: Array<{
    category_name: string;
    revenue_share: number;
    profit_share: number;
    average_margin: number;
    recommendation: string;
  }>;
  
  // Actionable recommendations
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    action: string;
    expected_impact: string;
    implementation_difficulty: 'easy' | 'medium' | 'hard';
    timeline: 'immediate' | '1_week' | '1_month';
  }>;
  
  // Pricing opportunities
  pricing_opportunities: {
    under_priced_items: Array<{item_name: string; current_price: number; suggested_price: number; expected_impact: string}>;
    over_priced_items: Array<{item_name: string; current_price: number; suggested_price: number; expected_impact: string}>;
    bundle_opportunities: Array<{combo_name: string; items: string[]; suggested_price: number; expected_margin: number}>;
  };
}
```

## Database Schema
```sql
-- Table: menu_performance_insights
CREATE TABLE IF NOT EXISTS menu_performance_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  
  -- Analysis period
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  
  -- Overall metrics
  total_revenue DECIMAL(10,2) NOT NULL,
  total_items_sold INTEGER NOT NULL,
  average_profit_margin DECIMAL(5,2) NOT NULL,
  menu_coverage_index DECIMAL(5,2) NOT NULL,
  
  -- Item analysis (stored as JSON for flexibility)
  items_analysis JSONB NOT NULL DEFAULT '[]',
  categories_analysis JSONB NOT NULL DEFAULT '[]',
  
  -- Recommendations
  recommendations JSONB NOT NULL DEFAULT '[]',
  pricing_opportunities JSONB NOT NULL DEFAULT '{}',
  
  -- Metadata
  items_analyzed INTEGER NOT NULL,
  analysis_version TEXT NOT NULL DEFAULT '1.0',
  
  -- Timestamps
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Indexes
  UNIQUE(org_id, business_id, period_start, period_end),
  INDEX idx_menu_insights_business (business_id),
  INDEX idx_menu_insights_date (period_start DESC)
);

-- Table: product_costs (if not exists)
CREATE TABLE IF NOT EXISTS product_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL, -- References Inzii product ID
  product_name TEXT NOT NULL,
  
  -- Cost components
  ingredient_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  packaging_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  labor_minutes DECIMAL(5,2) NOT NULL DEFAULT 0, -- Prep + cook time
  waste_percentage DECIMAL(5,2) NOT NULL DEFAULT 0, -- Expected waste
  
  -- Calculated fields
  total_cost DECIMAL(10,2) GENERATED ALWAYS AS (
    (ingredient_cost + packaging_cost) * (1 + waste_percentage / 100)
  ) STORED,
  
  -- Metadata
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Constraints
  UNIQUE(org_id, business_id, product_id),
  INDEX idx_product_costs_business (business_id),
  INDEX idx_product_costs_active (is_active)
);
```

## AI Prompt Template
```text
You are a restaurant menu optimization expert analyzing POS data for a Swedish restaurant.

RESTAURANT CONTEXT:
- Name: {restaurant_name}
- Cuisine: {cuisine_type}
- Price Point: {price_point} (budget/mid-range/premium)
- Location: {location_type} (city center/suburb/tourist area)

ANALYSIS PERIOD: {start_date} to {end_date} ({total_days} days)

SALES SUMMARY:
- Total Revenue: {total_revenue} SEK
- Total Items Sold: {total_items}
- Average Transaction Value: {avg_transaction} SEK
- Busiest Day: {busiest_day} ({busiest_day_revenue} SEK)
- Slowest Day: {slowest_day} ({slowest_day_revenue} SEK)

TOP 10 MENU ITEMS (by revenue):
{top_items_table}

COST DATA AVAILABLE: {has_cost_data ? "Yes" : "No"}
- Items with cost data: {items_with_costs}/{total_items}
- Average Food Cost Percentage: {avg_food_cost_pct}%

ANALYSIS INSTRUCTIONS:

1. CLASSIFY EACH ITEM using BCG Matrix:
   - Stars: High growth, high market share
   - Cash Cows: Low growth, high market share  
   - Question Marks: High growth, low market share
   - Dogs: Low growth, low market share

2. CALCULATE PROFITABILITY for each item (if cost data available):
   - Gross Profit Margin = (Price - Total Cost) / Price
   - Contribution Margin = Revenue - Variable Costs
   - Rank items by profit per serving

3. IDENTIFY PRICING OPPORTUNITIES:
   - Items priced below market rate (increase price)
   - Items with low demand elasticity (safe to increase)
   - Items that could be bundled
   - Seasonal pricing adjustments

4. PROVIDE ACTIONABLE RECOMMENDATIONS:
   - Which items to promote/feature
   - Which items to reformulate/improve
   - Which items to consider removing
   - Pricing adjustments with expected impact
   - Menu restructuring suggestions

5. CONSIDER SWEDISH RESTAURANT CONTEXT:
   - Swedish dining preferences and seasons
   - Local competitor pricing
   - Seasonal ingredient availability
   - Swedish holiday/event patterns

RESPONSE FORMAT (JSON only):
{
  "restaurant_id": "{restaurant_id}",
  "analyzed_period": {
    "start_date": "{start_date}",
    "end_date": "{end_date}",
    "total_days": {total_days}
  },
  "total_revenue": {total_revenue},
  "total_items_sold": {total_items_sold},
  "average_profit_margin": {avg_margin},
  "menu_coverage_index": {coverage_index},
  
  "items": [
    {
      "item_id": "prod_123",
      "item_name": "Swedish Meatballs",
      "category": "Mains",
      "units_sold": 150,
      "revenue": 22500,
      "average_selling_price": 150,
      "food_cost": 45,
      "labor_cost": 20,
      "total_cost": 65,
      "gross_profit": 85,
      "profit_margin": 56.7,
      "profit_per_serving": 85,
      "classification": "star",
      "recommendation": "increase_price",
      "trend": "growing",
      "week_over_week_growth": 12.5,
      "best_selling_times": ["Friday dinner", "Sunday lunch"],
      "common_modifications": ["Extra gravy", "No lingonberries"],
      "suggested_price_adjustment": 10
    }
    // ... more items
  ],
  
  "categories": [
    {
      "category_name": "Starters",
      "revenue_share": 15.2,
      "profit_share": 18.5,
      "average_margin": 65.3,
      "recommendation": "Add 1-2 premium starters to increase check average"
    }
    // ... more categories
  ],
  
  "recommendations": [
    {
      "priority": "high",
      "action": "Increase price of Swedish Meatballs by 10% (150 SEK → 165 SEK)",
      "expected_impact": "Increase weekly profit by 1,275 SEK with minimal sales impact",
      "implementation_difficulty": "easy",
      "timeline": "immediate"
    },
    {
      "priority": "medium",
      "action": "Create 'Traditional Swedish Dinner' bundle: Meatballs + Pickled Herring + Dessert",
      "expected_impact": "Increase average check by 75 SEK, improve margin to 68%",
      "implementation_difficulty": "medium",
      "timeline": "1_week"
    }
    // ... more recommendations
  ],
  
  "pricing_opportunities": {
    "under_priced_items": [
      {
        "item_name": "Gravlax Plate",
        "current_price": 185,
        "suggested_price": 210,
        "expected_impact": "+13.5% margin, +2,500 SEK weekly revenue"
      }
    ],
    "over_priced_items": [
      {
        "item_name": "Truffle Fries",
        "current_price": 95,
        "suggested_price": 85,
        "expected_impact": "+22% volume, net +1,800 SEK weekly profit"
      }
    ],
    "bundle_opportunities": [
      {
        "combo_name": "Weekend Family Feast",
        "items": ["Meatballs", "Mashed Potatoes", "Salad", "Apple Pie"],
        "suggested_price": 495,
        "expected_margin": 62.5
      }
    ]
  }
}
```

## Implementation Files

### 1. API Route: `app/api/cron/menu-performance-optimizer/route.ts`
```typescript
// @ts-nocheck
// /api/cron/menu-performance-optimizer - Weekly menu analysis
// Runs: Sunday 20:00 UTC

import { NextRequest, NextResponse } from 'next/server'
import { analyzeMenuPerformance } from '@/lib/agents/menu-performance-optimizer'

export const dynamic = 'force-dynamic'
export const maxDuration = 180 // 3 minutes for complex analysis

export async function POST(req: NextRequest) {
  // Authorization
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const businessId = req.nextUrl.searchParams.get('business_id') // Optional
    const results = await analyzeMenuPerformance(businessId)
    
    return NextResponse.json({
      ok: true,
      restaurants_analyzed: results.length,
      results,
      timestamp: new Date().toISOString()
    })
  } catch (error: any) {
    console.error('Menu performance optimization failed:', error)
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}
```

### 2. Core Logic: `lib/agents/menu-performance-optimizer.ts`
```typescript
// lib/agents/menu-performance-optimizer.ts
// Core logic for menu performance analysis

import { createAdminClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { AI_MODELS } from '@/lib/ai/models'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export interface MenuPerformanceAnalysis {
  // ... interface from above
}

export async function analyzeMenuPerformance(specificBusinessId?: string): Promise<MenuPerformanceAnalysis[]> {
  const db = createAdminClient()
  const results: MenuPerformanceAnalysis[] = []
  
  // Get restaurants with POS data
  let query = db.from('businesses')
    .select('id, name, cuisine_type, location_type')
    .not('inzii_integration_id', 'is', null) // Has POS integration
  
  if (specificBusinessId) {
    query = query.eq('id', specificBusinessId)
  }
  
  const { data: businesses } = await query
  
  if (!businesses || businesses.length === 0) {
    return results
  }
  
  // Process each restaurant
  for (const business of businesses) {
    try {
      // Gather sales data for last 28 days
      const salesData = await gatherSalesData(business.id)
      const costData = await gatherCostData(business.id)
      
      // Prepare comprehensive prompt
      const prompt = buildMenuAnalysisPrompt(business, salesData, costData)
      
      // Call Claude (Sonnet for complex analysis)
      const response = await anthropic.messages.create({
        model: AI_MODELS.COMPLEX_AGENT, // Sonnet 4-6
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      })
      
      // Parse response
      const content = response.content[0]
      if (content.type !== 'text') {
        throw new Error('Claude returned non-text response')
      }
      
      const analysis = JSON.parse(content.text) as MenuPerformanceAnalysis
      analysis.restaurant_id = business.id
      
      // Save to database
      await saveMenuAnalysis(analysis)
      
      results.push(analysis)
      
    } catch (error) {
      console.error(`Failed to analyze menu for business ${business.id}:`, error)
      // Continue with other businesses
    }
  }
  
  return results
}

async function gatherSalesData(businessId: string) {
  const db = createAdminClient()
  const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
  
  // Query POS sales data
  // This would join revenue_logs with inzii_products
  // Return structured sales data
  
  return {
    // Mock structure
    period: { start