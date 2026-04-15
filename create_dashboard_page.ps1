$content = @'
'use client'

import { useEffect, useState } from 'react'

interface Business {
  id: string
  name: string
  type: string | null
  city: string | null
  revenue: number
  net_profit: number
  margin: number
  staffPct: number
  foodPct: number
  rentPct: number
  target_margin_pct: number
  target_staff_pct: number
  target_food_pct: number
  colour: string
}

const COLOURS = ['#2D5A27','#1A3F6B','#7A3B1E','#4A237A','#1A5F5F','#6B4C1A']

export default function DashboardPage() {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [selected,   setSelected]   = useState<Business | null>(null)
  const [showAdd,    setShowAdd]    = useState(false)

  // Add business form
  const [newName,    setNewName]    = useState('')
  const [newType,    setNewType]    = useState('Restaurant')
  const [newCity,    setNewCity]    = useState('')
  const [newOrg,     setNewOrg]     = useState('')
  const [saving,     setSaving]     = useState(false)
  const [saveError,  setSaveError]  = useState('')

  useEffect(() => { loadBusinesses() }, [])

  async function loadBusinesses() {
    setLoading(true)
    const res  = await fetch('/api/businesses')
    const data = await res.json()
    if (Array.isArray(data)) {
      setBusinesses(data)
      if (data.length > 0 && !selected) setSelected(data[0])
    } else {
      setError(data.error ?? 'Failed to load')
    }
    setLoading(false)
  }

  async function handleAddBusiness(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    setSaveError('')

    const res  = await fetch('/api/businesses/add', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name:       newName.trim(),
        type:       newType,
        city:       newCity.trim() || null,
        org_number: newOrg.trim()  || null,
        colour:     COLOURS[businesses.length % COLOURS.length],
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      setSaveError(data.error ?? 'Failed to save')
      setSaving(false)
      return
    }

    // Reset form and reload
    setNewName(''); setNewType('Restaurant'); setNewCity(''); setNewOrg('')
    setShowAdd(false)
    setSaving(false)
    await loadBusinesses()
  }

  const fmt    = (n: number) => Math.round(n).toLocaleString('en-SE') + ' kr'
  const fmtPct = (n: number) => n.toFixed(1) + '%'

  if (loading) return <div style={{ padding: 40, color: '#666' }}>Loading…</div>
  if (error)   return <div style={{ padding: 40, color: 'red' }}>Error: {error}</div>

  const biz = selected ?? businesses[0]

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>

      {/* Business selector + Add button */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {businesses.map((b, i) => (
          <button key={b.id}
            onClick={() => setSelected(b)}
            style={{
              padding: '6px 14px', borderRadius: 8, border: '1.5px solid',
              borderColor: selected?.id === b.id ? (b.colour || COLOURS[i % COLOURS.length]) : '#ddd',
              background:  selected?.id === b.id ? (b.colour || COLOURS[i % COLOURS.length]) : 'white',
              color:       selected?.id === b.id ? 'white' : '#333',
              cursor: 'pointer', fontWeight: 500, fontSize: 13,
            }}>
            {b.name}
          </button>
        ))}
        <button
          onClick={() => setShowAdd(true)}
          style={{ padding: '6px 14px', borderRadius: 8, border: '1.5px dashed #bbb', background: 'white', color: '#666', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
          + Add location
        </button>
      </div>

      {/* Add business modal */}
      {showAdd && (
        <>
          <div
            onClick={() => setShowAdd(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100 }}
          />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'white', borderRadius: 14, padding: 28, width: 440, maxWidth: '94vw', zIndex: 101, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 20, fontStyle: 'italic', color: '#1E2761', marginBottom: 6 }}>Add a location</h2>
            <p style={{ fontSize: 13, color: '#999', marginBottom: 20 }}>Each restaurant, bar, or café is a separate location.</p>

            {saveError && <div style={{ background: '#fef0f0', border: '1px solid #f5c0c0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#c00', marginBottom: 14 }}>{saveError}</div>}

            <form onSubmit={handleAddBusiness}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#999', marginBottom: 5 }}>Name *</label>
                <input
                  style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                  type="text" placeholder="Bella Italia" required
                  value={newName} onChange={e => setNewName(e.target.value)} autoFocus
                />
              </div>

              <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#999', marginBottom: 5 }}>Type</label>
                  <select
                    style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none', background: 'white' }}
                    value={newType} onChange={e => setNewType(e.target.value)}>
                    {['Restaurant','Bar','Café','Pub','Food truck','Catering','Other'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#999', marginBottom: 5 }}>City</label>
                  <input
                    style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                    type="text" placeholder="Stockholm"
                    value={newCity} onChange={e => setNewCity(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#999', marginBottom: 5 }}>Org number (optional)</label>
                <input
                  style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                  type="text" placeholder="559059-3025"
                  value={newOrg} onChange={e => setNewOrg(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowAdd(false)}
                  style={{ padding: '9px 18px', borderRadius: 8, border: '1.5px solid #ddd', background: 'white', cursor: 'pointer', fontSize: 13 }}>
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#1E2761', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  {saving ? 'Saving…' : 'Add location'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* Current business header */}
      {biz && (
        <>
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 26, fontStyle: 'italic', color: '#1E2761', margin: 0 }}>
              {biz.name}
            </h1>
            <p style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
              {biz.type ?? 'Restaurant'}{biz.city ? ` · ${biz.city}` : ''} · {new Date().toLocaleDateString('en-SE', { month: 'long', year: 'numeric' })}
            </p>
          </div>

          {/* KPI Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            {[
              { label: 'Revenue',    value: fmt(biz.revenue),     sub: 'This month',                    ok: true },
              { label: 'Net Profit', value: fmt(biz.net_profit),  sub: `${fmtPct(biz.margin)} margin`,  ok: biz.margin >= biz.target_margin_pct },
              { label: 'Staff Cost', value: fmtPct(biz.staffPct), sub: `Target ${fmtPct(biz.target_staff_pct)}`, ok: biz.staffPct <= biz.target_staff_pct },
              { label: 'Food Cost',  value: fmtPct(biz.foodPct),  sub: `Target ${fmtPct(biz.target_food_pct)}`,  ok: biz.foodPct  <= biz.target_food_pct  },
            ].map(kpi => (
              <div key={kpi.label} style={{ background: 'white', border: '1px solid #eee', borderRadius: 12, padding: '14px 16px', borderLeft: `3px solid ${kpi.ok ? '#2D6A35' : '#E85B5B'}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#999', marginBottom: 6 }}>{kpi.label}</div>
                <div style={{ fontFamily: 'Georgia,serif', fontSize: 26, fontWeight: 600, color: '#1C1714', lineHeight: 1 }}>{kpi.value}</div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 5 }}>{kpi.sub}</div>
              </div>
            ))}
          </div>

          {/* Quick links */}
          <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
            {[
              { label: 'Notebook',      href: '/notebook'      },
              { label: 'Tracker',       href: '/tracker'       },
              { label: 'Budget',        href: '/budget'        },
              { label: 'Invoices',      href: '/invoices'      },
              { label: 'Alerts',        href: '/alerts'        },
              { label: 'Food / Bev',    href: '/revenue-split' },
              { label: 'Covers',        href: '/covers'        },
              { label: 'VAT',           href: '/vat'           },
              { label: 'Integrations',  href: '/integrations'  },
              { label: 'Settings',      href: '/settings'      },
              { label: 'Upgrade',       href: '/upgrade'       },
            ].map(l => (
              <a key={l.href} href={l.href} style={{ padding: '8px 14px', background: 'white', border: '1px solid #eee', borderRadius: 9, fontSize: 12, fontWeight: 500, color: '#333', textDecoration: 'none' }}>
                {l.label}
              </a>
            ))}
          </div>
        </>
      )}

    </div>
  )
}

'@
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) "app\dashboard\page.tsx"),
  $content,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Done"
