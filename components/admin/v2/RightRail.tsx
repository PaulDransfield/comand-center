'use client'
// components/admin/v2/RightRail.tsx
//
// Right-rail action drawer for the customer-detail page. Per PR 4 plan,
// implements four quick actions (Impersonate, Force sync, Reaggregate,
// Memo preview) + placeholders for the Subscription / Health probes /
// Recent admin trail / Danger zone sections (those land in PR 5).
//
// Each dangerous action goes through QuickActionButton → ReasonModal,
// which forces a ≥10-char reason that gets persisted to admin_audit_log.

import { useState } from 'react'
import { adminFetch } from '@/lib/admin/v2/api-client'
import { QuickActionButton } from './QuickActionButton'
import { ReasonModal } from './ReasonModal'

interface RightRailProps {
  orgId:           string
  currentPlan?:    string
  onActionComplete?: () => void
}

const PLAN_OPTIONS = ['founding', 'solo', 'group', 'chain', 'trial', 'past_due', 'enterprise']
const TRIAL_DAY_OPTIONS = [7, 14, 30]

export function RightRail({ orgId, currentPlan, onActionComplete }: RightRailProps) {
  // ── Action handlers — all v2 wrappers, all audit-logged ─────────────

  async function impersonate(reason: string) {
    const r = await adminFetch<{ magic_link: string; email: string }>(
      `/api/admin/v2/customers/${orgId}/impersonate`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    )
    // Open the magic link in a new tab. Admin uses incognito so their
    // own session doesn't get overwritten.
    if (typeof window !== 'undefined') {
      window.open(r.magic_link, '_blank', 'noopener,noreferrer')
    }
    return { message: `Magic link opened in new tab for ${r.email}` }
  }

  async function forceSync(reason: string) {
    const r = await adminFetch<{ ok: boolean; results: any[] }>(
      `/api/admin/v2/customers/${orgId}/sync`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    )
    const ok = r.results.filter(x => x.ok).length
    const fail = r.results.length - ok
    return { message: `Synced ${ok}/${r.results.length}${fail > 0 ? ` (${fail} failed — see audit)` : ''}` }
  }

  async function reaggregate(reason: string) {
    const r = await adminFetch<{ ok: boolean; results: any[] }>(
      `/api/admin/v2/customers/${orgId}/reaggregate`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    )
    const ok = r.results.filter(x => x.ok).length
    return { message: `Re-aggregated ${ok}/${r.results.length} business-year combos` }
  }

  async function runFortnoxBackfill(reason: string) {
    const r = await adminFetch<{ ok: boolean; enqueued: number; already_running: number; results: any[] }>(
      `/api/admin/v2/customers/${orgId}/run-fortnox-backfill`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    )
    const parts: string[] = []
    if (r.enqueued > 0)        parts.push(`Enqueued ${r.enqueued}`)
    if (r.already_running > 0) parts.push(`${r.already_running} already running`)
    return { message: parts.length ? parts.join(' · ') : 'Nothing to enqueue' }
  }

  function openMemoPreview() {
    // Memo preview is a GET — no audit needed (read-only). Open in new
    // tab. The legacy endpoint stays, no v2 wrapper required.
    if (typeof window !== 'undefined') {
      // Without a specific business_id the legacy route picks the first
      // business; that's the right default for an ad-hoc preview.
      window.open(`/api/admin/memo-preview?org_id=${orgId}`, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <aside style={{
      display:        'flex',
      flexDirection:  'column' as const,
      gap:            16,
    }}>
      {/* ─── Quick actions ─────────────────────────────────────────── */}
      <Section title="Quick actions">
        <QuickActionButton
          label="Impersonate owner"
          modalTitle="Impersonate the org owner"
          description="Generates a one-time magic link for the org's first member. Opens in a new tab — use incognito so your own admin session isn't overwritten."
          confirmLabel="Generate link"
          onAction={impersonate}
          onComplete={onActionComplete}
        />
        <QuickActionButton
          label="Force sync"
          modalTitle="Force sync all integrations"
          description="Runs a full sync for every connected integration on this org. Takes ~30s per integration."
          confirmLabel="Run sync"
          onAction={forceSync}
          onComplete={onActionComplete}
        />
        <QuickActionButton
          label="Re-aggregate metrics (current year)"
          modalTitle="Re-aggregate metrics"
          description="Rebuilds daily_metrics and monthly_metrics for every business in this org for the current year. Use after data drift or post-sync issues."
          confirmLabel="Re-aggregate"
          onAction={reaggregate}
          onComplete={onActionComplete}
        />
        <QuickActionButton
          label="Run Fortnox backfill (12mo)"
          modalTitle="Run Fortnox 12-month backfill"
          description="Queues every Fortnox integration on this org for the 12-month API backfill. Worker fetches vouchers via Fortnox API and writes per-month tracker_data rows (skipping months where PDF apply has already populated). Skips integrations whose backfill is currently running. Customer-side equivalent: the 'Backfill 12 months' button on /integrations."
          confirmLabel="Enqueue backfill"
          onAction={runFortnoxBackfill}
          onComplete={onActionComplete}
        />
        <button
          onClick={openMemoPreview}
          style={{
            width:         '100%',
            textAlign:     'left' as const,
            padding:       '8px 12px',
            background:    'white',
            border:        '1px solid #e5e7eb',
            borderRadius:  7,
            fontSize:      13,
            fontWeight:    500,
            color:         '#111',
            cursor:        'pointer',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#fafbfc')}
          onMouseLeave={e => (e.currentTarget.style.background = 'white')}
        >
          Preview Monday Memo ↗
        </button>
      </Section>

      {/* ─── Subscription (PR 5) ───────────────────────────────────── */}
      <Section title="Subscription">
        <ExtendTrialAction orgId={orgId} onComplete={onActionComplete} />
        <IssueCreditAction orgId={orgId} onComplete={onActionComplete} />
        <ChangePlanAction orgId={orgId} currentPlan={currentPlan} onComplete={onActionComplete} />
      </Section>

      {/* ─── Danger zone is now its own sub-tab (PR 5) ──────────────── */}
      <Section title="Health probes">
        <Placeholder text="Per-org probes land in a follow-up PR" />
      </Section>
    </aside>
  )
}

// ─── Subscription action atoms ──────────────────────────────────────────────

function ExtendTrialAction({ orgId, onComplete }: { orgId: string; onComplete?: () => void }) {
  const [open, setOpen] = useState(false)
  const [days, setDays] = useState<number>(14)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)
  const [err,  setErr]  = useState<string | null>(null)

  async function handleConfirm(reason: string) {
    setBusy(true); setErr(null); setInfo(null)
    try {
      const r = await adminFetch<{ trial_end: string; days_added: number }>(
        `/api/admin/v2/customers/${orgId}/extend-trial`,
        { method: 'POST', body: JSON.stringify({ reason, days }) },
      )
      setOpen(false)
      setInfo(`Trial extended by ${r.days_added}d → ends ${r.trial_end}`)
      onComplete?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Extend failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          style={{ padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 5, fontSize: 12, background: 'white' }}
        >
          {TRIAL_DAY_OPTIONS.map(d => <option key={d} value={d}>{d} days</option>)}
        </select>
        <button
          onClick={() => setOpen(true)}
          disabled={busy}
          style={{ flex: 1, padding: '8px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, fontWeight: 500, color: '#111', cursor: busy ? 'not-allowed' : 'pointer', textAlign: 'left' as const }}
        >
          Extend trial
        </button>
      </div>
      {info && <ActionInfo text={info} />}
      {err  && <ActionError text={err} />}
      <ReasonModal
        open={open}
        title={`Extend trial by ${days} days`}
        description="Pushes trial_end forward. Anchored on whichever is later: today, or current trial_end. Audit-logged."
        confirmLabel="Extend"
        busy={busy}
        onConfirm={handleConfirm}
        onCancel={() => { if (!busy) setOpen(false) }}
      />
    </div>
  )
}

function IssueCreditAction({ orgId, onComplete }: { orgId: string; onComplete?: () => void }) {
  const [open, setOpen] = useState(false)
  const [amountStr, setAmountStr] = useState<string>('500')
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)
  const [err,  setErr]  = useState<string | null>(null)

  async function handleConfirm(reason: string) {
    const amount = Math.round(Number(amountStr))
    if (!Number.isFinite(amount) || amount <= 0) { setErr('Amount must be > 0'); return }
    setBusy(true); setErr(null); setInfo(null)
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/issue-credit`, {
        method: 'POST',
        body:   JSON.stringify({ reason, amount_sek: amount }),
      })
      setOpen(false)
      setInfo(`Credit recorded: ${amount} kr (issue from Stripe dashboard separately)`)
      onComplete?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Credit failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <input
          type="number"
          value={amountStr}
          onChange={e => setAmountStr(e.target.value)}
          min={1}
          style={{ width: 70, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 5, fontSize: 12, fontFamily: 'inherit' }}
        />
        <span style={{ fontSize: 11, color: '#6b7280' }}>kr</span>
        <button
          onClick={() => setOpen(true)}
          disabled={busy}
          style={{ flex: 1, padding: '8px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, fontWeight: 500, color: '#111', cursor: busy ? 'not-allowed' : 'pointer', textAlign: 'left' as const }}
        >
          Issue credit
        </button>
      </div>
      {info && <ActionInfo text={info} />}
      {err  && <ActionError text={err} />}
      <ReasonModal
        open={open}
        title={`Issue ${amountStr} kr credit`}
        description="Records a billing_events row marking the credit. Issuing the actual Stripe credit happens from the Stripe dashboard separately — this is the bookkeeping mirror."
        confirmLabel="Record credit"
        busy={busy}
        onConfirm={handleConfirm}
        onCancel={() => { if (!busy) setOpen(false) }}
      />
    </div>
  )
}

function ChangePlanAction({ orgId, currentPlan, onComplete }: { orgId: string; currentPlan?: string; onComplete?: () => void }) {
  const [open, setOpen]       = useState(false)
  const [newPlan, setNewPlan] = useState<string>(currentPlan ?? 'solo')
  const [busy, setBusy]       = useState(false)
  const [info, setInfo]       = useState<string | null>(null)
  const [err,  setErr]        = useState<string | null>(null)

  async function handleConfirm(reason: string) {
    setBusy(true); setErr(null); setInfo(null)
    try {
      const r = await adminFetch<{ plan: string; previous_plan: string }>(
        `/api/admin/v2/customers/${orgId}/change-plan`,
        { method: 'POST', body: JSON.stringify({ reason, new_plan: newPlan }) },
      )
      setOpen(false)
      setInfo(`Plan changed: ${r.previous_plan} → ${r.plan}`)
      onComplete?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Plan change failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <select
          value={newPlan}
          onChange={e => setNewPlan(e.target.value)}
          style={{ padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 5, fontSize: 12, background: 'white' }}
        >
          {PLAN_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          onClick={() => setOpen(true)}
          disabled={busy || newPlan === currentPlan}
          style={{ flex: 1, padding: '8px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, fontWeight: 500, color: newPlan === currentPlan ? '#9ca3af' : '#111', cursor: (busy || newPlan === currentPlan) ? 'not-allowed' : 'pointer', textAlign: 'left' as const }}
        >
          Change plan
        </button>
      </div>
      {info && <ActionInfo text={info} />}
      {err  && <ActionError text={err} />}
      <ReasonModal
        open={open}
        title={`Change plan to "${newPlan}"`}
        description="Manual override. Stripe is the source of truth for paid plans via webhooks; this endpoint is for special cases (downgrading to past_due, putting an account on enterprise until billing catches up). Audit-logged with before/after."
        confirmLabel="Change plan"
        busy={busy}
        onConfirm={handleConfirm}
        onCancel={() => { if (!busy) setOpen(false) }}
      />
    </div>
  )
}

function ActionInfo({ text }: { text: string }) {
  return <div style={{ marginTop: 6, padding: '6px 8px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 5, fontSize: 11, color: '#15803d' }}>{text}</div>
}
function ActionError({ text }: { text: string }) {
  return <div style={{ marginTop: 6, padding: '6px 8px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 5, fontSize: 11, color: '#b91c1c' }}>{text}</div>
}

function Section({ title, children, tone }: { title: string; children: React.ReactNode; tone?: 'danger' }) {
  return (
    <div>
      <div style={{
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase' as const,
        color:         tone === 'danger' ? '#b91c1c' : '#9ca3af',
        marginBottom:  6,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
        {children}
      </div>
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div style={{
      padding:      '8px 12px',
      background:   '#fafbfc',
      border:       '1px dashed #e5e7eb',
      borderRadius: 7,
      fontSize:     11,
      color:        '#9ca3af',
      fontStyle:    'italic' as const,
    }}>
      {text}
    </div>
  )
}
