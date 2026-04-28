'use client'
// components/admin/v2/QuickActionButton.tsx
//
// A right-rail button that opens a ReasonModal on click. Caller supplies
// the action handler — receives the typed reason and returns a promise.
// On success, optional onComplete fires (e.g. to refresh data).
//
// Visual style mirrors a small secondary-style button. `tone="danger"`
// switches to red treatment for destructive actions.

import { useState } from 'react'
import { ReasonModal } from './ReasonModal'

export interface QuickActionButtonProps {
  label:        string
  modalTitle:   string
  description?: string
  confirmLabel?: string
  tone?:        'default' | 'danger'
  onAction:     (reason: string) => Promise<{ message?: string } | void>
  onComplete?:  () => void
  /** Disabled state — e.g. while another action is running. */
  disabled?:    boolean
}

export function QuickActionButton({
  label, modalTitle, description, confirmLabel, tone = 'default', onAction, onComplete, disabled,
}: QuickActionButtonProps) {
  const [open,  setOpen]  = useState(false)
  const [busy,  setBusy]  = useState(false)
  const [err,   setErr]   = useState<string | null>(null)
  const [info,  setInfo]  = useState<string | null>(null)

  async function handleConfirm(reason: string) {
    setBusy(true); setErr(null); setInfo(null)
    try {
      const r = await onAction(reason)
      setOpen(false)
      if (r?.message) setInfo(r.message)
      onComplete?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const dangerStyle = tone === 'danger'
  return (
    <div>
      <button
        onClick={() => setOpen(true)}
        disabled={disabled || busy}
        style={{
          width:         '100%',
          textAlign:     'left' as const,
          padding:       '8px 12px',
          background:    'white',
          border:        `1px solid ${dangerStyle ? '#fecaca' : '#e5e7eb'}`,
          borderRadius:  7,
          fontSize:      13,
          fontWeight:    500,
          color:         dangerStyle ? '#b91c1c' : '#111',
          cursor:        (disabled || busy) ? 'not-allowed' : 'pointer',
          transition:    'background 0.1s',
        }}
        onMouseEnter={e => { if (!disabled && !busy) e.currentTarget.style.background = '#fafbfc' }}
        onMouseLeave={e => (e.currentTarget.style.background = 'white')}
      >
        {label}
      </button>
      {err && (
        <div style={{ marginTop: 6, padding: '6px 8px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 5, fontSize: 11, color: '#b91c1c' }}>
          {err}
        </div>
      )}
      {info && (
        <div style={{ marginTop: 6, padding: '6px 8px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 5, fontSize: 11, color: '#15803d' }}>
          {info}
        </div>
      )}
      <ReasonModal
        open={open}
        title={modalTitle}
        description={description}
        confirmLabel={confirmLabel}
        busy={busy}
        onConfirm={handleConfirm}
        onCancel={() => { if (!busy) setOpen(false) }}
      />
    </div>
  )
}
