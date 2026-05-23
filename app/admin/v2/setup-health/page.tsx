'use client'
// app/admin/v2/setup-health/page.tsx
//
// Phase 3 — Admin org-wide setup health rollup. One row per business,
// sorted by severity. Lets ops spot customers whose data quality has
// drifted and proactively reach out.

import { useState } from 'react'
import { useAdminData } from '@/lib/admin/v2/use-admin-data'
import { adminFetch }   from '@/lib/admin/v2/api-client'

type Overall = 'ok' | 'warn' | 'fail' | 'pending' | 'unknown'

interface FailingCheck {
  key:    string
  label:  string
  status: 'warn' | 'fail'
  detail: string
}
interface Row {
  business_id:           string
  business_name:         string
  org_id:                string
  org_name:              string | null
  vat_filing_cadence:    'monthly' | 'quarterly' | 'annually' | null
  overall:               Overall
  counts:                Record<string, number> | null
  failing_checks:        FailingCheck[]
  evaluated_at:          string | null
  updated_minutes_ago:   number | null
  fortnox_status:        string | null
  fortnox_last_sync_at:  string | null
}
interface Response {
  businesses:   Row[]
  summary:      {
    total: number; ok: number; warn: number; fail: number
    pending: number; unknown: number; no_fortnox: number
  }
  generated_at: string
}

export default function SetupHealthPage() {
  const { data, loading, error, refetch } = useAdminData<Response>('/api/admin/v2/setup-health')
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [expanded,   setExpanded]   = useState<Record<string, boolean>>({})

  const refreshOne = async (bizId: string) => {
    setRefreshing(prev => ({ ...prev, [bizId]: true }))
    try {
      await adminFetch('/api/admin/v2/setup-health/refresh', {
        method: 'POST',
        body:   JSON.stringify({ business_id: bizId }),
      })
      await refetch()
    } catch (e: any) {
      alert(`Refresh failed: ${e?.message ?? e}`)
    } finally {
      setRefreshing(prev => ({ ...prev, [bizId]: false }))
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111', margin: 0 }}>Customer setup health</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
            12 readiness checks per Fortnox-connected business. Refreshed daily 07:00 UTC + on demand.
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={loading}
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 500,
            background: '#fff', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? 'Loading…' : 'Reload list'}
        </button>
      </div>

      {error && (
        <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fecaca',
                      borderRadius: 6, color: '#991b1b', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 16 }}>
            <SummaryTile label="Total" value={data.summary.total} tone="ink" />
            <SummaryTile label="Healthy" value={data.summary.ok} tone="ok" />
            <SummaryTile label="Pending" value={data.summary.pending} tone="pending" />
            <SummaryTile label="Warnings" value={data.summary.warn} tone="warn" />
            <SummaryTile label="Failing" value={data.summary.fail} tone="fail" />
            <SummaryTile label="No data" value={data.summary.unknown + data.summary.no_fortnox} tone="unknown" />
          </div>

          {/* Rollup table */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={th()}>Business</th>
                  <th style={th()}>Organisation</th>
                  <th style={th()}>Status</th>
                  <th style={th()}>Counts</th>
                  <th style={th()}>Cadence</th>
                  <th style={th()}>Last eval</th>
                  <th style={th()}>Fortnox</th>
                  <th style={{ ...th(), textAlign: 'right' as const }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.businesses.map(r => (
                  <>
                    <tr key={r.business_id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={td()}>
                        <button
                          onClick={() => setExpanded(p => ({ ...p, [r.business_id]: !p[r.business_id] }))}
                          style={{ background: 'transparent', border: 'none', color: '#111',
                                   fontWeight: 500, cursor: 'pointer', padding: 0, fontSize: 13,
                                   textAlign: 'left' as const }}
                        >
                          {(expanded[r.business_id] ? '▾ ' : '▸ ') + r.business_name}
                        </button>
                      </td>
                      <td style={{ ...td(), color: '#6b7280' }}>{r.org_name ?? '—'}</td>
                      <td style={td()}><StatusBadge status={r.overall} /></td>
                      <td style={{ ...td(), fontSize: 11, color: '#6b7280' }}>
                        {r.counts
                          ? `${r.counts.ok ?? 0}✓ ${r.counts.warn ?? 0}! ${r.counts.fail ?? 0}✕ ${r.counts.pending ?? 0}⋯`
                          : '—'}
                      </td>
                      <td style={{ ...td(), fontSize: 11, color: '#6b7280' }}>
                        {r.vat_filing_cadence ?? <span style={{ color: '#d97706' }}>not set</span>}
                      </td>
                      <td style={{ ...td(), fontSize: 11, color: '#6b7280' }}>
                        {r.updated_minutes_ago == null
                          ? '—'
                          : r.updated_minutes_ago < 60   ? `${r.updated_minutes_ago}m ago`
                          : r.updated_minutes_ago < 1440 ? `${Math.floor(r.updated_minutes_ago / 60)}h ago`
                          :                                `${Math.floor(r.updated_minutes_ago / 1440)}d ago`}
                      </td>
                      <td style={{ ...td(), fontSize: 11, color: r.fortnox_status === 'connected' ? '#059669' : '#dc2626' }}>
                        {r.fortnox_status ?? 'not connected'}
                      </td>
                      <td style={{ ...td(), textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                        <button
                          onClick={() => refreshOne(r.business_id)}
                          disabled={refreshing[r.business_id]}
                          style={smallBtn}
                        >
                          {refreshing[r.business_id] ? '…' : 'Re-run'}
                        </button>
                      </td>
                    </tr>
                    {expanded[r.business_id] && r.failing_checks.length > 0 && (
                      <tr style={{ background: '#fafafa' }}>
                        <td colSpan={8} style={{ padding: '10px 16px' }}>
                          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>
                            Failing / warning checks:
                          </div>
                          {r.failing_checks.map(c => (
                            <div key={c.key} style={{ display: 'flex', gap: 8, fontSize: 12,
                                                       padding: '4px 0', alignItems: 'baseline' }}>
                              <span style={{ width: 16, color: c.status === 'fail' ? '#dc2626' : '#d97706' }}>
                                {c.status === 'fail' ? '✕' : '!'}
                              </span>
                              <span style={{ width: 180, fontWeight: 500, color: '#374151' }}>{c.label}</span>
                              <span style={{ color: '#6b7280', flex: 1 }}>{c.detail}</span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'warn' | 'fail' | 'pending' | 'ink' | 'unknown' }) {
  const colorMap: Record<string, string> = {
    ok: '#059669', warn: '#d97706', fail: '#dc2626', pending: '#6366f1', ink: '#111', unknown: '#9ca3af',
  }
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: colorMap[tone], marginTop: 2 }}>{value}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: Overall }) {
  const styles: Record<Overall, { bg: string; color: string; label: string }> = {
    ok:      { bg: '#d1fae5', color: '#065f46', label: 'Healthy' },
    warn:    { bg: '#fef3c7', color: '#92400e', label: 'Warnings' },
    fail:    { bg: '#fee2e2', color: '#991b1b', label: 'Failing' },
    pending: { bg: '#e0e7ff', color: '#3730a3', label: 'Pending'  },
    unknown: { bg: '#f3f4f6', color: '#6b7280', label: 'No data'  },
  }
  const s = styles[status]
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      background: s.bg, color: s.color,
      borderRadius: 10, fontSize: 11, fontWeight: 500,
    }}>
      {s.label}
    </span>
  )
}

function th(): React.CSSProperties {
  return {
    padding:    '8px 12px',
    fontSize:   11,
    fontWeight: 600,
    color:      '#6b7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    textAlign:  'left' as const,
    borderBottom: '1px solid #e5e7eb',
  }
}

function td(): React.CSSProperties {
  return { padding: '10px 12px', fontSize: 13, color: '#374151' }
}

const smallBtn: React.CSSProperties = {
  padding:    '4px 10px',
  fontSize:   11,
  fontWeight: 500,
  background: '#fff',
  color:      '#374151',
  border:     '1px solid #d1d5db',
  borderRadius: 4,
  cursor:     'pointer',
}
