'use client'
// app/revisor/page.tsx
//
// Read-only landing page for the customer's external accountant (revisor).
// Lists the businesses the revisor has been granted access to, plus the
// last 12 closed (non-provisional) months per business. Click a month →
// month-detail page.
//
// Auth: enforced by lib/auth/permissions.ts (REVISOR_ALLOW_PATHS) +
// /api/revisor/data row-level permission check. This page itself is
// just a renderer.

import { useEffect, useState } from 'react'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Business {
  id:         string
  name:       string
  city:       string | null
  country:    string | null
  org_number: string | null
}
interface MonthRow {
  business_id:    string
  period_year:    number
  period_month:   number
  revenue:        number | null
  net_profit:     number | null
  margin_pct:     number | null
  source:         string | null
  created_via:    string | null
  updated_at:     string | null
}

const MONTH_NAMES_SV = [
  'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
]

export default function RevisorLanding() {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [months,     setMonths]     = useState<MonthRow[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')

  useEffect(() => {
    fetch('/api/revisor/data', { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => {
        setBusinesses(j.businesses ?? [])
        setMonths(j.months ?? [])
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: UX.pageBg }}>
      <Header />

      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 80px' }}>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: UX.ink1, margin: 0 }}>
            Månadsavslut · revisor-vy
          </h1>
          <p style={{ fontSize: 13, color: UX.ink3, marginTop: 4 }}>
            Skrivskyddad vy av månadsavstämningar för de verksamheter du har behörighet till.
            Klicka på en månad för fullständig P&amp;L, BAS-klassificerade transaktioner och
            kostnadsflaggor med drill-down till källfaktura.
          </p>
        </div>

        {loading && <Empty text="Laddar…" />}
        {error   && <Banner tone="bad" text={error} />}

        {!loading && !error && businesses.length === 0 && (
          <Empty text="Du har inte fått tillgång till någon verksamhet ännu. Be ägaren bjuda in dig som revisor på en specifik verksamhet." />
        )}

        {businesses.map(biz => {
          const bizMonths = months.filter(m => m.business_id === biz.id)
          return (
            <BusinessSection key={biz.id} biz={biz} months={bizMonths} />
          )
        })}
      </main>

      <Footer />
    </div>
  )
}

// ─── Sections ────────────────────────────────────────────────────────

function Header() {
  return (
    <header style={{
      background:    'white',
      borderBottom:  `1px solid ${UX.border}`,
      padding:       '12px 24px',
      display:       'flex',
      alignItems:    'center',
      justifyContent: 'space-between',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: UX.ink1 }}>CommandCenter</span>
        <span style={{
          fontSize:      9,
          fontWeight:    700,
          letterSpacing: '0.07em',
          padding:       '2px 6px',
          borderRadius:  3,
          background:    '#eef2ff',
          color:         '#4338ca',
        }}>
          REVISOR
        </span>
      </div>
      <a
        href="/login?logout=1"
        style={{
          fontSize: 12, color: UX.ink3, textDecoration: 'none',
        }}
      >
        Logga ut
      </a>
    </header>
  )
}

function BusinessSection({ biz, months }: { biz: Business; months: MonthRow[] }) {
  return (
    <section style={{
      background:   'white',
      border:       `1px solid ${UX.border}`,
      borderRadius: 10,
      padding:      '16px 18px',
      marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: UX.ink1 }}>
            {biz.name}
          </div>
          <div style={{ fontSize: 11, color: UX.ink4, marginTop: 2 }}>
            {biz.org_number ? `Org.nr ${formatOrgNr(biz.org_number)}` : 'Org.nr saknas — be ägaren komplettera'}
            {biz.city && <span> · {biz.city}</span>}
          </div>
        </div>
      </div>

      {months.length === 0 ? (
        <Empty text="Inga avslutade månader att visa ännu." />
      ) : (
        <div style={{
          display:    'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap:        8,
        }}>
          {months.map(m => (
            <MonthCard key={`${m.period_year}-${m.period_month}`} biz={biz} m={m} />
          ))}
        </div>
      )}
    </section>
  )
}

function MonthCard({ biz, m }: { biz: Business; m: MonthRow }) {
  const href = `/revisor/${biz.id}/${m.period_year}/${m.period_month}`
  const margin = m.margin_pct != null ? Number(m.margin_pct) : null
  const marginColour = margin == null ? UX.ink3
    : margin >= 10 ? UX.greenInk
    : margin >=  5 ? UX.amberInk
    : '#b91c1c'
  return (
    <a
      href={href}
      style={{
        display:        'block',
        padding:        '10px 12px',
        background:     UX.pageBg,
        border:         `1px solid ${UX.border}`,
        borderRadius:   8,
        textDecoration: 'none',
        color:          'inherit',
      }}
    >
      <div style={{ fontSize: 11, color: UX.ink3, fontWeight: 500 }}>
        {MONTH_NAMES_SV[m.period_month - 1]} {m.period_year}
      </div>
      <div style={{ fontSize: 14, fontWeight: 500, color: UX.ink1, marginTop: 4 }}>
        {fmtKr(m.revenue ?? 0)}
      </div>
      <div style={{ fontSize: 11, color: marginColour, marginTop: 2 }}>
        Marginal {margin != null ? margin.toFixed(1) + '%' : '—'}
      </div>
      <div style={{ fontSize: 10, color: UX.ink4, marginTop: 4 }}>
        Källa: {m.source ?? '—'}
      </div>
    </a>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' },
    warn: { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
    bad:  { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
    }}>
      {text}
    </div>
  )
}
function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: 36, textAlign: 'center' as const, color: UX.ink4, fontSize: 12 }}>
      {text}
    </div>
  )
}
function Footer() {
  return (
    <footer style={{
      maxWidth:   1100,
      margin:     '0 auto',
      padding:    '20px 24px 40px',
      fontSize:   10,
      color:      UX.ink4,
      borderTop:  `1px solid ${UX.border}`,
    }}>
      Genererad av CommandCenter ·{' '}
      <a href="/security" style={{ color: UX.ink3, textDecoration: 'underline' }}>säkerhet &amp; data</a>
    </footer>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatOrgNr(s: string): string {
  // 5560000000 → 556000-0000
  const clean = s.replace(/\D/g, '')
  if (clean.length !== 10) return s
  return `${clean.slice(0, 6)}-${clean.slice(6)}`
}
