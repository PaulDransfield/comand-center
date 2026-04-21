// components/ui/SyncIndicator.tsx
//
// Single shared sync-status pill used by every sidebar/topbar. The combined
// dot + label + click-to-resync was duplicated across places and repeatedly
// rendered as a broken truncated "Synpd 5m ago" hybrid with a separate "Sync
// now" button crammed next to it. This component is the one source of truth.
//
// Behaviour:
//   - collapsed: dot only (6–7 px), tooltip with label, click = sync
//   - expanded : dot + "Synced Nm ago" / "Syncing…" / "Never synced"; click
//                anywhere on the pill fires /api/resync for the given business
//   - syncing  : the dot spins (indigoLight), label reads "Syncing…"
//   - toast    : reuses a fixed-position status toast bottom-left for 4 s
//
// Never truncates mid-word: `white-space: nowrap` + `overflow: visible` on the
// label, `min-width: 0` on the flex child so ellipsis would show "..." rather
// than "Synpd" if the container ever squeezed.

'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { UX } from '@/lib/constants/tokens'

export interface SyncIndicatorProps {
  /** business_id — required to actually fire a resync. null disables the click. */
  businessId: string | null
  /** collapsed sidebar state — hides the label, shows only the dot */
  collapsed?: boolean
  /**
   * Optional: render inside a dark background (e.g. the navy sidebar).
   * Controls the label colour + border. Defaults to `dark`.
   */
  surface?: 'dark' | 'light'
}

export default function SyncIndicator({
  businessId,
  collapsed = false,
  surface = 'dark',
}: SyncIndicatorProps) {
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [busy,        setBusy]      = useState(false)
  const [toast,       setToast]     = useState('')
  const [now,         setNow]       = useState(Date.now())

  // Load + refresh the latest sync timestamp for this business.
  useEffect(() => {
    if (!businessId) { setLastSyncAt(null); return }
    let cancelled = false
    async function fetchLast() {
      try {
        const db = createClient()
        const { data } = await (db as any)
          .from('integrations')
          .select('last_sync_at')
          .eq('business_id', businessId)
          .not('last_sync_at', 'is', null)
          .order('last_sync_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!cancelled) setLastSyncAt(data?.last_sync_at ?? null)
      } catch { /* non-fatal */ }
    }
    fetchLast()
    const tick    = setInterval(() => setNow(Date.now()), 60_000)
    const refresh = setInterval(fetchLast, 60_000)
    const focus   = () => fetchLast()
    window.addEventListener('focus', focus)
    return () => {
      cancelled = true
      clearInterval(tick); clearInterval(refresh)
      window.removeEventListener('focus', focus)
    }
  }, [businessId])

  const label = useMemo(() => {
    if (busy) return 'Syncing…'
    if (!lastSyncAt) return 'Never synced'
    const d = new Date(lastSyncAt)
    const diffMin = Math.floor((now - d.getTime()) / 60_000)
    if (diffMin < 1)  return 'Synced just now'
    if (diffMin < 60) return `Synced ${diffMin}m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `Synced ${diffH}h ago`
    return `Synced ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
  }, [lastSyncAt, now, busy])

  const fresh = !!lastSyncAt && (now - new Date(lastSyncAt).getTime()) < 30 * 60_000

  async function run() {
    if (!businessId || busy) return
    setBusy(true); setToast('')
    try {
      const r = await fetch('/api/resync', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: businessId }),
      })
      const j = await r.json()
      if (!r.ok)              setToast(j.error ?? `Failed (${r.status})`)
      else if (j.errors > 0)  setToast(`Synced with ${j.errors} error${j.errors === 1 ? '' : 's'}`)
      else                    setToast(`Synced ${j.synced} integration${j.synced === 1 ? '' : 's'}`)
      setNow(Date.now()) // force the label to re-evaluate with the new timestamp once the effect refetches
    } catch (e: any) {
      setToast('Sync failed — ' + (e?.message ?? 'network'))
    }
    setBusy(false)
    setTimeout(() => setToast(''), 4000)
  }

  const dotColour = busy ? UX.indigoLight : fresh ? '#10b981' : UX.amberInk
  const labelColour = surface === 'dark' ? 'rgba(255,255,255,0.6)' : UX.ink3
  const borderColour = surface === 'dark' ? '0.5px solid rgba(255,255,255,0.06)' : `0.5px solid ${UX.border}`

  return (
    <>
      <button
        onClick={run}
        disabled={busy || !businessId}
        title={`${label}${busy || !businessId ? '' : ' — click to refresh'}`}
        style={{
          width:          '100%',
          display:        'flex',
          alignItems:     'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap:            7,
          padding:        collapsed ? '6px 0' : '6px 12px',
          background:     'transparent',
          border:         'none',
          borderBottom:   borderColour,
          cursor:         busy || !businessId ? 'default' : 'pointer',
          color:          labelColour,
          fontSize:       UX.fsMicro,
          fontFamily:     'inherit',       // prevent Windows substitution that was rendering "Spued"
          lineHeight:     1.4,
          textAlign:      'left' as const,
          overflow:       'hidden' as const,
        }}
      >
        <span
          className={busy ? 'cc-sync-spin' : undefined}
          style={{
            width:        collapsed ? 7 : 6,
            height:       collapsed ? 7 : 6,
            borderRadius: '50%',
            background:   dotColour,
            boxShadow:    fresh && !busy ? '0 0 6px rgba(16,185,129,0.55)' : 'none',
            flexShrink:   0,
            display:      'inline-block',
          }}
        />
        {!collapsed && (
          <span style={{
            minWidth:    0,
            flex:        '1 1 auto',
            whiteSpace:  'nowrap' as const,
            overflow:    'hidden' as const,
            textOverflow:'ellipsis' as const,
          }}>
            {label}
          </span>
        )}
      </button>
      {!collapsed && (
        <style>{`
          @keyframes cc-sync-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
          .cc-sync-spin { animation: cc-sync-spin 1.2s linear infinite; }
        `}</style>
      )}
      {toast && (
        <div role="status" style={{
          position: 'fixed' as const, bottom: 24, left: 24, background: UX.navy, color: 'white',
          padding: '10px 14px', borderRadius: UX.r_md, fontSize: UX.fsBody,
          boxShadow: '0 6px 18px rgba(0,0,0,.3)', zIndex: 1000,
        }}>
          {toast}
        </div>
      )}
    </>
  )
}
