// scripts/test-live-api-prober.ts
// Test script for Live API Prober Agent

import { testProbe, getProbeHistory, getWorkingEndpoints } from '@/lib/agents/live-api-prober'

async function main() {
  console.log('=== Live API Prober Test ===\n')
  
  // Test credentials (mock for testing)
  const testCredentials = {
    bearer_token: 'test_bearer_token_123',
    api_key: 'test_api_key_456',
    username: 'test_user',
    password: 'test_password'
  }
  
  try {
    // Test 1: Quick probe of Fortnox
    console.log('1. Testing Fortnox API probe...')
    const fortnoxResults = await testProbe('fortnox', testCredentials)
    
    console.log(`   Results: ${fortnoxResults.length} requests`)
    console.log(`   Successful: ${fortnoxResults.filter(r => r.success).length}`)
    console.log(`   Failed: ${fortnoxResults.filter(r => !r.success).length}`)
    
    if (fortnoxResults.length > 0) {
      console.log('\n   Sample successful result:')
      const success = fortnoxResults.find(r => r.success)
      if (success) {
        console.log(`   - Endpoint: ${success.endpoint}`)
        console.log(`   - Method: ${success.method}`)
        console.log(`   - Auth: ${success.auth_type}`)
        console.log(`   - Status: ${success.status_code}`)
        console.log(`   - Time: ${success.response_time_ms}ms`)
      }
      
      console.log('\n   Sample failed result:')
      const failed = fortnoxResults.find(r => !r.success)
      if (failed) {
        console.log(`   - Endpoint: ${failed.endpoint}`)
        console.log(`   - Method: ${failed.method}`)
        console.log(`   - Auth: ${failed.auth_type}`)
        console.log(`   - Status: ${failed.status_code}`)
        console.log(`   - Error: ${failed.error}`)
      }
    }
    
    // Test 2: Quick probe of Personalkollen
    console.log('\n2. Testing Personalkollen API probe...')
    const personalkollenResults = await testProbe('personalkollen', testCredentials)
    
    console.log(`   Results: ${personalkollenResults.length} requests`)
    console.log(`   Successful: ${personalkollenResults.filter(r => r.success).length}`)
    console.log(`   Failed: ${personalkollenResults.filter(r => !r.success).length}`)
    
    // Test 3: Get probe history (mock - will use mock Supabase client)
    console.log('\n3. Testing probe history retrieval...')
    const history = await getProbeHistory('fortnox', 3)
    console.log(`   History entries: ${history.length}`)
    
    // Test 4: Get working endpoints (mock)
    console.log('\n4. Testing working endpoints retrieval...')
    const workingEndpoints = await getWorkingEndpoints()
    console.log(`   Providers with data: ${Object.keys(workingEndpoints).length}`)
    
    // Summary
    console.log('\n=== Test Summary ===')
    console.log(`Total test requests: ${fortnoxResults.length + personalkollenResults.length}`)
    console.log(`Total successful: ${fortnoxResults.filter(r => r.success).length + personalkollenResults.filter(r => r.success).length}`)
    console.log(`Test completed successfully!`)
    
    // Show what the agent would do in production
    console.log('\n=== Production Mode ===')
    console.log('In production, the agent would:')
    console.log('1. Fetch real API credentials from database')
    console.log('2. Probe all configured providers (Fortnox, Personalkollen, Swess, Inzii, Visma)')
    console.log('3. Test multiple auth methods per endpoint (bearer, basic, api_key, etc.)')
    console.log('4. Test multiple HTTP methods (GET, POST, PUT, DELETE)')
    console.log('5. Capture all responses (200, 401, 404, 500, etc.)')
    console.log('6. Store results in database')
    console.log('7. Analyze patterns with Claude AI')
    console.log('8. Generate integration recommendations')
    
  } catch (error: any) {
    console.error('Test failed:', error.message)
    console.error('Stack:', error.stack)
    process.exit(1)
  }
}

// Run the test
main().catch(error => {
  console.error('Unhandled error:', error)
  process.exit(1)
})