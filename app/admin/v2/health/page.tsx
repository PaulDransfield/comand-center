'use client'
// app/admin/v2/health/page.tsx — PR 7.

export default function HealthPage() {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 40, textAlign: 'center' as const }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 8 }}>HEALTH</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: '#111', marginBottom: 4 }}>Coming in PR 7</div>
      <div style={{ fontSize: 12, color: '#9ca3af' }}>Crons, migrations, RLS, Sentry, Anthropic spend, Stripe webhook health.</div>
    </div>
  )
}
