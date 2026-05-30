'use client'
// app/admin/v2/inventory-accuracy/page.tsx
//
// Admin-only metrics view for the D3 accuracy snapshots
// (LEARNING-LOOP-PHASE1-PLAN.md §4 + §7.2 "admin-only").
//
// Owner-facing surfacing is DELIBERATELY NOT BUILT here. Per §7.2:
// "the metric is about our model's performance, not the owner's
// business; 'our AI is 61% accurate' is easy to misread and quietly
// becomes an implied promise."
//
// Layout: per-org sections, with each (business + global) row showing
// segmented metrics across the latest snapshots. Compact sparkline-style
// trend would be nice; v1 is just a table.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { adminFetch } from '@/lib/admin/v2/api-client'

interface Snapshot {
  id:                            string
  org_id:                        string
  business_id:                   string | null
  snapshot_date:                 string
  window_days:                   number
  needs_review_outcomes_total:   number
  needs_review_outcomes_agreed:  number
  needs_review_agreement_pct:    number | null
  audit_sample_outcomes_total:   number
  audit_sample_outcomes_agreed:  number
  audit_sample_agreement_pct:    number | null
  audit_sample_confirmations:    number
  audit_sample_corrections:      number
  audit_sample_precision_pct:    number | null
  needs_review_lines_count:      number
  total_lines_in_window:         number
  needs_review_rate_pct:         number | null
  demotions_in_window:           number
  active_aliases_window_start:   number
  demotion_rate_pct:             number | null
  ai_create_new_count:           number
  owner_create_new_count:        number
  create_new_divergence_pct:     number | null
  rebate_noise_count:            number
  alert_level:                   'hard' | 'soft' | 'informational' | null
  alert_reason:                  string | null
  baseline_needs_review_pct:     number | null
  delta_vs_baseline_pp:          number | null
  computed_at:                   string
  businesses:                    null | { name: string }
  organisations:                 null | { name: string }
}

export default function InventoryAccuracyAdminPage() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [days,      setDays]      = useState(90)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    adminFetch<{ snapshots: Snapshot[] }>(`/api/admin/inventory-accuracy?days=${days}`)
      .then(r => { if (!cancelled) setSnapshots(r.snapshots ?? []) })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days])

  // Latest snapshot per (org, business). The list is ordered desc by date.
  const latestByScope = new Map<string, Snapshot>()
  for (const s of snapshots) {
    const key = `${s.org_id}|${s.business_id ?? 'global'}`
    if (!latestByScope.has(key)) latestByScope.set(key, s)
  }
  const latest = [...latestByScope.values()]

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400 }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: '#111827', letterSpacing: '-0.01em' }}>
        Inventory categorisation — accuracy snapshots
      </h1>
      <p style={{ margin: '4px 0 18px', fontSize: 12, color: '#6b7280', maxWidth: 800, lineHeight: 1.5 }}>
        Admin-only metric view for the categorisation learning loop. The §7.1 floor watches
        <code style={{ background: '#f3f4f6', padding: '1px 6px', borderRadius: 3, margin: '0 4px' }}>needs_review_agreement_pct</code>
        specifically — audit-sample is a separate trend with its own thresholds.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, fontSize: 12, alignItems: 'center' }}>
        <label>Window:</label>
        {[30, 60, 90, 180, 365].map(d => (
          <button key={d} onClick={() => setDays(d)} style={{
            padding: '4px 10px', fontSize: 11,
            background: days === d ? '#1a1f2e' : 'transparent',
            color:      days === d ? '#fff'    : '#374151',
            border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
          }}>{d}d</button>
        ))}
      </div>

      {loading && <div style={{ padding: 16, color: '#9ca3af', fontSize: 12 }}>Loading…</div>}
      {error && <div style={{ padding: 12, background: '#fee2e2', color: '#991b1b', borderRadius: 6, fontSize: 12 }}>{error}</div>}

      {!loading && latest.length === 0 && (
        <div style={{ padding: 24, background: '#f9fafb', borderRadius: 8, fontSize: 12, color: '#6b7280' }}>
          No snapshots yet. The daily cron runs at 02:30 UTC; trigger manually with
          {' '}<code>POST /api/cron/inventory-accuracy-snapshot</code> if needed.
        </div>
      )}

      {/* Latest-per-scope summary table */}
      {latest.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '20px 0 8px' }}>
            Latest snapshot per scope
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' as const }}>
              <thead>
                <tr style={{ background: '#f3f4f6', textAlign: 'left' as const }}>
                  <th style={th}>Org / Business</th>
                  <th style={th}>Date</th>
                  <th style={thNum}>Needs-review agreement</th>
                  <th style={thNum}>Audit-sample agreement</th>
                  <th style={thNum}>Audit precision</th>
                  <th style={thNum}>Needs-review rate</th>
                  <th style={thNum}>Demotion rate</th>
                  <th style={thNum}>Create_new divergence</th>
                  <th style={thNum}>Rebate noise</th>
                  <th style={th}>Alert</th>
                </tr>
              </thead>
              <tbody>
                {latest.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 500 }}>{s.businesses?.name ?? `(${s.organisations?.name} global)`}</div>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>{s.organisations?.name}</div>
                    </td>
                    <td style={td}>{s.snapshot_date}</td>
                    <td style={tdNum}>{fmtPct(s.needs_review_agreement_pct)} <SmallCount n={s.needs_review_outcomes_total} /></td>
                    <td style={tdNum}>{fmtPct(s.audit_sample_agreement_pct)} <SmallCount n={s.audit_sample_outcomes_total} /></td>
                    <td style={tdNum}>{fmtPct(s.audit_sample_precision_pct)} <SmallCount n={s.audit_sample_confirmations + s.audit_sample_corrections} /></td>
                    <td style={tdNum}>{fmtPct(s.needs_review_rate_pct)} <SmallCount n={s.total_lines_in_window} /></td>
                    <td style={tdNum}>{fmtPct(s.demotion_rate_pct)} <SmallCount n={s.demotions_in_window} /></td>
                    <td style={tdNum}>{fmtPct(s.create_new_divergence_pct, '+')} <SmallCount n={s.ai_create_new_count} /></td>
                    <td style={tdNum}>{s.rebate_noise_count}</td>
                    <td style={td}><AlertBadge level={s.alert_level} reason={s.alert_reason} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Trend table — flat list */}
      {snapshots.length > latest.length && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '24px 0 8px' }}>
            All snapshots (most recent first, {snapshots.length} rows)
          </h2>
          <div style={{ overflowX: 'auto', maxHeight: 600, overflowY: 'auto' as const }}>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' as const }}>
              <thead style={{ position: 'sticky' as const, top: 0, background: '#f3f4f6' }}>
                <tr style={{ textAlign: 'left' as const }}>
                  <th style={th}>Date</th>
                  <th style={th}>Scope</th>
                  <th style={thNum}>NR agree</th>
                  <th style={thNum}>AS agree</th>
                  <th style={thNum}>AS prec</th>
                  <th style={thNum}>Baseline</th>
                  <th style={thNum}>Δ pp</th>
                  <th style={th}>Alert</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <td style={td}>{s.snapshot_date}</td>
                    <td style={td}>{s.businesses?.name ?? `(${s.organisations?.name} global)`}</td>
                    <td style={tdNum}>{fmtPct(s.needs_review_agreement_pct)}</td>
                    <td style={tdNum}>{fmtPct(s.audit_sample_agreement_pct)}</td>
                    <td style={tdNum}>{fmtPct(s.audit_sample_precision_pct)}</td>
                    <td style={tdNum}>{fmtPct(s.baseline_needs_review_pct)}</td>
                    <td style={tdNum}>{s.delta_vs_baseline_pp == null ? '—' : `${s.delta_vs_baseline_pp > 0 ? '+' : ''}${s.delta_vs_baseline_pp.toFixed(1)}`}</td>
                    <td style={td}><AlertBadge level={s.alert_level} reason={s.alert_reason} compact /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

const th    = { padding: '8px 10px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #d1d5db', fontSize: 11 } as const
const td    = { padding: '6px 10px', color: '#374151' } as const
const thNum = { ...th, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }
const tdNum = { ...td, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }

function fmtPct(n: number | null | undefined, sign: '' | '+' = ''): string {
  if (n == null) return '—'
  const s = sign === '+' && n > 0 ? '+' : ''
  return `${s}${n.toFixed(1)}%`
}

function SmallCount({ n }: { n: number }) {
  return <span style={{ color: '#9ca3af', fontSize: 10, marginLeft: 4 }}>n={n}</span>
}

function AlertBadge({ level, reason, compact }: { level: 'hard' | 'soft' | 'informational' | null; reason: string | null; compact?: boolean }) {
  if (!level) return <span style={{ color: '#9ca3af', fontSize: 10 }}>—</span>
  const bg =
    level === 'hard' ? '#fee2e2' :
    level === 'soft' ? '#fef3c7' :
                       '#e0e7ff'
  const fg =
    level === 'hard' ? '#991b1b' :
    level === 'soft' ? '#854f0b' :
                       '#3730a3'
  return (
    <span title={reason ?? ''} style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 3,
      background: bg, color: fg, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
    }}>
      {compact ? level.slice(0, 4) : level}
    </span>
  )
}
