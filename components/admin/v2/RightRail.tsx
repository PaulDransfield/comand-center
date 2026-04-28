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

import { adminFetch } from '@/lib/admin/v2/api-client'
import { QuickActionButton } from './QuickActionButton'

export function RightRail({ orgId, onActionComplete }: { orgId: string; onActionComplete?: () => void }) {
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
        <Placeholder text="Change plan · Extend trial · Issue credit — PR 5" />
      </Section>

      {/* ─── Health probes (PR 7-ish) ──────────────────────────────── */}
      <Section title="Health probes">
        <Placeholder text="Per-org health checks — PR 5" />
      </Section>

      {/* ─── Danger zone (PR 5) ────────────────────────────────────── */}
      <Section title="Danger zone" tone="danger">
        <Placeholder text="Hard delete · Revoke sessions · Force-flush — PR 5" />
      </Section>
    </aside>
  )
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
