'use client'
// components/admin/v2/TypedConfirmModal.tsx
//
// ReasonModal + a typed-confirmation field. Used for the most dangerous
// admin actions (hard delete, revoke sessions, force flush). User must
// type the org name (or other expectedConfirm) EXACTLY before the
// confirm button enables.
//
// Per the plan: if the user starts typing then closes the modal, the
// action does NOT fire. (Confirmed by the close-on-cancel handler that
// resets state in addition to calling onCancel.)

import { useEffect, useRef, useState } from 'react'

const REASON_MIN = 10

export interface TypedConfirmModalProps {
  open:            boolean
  title:           string
  description?:    string
  /** What the user must type EXACTLY to enable confirm. */
  expectedConfirm: string
  /** Display label for the typed-confirm field. */
  confirmFieldLabel?: string
  confirmLabel?:   string
  busy?:           boolean
  onConfirm:       (reason: string, typedConfirm: string) => void | Promise<void>
  onCancel:        () => void
}

export function TypedConfirmModal({
  open, title, description, expectedConfirm, confirmFieldLabel,
  confirmLabel = 'Delete', busy, onConfirm, onCancel,
}: TypedConfirmModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [reason, setReason] = useState('')
  const [typed,  setTyped]  = useState('')

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  // Reset state when the modal opens. CRUCIAL: ensures re-opening starts
  // fresh, never carries a stale typed-confirm from a previous attempt.
  useEffect(() => { if (open) { setReason(''); setTyped('') } }, [open])

  function onBackdrop(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onCancel()
  }

  const reasonOk = reason.trim().length >= REASON_MIN
  const typedOk  = typed === expectedConfirm
  const ok = reasonOk && typedOk

  return (
    <dialog
      ref={dialogRef}
      onClick={onBackdrop}
      onClose={onCancel}
      style={{
        background:   'white',
        border:       'none',
        borderRadius: 12,
        padding:      0,
        width:        'min(560px, calc(100vw - 32px))',
        boxShadow:    '0 12px 40px rgba(0,0,0,0.18)',
      }}
    >
      {/* Danger banner */}
      <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 22px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, borderBottom: '1px solid #fecaca' }}>
        Destructive action — requires typed confirmation
      </div>

      <div style={{ padding: '18px 22px 12px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 6 }}>{title}</div>
        {description && (
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>{description}</div>
        )}

        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 6 }}>
          Why?
        </label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          placeholder={`Min ${REASON_MIN} chars — explain the reason for the audit log`}
          autoFocus
          style={{
            width:        '100%',
            padding:      10,
            border:       '1px solid #e5e7eb',
            borderRadius: 7,
            fontSize:     13,
            outline:      'none',
            fontFamily:   'inherit',
            resize:       'vertical' as const,
            marginBottom: 12,
          }}
        />

        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 6 }}>
          {confirmFieldLabel ?? `Type "${expectedConfirm}" to confirm`}
        </label>
        <input
          type="text"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={expectedConfirm}
          style={{
            width:        '100%',
            padding:      10,
            border:       `1px solid ${typedOk ? '#bbf7d0' : '#e5e7eb'}`,
            borderRadius: 7,
            fontSize:     13,
            outline:      'none',
            fontFamily:   'ui-monospace, monospace',
            background:   typedOk ? '#f0fdf4' : 'white',
          }}
        />
        <div style={{ fontSize: 11, color: typedOk ? '#15803d' : '#9ca3af', marginTop: 4 }}>
          {typedOk ? '✓ matches' : `must equal "${expectedConfirm}" exactly`}
        </div>
      </div>

      <div style={{ padding: '12px 22px 18px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            padding:      '8px 14px',
            background:   '#f9fafb',
            border:       '1px solid #e5e7eb',
            borderRadius: 7,
            fontSize:     13,
            fontWeight:   500,
            color:        '#374151',
            cursor:       busy ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => { if (ok && !busy) onConfirm(reason.trim(), typed) }}
          disabled={!ok || busy}
          style={{
            padding:      '8px 16px',
            background:   ok && !busy ? '#dc2626' : '#d1d5db',
            border:       'none',
            borderRadius: 7,
            fontSize:     13,
            fontWeight:   600,
            color:        'white',
            cursor:       ok && !busy ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
