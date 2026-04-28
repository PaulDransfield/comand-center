'use client'
// app/admin/v2/customers/page.tsx
// Placeholder for PR 1. Real implementation lands in PR 3 (list view
// with filter chips + free-text search).

export default function CustomersPage() {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 40, textAlign: 'center' as const }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 8 }}>CUSTOMERS</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: '#111', marginBottom: 4 }}>Coming in PR 3</div>
      <div style={{ fontSize: 12, color: '#9ca3af' }}>List view, filter chips, search.</div>
    </div>
  )
}
