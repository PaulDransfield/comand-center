'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'

interface Alert {
  id: string; alert_type: string; severity: string; title: string
  description: string; metric_value: number; expected_value: number
  deviation_pct: number; period_date: string; is_read: boolean
  is_dismissed: boolean; created_at: string
  businesses: { name: string; city: string | null } | null
}

const SEV: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  critical: { bg: '#fef2f2', border: '#fecaca', text: '#991b1b', dot: '#dc2626' },
  high:     { bg: '#fff7ed', border: '#fed7aa', text: '#9a3412', dot: '#ea580c' },
  medium:   { bg: '#fefce8', border: '#fde68a', text: '#854d0e', dot: '#ca8a04' },
  low:      { bg: '#f0f9ff', border: '#bae6fd', text: '#075985', dot: '#0284c7' },
}

const TYPE_LABEL: Record<string, string> = {
  revenue_drop:    'Revenue drop',
  food_cost_spike: 'Food cost spike',
  staff_cost_spike:'Staff cost spike',
  invoice_spike:   'Invoice anomaly',
  covers_drop:     'Covers drop',
}

const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export default function AlertsPage() {
  const [alerts,   setAlerts]  = useState<Alert[]>([])
  const [loading,  setLoading] = useState(true)
  const [running,  setRunning] = useState(false)
  const [showAll,  setShowAll] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const res  = await fetch(`/api/alerts${showAll ? '?include_read=true' : ''}`)
    const data = await res.json()
    if (Array.isArray(data)) setAlerts(data)
    setLoading(false)
  }, [showAll])

  useEffect(() => { load() }, [load])

  async function action(id: string, type: 'mark_read' | 'dismiss') {
    await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: type }) })
    load()
  }

  async function runCheck() {
    setRunning(true)
    const res  = await fetch('/api/cron/anomaly-check?secret=commandcenter123')
    const data = await res.json()
    setRunning(false)
    load()
    if (data.alerts_created === 0) alert('No anomalies detected.')
    else alert(`${data.alerts_created} new alert${data.alerts_created !== 1 ? 's' : ''} created.`)
  }

  const critical = alerts.filter(a => a.severity === 'critical').length
  const high     = alerts.filter(a => a.severity === 'high').length
  const unread   = alerts.filter(a => !a.is_read).length

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 800 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Alerts</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Automatic anomaly detection · updated daily at 06:00</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowAll(s => !s)}
              style={{ padding: '8px 14px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
              {showAll ? 'Unread only' : 'Show all'}
            </button>
            <button onClick={runCheck} disabled={running}
              style={{ padding: '8px 16px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {running ? 'Checking...' : 'Run check now'}
            </button>
          </div>
        </div>

        {/* Summary KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Critical', value: critical, color: critical > 0 ? '#dc2626' : '#111' },
            { label: 'High',     value: high,     color: high     > 0 ? '#ea580c' : '#111' },
            { label: 'Unread',   value: unread,   color: unread   > 0 ? '#1a1f2e' : '#111' },
            { label: 'Total',    value: alerts.length, color: '#111' },
          ].map(k => (
            <div key={k.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: k.color }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Alert list */}
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : alerts.length === 0 ? (
          <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
            <div style={{ fontWeight: 600, color: '#15803d', fontSize: 15, marginBottom: 6 }}>All clear</div>
            <div style={{ fontSize: 13, color: '#9ca3af' }}>No active alerts. Click "Run check now" to scan for anomalies.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {alerts.map(alert => {
              const s = SEV[alert.severity] ?? SEV.low
              return (
                <div key={alert.id} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 12, padding: '16px 20px', opacity: alert.is_read ? 0.7 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: s.text }}>
                          {alert.severity} · {TYPE_LABEL[alert.alert_type] ?? alert.alert_type}
                        </span>
                        {alert.businesses && (
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>
                            {alert.businesses.name}{alert.businesses.city ? ` (${alert.businesses.city})` : ''}
                          </span>
                        )}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#111', marginBottom: 4 }}>{alert.title}</div>
                      <div style={{ fontSize: 13, color: '#555', lineHeight: 1.5 }}>{alert.description}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                        Detected {fmtDate(alert.created_at)} · Period: {fmtDate(alert.period_date)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginLeft: 16, flexShrink: 0 }}>
                      {!alert.is_read && (
                        <button onClick={() => action(alert.id, 'mark_read')}
                          style={{ padding: '5px 10px', background: 'white', border: `1px solid ${s.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', color: s.text }}>
                          Mark read
                        </button>
                      )}
                      <button onClick={() => action(alert.id, 'dismiss')}
                        style={{ padding: '5px 10px', background: 'white', border: `1px solid ${s.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', color: '#9ca3af' }}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </AppShell>
  )
}
