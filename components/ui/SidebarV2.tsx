// components/ui/SidebarV2.tsx
//
// Redesigned sidebar per DESIGN.md § Sidebar. Phase 0 creates this alongside
// the existing `components/Sidebar.tsx`; Phase 1 swaps the import in AppShell
// so the old sidebar stays live until then.
//
// Ports from the existing Sidebar (answers to audit Q2 in session):
//   - Business / location picker near the top.
//   - Sync-status indicator ("Live · X ago", "Synced Xh ago").
//   - "Sync now" button that calls /api/resync (last 7 days). Shipped this
//     session — kept because it's a working feature, not a nav element.
//
// New behaviour from spec:
//   - Exactly 6 primary items + Invoices + Alerts + Settings (utility).
//   - Alerts badge shows the count of unread, non-dismissed anomaly_alerts.
//   - Collapse to 52 px icon-only state, persisted in localStorage.
//   - Icons inline SVG, 14×14, stroke-width 1.2.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { UX } from '@/lib/constants/tokens'
import SyncIndicator from './SyncIndicator'

interface Business {
  id:   string
  name: string
  city: string | null
}

type NavItem =
  | { kind: 'section', label: string }
  | { kind: 'link',    key: string, label: string, href: string, icon: IconName, sub?: boolean, alertBadge?: boolean }

type IconName =
  | 'overview' | 'group' | 'financials' | 'operations'
  | 'pnl' | 'budget' | 'forecast'
  | 'revenue' | 'staff' | 'scheduling' | 'departments'
  | 'invoices' | 'alerts' | 'settings' | 'plan'

// Spec § Sidebar — 6 primary items + Invoices + Alerts + Settings.
const NAV: NavItem[] = [
  { kind: 'link',    key: 'overview',                label: 'Overview',          href: '/dashboard',    icon: 'overview' },
  { kind: 'link',    key: 'group',                   label: 'Group',             href: '/group',        icon: 'group' },
  { kind: 'section', label: 'Financials' },
  { kind: 'link',    key: 'financials/pnl',          label: 'P&L Tracker',       href: '/tracker',                icon: 'pnl',      sub: true },
  { kind: 'link',    key: 'financials/budget',       label: 'Budget vs Actual',  href: '/budget',                 icon: 'budget',   sub: true },
  { kind: 'link',    key: 'financials/performance',  label: 'Performance',       href: '/financials/performance', icon: 'forecast', sub: true },
  { kind: 'link',    key: 'financials/forecast',     label: 'Forecast',          href: '/forecast',               icon: 'forecast', sub: true },
  { kind: 'link',    key: 'financials/overheads',    label: 'Overheads',         href: '/overheads',              icon: 'budget',   sub: true },
  { kind: 'section', label: 'Operations' },
  { kind: 'link',    key: 'operations/revenue',      label: 'Revenue',           href: '/revenue',      icon: 'revenue',     sub: true },
  { kind: 'link',    key: 'operations/staff',        label: 'Staff',             href: '/staff',        icon: 'staff',       sub: true },
  { kind: 'link',    key: 'operations/scheduling',   label: 'Scheduling',        href: '/scheduling',   icon: 'scheduling',  sub: true },
  { kind: 'link',    key: 'operations/departments',  label: 'Departments',       href: '/departments',  icon: 'departments', sub: true },
  { kind: 'link',    key: 'invoices',                label: 'Invoices',          href: '/invoices',     icon: 'invoices' },
  { kind: 'link',    key: 'alerts',                  label: 'Alerts',            href: '/alerts',       icon: 'alerts',  alertBadge: true },
]

export interface SidebarV2Props {
  activeKey?: string
}

export default function SidebarV2({ activeKey }: SidebarV2Props) {
  const pathname = usePathname()
  const router   = useRouter()

  const [collapsed,   setCollapsed]   = useState(false)
  const [businesses,  setBusinesses]  = useState<Business[]>([])
  const [selected,    setSelected]    = useState<Business | null>(null)
  const [showBizMenu, setShowBizMenu] = useState(false)
  const [userName,    setUserName]    = useState('')
  const [alertCount,  setAlertCount]  = useState(0)
  const bizMenuRef = useRef<HTMLDivElement | null>(null)

  // ── Hydrate collapse state from localStorage ───────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem('cc_sidebar_collapsed')
      if (saved === '1') setCollapsed(true)
    } catch { /* SSR / private mode */ }
  }, [])

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('cc_sidebar_collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }

  // ── Load user, businesses, initial selection ──────────────────────────────
  useEffect(() => {
    const db = createClient()
    db.auth.getUser().then(({ data: { user } }: any) => {
      if (user) setUserName(user.email?.split('@')[0] ?? 'User')
    })
    fetch('/api/businesses').then(r => r.json()).then((data: any) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const biz   = (saved && data.find((b: any) => b.id === saved)) ?? data[0]
      setSelected(biz)
      localStorage.setItem('cc_selected_biz', biz.id)
    }).catch(() => {})
  }, [])

  // ── Alerts count polling ──────────────────────────────────────────────────
  // Sync freshness lives in <SyncIndicator/> now, so this effect only
  // refreshes the alerts badge.
  useEffect(() => {
    if (!selected) return
    async function fetchAlertCount() {
      try {
        const r = await fetch('/api/alerts')
        if (!r.ok) return
        const list = await r.json()
        if (!Array.isArray(list)) return
        setAlertCount(list.filter((a: any) => !a.is_read && !a.is_dismissed).length)
      } catch { /* non-fatal */ }
    }

    fetchAlertCount()
    const refresh = setInterval(fetchAlertCount, 60_000)
    const focus   = () => fetchAlertCount()
    window.addEventListener('focus', focus)
    return () => { clearInterval(refresh); window.removeEventListener('focus', focus) }
  }, [selected])

  // ── Business picker outside-click ─────────────────────────────────────────
  useEffect(() => {
    if (!showBizMenu) return
    function onDown(e: MouseEvent) {
      if (bizMenuRef.current && !bizMenuRef.current.contains(e.target as any)) {
        setShowBizMenu(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showBizMenu])

  function pickBusiness(b: Business) {
    setSelected(b)
    localStorage.setItem('cc_selected_biz', b.id)
    window.dispatchEvent(new Event('storage'))
    setShowBizMenu(false)
  }

  async function signOut() {
    await createClient().auth.signOut()
    router.push('/login')
  }

  // ── Derived: current active key ───────────────────────────────────────────
  const currentKey = useMemo(() => {
    if (activeKey) return activeKey
    const p = pathname ?? ''
    // Utility-bar paths (Settings + Subscription) live below the main NAV
    // and aren't in the array — match them by pathname directly so the
    // highlight still works without each page passing activeKey.
    if (p === '/settings' || p.startsWith('/settings/')) return 'settings'
    if (p === '/upgrade'  || p.startsWith('/upgrade/'))  return 'upgrade'
    // Longest-prefix match so sub-nav highlights correctly.
    const matches = NAV.filter((n): n is Extract<NavItem, { kind: 'link' }> => n.kind === 'link')
      .filter(n => p === n.href || p.startsWith(n.href + '/'))
    if (!matches.length) return ''
    return matches.sort((a, b) => b.href.length - a.href.length)[0].key
  }, [pathname, activeKey])

  // ── Render ────────────────────────────────────────────────────────────────
  const W = collapsed ? UX.sidebarWCol : UX.sidebarW

  return (
    <aside
      aria-label="Primary"
      style={{
        width:        W,
        flexShrink:   0,
        background:   UX.navyDeep,
        color:        'white',
        display:      'flex',
        flexDirection: 'column',
        minHeight:    '100vh',
        transition:   'width .15s ease',
      }}
    >
      {/* Brand row + collapse toggle */}
      <div style={{
        display:       'flex',
        alignItems:    'center',
        justifyContent: collapsed ? 'center' : 'space-between',
        padding:       collapsed ? '12px 0' : '14px 12px 10px',
        borderBottom:  '0.5px solid rgba(255,255,255,0.06)',
      }}>
        {!collapsed && (
          <span style={{ fontSize: 12, fontWeight: UX.fwMedium, letterSpacing: '.08em' }}>
            COMMAND<span style={{ color: UX.indigoLight }}>·</span>CENTER
          </span>
        )}
        <button
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleCollapsed}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.5)', fontSize: 14, padding: 4, lineHeight: 1,
          }}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* Business picker */}
      {!collapsed && (
        <div ref={bizMenuRef} style={{ position: 'relative' as const, padding: '8px 10px', borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={() => setShowBizMenu(s => !s)}
            aria-expanded={showBizMenu}
            style={{
              width:      '100%',
              display:    'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap:        6,
              padding:    '7px 9px',
              background: 'rgba(255,255,255,0.04)',
              color:      'white',
              border:     '0.5px solid rgba(255,255,255,0.08)',
              borderRadius: UX.r_md,
              cursor:     'pointer',
              fontSize:   UX.fsBody,
              textAlign:  'left' as const,
            }}
          >
            <span style={{ overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const, fontWeight: UX.fwMedium }}>
              {selected?.name ?? 'Pick a business'}
            </span>
            <span aria-hidden style={{ color: 'rgba(255,255,255,0.45)', fontSize: UX.fsMicro }}>▾</span>
          </button>
          {showBizMenu && businesses.length > 0 && (
            <div style={{
              position: 'absolute' as const, top: 'calc(100% + 2px)', left: 10, right: 10,
              background: UX.navyDeep, border: '0.5px solid rgba(255,255,255,0.1)',
              borderRadius: UX.r_md, padding: 4, zIndex: 40,
              boxShadow: '0 8px 24px rgba(0,0,0,.4)',
            }}>
              {businesses.map(b => (
                <button
                  key={b.id}
                  onClick={() => pickBusiness(b)}
                  style={{
                    display:    'block',
                    width:      '100%',
                    textAlign:  'left' as const,
                    padding:    '7px 9px',
                    background: selected?.id === b.id ? UX.indigoTint : 'transparent',
                    color:      'white',
                    border:     'none',
                    borderRadius: UX.r_sm,
                    cursor:     'pointer',
                    fontSize:   UX.fsBody,
                  }}
                >
                  {b.name}
                  {b.city && <span style={{ color: 'rgba(255,255,255,0.35)', marginLeft: 6, fontSize: UX.fsMicro }}>{b.city}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sync status — shared SyncIndicator. Sole source of truth for the
          "Synced Nm ago" pill; REVENUE-FIX § 1 called out that inline
          copies kept drifting and rendering broken text. */}
      {selected && (
        <SyncIndicator
          collapsed={collapsed}
          businessId={selected.id}
          surface="dark"
        />
      )}

      {/* Nav */}
      <nav style={{ flex: 1, padding: '8px 6px', overflowY: 'auto' as const }}>
        {NAV.map((item, i) => {
          if (item.kind === 'section') {
            if (collapsed) {
              // Render a thin divider instead of the section label
              return <div key={`sec-${i}`} style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '10px 12px' }} />
            }
            return (
              <div key={`sec-${i}`} style={{
                fontSize:      9,
                fontWeight:    UX.fwMedium,
                color:         'rgba(255,255,255,0.3)',
                letterSpacing: '.1em',
                textTransform: 'uppercase' as const,
                padding:       '12px 10px 4px',
              }}>
                {item.label}
              </div>
            )
          }
          const active   = currentKey === item.key || currentKey.startsWith(item.key + '/')
          const count    = item.alertBadge && alertCount > 0 ? alertCount : 0
          const padL     = !collapsed && item.sub ? 20 : 10
          return (
            <button
              key={item.key}
              onClick={() => router.push(item.href)}
              title={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
              style={{
                display:        'flex',
                alignItems:     'center',
                justifyContent: collapsed ? 'center' : 'flex-start',
                gap:            9,
                width:          '100%',
                padding:        collapsed ? '7px 0' : `6px ${padL}px 6px ${padL}px`,
                margin:         '1px 0',
                background:     active ? UX.indigoTint : 'transparent',
                border:         'none',
                borderRadius:   UX.r_md,
                color:          active ? 'white' : 'rgba(255,255,255,0.55)',
                fontSize:       UX.fsBody,
                fontWeight:     active ? UX.fwMedium : UX.fwRegular,
                cursor:         'pointer',
                textAlign:      'left' as const,
                position:       'relative' as const,
              }}
            >
              <SidebarIcon
                name={item.icon}
                size={14}
                color={active ? UX.indigoLight : 'rgba(255,255,255,0.5)'}
              />
              {!collapsed && <span style={{ overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{item.label}</span>}
              {count > 0 && (
                collapsed
                  ? <span style={{ position: 'absolute' as const, top: 4, right: 8, width: 6, height: 6, borderRadius: '50%', background: UX.redInk }} />
                  : <span style={{
                      marginLeft: 'auto' as const,
                      background:  UX.redInk,
                      color:       'white',
                      fontSize:    9,
                      fontWeight:  UX.fwMedium,
                      padding:     '1px 5px',
                      borderRadius: 8,
                      minWidth:    16,
                      textAlign:   'center' as const,
                    }}>{count}</span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Utility: Subscription + Settings.
         FIXES §0oo (2026-04-28): added Subscription button. Page existed
         at /upgrade but was only reachable via the AI-quota banner or a
         PlanGate redirect — paying customers had no obvious nav entry to
         manage their plan. */}
      <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.06)', padding: '6px 6px' }}>
        <button
          onClick={() => router.push('/upgrade')}
          title={collapsed ? 'Subscription' : undefined}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 9, width: '100%', padding: collapsed ? '7px 0' : '6px 10px',
            background: (currentKey === 'upgrade') ? UX.indigoTint : 'transparent',
            border: 'none', borderRadius: UX.r_md,
            color: (currentKey === 'upgrade') ? 'white' : 'rgba(255,255,255,0.55)',
            fontSize: UX.fsBody, cursor: 'pointer', textAlign: 'left' as const,
            marginBottom: 2,
          }}
        >
          <SidebarIcon name="plan" size={14} color={currentKey === 'upgrade' ? UX.indigoLight : 'rgba(255,255,255,0.5)'} />
          {!collapsed && <span>Subscription</span>}
        </button>
        <button
          onClick={() => router.push('/settings')}
          title={collapsed ? 'Settings' : undefined}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 9, width: '100%', padding: collapsed ? '7px 0' : '6px 10px',
            background: (currentKey === 'settings') ? UX.indigoTint : 'transparent',
            border: 'none', borderRadius: UX.r_md,
            color: (currentKey === 'settings') ? 'white' : 'rgba(255,255,255,0.55)',
            fontSize: UX.fsBody, cursor: 'pointer', textAlign: 'left' as const,
          }}
        >
          <SidebarIcon name="settings" size={14} color={currentKey === 'settings' ? UX.indigoLight : 'rgba(255,255,255,0.5)'} />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>

      {/* User + sign out */}
      {!collapsed && (
        <div style={{
          borderTop: '0.5px solid rgba(255,255,255,0.06)',
          padding: '8px 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: UX.fsMicro,
        }}>
          <span style={{ color: 'rgba(255,255,255,0.35)', overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
            {userName || 'Signed in'}
          </span>
          <button
            onClick={signOut}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'rgba(255,255,255,0.35)', fontSize: UX.fsMicro, padding: 0,
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon set — inline SVG, 14×14, stroke-width 1.2, currentColor-compatible.
// Kept intentionally spartan + consistent across all nav items.
// ─────────────────────────────────────────────────────────────────────────────
function SidebarIcon({ name, size = 14, color = 'currentColor' }: { name: IconName; size?: number; color?: string }) {
  const common = {
    width:       size,
    height:      size,
    viewBox:     '0 0 24 24',
    fill:        'none',
    stroke:      color,
    strokeWidth: 1.2,
    strokeLinecap:  'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as any,
    style:       { flexShrink: 0, display: 'block' as const },
  }

  switch (name) {
    case 'overview':    return <svg {...common}><rect x="3" y="3"  width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>
    case 'group':       return <svg {...common}><circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><path d="M14 20c.5-2 2.5-3 4-3 1 0 2 .3 3 1"/></svg>
    case 'financials':  return <svg {...common}><path d="M4 20V8l8-5 8 5v12"/><path d="M8 20v-6h8v6"/></svg>
    case 'operations':  return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>
    case 'pnl':         return <svg {...common}><path d="M3 17l6-6 4 4 8-10"/><path d="M14 5h7v7"/></svg>
    case 'budget':      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M8 15h4"/></svg>
    case 'forecast':    return <svg {...common}><path d="M3 18l5-6 4 3 6-8 3 4"/><path d="M3 21h18"/></svg>
    case 'revenue':     return <svg {...common}><path d="M12 3v18"/><path d="M8 7h5a3 3 0 010 6H8"/><path d="M16 17h-5a3 3 0 010-6"/></svg>
    case 'staff':       return <svg {...common}><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>
    case 'scheduling':  return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/><circle cx="8" cy="14" r="1"/><circle cx="12" cy="14" r="1"/><circle cx="16" cy="14" r="1"/></svg>
    case 'departments': return <svg {...common}><rect x="3" y="3"  width="8" height="8" rx="1.5"/><rect x="13" y="3"  width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>
    case 'invoices':    return <svg {...common}><path d="M6 3h9l3 3v15l-3-2-3 2-3-2-3 2V3z"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>
    case 'alerts':      return <svg {...common}><path d="M6 9a6 6 0 1112 0c0 4 2 5 2 7H4c0-2 2-3 2-7z"/><path d="M10 20a2 2 0 004 0"/></svg>
    case 'settings':    return <svg {...common}><circle cx="12" cy="12" r="2.4"/><path d="M19.4 12.9a7.5 7.5 0 000-1.8l2-1.5-2-3.4-2.3.8a7.5 7.5 0 00-1.6-.9l-.3-2.4h-4l-.3 2.4a7.5 7.5 0 00-1.6.9l-2.3-.8-2 3.4 2 1.5a7.5 7.5 0 000 1.8l-2 1.5 2 3.4 2.3-.8a7.5 7.5 0 001.6.9l.3 2.4h4l.3-2.4a7.5 7.5 0 001.6-.9l2.3.8 2-3.4z"/></svg>
    case 'plan':        return <svg {...common}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>
  }
}
