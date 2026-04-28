'use client'
// components/admin/v2/AdminNavV2.tsx
//
// New admin nav for the /admin/v2 surface. Same visual pattern as the
// existing AdminNav but with the new tab list (6 tabs vs 5) and a "v2"
// pill badge so Paul can tell at a glance which version he's in during
// the migration.
//
// Tabs per Admin-Console-Rebuild-Plan.md:
//   Overview · Customers · Agents · Health · Audit · Tools

import { usePathname, useRouter } from 'next/navigation'
import { clearAdminSecret } from '@/lib/admin/v2/api-client'

const TABS = [
  { href: '/admin/v2/overview',  label: 'Overview' },
  { href: '/admin/v2/customers', label: 'Customers' },
  { href: '/admin/v2/agents',    label: 'Agents' },
  { href: '/admin/v2/health',    label: 'Health' },
  { href: '/admin/v2/audit',     label: 'Audit' },
  { href: '/admin/v2/tools',     label: 'Tools' },
]

export function AdminNavV2() {
  const pathname = usePathname() ?? ''
  const router   = useRouter()

  function logout() {
    clearAdminSecret()
    router.push('/admin/login')
  }

  return (
    <div style={{
      background:  'white',
      borderBottom:'1px solid #e5e7eb',
      padding:     '0 24px',
      display:     'flex',
      alignItems:  'center',
      gap:         0,
      overflowX:   'auto' as const,
      position:    'sticky' as const,
      top:         0,
      zIndex:      50,
    }}>
      <div style={{
        display:    'flex',
        alignItems: 'center',
        gap:        8,
        marginRight:24,
        padding:    '14px 0',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111', whiteSpace: 'nowrap' }}>
          CommandCenter Admin
        </span>
        {/* v2 pill — temporary marker through the migration. Removed in
            cleanup PR ≥30 days after cut-over. */}
        <span style={{
          fontSize:      9,
          fontWeight:    700,
          letterSpacing: '0.06em',
          padding:       '2px 6px',
          borderRadius:  3,
          background:    '#eef2ff',
          color:         '#4338ca',
        }}>
          V2
        </span>
      </div>

      {TABS.map(tab => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + '/')
        return (
          <a
            key={tab.href}
            href={tab.href}
            style={{
              padding:        '14px 14px',
              fontSize:       13,
              fontWeight:     600,
              color:          active ? '#111' : '#6b7280',
              borderBottom:   active ? '2px solid #1a1f2e' : '2px solid transparent',
              textDecoration: 'none',
              whiteSpace:     'nowrap' as const,
              transition:     'color .15s',
            }}
          >
            {tab.label}
          </a>
        )
      })}

      <div style={{ flex: 1 }} />

      <a
        href="/dashboard"
        style={{
          padding:        '14px 12px',
          fontSize:       12,
          color:          '#6b7280',
          textDecoration: 'none',
          whiteSpace:     'nowrap' as const,
        }}
      >
        Back to app ↗
      </a>
      <button
        onClick={logout}
        style={{
          padding:      '8px 14px',
          background:   'none',
          border:       '1px solid #e5e7eb',
          borderRadius: 7,
          fontSize:     12,
          fontWeight:   600,
          color:        '#374151',
          cursor:       'pointer',
          marginLeft:   8,
        }}
      >
        Logout
      </button>
    </div>
  )
}
