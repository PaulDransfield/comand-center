'use client'
// app/admin/v2/backfill-health/page.tsx
//
// Per-customer backfill health dashboard. One row per business showing
// inventory_backfill_state + PDF queue + line queue + ingestion status,
// with a health score (healthy / attention / stuck) computed server-side.
//
// Designed to answer "is anyone's data import stuck right now?" in one
// glance. Stuck rows sort to the top. Click row → full progress payload.

import { useState } from 'react'
import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface BusinessRow {
  business_id:   string
  business_name: string
  org_id:        string
  org_name:      string
  backfill: {
    status:      string | null
    started_at:  string | null
    updated_at:  string | null
    finished_at: string | null
    progress:    any
    is_stale:    boolean
  }
  pdf_queue:  { pending: number; extracted: number; no_pdf: number; failed: number; total: number }
  line_queue: { matched: number; needs_review: number; not_inventory: number; unprocessed: number; total: number }
  ingestion:  { complete: number; header_only: number; partial: number; failed: number }
  oldest_pending_pdf_at:    string | null
  oldest_header_only_at:    string | null
  health_score:             'healthy' | 'attention' | 'stuck'
  health_reasons:           string[]
}

interface BackfillHealthResponse {
  businesses:   BusinessRow[]
  summary:      { total: number; healthy: number; attention: number; stuck: number }
  generated_at: string
  cached:       boolean
  age_ms?:      number
}

export default function BackfillHealthPage() {
  const { data, loading, error, refetch } = useAdminData<BackfillHealthResponse>('/api/admin/v2/backfill-health')
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111', margin: 0 }}>Backfill health</h1>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            One row per business. Stuck items sort to the top.
            {data && (
              <span> Generated {fmtDateTime(data.generated_at)}
                {data.cached && data.age_ms != null && <span> · cached {Math.round(data.age_ms / 1000)}s ago</span>}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={loading}
          style={{ padding: '6px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontWeight: 500, color: '#374151', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {error && (
        <div style={{ margin: '10px 0', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
          {error}
        </div>
      )}

      {!data && loading && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>Loading…</div>
      )}

      {data && (
        <>
          <SummaryStrip s={data.summary} />
          <section style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginTop: 14 }}>
            {data.businesses.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>No businesses yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
                  <tr>
                    <Th>Business</Th>
                    <Th>State</Th>
                    <Th>PDF queue</Th>
                    <Th>Line queue</Th>
                    <Th>Ingestion</Th>
                    <Th align="right">Last activity</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.businesses.map(b => {
                    const isOpen = expanded === b.business_id
                    return (
                      <RowGroup key={b.business_id} biz={b} isOpen={isOpen} onToggle={() => setExpanded(isOpen ? null : b.business_id)} />
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  )
}

// ── Atoms ──────────────────────────────────────────────────────────────

function SummaryStrip({ s }: { s: { total: number; healthy: number; attention: number; stuck: number } }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      <SummaryCard label="Total businesses" value={s.total} tone="neutral" />
      <SummaryCard label="Healthy"          value={s.healthy}   tone="good" />
      <SummaryCard label="Attention"        value={s.attention} tone="warn" />
      <SummaryCard label="Stuck"            value={s.stuck}     tone="bad" />
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const COLOR: Record<string, string> = { good: '#15803d', warn: '#d97706', bad: '#b91c1c', neutral: '#111' }
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: '#9ca3af', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, color: COLOR[tone], letterSpacing: '-0.02em' }}>{value}</div>
    </div>
  )
}

function RowGroup({ biz, isOpen, onToggle }: { biz: BusinessRow; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer', background: isOpen ? '#fafbfc' : 'white' }}
      >
        <Td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HealthPill score={biz.health_score} />
            <div>
              <div style={{ fontWeight: 500, color: '#111' }}>{biz.business_name}</div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>{biz.org_name}</div>
            </div>
          </div>
        </Td>
        <Td>
          <BackfillStatusPill state={biz.backfill} />
          {biz.backfill.progress?.phase && (
            <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>phase: {biz.backfill.progress.phase}</div>
          )}
        </Td>
        <Td>
          <QueueCounts pending={biz.pdf_queue.pending} ok={biz.pdf_queue.extracted} skipped={biz.pdf_queue.no_pdf} failed={biz.pdf_queue.failed} />
        </Td>
        <Td>
          <QueueCounts pending={biz.line_queue.needs_review} ok={biz.line_queue.matched} skipped={biz.line_queue.not_inventory} failed={biz.line_queue.unprocessed} />
        </Td>
        <Td>
          <IngestionCounts ing={biz.ingestion} />
        </Td>
        <Td align="right" muted>
          {biz.backfill.updated_at ? (
            <>
              <div style={{ fontSize: 11 }}>{fmtDateTime(biz.backfill.updated_at)}</div>
              <div style={{ fontSize: 10, color: biz.backfill.is_stale ? '#b91c1c' : '#9ca3af' }}>{niceAgo(Date.now() - new Date(biz.backfill.updated_at).getTime())}</div>
            </>
          ) : <span style={{ color: '#d1d5db' }}>—</span>}
        </Td>
      </tr>
      {isOpen && (
        <tr style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
          <td colSpan={6} style={{ padding: 14 }}>
            <ExpandedDetail biz={biz} />
          </td>
        </tr>
      )}
    </>
  )
}

function ExpandedDetail({ biz }: { biz: BusinessRow }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <div>
        <SectionLabel>Health reasons</SectionLabel>
        {biz.health_reasons.length === 0 ? (
          <div style={{ fontSize: 12, color: '#15803d' }}>Nothing flagged. All systems nominal.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#374151' }}>
            {biz.health_reasons.map((r, i) => <li key={i} style={{ marginBottom: 4 }}>{r}</li>)}
          </ul>
        )}
        {biz.oldest_pending_pdf_at && (
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 10 }}>
            Oldest pending PDF created: <strong>{fmtDateTime(biz.oldest_pending_pdf_at)}</strong>
          </div>
        )}
        {biz.oldest_header_only_at && (
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            Oldest header_only line created: <strong>{fmtDateTime(biz.oldest_header_only_at)}</strong>
          </div>
        )}
      </div>
      <div>
        <SectionLabel>Backfill progress (raw)</SectionLabel>
        <pre style={{
          background: '#0f172a', color: '#e2e8f0', padding: 10, borderRadius: 6,
          fontSize: 10, overflow: 'auto', maxHeight: 220, lineHeight: 1.5,
        }}>
          {JSON.stringify(biz.backfill.progress ?? { no_state: true }, null, 2)}
        </pre>
      </div>
    </div>
  )
}

function HealthPill({ score }: { score: BusinessRow['health_score'] }) {
  const T = {
    healthy:   { bg: '#dcfce7', fg: '#15803d', label: 'HEALTHY' },
    attention: { bg: '#fef3c7', fg: '#92400e', label: 'ATTENTION' },
    stuck:     { bg: '#fef2f2', fg: '#b91c1c', label: 'STUCK' },
  }[score]
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '3px 7px', borderRadius: 3, background: T.bg, color: T.fg, whiteSpace: 'nowrap' }}>
      {T.label}
    </span>
  )
}

function BackfillStatusPill({ state }: { state: BusinessRow['backfill'] }) {
  if (!state.status) return <span style={{ color: '#d1d5db', fontSize: 11 }}>never run</span>
  if (state.is_stale) {
    return <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 7px', borderRadius: 3, background: '#fef2f2', color: '#b91c1c' }}>STALE ({state.status})</span>
  }
  const T: Record<string, { bg: string; fg: string }> = {
    pending:   { bg: '#fef3c7', fg: '#92400e' },
    running:   { bg: '#dbeafe', fg: '#1e40af' },
    completed: { bg: '#dcfce7', fg: '#15803d' },
    failed:    { bg: '#fef2f2', fg: '#b91c1c' },
  }
  const t = T[state.status] ?? { bg: '#f3f4f6', fg: '#6b7280' }
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '3px 7px', borderRadius: 3, background: t.bg, color: t.fg }}>
      {state.status.toUpperCase()}
    </span>
  )
}

function QueueCounts({ pending, ok, skipped, failed }: { pending: number; ok: number; skipped: number; failed: number }) {
  if (pending === 0 && ok === 0 && skipped === 0 && failed === 0) {
    return <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
      <Tally label="ok"      n={ok}      tone="good" />
      <Tally label="pending" n={pending} tone={pending > 0 ? 'warn' : 'neutral'} />
      <Tally label="skipped" n={skipped} tone="neutral" />
      {failed > 0 && <Tally label="failed" n={failed} tone="bad" />}
    </div>
  )
}

function IngestionCounts({ ing }: { ing: BusinessRow['ingestion'] }) {
  if (ing.complete === 0 && ing.header_only === 0 && ing.partial === 0 && ing.failed === 0) {
    return <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
      <Tally label="complete"    n={ing.complete}    tone="good" />
      {ing.header_only > 0 && <Tally label="header_only" n={ing.header_only} tone="warn" />}
      {ing.partial     > 0 && <Tally label="partial"     n={ing.partial}     tone="warn" />}
      {ing.failed      > 0 && <Tally label="failed"      n={ing.failed}      tone="bad" />}
    </div>
  )
}

function Tally({ label, n, tone }: { label: string; n: number; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const T: Record<string, { bg: string; fg: string }> = {
    good:    { bg: '#dcfce7', fg: '#15803d' },
    warn:    { bg: '#fef3c7', fg: '#92400e' },
    bad:     { bg: '#fef2f2', fg: '#b91c1c' },
    neutral: { bg: '#f3f4f6', fg: '#6b7280' },
  }
  const t = T[tone]
  return (
    <span style={{ padding: '1px 6px', borderRadius: 3, background: t.bg, color: t.fg, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
      {n.toLocaleString()} {label}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: '#9ca3af', textTransform: 'uppercase', marginBottom: 6 }}>{children}</div>
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '10px 14px', textAlign: (align ?? 'left') as any, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', color: '#6b7280', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{children}</th>
}
function Td({ children, muted, align }: { children: React.ReactNode; muted?: boolean; align?: 'left' | 'right' }) {
  return <td style={{ padding: '12px 14px', fontSize: 12, color: muted ? '#6b7280' : '#111', textAlign: (align ?? 'left') as any, verticalAlign: 'top' }}>{children}</td>
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
function niceAgo(ms: number): string {
  if (ms < 60_000)      return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000)   return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000)  return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
