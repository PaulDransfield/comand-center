// components/Sidebar.tsx
// Shared sidebar navigation — used by all authenticated pages
// Dark sidebar with business switcher, grouped nav, AI section highlighted

'use client'

import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface Business {
  id:   string
  name: string
  city: string | null
}

const NAV = [
  { label: 'Overview', href: '/dashboard', section: null },
  { section: 'Financials' },
  { label: 'P&L Tracker',     href: '/tracker'        },
  { label: 'Budget vs Actual', href: '/budget'         },
  { label: 'VAT',              href: '/vat'            },
  { label: 'Food / Bev',       href: '/revenue-split'  },
  { label: 'Forecast',          href: '/forecast'       },
  { section: 'Operations' },
  { label: 'Revenue',          href: '/revenue'        },
  { label: 'Staff',            href: '/staff'          },
  { label: 'Departments',       href: '/departments'    },
  { label: 'Invoices',         href: '/invoices'       },
  { label: 'Alerts',           href: '/alerts'         },
]

const AI_NAV = [
  { label: 'Assistant',  href: '/notebook'       },
  { label: 'Studio',     href: '/notebook/studio' },
]

const BOTTOM_NAV = [
  { label: 'Integrations', href: '/integrations' },
  { label: 'Settings',     href: '/settings'     },
  { label: 'Upgrade',      href: '/upgrade', accent: true },
]

export default function Sidebar() {
  const pathname   = usePathname()
  const router     = useRouter()
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [selected,   setSelected]   = useState<Business | null>(null)
  const [showBizMenu, setShowBizMenu] = useState(false)
  const [userName,   setUserName]   = useState('')
  const [syncStatus, setSyncStatus] = useState<any>(null)

  useEffect(() => {
    const db = createClient()
    db.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      setUserName(user.email?.split('@')[0] ?? 'User')
    })
    fetch('/api/businesses').then(r => r.json()).then(data => {
      data = Array.isArray(data) ? data.filter((b: any) => b.is_active !== false) : data
      if (Array.isArray(data) && data.length > 0) {
        setBusinesses(data)
        const saved = localStorage.getItem('cc_selected_biz')
        const found = saved ? data.find((b: Business) => b.id === saved) : null
        const biz = found ?? data[0]
        setSelected(biz)
        fetchSyncStatus(biz.id)
      }
    })
  }, [])

  async function fetchSyncStatus(bizId: string) {
    try {
      const db = (await import('@/lib/supabase/client')).createClient()
      const { data } = await db
        .from('integrations')
        .select('last_sync_at, status')
        .eq('business_id', bizId)
        .eq('status', 'connected')
        .order('last_sync_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      setSyncStatus(data ?? null)
    } catch { setSyncStatus(null) }
  }

  function selectBiz(biz: Business) {
    setSelected(biz)
    localStorage.setItem('cc_selected_biz', biz.id)
    fetchSyncStatus(biz.id)
    // Notify other components on same page
    window.dispatchEvent(new Event('storage'))
    setShowBizMenu(false)
    window.dispatchEvent(new CustomEvent('cc_biz_change', { detail: biz }))
  }

  async function handleSignOut() {
    const db = createClient()
    await db.auth.signOut()
    router.push('/login')
  }

  const isActive = (href: string) => pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
  const isAiActive = AI_NAV.some(n => pathname.startsWith(n.href))

  return (
    <div style={{
      width: 220, minHeight: '100vh', background: '#1a1f2e',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
      position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 40,
      borderRight: '0.5px solid rgba(255,255,255,0.06)',
    }}>
      {/* Logo + business switcher */}
      <div style={{ padding: '16px 14px 12px', borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'white', letterSpacing: '-.01em', marginBottom: 10 }}>
          CommandCenter
        </div>
        {selected && (
          <div style={{ position: 'relative' }}>
            <div onClick={() => setShowBizMenu(s => !s)}
              style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'white' }}>{selected.name}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>{selected.city ?? 'Restaurant'}</div>
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>▾</div>
            </div>
            {showBizMenu && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#252d3d', borderRadius: 8, border: '0.5px solid rgba(255,255,255,0.1)', marginTop: 4, zIndex: 50, overflow: 'hidden' }}>
                {businesses.map(biz => (
                  <div key={biz.id} onClick={() => selectBiz(biz)}
                    style={{ padding: '8px 12px', cursor: 'pointer', background: selected.id === biz.id ? 'rgba(99,102,241,0.2)' : 'transparent' }}>
                    <div style={{ fontSize: 12, color: 'white', fontWeight: selected.id === biz.id ? 500 : 400 }}>{biz.name}</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{biz.city ?? 'Restaurant'}</div>
                  </div>
                ))}
                <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.08)', padding: '7px 12px', cursor: 'pointer' }}
                  onClick={() => { setShowBizMenu(false); router.push('/settings') }}>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>+ Add location</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sync status */}
      {syncStatus?.last_sync_at && (
        <div style={{ padding: '6px 14px', borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', display: 'inline-block', flexShrink: 0 }} />
            {(() => {
              const d = new Date(syncStatus.last_sync_at)
              const now = new Date()
              const diffH = Math.floor((now.getTime() - d.getTime()) / 3600000)
              if (diffH < 1) return 'Synced just now'
              if (diffH < 24) return `Synced ${diffH}h ago`
              return `Synced ${d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })}`
            })()}
          </div>
        </div>
      )}

      {/* Main nav */}
      <div style={{ padding: '8px 8px', flex: 1, overflowY: 'auto' }}>
        {NAV.map((item, i) => {
          if ('section' in item && item.section) return (
            <div key={i} style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.25)', letterSpacing: '.1em', textTransform: 'uppercase', padding: '10px 8px 3px' }}>
              {item.section}
            </div>
          )
          if (!item.href) return null
          const active = isActive(item.href)
          return (
            <div key={item.href} onClick={() => router.push(item.href)}
              style={{ borderRadius: 6, padding: '6px 8px', marginBottom: 1, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                background: active ? 'rgba(99,102,241,0.15)' : 'transparent' }}>
              <div style={{ width: 4, height: 4, borderRadius: '50%', flexShrink: 0, background: active ? '#6366f1' : 'rgba(255,255,255,0.15)' }} />
              <span style={{ fontSize: 12, color: active ? 'white' : 'rgba(255,255,255,0.55)', fontWeight: active ? 500 : 400 }}>
                {item.label}
              </span>
            </div>
          )
        })}

        {/* AI Assistant section — highlighted */}
        <div style={{ margin: '10px 0 4px', borderRadius: 8, overflow: 'hidden', background: 'linear-gradient(135deg, #312e81, #1e1b4b)', border: '0.5px solid rgba(99,102,241,0.35)' }}>
          <div style={{ padding: '8px 10px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#818cf8' }} />
            <span style={{ fontSize: 11, fontWeight: 500, color: '#c7d2fe' }}>AI Assistant</span>
            <span style={{ marginLeft: 'auto', fontSize: 9, background: 'rgba(99,102,241,0.3)', color: '#a5b4fc', padding: '1px 5px', borderRadius: 3 }}>BETA</span>
          </div>
          {AI_NAV.map(n => {
            const active = pathname === n.href
            return (
              <div key={n.href} onClick={() => router.push(n.href)}
                style={{ padding: '5px 10px 5px 24px', fontSize: 11, cursor: 'pointer', borderRadius: 4, margin: '1px 4px',
                  background: active ? 'rgba(99,102,241,0.25)' : 'transparent',
                  color: active ? 'white' : 'rgba(199,210,254,0.7)',
                  fontWeight: active ? 500 : 400 }}>
                {n.label}
              </div>
            )
          })}
          <div style={{ padding: '4px 10px 8px', fontSize: 9, color: 'rgba(165,180,252,0.5)', lineHeight: 1.4 }}>
            Powered by your live data
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <div style={{ padding: '8px 8px', borderTop: '0.5px solid rgba(255,255,255,0.06)' }}>
        {BOTTOM_NAV.map(item => {
          const active = isActive(item.href)
          return (
            <div key={item.href} onClick={() => router.push(item.href)}
              style={{ borderRadius: 6, padding: '6px 8px', marginBottom: 1, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                background: active ? 'rgba(99,102,241,0.15)' : 'transparent' }}>
              <div style={{ width: 4, height: 4, borderRadius: '50%', flexShrink: 0, background: active ? '#6366f1' : 'rgba(255,255,255,0.1)' }} />
              <span style={{ fontSize: 12, fontWeight: active ? 500 : 400,
                color: item.accent ? '#818cf8' : active ? 'white' : 'rgba(255,255,255,0.45)' }}>
                {item.label}
              </span>
            </div>
          )
        })}
        {/* User + sign out */}
        <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.06)', marginTop: 8, paddingTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{userName}</span>
          <span onClick={handleSignOut} style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', cursor: 'pointer' }}>Sign out</span>
        </div>
      </div>
    </div>
  )
}
