# Enhanced API Schema Discovery Agent - Deployment Guide

## 🚀 Production Deployment Checklist

### 1. Environment Variables Required

Add these to your Vercel project environment variables:

```bash
# Required for Enhanced API Discovery Agent
ANTHROPIC_API_KEY=your_anthropic_api_key_here  # Claude Haiku 4.5
CRON_SECRET=your_secure_cron_secret_here       # For cron job authentication

# Already existing in your project:
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### 2. Vercel Cron Configuration (Already Updated)

Your `vercel.json` now includes:

```json
{
  "crons": [
    {
      "path": "/api/cron/api-discovery",
      "schedule": "0 2 * * 0"  // Weekly on Sunday at 02:00
    },
    {
      "path": "/api/cron/api-discovery-enhanced",
      "schedule": "0 3 * * 0"  // Weekly on Sunday at 03:00
    }
  ]
}
```

### 3. Database Tables (Already Created)

You've already created these tables:

```sql
-- Enhanced discoveries table
CREATE TABLE api_discoveries_enhanced (...);

-- Implementation plans table  
CREATE TABLE implementation_plans (...);
```

### 4. Deployment Steps

#### Step 1: Push to GitHub
```bash
git add .
git commit -m "feat: Enhanced API Schema Discovery Agent with AI-powered analysis"
git push origin main
```

#### Step 2: Vercel Auto-Deploy
- Vercel will automatically deploy from GitHub
- Environment variables will be loaded from Vercel dashboard
- Cron jobs will be registered automatically

#### Step 3: Verify Deployment
1. **Check Vercel Dashboard**: Ensure deployment succeeded
2. **Verify Environment Variables**: Confirm ANTHROPIC_API_KEY and CRON_SECRET are set
3. **Test Cron Jobs**: Manually trigger to verify

### 5. Manual Testing After Deployment

#### Test 1: Manual Cron Trigger
```bash
# Using curl or Postman
curl -X POST "https://your-domain.vercel.app/api/cron/api-discovery-enhanced" \
  -H "Authorization: Bearer your_cron_secret"
```

#### Test 2: Access Admin Panel
Navigate to: `https://your-domain.vercel.app/admin/api-discoveries-enhanced`

#### Test 3: Test with Sample Data
```bash
# Run the test script locally to verify AI analysis works
npx tsx scripts/test-enhanced-discovery.ts
```

### 6. Monitoring Setup

#### Vercel Logs
- Check Vercel dashboard → Functions → Logs
- Monitor `/api/cron/api-discovery-enhanced` executions

#### Success Metrics to Track
1. **Execution Success Rate**: % of cron runs that complete successfully
2. **Analysis Confidence**: Average confidence score of discoveries
3. **Unused Fields Found**: Number of high-value unused fields identified
4. **Implementation Rate**: % of phase 1 tasks implemented

### 7. Cost Management

#### Claude API Costs
- **Model**: Claude Haiku 4.5 (most cost-effective)
- **Cost**: ~$0.25 per analysis
- **Monthly Estimate**: 
  - 50 customers: ~$12.50/month
  - 100 customers: ~$25/month
  - 200 customers: ~$50/month

#### Optimization Tips
1. **Cache Results**: Store analysis for 30 days before re-analyzing
2. **Batch Processing**: Analyze multiple integrations in single AI call
3. **Sample Size**: Use 3-5 sample items instead of full dataset

### 8. Troubleshooting

#### Common Issues & Solutions

**Issue 1: "ANTHROPIC_API_KEY not set"**
```bash
# Solution: Add to Vercel environment variables
ANTHROPIC_API_KEY=sk-ant-...
```

**Issue 2: Cron job returns 401 Unauthorized**
```bash
# Solution: Ensure CRON_SECRET matches in both:
# 1. Vercel environment variables
# 2. Authorization header in cron request
```

**Issue 3: Database tables not found**
```sql
-- Solution: Run the SQL from docs/ENHANCED-API-DISCOVERY-AGENT.md
CREATE TABLE api_discoveries_enhanced (...);
CREATE TABLE implementation_plans (...);
```

**Issue 4: AI analysis timeout (10+ minutes)**
```typescript
// Solution: Reduce sample data size in enhanced-analyzer.ts
const sample_data = request.sample_data.slice(0, 3); // Use only 3 items
```

### 9. Rollback Plan

If issues occur after deployment:

#### Step 1: Disable Cron Jobs
Temporarily remove from `vercel.json`:
```json
// Comment out or remove the new cron jobs
```

#### Step 2: Revert Code
```bash
git revert HEAD  # Revert the last commit
git push origin main
```

#### Step 3: Monitor Existing Functionality
Ensure original API discovery agent still works at `/admin/api-discoveries`

### 10. Post-Deployment Validation

#### Day 1 Checklist
- [ ] Cron jobs registered in Vercel dashboard
- [ ] Environment variables verified
- [ ] Admin panel accessible at `/admin/api-discoveries-enhanced`
- [ ] Manual cron trigger successful
- [ ] Database tables accessible

#### Week 1 Checklist  
- [ ] First automated cron execution successful
- [ ] Discoveries appearing in admin panel
- [ ] AI analysis confidence scores > 70%
- [ ] Unused fields identified for existing integrations
- [ ] No performance issues reported

#### Month 1 Checklist
- [ ] All active integrations analyzed
- [ ] High-value unused fields implemented
- [ ] Customer feedback on new insights
- [ ] Cost within expected range ($10-20/month)

### 11. Performance Optimization

#### For High Volume (100+ customers)
1. **Increase concurrency limit** in Vercel settings
2. **Implement request queuing** for batch processing
3. **Cache AI responses** for similar API structures
4. **Use streaming responses** for large analyses

#### Database Optimization
```sql
-- Add indexes for common queries
CREATE INDEX idx_discoveries_integration ON api_discoveries_enhanced(integration_id);
CREATE INDEX idx_discoveries_confidence ON api_discoveries_enhanced(confidence_score);
CREATE INDEX idx_plans_integration ON implementation_plans(integration_id);
```

### 12. Security Considerations

#### API Key Security
- **Never commit** API keys to GitHub
- **Use Vercel environment variables**
- **Rotate keys** every 90 days
- **Monitor usage** for anomalies

#### Data Privacy
- **Sample data only**: Agent analyzes sample data, not full datasets
- **No PII storage**: Results don't contain customer personal information
- **GDPR compliant**: Analysis results can be deleted on request

### 13. Success Metrics Dashboard

Add to your admin dashboard:

```typescript
// Key metrics to display
const metrics = {
  total_discoveries: 0,
  average_confidence: 0,
  unused_fields_identified: 0,
  high_value_insights: 0,
  implementations_completed: 0,
  monthly_ai_cost: 0
};
```

### 14. Support & Maintenance

#### Regular Maintenance Tasks
- **Weekly**: Review discovery results, implement high-value findings
- **Monthly**: Update AI prompts based on feedback, optimize costs
- **Quarterly**: Review security, rotate API keys, update documentation

#### Support Channels
1. **Technical Issues**: Check Vercel logs, database queries
2. **AI Accuracy**: Review confidence scores, adjust prompts
3. **Performance**: Monitor execution times, optimize sample sizes

## 🎯 Ready for Production

Your Enhanced API Schema Discovery Agent is **fully configured and ready for production deployment**. The system will:

1. **Automatically analyze** all integrations weekly
2. **Identify unused data** with business value
3. **Generate implementation plans** with timelines
4. **Provide AI-powered insights** to restaurant owners
5. **Scale efficiently** with your customer growth

**Next Action**: Push to GitHub and let Vercel auto-deploy!