// app/admin/api-discoveries/page.tsx
// Admin interface for reviewing API schema discoveries

'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CheckCircle, AlertTriangle, Info, Download, RefreshCw } from 'lucide-react'

interface ApiDiscovery {
  id: string
  integration_id: string
  provider: string
  discoveries: any
  suggested_mappings: any[]
  recommendations: any[]
  sync_engine_config?: any
  generated_code?: string
  table_sql?: string[]
  discovered_at: string
  integration?: {
    business?: {
      name: string
    }
  }
}

export default function ApiDiscoveriesPage() {
  const [discoveries, setDiscoveries] = useState<ApiDiscovery[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDiscovery, setSelectedDiscovery] = useState<ApiDiscovery | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    loadDiscoveries()
  }, [])

  async function loadDiscoveries() {
    try {
      const { data, error } = await supabase
        .from('api_discoveries')
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
      console.error('Failed to load discoveries:', error)
    } finally {
      setLoading(false)
    }
  }

  async function triggerDiscovery() {
    setRefreshing(true)
    try {
      const response = await fetch('/api/cron/api-discovery', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET || 'dev-secret'}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Discovery failed: ${response.status}`)
      }

      const result = await response.json()
      alert(`Discovery triggered: ${result.integrations_processed} integrations processed`)
      
      // Reload discoveries
      await loadDiscoveries()
    } catch (error: any) {
      console.error('Failed to trigger discovery:', error)
      alert(`Error: ${error.message}`)
    } finally {
      setRefreshing(false)
    }
  }

  function getPriorityColor(priority: string) {
    switch (priority) {
      case 'high': return 'bg-red-100 text-red-800 border-red-300'
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-300'
      case 'low': return 'bg-blue-100 text-blue-800 border-blue-300'
      default: return 'bg-gray-100 text-gray-800 border-gray-300'
    }
  }

  function getConfidenceColor(confidence: number) {
    if (confidence >= 85) return 'bg-green-100 text-green-800 border-green-300'
    if (confidence >= 70) return 'bg-yellow-100 text-yellow-800 border-yellow-300'
    return 'bg-red-100 text-red-800 border-red-300'
  }

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-gray-400" />
            <p className="text-gray-500">Loading API discoveries...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">API Schema Discoveries</h1>
          <p className="text-gray-600 mt-2">
            Review discovered API endpoints and suggested mappings to CommandCenter schema
          </p>
        </div>
        <Button onClick={triggerDiscovery} disabled={refreshing}>
          {refreshing ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
              Running Discovery...
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-2" />
              Run Discovery Now
            </>
          )}
        </Button>
      </div>

      {discoveries.length === 0 ? (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>No discoveries yet</AlertTitle>
          <AlertDescription>
            Run the API Schema Discovery Agent to analyze your integrations and discover available endpoints.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: Discovery list */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <CardTitle>Recent Discoveries</CardTitle>
                <CardDescription>
                  {discoveries.length} integration{discoveries.length !== 1 ? 's' : ''} analyzed
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
                      onClick={() => setSelectedDiscovery(discovery)}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{discovery.provider}</Badge>
                            {discovery.integration?.business?.name && (
                              <span className="text-sm text-gray-600">
                                {discovery.integration.business.name}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 mt-1">
                            {new Date(discovery.discovered_at).toLocaleDateString()}
                          </p>
                        </div>
                        {discovery.recommendations?.length > 0 && (
                          <Badge variant="destructive" className="ml-2">
                            {discovery.recommendations.length} recs
                          </Badge>
                        )}
                      </div>
                      {discovery.discoveries?.endpoints_explored && (
                        <p className="text-sm mt-2">
                          {discovery.discoveries.endpoints_explored} endpoints explored
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right column: Discovery details */}
          <div className="lg:col-span-2">
            {selectedDiscovery ? (
              <Card>
                <CardHeader>
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        {selectedDiscovery.provider} Discovery
                        <Badge variant="outline">
                          {selectedDiscovery.discoveries?.endpoints_explored || 0} endpoints
                        </Badge>
                      </CardTitle>
                      <CardDescription>
                        Discovered {new Date(selectedDiscovery.discovered_at).toLocaleString()}
                      </CardDescription>
                    </div>
                    {selectedDiscovery.generated_code && (
                      <Button variant="outline" size="sm">
                        <Download className="h-4 w-4 mr-2" />
                        Download Config
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="recommendations">
                    <TabsList className="grid w-full grid-cols-4">
                      <TabsTrigger value="recommendations">Recommendations</TabsTrigger>
                      <TabsTrigger value="mappings">Mappings</TabsTrigger>
                      <TabsTrigger value="config">Sync Config</TabsTrigger>
                      <TabsTrigger value="raw">Raw Data</TabsTrigger>
                    </TabsList>

                    <TabsContent value="recommendations" className="space-y-4">
                      {selectedDiscovery.recommendations?.length > 0 ? (
                        selectedDiscovery.recommendations.map((rec: any, index: number) => (
                          <Alert key={index} className={getPriorityColor(rec.priority)}>
                            {rec.priority === 'high' ? (
                              <AlertTriangle className="h-4 w-4" />
                            ) : rec.priority === 'medium' ? (
                              <AlertTriangle className="h-4 w-4" />
                            ) : (
                              <Info className="h-4 w-4" />
                            )}
                            <AlertTitle className="capitalize">{rec.type.replace('_', ' ')}</AlertTitle>
                            <AlertDescription>
                              <div className="mt-2">
                                <p><strong>Endpoint:</strong> {rec.endpoint}</p>
                                <p><strong>Reasoning:</strong> {rec.reasoning}</p>
                                {rec.business_value && (
                                  <p><strong>Business Value:</strong> {rec.business_value}</p>
                                )}
                                {rec.fields && (
                                  <p><strong>Fields:</strong> {rec.fields.join(', ')}</p>
                                )}
                              </div>
                            </AlertDescription>
                          </Alert>
                        ))
                      ) : (
                        <Alert>
                          <CheckCircle className="h-4 w-4" />
                          <AlertTitle>No recommendations</AlertTitle>
                          <AlertDescription>
                            All discovered endpoints appear to be properly configured.
                          </AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>

                    <TabsContent value="mappings" className="space-y-4">
                      {selectedDiscovery.suggested_mappings?.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b">
                                <th className="text-left p-2">API Field</th>
                                <th className="text-left p-2">CommandCenter Table</th>
                                <th className="text-left p-2">CommandCenter Field</th>
                                <th className="text-left p-2">Confidence</th>
                                <th className="text-left p-2">Reasoning</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedDiscovery.suggested_mappings.map((mapping: any, index: number) => (
                                <tr key={index} className="border-b hover:bg-gray-50">
                                  <td className="p-2 font-mono text-xs">{mapping.fortnox_field}</td>
                                  <td className="p-2">{mapping.commandcenter_table}</td>
                                  <td className="p-2">{mapping.commandcenter_field}</td>
                                  <td className="p-2">
                                    <Badge className={getConfidenceColor(mapping.confidence)}>
                                      {mapping.confidence}%
                                    </Badge>
                                  </td>
                                  <td className="p-2 text-xs text-gray-600">{mapping.reasoning}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <Alert>
                          <Info className="h-4 w-4" />
                          <AlertTitle>No mappings found</AlertTitle>
                          <AlertDescription>
                            No suggested mappings available for this discovery.
                          </AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>

                    <TabsContent value="config">
                      {selectedDiscovery.generated_code ? (
                        <div className="space-y-4">
                          <div>
                            <h4 className="font-medium mb-2">Generated Sync Engine Configuration</h4>
                            <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs">
                              {selectedDiscovery.generated_code}
                            </pre>
                          </div>
                          {selectedDiscovery.table_sql && selectedDiscovery.table_sql.length > 0 && (
                            <div>
                              <h4 className="font-medium mb-2">SQL for New Tables</h4>
                              {selectedDiscovery.table_sql.map((sql, index) => (
                                <pre key={index} className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs mb-2">
                                  {sql}
                                </pre>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <Alert>
                          <Info className="h-4 w-4" />
                          <AlertTitle>No configuration generated</AlertTitle>
                          <AlertDescription>
                            Sync engine configuration not available for this discovery.
                          </AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>

                    <TabsContent value="raw">
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs">
                        {JSON.stringify(selectedDiscovery.discoveries, null, 2)}
                      </pre>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Select a Discovery</CardTitle>
                  <CardDescription>
                    Choose a discovery from the list to view details and recommendations
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-center py-12 text-gray-500">
                    <Info className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                    <p>No discovery selected</p>
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