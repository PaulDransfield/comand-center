// app/admin/api-discoveries-enhanced/simple-page.tsx
// Simplified admin interface for Enhanced API schema discoveries

'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { EnhancedAnalysisResult } from '@/lib/api-discovery/enhanced-analyzer'

interface EnhancedApiDiscovery {
  id: string
  integration_id: string
  provider: string
  provider_type: string
  analysis_result: EnhancedAnalysisResult
  confidence_score: number
  data_type: string
  unused_fields_count: number
  business_insights_count: number
  discovered_at: string
  integration?: {
    business?: {
      name: string
    }
  }
}

interface ImplementationPlan {
  id: string
  integration_id: string
  provider: string
  phase1_tasks: string[]
  phase2_tasks: string[]
  phase3_tasks: string[]
  estimated_timeline: string
  generated_at: string
}

export default function SimpleEnhancedApiDiscoveriesPage() {
  const [discoveries, setDiscoveries] = useState<EnhancedApiDiscovery[]>([])
  const [implementationPlans, setImplementationPlans] = useState<ImplementationPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDiscovery, setSelectedDiscovery] = useState<EnhancedApiDiscovery | null>(null)
  const [selectedPlan, setSelectedPlan] = useState<ImplementationPlan | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    loadEnhancedDiscoveries()
    loadImplementationPlans()
  }, [])

  async function loadEnhancedDiscoveries() {
    try {
      const { data, error } = await supabase
        .from('api_discoveries_enhanced')
        .select(`
          *,
          integration:integrations(
            business:businesses(name)
          )
        `)
        .order('discovered_at', { ascending: false })

      if (error) throw error
      setDiscoveries(data || [])
    } catch (error) {
      console.error('Failed to load enhanced discoveries:', error)
    }
  }

  async function loadImplementationPlans() {
    try {
      const { data, error } = await supabase
        .from('implementation_plans')
        .select('*')
        .order('generated_at', { ascending: false })

      if (error) throw error
      setImplementationPlans(data || [])
    } catch (error) {
      console.error('Failed to load implementation plans:', error)
    } finally {
      setLoading(false)
    }
  }

  async function triggerEnhancedDiscovery() {
    setRefreshing(true)
    try {
      const response = await fetch('/api/cron/api-discovery-enhanced', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET || 'dev-secret'}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Enhanced discovery failed: ${response.status}`)
      }

      const result = await response.json()
      alert(`Enhanced discovery triggered: ${result.integrations_processed} integrations processed`)
      
      // Reload discoveries and plans
      await loadEnhancedDiscoveries()
      await loadImplementationPlans()
    } catch (error: any) {
      console.error('Failed to trigger enhanced discovery:', error)
      alert(`Error: ${error.message}`)
    } finally {
      setRefreshing(false)
    }
  }

  function getConfidenceColor(confidence: number) {
    if (confidence >= 85) return 'bg-green-100 text-green-800 border border-green-300'
    if (confidence >= 70) return 'bg-yellow-100 text-yellow-800 border border-yellow-300'
    return 'bg-red-100 text-red-800 border border-red-300'
  }

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4"></div>
            <p className="text-gray-500">Loading enhanced API discoveries...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Enhanced API Schema Discoveries</h1>
          <p className="text-gray-600 mt-2">
            AI-powered analysis of API integrations with unused data identification and business insights
          </p>
        </div>
        <button 
          onClick={triggerEnhancedDiscovery} 
          disabled={refreshing}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refreshing ? (
            <>
              <span className="animate-spin inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2"></span>
              Running Enhanced Discovery...
            </>
          ) : (
            'Run Enhanced Discovery'
          )}
        </button>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Total Discoveries</p>
              <p className="text-2xl font-bold">{discoveries.length}</p>
            </div>
            <div className="h-8 w-8 text-blue-500">📊</div>
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Avg Confidence</p>
              <p className="text-2xl font-bold">
                {discoveries.length > 0 
                  ? Math.round(discoveries.reduce((sum, d) => sum + d.confidence_score, 0) / discoveries.length)
                  : 0}%
              </p>
            </div>
            <div className="h-8 w-8 text-green-500">🎯</div>
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Unused Fields</p>
              <p className="text-2xl font-bold">
                {discoveries.reduce((sum, d) => sum + d.unused_fields_count, 0)}
              </p>
            </div>
            <div className="h-8 w-8 text-yellow-500">📈</div>
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Business Insights</p>
              <p className="text-2xl font-bold">
                {discoveries.reduce((sum, d) => sum + d.business_insights_count, 0)}
              </p>
            </div>
            <div className="h-8 w-8 text-purple-500">⚡</div>
          </div>
        </div>
      </div>

      {discoveries.length === 0 ? (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex">
            <div className="text-blue-600 mr-3">ℹ️</div>
            <div>
              <h3 className="font-medium text-blue-800">No enhanced discoveries yet</h3>
              <p className="text-blue-700 text-sm mt-1">
                Run the Enhanced API Schema Discovery Agent to analyze your integrations with AI-powered insights.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: Discovery list */}
          <div className="lg:col-span-1">
            <div className="bg-white border border-gray-200 rounded-lg">
              <div className="border-b border-gray-200 p-4">
                <h2 className="text-lg font-semibold">Enhanced Discoveries</h2>
                <p className="text-gray-600 text-sm">
                  {discoveries.length} integration{discoveries.length !== 1 ? 's' : ''} analyzed with AI
                </p>
              </div>
              <div className="p-4">
                <div className="space-y-3">
                  {discoveries.map((discovery) => (
                    <div
                      key={discovery.id}
                      className={`p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${
                        selectedDiscovery?.id === discovery.id ? 'bg-blue-50 border-blue-300' : 'border-gray-200'
                      }`}
                      onClick={() => {
                        setSelectedDiscovery(discovery)
                        const plan = implementationPlans.find(p => p.integration_id === discovery.integration_id)
                        setSelectedPlan(plan || null)
                      }}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                              {discovery.provider}
                            </span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-50 text-gray-600">
                              {discovery.provider_type}
                            </span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getConfidenceColor(discovery.confidence_score)}`}>
                              {discovery.confidence_score}%
                            </span>
                          </div>
                          <p className="text-sm font-medium">{discovery.data_type} data</p>
                          {discovery.integration?.business?.name && (
                            <p className="text-xs text-gray-600 mt-1">
                              {discovery.integration.business.name}
                            </p>
                          )}
                          <p className="text-xs text-gray-500 mt-1">
                            {new Date(discovery.discovered_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          {discovery.unused_fields_count > 0 && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-gray-300">
                              {discovery.unused_fields_count} unused fields
                            </span>
                          )}
                          {discovery.business_insights_count > 0 && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-purple-300 bg-purple-50 text-purple-800">
                              {discovery.business_insights_count} insights
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Implementation Plans */}
            {implementationPlans.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg mt-6">
                <div className="border-b border-gray-200 p-4">
                  <h2 className="text-lg font-semibold">Implementation Plans</h2>
                  <p className="text-gray-600 text-sm">
                    {implementationPlans.length} plan{implementationPlans.length !== 1 ? 's' : ''} generated
                  </p>
                </div>
                <div className="p-4">
                  <div className="space-y-3">
                    {implementationPlans.map((plan) => (
                      <div
                        key={plan.id}
                        className={`p-3 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${
                          selectedPlan?.id === plan.id ? 'bg-green-50 border-green-300' : 'border-gray-200'
                        }`}
                        onClick={() => setSelectedPlan(plan)}
                      >
                        <div className="flex justify-between items-center">
                          <div>
                            <p className="font-medium text-sm">{plan.provider}</p>
                            <p className="text-xs text-gray-500">{plan.estimated_timeline}</p>
                          </div>
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-gray-300">
                            {plan.phase1_tasks.length} phase 1 tasks
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right column: Discovery details */}
          <div className="lg:col-span-2">
            {selectedDiscovery ? (
              <div className="bg-white border border-gray-200 rounded-lg">
                <div className="border-b border-gray-200 p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <h2 className="text-xl font-bold flex items-center gap-2">
                        {selectedDiscovery.provider} Enhanced Analysis
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-300">
                          {selectedDiscovery.provider_type}
                        </span>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getConfidenceColor(selectedDiscovery.confidence_score)}`}>
                          {selectedDiscovery.confidence_score}% confidence
                        </span>
                      </h2>
                      <p className="text-gray-600 text-sm">
                        AI-powered analysis completed {new Date(selectedDiscovery.discovered_at).toLocaleString()}
                      </p>
                    </div>
                    <button className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium py-1.5 px-3 rounded-lg text-sm">
                      📥 Export Analysis
                    </button>
                  </div>
                </div>
                <div className="p-4">
                  <div className="border-b border-gray-200 mb-4">
                    <div className="flex space-x-4">
                      <button className="pb-2 px-1 border-b-2 border-blue-500 text-blue-600 font-medium">Overview</button>
                      <button className="pb-2 px-1 text-gray-600 hover:text-gray-900">Field Mappings</button>
                      <button className="pb-2 px-1 text-gray-600 hover:text-gray-900">Unused Data</button>
                      <button className="pb-2 px-1 text-gray-600 hover:text-gray-900">Business Insights</button>
                      <button className="pb-2 px-1 text-gray-600 hover:text-gray-900">Implementation</button>
                    </div>
                  </div>

                  {/* Overview Content */}
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h3 className="font-medium text-sm mb-3">Data Quality</h3>
                        <div className="space-y-2">
                          <div>
                            <p className="text-xs text-gray-500">Completeness</p>
                            <div className="flex items-center gap-2">
                              <div className="w-full bg-gray-200 rounded-full h-2">
                                <div 
                                  className="bg-green-500 h-2 rounded-full" 
                                  style={{ width: `${selectedDiscovery.analysis_result.data_quality.completeness_score}%` }}
                                />
                              </div>
                              <span className="text-sm font-medium">{selectedDiscovery.analysis_result.data_quality.completeness_score}%</span>
                            </div>
                          </div>
                          <div>
                            <p className="text-xs text-gray-500">Consistency</p>
                            <div className="flex items-center gap-2">
                              <div className="w-full bg-gray-200 rounded-full h-2">
                                <div 
                                  className="bg-blue-500 h-2 rounded-full" 
                                  style={{ width: `${selectedDiscovery.analysis_result.data_quality.consistency_score}%` }}
                                />
                              </div>
                              <span className="text-sm font-medium">{selectedDiscovery.analysis_result.data_quality.consistency_score}%</span>
                            </div>
                          </div>
                          <div>
                            <p className="text-xs text-gray-500">Freshness</p>
                            <div className="flex items-center gap-2">
                              <div className="w-full bg-gray-200 rounded-full h-2">
                                <div 
                                  className="bg-purple-500 h-2 rounded-full" 
                                  style={{ width: `${selectedDiscovery.analysis_result.data_quality.freshness_score}%` }}
                                />
                              </div>
                              <span className="text-sm font-medium">{selectedDiscovery.analysis_result.data_quality.freshness_score}%</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="border border-gray-200 rounded-lg p-4">
                        <h3 className="font-medium text-sm mb-3">Implementation</h3>
                        <div className="space-y-2">
                          <div className="flex justify-between">
                            <span className="text-sm">Sync Frequency</span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-gray-300">
                              {selectedDiscovery