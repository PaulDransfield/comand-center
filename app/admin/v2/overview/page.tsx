'use client'
// app/admin/v2/overview/page.tsx
// PR 2 — incidents strip + business KPIs.
//
// Two distinct sections:
//   1. Incidents strip (top) — "what needs Paul's attention right now"
//      Pulled from the new /api/admin/v2/incidents route.
//   2. Business KPIs (below) — recreated visually from the EXISTING
//      /api/admin/overview route (per the plan: don't build a new API
//      for KPIs in this PR).
//
// FIXES.md §0ac.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'
import { IncidentRow } from '@/components/admin/v2/IncidentRow'
import { KpiStrip } from '@/components/admin/v2/KpiStrip'
import type { Incident, KpiStat } from '@/lib/admin/v2/types'

interface OverviewKpis {
  total_customers:    number
  active_customers:   number
  trialing:           number
  at_risk:            number
  in_setup:           number
  churned:            number
  mrr_sek:            number
  signups_this_week:  number
  signups_last_week:  number
  ai_queries_month:   number
  ai_cost_usd_month:  number
}
interface OverviewResponse {
  kpis: OverviewKpis
}

export default function OverviewPage() {
  const incidents  = useAdminData<{ incidents: Incident[]; generated_at: string }>('/api/admin/v2/incidents')
  const overview   = useAdminData<OverviewResponse>('/api/admin/overview')

  return (
    <div>
      {/* ─── Incidents strip ─────────────────────────────────────────── */}
      <Section title="Needs your attention" subtitle="Stuck integrations, stale data, AI cost outliers">
        {incidents.loading ? (
          <Empty text="Loading incidents…" />
        ) : incidents.error ? (
          <Error text={incidents.error} />
        ) : (incidents.data?.incidents ?? []).length === 0 ? (
          <Empty text="Nothing on fire ✓" tone="good" />
        ) : (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10 }}>
            {incidents.data!.incidents.map((it, i) => (
              <IncidentRow key={`${it.kind}-${it.org_id}-${i}`} incident={it} />
            ))}
          </div>
        )}
      </Section>

      {/* ─── Business KPIs ───────────────────────────────────────────── */}
      <Section title="Business KPIs" subtitle="Customer count, MRR, signups, AI usage">
        {overview.loading ? (
          <Empty text="Loading KPIs…" />
        ) : overview.error ? (
          <Error text={overview.error} />
        ) : !overview.data ? (
          <Empty text="No KPI data" />
        ) : (
          <KpiStrip items={buildKpiItems(overview.data.kpis)} columns={4} />
        )}
      </Section>
    </div>
  )
}

function buildKpiItems(k: OverviewKpis): KpiStat[] {
  const signupDelta = k.signups_last_week > 0
    ? Math.round(((k.signups_this_week - k.signups_last_week) / k.signups_last_week) * 100)
    : null
  return [
    {
      label: 'MRR',
      value: `${k.mrr_sek.toLocaleString('en-GB').replace(/,/g, ' ')} kr`,
      sub:   `excl. trial · ${k.trialing} on trial`,
      tone:  'good',
    },
    {
      label: 'Customers',
      value: String(k.total_customers),
      sub:   `${k.active_customers} active · ${k.at_risk} at risk`,
      tone:  k.at_risk > 0 ? 'warn' : 'neutral',
    },
    {
      label: 'Signups this week',
      value: String(k.signups_this_week),
      sub:   signupDelta !== null
        ? `${signupDelta >= 0 ? '+' : ''}${signupDelta}% vs last week`
        : 'no prior data',
      tone:  signupDelta !== null ? (signupDelta >= 0 ? 'good' : 'bad') : 'neutral',
    },
    {
      label: 'In setup',
      value: String(k.in_setup),
      sub:   'connected, no sync yet',
      tone:  'neutral',
    },
    {
      label: 'AI queries / mo',
      value: k.ai_queries_month.toLocaleString('en-GB').replace(/,/g, ' '),
      sub:   `~$${k.ai_cost_usd_month.toFixed(2)} est.`,
      tone:  'neutral',
    },
    {
      label: 'Churned',
      value: String(k.churned),
      sub:   'deactivated',
      tone:  k.churned > 0 ? 'bad' : 'neutral',
    },
  ]
}

// ─── Atoms ──────────────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}

function Empty({ text, tone }: { text: string; tone?: 'good' | 'neutral' }) {
  return (
    <div style={{
      background:    'white',
      border:        '1px solid #e5e7eb',
      borderRadius:  10,
      padding:       '24px 16px',
      textAlign:     'center' as const,
      fontSize:      12,
      color:         tone === 'good' ? '#15803d' : '#9ca3af',
    }}>
      {text}
    </div>
  )
}

function Error({ text }: { text: string }) {
  return (
    <div style={{
      background:    '#fef2f2',
      border:        '1px solid #fecaca',
      borderRadius:  10,
      padding:       '14px 18px',
      fontSize:      12,
      color:         '#b91c1c',
    }}>
      {text}
    </div>
  )
}
