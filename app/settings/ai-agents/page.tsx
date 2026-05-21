'use client'
// app/settings/ai-agents/page.tsx
//
// Owner-facing AI agents governance page. Six cards (one per agent)
// showing:
//   - Name + description
//   - Enabled / disabled toggle
//   - Schedule + last-run status + 30-day cost
//   - Plan restriction badge (Pro / Group) where applicable
//
// Trust + accountability surface. Pairs with the revisor view we
// shipped earlier — owners can demonstrate "yes, the AI is running on
// my account but here's exactly what each agent does, when, and how
// much it costs me."
//
// Auth: owner only. Manager/viewer/revisor see /no-access via the
// AppShell role gate.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'

interface Agent {
  key:              string
  name:             string
  description:      string
  schedule_human:   string
  plan_required:    null | 'pro' | 'group'
  enabled:          boolean
  last_run_at:      string | null
  last_finished_at: string | null
  last_status:      string | null
  cost_usd_30d:     number
}

export default function AiAgentsPage() {
  const [agents, setAgents]   = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/settings/ai-agents', { cache: 'no-store' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${r.status}`)
      }
      const j = await r.json()
      setAgents(j.agents ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function toggle(key: string, next: boolean) {
    setSaving(key)
    // Optimistic update
    setAgents(prev => prev.map(a => a.key === key ? { ...a, enabled: next } : a))
    try {
      const r = await fetch('/api/settings/ai-agents', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ key, enabled: next }),
      })
      if (!r.ok) {
        // Revert + surface
        setAgents(prev => prev.map(a => a.key === key ? { ...a, enabled: !next } : a))
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${r.status}`)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 24px 60px' }}>
        <div style={{ marginBottom: 18 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: UXP.ink1, margin: 0 }}>
            AI agents
          </h1>
          <p style={{ fontSize: 13, color: UXP.ink3, marginTop: 4, lineHeight: 1.5 }}>
            Six AI agents work in the background on your data: anomaly detection, monday memo, forecast
            calibration, supplier price drift, scheduling, and onboarding welcome. Each runs on its own schedule
            and can be turned off if you don't want it. Costs are shown for the last 30 days.
          </p>
        </div>

        {error   && <Banner tone="bad" text={error} />}
        {loading && <Empty text="Loading agents…" />}

        <div style={{ display: 'grid', gap: 10 }}>
          {agents.map(a => (
            <AgentCard
              key={a.key}
              agent={a}
              saving={saving === a.key}
              onToggle={(next) => toggle(a.key, next)}
            />
          ))}
        </div>

        <Footnote />
      </div>
    </AppShell>
  )
}

// ─── Agent card ──────────────────────────────────────────────────────

function AgentCard({ agent: a, saving, onToggle }: { agent: Agent; saving: boolean; onToggle: (next: boolean) => void }) {
  const planLabel =
    a.plan_required === 'group' ? 'Group' :
    a.plan_required === 'pro'   ? 'Pro+'  :
    null

  const lastRunStr = formatLastRun(a.last_run_at)
  const statusTone: 'good' | 'warn' | 'bad' | 'neutral' =
    a.last_status === 'success' ? 'good'
    : a.last_status === 'error' ? 'bad'
    : a.last_status === 'running' ? 'warn'
    : 'neutral'
  const statusLabel = a.last_status
    ? (a.last_status === 'success' ? '✓ success' : a.last_status === 'error' ? '✗ error' : a.last_status)
    : 'never run'

  return (
    <div style={{
      background:   UXP.cardBg,
      border:       `1px solid ${a.enabled ? UXP.border : UXP.lavMid}`,   // amber border when off — gentle signal
      borderRadius: 10,
      padding:      '14px 16px',
      opacity:      a.enabled ? 1 : 0.85,
    }}>
      <div style={{
        display:        'grid',
        gridTemplateColumns: '1fr 70px',
        gap:            14,
        alignItems:     'start',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' as const, marginBottom: 4 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: UXP.ink1, margin: 0 }}>
              {a.name}
            </h2>
            {planLabel && <PlanPill label={planLabel} />}
            <StatusPill enabled={a.enabled} />
          </div>
          <p style={{ fontSize: 12, color: UXP.ink3, margin: 0, lineHeight: 1.5 }}>
            {a.description}
          </p>
          <div style={{
            marginTop: 8,
            fontSize:  11,
            color:     UXP.ink4,
            display:   'flex',
            flexWrap:  'wrap' as const,
            gap:       '4px 12px',
          }}>
            <span><strong style={{ color: UXP.ink3 }}>Schedule:</strong> {a.schedule_human}</span>
            <span>·</span>
            <span>
              <strong style={{ color: UXP.ink3 }}>Last run:</strong>{' '}
              {lastRunStr}
              {' '}
              <span style={{ color: statusTone === 'good' ? UXP.greenDeep : statusTone === 'bad' ? UXP.roseText : UXP.ink4 }}>
                {statusLabel}
              </span>
            </span>
            <span>·</span>
            <span><strong style={{ color: UXP.ink3 }}>Cost (30d):</strong> {fmtCost(a.cost_usd_30d)}</span>
          </div>

          <div style={{ marginTop: 10 }}>
            <Link
              href={`/settings/ai-agents/${a.key}`}
              style={{
                fontSize:       11,
                fontWeight:     500,
                color:          UXP.ink2,
                textDecoration: 'none',
                padding:        '4px 10px',
                background:     UXP.pageBg,
                border:         `1px solid ${UXP.border}`,
                borderRadius:   999,
                display:        'inline-block',
              }}
            >
              View activity →
            </Link>
          </div>
        </div>

        <ToggleSwitch
          checked={a.enabled}
          disabled={saving}
          onChange={onToggle}
        />
      </div>
    </div>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function ToggleSwitch({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width:        46,
        height:       26,
        borderRadius: 999,
        border:       'none',
        background:   checked ? UXP.greenDeep : UXP.ink4,
        position:     'relative' as const,
        cursor:       disabled ? 'not-allowed' : 'pointer',
        opacity:      disabled ? 0.6 : 1,
        transition:   'background 0.15s',
        padding:      0,
      }}
    >
      <span style={{
        position:     'absolute' as const,
        top:          3,
        left:         checked ? 23 : 3,
        width:        20,
        height:       20,
        borderRadius: '50%',
        background:   'white',
        transition:   'left 0.15s',
        boxShadow:    '0 1px 2px rgba(0,0,0,0.2)',
      }} />
    </button>
  )
}

function PlanPill({ label }: { label: string }) {
  return (
    <span style={{
      fontSize:     9,
      fontWeight:   700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase' as const,
      padding:      '2px 6px',
      borderRadius: 3,
      background:   UXP.lavFill,
      color:        UXP.lavDeep,
    }}>
      {label}
    </span>
  )
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span style={{
      fontSize:     10,
      fontWeight:   600,
      padding:      '2px 8px',
      borderRadius: 999,
      background:   enabled ? UXP.greenFill : UXP.lavFill,
      color:        enabled ? UXP.greenDeep : UXP.coral,
    }}>
      {enabled ? 'ENABLED' : 'DISABLED'}
    </span>
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

function Footnote() {
  return (
    <div style={{
      marginTop:    24,
      paddingTop:   16,
      borderTop:    `1px solid ${UXP.border}`,
      fontSize:     11,
      color:        UXP.ink4,
      lineHeight:   1.6,
    }}>
      <strong style={{ color: UXP.ink3 }}>How agents work:</strong> Each agent runs on its own
      cron schedule and reads your business data via the Supabase service role. They use Claude Haiku 4.5
      for most actions (low cost, fast) and Claude Sonnet 4.6 for harder reasoning tasks. Data leaves
      Sweden only briefly during the Anthropic API call; nothing about your business is stored on Anthropic's
      side. Agent outputs (emails, alerts, suggestions) live in your CommandCenter — you can review them in
      the relevant pages. Turning an agent off stops it on the next scheduled run; in-flight invocations
      complete first.
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatLastRun(iso: string | null): string {
  if (!iso) return 'never run'
  try {
    const ms = Date.now() - new Date(iso).getTime()
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 1)         return 'just now'
    if (minutes < 60)        return `${minutes} min ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24)          return `${hours}h ago`
    const days  = Math.floor(hours / 24)
    if (days < 30)           return `${days}d ago`
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  } catch {
    return iso
  }
}

function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return '$0.00'
  if (usd < 0.01) return '< $0.01'
  return '$' + usd.toFixed(2)
}
