'use client'
// app/admin/cron-health/page.tsx
//
// A1.6 — admin cron observability surface. Reads /api/admin/cron-health
// and shows:
//   - summary tiles: crons seen, stuck running, failures 24h, total runs 24h
//   - latest-per-cron table sorted with failures + stuck rows at the top
//   - "currently stuck" callout for status='running' rows past the stale
//     threshold (presumed crashed workers)
//   - top long-runners (last 24h)
//
// Refreshes every 30s by polling the API. No write actions yet — this is
// a window into the run log, not a control surface.

import { useEffect, useState } from 'react'

interface CronRow {
  id:               string
  cron_name:        string
  started_at:       string
  // The API enriches cron_run_log with derived fields:
  //   ended_at      = finished_at
  //   duration_ms   = finished_at - started_at
  //   items_processed = meta.processed/count/rows
  // Native cron_run_log uses 'error' as the failed-status value.
  finished_at:      string | null
  duration_ms:      number | null
  status:           'running' | 'success' | 'error' | null
  items_processed:  number | null
  error:            string | null
}

interface Payload {
  computed_at: string
  summary: {
    crons_seen:     number
    stuck_running:  number
    failures_24h:   number
    total_runs_24h: number
  }
  latest_per_cron:  CronRow[]
  stuck_running:    CronRow[]
  failures_24h:     CronRow[]
  top_long_runners: CronRow[]
}

export default function CronHealthPage() {
  const [data, setData]       = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await fetch('/api/admin/cron-health', { cache: 'no-store' })
        const j = await r.json()
        if (cancelled) return
        if (!r.ok) setErr(j?.error ?? `HTTP ${r.status}`)
        else { setData(j); setErr(null) }
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div style={S.title}>Cron health</div>
        <div style={S.subtitle}>
          Live status of every scheduled job. Refreshes every 30 seconds.
        </div>
      </div>

      {err && <div style={S.errorBanner}>Error: {err}</div>}

      {/* Summary tiles */}
      <div style={S.tilesRow}>
        <Tile label="Crons seen"     value={data?.summary.crons_seen     ?? '—'} />
        <Tile label="Total runs 24h" value={data?.summary.total_runs_24h ?? '—'} />
        <Tile label="Failures 24h"   value={data?.summary.failures_24h   ?? '—'} tone={data?.summary?.failures_24h ? 'bad' : 'good'} />
        <Tile label="Stuck running"  value={data?.summary.stuck_running  ?? '—'} tone={data?.summary?.stuck_running ? 'bad' : 'good'} />
      </div>

      {/* Stuck running callout */}
      {data?.stuck_running && data.stuck_running.length > 0 && (
        <section style={S.section}>
          <div style={S.sectionTitle}>Currently stuck</div>
          <div style={S.sectionHint}>Status=running for more than 20 minutes — presumed crashed worker.</div>
          <RunTable rows={data.stuck_running} />
        </section>
      )}

      {/* Latest per cron */}
      <section style={S.section}>
        <div style={S.sectionTitle}>Latest run per cron</div>
        <div style={S.sectionHint}>One row per distinct cron_name. Sorted with failures + running at the top.</div>
        <RunTable rows={sortLatest(data?.latest_per_cron ?? [])} />
      </section>

      {/* Failures 24h */}
      {data?.failures_24h && data.failures_24h.length > 0 && (
        <section style={S.section}>
          <div style={S.sectionTitle}>Failures (last 24h)</div>
          <div style={S.sectionHint}>Status=failed or partial. Up to 30 shown.</div>
          <RunTable rows={data.failures_24h} />
        </section>
      )}

      {/* Top long runners */}
      {data?.top_long_runners && data.top_long_runners.length > 0 && (
        <section style={S.section}>
          <div style={S.sectionTitle}>Top long-runners (last 24h)</div>
          <div style={S.sectionHint}>Sorted by duration. Useful for spotting slow crons before they hit timeouts.</div>
          <RunTable rows={data.top_long_runners} />
        </section>
      )}

      {data && (
        <div style={S.footer}>
          Last computed {formatRelative(data.computed_at)}.
        </div>
      )}

      {loading && !data && <div style={S.footer}>Loading…</div>}
    </div>
  )
}

function sortLatest(rows: CronRow[]): CronRow[] {
  const order: Record<string, number> = {
    error:   0,
    running: 1,
    success: 2,
  }
  return [...rows].sort((a, b) => {
    const r = (order[a.status ?? ''] ?? 9) - (order[b.status ?? ''] ?? 9)
    if (r !== 0) return r
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  })
}

function Tile({ label, value, tone = 'neutral' }: { label: string; value: any; tone?: 'good' | 'bad' | 'neutral' }) {
  const tones = {
    good:    { fg: '#1f7a4d', bg: '#e6f7ee' },
    bad:     { fg: '#a3243a', bg: '#fdebee' },
    neutral: { fg: '#3a3550', bg: '#fff'    },
  }[tone]
  return (
    <div style={{ ...S.tile, color: tones.fg, background: tones.bg }}>
      <div style={S.tileLabel}>{label}</div>
      <div style={S.tileValue}>{value}</div>
    </div>
  )
}

function RunTable({ rows }: { rows: CronRow[] }) {
  if (rows.length === 0) return <div style={S.empty}>No rows.</div>
  return (
    <div style={S.tableWrap}>
      <table style={S.table}>
        <thead>
          <tr style={S.theadRow}>
            <th style={S.th}>Status</th>
            <th style={S.th}>Cron</th>
            <th style={S.th}>Started</th>
            <th style={S.th}>Duration</th>
            <th style={S.thRight}>Items</th>
            <th style={S.th}>Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={S.tr}>
              <td style={S.td}><StatusPill status={r.status ?? 'running'} /></td>
              <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12 }}>{r.cron_name}</td>
              <td style={S.td}>{formatRelative(r.started_at)}</td>
              <td style={S.td}>{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
              <td style={S.tdRight}>{r.items_processed ?? '—'}</td>
              <td style={{ ...S.td, color: '#a3243a', fontSize: 11, maxWidth: 360, overflow: 'hidden' as const, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {r.error ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const palette = (
       status === 'success' ? { bg: '#e6f7ee', fg: '#1f7a4d' }
     : status === 'running' ? { bg: '#eeeaf7', fg: '#5b4a86' }
     : status === 'error'   ? { bg: '#fdebee', fg: '#a3243a' }
     :                        { bg: '#f5f5f5', fg: '#666'    }
  )
  return (
    <span style={{
      display:       'inline-block',
      padding:       '2px 8px',
      background:    palette.bg,
      color:         palette.fg,
      borderRadius:  10,
      fontSize:      10,
      fontWeight:    500,
      letterSpacing: '0.02em',
    }}>
      {status}
    </span>
  )
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return iso
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

const S: Record<string, React.CSSProperties> = {
  page:          { maxWidth: 1200, margin: '0 auto', padding: '24px 20px' },
  header:        { marginBottom: 18 },
  title:         { fontSize: 22, fontWeight: 600, color: '#3a3550', letterSpacing: '-0.02em' },
  subtitle:      { fontSize: 12, color: '#7a7390', marginTop: 4 },
  errorBanner:   { padding: '10px 14px', background: '#fdebee', color: '#a3243a', borderRadius: 8, marginBottom: 14, fontSize: 12 },
  tilesRow:      { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 },
  tile:          { padding: '14px 16px', borderRadius: 12, border: '0.5px solid rgba(58,53,80,0.08)', boxShadow: '0 1px 2px rgba(58,53,80,0.04)' },
  tileLabel:     { fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' as const, opacity: 0.7 },
  tileValue:     { fontSize: 24, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' as const, letterSpacing: '-0.02em' },
  section:       { marginBottom: 22 },
  sectionTitle:  { fontSize: 13, fontWeight: 500, color: '#3a3550', marginBottom: 4 },
  sectionHint:   { fontSize: 10, color: '#7a7390', marginBottom: 8 },
  tableWrap:     { background: '#fff', border: '0.5px solid rgba(58,53,80,0.08)', borderRadius: 8, overflow: 'hidden' as const },
  table:         { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 },
  theadRow:      { background: '#faf9fd', borderBottom: '0.5px solid rgba(58,53,80,0.08)' },
  th:            { textAlign: 'left' as const, padding: '8px 12px', fontWeight: 500, color: '#5b4a86', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' as const },
  thRight:       { textAlign: 'right' as const, padding: '8px 12px', fontWeight: 500, color: '#5b4a86', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' as const },
  tr:            { borderBottom: '0.5px solid rgba(58,53,80,0.05)' },
  td:            { padding: '8px 12px', color: '#3a3550', verticalAlign: 'middle' as const },
  tdRight:       { padding: '8px 12px', color: '#3a3550', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const },
  errorCount:    { color: '#a3243a', fontWeight: 600 },
  empty:         { padding: '14px 16px', fontSize: 11, color: '#7a7390', textAlign: 'center' as const },
  footer:        { fontSize: 10, color: '#7a7390', marginTop: 12 },
}
