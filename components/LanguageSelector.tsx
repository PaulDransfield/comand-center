'use client'
// components/LanguageSelector.tsx
//
// User-facing locale picker. Renders one of two visual modes:
//   compact — a small pill that pops a dropdown (sidebar context)
//   inline  — a row of flag pills (landing-page header context)
//
// Switching:
//   1. POST /api/auth/locale { locale } — server writes the cookie (and
//      persists to DB if signed in)
//   2. Hard refresh via window.location.reload() so next-intl re-reads
//      the cookie and re-loads the message JSON for the new locale.
//      Soft router.refresh() doesn't reliably clear next-intl's cached
//      messages on the client.

import { useState, useTransition } from 'react'
import { useLocale } from 'next-intl'
import { LOCALES, LOCALE_LABELS, LOCALE_FLAGS, type Locale } from '@/lib/i18n/config'

export function LanguageSelector({
  variant   = 'compact',
  onTone    = 'light',
  placement = 'bottom',
}: {
  variant?: 'compact' | 'inline'
  /** 'light' = white surfaces (e.g. landing). 'dark' = navy sidebar. */
  onTone?:  'light' | 'dark'
  /** Compact-variant menu position. 'top' = open upward (use when the
   *  trigger sits near the viewport bottom, like the sidebar footer).
   *  'bottom' (default) opens downward. */
  placement?: 'top' | 'bottom'
}) {
  const current = useLocale() as Locale
  const [open,    setOpen]    = useState<boolean>(false)
  const [pending, startPending] = useTransition()

  function pick(locale: Locale) {
    if (locale === current) { setOpen(false); return }
    startPending(async () => {
      try {
        const r = await fetch('/api/auth/locale', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ locale }),
        })
        if (r.ok) {
          // Hard reload — next-intl needs a fresh request to re-evaluate
          // the cookie and load the new language pack server-side.
          window.location.reload()
        }
      } catch {
        // Silent — the user can try again. Connection issue.
      }
    })
  }

  if (variant === 'inline') {
    return (
      <div style={{ display: 'inline-flex', gap: 6 }}>
        {LOCALES.map(loc => (
          <button
            key={loc}
            onClick={() => pick(loc)}
            disabled={pending}
            title={LOCALE_LABELS[loc]}
            style={{
              padding:    '6px 10px',
              background: loc === current ? (onTone === 'dark' ? '#fff' : '#1a1f2e') : 'transparent',
              color:      loc === current ? (onTone === 'dark' ? '#1a1f2e' : '#fff') : (onTone === 'dark' ? 'rgba(255,255,255,0.7)' : '#1a1f2e'),
              border:     `1px solid ${loc === current ? (onTone === 'dark' ? '#fff' : '#1a1f2e') : (onTone === 'dark' ? 'rgba(255,255,255,0.2)' : '#e5e7eb')}`,
              borderRadius: 999,
              fontSize:   12, fontWeight: 500,
              cursor:     pending ? 'wait' : 'pointer',
            }}
          >
            <span style={{ marginRight: 4 }}>{LOCALE_FLAGS[loc]}</span>
            {LOCALE_LABELS[loc]}
          </button>
        ))}
      </div>
    )
  }

  // compact (default) — flag button with dropdown.
  // When used in a narrow container like the sidebar, set placement="top"
  // → the wrapper goes full-width and the menu spans the trigger so neither
  // overflows the parent column.
  const isNarrowHost = placement === 'top'
  return (
    <div style={{
      position: 'relative' as const,
      display:  isNarrowHost ? 'block' : 'inline-block',
      width:    isNarrowHost ? '100%'  : 'auto',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={pending}
        title={LOCALE_LABELS[current]}
        style={{
          padding:      '6px 10px',
          background:   onTone === 'dark' ? 'rgba(255,255,255,0.06)' : 'white',
          color:        onTone === 'dark' ? 'rgba(255,255,255,0.85)' : '#374151',
          border:       `1px solid ${onTone === 'dark' ? 'rgba(255,255,255,0.12)' : '#e5e7eb'}`,
          borderRadius: 7,
          fontSize:     12, fontWeight: 500,
          cursor:       pending ? 'wait' : 'pointer',
          display:      isNarrowHost ? 'flex' : 'inline-flex',
          width:        isNarrowHost ? '100%' : 'auto',
          alignItems:   'center',
          justifyContent: 'space-between',
          gap:          6,
        }}
      >
        <span>{LOCALE_FLAGS[current]}</span>
        <span>{LOCALE_LABELS[current]}</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>▾</span>
      </button>
      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          style={{
            position: 'absolute' as const,
            ...(placement === 'top'
              ? { bottom: 'calc(100% + 4px)' }
              : { top:    'calc(100% + 4px)' }),
            // In narrow-host mode (sidebar), span the trigger's full width
            // so nothing overflows the column. Otherwise right-align.
            ...(isNarrowHost ? { left: 0, right: 0 } : { right: 0 }),
            background: onTone === 'dark' ? '#0f1421' : 'white',
            border:     `1px solid ${onTone === 'dark' ? 'rgba(255,255,255,0.12)' : '#e5e7eb'}`,
            borderRadius: 7,
            padding:    4,
            boxShadow:  '0 8px 24px rgba(0,0,0,0.18)',
            minWidth:   isNarrowHost ? 0 : 140,
            zIndex:     50,
          }}
        >
          {LOCALES.map(loc => (
            <button
              key={loc}
              onClick={() => pick(loc)}
              disabled={pending}
              style={{
                display:    'flex',
                alignItems: 'center',
                gap:        8,
                width:      '100%',
                padding:    '7px 10px',
                background: loc === current
                  ? (onTone === 'dark' ? 'rgba(255,255,255,0.08)' : '#f3f4f6')
                  : 'transparent',
                color:      onTone === 'dark' ? 'rgba(255,255,255,0.85)' : '#374151',
                border:     'none',
                borderRadius: 5,
                fontSize:   13, fontWeight: 500,
                cursor:     pending ? 'wait' : 'pointer',
                textAlign:  'left' as const,
              }}
            >
              <span>{LOCALE_FLAGS[loc]}</span>
              <span>{LOCALE_LABELS[loc]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
