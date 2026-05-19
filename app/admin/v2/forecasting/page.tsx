'use client'
// app/admin/v2/forecasting/page.tsx
//
// Phase 0 measurement dashboard for the prediction-improvement plan.
// One page that answers three questions:
//
//   1. "How accurate is each forecast surface, per business, per horizon?"
//      → MAPE-by-horizon-bucket table (all-time)
//
//   2. "Is the forecaster getting better recently?"
//      → Rolling 28-day delta column
//
//   3. "When the forecaster says 'high confidence', is it actually high?"
//      → Confidence calibration table
//
// Reads /api/admin/v2/forecasting (single round-trip, 60s cached).
// Styling matches /admin/v2/health Card/Stat/Banner atoms.

import { useMemo } from 'react'
import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface MapeRow {
  business_id:         string
  surface:             string
  horizon_bucket_days: number
  resolved_rows:       number
  mape_pct:            number
  bias_pct:            number
  error_stddev_pct?:   number | null
  earliest_forecast:   string
  latest_forecast:     string
}

interface ConfidenceRow {
  business_id:    string
  surface:        string
  confidence:     'high' | 'medium' | 'low'
  resolved_rows:  number
  mape_pct:       number
  bias_pct:       number
}

interface ForecastingResponse {
  all_time:    MapeRow[]
  rolling_28d: MapeRow[]
  confidence:  ConfidenceRow[]
  businesses:  Record<string, { id: string; name: string; org_id: string }>
  errors:      string[]
  generated_at: string
  cached?:     boolean
  age_ms?:     number
}

const HORIZON_BUCKETS = [1, 7, 14, 28] as const
const SURFACES = ['consolidated_daily', 'llm_adjusted', 'scheduling_ai_revenue', 'weather_demand'] as const
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const

export default function ForecastingPage() {
  const { data, loading, error, refetch } = useAdminData<ForecastingResponse>('/api/admin/v2/forecasting')

  return (
    <div>
      <Header data={data} loading={loading} onRefresh={refetch} />

      {error && <Banner tone="bad" text={error} />}
      {data?.errors?.length ? <Banner tone="warn" text={`View errors: ${data.errors.join(' · ')}`} /> : null}
      {!data && loading && <Empty text="Loading prediction metrics…" />}

      {data && (
        <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
          <Headline data={data} />
          <MapeByHorizonCard data={data} />
          <ConfidenceCard data={data} />
          <LegendCard />
        </div>
      )}
    </div>
  )
}

// ─── Header ──────────────────────────────────────────────────────────

function Header({ data, loading, onRefresh }: { data: ForecastingResponse | null; loading: boolean; onRefresh: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
      <div>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111', margin: 0 }}>Forecasting metrics</h1>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
          Phase 0 measurement dashboard — MAPE, bias, and confidence calibration across every forecast surface.
          {data && (
            <>
              {' · '}
              Generated {fmtTime(data.generated_at)}
              {data.cached && data.age_ms != null && <span> · cached {Math.round(data.age_ms / 1000)}s ago</span>}
            </>
          )}
        </div>
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        style={{ padding: '6px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontWeight: 500, color: '#374151', cursor: loading ? 'not-allowed' : 'pointer' }}
      >
        {loading ? 'Refreshing…' : 'Refresh now'}
      </button>
    </div>
  )
}

// ─── Headline cards ──────────────────────────────────────────────────

function Headline({ data }: { data: ForecastingResponse }) {
  const totalRows = data.all_time.reduce((s, r) => s + r.resolved_rows, 0)
  const businessesCovered = new Set(data.all_time.map(r => r.business_id)).size
  const surfacesCovered   = new Set(data.all_time.map(r => r.surface)).size

  // Best (lowest) MAPE across all (business, surface, horizon=7d) cells
  const sevenDayRows = data.all_time.filter(r => r.horizon_bucket_days === 7)
  const bestSevenDay = sevenDayRows.length
    ? sevenDayRows.reduce((best, r) => r.mape_pct < best.mape_pct ? r : best, sevenDayRows[0])
    : null
  const bizName = bestSevenDay ? (data.businesses[bestSevenDay.business_id]?.name ?? bestSevenDay.business_id.slice(0, 8)) : '—'

  return (
    <Card title="Overview" subtitle="Foundation metrics for every later prediction-improvement decision.">
      <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Stat label="Resolved predictions" value={String(totalRows)} sub={`${data.all_time.length} (business × surface × horizon) cells`} />
        <Stat label="Businesses" value={String(businessesCovered)} sub={`${surfacesCovered} surfaces`} />
        <Stat
          label="Best 7d MAPE"
          value={bestSevenDay ? `${bestSevenDay.mape_pct}%` : '—'}
          sub={bestSevenDay ? `${bizName} · ${bestSevenDay.surface}` : 'no resolved 7-day predictions yet'}
          tone={bestSevenDay ? mapeTone(bestSevenDay.mape_pct) : 'neutral'}
        />
        <Stat
          label="Date range"
          value={data.all_time.length ? `${earliestDate(data.all_time)} → ${latestDate(data.all_time)}` : '—'}
          small
        />
      </div>
    </Card>
  )
}

// ─── MAPE-by-horizon card ────────────────────────────────────────────

function MapeByHorizonCard({ data }: { data: ForecastingResponse }) {
  // Per-business grouping — one section per business, each showing surface rows
  // across the four horizon buckets.
  const byBusiness = useMemo(() => groupByBusiness(data.all_time), [data.all_time])
  const rolling28ByKey = useMemo(() => indexByKey(data.rolling_28d), [data.rolling_28d])

  if (!data.all_time.length) {
    return (
      <Card title="MAPE by surface × horizon" subtitle="No resolved predictions yet — wait for the reconciler to grade rows.">
        <Empty text="Empty ledger" />
      </Card>
    )
  }

  return (
    <Card title="MAPE by surface × horizon" subtitle="All-time vs rolling-28-day. Lower is better. Bias near 0 is better.">
      <div style={{ padding: '4px 0 12px' }}>
        {Object.entries(byBusiness).map(([businessId, surfaceMap]) => (
          <BusinessBlock
            key={businessId}
            businessName={data.businesses[businessId]?.name ?? businessId.slice(0, 8)}
            surfaceMap={surfaceMap}
            rolling28ByKey={rolling28ByKey}
          />
        ))}
      </div>
    </Card>
  )
}

function BusinessBlock({
  businessName,
  surfaceMap,
  rolling28ByKey,
}: {
  businessName:   string
  surfaceMap:     Record<string, Record<number, MapeRow>>
  rolling28ByKey: Record<string, MapeRow>
}) {
  const surfaces = Object.keys(surfaceMap).sort(surfaceSortKey)
  return (
    <div style={{ borderTop: '1px solid #f3f4f6', padding: '12px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 8 }}>{businessName}</div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' as const }}>
        <thead>
          <tr style={{ color: '#6b7280', textAlign: 'left' as const, borderBottom: '1px solid #f3f4f6' }}>
            <th style={th()}>Surface</th>
            {HORIZON_BUCKETS.map(h => (
              <th key={h} style={th()} title={`Predictions made ≤ ${h} days ahead of forecast date`}>
                {h === 1 ? '1d' : `${h}d`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {surfaces.map(surface => (
            <tr key={surface} style={{ borderBottom: '1px solid #fafafa' }}>
              <td style={td()}>
                <span style={{ fontWeight: 500, color: '#374151' }}>{surfaceLabel(surface)}</span>
              </td>
              {HORIZON_BUCKETS.map(h => {
                const cell = surfaceMap[surface]?.[h]
                if (!cell) return <td key={h} style={td()}><span style={{ color: '#d1d5db' }}>—</span></td>
                const r28 = rolling28ByKey[mapeKey(cell.business_id, cell.surface, h)]
                return (
                  <td key={h} style={td()}>
                    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1 }}>
                      <div style={{ color: mapeColor(cell.mape_pct), fontWeight: 500 }}>
                        {cell.mape_pct}%
                        {r28 && r28.mape_pct !== cell.mape_pct && (
                          <span style={{ fontSize: 10, marginLeft: 4, color: r28.mape_pct < cell.mape_pct ? '#15803d' : '#b91c1c' }}>
                            {r28.mape_pct < cell.mape_pct ? '↓' : '↑'}{Math.abs(r28.mape_pct - cell.mape_pct).toFixed(1)}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>
                        bias {cell.bias_pct > 0 ? '+' : ''}{cell.bias_pct}% · n={cell.resolved_rows}
                      </div>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Confidence calibration card ─────────────────────────────────────

function ConfidenceCard({ data }: { data: ForecastingResponse }) {
  if (!data.confidence.length) {
    return (
      <Card title="Confidence calibration" subtitle="When the forecaster says 'high confidence', is it actually accurate?">
        <Empty text="No resolved rows with confidence labels yet" />
      </Card>
    )
  }

  const byKey: Record<string, Record<string, ConfidenceRow>> = {}
  for (const r of data.confidence) {
    const k = `${r.business_id}::${r.surface}`
    if (!byKey[k]) byKey[k] = {}
    byKey[k][r.confidence] = r
  }
  const keys = Object.keys(byKey).sort()

  return (
    <Card title="Confidence calibration" subtitle="A well-calibrated forecaster shows low MAPE on 'high', higher on 'low'. If they're flat, the confidence label is broken.">
      <div style={{ padding: '4px 16px 12px' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' as const }}>
          <thead>
            <tr style={{ color: '#6b7280', textAlign: 'left' as const, borderBottom: '1px solid #f3f4f6' }}>
              <th style={th()}>Business</th>
              <th style={th()}>Surface</th>
              {CONFIDENCE_LEVELS.map(c => (
                <th key={c} style={th()}>{c}</th>
              ))}
              <th style={th()}>Calibrated?</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => {
              const [bizId, surface] = k.split('::')
              const row = byKey[k]
              const high = row.high?.mape_pct
              const low  = row.low?.mape_pct
              const calibrated = (high != null && low != null) ? high < low : null
              return (
                <tr key={k} style={{ borderBottom: '1px solid #fafafa' }}>
                  <td style={td()}>{data.businesses[bizId]?.name ?? bizId.slice(0, 8)}</td>
                  <td style={td()}>{surfaceLabel(surface)}</td>
                  {CONFIDENCE_LEVELS.map(c => (
                    <td key={c} style={td()}>
                      {row[c]
                        ? (
                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1 }}>
                            <div style={{ color: mapeColor(row[c].mape_pct), fontWeight: 500 }}>{row[c].mape_pct}%</div>
                            <div style={{ fontSize: 10, color: '#9ca3af' }}>n={row[c].resolved_rows}</div>
                          </div>
                        )
                        : <span style={{ color: '#d1d5db' }}>—</span>}
                    </td>
                  ))}
                  <td style={td()}>
                    {calibrated == null
                      ? <span style={{ color: '#9ca3af' }}>n/a</span>
                      : calibrated
                        ? <span style={{ color: '#15803d', fontWeight: 500 }}>✓</span>
                        : <span style={{ color: '#b91c1c', fontWeight: 500 }}>✗</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ─── Legend ──────────────────────────────────────────────────────────

function LegendCard() {
  return (
    <Card title="How to read this" subtitle="">
      <div style={{ padding: '10px 16px 14px', fontSize: 12, color: '#374151', lineHeight: 1.6 }}>
        <div><strong>MAPE</strong> = mean absolute percentage error. Lower is better. Industry target for mature daily restaurant prediction: 15%. Cold-start floor (&lt; 180 days history): 25%.</div>
        <div><strong>Bias</strong> = signed mean error. Near 0 means predictions are centered. Persistent + means systematic over-prediction (overstaffs); persistent − means under-prediction (cuts trade you didn't see coming).</div>
        <div><strong>Rolling-28d arrows</strong>: ↓ = recent MAPE is better than all-time (forecaster improving); ↑ = recent is worse.</div>
        <div><strong>Confidence calibration</strong>: a well-calibrated forecaster's 'high' confidence days run at lower MAPE than 'low' confidence days. If they're flat (✗), the badge is unreliable — fix the confidence logic before adding signals.</div>
        <div style={{ marginTop: 6, color: '#6b7280' }}>Surfaces: <em>consolidated_daily</em> = Piece 2 deterministic (v1.5.0); <em>llm_adjusted</em> = Piece 4 Haiku enrichment; <em>scheduling_ai_revenue</em> + <em>weather_demand</em> = legacy pre-v2.</div>
      </div>
    </Card>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function groupByBusiness(rows: MapeRow[]): Record<string, Record<string, Record<number, MapeRow>>> {
  const out: Record<string, Record<string, Record<number, MapeRow>>> = {}
  for (const r of rows) {
    if (!out[r.business_id]) out[r.business_id] = {}
    if (!out[r.business_id][r.surface]) out[r.business_id][r.surface] = {}
    out[r.business_id][r.surface][r.horizon_bucket_days] = r
  }
  return out
}

function indexByKey(rows: MapeRow[]): Record<string, MapeRow> {
  const out: Record<string, MapeRow> = {}
  for (const r of rows) {
    out[mapeKey(r.business_id, r.surface, r.horizon_bucket_days)] = r
  }
  return out
}

function mapeKey(bizId: string, surface: string, horizon: number): string {
  return `${bizId}::${surface}::${horizon}`
}

function surfaceSortKey(a: string, b: string): number {
  const order: Record<string, number> = {
    consolidated_daily:    1,
    llm_adjusted:          2,
    scheduling_ai_revenue: 3,
    weather_demand:        4,
  }
  return (order[a] ?? 99) - (order[b] ?? 99)
}

function surfaceLabel(s: string): string {
  if (s === 'consolidated_daily')    return 'consolidated (v1.5)'
  if (s === 'llm_adjusted')          return 'llm-adjusted (v1.1)'
  if (s === 'scheduling_ai_revenue') return 'legacy: scheduling'
  if (s === 'weather_demand')        return 'legacy: weather'
  return s
}

function mapeTone(m: number): 'good' | 'warn' | 'bad' | 'neutral' {
  if (m <= 15) return 'good'
  if (m <= 25) return 'warn'
  return 'bad'
}
function mapeColor(m: number): string {
  if (m <= 15) return '#15803d'
  if (m <= 25) return '#d97706'
  return '#b91c1c'
}

function earliestDate(rows: MapeRow[]): string {
  return rows.reduce((min, r) => r.earliest_forecast < min ? r.earliest_forecast : min, rows[0]?.earliest_forecast ?? '')
}
function latestDate(rows: MapeRow[]): string {
  return rows.reduce((max, r) => r.latest_forecast > max ? r.latest_forecast : max, rows[0]?.latest_forecast ?? '')
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
  } catch { return iso }
}

// ─── Atoms (mirror /admin/v2/health) ─────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}
function Stat({ label, value, sub, tone, small }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' | 'neutral'; small?: boolean }) {
  const COLOR: Record<string, string> = { good: '#15803d', warn: '#d97706', bad: '#b91c1c', neutral: '#111' }
  const c = COLOR[tone ?? 'neutral']
  return (
    <div>
      {label && <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: '#9ca3af', textTransform: 'uppercase' as const, marginBottom: 4 }}>{label}</div>}
      <div style={{ fontSize: small ? 12 : 18, fontWeight: small ? 400 : 500, color: c, letterSpacing: '-0.01em' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' },
    warn: { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
    bad:  { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
  }[tone]
  return (
    <div style={{ margin: '10px 0', padding: '10px 14px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12, color: T.fg }}>
      {text}
    </div>
  )
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>{text}</div>
}
function th(): React.CSSProperties {
  return { padding: '8px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }
}
function td(): React.CSSProperties {
  return { padding: '8px 8px', verticalAlign: 'top' as const }
}
