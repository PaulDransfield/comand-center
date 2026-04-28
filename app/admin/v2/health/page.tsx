'use client'
// app/admin/v2/health/page.tsx
// PR 7 — global system health: Crons, Migrations, RLS, Sentry, Anthropic, Stripe.
// FIXES.md §0ah.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface HealthResponse {
  crons: {
    crons: Array<{
      path: string; schedule: string; schedule_human: string
      last_started_at: string | null; last_finished_at: string | null
      last_status: string | null; last_error: string | null
      age_ms: number | null
    }>
    log_table_present: boolean
    note: string
  }
  migrations: {
    applied_count: number; pending_count: number; pending: string[]
    header_line: string; ok: boolean; error?: string
  }
  rls: {
    rpc_present: boolean
    total_tables: number; rls_enabled: number
    anomalies: Array<{ table_name: string; rls_enabled: boolean; policy_count: number }>
    tables_with_no_policy: number
    tables: Array<{ table_name: string; rls_enabled: boolean; policy_count: number; is_anomaly: boolean }>
    note?: string; error?: string
  }
  sentry:    {
    configured: boolean
    ok?: boolean
    errors_24h?: number
    total_events_24h?: number
    top_issues?: Array<{ title: string; count: number; level: string; permalink: string; first_seen: string; culprit: string }>
    since?: string
    note?: string
    error?: string
  }
  anthropic: {
    ok: boolean; rpc_used?: boolean
    last_24h_usd?: number; prior_24h_usd?: number; delta_pct?: number | null
    global_cap_usd?: number; pct_of_cap?: number | null
    error?: string
  }
  stripe:    { ok: boolean; events_24h?: number; stuck_count?: number; note?: string; error?: string }
  generated_at: string
  cached:       boolean
  age_ms?:      number
}

export default function HealthPage() {
  const { data, loading, error, refetch } = useAdminData<HealthResponse>('/api/admin/v2/health')

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111', margin: 0 }}>System health</h1>
          {data && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
              Generated {fmtDateTime(data.generated_at)}
              {data.cached && data.age_ms != null && <span> · cached {Math.round(data.age_ms / 1000)}s ago</span>}
            </div>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={loading}
          style={{ padding: '6px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontWeight: 500, color: '#374151', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {error && <Banner tone="bad" text={error} />}

      {!data && loading && <Empty text="Loading health probes…" />}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
          <CronsSection data={data.crons} />
          <MigrationsSection data={data.migrations} />
          <RlsSection data={data.rls} />
          <SentrySection data={data.sentry} />
          <AnthropicSection data={data.anthropic} />
          <StripeSection data={data.stripe} />
        </div>
      )}
    </div>
  )
}

// ─── Crons ─────────────────────────────────────────────────────────────────

function CronsSection({ data }: { data: HealthResponse['crons'] }) {
  return (
    <Card title="Crons" subtitle={data.note}>
      {!data.log_table_present && (
        <Banner tone="warn" text="cron_run_log table missing — apply M036-ADMIN-HEALTH-CONFIG.sql in Supabase. Until then crons show 'never logged'." />
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
        <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
          <tr>
            <Th>Cron</Th><Th>Schedule</Th><Th>Last status</Th><Th align="right">Last started</Th>
          </tr>
        </thead>
        <tbody>
          {data.crons.map(c => {
            const ok      = c.last_status === 'success'
            const err     = c.last_status === 'error'
            const running = c.last_status === 'running'
            const stale   = c.age_ms != null && c.age_ms > 26 * 60 * 60 * 1000   // >26h since last run
            return (
              <tr key={c.path} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <Td>
                  <code style={{ fontSize: 11, color: '#111', fontWeight: 500 }}>{c.path}</code>
                  {c.last_error && (
                    <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4, maxWidth: 360, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }} title={c.last_error}>
                      {c.last_error}
                    </div>
                  )}
                </Td>
                <Td muted>
                  <code style={{ fontSize: 11 }}>{c.schedule}</code>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{c.schedule_human}</div>
                </Td>
                <Td>
                  {c.last_status === null ? <Pill tone="neutral">NEVER LOGGED</Pill>
                    : ok       ? <Pill tone="good">SUCCESS</Pill>
                    : running  ? <Pill tone="warn">RUNNING</Pill>
                    : err      ? <Pill tone="bad">ERROR</Pill>
                    : <Pill tone="neutral">{(c.last_status ?? '?').toUpperCase()}</Pill>}
                </Td>
                <Td muted align="right">
                  {c.last_started_at ? (
                    <>
                      <div>{fmtDateTime(c.last_started_at)}</div>
                      <div style={{ fontSize: 10, color: stale ? '#b91c1c' : '#9ca3af' }}>{c.age_ms != null ? niceAgo(c.age_ms) : ''}</div>
                    </>
                  ) : <span style={{ color: '#d1d5db' }}>—</span>}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

// ─── Migrations ────────────────────────────────────────────────────────────

function MigrationsSection({ data }: { data: HealthResponse['migrations'] }) {
  return (
    <Card title="Migrations" subtitle="Parsed from MIGRATIONS.md header line.">
      {!data.ok && <Banner tone="bad" text={`Failed to read MIGRATIONS.md: ${data.error}`} />}
      {data.ok && (
        <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Stat label="Applied" value={String(data.applied_count)} tone="good" />
          <Stat label="Pending" value={String(data.pending_count)} tone={data.pending_count > 0 ? 'warn' : 'good'} />
          <Stat
            label="Pending list"
            value={data.pending.length === 0 ? 'none' : data.pending.join(', ')}
            small
          />
        </div>
      )}
      {data.header_line && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid #f3f4f6', fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>
          {data.header_line}
        </div>
      )}
    </Card>
  )
}

// ─── RLS ───────────────────────────────────────────────────────────────────

function RlsSection({ data }: { data: HealthResponse['rls'] }) {
  return (
    <Card title="Row-Level Security" subtitle="Public-schema tables with RLS state + policy count. Anomaly = RLS on with zero policies (full lockout).">
      {!data.rpc_present && (
        <Banner tone="warn" text={data.note ?? 'admin_health_rls() RPC missing — apply M036-ADMIN-HEALTH-CONFIG.sql in Supabase.'} />
      )}
      {data.rpc_present && (
        <>
          <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Stat label="Total tables" value={String(data.total_tables)} />
            <Stat label="RLS enabled"  value={String(data.rls_enabled)}  tone={data.rls_enabled === data.total_tables ? 'good' : 'warn'} />
            <Stat label="Anomalies"    value={String(data.anomalies.length)} tone={data.anomalies.length > 0 ? 'bad' : 'good'} />
          </div>
          {data.anomalies.length > 0 && (
            <div style={{ padding: '0 16px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#b91c1c', marginBottom: 6 }}>RLS-on but no policies (effectively locked out):</div>
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                {data.anomalies.map(t => (
                  <code key={t.table_name} style={{ fontSize: 11, background: '#fef2f2', color: '#b91c1c', padding: '3px 6px', borderRadius: 4, border: '1px solid #fecaca' }}>
                    {t.table_name}
                  </code>
                ))}
              </div>
            </div>
          )}
          <details style={{ borderTop: '1px solid #f3f4f6' }}>
            <summary style={{ padding: '10px 16px', cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>
              Show all {data.tables.length} tables
            </summary>
            <div style={{ maxHeight: 280, overflow: 'auto' as const, padding: '0 16px 12px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                <thead><tr><Th>Table</Th><Th>RLS</Th><Th align="right">Policies</Th></tr></thead>
                <tbody>
                  {data.tables.map(t => (
                    <tr key={t.table_name} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <Td><code style={{ fontSize: 11 }}>{t.table_name}</code></Td>
                      <Td>{t.rls_enabled ? <Pill tone="good">ON</Pill> : <Pill tone="neutral">OFF</Pill>}</Td>
                      <Td align="right" muted style={{ color: t.is_anomaly ? '#b91c1c' : (t.policy_count === 0 ? '#9ca3af' : '#111'), fontWeight: t.is_anomaly ? 600 : 400 }}>
                        {t.policy_count}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Card>
  )
}

// ─── Sentry ────────────────────────────────────────────────────────────────

function SentrySection({ data }: { data: HealthResponse['sentry'] }) {
  const errors = data.errors_24h ?? 0
  const events = data.total_events_24h ?? 0
  const topIssues = data.top_issues ?? []
  return (
    <Card title="Sentry" subtitle="Top unresolved error/fatal issues + total event volume in the last 24h.">
      {!data.configured ? (
        <Body>{data.note}</Body>
      ) : data.ok === false ? (
        <Banner tone="bad" text={`Sentry probe failed: ${data.error}`} />
      ) : (
        <>
          <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            <Stat
              label="Errors (24h)"
              value={String(errors)}
              tone={errors > 50 ? 'bad' : errors > 10 ? 'warn' : 'good'}
            />
            <Stat
              label="All events (24h)"
              value={String(events)}
              small
            />
          </div>
          {topIssues.length > 0 && (
            <div style={{ padding: '0 16px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 8 }}>
                Top unresolved (by frequency)
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                {topIssues.map((iss, i) => (
                  <a
                    key={i}
                    href={iss.permalink || undefined}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 10px', background: '#f9fafb',
                      border: '1px solid #f3f4f6', borderRadius: 6,
                      textDecoration: 'none', color: 'inherit',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1, marginRight: 10 }}>
                      <div style={{ fontSize: 12, color: '#111', fontWeight: 500, whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>
                        {iss.title}
                      </div>
                      {iss.culprit && (
                        <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'ui-monospace, monospace', marginTop: 2, whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>
                          {iss.culprit}
                        </div>
                      )}
                    </div>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: iss.level === 'fatal' ? '#991b1b' : '#92400e',
                      background: iss.level === 'fatal' ? '#fee2e2' : '#fef3c7',
                      padding: '2px 8px', borderRadius: 999,
                    }}>
                      {iss.count}×
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {topIssues.length === 0 && errors === 0 && (
            <div style={{ padding: '0 16px 14px', fontSize: 11, color: '#9ca3af' }}>
              No unresolved error/fatal issues in the last 24h.
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ─── Anthropic spend ───────────────────────────────────────────────────────

function AnthropicSection({ data }: { data: HealthResponse['anthropic'] }) {
  if (!data.ok) {
    return <Card title="Anthropic spend"><Banner tone="bad" text={`Probe failed: ${data.error}`} /></Card>
  }
  const last  = data.last_24h_usd  ?? 0
  const prior = data.prior_24h_usd ?? 0
  const delta = data.delta_pct
  const cap   = data.global_cap_usd ?? 0
  const pctOfCap = data.pct_of_cap ?? 0
  return (
    <Card title="Anthropic spend" subtitle={data.rpc_used ? 'Reading via ai_spend_24h_global_usd RPC.' : 'Falling back to direct SUM (M033 RPC missing).'}>
      <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <Stat label="Last 24h"  value={`$${last.toFixed(4)}`}  tone={pctOfCap > 80 ? 'bad' : pctOfCap > 50 ? 'warn' : 'good'} sub={`${pctOfCap}% of $${cap} cap`} />
        <Stat label="Prior 24h" value={`$${prior.toFixed(4)}`} />
        <Stat
          label="Delta"
          value={delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta}%`}
          tone={delta == null ? 'neutral' : delta > 50 ? 'warn' : delta < -20 ? 'good' : 'neutral'}
        />
      </div>
    </Card>
  )
}

// ─── Stripe webhook ────────────────────────────────────────────────────────

function StripeSection({ data }: { data: HealthResponse['stripe'] }) {
  if (!data.ok) {
    return <Card title="Stripe webhook"><Banner tone="bad" text={`Probe failed: ${data.error}`} /></Card>
  }
  return (
    <Card title="Stripe webhook" subtitle={data.note}>
      <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <Stat label="Events processed (24h)" value={String(data.events_24h ?? 0)} />
        <Stat
          label="Stuck rows"
          value={String(data.stuck_count ?? 0)}
          tone={(data.stuck_count ?? 0) > 0 ? 'bad' : 'good'}
        />
      </div>
    </Card>
  )
}

// ─── Atoms ─────────────────────────────────────────────────────────────────

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
    <div style={{ margin: '10px 14px', padding: '10px 14px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12, color: T.fg }}>
      {text}
    </div>
  )
}
function Body({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '12px 16px', fontSize: 12, color: '#6b7280' }}>{children}</div>
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>{text}</div>
}
function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '8px 14px', textAlign: (align ?? 'left') as any, fontSize: 11, fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' as const }}>{children}</th>
}
function Td({ children, muted, align, style }: { children: React.ReactNode; muted?: boolean; align?: 'left' | 'right'; style?: React.CSSProperties }) {
  return <td style={{ padding: '10px 14px', fontSize: 12, color: muted ? '#6b7280' : '#111', textAlign: (align ?? 'left') as any, verticalAlign: 'top' as const, ...style }}>{children}</td>
}
function Pill({ children, tone }: { children: React.ReactNode; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const t = {
    good:    { bg: '#dcfce7', fg: '#15803d' },
    warn:    { bg: '#fef3c7', fg: '#92400e' },
    bad:     { bg: '#fef2f2', fg: '#b91c1c' },
    neutral: { bg: '#f3f4f6', fg: '#6b7280' },
  }[tone]
  return <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3, background: t.bg, color: t.fg }}>{children}</span>
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
function niceAgo(ms: number): string {
  if (ms < 60_000) return 'just now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
