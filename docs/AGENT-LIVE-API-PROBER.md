# Live API Prober Agent (Ready for Use with Claude)

## Overview
The Live API Prober Agent is an intelligent API discovery system that fires real HTTP requests with stored API keys across many possible endpoint and auth combinations. It captures every response (including 401s and 404s) and uses Claude AI to analyze patterns and discover working endpoints.

**Status:** ✅ **Agent created and ready** - Code is complete but not actively running. Use with Claude for API discovery tasks.

## Key Features

### 1. **Real HTTP Request Probing**
- Fires actual HTTP requests to target APIs
- Tests multiple authentication methods (Bearer, Basic, API Key, OAuth2)
- Tests multiple HTTP methods (GET, POST, PUT, DELETE)
- Captures all responses including errors

### 2. **Intelligent Pattern Discovery**
- Uses Claude AI to analyze response patterns
- Identifies working authentication methods
- Discovers valid endpoint structures
- Infers data schemas from successful responses

### 3. **Comprehensive Coverage**
- Pre-configured for common Swedish business APIs:
  - Fortnox (Accounting)
  - Personalkollen (HR/Payroll)
  - Swess (POS/Restaurant)
  - Inzii (POS)
  - Visma (Accounting)
- Extensible to any REST API

### 4. **Safe Probing**
- Only uses GET requests for discovery (avoids data modification)
- Respectful delays between requests
- Configurable timeouts
- Rate limit detection

## Architecture

### Core Components

#### 1. **API Provider Configurations**
```typescript
interface APIProviderConfig {
  provider: string
  base_url: string
  auth_methods: string[]
  common_endpoints: string[]
  common_headers: Record<string, string>
}
```

#### 2. **Probe Results**
```typescript
interface APIProbeResult {
  provider: string
  endpoint: string
  method: string
  auth_type: string
  status_code: number
  response_body: any
  response_time_ms: number
  success: boolean
  error?: string
}
```

#### 3. **AI Analysis**
```typescript
interface APIProbeAnalysis {
  provider: string
  working_endpoints: Array<{...}>
  auth_patterns: Array<{...}>
  rate_limits?: {...}
  data_schema?: {...}
  recommendations: Array<{...}>
}
```

## Usage

### 1. **Manual Trigger (Admin)**
```bash
# Trigger a probe for all providers
curl -X POST http://localhost:3000/api/cron/live-api-prober \
  -H "Authorization: Bearer admin123" \
  -H "Content-Type: application/json" \
  -d '{"test_mode": true}'

# Trigger for specific provider with credentials
curl -X POST http://localhost:3000/api/cron/live-api-prober \
  -H "Authorization: Bearer admin123" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "fortnox",
    "credentials": {
      "bearer_token": "your_token_here"
    }
  }'
```

### 2. **Cron Job**
```bash
# Scheduled probe (requires CRON_SECRET)
curl http://localhost:3000/api/cron/live-api-prober \
  -H "Authorization: Bearer your_cron_secret"
```

### 3. **Programmatic Usage**
```typescript
import { probeAPIs, testProbe } from '@/lib/agents/live-api-prober'

// Full probe
const { results, analysis } = await probeAPIs('fortnox', credentials)

// Quick test
const testResults = await testProbe('personalkollen', testCredentials)
```

## Database Schema

### Required Tables

#### 1. **api_credentials**
```sql
CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  credentials JSONB NOT NULL,
  status TEXT DEFAULT 'active',
  discovered_auth_patterns TEXT[],
  last_probe_date TIMESTAMPTZ,
  probe_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 2. **api_probe_results**
```sql
CREATE TABLE api_probe_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  probe_date TIMESTAMPTZ DEFAULT NOW(),
  results JSONB NOT NULL,
  analysis JSONB NOT NULL,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Configuration

### Environment Variables
```bash
# Required for AI analysis
ANTHROPIC_API_KEY=your_claude_api_key

# For cron job authentication
CRON_SECRET=your_cron_secret

# For admin manual triggers
ADMIN_SECRET=admin123
```

### Provider Configuration
Add new providers in `lib/agents/live-api-prober.ts`:
```typescript
{
  provider: 'new_provider',
  base_url: 'https://api.newprovider.com',
  auth_methods: ['bearer', 'api_key'],
  common_endpoints: [
    '/v1/users',
    '/v1/orders',
    '/v1/products'
  ],
  common_headers: {
    'Content-Type': 'application/json'
  }
}
```

## Testing

### Run Test Script
```bash
cd comand-center
npx tsx scripts/test-live-api-prober.ts
```

### Expected Output
```
=== Live API Prober Test ===

1. Testing Fortnox API probe...
   Results: 8 requests
   Successful: 0
   Failed: 8

2. Testing Personalkollen API probe...
   Results: 4 requests
   Successful: 0
   Failed: 4

=== Test Summary ===
Total test requests: 12
Total successful: 0
Test completed successfully!
```

**Note:** Test will show 0 successful with mock credentials. With real credentials, it will discover working endpoints.

## Integration with CommandCenter

### 1. **Automatic Discovery**
- Runs nightly via cron job
- Updates `api_credentials` with discovered patterns
- Stores results for analysis

### 2. **Data Mapping**
- Uses discovered schemas to map to CommandCenter tables
- Generates integration recommendations
- Identifies unused data fields

### 3. **Monitoring**
- Tracks API health over time
- Detects breaking changes
- Monitors response times

## Security Considerations

### 1. **Credential Storage**
- API credentials encrypted at rest
- Only accessible to admin users
- Automatic rotation support

### 2. **Request Safety**
- Discovery phase uses only GET requests
- Configurable rate limiting
- Respects API terms of service

### 3. **Access Control**
- Cron jobs require secret token
- Manual triggers require admin authentication
- Results stored in secure database

## Troubleshooting

### Common Issues

#### 1. **All Requests Fail (401)**
- Check API credentials are valid
- Verify authentication method
- Check API key permissions

#### 2. **Rate Limiting**
- Increase delays between requests
- Implement exponential backoff
- Monitor rate limit headers

#### 3. **Claude Analysis Fails**
- Check ANTHROPIC_API_KEY is set
- Verify Claude has sufficient tokens
- Check response size limits

### Debugging
```typescript
// Enable verbose logging
console.log('Probing ${providerConfig.provider} API...')

// Check individual responses
results.forEach(r => {
  if (r.error) console.log(`Error: ${r.endpoint} - ${r.error}`)
})
```

## Future Enhancements

### Planned Features
1. **Webhook Integration** - Real-time discovery triggers
2. **GraphQL Support** - Probe GraphQL APIs
3. **SOAP/WSDL** - Legacy API support
4. **Performance Benchmarking** - Response time tracking
5. **Change Detection** - Alert on API changes

### Integration Points
1. **CommandCenter Dashboard** - Visual probe results
2. **Alert System** - Notify on discovery
3. **Data Mapping UI** - Visual schema mapping
4. **API Documentation Generator** - Auto-generate docs

## Conclusion
The Live API Prober Agent automates the discovery of working API endpoints and authentication patterns. By combining real HTTP probing with AI analysis, it can discover and document APIs without manual intervention, accelerating integration projects and reducing development time.