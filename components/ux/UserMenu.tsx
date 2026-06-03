'use client'
// components/ux/UserMenu.tsx
//
// Avatar pill with a dropdown for the new top toolbar. Contains the
// language selector, a settings shortcut, and sign-out. Ports the
// user-row behaviour that lived at the bottom of SidebarV2 so the rail
// can stay icon-only.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LanguageSelector } from '@/components/LanguageSelector'
import { UXP } from '@/lib/constants/tokens'

export default function UserMenu() {
  const ref = useRef<HTMLDivElement | null>(null)
  const router = useRouter()
  const [email,  setEmail]  = useState<string>('')
  const [open,   setOpen]   = useState(false)

  useEffect(() => {
    const db = createClient()
    db.auth.getUser().then(({ data: { user } }: any) => {
      if (user?.email) setEmail(user.email as string)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  async function signOut() {
    await createClient().auth.signOut()
    router.push('/login')
  }

  const initial = (email.split('@')[0] || '?').slice(0, 2).toUpperCase()

  return (
    <div ref={ref} style={{ position: 'relative' as const }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Account"
        aria-expanded={open}
        style={{
          width:          28,
          height:         28,
          borderRadius:   '50%',
          background:     UXP.lavFill,
          color:          UXP.lavText,
          border:         `0.5px solid ${UXP.border}`,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          fontSize:       10,
          fontWeight:     600,
          fontFamily:     'inherit',
          cursor:         'pointer',
          padding:        0,
        }}
      >
        {initial}
      </button>

      {open && (
        <div
          className="cc-user-menu-pop"
          style={{
            position:     'absolute' as const,
            top:          'calc(100% + 6px)',
            right:        0,
            minWidth:     220,
            maxWidth:     'calc(100vw - 16px)',
            background:   UXP.cardBg,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_md,
            padding:      6,
            zIndex:       400,
            boxShadow:    '0 8px 24px rgba(58,53,80,0.12)',
            display:      'grid',
            gap:          4,
          }}
        >
          <style>{`
            @media (max-width: 600px) {
              .cc-user-menu-pop {
                position: fixed !important;
                top: auto !important;
                bottom: 8px !important;
                left: 8px !important;
                right: 8px !important;
                min-width: 0 !important;
                max-width: none !important;
              }
            }
          `}</style>
          <div style={{
            padding:    '6px 8px',
            fontSize:   10,
            color:      UXP.ink3,
            overflow:   'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {email || 'Signed in'}
          </div>

          <div style={{ borderTop: `0.5px solid ${UXP.borderSoft}`, padding: '6px 4px' }}>
            <LanguageSelector variant="compact" onTone="light" placement="bottom" />
          </div>

          <MenuItem
            label="Settings"
            onClick={() => { setOpen(false); router.push('/settings') }}
          />
          <MenuItem
            label="Subscription"
            onClick={() => { setOpen(false); router.push('/upgrade') }}
          />
          <div style={{ borderTop: `0.5px solid ${UXP.borderSoft}`, marginTop: 2 }} />
          <MenuItem label="Sign out" onClick={signOut} tone="rose" />
        </div>
      )}
    </div>
  )
}

function MenuItem({ label, onClick, tone }: { label: string; onClick: () => void; tone?: 'rose' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display:      'block',
        width:        '100%',
        textAlign:    'left' as const,
        padding:      '7px 9px',
        background:   'transparent',
        color:        tone === 'rose' ? UXP.roseText : UXP.ink1,
        border:       'none',
        borderRadius: UXP.r_sm,
        cursor:       'pointer',
        fontSize:     11,
        fontFamily:   'inherit',
      }}
    >
      {label}
    </button>
  )
}
