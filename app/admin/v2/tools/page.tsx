'use client'
// app/admin/v2/tools/page.tsx — PR 9.

export default function ToolsPage() {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 40, textAlign: 'center' as const }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 8 }}>TOOLS</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: '#111', marginBottom: 4 }}>Coming in PR 9</div>
      <div style={{ fontSize: 12, color: '#9ca3af' }}>Backfill weather, run discovery, test connections, safe SQL runner.</div>
    </div>
  )
}
