'use client'
// components/admin/v2/IncidentRow.tsx
//
// Single row in the overview's incidents strip. Severity dot + title +
// org meta + jump link. Click anywhere on the row → jump.

import type { Incident } from '@/lib/admin/v2/types'

const DOT: Record<string, string> = {
  critical: '#dc2626',
  warn:     '#d97706',
  info:     '#2563eb',
  ok:       '#15803d',
}

export function IncidentRow({ incident }: { incident: Incident }) {
  const dot = DOT[incident.severity] ?? '#9ca3af'
  return (
    <a
      href={incident.href}
      style={{
        display:        'flex',
        alignItems:     'center',
        gap:            12,
        padding:        '10px 12px',
        borderBottom:   '1px solid #f3f4f6',
        textDecoration: 'none',
        color:          'inherit',
        cursor:         'pointer',
        transition:     'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = '#fafbfc')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{
        width:        8,
        height:       8,
        borderRadius: '50%',
        background:   dot,
        flexShrink:   0,
      }} />

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: '#111', fontWeight: 500, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
          {incident.org_name && <span style={{ color: '#6b7280', fontWeight: 400 }}>{incident.org_name} · </span>}
          {incident.title}
        </div>
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
          {incident.detail}
        </div>
      </div>

      <span style={{
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        color:         dot,
        whiteSpace:    'nowrap' as const,
      }}>
        {incident.severity}
      </span>

      <span aria-hidden style={{ fontSize: 14, color: '#9ca3af' }}>→</span>
    </a>
  )
}
