'use client'
// app/settings/ai-agents/[key]/page.tsx
//
// Per-agent activity drill-down. Owner-facing transparency page —
// "show me everything this agent has done." Three sections:
//
//   1. Header — agent name + description + plan badge + schedule
//   2. Cost   — 7d / 30d / all-time spend in USD
//   3. Actions — what this agent emitted (anomaly alerts, memos,
//                scheduling cuts). Empty state copy when the agent
//                doesn't persist an explicit output (forecast
//                calibration, onboarding welcome).
//   4. Runs   — last 20 cron invocations with status + duration
//   5. LLM    — last 20 ai_request_log rows: model, tokens, $cost
//
// Pairs with /settings/ai-agents (the listing). Click a card → here.

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import { UXP } from '@/lib/constants/tokens'

interface ActivityResp {
  meta: {
    key:            string
    name:           string
    description:    string
    schedule_human: string
    plan_required:  null | 'pro' | 'group'
    cron_name:      string
    request_types:  string[]
  }
  runs:      Run[]
  llm_calls: LlmCall[]
  actions:   Action[]
  cost:      { last_7d: number; last_30d: number; all_time: number }
}
interface Run {
  id:            string
  started_at:    string
  finished_at:   string | null
  status:        string | null
  error_message: string | null
  payload:       any
}
interface LlmCall {
  id:            string
  created_at:    string
  request_type:  string
  model:         string | null
  cost_usd:      number | null
  input_tokens:  number | null
  output_tokens: number | null
  latency_ms:    number | null
  status:        string | null
}
interface Action {
  id:            string
  occurred_at:   string
  business_id?:  string | null
  business_name?: string | null
  kind:          string
  title:         string
  detail?:       string | null
  meta?:         Record<string, any>
}

export default function AgentActivityPage() {
  const params = useParams<{ key: string }>()
  const key    = String(params?.key ?? '')
  const [data, setData]       = useState<ActivityResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    if (!key) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/settings/ai-agents/${encodeURIComponent(key)}`, { cache: 'no-store' })
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
        if (!cancelled) setData(j)
      })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [key])

  return (
    <AppShell>
      <PageContainer maxWidth={980}>
        <div style={{ marginBottom: 14 }}>
          <Link href="/settings/ai-agents" style={{ fontSize: 12, color: UXP.ink3, textDecoration: 'none' }}>
            ← All AI agents
          </Link>
        </div>

        {error   && <Banner tone="bad" text={error} />}
        {loading && <Empty text="Loading activity…" />}

        {data && !loading && (
          <>
            <Header meta={data.meta} />
            <CostStrip cost={data.cost} hasRequests={data.meta.request_types.length > 0} />
            <ActionsSection actions={data.actions} agentKey={data.meta.key} />
            <RunsSection runs={data.runs} />
            <LlmSection calls={data.llm_calls} hasRequests={data.meta.request_types.length > 0} />
          </>
        )}
      </PageContainer>
    </AppShell>
  )
}

// ─── Sections ────────────────────────────────────────────────────────

function Header({ meta }: { meta: ActivityResp['meta'] }) {
  const planLabel =
    meta.plan_required === 'group' ? 'Group' :
    meta.plan_required === 'pro'   ? 'Pro+'  :
    null
  return (
    <div style={{
      background:   UXP.cardBg,
      border:       `1px solid ${UXP.border}`,
      borderRadius: 10,
      padding:      '18px 20px',
      marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: UXP.ink1, margin: 0 }}>{meta.name}</h1>
        {planLabel && (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            padding: '2px 6px', borderRadius: 3,
            background: UXP.lavFill, color: UXP.lavDeep,
          }}>{planLabel}</span>
        )}
      </div>
      <p style={{ fontSize: 13, color: UXP.ink3, marginTop: 6, lineHeight: 1.55 }}>
        {meta.description}
      </p>
      <div style={{ marginTop: 8, fontSize: 11, color: UXP.ink4 }}>
        <strong style={{ color: UXP.ink3 }}>Schedule:</strong> {meta.schedule_human}
        &nbsp;·&nbsp;<strong style={{ color: UXP.ink3 }}>Cron job:</strong> <code style={{ fontSize: 10 }}>{meta.cron_name}</code>
      </div>
    </div>
  )
}

function CostStrip({ cost, hasRequests }: { cost: ActivityResp['cost']; hasRequests: boolean }) {
  if (!hasRequests) return null
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
      marginBottom: 14,
    }}>
      <CostTile label="Last 7 days"  value={cost.last_7d}  />
      <CostTile label="Last 30 days" value={cost.last_30d} />
      <CostTile label="All time"     value={cost.all_time} />
    </div>
  )
}

function CostTile({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      background: UXP.cardBg, border: `1px solid ${UXP.border}`, borderRadius: 8,
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: UXP.ink1 }}>
        {fmtCost(value)}
      </div>
    </div>
  )
}

function ActionsSection({ actions, agentKey }: { actions: Action[]; agentKey: string }) {
  return (
    <Section title="What this agent did" subtitle={actionsSubtitle(agentKey, actions.length)}>
      {actions.length === 0 ? (
        <EmptyRow text={emptyActionsCopy(agentKey)} />
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {actions.map(a => <ActionRow key={a.id} action={a} />)}
        </div>
      )}
    </Section>
  )
}

function ActionRow({ action }: { action: Action }) {
  const severity = action.meta?.severity as string | undefined
  const sevColor =
    severity === 'high'   ? UXP.roseText :
    severity === 'medium' ? UXP.coral :
    severity === 'low'    ? UXP.greenDeep :
    UXP.ink3
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '110px 1fr', gap: 12,
      padding: '10px 12px',
      background: UXP.pageBg, border: `0.5px solid ${UXP.border}`, borderRadius: 6,
      fontSize: 12,
    }}>
      <div style={{ color: UXP.ink4, fontSize: 11 }}>
        {fmtDateShort(action.occurred_at)}
        {action.business_name && (
          <div style={{ marginTop: 2, color: UXP.ink3, fontSize: 10 }}>
            {action.business_name}
          </div>
        )}
      </div>
      <div>
        <div style={{ color: UXP.ink1, fontWeight: 500 }}>
          {severity && (
            <span style={{
              display: 'inline-block', marginRight: 6,
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
              textTransform: 'uppercase' as const,
              padding: '1px 5px', borderRadius: 3,
              border: `1px solid ${sevColor}`, color: sevColor,
            }}>{severity}</span>
          )}
          {action.title}
        </div>
        {action.detail && (
          <div style={{ marginTop: 4, color: UXP.ink3, fontSize: 11, lineHeight: 1.5 }}>
            {action.detail}
          </div>
        )}
      </div>
    </div>
  )
}

function RunsSection({ runs }: { runs: Run[] }) {
  return (
    <Section title="Recent cron runs" subtitle={`Last ${Math.min(runs.length, 20)} invocation${runs.length === 1 ? '' : 's'} — newest first`}>
      {runs.length === 0 ? (
        <EmptyRow text="No runs recorded yet. The first run may not have happened on this deployment." />
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {runs.map(r => <RunRow key={r.id} run={r} />)}
        </div>
      )}
    </Section>
  )
}

function RunRow({ run }: { run: Run }) {
  const tone: 'good' | 'warn' | 'bad' | 'neutral' =
    run.status === 'success' ? 'good'
    : run.status === 'error' ? 'bad'
    : run.status === 'running' ? 'warn'
    : 'neutral'
  const tonePalette: Record<typeof tone, { bg: string; fg: string }> = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
    warn:    { bg: UXP.lavFill, fg: UXP.coral },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText },
    neutral: { bg: UXP.subtleBg,  fg: UXP.ink3 },
  }
  const durMs = run.finished_at && run.started_at
    ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    : null
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '160px 90px 1fr 90px',
      gap: 10, alignItems: 'center',
      padding: '6px 10px',
      background: UXP.pageBg, border: `0.5px solid ${UXP.border}`, borderRadius: 6,
      fontSize: 11, color: UXP.ink3,
    }}>
      <div>{fmtDateTime(run.started_at)}</div>
      <span style={{
        display: 'inline-flex', justifyContent: 'center',
        padding: '2px 8px', borderRadius: 999,
        background: tonePalette[tone].bg, color: tonePalette[tone].fg,
        fontSize: 10, fontWeight: 600,
      }}>
        {run.status ?? 'unknown'}
      </span>
      <div style={{ color: UXP.ink4, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
        {run.error_message
          ? <span style={{ color: UXP.roseText }}>error: {run.error_message}</span>
          : payloadSummary(run.payload)}
      </div>
      <div style={{ textAlign: 'right' as const, color: UXP.ink4 }}>
        {durMs == null ? '—' : durMs < 1000 ? `${durMs} ms` : `${(durMs / 1000).toFixed(1)} s`}
      </div>
    </div>
  )
}

function LlmSection({ calls, hasRequests }: { calls: LlmCall[]; hasRequests: boolean }) {
  if (!hasRequests) {
    return (
      <Section title="LLM calls" subtitle="This agent does not call the language model — it runs pure arithmetic.">
        <EmptyRow text="No LLM calls — agent uses deterministic logic only." />
      </Section>
    )
  }
  return (
    <Section title="Recent LLM calls" subtitle={`Last ${Math.min(calls.length, 20)} call${calls.length === 1 ? '' : 's'} — newest first`}>
      {calls.length === 0 ? (
        <EmptyRow text="No LLM calls recorded yet for this agent." />
      ) : (
        <div style={{ display: 'grid', gap: 3 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '140px 120px 90px 90px 60px 70px',
            gap: 10, padding: '4px 10px',
            fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: '0.05em',
          }}>
            <div>When</div><div>Model</div><div>In</div><div>Out</div><div>Latency</div><div style={{ textAlign: 'right' as const }}>Cost</div>
          </div>
          {calls.map(c => <LlmRow key={c.id} call={c} />)}
        </div>
      )}
    </Section>
  )
}

function LlmRow({ call }: { call: LlmCall }) {
  const ok = call.status == null || call.status === 'success' || call.status === 'ok'
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '140px 120px 90px 90px 60px 70px',
      gap: 10, alignItems: 'center',
      padding: '5px 10px',
      background: UXP.pageBg, border: `0.5px solid ${UXP.border}`, borderRadius: 6,
      fontSize: 11, color: UXP.ink3,
    }}>
      <div>{fmtDateTime(call.created_at)}</div>
      <div style={{ fontSize: 10, color: UXP.ink2 }} title={call.model ?? ''}>
        {shortenModel(call.model)}
      </div>
      <div style={{ color: UXP.ink4 }}>{fmtNum(call.input_tokens)}</div>
      <div style={{ color: UXP.ink4 }}>{fmtNum(call.output_tokens)}</div>
      <div style={{ color: UXP.ink4 }}>{call.latency_ms ? `${call.latency_ms}ms` : '—'}</div>
      <div style={{ textAlign: 'right' as const, color: ok ? UXP.ink2 : UXP.roseText, fontWeight: 500 }}>
        {fmtCost(call.cost_usd ?? 0)}
      </div>
    </div>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background:   UXP.cardBg,
      border:       `1px solid ${UXP.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginBottom: 12,
    }}>
      <div style={{ marginBottom: 10 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: UXP.ink1, margin: 0 }}>{title}</h2>
        {subtitle && <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div style={{
      padding:    '14px',
      background: UXP.pageBg,
      border:     `0.5px dashed ${UXP.border}`,
      borderRadius: 6,
      fontSize:   12, color: UXP.ink4, textAlign: 'center' as const,
    }}>{text}</div>
  )
}

function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: UXP.greenFill, border: UXP.green, fg: UXP.greenDeep },
    warn: { bg: UXP.lavFill, border: UXP.lavMid, fg: UXP.coral },
    bad:  { bg: UXP.roseFill, border: UXP.rose, fg: UXP.roseText },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
    }}>{text}</div>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12 }}>{text}</div>
}

// ─── Helpers ─────────────────────────────────────────────────────────

function actionsSubtitle(agentKey: string, count: number): string {
  switch (agentKey) {
    case 'anomaly_detection':       return `Anomaly alerts emitted (${count})`
    case 'monday_briefing':         return `Monday memos sent (${count})`
    case 'scheduling_optimization': return `Scheduling reports generated (${count})`
    case 'forecast_calibration':    return 'Bias-factor adjustments are made in place; no separate output stream.'
    case 'supplier_price_creep':    return 'Surfaces alerts via the Anomaly detection feed.'
    case 'onboarding_success':      return 'Sends a one-time welcome email after first sync.'
    default:                        return `${count} items`
  }
}

function emptyActionsCopy(agentKey: string): string {
  switch (agentKey) {
    case 'anomaly_detection':       return 'No anomalies flagged yet. Quiet weeks = healthy operations.'
    case 'monday_briefing':         return 'No memos sent yet. First one lands the next Monday after a full data week.'
    case 'scheduling_optimization': return 'No scheduling reports yet. First one lands the next Monday 07:00 UTC with at least 2 weeks of rota + sales data.'
    case 'forecast_calibration':    return 'This agent adjusts bias factors in place — see the forecast accuracy chart for outcomes.'
    case 'supplier_price_creep':    return 'No supplier drift flagged yet. Alerts show on the main Alerts page.'
    case 'onboarding_success':      return 'No welcome emails yet — fires once per business when first sync completes.'
    default:                        return 'No activity yet.'
  }
}

function payloadSummary(payload: any): string {
  if (!payload) return ''
  if (typeof payload === 'string') return payload.slice(0, 200)
  try {
    const keys = Object.keys(payload)
    if (keys.length === 0) return ''
    const pairs = keys.slice(0, 4).map(k => {
      const v = payload[k]
      if (typeof v === 'object' && v != null) return `${k}=${Array.isArray(v) ? `[${v.length}]` : '{…}'}`
      return `${k}=${String(v).slice(0, 30)}`
    })
    return pairs.join(' · ')
  } catch { return '' }
}

function shortenModel(m: string | null): string {
  if (!m) return '—'
  return m
    .replace('claude-haiku-4-5-20251001', 'haiku-4.5')
    .replace('claude-sonnet-4-6', 'sonnet-4.6')
    .replace('claude-', '')
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US')
}

function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return '$0.00'
  if (usd < 0.01) return '< $0.01'
  if (usd < 1)    return '$' + usd.toFixed(3)
  return '$' + usd.toFixed(2)
}

function fmtDateShort(iso: string): string {
  try {
    const d = new Date(iso)
    const day = d.getUTCDate()
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
    return `${day} ${month}`
  } catch { return iso }
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    const day = d.getUTCDate()
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    return `${day} ${month} ${hh}:${mm}`
  } catch { return iso }
}
