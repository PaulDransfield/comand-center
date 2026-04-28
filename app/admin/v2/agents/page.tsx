'use client'
// app/admin/v2/agents/page.tsx
// PR 6 — Agents tab. Operational view per agent + recent failures panel.
// FIXES.md §0ag.

import { useState } from 'react'
import { useAdminData } from '@/lib/admin/v2/use-admin-data'
import { adminFetch } from '@/lib/admin/v2/api-client'
import { ReasonModal } from '@/components/admin/v2/ReasonModal'

interface AgentRow {
  key:                string
  name:               string
  cron:               string
  blocked:            boolean
  is_active:          boolean
  settings_persisted: boolean
  last_run:           string | null
  runs_24h:           number
  runs_7d:            number
  last_changed_at:    string | null
  last_changed_by:    string | null
  last_change_reason: string | null
  error?:             string
}
interface FailureRow {
  id:          string
  org_id:      string | null
  org_name:    string
  provider:    string
  status:      string
  error_msg:   string | null
  duration_ms: number | null
  created_at:  string
}
interface AgentsResponse {
  agents:             AgentRow[]
  recent_failures:    FailureRow[]
  settings_persisted: boolean
  generated_at:       string
}

export default function AgentsPage() {
  const { data, loading, error, refetch } = useAdminData<AgentsResponse>('/api/admin/v2/agents')
  const [target, setTarget] = useState<{ agent: AgentRow; nextActive: boolean } | null>(null)
  const [busy,   setBusy]   = useState(false)
  const [info,   setInfo]   = useState<string | null>(null)
  const [err,    setErr]    = useState<string | null>(null)

  async function confirmToggle(reason: string) {
    if (!target) return
    setBusy(true); setErr(null); setInfo(null)
    try {
      await adminFetch('/api/admin/v2/agents', {
        method: 'POST',
        body:   JSON.stringify({ agent_key: target.agent.key, is_active: target.nextActive, reason }),
      })
      setInfo(`${target.agent.name}: ${target.nextActive ? 'enabled' : 'killed'}`)
      setTarget(null)
      refetch()
    } catch (e: any) {
      setErr(e?.message ?? 'Toggle failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {/* Banner if M035 hasn't been applied yet. */}
      {data && !data.settings_persisted && (
        <Banner tone="warn" text="agent_settings table missing — apply M035-ADMIN-AGENT-SETTINGS.sql in Supabase to enable kill switches. Until then the buttons return an error." />
      )}

      {info && <Banner tone="good" text={info} onClose={() => setInfo(null)} />}
      {err  && <Banner tone="bad"  text={err}  onClose={() => setErr(null)} />}

      <Section title="Agents" subtitle="One row per scheduled AI agent. Kill switch flips agent_settings.is_active and audits the reason.">
        {loading ? <Empty text="Loading agents…" />
          : error ? <Banner tone="bad" text={error} />
          : !data ? <Empty text="No data" />
          : (
            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
                  <tr>
                    <Th>Agent</Th>
                    <Th>State</Th>
                    <Th align="right">Last run</Th>
                    <Th align="right">Runs 24h / 7d</Th>
                    <Th>Last change</Th>
                    <Th align="right" />
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map(a => <AgentRowEl key={a.key} a={a} onToggle={(next) => setTarget({ agent: a, nextActive: next })} />)}
                </tbody>
              </table>
            </div>
          )
        }
      </Section>

      <Section title="Recent failures" subtitle="Last 20 sync_log rows with status != 'success'. Per-agent run logging is a follow-up — until then this is the honest cross-platform signal.">
        {loading ? <Empty text="Loading failures…" />
          : !data ? null
          : data.recent_failures.length === 0
            ? <Empty text="No recent failures ✓" tone="good" />
            : (
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                  <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
                    <tr>
                      <Th align="right">When</Th><Th>Org</Th><Th>Provider</Th><Th>Status</Th><Th>Error</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_failures.map(f => (
                      <tr key={f.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <Td align="right" muted>{fmtDateTime(f.created_at)}</Td>
                        <Td>
                          {f.org_id
                            ? <a href={`/admin/v2/customers/${f.org_id}`} style={{ color: '#111', fontWeight: 500, textDecoration: 'none' }}>{f.org_name}</a>
                            : <span style={{ color: '#d1d5db' }}>—</span>}
                        </Td>
                        <Td muted style={{ textTransform: 'capitalize' as const }}>{f.provider}</Td>
                        <Td><Pill tone="bad">{f.status.toUpperCase()}</Pill></Td>
                        <Td>
                          {f.error_msg ? (
                            <div style={{ fontSize: 11, color: '#b91c1c', maxWidth: 360, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }} title={f.error_msg}>
                              {f.error_msg}
                            </div>
                          ) : <span style={{ color: '#d1d5db' }}>—</span>}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      </Section>

      <Section title="Currently running" subtitle="No in-flight agent tracking yet. A future PR can add an agent_run_log table that records start + end timestamps; until then we surface only completed runs above.">
        <Empty text="—" />
      </Section>

      <ReasonModal
        open={!!target}
        title={target ? `${target.nextActive ? 'Re-enable' : 'Kill'} ${target.agent.name}` : ''}
        description={target?.nextActive
          ? 'Re-enables the agent. Cron will run on its normal schedule again.'
          : 'Sets agent_settings.is_active = false. Cron handlers will need a follow-up PR to honour this; for now the kill state is recorded but cron may still fire.'}
        confirmLabel={target?.nextActive ? 'Re-enable' : 'Kill'}
        busy={busy}
        onConfirm={confirmToggle}
        onCancel={() => { if (!busy) setTarget(null) }}
      />
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────

function AgentRowEl({ a, onToggle }: { a: AgentRow; onToggle: (nextActive: boolean) => void }) {
  return (
    <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
      <Td>
        <div style={{ fontWeight: 500, color: '#111' }}>
          {a.name}
          {a.blocked && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '1px 4px', borderRadius: 3 }}>BLOCKED</span>}
        </div>
        <code style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, display: 'block' }}>{a.cron}</code>
        {a.error && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>{a.error}</div>}
      </Td>
      <Td>
        {a.is_active
          ? <Pill tone="good">ACTIVE</Pill>
          : <Pill tone="bad">KILLED</Pill>}
      </Td>
      <Td muted align="right">
        {a.last_run ? fmtDateTime(a.last_run) : <span style={{ color: '#d1d5db' }}>never</span>}
      </Td>
      <Td muted align="right">
        <span style={{ fontVariantNumeric: 'tabular-nums' as const }}>{a.runs_24h}</span>
        <span style={{ color: '#d1d5db', margin: '0 4px' }}>/</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' as const }}>{a.runs_7d}</span>
      </Td>
      <Td>
        {a.last_changed_at
          ? (
            <div>
              <div style={{ fontSize: 11, color: '#374151' }}>{fmtDateTime(a.last_changed_at)}</div>
              {a.last_change_reason && (
                <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' as const, marginTop: 2, paddingLeft: 6, borderLeft: '2px solid #e5e7eb', maxWidth: 280, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }} title={a.last_change_reason}>
                  {a.last_change_reason}
                </div>
              )}
            </div>
          )
          : <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>}
      </Td>
      <Td align="right">
        <button
          onClick={() => onToggle(!a.is_active)}
          disabled={a.blocked}
          style={{
            padding:      '6px 12px',
            background:   a.is_active ? '#fef2f2' : '#f0fdf4',
            border:       `1px solid ${a.is_active ? '#fecaca' : '#bbf7d0'}`,
            borderRadius: 6,
            fontSize:     11,
            fontWeight:   600,
            color:        a.is_active ? '#b91c1c' : '#15803d',
            cursor:       a.blocked ? 'not-allowed' : 'pointer',
            opacity:      a.blocked ? 0.5 : 1,
          }}
          title={a.blocked ? 'Agent is blocked at the source — kill switch unavailable' : undefined}
        >
          {a.is_active ? 'Kill' : 'Re-enable'}
        </button>
      </Td>
    </tr>
  )
}

// ─── Atoms ──────────────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}
function Banner({ tone, text, onClose }: { tone: 'good' | 'warn' | 'bad'; text: string; onClose?: () => void }) {
  const T = {
    good: { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' },
    warn: { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
    bad:  { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
  }[tone]
  return (
    <div style={{ padding: '10px 14px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12, color: T.fg, marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span>{text}</span>
      {onClose && (
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.fg, cursor: 'pointer', fontSize: 14, marginLeft: 12 }}>×</button>
      )}
    </div>
  )
}
function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '8px 14px', textAlign: (align ?? 'left') as any, fontSize: 11, fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' as const }}>{children}</th>
}
function Td({ children, muted, align, style }: { children: React.ReactNode; muted?: boolean; align?: 'left' | 'right'; style?: React.CSSProperties }) {
  return <td style={{ padding: '10px 14px', fontSize: 12, color: muted ? '#6b7280' : '#111', textAlign: (align ?? 'left') as any, verticalAlign: 'top' as const, ...style }}>{children}</td>
}
function Pill({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'neutral' }) {
  const t = { good: { bg: '#dcfce7', fg: '#15803d' }, bad: { bg: '#fef2f2', fg: '#b91c1c' }, neutral: { bg: '#f3f4f6', fg: '#6b7280' } }[tone]
  return <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3, background: t.bg, color: t.fg }}>{children}</span>
}
function Empty({ text, tone }: { text: string; tone?: 'good' }) {
  return <div style={{ padding: 24, textAlign: 'center' as const, fontSize: 12, color: tone === 'good' ? '#15803d' : '#9ca3af', background: 'white', border: '1px solid #e5e7eb', borderRadius: 10 }}>{text}</div>
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
