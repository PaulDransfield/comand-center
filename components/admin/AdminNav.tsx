'use client'
// components/admin/AdminNav.tsx
// Shared navigation strip used across all /admin/* pages so pages feel like one app.

import { usePathname, useRouter } from 'next/navigation'

const TABS = [
  { href: '/admin/overview',  label: 'Overview' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/agents',    label: 'Agents' },
  { href: '/admin/health',    label: 'Health' },
]

export function AdminNav() {
  const pathname = usePathname() ?? ''
  const router = useRouter()

  function logout() {
    if (typeof window !== 'undefined') sessionStorage.removeItem('admin_auth')
    router.push('/admin/login')
  }

  return (
    <div style={{
      background: 'white', borderBottom: '1px solid #e5e7eb',
      padding: '0 24px', display: 'flex', alignItems: 'center',
      gap: 0, overflowX: 'auto', position: 'sticky', top: 0, zIndex: 50,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginRight: 24, padding: '14px 0', whiteSpace: 'nowrap' }}>
        CommandCenter Admin
      </div>
      {TABS.map(tab => {
        const active = pathname.startsWith(tab.href)
        return (
          <a
            key={tab.href}
            href={tab.href}
            style={{
              padding: '14px 14px', fontSize: 13, fontWeight: 600,
              color: active ? '#111' : '#6b7280',
              borderBottom: active ? '2px solid #1a1f2e' : '2px solid transparent',
              textDecoration: 'none', whiteSpace: 'nowrap',
              transition: 'color .15s',
            }}
          >
            {tab.label}
          </a>
        )
      })}
      <div style={{ flex: 1 }} />
      <a href="/dashboard" style={{ padding: '14px 12px', fontSize: 12, color: '#6b7280', textDecoration: 'none', whiteSpace: 'nowrap' }}>
        Back to app ↗
      </a>
      <button
        onClick={logout}
        style={{ padding: '8px 14px', background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer', marginLeft: 8, marginRight: 0 }}
      >
        Logout
      </button>
    </div>
  )
}
