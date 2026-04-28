'use client'
// components/admin/v2/CustomerData.tsx
//
// Data sub-tab — per business: revenue_logs / staff_logs / daily_metrics
// / monthly_metrics / tracker_data freshness probes. Surfaces gaps (PK
// hasn't synced in N days, aggregator hasn't run since X) that the
// integrations status alone wouldn't show.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface BusinessProbe {
  id: string
  name: string
  revenue_logs:    { latest_date: string | null; rows_last_30d: number; age_days: number | null }
  staff_logs:      { latest_date: string | null; rows_last_30d: number; age_days: number | null }
  daily_metrics:   { latest_date: string | null; last_aggregated: string | null; age_days: number | null }
  monthly_metrics: { months_in_year: number; latest_month: number | null; last_aggregated: string }
  tracker_data:    { latest_period: string | null; latest_source: string | null; last_updated: string | null }
}

interface DataResponse {
  businesses: BusinessProbe[]
  generated_at: string
}

export function CustomerData({ orgId }: { orgId: string }) {
  const { data, loading, error } = useAdminData<DataResponse>(`/api/admin/v2/customers/${orgId}/data`)

  if (loading) return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading data probes…</div>
  if (error)   return <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12 }}>Error: {error}</div>
  if (!data || data.businesses.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10 }}>No businesses to probe.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      {data.businesses.map(b => (
        <BusinessCard key={b.id} probe={b} />
      ))}
    </div>
  )
}

function BusinessCard({ probe }: { probe: BusinessProbe }) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{probe.name}</div>
        <code style={{ fontSize: 10, color: '#9ca3af' }}>{probe.id.slice(0, 8)}…</code>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 0 }}>
        <Probe
          label="revenue_logs"
          value={probe.revenue_logs.latest_date ?? '—'}
          sub={`${probe.revenue_logs.rows_last_30d} rows / 30d`}
          ageDays={probe.revenue_logs.age_days}
        />
        <Probe
          label="staff_logs"
          value={probe.staff_logs.latest_date ?? '—'}
          sub={`${probe.staff_logs.rows_last_30d} rows / 30d`}
          ageDays={probe.staff_logs.age_days}
        />
        <Probe
          label="daily_metrics"
          value={probe.daily_metrics.latest_date ?? '—'}
          sub={probe.daily_metrics.last_aggregated ? `agg ${fmtDateTime(probe.daily_metrics.last_aggregated)}` : 'never aggregated'}
          ageDays={probe.daily_metrics.age_days}
        />
        <Probe
          label="monthly_metrics (yr)"
          value={probe.monthly_metrics.latest_month ? `month ${probe.monthly_metrics.latest_month}` : '—'}
          sub={`${probe.monthly_metrics.months_in_year} months written`}
          ageDays={null}
        />
        <Probe
          label="tracker_data"
          value={probe.tracker_data.latest_period ?? '—'}
          sub={probe.tracker_data.latest_source ? `source: ${probe.tracker_data.latest_source}` : 'no rows'}
          ageDays={null}
        />
      </div>
    </div>
  )
}

function Probe({ label, value, sub, ageDays }: { label: string; value: string; sub: string; ageDays: number | null }) {
  let tone: 'good' | 'warn' | 'bad' | 'neutral' = 'neutral'
  if (ageDays != null) {
    if (ageDays <= 1)      tone = 'good'
    else if (ageDays <= 3) tone = 'warn'
    else                   tone = 'bad'
  }
  const COLOR = { good: '#15803d', warn: '#d97706', bad: '#b91c1c', neutral: '#6b7280' }[tone]
  const BORDER = { good: '#bbf7d0', warn: '#fde68a', bad: '#fecaca', neutral: '#e5e7eb' }[tone]
  return (
    <div style={{ padding: '12px 14px', borderRight: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}` }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: '#9ca3af', textTransform: 'uppercase' as const }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, color: COLOR, marginTop: 4 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
        {sub}
        {ageDays != null && (
          <span style={{ marginLeft: 4, color: COLOR, fontWeight: 500 }}>
            · {ageDays === 0 ? 'today' : ageDays === 1 ? '1d old' : `${ageDays}d old`}
          </span>
        )}
      </div>
    </div>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)}`
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${fmtDate(iso)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
