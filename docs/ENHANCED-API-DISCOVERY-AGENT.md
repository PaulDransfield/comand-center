# Enhanced API Schema Discovery Agent

## Overview

The Enhanced API Schema Discovery Agent is an AI-powered system that automatically analyzes new API integrations (POS systems, staffing software, accounting systems) and provides comprehensive mapping recommendations for CommandCenter. It addresses the challenge of mapping diverse API data structures to a unified schema.

## Key Features

### 1. **Generic API Analysis**
- Works with any POS/staffing/accounting system (not just Fortnox/Personalkollen)
- Automatically determines provider type (POS, staffing, accounting, inventory, other)
- Handles Swedish business context and data formats

### 2. **Intelligent Field Mapping**
- Maps API fields to appropriate CommandCenter tables
- Provides confidence scores for each mapping
- Identifies required transformations (date formats, currency conversion, Swedish text)

### 3. **Unused Data Identification**
- Identifies valuable data fields not currently mapped
- Assesses business value (high/medium/low)
- Evaluates implementation effort (low/medium/high)
- Suggests actions: map now, future feature, or ignore

### 4. **Business Insights Generation**
- Provides actionable insights for restaurant owners
- Identifies impact areas: revenue, costs, efficiency, compliance, customer experience
- Prioritizes implementation based on business value

### 5. **Implementation Recommendations**
- Optimal sync frequency (daily, weekly, monthly, realtime)
- Rate limit handling strategies
- Error handling approaches
- Data retention policies
- Estimated monthly data volume

### 6. **Code Generation**
- Generates sync configuration snippets
- Provides transformation functions
- Creates validation rules

## Architecture

```
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────┐
│  API Discovery  │    │  Enhanced Analyzer   │    │  Claude AI      │
│  Cron Endpoint  │───▶│  (TypeScript/Node)  │───▶│  (Haiku 4.5)    │
└─────────────────┘    └──────────────────────┘    └─────────────────┘
         │                        │                         │
         │                        │                         │
         ▼                        ▼                         ▼
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────┐
│  Supabase DB    │    │  Implementation      │    │  Analysis       │
│  (Store Results)│    │  Plan Generator      │    │  Results        │
└─────────────────┘    └──────────────────────┘    └─────────────────┘
```

## Supported Providers

### POS Systems
- iZettle, Lightspeed, Visma Retail, Bokio Retail
- Fortnox Retail, Swess, Inzii, Unicenta, Square

### Staffing Systems
- Personalkollen, Visma Lön, Bokio Lön
- Fortnox Lön, TimeCare, Planful

### Accounting Systems
- Fortnox, Visma, Bokio, QuickBooks, Xero

### Inventory Systems
- Lightspeed Inventory, Visma Lager, Fortnox Lager

## Database Schema

The agent stores results in two main tables:

### `api_discoveries_enhanced`
```sql
CREATE TABLE api_discoveries_enhanced (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id),
  org_id UUID REFERENCES organisations(id),
  business_id UUID REFERENCES businesses(id),
  provider TEXT,
  provider_type TEXT,
  analysis_result JSONB,  -- Full EnhancedAnalysisResult
  confidence_score INTEGER,
  data_type TEXT,
  unused_fields_count INTEGER,
  business_insights_count INTEGER,
  discovered_at TIMESTAMPTZ DEFAULT now()
);
```

### `implementation_plans`
```sql
CREATE TABLE implementation_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id),
  org_id UUID REFERENCES organisations(id),
  provider TEXT,
  phase1_tasks TEXT[],
  phase2_tasks TEXT[],
  phase3_tasks TEXT[],
  estimated_timeline TEXT,
  generated_at TIMESTAMPTZ DEFAULT now()
);
```

## Usage

### 1. Manual Trigger
```bash
curl -X POST "http://localhost:3000/api/cron/api-discovery-enhanced" \
  -H "Authorization: Bearer your-cron-secret"
```

### 2. Scheduled Cron (Vercel)
Add to `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/cron/api-discovery-enhanced",
      "schedule": "0 2 * * 0"  # Weekly on Sunday at 02:00
    }
  ]
}
```

### 3. Retrieve Results
```bash
# Get all recent discoveries
curl "http://localhost:3000/api/cron/api-discovery-enhanced"

# Get discoveries for specific integration
curl "http://localhost:3000/api/cron/api-discovery-enhanced?integration_id=uuid-here"
```

## Test Script

Run the test script to see the agent in action:
```bash
cd C:\Users\Chicce\Desktop\comand-center
node scripts/test-enhanced-discovery.js
```

The test demonstrates analysis of:
1. iZettle POS transaction data
2. Personalkollen staff shift data
3. Fortnox invoice data

## Integration with Existing System

The enhanced agent complements the existing API discovery system:

### Current System (`/api/cron/api-discovery`)
- Basic field mapping for known providers (Fortnox, Personalkollen, Swess/Inzii)
- Simple confidence scoring
- Weekly schedule

### Enhanced System (`/api/cron/api-discovery-enhanced`)
- Comprehensive analysis for any provider
- Unused data identification
- Business insights generation
- Implementation planning
- Monthly schedule (more intensive analysis)

## Business Value

### For Restaurant Owners
- **Faster Integration**: New APIs mapped automatically in minutes vs. manual days
- **Better Insights**: Identifies valuable data that would otherwise be ignored
- **Actionable Recommendations**: Clear implementation priorities

### For Development Team
- **Reduced Manual Work**: Automates tedious mapping tasks
- **Consistent Quality**: AI ensures consistent mapping logic
- **Scalable**: Handles new providers without code changes

### For CommandCenter Platform
- **Competitive Advantage**: Faster onboarding of new customers
- **Data Completeness**: Utilizes more API data for better insights
- **Customer Satisfaction**: Provides immediate value from connected systems

## Cost Considerations

- Uses Claude Haiku 4.5 model (cost-effective at ~$0.25 per analysis)
- Each analysis uses ~500-1000 tokens
- Monthly cost for 50 customers: ~$12.50
- Runs weekly for new integrations, monthly for existing

## Implementation Phases

### Phase 1 (Week 1-2)
1. Deploy enhanced analyzer library
2. Create database tables
3. Set up cron endpoint
4. Test with sample data

### Phase 2 (Week 3-4)
1. Integrate with admin panel
2. Add visualization of discovery results
3. Implement automatic sync configuration generation
4. Add email notifications for high-value discoveries

### Phase 3 (Week 5-6)
1. Implement suggested transformations automatically
2. Add A/B testing for mapping accuracy
3. Create feedback loop to improve AI prompts
4. Add support for real-time webhook discovery

## Monitoring and Maintenance

### Key Metrics to Track
- **Accuracy**: Compare AI mappings with manual validations
- **Completion Rate**: % of integrations successfully analyzed
- **Business Value**: # of high-value unused fields identified
- **Implementation Rate**: % of recommendations implemented

### Alerting
- Email alerts for analysis failures
- Slack notifications for high-confidence discoveries
- Weekly summary report of discoveries and implementations

## Future Enhancements

### Short-term (Q2 2026)
- Multi-endpoint analysis for complex APIs
- Swedish language support for field descriptions
- Integration with existing sync engine

### Medium-term (Q3 2026)
- Machine learning model trained on past mappings
- Automatic code generation for sync adapters
- Real-time analysis during API connection setup

### Long-term (Q4 2026)
- Predictive analytics for data quality issues
- Automated testing of generated sync configurations
- Integration marketplace with pre-built mappings

## Troubleshooting

### Common Issues

1. **No Sample Data Available**
   - Ensure integration has synced at least once
   - Check `sync_logs` table for recent successful syncs
   - Manually trigger a sync before discovery

2. **Low Confidence Scores**
   - Provide more sample data (5-10 items)
   - Include API documentation in analysis request
   - Specify provider type explicitly

3. **Analysis Timeouts**
   - Reduce sample data size
   - Increase `maxDuration` in route configuration
   - Process fewer integrations per run

### Debugging
```bash
# Check logs
tail -f logs/api-discovery.log

# Test with specific integration
curl -X POST "http://localhost:3000/api/cron/api-discovery-enhanced" \
  -H "Authorization: Bearer your-cron-secret" \
  -H "Content-Type: application/json" \
  -d '{"integration_ids": ["uuid-here"]}'
```

## Conclusion

The Enhanced API Schema Discovery Agent transforms the challenge of integrating diverse restaurant systems from a manual, error-prone process into an automated, intelligent system. By leveraging AI to understand API data structures and provide actionable recommendations, CommandCenter can onboard new customers faster and extract more value from their existing systems.

The agent represents a significant competitive advantage in the restaurant business intelligence market, where data integration complexity is a major barrier to adoption.