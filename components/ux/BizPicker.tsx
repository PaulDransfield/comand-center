'use client'
// components/ux/BizPicker.tsx
//
// Multi-tenant business selector for the new top toolbar. Ports the
// behaviour from SidebarV2's business picker so the rail can stay
// icon-only: business switch happens up in the toolbar instead.
//
//   • Reads /api/businesses, persists selection in `cc_selected_biz`.
//   • Dispatches a 'storage' event so the dashboard's own bizId listener
//     re-syncs when the user switches business.
//   • UXP pastel pill styling — no navy.

import { useEffect, useRef, useState } from 'react'
import { UXP } from '@/lib/constants/tokens'
import { Popover } from '@/components/ui/Popover'

interface Business {
  id:         string
  name:       string
  city:       string | null
  org_number: string | null
}

export default function BizPicker() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [selected,   setSelected]   = useState<Business | null>(null)
  const [open,       setOpen]       = useState(false)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const biz   = (saved && data.find((b: any) => b.id === saved)) ?? data[0]
      setSelected(biz)
      localStorage.setItem('cc_selected_biz', biz.id)
    }).catch(() => {})
  }, [])

  // Reflect cross-tab/cross-component picker changes.
  useEffect(() => {
    function onStorage() {
      const s = localStorage.getItem('cc_selected_biz')
      if (!s) return
      setSelected(prev => prev && prev.id === s ? prev : (businesses.find(b => b.id === s) ?? prev))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [businesses])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function pick(b: Business) {
    setSelected(b)
    localStorage.setItem('cc_selected_biz', b.id)
    window.dispatchEvent(new Event('storage'))
    setOpen(false)
  }

  // Single-business orgs: render a static label, no dropdown.
  if (businesses.length <= 1) {
    return (
      <span
        style={{
          padding:      '5px 10px',
          background:   UXP.cardBg,
          color:        UXP.ink1,
          border:       `0.5px solid rgba(58,53,80,0.1)`,
          borderRadius: 7,
          fontSize:     11,
          fontWeight:   500,
          maxWidth:     180,
          overflow:     'hidden',
          textOverflow: 'ellipsis',
          whiteSpace:   'nowrap',
        }}
      >
        {selected?.name ?? '—'}
      </span>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative' as const }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display:      'inline-flex',
          alignItems:   'center',
          gap:          6,
          padding:      '5px 10px',
          background:   UXP.cardBg,
          color:        UXP.ink1,
          border:       `0.5px solid rgba(58,53,80,0.1)`,
          borderRadius: 7,
          fontSize:     11,
          fontWeight:   500,
          fontFamily:   'inherit',
          cursor:       'pointer',
          maxWidth:     180,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.name ?? 'Select business'}
        </span>
        <span aria-hidden style={{ color: UXP.ink3, fontSize: 10 }}>▾</span>
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="left"
        menuWidth={200}
        title="Select business"
      >
        {businesses.map(b => (
          <button
            key={b.id}
            type="button"
            onClick={() => pick(b)}
            style={{
              display:      'block',
              width:        '100%',
              textAlign:    'left' as const,
              padding:      '9px 10px',
              background:   selected?.id === b.id ? UXP.lavFill : 'transparent',
              color:        selected?.id === b.id ? UXP.lavText : UXP.ink1,
              border:       'none',
              borderRadius: UXP.r_sm,
              cursor:       'pointer',
              fontSize:     12,
              fontFamily:   'inherit',
            }}
          >
            {b.name}
            {b.city && (
              <span style={{ color: UXP.ink3, marginLeft: 6, fontSize: 10 }}>{b.city}</span>
            )}
          </button>
        ))}
      </Popover>
    </div>
  )
}
