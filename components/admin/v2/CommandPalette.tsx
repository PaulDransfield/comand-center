'use client'
// components/admin/v2/CommandPalette.tsx
//
// ⌘K modal — STUB for PR 1. Renders an empty modal that opens on
// Cmd/Ctrl+K and closes on Esc / backdrop click. Real search wiring is
// PR 11.
//
// Native <dialog> element handles focus trap, Esc, and backdrop click
// for free — saves us a third-party dep + ~30 lines of focus-management.

import { useEffect, useRef } from 'react'

export function CommandPalette() {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const inputRef  = useRef<HTMLInputElement | null>(null)

  // Cmd+K / Ctrl+K opens the modal. Esc closes it (native dialog behaviour).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      if (isCmdK) {
        e.preventDefault()
        const d = dialogRef.current
        if (!d) return
        if (d.open) d.close()
        else d.showModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus the input when the dialog opens. Native dialog focuses the first
  // tabbable, but autofocus is more reliable across browsers.
  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    const onShow = () => setTimeout(() => inputRef.current?.focus(), 50)
    d.addEventListener('close', () => {})
    d.addEventListener('show', onShow as any)
    // Polyfill for browsers that don't fire 'show' on showModal
    const observer = new MutationObserver(() => { if (d.open) onShow() })
    observer.observe(d, { attributes: true, attributeFilter: ['open'] })
    return () => { observer.disconnect() }
  }, [])

  function onBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    // Native dialog doesn't close on backdrop by default — add it.
    if (e.target === dialogRef.current) dialogRef.current?.close()
  }

  return (
    <dialog
      ref={dialogRef}
      onClick={onBackdropClick}
      style={{
        background:    'white',
        border:        'none',
        borderRadius:  12,
        padding:       0,
        boxShadow:     '0 12px 40px rgba(0,0,0,0.18)',
        width:         'min(560px, calc(100vw - 32px))',
        maxHeight:     'min(420px, calc(100vh - 80px))',
      }}
    >
      <div style={{ padding: '16px 18px 14px', borderBottom: '1px solid #f3f4f6' }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search orgs, users, integrations, audit log… (search lands in PR 11)"
          disabled
          style={{
            width:       '100%',
            border:      'none',
            outline:     'none',
            fontSize:    14,
            color:       '#374151',
            background:  'transparent',
          }}
        />
      </div>
      <div style={{ padding: 24, fontSize: 12, color: '#9ca3af', textAlign: 'center' as const }}>
        ⌘K opens this. Esc closes. Real search lands in PR 11.
      </div>
      <div style={{ padding: '8px 18px 14px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => dialogRef.current?.close()}
          style={{
            padding:      '6px 12px',
            background:   '#f9fafb',
            border:       '1px solid #e5e7eb',
            borderRadius: 6,
            fontSize:     12,
            fontWeight:   500,
            color:        '#374151',
            cursor:       'pointer',
          }}
        >
          Close
        </button>
      </div>
    </dialog>
  )
}
