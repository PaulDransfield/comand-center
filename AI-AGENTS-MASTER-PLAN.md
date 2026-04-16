# CommandCenter AI Agents Master Plan

## Overview
This document outlines the comprehensive plan for building 10 new AI agents for CommandCenter, targeting both admin/internal use and customer/restaurant owner needs. The agents will be built following existing patterns and documented for Claude deployment.

## Project Context
- **Platform**: CommandCenter - AI-powered business intelligence for Swedish restaurants
- **Tech Stack**: Next.js 14, Supabase PostgreSQL, Anthropic Claude, Stripe, Vercel
- **Existing Agents**: 6 agents already built (anomaly detection, forecast calibration, scheduling optimization, etc.)
- **Vercel Project ID**: `prj_m5hdZ9kjsD9XdQ6baX5YDxnz1LWv`

## The 10 New AI Agents

### 1. Customer Health Scoring Agent (Admin)
**Purpose**: Automatically score customer health based on usage patterns, data completeness, and engagement
**Target**: Admin/internal use
**Business Value**: Proactive customer success, identify at-risk accounts
**Data Sources**: Usage logs, integration status, feature adoption, support tickets
**Output**: Health score (0-100), risk factors, retention predictions
**Frequency**: Weekly analysis (Monday 08:00 UTC)
**AI Model**: Claude Haiku 4.5
**Storage**: `customer_health_scores` table

### 2. Integration Quality Monitor (Admin)
**Purpose**: Monitor data quality from connected integrations (Fortnox, Personalkollen, Inzii)
**Target**: Admin/internal use
**Business Value**: Ensure reliable data pipelines, identify integration issues
**Data Sources**: Sync logs, data completeness metrics, error rates
**Output**: Data completeness scores, sync success rates, field mapping accuracy
**Frequency**: Daily monitoring (06:00 UTC)
**AI Model**: Claude Haiku 4.5 (minimal AI needed)
**Storage**: `integration_quality_metrics` table

### 3. Usage Pattern Analyzer (Admin)
**Purpose**: Analyze how customers use the platform to identify feature gaps
**Target**: Admin/internal use
**Business Value**: Product development insights, feature prioritization
**Data Sources**: Feature usage logs, page views, user interactions
**Output**: Feature adoption rates, unused capabilities, user journey patterns
**Frequency**: Monthly analysis (1st of month, 09:00 UTC)
**AI Model**: Claude Sonnet 4-6 (complex pattern analysis)
**Storage**: `usage_pattern_insights` table

### 4. Support Ticket Triage Agent (Admin)
**Purpose**: Analyze incoming support requests and categorize/triage automatically
**Target**: Admin/internal use
**Business Value**: Faster support response, identify common issues
**Data Sources**: Support ticket content, customer metadata, historical resolutions
**Output**: Categorized tickets, suggested responses, priority levels
**Frequency**: Real-time as tickets arrive
**AI Model**: Claude Haiku 4.5
**Storage**: `ticket_triage_results` table

### 5. Menu Performance Optimizer (Customer)
**Purpose**: Analyze POS data to identify best/worst performing menu items
**Target**: Restaurant owners/customers
**Business Value**: Increase profitability through menu optimization
**Data Sources**: Inzii/Swess POS data, product sales, cost data
**Output**: Menu item profitability, seasonal trends, substitution recommendations
**Frequency**: Weekly analysis (Sunday 20:00 UTC)
**AI Model**: Claude Sonnet 4-6 (complex profitability analysis)
**Storage**: `menu_performance_insights` table

### 6. Staff Performance Coach (Customer)
**Purpose**: Provide personalized feedback to staff based on performance metrics
**Target**: Restaurant owners/customers
**Business Value**: Improve staff productivity and retention
**Data Sources**: Personalkollen staff data, sales per shift, customer feedback
**Output**: Individual performance reports, improvement suggestions, training recommendations
**Frequency**: Bi-weekly for each staff member (Monday & Thursday 07:00 UTC)
**AI Model**: Claude Haiku 4.5
**Storage**: `staff_performance_reports` table

### 7. Supplier Negotiation Assistant (Customer)
**Purpose**: Analyze purchase patterns and suggest negotiation strategies with suppliers
**Target**: Restaurant owners/customers
**Business Value**: Reduce food costs through better supplier deals
**Data Sources**: Fortnox supplier invoices, purchase history, market prices
**Output**: Price comparison data, negotiation talking points, contract review
**Frequency**: Quarterly before supplier negotiations (1st of quarter, 10:00 UTC)
**AI Model**: Claude Sonnet 4-6 (complex negotiation analysis)
**Storage**: `supplier_negotiation_insights` table

### 8. Compliance & Regulation Monitor (Customer)
**Purpose**: Monitor for regulatory changes affecting Swedish restaurants
**Target**: Restaurant owners/customers
**Business Value**: Avoid fines, stay compliant with Swedish regulations
**Data Sources**: Regulatory databases, government publications, industry news
**Output**: Compliance checklists, regulation updates, required action items
**Frequency**: Monthly monitoring (15th of month, 11:00 UTC)
**AI Model**: Claude Haiku 4.5
**Storage**: `compliance_updates` table

### 9. Energy & Sustainability Optimizer (Customer)
**Purpose**: Analyze utility costs and suggest sustainability improvements
**Target**: Restaurant owners/customers
**Business Value**: Reduce operational costs, improve sustainability credentials
**Data Sources**: Utility bills, energy consumption data, sustainability metrics
**Output**: Energy usage patterns, cost-saving recommendations, sustainability score
**Frequency**: Monthly analysis (5th of month, 12:00 UTC)
**AI Model**: Claude Haiku 4.5
**Storage**: `sustainability_insights` table

### 10. Customer Experience Analyzer (Customer)
**Purpose**: Analyze customer feedback and transaction data to improve experience
**Target**: Restaurant owners/customers
**Business Value**: Increase customer satisfaction and repeat business
**Data Sources**: Transaction data, customer feedback (if collected), review sites
**Output**: Customer sentiment analysis, service bottlenecks, improvement areas
**Frequency**: Weekly analysis (Saturday 18:00 UTC)
**AI Model**: Claude Sonnet 4-6 (sentiment analysis)
**Storage**: `customer_experience_insights` table

## Technical Implementation Plan

### File Structure
```
comand-center/
├── app/
│   ├── api/
│   │   └── cron/
│   │       ├── customer-health-scoring/
│   │       │   └── route.ts
│   │       ├── integration-quality-monitor/
│   │       │   └── route.ts
│   │       ├── usage-pattern-analyzer/
│   │       │   └── route.ts
│   │       ├── support-ticket-triage/
│   │       │   └── route.ts
│   │       ├── menu-performance-optimizer/
│   │       │   └── route.ts
│   │       ├── staff-performance-coach/
│   │       │   └── route.ts
│   │       ├── supplier-negotiation-assistant/
│   │       │   └── route.ts
│   │       ├── compliance-regulation-monitor/
│   │       │   └── route.ts
│   │       ├── energy-sustainability-optimizer/
│   │       │   └── route.ts
│   │       └── customer-experience-analyzer/
│   │           └── route.ts
├── lib/
│   └── agents/
│       ├── customer-health-scoring.ts
│       ├── integration-quality-monitor.ts
│       ├── usage-pattern-analyzer.ts
│       ├── support-ticket-triage.ts
│       ├── menu-performance-optimizer.ts
│       ├── staff-performance-coach.ts
│       ├── supplier-negotiation-assistant.ts
│       ├── compliance-regulation-monitor.ts
│       ├── energy-sustainability-optimizer.ts
│       └── customer-experience-analyzer.ts
├── scripts/
│   ├── test-customer-health-scoring.ts
│   ├── test-integration-quality-monitor.ts
│   ├── test-usage-pattern-analyzer.ts
│   ├── test-support-ticket-triage.ts
│   ├── test-menu-performance-optimizer.ts
│   ├── test-staff-performance-coach.ts
│   ├── test-supplier-negotiation-assistant.ts
│   ├── test-compliance-regulation-monitor.ts
│   ├── test-energy-sustainability-optimizer.ts
│   └── test-customer-experience-analyzer.ts
└── docs/
    ├── AGENT-CUSTOMER-HEALTH-SCORING.md
    ├── AGENT-INTEGRATION-QUALITY-MONITOR.md
    ├── AGENT-USAGE-PATTERN-ANALYZER.md
    ├── AGENT-SUPPORT-TICKET-TRIAGE.md
    ├── AGENT-MENU-PERFORMANCE-OPTIMIZER.md
    ├── AGENT-STAFF-PERFORMANCE-COACH.md
    ├── AGENT-SUPPLIER-NEGOTIATION-ASSISTANT.md
    ├── AGENT-COMPLIANCE-REGULATION-MONITOR.md
    ├── AGENT-ENERGY-SUSTAINABILITY-OPTIMIZER.md
    └── AGENT-CUSTOMER-EXPERIENCE-ANALYZER.md
```

### Database Tables Required
Each agent will need its own table for storing results:
1. `customer_health_scores` - Weekly health scores per organization
2. `integration_quality_metrics` - Daily quality metrics per integration
3. `usage_pattern_insights` - Monthly usage insights
4. `ticket_triage_results` - Real-time ticket analysis
5. `menu_performance_insights` - Weekly menu item analysis
6. `staff_performance_reports` - Bi-weekly staff reports
7. `supplier_negotiation_insights` - Quarterly supplier analysis
8. `compliance_updates` - Monthly regulatory updates
9. `sustainability_insights` - Monthly sustainability analysis
10. `customer_experience_insights` - Weekly customer experience analysis

### Vercel Cron Configuration
Add to `vercel.json`:
```json
{
  "crons": [
    // Existing cron jobs...
    {
      "path": "/api/cron/customer-health-scoring",
      "schedule": "0 8 * * 1"
    },
    {
      "path": "/api/cron/integration-quality-monitor",
      "schedule": "0 6 * * *"
    },
    {
      "path": "/api/cron/usage-pattern-analyzer",
      "schedule": "0 9 1 * *"
    },
    {
      "path": "/api/cron/menu-performance-optimizer",
      "schedule": "0 20 * * 0"
    },
    {
      "path": "/api/cron/staff-performance-coach",
      "schedule": "0 7 * * 1,4"
    },
    {
      "path": "/api/cron/supplier-negotiation-assistant",
      "schedule": "0 10 1 */3 *"
    },
    {
      "path": "/api/cron/compliance-regulation-monitor",
      "schedule": "0 11 15 * *"
    },
    {
      "path": "/api/cron/energy-sustainability-optimizer",
      "schedule": "0 12 5 * *"
    },
    {
      "path": "/api/cron/customer-experience-analyzer",
      "schedule": "0 18 * * 6"
    }
  ]
}
```

### Environment Variables Required
```
# For new agents
ANTHROPIC_API_KEY=sk-ant-...  # Already exists
CRON_SECRET=...               # Already exists
SUPABASE_SERVICE_ROLE_KEY=... # Already exists

# Optional for specific agents
REGULATORY_API_KEY=...        # For compliance monitor
ENERGY_DATA_API_KEY=...       # For sustainability optimizer
```

### Cost Estimates
- **Haiku-based agents** (7 agents): ~$0.25 per run × 7 = $1.75 per run
- **Sonnet-based agents** (3 agents): ~$1.50 per run × 3 = $4.50 per run
- **Monthly estimate** (assuming all run as scheduled): ~$50-75 for 50 customers

### Implementation Priority Order
1. Customer Health Scoring Agent (high business value, admin)
2. Menu Performance Optimizer (high business value, customer)
3. Integration Quality Monitor (critical for reliability)
4. Staff Performance Coach (addresses major pain point)
5. Usage Pattern Analyzer (product insights)
6. Customer Experience Analyzer (customer retention)
7. Supplier Negotiation Assistant (cost savings)
8. Support Ticket Triage Agent (operational efficiency)
9. Compliance & Regulation Monitor (risk mitigation)
10. Energy & Sustainability Optimizer (cost savings + branding)

### Testing Strategy
1. Unit tests for each agent's core logic
2. Integration tests with sample data
3. End-to-end tests simulating full agent runs
4. Performance tests for scale (100+ customers)

### Monitoring & Alerting
1. Success/failure logging for each agent run
2. Performance metrics (execution time, API costs)
3. Alerting for failed agent runs
4. Dashboard for agent status in admin panel

## Deployment Instructions for Claude
1. Review this master plan and individual agent specifications
2. Create database tables using SQL in Supabase
3. Implement agents following existing patterns in codebase
4. Update `vercel.json` with cron schedules
5. Test each agent with sample data
6. Deploy to Vercel project `prj_m5hdZ9kjsD9XdQ6baX5YDxnz1LWv`
7. Monitor initial runs and adjust as needed

## Success Metrics
1. All 10 agents running successfully on schedule
2. No critical errors in agent execution
3. Positive customer feedback on agent insights
4. Reduced support tickets through proactive monitoring
5. Measurable business impact (cost savings, revenue increase)

---

*This document will be updated as agents are implemented and deployed.*