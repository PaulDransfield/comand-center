'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'
import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import { deptColor, deptBg, KPI_CARD, CARD, BTN, CC_DARK, CC_PURPLE, CC_GREEN, CC_RED } from '@/lib/constants/colors'

interface Business { id: string; name: string }
interface BudgetRow {
  month: number
  budget: { revenue_target: number; food_cost_pct_target: number; staff_cost_pct_target: number; net_profit_target: number } | null
  actual: { revenue: number; food_cost: number; staff_cost: number; net_profit: number; food_pct: number; staff_pct: number } | null
}
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number) => n.toFixed(1) + '%'

export default function BudgetPage() {
  const now = new Date()
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [selected, setSelected]     = useState('')
  const [year, setYear]             = useState(now.getFullYear())
  const [rows, setRows]             = useState<BudgetRow[]>([])
  const [loading, setLoading]       = useState(true)
  const [editing, setEditing]       = useState<number|null>(null)
  const [form, setForm]             = useState<any>({})
  const [saving, setSaving]         = useState(false)
  // AI generation state
  const [generating, setGenerating] = useState(false)
  const [genError,   setGenError]   = useState('')
  const [suggestions, setSuggestions] = useState<any>(null)  // { overall_strategy, monthly }
  const [applying,   setApplying]   = useState(false)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const sync = () => {
        const saved = localStorage.getItem('cc_selected_biz')
        const id = (saved && data.find((b: any) => b.id === saved)) ? saved : data[0].id
        setSelected(id)
      }
      sync()
      window.addEventListener('storage', sync)
    }).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!selected) return
    setLoading(true)
    const res = await fetch(`/api/budgets?business_id=${selected}&year=${year}`)
    const d   = await res.json()
    // API returns { year, months } — months is the array we render
    const months = Array.isArray(d) ? d : (Array.isArray(d?.months) ? d.months : [])
    setRows(months)
    setLoading(false)
  }, [selected, year])

  useEffect(() => { if (selected) load() }, [selected])

  async function save(month: number) {
    setSaving(true)
    await fetch('/api/budgets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, business_id: selected, year, month }),
    })
    setSaving(false); setEditing(null); load()
  }

  async function generateWithAI() {
    if (!selected) return
    setGenerating(true); setGenError(''); setSuggestions(null)
    try {
      const res = await fetch('/api/budgets/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: selected, year }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Generation failed')
      setSuggestions(data)
    } catch (e: any) { setGenError(e.message) }
    setGenerating(false)
  }

  async function applyAllSuggestions() {
    if (!suggestions?.monthly) return
    setApplying(true)
    try {
      // Upsert each month in parallel
      await Promise.all(suggestions.monthly.map((s: any) =>
        fetch('/api/budgets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id:            selected,
            year,
            month:                  s.month,
            revenue_target:         s.revenue_target,
            food_cost_pct_target:   s.food_cost_pct_target,
            staff_cost_pct_target:  s.staff_cost_pct_target,
            net_profit_target:      s.net_profit_target,
          }),
        })
      ))
      setSuggestions(null)
      load()
    } catch (e: any) {
      setGenError('Failed to apply: ' + e.message)
    }
    setApplying(false)
  }

  const withActual = rows.filter(r => r.actual && r.actual.revenue > 0)
  const totalRev   = withActual.reduce((s, r) => s + (r.actual?.revenue ?? 0), 0)
  const totalBudg  = withActual.reduce((s, r) => s + (r.budget?.revenue_target ?? 0), 0)
  const onTrack    = withActual.filter(r => r.actual && r.budget && r.actual.revenue >= r.budget.revenue_target).length

  return (
    <AppShell>
      <div className="page-wrap" style={{ maxWidth: 1000 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div><h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Budget vs Actual</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Full year comparison · {year}</p></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
            <button
              onClick={generateWithAI}
              disabled={generating || !selected}
              style={{
                padding: '8px 14px',
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: generating || !selected ? 'not-allowed' : 'pointer',
                opacity: generating || !selected ? 0.6 : 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
              title="Let AI suggest budgets based on your last year + forecasts"
            >
              <span>✦</span>
              {generating ? 'Generating…' : 'Generate with AI'}
            </button>
            <select value={selected} onChange={e => setSelected(e.target.value)} style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {/* Generation error banner */}
        {genError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#dc2626', marginBottom: 16 }}>
            {genError}
            <button onClick={() => setGenError('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontWeight: 700 }}>×</button>
          </div>
        )}

        {/* AI suggestions review modal */}
        {suggestions && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* Modal header */}
              <div style={{ padding: '18px 24px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>AI-generated budgets for {year}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Review, then apply all — or close to discard</div>
                </div>
                <button onClick={() => setSuggestions(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#9ca3af', lineHeight: 1 }}>×</button>
              </div>

              {/* Strategy */}
              {suggestions.overall_strategy && (
                <div style={{ padding: '14px 24px', background: '#fafbff', borderBottom: '1px solid #f3f4f6', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
                  <span style={{ fontWeight: 700, color: '#6366f1' }}>Strategy: </span>
                  {suggestions.overall_strategy}
                </div>
              )}

              {/* Monthly suggestions list */}
              <div style={{ overflowY: 'auto', flex: 1, padding: '10px 24px 16px' }}>
                {suggestions.monthly.map((s: any) => (
                  <div key={s.month} style={{ padding: '12px 0', borderBottom: '1px solid #f3f4f6' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, color: '#111', fontSize: 14 }}>{MONTHS[s.month - 1]}</span>
                      <span style={{ fontSize: 13, color: '#6366f1', fontWeight: 600 }}>{fmtKr(s.revenue_target)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                      Food {s.food_cost_pct_target}% · Staff {s.staff_cost_pct_target}% · Profit target {fmtKr(s.net_profit_target)}
                    </div>
                    {s.reasoning && (
                      <div style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>{s.reasoning}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Modal footer */}
              <div style={{ padding: '14px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  onClick={() => setSuggestions(null)}
                  disabled={applying}
                  style={{ padding: '9px 18px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >
                  Discard
                </button>
                <button
                  onClick={applyAllSuggestions}
                  disabled={applying}
                  style={{ padding: '9px 18px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: applying ? 'not-allowed' : 'pointer', opacity: applying ? 0.6 : 1 }}
                >
                  {applying ? 'Applying…' : 'Apply all 12 months →'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Revenue vs budget', value: totalBudg > 0 ? ((totalRev/totalBudg-1)*100).toFixed(1)+'%' : '--', ok: totalRev >= totalBudg, sub: 'YTD' },
            { label: 'Months on track',   value: `${onTrack} / ${withActual.length}`, ok: onTrack >= withActual.length/2, sub: 'Revenue target met' },
            { label: 'Actual revenue',    value: fmtKr(totalRev), ok: true, sub: `${withActual.length} months of data` },
          ].map(k => (
            <div key={k.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{k.label}</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: k.ok ? '#15803d' : '#dc2626' }}>{k.value}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{k.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <div className="table-scroll"><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 600 }}>
            <thead>
              <tr style={{ background: '#fafafa', borderBottom: '1px solid #e5e7eb' }}>
                {['Month','Budget','Actual','Variance','Food cost','Staff cost','Status',''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</td></tr>
              ) : rows.map((row, i) => {
                const a = row.actual; const b = row.budget
                const hasActual = a && a.revenue > 0
                const variance  = hasActual && b ? a.revenue - b.revenue_target : null
                const onTrack   = variance !== null ? variance >= 0 : null
                const isEdit    = editing === row.month

                if (isEdit) return (
                  <tr key={i} style={{ background: 'white', borderBottom: '0.5px solid #e5e7eb' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{MONTHS[row.month-1].slice(0,3)}</td>
                    {[
                      { key: 'revenue_target',        label: 'Revenue target', placeholder: '300000' },
                      { key: 'food_cost_pct_target',  label: 'Food cost %',    placeholder: '31' },
                      { key: 'staff_cost_pct_target', label: 'Staff cost %',   placeholder: '40' },
                      { key: 'net_profit_target',     label: 'Profit target',  placeholder: '45000' },
                    ].map(f => (
                      <td key={f.key} style={{ padding: '6px 6px' }}>
                        <input type="number" placeholder={f.placeholder} value={form[f.key] ?? ''}
                          onChange={e => setForm((prev: any) => ({ ...prev, [f.key]: parseFloat(e.target.value) || 0 }))}
                          style={{ width: '100%', padding: '6px 8px', border: '1px solid #6366f1', borderRadius: 6, fontSize: 12 }} />
                      </td>
                    ))}
                    <td colSpan={3} />
                    <td style={{ padding: '6px 8px' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => save(row.month)} disabled={saving}
                          style={{ padding: '5px 10px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                          {saving ? '...' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(null)}
                          style={{ padding: '5px 8px', background: '#f3f4f6', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>X</button>
                      </div>
                    </td>
                  </tr>
                )

                return (
                  <tr key={i} style={{ borderBottom: '0.5px solid #f3f4f6', opacity: hasActual ? 1 : 0.6 }}>
                    <td style={{ padding: '11px 12px', fontWeight: 600, color: '#111' }}>{MONTHS[row.month-1].slice(0,3)}</td>
                    <td style={{ padding: '11px 12px', color: '#6b7280' }}>{b ? fmtKr(b.revenue_target) : '--'}</td>
                    <td style={{ padding: '11px 12px', fontWeight: 600 }}>{hasActual ? fmtKr(a!.revenue) : '--'}</td>
                    <td style={{ padding: '11px 12px', fontWeight: 600, color: variance === null ? '#9ca3af' : variance >= 0 ? '#15803d' : '#dc2626' }}>
                      {variance !== null ? (variance >= 0 ? '+' : '') + fmtKr(variance) : '--'}
                    </td>
                    <td style={{ padding: '11px 12px', color: a && b && a.food_pct <= b.food_cost_pct_target ? '#15803d' : '#dc2626' }}>
                      {hasActual ? `${fmtPct(a!.food_pct)} / ${b ? fmtPct(b.food_cost_pct_target) : '--'}` : '--'}
                    </td>
                    <td style={{ padding: '11px 12px', color: a && b && a.staff_pct <= b.staff_cost_pct_target ? '#15803d' : '#dc2626' }}>
                      {hasActual ? `${fmtPct(a!.staff_pct)} / ${b ? fmtPct(b.staff_cost_pct_target) : '--'}` : '--'}
                    </td>
                    <td style={{ padding: '11px 12px' }}>
                      {onTrack !== null && <span style={{ background: onTrack ? '#f0fdf4' : '#fef2f2', color: onTrack ? '#15803d' : '#dc2626', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                        {onTrack ? 'On track' : 'Off track'}
                      </span>}
                    </td>
                    <td style={{ padding: '11px 12px' }}>
                      <button onClick={() => { setEditing(row.month); setForm(b ?? {}) }}
                        style={{ padding: '4px 10px', background: '#f3f4f6', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer', color: '#374151' }}>
                        {b ? 'Edit' : 'Set budget'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        </div>
      </div>
    </AppShell>
  )
}