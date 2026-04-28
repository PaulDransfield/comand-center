'use client'
// components/admin/v2/CustomerDangerZone.tsx
//
// Danger zone sub-tab — destructive actions: hard delete, revoke
// sessions. Each requires reason + (for hard delete) typed
// confirmation matching the org name.

import { useState } from 'react'
import { adminFetch } from '@/lib/admin/v2/api-client'
import { TypedConfirmModal } from './TypedConfirmModal'
import { ReasonModal } from './ReasonModal'

interface DangerZoneProps {
  orgId:       string
  orgName:     string
  onComplete?: () => void
}

export function CustomerDangerZone({ orgId, orgName, onComplete }: DangerZoneProps) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [busy,       setBusy]       = useState<string | null>(null)
  const [info,       setInfo]       = useState<string | null>(null)
  const [err,        setErr]        = useState<string | null>(null)

  async function handleDelete(reason: string, typedConfirm: string) {
    setBusy('delete'); setErr(null); setInfo(null)
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/hard-delete`, {
        method: 'POST',
        body:   JSON.stringify({ reason, typed_confirm: typedConfirm }),
      })
      setDeleteOpen(false)
      setInfo(`Hard-deleted "${orgName}". The audit row was written before purge.`)
      onComplete?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Hard delete failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleRevoke(reason: string) {
    setBusy('revoke'); setErr(null); setInfo(null)
    try {
      const r = await adminFetch<{ ok: boolean; revoked: number; failed: number }>(
        `/api/admin/v2/customers/${orgId}/revoke-sessions`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      )
      setRevokeOpen(false)
      setInfo(`Revoked sessions for ${r.revoked} user${r.revoked === 1 ? '' : 's'}${r.failed > 0 ? ` (${r.failed} failed)` : ''}.`)
      onComplete?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Revoke failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <Card title="Hard delete" tone="danger">
        <Body>
          <strong style={{ color: '#b91c1c' }}>Irreversible.</strong> Removes the organisation and every row that
          references it across every tenant table — businesses, integrations, syncs, audit, billing
          history. A `deletion_requests` record is written first so we retain a GDPR Art. 17 paper trail.
          You'll be required to type the org name (<code style={{ background: '#fef2f2', padding: '0 4px', borderRadius: 3, color: '#b91c1c' }}>{orgName}</code>) to confirm.
        </Body>
        <Action onClick={() => setDeleteOpen(true)} disabled={!!busy} tone="danger">
          Hard delete this organisation
        </Action>
      </Card>

      <Card title="Revoke all sessions" tone="warn">
        <Body>
          Signs out every member of this org. Forces re-auth on the next request. Useful when a user
          credential is suspected compromised, or after a large account-takeover incident. Doesn't
          delete the user — they can sign in again with their normal credentials.
        </Body>
        <Action onClick={() => setRevokeOpen(true)} disabled={!!busy} tone="warn">
          Revoke all sessions
        </Action>
      </Card>

      <Card title="Force-flush all data">
        <Body>
          Wipe revenue_logs / staff_logs / daily_metrics / monthly_metrics / tracker_data while
          keeping the org structure intact. Useful when a sync wrote bad data and we need to start
          from scratch.
        </Body>
        <div style={{ padding: '10px 14px', fontSize: 11, color: '#9ca3af', fontStyle: 'italic' as const }}>
          Available in a follow-up — the cascade list needs verification before this can ship safely.
        </div>
      </Card>

      {info && (
        <div style={{ padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, color: '#15803d' }}>
          {info}
        </div>
      )}
      {err && (
        <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
          {err}
        </div>
      )}

      <TypedConfirmModal
        open={deleteOpen}
        title={`Hard delete "${orgName}"`}
        description="Every row referencing this org will be cascaded out. This cannot be undone — restore is from backups only. Audit row is written BEFORE the purge runs."
        expectedConfirm={orgName}
        confirmFieldLabel={`Type "${orgName}" to confirm`}
        confirmLabel="Hard delete"
        busy={busy === 'delete'}
        onConfirm={handleDelete}
        onCancel={() => { if (busy !== 'delete') setDeleteOpen(false) }}
      />

      <ReasonModal
        open={revokeOpen}
        title="Revoke all sessions"
        description="Signs out every member of this org. Reason recorded to audit log."
        confirmLabel="Revoke"
        busy={busy === 'revoke'}
        onConfirm={handleRevoke}
        onCancel={() => { if (busy !== 'revoke') setRevokeOpen(false) }}
      />
    </div>
  )
}

function Card({ title, children, tone }: { title: string; children: React.ReactNode; tone?: 'danger' | 'warn' }) {
  const accent = tone === 'danger' ? '#fecaca' : tone === 'warn' ? '#fde68a' : '#e5e7eb'
  return (
    <div style={{ background: 'white', border: `1px solid ${accent}`, borderRadius: 10, overflow: 'hidden' as const }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', fontSize: 12, fontWeight: 600, color: tone === 'danger' ? '#b91c1c' : tone === 'warn' ? '#92400e' : '#374151' }}>
        {title}
      </div>
      {children}
    </div>
  )
}
function Body({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '12px 14px', fontSize: 12, color: '#374151', lineHeight: 1.55 }}>{children}</div>
}
function Action({ onClick, disabled, tone, children }: { onClick: () => void; disabled?: boolean; tone: 'danger' | 'warn'; children: React.ReactNode }) {
  const COLOR = tone === 'danger' ? { bg: '#dc2626', fg: 'white' } : { bg: '#f59e0b', fg: 'white' }
  return (
    <div style={{ padding: '0 14px 14px' }}>
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          padding:      '8px 16px',
          background:   disabled ? '#d1d5db' : COLOR.bg,
          color:        COLOR.fg,
          border:       'none',
          borderRadius: 7,
          fontSize:     12,
          fontWeight:   600,
          cursor:       disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {children}
      </button>
    </div>
  )
}
