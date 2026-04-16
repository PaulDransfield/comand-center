'use client'
// @ts-nocheck
// app/notebook/studio/page.tsx — AI Studio (coming soon)

import AppShell from '@/components/AppShell'
import Link from 'next/link'

export default function StudioPage() {
  return (
    <AppShell>
      <div style={{ padding: '40px 28px', maxWidth: 640 }}>
        <div style={{ marginBottom: 24 }}>
          <Link href="/notebook" style={{ fontSize: 13, color: '#6b7280', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            ← Assistant
          </Link>
        </div>

        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 16, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>✦</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', marginBottom: 8 }}>AI Studio</h1>
          <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6, marginBottom: 24 }}>
            Build custom AI-powered reports, set up scheduled insights, and create automated alerts — tailored to your restaurants.
          </p>
          <div style={{ display: 'inline-flex', padding: '6px 14px', background: '#f3f4f6', borderRadius: 20, fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
            Coming soon
          </div>
        </div>

        <div style={{ marginTop: 20, display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          {[
            { icon: '📊', title: 'Custom Reports', desc: 'Build reports across any data combination' },
            { icon: '⏰', title: 'Scheduled Insights', desc: 'Automated weekly and monthly summaries' },
            { icon: '🔔', title: 'Smart Alerts', desc: 'Define custom thresholds for anomaly detection' },
            { icon: '📧', title: 'Email Digests', desc: 'Deliver insights directly to your inbox' },
          ].map(item => (
            <div key={item.title} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 22, marginBottom: 8 }}>{item.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>{item.title}</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>{item.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  )
}
