'use client'
// components/ux/RailSyncSlot.tsx
//
// Thin wrapper that mounts <SyncIndicator collapsed/> at the bottom of
// the icon rail. Subscribes to the `cc_selected_biz` localStorage key
// (set by BizPicker / the dashboard) so the rail's sync dot reflects
// the currently-selected business without prop-drilling through AppShell.

import { useEffect, useState } from 'react'
import SyncIndicator from '@/components/ui/SyncIndicator'

export default function RailSyncSlot() {
  const [bizId, setBizId] = useState<string | null>(null)

  useEffect(() => {
    function read() {
      try { setBizId(localStorage.getItem('cc_selected_biz')) } catch {}
    }
    read()
    window.addEventListener('storage', read)
    return () => window.removeEventListener('storage', read)
  }, [])

  return <SyncIndicator businessId={bizId} collapsed surface="light" />
}
