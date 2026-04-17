# Live API Prober - Quick Start for Claude

## Agent Status: ✅ READY (Not Actively Running)

The Live API Prober agent has been created and is ready for use with Claude. The agent is **not actively running** - it's available for manual use when needed.

## What This Agent Does

The Live API Prober:
1. **Fires real HTTP requests** to discover working API endpoints
2. **Tests multiple authentication methods** (Bearer, Basic, API Key, OAuth2)
3. **Captures all responses** including 401s and 404s (errors provide valuable information)
4. **Uses Claude AI** to analyze patterns and discover working endpoints
5. **Stores results** in database for future reference

## Files Created

### 1. **Core Agent** (`lib/agents/live-api-prober.ts`)
- Main agent logic with all probing functionality
- Pre-configured for Swedish business APIs (Fortnox, Personalkollen, Swess, Inzii, Visma)
- AI analysis integration with Claude

### 2. **API Route** (`app/api/cron/live-api-prober/route.ts`)
- Manual trigger endpoint (POST): `/api/cron/live-api-prober`
- Cron job endpoint (GET): `/api/cron/live-api-prober`
- Requires authentication: `Authorization: Bearer admin123`

### 3. **Test Script** (`scripts/test-live-api-prober.ts`)
- Test the agent with mock credentials
- Run with: `npx tsx scripts/test-live-api-prober.ts`

### 4. **Documentation** (`docs/AGENT-LIVE-API-PROBER.md`)
- Complete documentation with usage examples
- Database schema requirements
- Configuration instructions

## How Claude Can Use This Agent

### Option 1: Manual Trigger via API
```bash
# Test mode (safe, uses mock credentials)
curl -X POST http://localhost:3000/api/cron/live-api-prober \
  -H "Authorization: Bearer admin123" \
  -H "Content-Type: application/json" \
  -d '{"test_mode": true}'

# Full probe with specific provider
curl -X POST http://localhost:3000/api/cron/live-api-prober \
  -H "Authorization: Bearer admin123" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "fortnox",
    "credentials": {
      "bearer_token": "actual_token_here"
    },
    "test_mode": false
  }'
```

### Option 2: Programmatic Usage
```typescript
// Import and use directly in code
import { probeAPIs, testProbe } from '@/lib/agents/live-api-prober'

// Quick test with mock credentials
const results = await testProbe('fortnox', {
  bearer_token: 'test_token',
  api_key: 'test_key'
})

// Full probe with real credentials
const { results, analysis } = await probeAPIs('personalkollen', {
  bearer_token: 'real_bearer_token'
})
```

### Option 3: Test Script
```bash
cd comand-center
npx tsx scripts/test-live-api-prober.ts
```

## When to Use This Agent

Use the Live API Prober when you need to:

1. **Discover working API endpoints** for a new integration
2. **Test authentication methods** to find what works
3. **Map API data structure** to CommandCenter schema
4. **Monitor API health** over time
5. **Detect breaking changes** in external APIs

## Current Configuration

### Supported Providers:
- `fortnox` - Accounting API
- `personalkollen` - HR/Payroll API  
- `swess` - POS/Restaurant API
- `inzii` - POS API
- `visma` - Accounting API

### Authentication Methods Tested:
- Bearer token
- Basic auth
- API key (header)
- API key (query parameter)
- OAuth2

## Safety Features

1. **GET-only discovery** - Only uses GET requests to avoid data modification
2. **Rate limiting** - Respectful delays between requests
3. **Timeout protection** - Configurable request timeouts
4. **Error capture** - Records all errors for analysis
5. **Mock mode** - Safe testing with mock credentials

## Next Steps (When Ready to Activate)

1. **Add real API credentials** to database or environment
2. **Create database tables** (see documentation for schema)
3. **Test with real credentials** using test mode
4. **Schedule cron job** for regular probing (optional)
5. **Build UI** to view results (optional)

## Notes for Claude

- The agent is **ready but inactive** - won't run automatically
- Use `test_mode: true` for safe experimentation
- All code is in TypeScript with proper error handling
- AI analysis requires `ANTHROPIC_API_KEY` environment variable
- Database integration uses the existing Supabase setup

## Quick Reference

```typescript
// Main functions available:
probeAPIs(provider?, credentials?)     // Full probe
testProbe(provider, testCredentials)   // Quick test
getProbeHistory(provider?, limit?)     // Get past results
getWorkingEndpoints(provider?)         // Get discovered endpoints
```

The agent is now part of your CommandCenter AI agent ecosystem and ready for use when API discovery is needed.