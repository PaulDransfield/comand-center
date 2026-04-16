'use client'
// @ts-nocheck

import { useState, useEffect } from 'react'

export default function EnhancedApiDiscoveriesPage() {
  const [discoveries, setDiscoveries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [runningDiscovery, setRunningDiscovery] = useState(false)

  useEffect(() => { loadDiscoveries() }, [])

  async function loadDiscoveries() {
    try {
      const adminSecret = sessionStorage.getItem('admin_auth') || ''
      const res = await fetch('/api/admin/trigger-enhanced-discovery', {
        headers: { 'Authorization': `Bearer ${adminSecret}` }
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setDiscoveries(json.discoveries || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  async function runScan() {
    setRunningDiscovery(true)
    const adminSecret = sessionStorage.getItem('admin_auth') || ''
    try {
      const res = await fetch('/api/admin/trigger-enhanced-discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminSecret}` }
      })
      const result = await res.json()
      const errors = result.results?.filter((r: any) => r.status === 'error').map((r: any) => `• ${r.provider}: ${r.error}`).join('\n') || ''
      alert(`Scan complete\n\nCompleted: ${result.summary?.completed || 0}  Skipped: ${result.summary?.skipped || 0}  Errors: ${result.summary?.errors || 0}${errors ? '\n\n' + errors : ''}`)
      await loadDiscoveries()
    } catch (e: any) {
      alert(`Error: ${e.message}`)
    } finally {
      setRunningDiscovery(false)
    }
  }

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  // Build a ready-to-paste Claude Code prompt for a business insight
  function insightPrompt(discovery: any, insight: any): string {
    const analysis = discovery.analysis_result || {}
    return `CommandCenter improvement — ${discovery.provider} (${discovery.provider_type})

INSIGHT: ${insight.insight}
IMPACT: ${insight.impact} | PRIORITY: ${insight.priority}
ACTION: ${insight.suggested_implementation}

CONTEXT:
- Provider: ${discovery.provider} (${discovery.data_type} data)
- Data available in: ${analysis.primary_table || 'staff_logs / revenue_logs'}
- Confidence: ${discovery.confidence_score}%

Please implement this improvement in CommandCenter. Reference the existing pages (dashboard, staff, tracker, revenue, departments) and use the data already synced in Supabase. Show me what you plan to build before writing any code.`
  }

  // Build a ready-to-paste Claude Code prompt for an unused field
  function unusedFieldPrompt(discovery: any, field: any): string {
    const analysis = discovery.analysis_result || {}
    return `CommandCenter — add unused data field from ${discovery.provider}

FIELD: ${field.field_path} (${field.field_type})
POTENTIAL USE: ${field.potential_use}
BUSINESS VALUE: ${field.business_value} | IMPLEMENTATION EFFORT: ${field.implementation_effort}
RECOMMENDED ACTION: ${field.suggested_action}

CONTEXT:
- This field comes from ${discovery.provider} (${discovery.provider_type})
- It maps to the ${analysis.primary_table || 'staff_logs / revenue_logs'} table
- The data is already being synced — we just need to surface it in the UI

Please implement this in CommandCenter. Show me what you plan to build before writing any code.`
  }

  // Build a prompt for a field mapping gap
  function mappingPrompt(discovery: any, mapping: any): string {
    return `CommandCenter — improve data mapping for ${discovery.provider}

FIELD: ${mapping.source_field} → ${mapping.target_table}.${mapping.target_field}
CONFIDENCE: ${mapping.confidence}%
TRANSFORMATION NEEDED: ${(mapping.transformation_needed || []).join(', ') || 'none'}
REASONING: ${mapping.reasoning}

This field from ${discovery.provider} is mapped but may not be fully utilised in the UI. Please check if this data is being displayed correctly in CommandCenter and suggest improvements. Show me the plan before writing any code.`
  }

  const priorityColor = (p: string) => p === 'high' ? '#dc2626' : p === 'medium' ? '#d97706' : '#16a34a'
  const valueColor = (v: string) => v === 'high' ? '#7c3aed' : v === 'medium' ? '#2563eb' : '#6b7280'
  const effortColor = (e: string) => e === 'low' ? '#16a34a' : e === 'medium' ? '#d97706' : '#dc2626'

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading discoveries...</div>
  )

  return (
    <div style={{ minHeight: '100vh', background: '#f3f4f6', padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1f2e' }}>API Discovery Insights</div>
            <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>
              Click any insight or unused field to get a ready-to-paste Claude Code prompt
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <a href="/admin" style={{ padding: '8px 16px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, color: '#374151', textDecoration: 'none' }}>
              Back to Admin
            </a>
            <button onClick={runScan} disabled={runningDiscovery} style={{ padding: '8px 16px', background: runningDiscovery ? '#93c5fd' : '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: runningDiscovery ? 'not-allowed' : 'pointer' }}>
              {runningDiscovery ? 'Scanning...' : 'Run Scan'}
            </button>
          </div>
        </div>

        {discoveries.length === 0 ? (
          <div style={{ background: 'white', borderRadius: 12, padding: 40, textAlign: 'center', color: '#6b7280' }}>
            No discoveries yet. Run a scan to analyse your integrations.
          </div>
        ) : discoveries.map(discovery => {
          const analysis = discovery.analysis_result || {}
          const insights = analysis.business_insights || []
          const unusedFields = analysis.unused_fields || []
          const fieldMappings = analysis.field_mappings || []
          const isOpen = expanded === discovery.id
          const tab = activeTab[discovery.id] || 'insights'
          const confidenceColor = discovery.confidence_score >= 85 ? '#16a34a' : discovery.confidence_score >= 70 ? '#d97706' : '#dc2626'

          return (
            <div key={discovery.id} style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', marginBottom: 16, overflow: 'hidden' }}>

              {/* Card header — click to expand */}
              <div
                onClick={() => setExpanded(isOpen ? null : discovery.id)}
                style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1f2e', textTransform: 'capitalize' }}>{discovery.provider}</div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{discovery.provider_type} · {discovery.data_type} · {new Date(discovery.discovered_at).toLocaleDateString('sv-SE')}</div>
                  </div>
                  <span style={{ padding: '2px 10px', borderRadius: 20, background: confidenceColor + '15', color: confidenceColor, fontSize: 12, fontWeight: 600 }}>
                    {discovery.confidence_score}% confidence
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                    <span style={{ color: '#7c3aed', fontWeight: 600 }}>{insights.length} insights</span>
                    <span style={{ color: '#2563eb', fontWeight: 600 }}>{unusedFields.length} unused fields</span>
                    <span style={{ color: '#6b7280' }}>{fieldMappings.length} mappings</span>
                  </div>
                  <span style={{ color: '#9ca3af', fontSize: 18 }}>{isOpen ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {isOpen && (
                <div style={{ borderTop: '1px solid #f3f4f6' }}>

                  {/* Tabs */}
                  <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 20px' }}>
                    {[
                      { key: 'insights', label: `Business Insights (${insights.length})` },
                      { key: 'unused', label: `Unused Fields (${unusedFields.length})` },
                      { key: 'mappings', label: `Field Mappings (${fieldMappings.length})` },
                    ].map(t => (
                      <button
                        key={t.key}
                        onClick={() => setActiveTab(prev => ({ ...prev, [discovery.id]: t.key }))}
                        style={{
                          padding: '12px 16px', border: 'none', background: 'none', cursor: 'pointer',
                          fontSize: 13, fontWeight: tab === t.key ? 700 : 400,
                          color: tab === t.key ? '#1a1f2e' : '#6b7280',
                          borderBottom: tab === t.key ? '2px solid #1a1f2e' : '2px solid transparent',
                          marginBottom: -1
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div style={{ padding: 20 }}>

                    {/* BUSINESS INSIGHTS TAB */}
                    {tab === 'insights' && (
                      <div>
                        {insights.length === 0 ? (
                          <p style={{ color: '#9ca3af', fontSize: 13 }}>No insights found.</p>
                        ) : insights.map((insight: any, i: number) => {
                          const promptId = `insight-${discovery.id}-${i}`
                          const prompt = insightPrompt(discovery, insight)
                          return (
                            <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 12 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                                    <span style={{ padding: '2px 8px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>{insight.impact}</span>
                                    <span style={{ padding: '2px 8px', borderRadius: 4, background: priorityColor(insight.priority) + '15', color: priorityColor(insight.priority), fontSize: 11, fontWeight: 600 }}>
                                      {insight.priority} priority
                                    </span>
                                  </div>
                                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1f2e', marginBottom: 6 }}>{insight.insight}</div>
                                  <div style={{ fontSize: 13, color: '#6b7280' }}>Action: {insight.suggested_implementation}</div>
                                </div>
                                <button
                                  onClick={() => copy(prompt, promptId)}
                                  style={{
                                    padding: '8px 14px', borderRadius: 6, border: '1px solid #e5e7eb',
                                    background: copied === promptId ? '#dcfce7' : 'white',
                                    color: copied === promptId ? '#16a34a' : '#374151',
                                    fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0
                                  }}
                                >
                                  {copied === promptId ? '✓ Copied' : 'Copy prompt'}
                                </button>
                              </div>
                              {/* Preview of the prompt */}
                              <details style={{ marginTop: 10 }}>
                                <summary style={{ fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>Preview Claude Code prompt</summary>
                                <pre style={{ marginTop: 8, padding: 12, background: '#f8fafc', borderRadius: 6, fontSize: 11, color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid #e5e7eb' }}>
                                  {prompt}
                                </pre>
                              </details>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* UNUSED FIELDS TAB */}
                    {tab === 'unused' && (
                      <div>
                        {unusedFields.length === 0 ? (
                          <p style={{ color: '#9ca3af', fontSize: 13 }}>No unused fields found.</p>
                        ) : unusedFields.map((field: any, i: number) => {
                          const promptId = `field-${discovery.id}-${i}`
                          const prompt = unusedFieldPrompt(discovery, field)
                          return (
                            <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 12 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                                    <span style={{ padding: '2px 8px', borderRadius: 4, background: '#f3f4f6', color: '#374151', fontSize: 11, fontWeight: 700, fontFamily: 'monospace' }}>
                                      {field.field_path}
                                    </span>
                                    <span style={{ padding: '2px 8px', borderRadius: 4, background: valueColor(field.business_value) + '15', color: valueColor(field.business_value), fontSize: 11, fontWeight: 600 }}>
                                      {field.business_value} value
                                    </span>
                                    <span style={{ padding: '2px 8px', borderRadius: 4, background: effortColor(field.implementation_effort) + '15', color: effortColor(field.implementation_effort), fontSize: 11, fontWeight: 600 }}>
                                      {field.implementation_effort} effort
                                    </span>
                                    <span style={{ padding: '2px 8px', borderRadius: 4, background: field.suggested_action === 'map_now' ? '#dcfce7' : '#f3f4f6', color: field.suggested_action === 'map_now' ? '#16a34a' : '#6b7280', fontSize: 11, fontWeight: 600 }}>
                                      {field.suggested_action?.replace('_', ' ')}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1f2e', marginBottom: 4 }}>{field.potential_use}</div>
                                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{field.field_type} field</div>
                                </div>
                                <button
                                  onClick={() => copy(prompt, promptId)}
                                  style={{
                                    padding: '8px 14px', borderRadius: 6, border: '1px solid #e5e7eb',
                                    background: copied === promptId ? '#dcfce7' : 'white',
                                    color: copied === promptId ? '#16a34a' : '#374151',
                                    fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0
                                  }}
                                >
                                  {copied === promptId ? '✓ Copied' : 'Copy prompt'}
                                </button>
                              </div>
                              <details style={{ marginTop: 10 }}>
                                <summary style={{ fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>Preview Claude Code prompt</summary>
                                <pre style={{ marginTop: 8, padding: 12, background: '#f8fafc', borderRadius: 6, fontSize: 11, color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid #e5e7eb' }}>
                                  {prompt}
                                </pre>
                              </details>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* FIELD MAPPINGS TAB */}
                    {tab === 'mappings' && (
                      <div>
                        {fieldMappings.length === 0 ? (
                          <p style={{ color: '#9ca3af', fontSize: 13 }}>No field mappings found.</p>
                        ) : fieldMappings.map((mapping: any, i: number) => {
                          const promptId = `mapping-${discovery.id}-${i}`
                          const prompt = mappingPrompt(discovery, mapping)
                          const confColor = mapping.confidence >= 85 ? '#16a34a' : mapping.confidence >= 70 ? '#d97706' : '#dc2626'
                          return (
                            <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, marginBottom: 10 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                                    <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#1a1f2e' }}>{mapping.source_field}</span>
                                    <span style={{ color: '#9ca3af' }}>→</span>
                                    <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#2563eb' }}>{mapping.target_table}.{mapping.target_field}</span>
                                    <span style={{ padding: '1px 7px', borderRadius: 4, background: confColor + '15', color: confColor, fontSize: 11, fontWeight: 600 }}>
                                      {mapping.confidence}%
                                    </span>
                                  </div>
                                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{mapping.reasoning}</div>
                                  {mapping.transformation_needed?.length > 0 && (
                                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                                      Transforms: {mapping.transformation_needed.join(', ')}
                                    </div>
                                  )}
                                </div>
                                <button
                                  onClick={() => copy(prompt, promptId)}
                                  style={{
                                    padding: '6px 12px', borderRadius: 6, border: '1px solid #e5e7eb',
                                    background: copied === promptId ? '#dcfce7' : 'white',
                                    color: copied === promptId ? '#16a34a' : '#374151',
                                    fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0
                                  }}
                                >
                                  {copied === promptId ? '✓ Copied' : 'Copy prompt'}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
