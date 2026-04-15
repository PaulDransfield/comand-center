// scripts/test-enhanced-discovery.ts
// Test script for the Enhanced API Schema Discovery Agent

import { analyzeGenericAPIEnhanced, APIAnalysisRequest } from '../lib/api-discovery/enhanced-analyzer'

// Sample data for different types of POS/staffing systems
const TEST_CASES = [
  {
    name: 'iZettle POS System',
    provider: 'iZettle',
    provider_type: 'pos' as const,
    endpoint: '/v1/purchases',
    sample_data: [
      {
        id: 'purchase_123',
        amount: 1250.50,
        currency: 'SEK',
        created_at: '2026-03-15T14:30:00Z',
        updated_at: '2026-03-15T14:30:00Z',
        status: 'completed',
        payment_type: 'card',
        card_type: 'Visa',
        tip_amount: 50.00,
        products: [
          {
            name: 'Pizza Margherita',
            quantity: 2,
            unit_price: 250.00,
            vat_percentage: 12
          },
          {
            name: 'Coca-Cola',
            quantity: 2,
            unit_price: 25.00,
            vat_percentage: 25
          }
        ],
        customer: {
          email: 'customer@example.com',
          phone: '+46701234567'
        },
        location: {
          name: 'Main Restaurant',
          city: 'Stockholm'
        },
        metadata: {
          table_number: 12,
          server_id: 'server_456',
          shift_id: 'shift_789'
        }
      }
    ],
    api_documentation: 'iZettle provides transaction data including products, payments, and customer information. Useful for revenue tracking and product analysis.'
  },
  {
    name: 'Personalkollen Staffing System',
    provider: 'Personalkollen',
    provider_type: 'staffing' as const,
    endpoint: '/api/v1/shifts',
    sample_data: [
      {
        shift_id: 'shift_abc123',
        employee_id: 'emp_456',
        employee_name: 'Anna Andersson',
        department: 'Kök',
        position: 'Kock',
        shift_start: '2026-03-15T08:00:00',
        shift_end: '2026-03-15T16:30:00',
        break_minutes: 30,
        hours_worked: 8.0,
        hourly_rate: 185.50,
        cost_actual: 1484.00,
        cost_estimated: 1484.00,
        ob_type: 'OB1',
        ob_supplement: 74.20,
        late_arrival_minutes: 5,
        notes: 'Training new employee',
        skills: ['Grill', 'Fritös', 'Salad'],
        certifications: ['Hygiencertifikat', 'Brandskydd'],
        performance_rating: 4.5
      }
    ],
    api_documentation: 'Personalkollen provides detailed staff shift data including hours, costs, OB supplements, and performance metrics.'
  },
  {
    name: 'Fortnox Accounting System',
    provider: 'Fortnox',
    provider_type: 'accounting' as const,
    endpoint: '/invoices',
    sample_data: [
      {
        DocumentNumber: 'INV-2026-00123',
        InvoiceDate: '2026-03-15',
        DueDate: '2026-04-15',
        CustomerName: 'ICA Supermarket',
        CustomerNumber: 'CUST456',
        Total: 12500.00,
        VAT: 2500.00,
        Currency: 'SEK',
        CurrencyRate: 1.0,
        InvoiceRows: [
          {
            ArticleNumber: 'PROD001',
            Description: 'Köttbullar 1kg',
            Quantity: 10,
            Price: 125.00,
            VAT: 25.00
          }
        ],
        YourReference: 'PO-789',
        OurReference: 'John Doe',
        PaymentWay: 'Bankgiro',
        Project: 'Restaurant Supplies',
        CostCenter: 'Kitchen'
      }
    ],
    api_documentation: 'Fortnox provides invoice and accounting data including suppliers, amounts, VAT, and project/cost center tracking.'
  }
]

async function runTest() {
  console.log('🚀 Testing Enhanced API Schema Discovery Agent\n')
  console.log('='.repeat(80))
  
  for (const testCase of TEST_CASES) {
    console.log(`\n📊 Testing: ${testCase.name}`)
    console.log(`Provider: ${testCase.provider} (${testCase.provider_type})`)
    console.log(`Endpoint: ${testCase.endpoint}`)
    console.log('-'.repeat(40))
    
    try {
      const analysisRequest: APIAnalysisRequest = {
        provider: testCase.provider,
        endpoint: testCase.endpoint,
        endpoint_description: `Test data for ${testCase.name}`,
        sample_data: testCase.sample_data,
        api_documentation: testCase.api_documentation,
        provider_type: testCase.provider_type,
        known_apis: ['Fortnox', 'Personalkollen', 'iZettle', 'Lightspeed', 'Visma', 'Bokio']
      }
      
      console.log('Analyzing sample data with Claude...')
      const result = await analyzeGenericAPIEnhanced(analysisRequest)
      
      // Display results
      console.log(`\n✅ Analysis Complete`)
      console.log(`Data Type: ${result.data_type}`)
      console.log(`Primary Table: ${result.primary_table}`)
      console.log(`Confidence Score: ${result.confidence_score}%`)
      
      console.log(`\n📋 Field Mappings (${result.field_mappings.length} found):`)
      result.field_mappings.slice(0, 5).forEach((mapping, i) => {
        console.log(`  ${i + 1}. ${mapping.source_field} → ${mapping.target_table}.${mapping.target_field} (${mapping.confidence}%)`)
        if (mapping.transformation_needed.length > 0) {
          console.log(`     Transformations needed: ${mapping.transformation_needed.join(', ')}`)
        }
      })
      
      console.log(`\n🔍 Unused Fields Analysis (${result.unused_fields.length} found):`)
      const highValueUnused = result.unused_fields.filter(f => f.business_value === 'high')
      if (highValueUnused.length > 0) {
        console.log(`  High-value unused fields:`)
        highValueUnused.slice(0, 3).forEach((field, i) => {
          console.log(`  ${i + 1}. ${field.field_path}: ${field.potential_use}`)
          console.log(`     Action: ${field.suggested_action} (Effort: ${field.implementation_effort})`)
        })
      }
      
      console.log(`\n💡 Business Insights (${result.business_insights.length} found):`)
      result.business_insights.slice(0, 3).forEach((insight, i) => {
        console.log(`  ${i + 1}. ${insight.insight}`)
        console.log(`     Impact: ${insight.impact}, Priority: ${insight.priority}`)
      })
      
      console.log(`\n📈 Data Quality:`)
      console.log(`  Completeness: ${result.data_quality.completeness_score}%`)
      console.log(`  Consistency: ${result.data_quality.consistency_score}%`)
      console.log(`  Freshness: ${result.data_quality.freshness_score}%`)
      if (result.data_quality.issues.length > 0) {
        console.log(`  Issues: ${result.data_quality.issues.slice(0, 2).join('; ')}`)
      }
      
      console.log(`\n⚙️ Implementation Recommendations:`)
      console.log(`  Sync Frequency: ${result.implementation.sync_frequency}`)
      console.log(`  Estimated Monthly Rows: ${result.implementation.estimated_monthly_rows}`)
      console.log(`  Data Retention: ${result.implementation.data_retention}`)
      
      console.log('\n' + '='.repeat(80))
      
    } catch (error: any) {
      console.error(`❌ Test failed for ${testCase.name}:`, error.message)
      console.log('\n' + '='.repeat(80))
    }
  }
  
  console.log('\n🎯 Test Summary')
  console.log('All test cases demonstrate how the Enhanced API Schema Discovery Agent can:')
  console.log('1. Automatically map API data to CommandCenter schema')
  console.log('2. Identify unused data fields with business value')
  console.log('3. Provide actionable insights for restaurant owners')
  console.log('4. Generate implementation recommendations')
  console.log('\nThe agent handles multiple POS/staffing systems and provides Swedish business context.')
}

// Run the test
runTest().catch(console.error)