'use client'
// components/ui/PdfModal.tsx
//
// Shared in-app PDF viewer. Renders a backdrop modal with an iframe so
// PDFs never spawn a new browser tab. Used by EditItemModal's "View PDF"
// button and (TODO) the overheads drill-down + any other PDF surface.
//
// Why an iframe: the browser renders the PDF natively, the user keeps
// our chrome around it, and the resolver URL stays the same (no extra
// download endpoint). Closing returns them right to where they were —
// no lost context.

import { useEffect } from 'react'
import { UXP } from '@/lib/constants/tokens'

export interface PdfModalProps {
  url:   string             // resolver / file URL; iframe loads this directly
  title: string             // shown in the header strip
  onClose: () => void
}

export function PdfModal({ url, title, onClose }: PdfModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    // Stop body scrolling while the modal is open.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,        // toast/modal layer per Z token scale
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 8, overflow: 'hidden',
          width: '100%', maxWidth: 1100, height: '90vh',
          display: 'flex', flexDirection: 'column' as const,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '10px 14px', borderBottom: `0.5px solid ${UXP.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
            {title}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 500,
                background: 'transparent', color: UXP.ink3, textDecoration: 'none' as const,
                border: `0.5px solid ${UXP.border}`, borderRadius: 4, fontFamily: 'inherit',
              }}
              title="Open in new tab"
            >Open in tab</a>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 500,
                background: UXP.subtleBg, color: UXP.ink2,
                border: `0.5px solid ${UXP.border}`, borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >Close</button>
          </div>
        </div>
        {/* Body */}
        <iframe
          src={url}
          title={title}
          style={{ flex: 1, border: 'none', width: '100%', display: 'block' }}
        />
      </div>
    </div>
  )
}
