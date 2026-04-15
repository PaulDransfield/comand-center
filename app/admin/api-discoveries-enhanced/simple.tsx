// app/admin/api-discoveries-enhanced/simple.tsx
// Minimal admin interface for Enhanced API schema discoveries

'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

interface EnhancedApiDiscovery {
  id: string
  integration_id: string
  provider: string
  provider_type: string
  confidence_score: number
  data_type: string
  unused_fields_count: number
  business_insights_count: number
  discovered_at: string
}

export default function SimpleEnhancedApiDiscoveriesPage() {
  const [discoveries, setDiscoveries] = useState<EnhancedApiDiscovery[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    loadEnhancedDiscoveries()
  }, [])

  async function loadEnhancedDiscoveries() {
    try {
      const { data, error } = await supabase
        .from('api_discoveries_enhanced')
        .select('*')
        .order('discovered_at', { ascending: false })

      if (error) throw error
      setDiscoveries(data || [])
    } catch (error) {
      console.error('Failed to load enhanced discoveries:', error)
    } finally {
      setLoading(false)
    }
  }

  async function triggerEnhancedDiscovery() {
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
      
      // Reload discoveries
      await loadEnhancedDiscoveries()
    } catch (error: any) {
      console.error('Failed to trigger enhanced discovery:', error)
      alert(`Error: ${error.message}`)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ 
              animation: 'spin 1s linear infinite',
              borderRadius: '50%',
              height: '32px',
              width: '32px',
              borderBottom: '2px solid #111827',
              margin: '0 auto 16px'
            }}></div>
            <p style={{ color: '#6b7280' }}>Loading enhanced API discoveries...</p>
          </div>
        </div>
      </div>
    )
  }

  const totalUnusedFields = discoveries.reduce((sum, d) => sum + d.unused_fields_count, 0)
  const totalInsights = discoveries.reduce((sum, d) => sum + d.business_insights_count, 0)
  const avgConfidence = discoveries.length > 0 
    ? Math.round(discoveries.reduce((sum, d) => sum + d.confidence_score, 0) / discoveries.length)
    : 0

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '30px', fontWeight: 'bold' }}>Enhanced API Schema Discoveries</h1>
          <p style={{ color: '#6b7280', marginTop: '8px' }}>
            AI-powered analysis of API integrations with unused data identification
          </p>
        </div>
        <button 
          onClick={triggerEnhancedDiscovery}
          style={{
            backgroundColor: '#2563eb',
            color: 'white',
            fontWeight: '500',
            padding: '8px 16px',
            borderRadius: '8px',
            border: 'none',
            cursor: 'pointer'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#1d4ed8'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#2563eb'}
        >
          Run Enhanced Discovery
        </button>
      </div>

      {/* Stats Overview */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '16px',
        marginBottom: '24px'
      }}>
        <div style={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '14px', color: '#6b7280' }}>Total Discoveries</p>
              <p style={{ fontSize: '24px', fontWeight: 'bold' }}>{discoveries.length}</p>
            </div>
            <div style={{ fontSize: '24px' }}>📊</div>
          </div>
        </div>
        <div style={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '14px', color: '#6b7280' }}>Avg Confidence</p>
              <p style={{ fontSize: '24px', fontWeight: 'bold' }}>{avgConfidence}%</p>
            </div>
            <div style={{ fontSize: '24px' }}>🎯</div>
          </div>
        </div>
        <div style={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '14px', color: '#6b7280' }}>Unused Fields</p>
              <p style={{ fontSize: '24px', fontWeight: 'bold' }}>{totalUnusedFields}</p>
            </div>
            <div style={{ fontSize: '24px' }}>📈</div>
          </div>
        </div>
        <div style={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '14px', color: '#6b7280' }}>Business Insights</p>
              <p style={{ fontSize: '24px', fontWeight: 'bold' }}>{totalInsights}</p>
            </div>
            <div style={{ fontSize: '24px' }}>⚡</div>
          </div>
        </div>
      </div>

      {discoveries.length === 0 ? (
        <div style={{ backgroundColor: '#dbeafe', border: '1px solid #93c5fd', borderRadius: '8px', padding: '16px' }}>
          <div style={{ display: 'flex' }}>
            <div style={{ color: '#1d4ed8', marginRight: '12px' }}>ℹ️</div>
            <div>
              <h3 style={{ fontWeight: '500', color: '#1e40af' }}>No enhanced discoveries yet</h3>
              <p style={{ color: '#1e40af', fontSize: '14px', marginTop: '4px' }}>
                Run the Enhanced API Schema Discovery Agent to analyze your integrations with AI-powered insights.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
          <div style={{ borderBottom: '1px solid #e5e7eb', padding: '16px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: '600' }}>Enhanced Discoveries</h2>
            <p style={{ color: '#6b7280', fontSize: '14px' }}>
              {discoveries.length} integration{discoveries.length !== 1 ? 's' : ''} analyzed with AI
            </p>
          </div>
          <div style={{ padding: '16px' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '14px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <th style={{ textAlign: 'left', padding: '8px', fontWeight: '500' }}>Provider</th>
                    <th style={{ textAlign: 'left', padding: '8px', fontWeight: '500' }}>Type</th>
                    <th style={{ textAlign: 'left', padding: '8px', fontWeight: '500' }}>Confidence</th>
                    <th style={{ textAlign: 'left', padding: '8px', fontWeight: '500' }}>Unused Fields</th>
                    <th style={{ textAlign: 'left', padding: '8px', fontWeight: '500' }}>Insights</th>
                    <th style={{ textAlign: 'left', padding: '8px', fontWeight: '500' }}>Discovered</th>
                  </tr>
                </thead>
                <tbody>
                  {discoveries.map((discovery) => {
                    const confidenceColor = discovery.confidence_score >= 85 ? '#10b981' : 
                                           discovery.confidence_score >= 70 ? '#f59e0b' : '#ef4444'
                    return (
                      <tr key={discovery.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '12px 8px' }}>
                          <div style={{ fontWeight: '500' }}>{discovery.provider}</div>
                          <div style={{ fontSize: '12px', color: '#6b7280' }}>{discovery.data_type}</div>
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          <span style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            backgroundColor: '#f3f4f6',
                            color: '#374151',
                            fontSize: '12px'
                          }}>
                            {discovery.provider_type}
                          </span>
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          <span style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: '9999px',
                            backgroundColor: confidenceColor + '20',
                            color: confidenceColor,
                            fontSize: '12px',
                            fontWeight: '500'
                          }}>
                            {discovery.confidence_score}%
                          </span>
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          {discovery.unused_fields_count > 0 ? (
                            <span style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              border: '1px solid #d1d5db',
                              fontSize: '12px'
                            }}>
                              {discovery.unused_fields_count}
                            </span>
                          ) : (
                            <span style={{ color: '#9ca3af', fontSize: '12px' }}>None</span>
                          )}
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          {discovery.business_insights_count > 0 ? (
                            <span style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              border: '1px solid #c084fc',
                              backgroundColor: '#f3e8ff',
                              color: '#7c3aed',
                              fontSize: '12px'
                            }}>
                              {discovery.business_insights_count}
                            </span>
                          ) : (
                            <span style={{ color: '#9ca3af', fontSize: '12px' }}>None</span>
                          )}
                        </td>
                        <td style={{ padding: '12px 8px', color: '#6b7280', fontSize: '12px' }}>
                          {new Date(discovery.discovered_at).toLocaleDateString()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}