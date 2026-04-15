// lib/hooks/useSelectedBusiness.ts
// Returns the currently selected business_id from localStorage
// Automatically updates when the sidebar switches business

'use client'

import { useState, useEffect } from 'react'

export function useSelectedBusiness() {
  const [selectedId, setSelectedId] = useState<string>('')
  const [businesses, setBusinesses] = useState<any[]>([])
  const [selected,   setSelected]   = useState<any>(null)

  useEffect(() => {
    // Load businesses
    fetch('/api/businesses')
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data)) return
        setBusinesses(data)

        const sync = () => {
          const saved = localStorage.getItem('cc_selected_biz')
          const biz   = (saved && data.find(b => b.id === saved)) ? data.find(b => b.id === saved) : data[0]
          if (biz) {
            setSelectedId(biz.id)
            setSelected(biz)
            localStorage.setItem('cc_selected_biz', biz.id)
          }
        }

        sync()
        window.addEventListener('storage', sync)
        return () => window.removeEventListener('storage', sync)
      })
      .catch(() => {})
  }, [])

  return { selectedId, selected, businesses }
}
