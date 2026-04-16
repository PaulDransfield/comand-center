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