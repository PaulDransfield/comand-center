// app/admin/api-discoveries-enhanced/page.tsx
// Admin interface for reviewing Enhanced API schema discoveries with unused data analysis

'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CheckCircle, AlertTriangle, Info, Download, RefreshCw, TrendingUp, Zap, Target, BarChart } from 'lucide-react'
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

export default function EnhancedApiDiscoveriesPage() {
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
    if (confidence >= 85) return 'bg-green-100 text-green-800 border-green-300'
    if (confidence >= 70) return 'bg-yellow-100 text-yellow-800 border-yellow-300'
    return 'bg-red-100 text-red-800 border-red-300'
  }

  function getBusinessValueColor(value: 'high' | 'medium' | 'low') {
    switch (value) {
      case 'high': return 'bg-green-100 text-green-800 border-green-300'
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-300'
      case 'low': return 'bg-gray-100 text-gray-800 border-gray-300'
    }
  }

  function getImpactColor(impact: string) {
    switch (impact) {
      case 'revenue': return 'bg-green-100 text-green-800 border-green-300'
      case 'costs': return 'bg-red-100 text-red-800 border-red-300'
      case 'efficiency': return 'bg-blue-100 text-blue-800 border-blue-300'
      case 'compliance': return 'bg-purple-100 text-purple-800 border-purple-300'
      case 'customer_experience': return 'bg-pink-100 text-pink-800 border-pink-300'
      default: return 'bg-gray-100 text-gray-800 border-gray-300'
    }
  }

  function getPriorityIcon(priority: 'high' | 'medium' | 'low') {
    switch (priority) {
      case 'high': return <AlertTriangle className="h-4 w-4 text-red-600" />
      case 'medium': return <AlertTriangle className="h-4 w-4 text-yellow-600" />
      case 'low': return <Info className="h-4 w-4 text-blue-600" />
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-gray-400" />
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
        <Button onClick={triggerEnhancedDiscovery} disabled={refreshing}>
          {refreshing ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
              Running Enhanced Discovery...
            </>
          ) : (
            <>
              <Zap className="h-4 w-4 mr-2" />
              Run Enhanced Discovery
            </>
          )}
        </Button>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Total Discoveries</p>
                <p className="text-2xl font-bold">{discoveries.length}</p>
              </div>
              <BarChart className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Avg Confidence</p>
                <p className="text-2xl font-bold">
                  {discoveries.length > 0 
                    ? Math.round(discoveries.reduce((sum, d) => sum + d.confidence_score, 0) / discoveries.length)
                    : 0}%
                </p>
              </div>
              <Target className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Unused Fields</p>
                <p className="text-2xl font-bold">
                  {discoveries.reduce((sum, d) => sum + d.unused_fields_count, 0)}
                </p>
              </div>
              <TrendingUp className="h-8 w-8 text-yellow-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Business Insights</p>
                <p className="text-2xl font-bold">
                  {discoveries.reduce((sum, d) => sum + d.business_insights_count, 0)}
                </p>
              </div>
              <Zap className="h-8 w-8 text-purple-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {discoveries.length === 0 ? (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>No enhanced discoveries yet</AlertTitle>
          <AlertDescription>
            Run the Enhanced API Schema Discovery Agent to analyze your integrations with AI-powered insights.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: Discovery list */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <CardTitle>Enhanced Discoveries</CardTitle>
                <CardDescription>
                  {discoveries.length} integration{discoveries.length !== 1 ? 's' : ''} analyzed with AI
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {discoveries.map((discovery) => (
                    <div
                      key={discovery.id}
                      className={`p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${
                        selectedDiscovery?.id === discovery.id ? 'bg-blue-50 border-blue-300' : ''
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
                            <Badge variant="outline">{discovery.provider}</Badge>
                            <Badge variant="secondary" className="text-xs">
                              {discovery.provider_type}
                            </Badge>
                            <Badge className={getConfidenceColor(discovery.confidence_score)}>
                              {discovery.confidence_score}%
                            </Badge>
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
                            <Badge variant="outline" className="text-xs">
                              {discovery.unused_fields_count} unused fields
                            </Badge>
                          )}
                          {discovery.business_insights_count > 0 && (
                            <Badge variant="outline" className="text-xs bg-purple-50">
                              {discovery.business_insights_count} insights
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Implementation Plans */}
            {implementationPlans.length > 0 && (
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>Implementation Plans</CardTitle>
                  <CardDescription>
                    {implementationPlans.length} plan{implementationPlans.length !== 1 ? 's' : ''} generated
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {implementationPlans.map((plan) => (
                      <div
                        key={plan.id}
                        className={`p-3 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${
                          selectedPlan?.id === plan.id ? 'bg-green-50 border-green-300' : ''
                        }`}
                        onClick={() => setSelectedPlan(plan)}
                      >
                        <div className="flex justify-between items-center">
                          <div>
                            <p className="font-medium text-sm">{plan.provider}</p>
                            <p className="text-xs text-gray-500">{plan.estimated_timeline}</p>
                          </div>
                          <Badge variant="outline" className="text-xs">
                            {plan.phase1_tasks.length} phase 1 tasks
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right column: Discovery details */}
          <div className="lg:col-span-2">
            {selectedDiscovery ? (
              <Card>
                <CardHeader>
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        {selectedDiscovery.provider} Enhanced Analysis
                        <Badge variant="outline">{selectedDiscovery.provider_type}</Badge>
                        <Badge className={getConfidenceColor(selectedDiscovery.confidence_score)}>
                          {selectedDiscovery.confidence_score}% confidence
                        </Badge>
                      </CardTitle>
                      <CardDescription>
                        AI-powered analysis completed {new Date(selectedDiscovery.discovered_at).toLocaleString()}
                      </CardDescription>
                    </div>
                    <Button variant="outline" size="sm">
                      <Download className="h-4 w-4 mr-2" />
                      Export Analysis
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="overview">
                    <TabsList className="grid w-full grid-cols-5">
                      <TabsTrigger value="overview">Overview</TabsTrigger>
                      <TabsTrigger value="mappings">Field Mappings</TabsTrigger>
                      <TabsTrigger value="unused">Unused Data</TabsTrigger>
                      <TabsTrigger value="insights">Business Insights</TabsTrigger>
                      <TabsTrigger value="implementation">Implementation</TabsTrigger>
                    </TabsList>

                    <TabsContent value="overview" className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Data Quality</CardTitle>
                          </CardHeader>
                          <CardContent>
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
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Implementation</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="space-y-2">
                              <div className="flex justify-between">
                                <span className="text-sm">Sync Frequency</span>
                                <Badge variant="outline">
                                  {selectedDiscovery.analysis_result.implementation.sync_frequency}
                                </Badge>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-sm">Monthly Rows</span>
                                <span className="text-sm font-medium">
                                  {selectedDiscovery.analysis_result.implementation.estimated_monthly_rows.toLocaleString()}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-sm">Data Retention</span>
                                <span className="text-sm text-gray-600">
                                  {selectedDiscovery.analysis_result.implementation.data_retention}
                                </span>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </div>

                      {/* Data Quality Issues */}
                      {selectedDiscovery.analysis_result.data_quality.issues.length > 0 && (
                        <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle>Data Quality Issues</AlertTitle>
                          <AlertDescription>
                            <ul className="list-disc pl-4 mt-2 space-y-1">
                              {selectedDiscovery.analysis_result.data_quality.issues.map((issue, index) => (
                                <li key={index} className="text-sm">{issue}</li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Recommendations */}
                      {selectedDiscovery.analysis_result.data_quality.recommendations.length > 0 && (
                        <Alert>
                          <Info className="h-4 w-4" />
                          <AlertTitle>Recommendations</AlertTitle>
                          <AlertDescription>
                            <ul className="list-disc pl-4 mt-2 space-y-1">
                              {selectedDiscovery.analysis_result.data_quality.recommendations.map((rec, index) => (
                                <li key={index} className="text-sm">{rec}</li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>

                    <TabsContent value="mappings" className="space-y-4">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left p-2">API Field</th>
                              <th className="text-left p-2">Type</th>
                              <th className="text-left p-2">Target Table</th>
                              <th className="text-left p-2">Target Field</th>
                              <th className="text-left p-2">Confidence</th>
                              <th className="text-left p-2">Transformations</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedDiscovery.analysis_result.field_mappings.map((mapping, index) => (
                              <tr key={index} className="border-b hover:bg-gray-50">
                                <td className="p-2 font-mono text-xs">{mapping.source_field}</td>
                                <td className="p-2 text-xs">{mapping.source_type}</td>
                                <td className="p-2">{mapping.target_table}</td>
                                <td className="p-2">{mapping.target_field}</td>
                                <td className="p-2">
                                  <Badge className={getConfidenceColor(mapping.confidence)}>
                                    {mapping.confidence}%
                                  </Badge>
                                </td>
                                <td className="p-2">
                                  {mapping.transformation_needed.length > 0 ? (
                                    <div className="flex flex-wrap gap-1">
                                      {mapping.transformation_needed.map((transform, i) => (
                                        <Badge key={i} variant="outline" className="text-xs">
                                          {transform}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-gray-500">None</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="text-sm text-gray-500">
                        {selectedDiscovery.analysis_result.field_mappings.length} field mappings found
                      </div>
                    </TabsContent>

                    <TabsContent value="unused" className="space-y-4">
                      {selectedDiscovery.analysis_result.unused_fields.length > 0 ? (
                        <div className="space-y-4">
                          {selectedDiscovery.analysis_result.unused_fields.map((field, index) => (
                            <Card key={index}>
                              <CardHeader className="pb-2">
                                <div className="flex justify-between items-start">
                                  <CardTitle className="text-sm font-mono">{field.field_path}</CardTitle>
                                  <div className="flex gap-2">
                                    <Badge className={getBusinessValueColor(field.business_value)}>
                                      {field.business_value} value
                                    </Badge>
                                    <Badge variant="outline">
                                      {field.implementation_effort} effort
                                    </Badge>
                                    <Badge variant={
                                      field.suggested_action === 'map_now' ? 'default' :
                                      field.suggested_action === 'future_feature' ? 'secondary' : 'outline'
                                    }>
                                      {field.suggested_action}
                                    </Badge>
                                  </div>
                                </div>
                              </CardHeader>
                              <CardContent>
                                <div className="space-y-2">
                                  <div>
                                    <p className="text-xs text-gray-500">Sample Value</p>
                                    <p className="text-sm font-mono bg-gray-50 p-2 rounded">
                                      {JSON.stringify(field.sample_value)}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Potential Use</p>
                                    <p className="text-sm">{field.potential_use}</p>
                                  </div>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      ) : (
                        <Alert>
                          <CheckCircle className="h-4 w-4" />
                          <AlertTitle>No unused fields found</AlertTitle>
                          <AlertDescription>
                            All API fields appear to be mapped to CommandCenter schema.
                          </AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>

                    <TabsContent value="insights" className="space-y-4">
                      {selectedDiscovery.analysis_result.business_insights.length > 0 ? (
                        <div className="space-y-4">
                          {selectedDiscovery.analysis_result.business_insights.map((insight, index) => (
                            <Alert key={index} className={getImpactColor(insight.impact)}>
                              {getPriorityIcon(insight.priority)}
                              <AlertTitle className="capitalize">{insight.impact} Impact</AlertTitle>
                              <AlertDescription>
                                <div className="mt-2">
                                  <p className="font-medium">{insight.insight}</p>
                                  <div className="flex items-center gap-2 mt-2">
                                    <Badge variant="outline" className={getImpactColor(insight.impact)}>
                                      {insight.impact}
                                    </Badge>
                                    <Badge variant={
                                      insight.priority === 'high' ? 'destructive' :
                                      insight.priority === 'medium' ? 'secondary' : 'outline'
                                    }>
                                      {insight.priority} priority
                                    </Badge>
                                  </div>
                                  <p className="text-sm mt-2">
                                    <strong>Implementation:</strong> {insight.suggested_implementation}
                                  </p>
                                </div>
                              </AlertDescription>
                            </Alert>
                          ))}
                        </div>
                      ) : (
                        <Alert>
                          <Info className="h-4 w-4" />
                          <AlertTitle>No business insights</AlertTitle>
                          <AlertDescription>
                            No additional business insights identified for this integration.
                          </AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>

                    <TabsContent value="implementation" className="space-y-4">
                      {selectedPlan ? (
                        <div className="space-y-6">
                          <div>
                            <h3 className="font-medium mb-2">Implementation Timeline</h3>
                            <Badge variant="outline">{selectedPlan.estimated_timeline}</Badge>
                          </div>

                          <div>
                            <h3 className="font-medium mb-2">Phase 1: Immediate Actions</h3>
                            <ul className="space-y-2">
                              {selectedPlan.phase1_tasks.map((task, index) => (
                                <li key={index} className="flex items-start gap-2">
                                  <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                                  <span className="text-sm">{task}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          {selectedPlan.phase2_tasks.length > 0 && (
                            <div>
                              <h3 className="font-medium mb-2">Phase 2: Near-term Enhancements</h3>
                              <ul className="space-y-2">
                                {selectedPlan.phase2_tasks.map((task, index) => (
                                  <li key={index} className="flex items-start gap-2">
                                    <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                                    <span className="text-sm">{task}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {selectedPlan.phase3_tasks.length > 0 && (
                            <div>
                              <h3 className="font-medium mb-2">Phase 3: Future Considerations</h3>
                              <ul className="space-y-2">
                                {selectedPlan.phase3_tasks.map((task, index) => (
                                  <li key={index} className="flex items-start gap-2">
                                    <Info className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
                                    <span className="text-sm">{task}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="pt-4 border-t">
                            <h3 className="font-medium mb-2">Generated Code Snippets</h3>
                            {selectedDiscovery.analysis_result.code_snippets.sync_config && (
                              <div className="mb-4">
                                <h4 className="text-sm font-medium mb-1">Sync Configuration</h4>
                                <pre className="bg-gray-900 text-gray-100 p-3 rounded text-xs overflow-x-auto">
                                  {selectedDiscovery.analysis_result.code_snippets.sync_config}
                                </pre>
                              </div>
                            )}
                            {selectedDiscovery.analysis_result.code_snippets.transformation_functions.length > 0 && (
                              <div>
                                <h4 className="text-sm font-medium mb-1">Transformation Functions</h4>
                                {selectedDiscovery.analysis_result.code_snippets.transformation_functions.map((func, index) => (
                                  <pre key={index} className="bg-gray-900 text-gray-100 p-3 rounded text-xs overflow-x-auto mb-2">
                                    {func}
                                  </pre>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <Alert>
                          <Info className="h-4 w-4" />
                          <AlertTitle>No implementation plan</AlertTitle>
                          <AlertDescription>
                            No implementation plan generated for this discovery yet.
                          </AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Select a Discovery</CardTitle>
                  <CardDescription>
                    Choose an enhanced discovery from the list to view AI-powered insights and recommendations
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-center py-12 text-gray-500">
                    <Zap className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                    <p>No enhanced discovery selected</p>
                    <p className="text-sm mt-2">Select a discovery to see AI-powered analysis results</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
