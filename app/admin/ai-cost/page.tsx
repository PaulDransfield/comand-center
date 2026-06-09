'use client'
// app/admin/ai-cost/page.tsx
//
// A3.4 — admin AI cost dashboard. Pulls /api/admin/ai-cost and renders:
//   - alert banner when today's spend ≥70 % of cap
//   - 4 summary tiles (today / MTD / window total / cap %)
//   - 30-day spend trend (SVG line)
//   - 4 breakdown tables (per-org / per-surface / per-model / per-page)
//
// Refreshes every 60 seconds.

import { useEffect, useState } from 'react'

interface Bucket {
  count:         number
  input_tokens:  number
  output_tokens: number
  cost_usd:      number
  cost_sek:      number
}

interface Summary {
  window_from:    string
  window_to:      string
  computed_at:    string
  total: { requests: number; cost_usd: number; cost_sek: number; input_tokens: number; output_tokens: number }
  today_usd:      number
  mtd_usd:        number
  max_daily_usd:  number
  pct_of_cap:     number
  alert_level:    'ok' | 'warning' | 'critical'
  by_day:         Array<{ date: string; requests: number; cost_usd: number; cost_sek: number }>
  by_org:         Array<{ org_id: string; org_name: string | null } & Bucket>
  by_surface:     Array<{ key: string } & Bucket>
  by_model:       Array<{ key: string } & Bucket>
  by_page:        Array<{ key: string } & Bucket>
}

export default function AiCostPage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await fetch(`/api/admin/ai-cost?days=${days}`, { cache: 'no-store' })
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
    const t = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [days])

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <div style={S.title}>AI cost</div>
          <div style={S.subtitle}>
            Spend across every Anthropic surface. Refreshes every minute.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[7, 14, 30, 60, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: '6px 12px',
              border: 'none',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              background: d === days ? '#5b4a86' : '#fff',
              color: d === days ? '#fff' : '#3a3550',
              boxShadow: '0 0.5px 0 rgba(58,53,80,0.08)',
            }}>{d}d</button>
          ))}
        </div>
      </div>

      {err && <div style={S.errorBanner}>Error: {err}</div>}

      {data && data.alert_level !== 'ok' && (
        <div style={data.alert_level === 'critical' ? S.criticalBanner : S.warningBanner}>
          {data.alert_level === 'critical' ? 'CRITICAL' : 'WARNING'}: today's spend is{' '}
          <strong>{data.pct_of_cap.toFixed(1)}%</strong> of the daily cap (${data.max_daily_usd}). Investigate immediately.
        </div>
      )}

      {/* Summary tiles */}
      <div style={S.tilesRow}>
        <Tile label="Today" value={`$${(data?.today_usd ?? 0).toFixed(2)}`} sub={`${data?.pct_of_cap.toFixed(1) ?? '0'}% of cap`} tone={
          data?.alert_level === 'critical' ? 'bad'
          : data?.alert_level === 'warning' ? 'warn'
          : 'good'} />
        <Tile label="Month-to-date" value={`$${(data?.mtd_usd ?? 0).toFixed(2)}`} sub="from 1st" />
        <Tile label={`${data?.window_from ?? '—'} → today`} value={`$${(data?.total.cost_usd ?? 0).toFixed(2)}`} sub={`${(data?.total.requests ?? 0).toLocaleString()} requests`} />
        <Tile label="Daily cap" value={`$${data?.max_daily_usd ?? 0}`} sub="MAX_DAILY_GLOBAL_USD env" />
      </div>

      {/* 30-day chart */}
      {data && data.by_day.length > 0 && (
        <section style={S.section}>
          <div style={S.sectionTitle}>Spend trend (USD per day)</div>
          <SpendChart days={data.by_day} cap={data.max_daily_usd} />
        </section>
      )}

      {/* Per-org */}
      <BreakdownSection title="By organisation" cap={(o: any) => o.org_name ?? o.org_id.slice(0, 8) + '…'} rows={data?.by_org ?? []} />
      {/* Per-surface */}
      <BreakdownSection title="By request type / surface" cap={(o: any) => o.key} rows={data?.by_surface ?? []} />
      {/* Per-model */}
      <BreakdownSection title="By model" cap={(o: any) => o.key} rows={data?.by_model ?? []} />
      {/* Per-page */}
      <BreakdownSection title="By calling page" cap={(o: any) => o.key} rows={data?.by_page ?? []} />

      {data && <div style={S.footer}>Computed {data.computed_at.slice(0, 19).replace('T', ' ')} UTC.</div>}
      {loading && !data && <div style={S.footer}>Loading…</div>}
    </div>
  )
}

function Tile({ label, value, sub, tone = 'neutral' }: { label: string; value: string; sub: string; tone?: 'good' | 'bad' | 'warn' | 'neutral' }) {
  const palette = {
    good:    { fg: '#1f7a4d', bg: '#e6f7ee' },
    bad:     { fg: '#a3243a', bg: '#fdebee' },
    warn:    { fg: '#a17418', bg: '#fff4e0' },
    neutral: { fg: '#3a3550', bg: '#fff'    },
  }[tone]
  return (
    <div style={{ ...S.tile, color: palette.fg, background: palette.bg }}>
      <div style={S.tileLabel}>{label}</div>
      <div style={S.tileValue}>{value}</div>
      <div style={S.tileSub}>{sub}</div>
    </div>
  )
}

function SpendChart({ days, cap }: { days: Array<{ date: string; cost_usd: number }>; cap: number }) {
  const W = 1080
  const H = 200
  const PAD_L = 50
  const PAD_R = 12
  const PAD_T = 12
  const PAD_B = 24
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const max = Math.max(cap, ...days.map(d => d.cost_usd), 1)
  const x = (i: number) => PAD_L + (i / Math.max(1, days.length - 1)) * innerW
  const y = (v: number) => PAD_T + (1 - v / max) * innerH
  const path = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.cost_usd)}`).join(' ')
  const capY = y(cap)
  return (
    <div style={{ overflowX: 'auto' as const }}>
      <svg width={W} height={H} style={{ display: 'block', background: '#faf9fd' }}>
        <line x1={PAD_L} x2={PAD_L + innerW} y1={capY} y2={capY} stroke="#cf8b1a" strokeWidth={0.5} strokeDasharray="3 3" />
        <text x={PAD_L + innerW - 4} y={capY - 4} fontSize="9" fill="#cf8b1a" textAnchor="end">cap ${cap}</text>
        <path d={path} stroke="#5b4a86" strokeWidth={1.5} fill="none" />
        {days.map((d, i) => <circle key={d.date} cx={x(i)} cy={y(d.cost_usd)} r={2} fill="#5b4a86" />)}
        <text x={PAD_L - 8} y={PAD_T + 4} fontSize="9" fill="#7a7390" textAnchor="end">${max.toFixed(0)}</text>
        <text x={PAD_L - 8} y={PAD_T + innerH + 4} fontSize="9" fill="#7a7390" textAnchor="end">$0</text>
        <text x={x(0)} y={H - 8} fontSize="9" fill="#7a7390" textAnchor="start">{days[0]?.date.slice(5)}</text>
        <text x={x(days.length - 1)} y={H - 8} fontSize="9" fill="#7a7390" textAnchor="end">{days[days.length - 1]?.date.slice(5)}</text>
      </svg>
    </div>
  )
}

function BreakdownSection({ title, cap, rows }: { title: string; cap: (r: any) => string; rows: any[] }) {
  if (rows.length === 0) return null
  const totalUsd = rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
  return (
    <section style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr style={S.theadRow}>
              <th style={S.th}>Name</th>
              <th style={S.thRight}>Requests</th>
              <th style={S.thRight}>Input tokens</th>
              <th style={S.thRight}>Output tokens</th>
              <th style={S.thRight}>Cost USD</th>
              <th style={S.thRight}>Cost SEK</th>
              <th style={S.thRight}>Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((r, i) => {
              const pct = totalUsd > 0 ? (Number(r.cost_usd) / totalUsd) * 100 : 0
              return (
                <tr key={i} style={S.tr}>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11 }}>{cap(r)}</td>
                  <td style={S.tdRight}>{r.count?.toLocaleString() ?? '—'}</td>
                  <td style={S.tdRight}>{Number(r.input_tokens ?? 0).toLocaleString()}</td>
                  <td style={S.tdRight}>{Number(r.output_tokens ?? 0).toLocaleString()}</td>
                  <td style={S.tdRight}>${Number(r.cost_usd ?? 0).toFixed(4)}</td>
                  <td style={S.tdRight}>{Number(r.cost_sek ?? 0).toFixed(2)}</td>
                  <td style={S.tdRight}>{pct.toFixed(1)}%</td>
                </tr>
              )
            })}
            {rows.length > 20 && (
              <tr><td colSpan={7} style={{ ...S.td, color: '#7a7390', textAlign: 'center' as const }}>… and {rows.length - 20} more</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const S: Record<string, React.CSSProperties> = {
  page:           { maxWidth: 1200, margin: '0 auto', padding: '24px 20px' },
  header:         { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, gap: 16 },
  title:          { fontSize: 22, fontWeight: 600, color: '#3a3550', letterSpacing: '-0.02em' },
  subtitle:       { fontSize: 12, color: '#7a7390', marginTop: 4 },
  errorBanner:    { padding: '10px 14px', background: '#fdebee', color: '#a3243a', borderRadius: 8, marginBottom: 14, fontSize: 12 },
  warningBanner:  { padding: '12px 16px', background: '#fff4e0', color: '#a17418', borderRadius: 8, marginBottom: 14, fontSize: 12, fontWeight: 500 },
  criticalBanner: { padding: '12px 16px', background: '#fdebee', color: '#a3243a', borderRadius: 8, marginBottom: 14, fontSize: 12, fontWeight: 600 },
  tilesRow:       { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 },
  tile:           { padding: '14px 16px', borderRadius: 12, border: '0.5px solid rgba(58,53,80,0.08)', boxShadow: '0 1px 2px rgba(58,53,80,0.04)' },
  tileLabel:      { fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' as const, opacity: 0.7 },
  tileValue:      { fontSize: 22, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' as const, letterSpacing: '-0.02em' },
  tileSub:        { fontSize: 10, color: '#7a7390', marginTop: 3 },
  section:        { marginBottom: 22 },
  sectionTitle:   { fontSize: 13, fontWeight: 500, color: '#3a3550', marginBottom: 8 },
  tableWrap:      { background: '#fff', border: '0.5px solid rgba(58,53,80,0.08)', borderRadius: 8, overflow: 'hidden' as const },
  table:          { width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 },
  theadRow:       { background: '#faf9fd', borderBottom: '0.5px solid rgba(58,53,80,0.08)' },
  th:             { textAlign: 'left' as const, padding: '8px 12px', fontWeight: 500, color: '#5b4a86', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' as const },
  thRight:        { textAlign: 'right' as const, padding: '8px 12px', fontWeight: 500, color: '#5b4a86', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' as const },
  tr:             { borderBottom: '0.5px solid rgba(58,53,80,0.05)' },
  td:             { padding: '8px 12px', color: '#3a3550' },
  tdRight:        { padding: '8px 12px', color: '#3a3550', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const },
  footer:         { fontSize: 10, color: '#7a7390', marginTop: 12 },
}
