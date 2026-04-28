'use client'
// components/admin/v2/ReasonModal.tsx
//
// "Why?" modal for dangerous admin actions. Per the plan's hard rule:
// every dangerous action requires a typed reason field (≥10 chars) that
// gets persisted into admin_audit_log.payload.reason.
//
// Confirm button stays disabled until the textarea has ≥10 chars. Esc /
// backdrop click cancels. Native <dialog> handles focus trap.

import { useEffect, useRef, useState } from 'react'

const REASON_MIN = 10

export interface ReasonModalProps {
  open:        boolean
  title:       string
  description?: string
  confirmLabel?: string
  busy?:       boolean
  onConfirm:   (reason: string) => void | Promise<void>
  onCancel:    () => void
}

export function ReasonModal({
  open, title, description, confirmLabel = 'Confirm', busy, onConfirm, onCancel,
}: ReasonModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [reason, setReason] = useState('')

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  // Reset reason when the modal opens.
  useEffect(() => { if (open) setReason('') }, [open])

  function onBackdrop(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onCancel()
  }

  const ok = reason.trim().length >= REASON_MIN

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
        width:        'min(520px, calc(100vw - 32px))',
        boxShadow:    '0 12px 40px rgba(0,0,0,0.18)',
      }}
    >
      <div style={{ padding: '20px 22px 12px' }}>
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
          rows={4}
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
          }}
        />
        <div style={{ fontSize: 11, color: ok ? '#15803d' : '#9ca3af', marginTop: 4 }}>
          {reason.trim().length} / {REASON_MIN} chars {ok ? '✓' : ''}
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
          onClick={() => { if (ok && !busy) onConfirm(reason.trim()) }}
          disabled={!ok || busy}
          style={{
            padding:      '8px 16px',
            background:   ok && !busy ? '#1a1f2e' : '#d1d5db',
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
