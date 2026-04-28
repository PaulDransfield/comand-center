'use client'
// app/admin/v2/overview/page.tsx
// Placeholder for PR 1. Real implementation lands in PR 2 (incidents
// strip + KPI strip).

export default function OverviewPage() {
  return <Placeholder tab="Overview" pr={2} />
}

function Placeholder({ tab, pr }: { tab: string; pr: number }) {
  return (
    <div style={{
      background:    'white',
      border:        '1px solid #e5e7eb',
      borderRadius:  10,
      padding:       40,
      textAlign:     'center' as const,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 8 }}>
        {tab.toUpperCase()}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: '#111', marginBottom: 4 }}>
        Coming in PR {pr}
      </div>
      <div style={{ fontSize: 12, color: '#9ca3af' }}>
        Foundation only in PR 1 — nav, layout, command-palette stub.
      </div>
    </div>
  )
}
