'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'
import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import AiLimitReached from '@/components/AiLimitReached'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import StatusPill from '@/components/ui/StatusPill'
import TopBar from '@/components/ui/TopBar'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
import { UX } from '@/lib/constants/tokens'
import { deptColor, deptBg, KPI_CARD, CARD, BTN, CC_DARK, CC_PURPLE, CC_GREEN, CC_RED } from '@/lib/constants/colors'
import { fmtKr, fmtPct } from '@/lib/format'

interface Business { id: string; name: string }
interface BudgetRow {
  month: number
  budget: { revenue_target: number; food_cost_pct_target: number; staff_cost_pct_target: number; net_profit_target: number } | null
  actual: { revenue: number; food_cost: number; staff_cost: number; net_profit: number; food_pct: number; staff_pct: number } | null
}
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

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
  const t   = useTranslations('financials.budget')
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
  // Owner feedback per month (too_high / too_low / just_right / wrong_shape).
  // Captured immediately on click; flows into ai_forecast_outcomes and feeds
  // the next AI generation's "PRIOR ACCURACY" block.
  const [feedbackByMonth, setFeedbackByMonth] = useState<Record<number, string>>({})
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
  // 4th bucket per BUDGET-FIX § 6 — months with real revenue but no budget
  // set. Previously these were mis-counted as "Not started" (wrong —
  // April HAD started) or silently dropped. Now they show up explicitly.
  const loggedNoBudget = withActual.filter(r => !r.budget).length
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
    if (withActual.length === 0) {
      return <>No actuals logged yet for <span style={{ fontWeight: UX.fwMedium }}>{year}</span>.</>
    }
    // Single logged month, no budget to compare against — awkward to
    // say "1 month on track", per BUDGET-FIX "One more thing". Natural
    // English: name the month and acknowledge no budget.
    if (withActual.length === 1 && loggedNoBudget === 1) {
      const m = withActual[0]
      return (
        <>
          {MONTHS[m.month - 1]} logged ({fmtKr(Number(m.actual?.revenue ?? 0))}) — <span style={{ color: UX.ink3 }}>no budget set yet</span>.
        </>
      )
    }
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
        <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>
          {withActual.length === 1
            ? `${MONTHS[withActual[0].month - 1]} on budget.`
            : `All ${withActual.length} logged months on track.`}
        </span>
      </>
    )
  })()

  const heroContext = totalBudg > 0
    ? `${Math.round((totalRev / totalBudg) * 100)}% of YTD revenue target delivered · ${withActual.length} of ${monthsInYearSoFar} months logged`
    : withActual.length
      ? `${withActual.length} of ${monthsInYearSoFar} months logged — budgets not set yet`
      : undefined

  // ── AI Budget Coach → AttentionPanel items  (no more purple gradient).
  //    Phase 4 collapses the banner into regular content: a short white
  //    AttentionPanel with up to 3 bullets (pacing verdict, labour lever,
  //    scheduling jump). Narrative prose that's too long to fit in a
  //    bullet falls back to a single bullet with the full line.
  const coachItems: AttentionItem[] = (() => {
    if (!coach || coach.has_budget === false || !coach.narrative) return []
    const out: AttentionItem[] = []
    // Overall pacing — tone from projected vs budget revenue.
    const onPace = coach.projected && coach.budget
      ? Number(coach.projected.revenue ?? 0) >= Number(coach.budget.revenue_target ?? 0)
      : null
    out.push({
      tone:    onPace == null ? 'warning' : onPace ? 'good' : 'bad',
      entity:  'Pacing',
      message: `MTD ${fmtKr(Number(coach.mtd?.revenue ?? 0))} → projected ${fmtKr(Number(coach.projected?.revenue ?? 0))}${coach.budget?.revenue_target ? ` vs ${fmtKr(Number(coach.budget.revenue_target))} target` : ''}.`,
    })
    // Labour lever, if flagged by the server.
    if (coach.labour_is_the_lever && coach.projected?.labour_pct != null) {
      out.push({
        tone:    'bad',
        entity:  'Labour',
        message: `projected at ${fmtPct(Number(coach.projected.labour_pct))} — open Scheduling and trim next week's hours.`,
      })
    }
    // Narrative first-sentence as the "do this next" bullet.
    const firstSentence = String(coach.narrative).split(/(?<=[.!?])\s+/).filter(Boolean)[0]
    if (firstSentence) {
      out.push({
        tone:    'warning',
        entity:  'Coach',
        message: firstSentence.slice(0, 180),
      })
    }
    return out.slice(0, 3)
  })()

  return (
    <AppShell>
      <div style={{ maxWidth: 1000 }}>

        {/* Row-hover reveal for the pencil action — same pattern as the
            P&L tracker.  Keeps the row visually clean; ✎ shows on hover
            or focus (FIX-PROMPT § Phase 4 "remove per-row buttons"). */}
        <style>{`
          .cc-bud-action { opacity: 0; transition: opacity .12s ease; }
          .cc-bud-row:hover .cc-bud-action,
          .cc-bud-row:focus-within .cc-bud-action { opacity: 1; }
        `}</style>

        {/* TopBar — breadcrumb + business/year selectors + top-level AI
            action. Replaces the floating "Generate with AI" row. */}
        <TopBar
          crumbs={[
            { label: t('crumb.financials') },
            { label: t('crumb.budget'), active: true },
          ]}
          rightSlot={
            <>
              <button
                onClick={generateWithAI}
                disabled={generating || !selected}
                title={t('ai.title')}
                style={{
                  padding: '5px 11px', background: UX.indigo, color: 'white',
                  border: 'none', borderRadius: UX.r_md, fontSize: UX.fsBody, fontWeight: UX.fwMedium,
                  cursor: generating || !selected ? 'not-allowed' : 'pointer',
                  opacity: generating || !selected ? 0.6 : 1,
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                }}
              >
                <span>✦</span>
                {generating ? t('ai.generating') : t('ai.generate')}
              </button>
              <select value={selected} onChange={e => setSelected(e.target.value)}
                style={{ padding: '5px 9px', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, fontSize: UX.fsBody, background: UX.cardBg, color: UX.ink1 }}>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select value={year} onChange={e => setYear(parseInt(e.target.value))}
                style={{ padding: '5px 9px', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, fontSize: UX.fsBody, background: UX.cardBg, color: UX.ink1 }}>
                {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </>
          }
        />

        {/* PageHero — replaces the big header + KPI row */}
        <PageHero
          eyebrow={t('eyebrowYearBudget', { year })}
          headline={headline}
          context={heroContext}
          right={
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' as const }}>
              <TallyDot tone="good"    count={onTrack}         label={t('tally.onTrack')} />
              <TallyDot tone="bad"     count={offTrack}        label={t('tally.offTrack')} />
              {loggedNoBudget > 0 && (
                <TallyDot tone="info"  count={loggedNoBudget}  label={t('tally.noBudget')} />
              )}
              <TallyDot tone="neutral" count={notStarted}      label={t('tally.notStarted')} />
            </div>
          }
        />

        {/* AI Budget Coach — only rendered when Claude has real, actionable
            output. Empty states (no budget set, still loading) show NOTHING
            here (BUDGET-FIX § 1). The hero / tally / NOT SET pills already
            carry the "you haven't set a budget yet" signal; a banner
            repeating it is noise. */}
        {coachItems.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <AttentionPanel
              title="AI Budget Coach"
              items={coachItems}
              rightSlot={coach?.labour_is_the_lever ? (
                <a href="/scheduling" style={{ fontSize: UX.fsLabel, color: UX.indigo, textDecoration: 'none', fontWeight: UX.fwMedium }}>
                  Open scheduling →
                </a>
              ) : undefined}
            />
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <FeedbackButtons
                          businessId={selected}
                          year={year}
                          month={s.month}
                          currentReaction={feedbackByMonth[s.month]}
                          onRecord={(reaction) => setFeedbackByMonth(prev => ({ ...prev, [s.month]: reaction }))}
                        />
                        <span style={{ fontSize: 13, color: '#6366f1', fontWeight: 600 }}>{fmtKr(s.revenue_target)}</span>
                      </div>
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
            <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>{t('loading')}</div>
          ) : (() => {
            // Year-max drives the horizontal scale so every month's bar is
            // honestly proportional to the biggest month on the page — whether
            // that max comes from a budget or an actual. BUDGET-FIX § 4 fixes
            // the earlier bug where rows with actuals-but-no-budget rendered
            // as empty tracks because yearMax only looked at budgets.
            const yearMax = Math.max(
              1,
              ...rows.map(r => Number(r.budget?.revenue_target ?? 0)),
              ...rows.map(r => Number(r.actual?.revenue         ?? 0)),
            )
            return rows.map((row, i) => {
              const a = row.actual
              const b = row.budget
              const hasActual = !!(a && a.revenue > 0)
              const variance  = hasActual && b ? a!.revenue - b.revenue_target : null
              const onTrackFlag = variance !== null ? variance >= 0 : null
              const isEdit    = editing === row.month

              // Bar geometry — both values as a % of the year max.
              const tickPct = b && b.revenue_target > 0
                ? (b.revenue_target / yearMax) * 100
                : null
              const fillPct = hasActual
                ? Math.min(120, (a!.revenue / yearMax) * 100)
                : null
              // Green when actual ≥ budget (or there's no budget to fail
              // against — actual is the only data we have). Red only when
              // the user has set a budget and actual came in under.
              const fillColour = !b                      ? UX.greenInk
                               : onTrackFlag === true    ? UX.greenInk
                               : onTrackFlag === false   ? UX.redInk
                               :                           UX.ink5
              const statusLabel: string =
                !b && !hasActual             ? 'NOT SET'
                : !b && hasActual            ? 'NO BUDGET'
                : !hasActual                 ? 'NO ACTUALS'
                : onTrackFlag                ? 'ON TRACK'
                :                              'OFF TRACK'
              const statusTone: 'good' | 'warning' | 'bad' | 'neutral' | 'info' =
                statusLabel === 'ON TRACK'   ? 'good'
                : statusLabel === 'OFF TRACK' ? 'bad'
                : statusLabel === 'NO BUDGET' ? 'info'
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
                    <div
                      className="cc-bud-row"
                      style={{
                        display:             'grid',
                        gridTemplateColumns: '60px 1fr 90px 90px 90px',
                        gap:                 12,
                        padding:             '11px 16px',
                        alignItems:          'center',
                        borderBottom:        i === rows.length - 1 ? 'none' : `0.5px solid ${UX.borderSoft}`,
                        opacity:             !b && !hasActual ? 0.6 : 1,
                      }}
                    >
                      <span style={{ fontWeight: UX.fwMedium, color: UX.ink1, fontSize: UX.fsBody }}>{MONTHS[row.month - 1].slice(0, 3)}</span>

                      {/* Progress bar per DESIGN.md § 4.  Rendered whenever
                          there's EITHER a budget or an actual, so an
                          actual-only month (April) now shows a full green
                          fill instead of the empty track that BUDGET-FIX § 4
                          called out. */}
                      {(b || hasActual) ? (
                        <div style={{ position: 'relative' as const, height: 26 }}>
                          {/* Grey track */}
                          <div style={{
                            position:     'absolute' as const,
                            left: 0, right: 0,
                            top: 10, height: 8,
                            background:   UX.borderSoft,
                            borderRadius: 3,
                          }}>
                            {fillPct != null && fillPct > 0 && (
                              <div style={{
                                position:     'absolute' as const,
                                left:         0,
                                top:          0,
                                bottom:       0,
                                width:        `${Math.max(1, fillPct)}%`,
                                background:   fillColour,
                                borderRadius: fillPct >= 99.5 ? 3 : '3px 0 0 3px',
                                opacity:      0.92,
                              }} />
                            )}
                            {tickPct != null && (
                              <div
                                title={`Target: ${fmtKr(b!.revenue_target)}`}
                                style={{
                                  position:     'absolute' as const,
                                  left:         `calc(${tickPct}% - 1px)`,
                                  top:          -3,
                                  bottom:       -3,
                                  width:        2,
                                  background:   UX.ink1,
                                  borderRadius: 1,
                                }}
                              />
                            )}
                          </div>

                          {/* Labels — "act" above the bar at the fill end,
                              "bud" below at the tick. If the two are within
                              10pp of each other they'd collide; drop the
                              label on the shorter one (BUDGET-FIX § 5). */}
                          {(() => {
                            const showAct = fillPct != null
                            const showBud = tickPct != null
                            const tooClose = showAct && showBud && Math.abs(fillPct! - tickPct!) < 10
                            const hideAct = tooClose && fillPct! < tickPct!
                            const hideBud = tooClose && tickPct! <= fillPct!
                            return (
                              <>
                                {showAct && !hideAct && (
                                  <span style={{
                                    position:     'absolute' as const,
                                    left:         `clamp(0%, calc(${Math.min(95, fillPct!)}% - 6px), calc(100% - 80px))`,
                                    top:          -2,
                                    fontSize:     9,
                                    color:        fillColour,
                                    fontWeight:   UX.fwMedium,
                                    fontVariantNumeric: 'tabular-nums' as const,
                                    whiteSpace:   'nowrap' as const,
                                  }}>
                                    act {fmtKr(a!.revenue)}
                                  </span>
                                )}
                                {showBud && !hideBud && (
                                  <span style={{
                                    position:     'absolute' as const,
                                    left:         `clamp(0%, calc(${tickPct!}% + 4px), calc(100% - 70px))`,
                                    bottom:       -2,
                                    fontSize:     9,
                                    color:        UX.ink3,
                                    fontVariantNumeric: 'tabular-nums' as const,
                                    whiteSpace:   'nowrap' as const,
                                  }}>
                                    bud {fmtKr(b!.revenue_target)}
                                  </span>
                                )}
                              </>
                            )
                          })()}
                        </div>
                      ) : (
                        <span style={{ fontSize: UX.fsMicro, color: UX.ink4, fontStyle: 'italic' as const }}>
                          budget not set
                        </span>
                      )}

                      <span style={{ textAlign: 'right' as const, fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: variance == null ? UX.ink5 : variance >= 0 ? UX.greenInk : UX.redInk, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const }}>
                        {variance != null ? (variance >= 0 ? '+' : '−') + fmtKr(Math.abs(variance)) : '—'}
                      </span>

                      <div style={{ textAlign: 'right' as const }}>
                        <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
                      </div>

                      {/* Hover-only pencil — single affordance.  No per-row
                          Set / +Analyse buttons cluttering the table. The
                          top-right "+ Generate with AI" handles bulk
                          setting.  A future iteration could bring the
                          per-month "Analyse" back as a right-click menu or
                          keyboard shortcut; it doesn't belong on every row.
                          FIX-PROMPT § Phase 4. */}
                      <div
                        className="cc-bud-action"
                        style={{ textAlign: 'right' as const }}
                        onClick={e => e.stopPropagation()}
                      >
                        <button
                          aria-label={b ? `Edit ${MONTHS[row.month - 1]} budget` : `Set ${MONTHS[row.month - 1]} budget`}
                          onClick={() => { setEditing(row.month); setForm(b ?? {}) }}
                          style={{
                            padding:      '3px 8px',
                            background:   'transparent',
                            border:       'none',
                            borderRadius: UX.r_sm,
                            fontSize:     13,
                            cursor:       'pointer',
                            color:        UX.ink4,
                            lineHeight:   1,
                          }}
                        >
                          ✎
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          })()}
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
function TallyDot({ tone, count, label }: { tone: 'good' | 'bad' | 'neutral' | 'info'; count: number; label: string }) {
  const dot =
    tone === 'good' ? UX.greenInk :
    tone === 'bad'  ? UX.redInk   :
    tone === 'info' ? UX.indigo   :
                      UX.ink4
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
      <span style={{ fontSize: 17, fontWeight: UX.fwMedium, color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{count}</span>
      <span style={{ fontSize: UX.fsMicro, color: UX.ink3 }}>{label}</span>
    </div>
  )
}

// ─── FeedbackButtons — per-month owner reaction on an AI suggestion ──
// Writes to ai_forecast_outcomes via /api/budgets/feedback. The next
// AI generation includes these reactions in its "PRIOR ACCURACY"
// block, so the AI self-corrects toward what the owner actually wants.
function FeedbackButtons({
  businessId, year, month, currentReaction, onRecord,
}: {
  businessId: string | null
  year: number
  month: number
  currentReaction: string | undefined
  onRecord: (reaction: string) => void
}) {
  const [saving, setSaving] = useState<string | null>(null)

  const record = async (reaction: 'too_high' | 'too_low' | 'just_right' | 'wrong_shape') => {
    if (!businessId || saving) return
    setSaving(reaction)
    try {
      const r = await fetch('/api/budgets/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, year, month, reaction }),
      })
      if (r.ok) onRecord(reaction)
    } catch { /* silent — UI doesn't block on this */ }
    setSaving(null)
  }

  const btn = (reaction: 'too_high' | 'too_low' | 'just_right', glyph: string, title: string) => {
    const active = currentReaction === reaction
    return (
      <button
        onClick={() => record(reaction)}
        disabled={saving !== null}
        title={title}
        style={{
          padding:     '2px 6px',
          background:  active ? '#6366f1' : 'transparent',
          color:       active ? 'white'   : '#9ca3af',
          border:      `1px solid ${active ? '#6366f1' : '#e5e7eb'}`,
          borderRadius: 4,
          fontSize:    10,
          fontWeight:  600,
          cursor:      saving === null ? 'pointer' : 'wait',
          opacity:     saving === reaction ? 0.6 : 1,
          transition:  'all 120ms',
        }}
      >
        {glyph}
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {btn('too_low',    '↑', 'Target too low')}
      {btn('just_right', '✓', 'Just right')}
      {btn('too_high',   '↓', 'Target too high')}
    </div>
  )
}