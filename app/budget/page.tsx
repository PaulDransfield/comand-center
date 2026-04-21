'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'
import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AiLimitReached from '@/components/AiLimitReached'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import StatusPill from '@/components/ui/StatusPill'
import { UX } from '@/lib/constants/tokens'
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

function QuickStat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  const valueColour = tone === 'bad' ? '#fca5a5' : tone === 'ok' ? '#86efac' : 'white'
  return (
    <div>
      <div style={{ fontSize: 10, color: 'rgba(199,210,254,0.65)', letterSpacing: '.05em', textTransform: 'uppercase' as const, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: valueColour, marginTop: 1 }}>{value}</div>
    </div>
  )
}

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
  // Per-month analyse state
  const [analysingMonth, setAnalysingMonth] = useState<number|null>(null)  // month being analysed (loading spinner)
  const [analysis, setAnalysis] = useState<any>(null)                       // { month, result }
  // Shared AI limit-reached flag (either Generate or Analyse triggered a 429 with upgrade:true)
  const [aiLimitHit, setAiLimitHit] = useState<{limit:number,used:number,plan:string}|null>(null)
  // AI Budget Coach — current-month pacing + prescription
  const [coach,        setCoach]        = useState<any>(null)
  const [coachLoading, setCoachLoading] = useState(false)

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

  // Fetch the AI Budget Coach pacing narrative for the current month as soon
  // as a business is picked. Cheap — one Haiku call, ~200 tokens.
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setCoachLoading(true); setCoach(null)
    fetch(`/api/budgets/coach?business_id=${selected}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled && j && !j.error) setCoach(j) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCoachLoading(false) })
    return () => { cancelled = true }
  }, [selected])

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
    setGenerating(true); setGenError(''); setSuggestions(null); setAiLimitHit(null)
    try {
      const res = await fetch('/api/budgets/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: selected, year }),
      })
      const data = await res.json()
      if (res.status === 429 && data.upgrade) {
        setAiLimitHit({ limit: data.limit, used: data.used, plan: data.plan })
        return
      }
      if (!res.ok) throw new Error(data.error ?? 'Generation failed')
      setSuggestions(data)
      // Tell the sidebar meter to refresh — AI counter just moved server-side.
      try { window.dispatchEvent(new Event('cc_ai_used')) } catch {}
    } catch (e: any) { setGenError(e.message) }
    setGenerating(false)
  }

  async function analyseMonth(month: number) {
    if (!selected) return
    setAnalysingMonth(month); setAnalysis(null); setAiLimitHit(null)
    try {
      const res = await fetch('/api/budgets/analyse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: selected, year, month }),
      })
      const data = await res.json()
      if (res.status === 429 && data.upgrade) {
        setAiLimitHit({ limit: data.limit, used: data.used, plan: data.plan })
        setAnalysingMonth(null)
        return
      }
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed')
      setAnalysis({ month, result: data })
      try { window.dispatchEvent(new Event('cc_ai_used')) } catch {}
    } catch (e: any) {
      setAnalysis({ month, result: { verdict: 'error', headline: e.message, analysis: [], recommendations: [] } })
    }
    setAnalysingMonth(null)
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

  // ── Derived status tallies + outlier for hero ──────────────────────────
  const now2 = new Date()
  const monthsInYearSoFar = year === now2.getFullYear() ? now2.getMonth() + 1
                          : year < now2.getFullYear() ? 12
                          : 0
  const withActual = rows.filter(r => r.actual && r.actual.revenue > 0)
  const totalRev   = withActual.reduce((s, r) => s + (r.actual?.revenue ?? 0), 0)
  const totalBudg  = withActual.reduce((s, r) => s + (r.budget?.revenue_target ?? 0), 0)
  const onTrack    = withActual.filter(r => r.actual && r.budget && r.actual.revenue >= r.budget.revenue_target).length
  const offTrack   = withActual.filter(r => r.actual && r.budget && r.actual.revenue < r.budget.revenue_target).length
  const notStarted = rows.filter(r => !r.budget && (!r.actual || r.actual.revenue === 0)).length

  // Biggest miss = month with largest negative variance on rev_target
  let biggestMiss: { month: number; kr: number } | null = null
  for (const r of withActual) {
    if (!r.budget) continue
    const miss = (r.actual?.revenue ?? 0) - r.budget.revenue_target
    if (miss < 0 && (biggestMiss == null || miss < biggestMiss.kr)) {
      biggestMiss = { month: r.month, kr: miss }
    }
  }

  const headline = (() => {
    if (withActual.length === 0) return <>No actuals logged yet for <span style={{ fontWeight: UX.fwMedium }}>{year}</span>.</>
    if (biggestMiss) {
      return (
        <>
          <span style={{ color: onTrack > offTrack ? UX.greenInk : UX.redInk, fontWeight: UX.fwMedium }}>
            {onTrack} of {withActual.length} months on track
          </span>
          {' '}— <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{MONTHS[biggestMiss.month - 1]} missed by {fmtKr(Math.abs(biggestMiss.kr))}</span>.
        </>
      )
    }
    return (
      <>
        <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>All {withActual.length} logged month{withActual.length === 1 ? '' : 's'} on track.</span>
      </>
    )
  })()

  const heroContext = totalBudg > 0
    ? `${Math.round((totalRev / totalBudg) * 100)}% of YTD revenue target delivered · ${withActual.length} of ${monthsInYearSoFar} months logged`
    : undefined

  return (
    <AppShell>
      <div style={{ maxWidth: 1000 }}>

        {/* Local selectors + "Generate with AI" action — small row above the hero */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8, flexWrap: 'wrap' as const }}>
          <button
            onClick={generateWithAI}
            disabled={generating || !selected}
            style={{
              padding: '6px 12px', background: UX.indigo, color: 'white',
              border: 'none', borderRadius: UX.r_md, fontSize: UX.fsBody, fontWeight: UX.fwMedium,
              cursor: generating || !selected ? 'not-allowed' : 'pointer',
              opacity: generating || !selected ? 0.6 : 1,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
            title="Let AI suggest budgets from your last year + forecasts"
          >
            <span>✦</span>
            {generating ? 'Generating…' : 'Generate with AI'}
          </button>
          <select value={selected} onChange={e => setSelected(e.target.value)}
            style={{ padding: '6px 10px', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, fontSize: UX.fsBody, background: UX.cardBg, color: UX.ink1 }}>
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            style={{ padding: '6px 10px', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, fontSize: UX.fsBody, background: UX.cardBg, color: UX.ink1 }}>
            {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* PageHero — replaces the big header + KPI row */}
        <PageHero
          eyebrow={`${year} BUDGET`}
          headline={headline}
          context={heroContext}
          right={
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <TallyDot tone="good"    count={onTrack}    label="On track" />
              <TallyDot tone="bad"     count={offTrack}   label="Off track" />
              <TallyDot tone="neutral" count={notStarted} label="Not started" />
            </div>
          }
        />

        {/* ───────────────────────────────────────────────────────────
            AI Budget Coach — current-month pacing + one prescription.
            Answers "am I on track + what do I do next week?". Always at
            the top so the page leads with action, not with a table.
        ─────────────────────────────────────────────────────────── */}
        {(coachLoading || coach?.narrative || coach?.has_budget === false) && (
          <div style={{ background: 'linear-gradient(135deg, #1e1b4b, #312e81)', borderRadius: 14, padding: '22px 26px', marginBottom: 16, color: 'white' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ width: 26, height: 26, background: 'rgba(99,102,241,0.35)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>✦</div>
              <span style={{ fontSize: 10, background: 'rgba(99,102,241,0.35)', color: 'white', padding: '2px 8px', borderRadius: 4, fontWeight: 700, letterSpacing: '.05em' }}>AI BUDGET COACH</span>
            </div>
            {coachLoading ? (
              <div style={{ fontSize: 14, color: 'rgba(199,210,254,0.85)', fontStyle: 'italic' as const }}>Checking this month's pace…</div>
            ) : coach?.has_budget === false ? (
              <div style={{ fontSize: 14, color: 'rgba(199,210,254,0.9)', lineHeight: 1.6 }}>
                {coach.hint || 'Set a budget for this month to see pacing and AI advice.'}
              </div>
            ) : coach?.narrative ? (
              <>
                <div style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.65, fontFamily: 'Georgia, serif', whiteSpace: 'pre-wrap' as const }}>
                  {coach.narrative}
                </div>
                {/* Quick-stat row + scheduling jump when labour is the lever */}
                <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap' as const, gap: 16, alignItems: 'center' }}>
                  <QuickStat label="Revenue MTD"    value={fmtKr(coach.mtd.revenue)} />
                  <QuickStat label="Projected"      value={fmtKr(coach.projected.revenue)} />
                  <QuickStat label="Labour %"       value={fmtPct(coach.projected.labour_pct)} tone={coach.labour_is_the_lever ? 'bad' : 'ok'} />
                  {coach.labour_is_the_lever && (
                    <a href="/scheduling" style={{ marginLeft: 'auto', padding: '8px 16px', background: '#6366f1', color: 'white', borderRadius: 8, fontSize: 12, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' as const }}>
                      Open scheduling → trim next week
                    </a>
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* AI daily limit hit — reuse the AskAI upsell card */}
        {aiLimitHit && (
          <div style={{ marginBottom: 16 }}>
            <AiLimitReached used={aiLimitHit.used} limit={aiLimitHit.limit} plan={aiLimitHit.plan} />
          </div>
        )}

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

        {/* ─── 12-row progress-bar list ─────────────────────────────────── */}
        <div style={{
          background:   UX.cardBg,
          border:       `0.5px solid ${UX.border}`,
          borderRadius: UX.r_lg,
          overflow:     'hidden' as const,
        }}>
          <div style={{
            padding:      '10px 16px',
            background:   UX.subtleBg,
            borderBottom: `0.5px solid ${UX.borderSoft}`,
            display:      'grid',
            gridTemplateColumns: '60px 1fr 90px 90px 90px',
            gap:          12,
            fontSize:     UX.fsMicro,
            fontWeight:   UX.fwMedium,
            color:        UX.ink4,
            letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
          }}>
            <span>Month</span>
            <span>Progress vs budget</span>
            <span style={{ textAlign: 'right' as const }}>Variance</span>
            <span style={{ textAlign: 'right' as const }}>Status</span>
            <span style={{ textAlign: 'right' as const }}></span>
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading…</div>
          ) : (
            rows.map((row, i) => {
              const a = row.actual
              const b = row.budget
              const hasActual = a && a.revenue > 0
              const variance  = hasActual && b ? a.revenue - b.revenue_target : null
              const onTrackFlag = variance !== null ? variance >= 0 : null
              const isEdit    = editing === row.month

              // Progress bar math — actual fill scaled against target, capped at 140% for visibility.
              const pct = b && b.revenue_target > 0 && hasActual
                ? Math.max(0, Math.min(140, (a!.revenue / b.revenue_target) * 100))
                : 0
              const barColour = pct >= 100 ? UX.greenInk : pct >= 85 ? UX.amberInk : pct > 0 ? UX.redInk : UX.ink5
              const statusLabel: string =
                !b                           ? 'NOT SET'
                : !hasActual                 ? 'NO ACTUALS'
                : onTrackFlag                ? 'ON TRACK'
                :                              'OFF TRACK'
              const statusTone: 'good' | 'warning' | 'bad' | 'neutral' =
                statusLabel === 'ON TRACK'   ? 'good'
                : statusLabel === 'OFF TRACK' ? 'bad'
                :                               'neutral'

              return (
                <div key={row.month}>
                  {isEdit ? (
                    <div style={{
                      display:             'grid',
                      gridTemplateColumns: '60px 1fr 90px 90px 90px',
                      gap:                 12,
                      padding:             '10px 16px',
                      alignItems:          'center',
                      borderBottom:        `0.5px solid ${UX.borderSoft}`,
                      background:          UX.cardBg,
                    }}>
                      <span style={{ fontWeight: UX.fwMedium, color: UX.ink1, fontSize: UX.fsBody }}>{MONTHS[row.month - 1].slice(0, 3)}</span>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
                        {[
                          { key: 'revenue_target',        placeholder: 'rev' },
                          { key: 'food_cost_pct_target',  placeholder: 'food %' },
                          { key: 'staff_cost_pct_target', placeholder: 'staff %' },
                          { key: 'net_profit_target',     placeholder: 'profit' },
                        ].map(f => (
                          <input
                            key={f.key}
                            type="number" placeholder={f.placeholder}
                            value={(form as any)[f.key] ?? ''}
                            onChange={e => setForm((prev: any) => ({ ...prev, [f.key]: parseFloat(e.target.value) || 0 }))}
                            style={{ padding: '5px 8px', border: `1px solid ${UX.indigo}`, borderRadius: UX.r_sm, fontSize: UX.fsMicro }}
                          />
                        ))}
                      </div>
                      <span />
                      <span />
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button onClick={() => save(row.month)} disabled={saving}
                          style={{ padding: '4px 10px', background: UX.navy, color: 'white', border: 'none', borderRadius: UX.r_sm, fontSize: UX.fsMicro, cursor: 'pointer', fontWeight: UX.fwMedium }}>
                          {saving ? '…' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(null)}
                          style={{ padding: '4px 8px', background: UX.borderSoft, border: 'none', borderRadius: UX.r_sm, fontSize: UX.fsMicro, cursor: 'pointer', color: UX.ink2 }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{
                      display:             'grid',
                      gridTemplateColumns: '60px 1fr 90px 90px 90px',
                      gap:                 12,
                      padding:             '11px 16px',
                      alignItems:          'center',
                      borderBottom:        i === rows.length - 1 ? 'none' : `0.5px solid ${UX.borderSoft}`,
                      opacity:             !b && !hasActual ? 0.6 : 1,
                    }}>
                      <span style={{ fontWeight: UX.fwMedium, color: UX.ink1, fontSize: UX.fsBody }}>{MONTHS[row.month - 1].slice(0, 3)}</span>

                      {/* Progress bar with tick at 100% budget */}
                      <div style={{ position: 'relative' as const, height: 20, display: 'flex', alignItems: 'center' }}>
                        <div style={{ position: 'absolute' as const, inset: 0, top: 7, bottom: 7, background: UX.borderSoft, borderRadius: 2 }}>
                          {hasActual && b && b.revenue_target > 0 && (
                            <div style={{
                              position:   'absolute' as const,
                              left:       0,
                              top:        0,
                              bottom:     0,
                              // Compress overflow past 100% visually — show full width when ≥100%
                              width:      `${Math.min(100, pct)}%`,
                              background: barColour,
                              borderRadius: 2,
                              opacity:    0.9,
                            }} />
                          )}
                          {b && (
                            <div
                              title={`Target: ${fmtKr(b.revenue_target)}`}
                              style={{
                                position:   'absolute' as const,
                                left:       'calc(100% - 1px)',
                                top:        -2,
                                bottom:     -2,
                                width:      2,
                                background: UX.ink2,
                              }}
                            />
                          )}
                        </div>
                        <div style={{ position: 'relative' as const, width: '100%', display: 'flex', justifyContent: 'space-between', fontSize: 9, color: UX.ink4, fontVariantNumeric: 'tabular-nums' as const }}>
                          <span style={{ background: UX.cardBg, padding: '0 4px' }}>
                            {hasActual ? `act ${fmtKr(a!.revenue)}` : b ? `no actuals yet` : 'budget not set'}
                          </span>
                          <span style={{ background: UX.cardBg, padding: '0 4px' }}>{b ? `bud ${fmtKr(b.revenue_target)}` : ''}</span>
                        </div>
                      </div>

                      <span style={{ textAlign: 'right' as const, fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: variance == null ? UX.ink5 : variance >= 0 ? UX.greenInk : UX.redInk, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const }}>
                        {variance != null ? (variance >= 0 ? '+' : '−') + fmtKr(Math.abs(variance)) : '—'}
                      </span>

                      <div style={{ textAlign: 'right' as const }}>
                        <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
                      </div>

                      <div style={{ textAlign: 'right' as const, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button onClick={() => { setEditing(row.month); setForm(b ?? {}) }}
                          style={{ padding: '3px 10px', background: 'transparent', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_sm, fontSize: UX.fsMicro, cursor: 'pointer', color: UX.ink3 }}>
                          {b ? 'Edit' : 'Set'}
                        </button>
                        {hasActual && (
                          <button
                            onClick={() => analyseMonth(row.month)}
                            disabled={analysingMonth === row.month}
                            style={{
                              padding: '3px 10px', background: UX.indigoBg, border: `0.5px solid ${UX.indigo}`, borderRadius: UX.r_sm, fontSize: UX.fsMicro,
                              cursor: analysingMonth === row.month ? 'wait' : 'pointer',
                              color: UX.indigo, fontWeight: UX.fwMedium, display: 'inline-flex', alignItems: 'center', gap: 3,
                            }}
                            title="AI review of this month vs budget / last year"
                          >
                            <span>✦</span>
                            {analysingMonth === row.month ? '…' : 'Analyse'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Per-month analysis modal */}
        {analysis && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* Header */}
              <div style={{
                padding: '18px 24px',
                background: analysis.result?.verdict === 'hit'    ? 'linear-gradient(135deg, #15803d 0%, #22c55e 100%)'
                           : analysis.result?.verdict === 'missed'? 'linear-gradient(135deg, #dc2626 0%, #f87171 100%)'
                           : analysis.result?.verdict === 'mixed' ? 'linear-gradient(135deg, #d97706 0%, #fbbf24 100%)'
                           : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: 'white',
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, opacity: 0.85, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{MONTHS[analysis.month - 1]} {year} · {analysis.result?.verdict?.toUpperCase() ?? 'ANALYSIS'}</span>
                    <span title="Generated by AI — review before acting" style={{ background: 'rgba(255,255,255,0.2)', padding: '1px 6px', borderRadius: 3, fontSize: 9 }}>✦ AI</span>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.4 }}>
                    {analysis.result?.headline ?? 'Analysis'}
                  </div>
                </div>
                <button onClick={() => setAnalysis(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: 'white', lineHeight: 1 }}>×</button>
              </div>

              {/* Body */}
              <div style={{ overflowY: 'auto', flex: 1, padding: '16px 24px' }}>

                {/* Per-metric analysis */}
                {analysis.result?.analysis?.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>
                      What happened
                    </div>
                    {analysis.result.analysis.map((a: any, idx: number) => {
                      const color = a.status === 'good' ? { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d' }
                                  : a.status === 'bad'  ? { bg: '#fef2f2', border: '#fecaca', text: '#dc2626' }
                                  :                        { bg: '#fffbeb', border: '#fef3c7', text: '#d97706' }
                      const label = a.metric === 'staff_cost' ? 'Staff cost'
                                  : a.metric === 'food_cost'  ? 'Food cost'
                                  : a.metric === 'net_profit' ? 'Net profit'
                                  : a.metric === 'margin'     ? 'Margin'
                                  : a.metric === 'revenue'    ? 'Revenue'
                                  : a.metric
                      return (
                        <div key={idx} style={{ background: color.bg, border: `1px solid ${color.border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', color: color.text, marginBottom: 3 }}>
                            {label}
                          </div>
                          <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{a.message}</div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Recommendations */}
                {analysis.result?.recommendations?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>
                      Recommendations
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
                      {analysis.result.recommendations.map((rec: string, idx: number) => (
                        <li key={idx} style={{ marginBottom: 6 }}>{rec}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {analysis.result?.verdict === 'no-data' && (
                  <div style={{ fontSize: 13, color: '#6b7280', padding: '10px 0' }}>
                    Nothing to analyse for this month yet.
                  </div>
                )}
              </div>

              {/* Footer */}
              <div style={{ padding: '12px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setAnalysis(null)}
                  style={{ padding: '8px 16px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  )
}

// Small dot + count + label tally used in the PageHero right slot.
function TallyDot({ tone, count, label }: { tone: 'good' | 'bad' | 'neutral'; count: number; label: string }) {
  const dot =
    tone === 'good' ? UX.greenInk :
    tone === 'bad'  ? UX.redInk   :
                      UX.ink4
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
      <span style={{ fontSize: 17, fontWeight: UX.fwMedium, color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{count}</span>
      <span style={{ fontSize: UX.fsMicro, color: UX.ink3 }}>{label}</span>
    </div>
  )
}