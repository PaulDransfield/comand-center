'use client'
// @ts-nocheck
// app/budget/page.tsx — full rebuild on the new system
//
// Same treatment as the dashboard / staff / revenue rebuilds. Every
// surface lives on UXP + KpiCardUX / BreakdownTable; the legacy
// PageHero / SupportingStats / AttentionPanel / TopBar / inline
// QuickStat are deleted. Year stepper lives in the AppShell toolbar.
//
// Four flows preserved:
//   1. Year nav  → AppShell date stepper
//   2. AI Generate (whole year) → "✦ Generate with AI" pill → modal →
//      apply all
//   3. Manual per-month edit → click any row → inline drawer
//   4. Per-month AI Analyse → "Analyse" link inside the edit drawer
//
// Data:
//   GET  /api/budgets?business_id&year         — { year, months: [12] }
//   POST /api/budgets                          — upsert per-month targets
//   POST /api/budgets/generate                 — whole-year AI suggestions
//   POST /api/budgets/analyse                  — per-month AI verdict
//   GET  /api/budgets/coach?business_id        — current-month pacing
//   POST /api/budgets/feedback                 — owner reaction on suggestion

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })
const AiLimitReached = dynamicImport(() => import('@/components/AiLimitReached'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

interface BudgetRow {
  month:  number
  budget: any
  actual: any
  last_year: any
  variance: any
}

export default function BudgetPage() {
  const now = new Date()
  const [bizId,        setBizId]        = useState<string | null>(null)
  const [year,         setYear]         = useState(now.getFullYear())
  const [rows,         setRows]         = useState<BudgetRow[]>([])
  const [loading,      setLoading]      = useState(true)
  const [editing,      setEditing]      = useState<BudgetRow | null>(null)
  const [editForm,     setEditForm]     = useState<any>({})
  const [saving,       setSaving]       = useState(false)
  // AI generation state
  const [generating,   setGenerating]   = useState(false)
  const [genError,     setGenError]     = useState('')
  const [suggestions,  setSuggestions]  = useState<any>(null)
  const [applying,     setApplying]     = useState(false)
  const [feedbackByMonth, setFeedbackByMonth] = useState<Record<number, string>>({})
  // Per-month analyse
  const [analysingMonth, setAnalysingMonth] = useState<number | null>(null)
  const [analysis,       setAnalysis]       = useState<any>(null)
  // AI limit
  const [aiLimitHit, setAiLimitHit] = useState<any>(null)
  // Coach
  const [coach,        setCoach]        = useState<any>(null)
  const [coachLoading, setCoachLoading] = useState(false)

  // Subscribe to BizPicker
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Load year rollup
  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    const res  = await fetch(`/api/budgets?business_id=${bizId}&year=${year}`)
    const data = await res.json()
    const months = Array.isArray(data) ? data : (Array.isArray(data?.months) ? data.months : [])
    setRows(months)
    setLoading(false)
  }, [bizId, year])
  useEffect(() => { if (bizId) load() }, [bizId, year, load])

  // Load coach
  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    setCoachLoading(true); setCoach(null)
    fetch(`/api/budgets/coach?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled && j && !j.error) setCoach(j) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCoachLoading(false) })
    return () => { cancelled = true }
  }, [bizId])

  // Save per-month edit
  async function saveEdit() {
    if (!editing || !bizId) return
    setSaving(true)
    await fetch('/api/budgets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...editForm, business_id: bizId, year, month: editing.month }),
    })
    setSaving(false)
    setEditing(null)
    load()
  }

  // AI generate
  async function generateWithAI() {
    if (!bizId) return
    setGenerating(true); setGenError(''); setSuggestions(null); setAiLimitHit(null)
    try {
      const res = await fetch('/api/budgets/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, year }),
      })
      const data = await res.json()
      if (res.status === 429 && data.upgrade) {
        setAiLimitHit({ limit: data.limit, used: data.used, plan: data.plan })
      } else if (!res.ok) {
        throw new Error(data.error ?? 'Generation failed')
      } else {
        setSuggestions(data)
        try { window.dispatchEvent(new Event('cc_ai_used')) } catch {}
      }
    } catch (e: any) {
      setGenError(e.message)
    }
    setGenerating(false)
  }

  async function applyAllSuggestions() {
    if (!suggestions?.monthly || !bizId) return
    setApplying(true)
    try {
      await Promise.all(suggestions.monthly.map((s: any) =>
        fetch('/api/budgets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id:           bizId,
            year,
            month:                 s.month,
            revenue_target:        s.revenue_target,
            food_cost_pct_target:  s.food_cost_pct_target,
            staff_cost_pct_target: s.staff_cost_pct_target,
            net_profit_target:     s.net_profit_target,
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

  // Per-month analyse
  async function analyseMonth(month: number) {
    if (!bizId) return
    setAnalysingMonth(month); setAnalysis(null)
    try {
      const res = await fetch('/api/budgets/analyse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, year, month }),
      })
      const data = await res.json()
      if (res.status === 429 && data.upgrade) {
        setAiLimitHit({ limit: data.limit, used: data.used, plan: data.plan })
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

  // ── Derived totals ──────────────────────────────────────────────
  const monthsInYearSoFar = year === now.getFullYear() ? now.getMonth() + 1
                          : year <  now.getFullYear() ? 12 : 0
  const withActual = rows.filter(r => r.actual && r.actual.revenue > 0)
  const totalRev   = withActual.reduce((s, r) => s + (r.actual?.revenue ?? 0), 0)
  const totalBudg  = withActual.reduce((s, r) => s + (r.budget?.revenue_target ?? 0), 0)
  const totalYearBudg = rows.reduce((s, r) => s + (r.budget?.revenue_target ?? 0), 0)
  const monthsSet  = rows.filter(r => r.budget).length
  const onTrack    = withActual.filter(r => r.actual && r.budget && r.actual.revenue >= r.budget.revenue_target).length
  const offTrack   = withActual.filter(r => r.actual && r.budget && r.actual.revenue <  r.budget.revenue_target).length
  const pacingPct  = totalBudg > 0 ? (totalRev / totalBudg) * 100 : 0
  // Linear projection: average actual × 12 (only when at least one month closed)
  const projection = withActual.length > 0 ? (totalRev / withActual.length) * 12 : 0
  const projDelta  = totalYearBudg > 0 && projection > 0
    ? `${projection >= totalYearBudg ? '+' : ''}${(((projection - totalYearBudg) / totalYearBudg) * 100).toFixed(1)}%`
    : null

  // Stepper
  const canStepNext = year < now.getFullYear() + 1
  function step(dir: -1 | 1) { setYear(y => y + dir) }

  return (
    <AppShell
      dateLabel={String(year)}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>

        {/* Header row — Generate AI action */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={generateWithAI}
            disabled={generating || !bizId}
            style={{
              padding:      '6px 14px',
              background:   generating ? UXP.lavMid : UXP.lav,
              color:        '#fff',
              border:       'none',
              borderRadius: 999,
              fontSize:     11,
              fontWeight:   500,
              fontFamily:   'inherit',
              cursor:       generating || !bizId ? 'not-allowed' : 'pointer',
              opacity:      generating || !bizId ? 0.6 : 1,
              display:      'inline-flex',
              alignItems:   'center',
              gap:          6,
            }}
          >
            <span aria-hidden>✦</span>
            {generating ? 'Generating…' : 'Generate with AI'}
          </button>
        </div>

        {aiLimitHit && (
          <AiLimitReached used={aiLimitHit.used} limit={aiLimitHit.limit} plan={aiLimitHit.plan} />
        )}

        {genError && (
          <Banner tone="bad" text={genError} onClose={() => setGenError('')} />
        )}

        {/* ── KPI strip ─────────────────────────────────────────── */}
        <KpiStrip
          year={year}
          totalYearBudg={totalYearBudg}
          monthsSet={monthsSet}
          totalRev={totalRev}
          pacingPct={pacingPct}
          monthsInYearSoFar={monthsInYearSoFar}
          withActualCount={withActual.length}
          projection={projection}
          projDelta={projDelta}
          onTrack={onTrack}
          offTrack={offTrack}
        />

        {/* ── Coach card ─────────────────────────────────────────── */}
        {coach && coach.has_budget !== false && coach.narrative && (
          <CoachCard coach={coach} />
        )}

        {/* ── Monthly BreakdownTable ─────────────────────────────── */}
        <MonthlyBreakdown
          rows={rows}
          loading={loading}
          onEdit={(row: any) => {
            setEditing(row)
            setEditForm({
              revenue_target:        row.budget?.revenue_target        ?? '',
              food_cost_pct_target:  row.budget?.food_cost_pct_target  ?? '',
              staff_cost_pct_target: row.budget?.staff_cost_pct_target ?? '',
              net_profit_target:     row.budget?.net_profit_target     ?? '',
            })
            setAnalysis(null)
          }}
          totalRev={totalRev}
          totalYearBudg={totalYearBudg}
        />

        {/* Per-month edit drawer */}
        {editing && (
          <EditDrawer
            row={editing}
            form={editForm}
            saving={saving}
            analysing={analysingMonth === editing.month}
            analysis={analysis && analysis.month === editing.month ? analysis.result : null}
            onChange={setEditForm}
            onSave={saveEdit}
            onCancel={() => { setEditing(null); setAnalysis(null) }}
            onAnalyse={() => analyseMonth(editing.month)}
          />
        )}

        {/* AI suggestions modal */}
        {suggestions && (
          <SuggestionsModal
            year={year}
            suggestions={suggestions}
            applying={applying}
            feedbackByMonth={feedbackByMonth}
            onRecord={(m: number, r: string) => setFeedbackByMonth(prev => ({ ...prev, [m]: r }))}
            onApply={applyAllSuggestions}
            onClose={() => setSuggestions(null)}
            businessId={bizId}
          />
        )}
      </div>

      <AskAI
        page="budget"
        context={rows.length > 0 ? [
          `Year ${year} budget overview`,
          `${monthsSet} of 12 months have targets set.`,
          `YTD: actual ${fmtKr(totalRev)} vs budgeted ${fmtKr(totalBudg)} (pacing ${fmtPct(pacingPct)}).`,
          projection > 0 ? `Linear projection: ${fmtKr(projection)} for the year.` : null,
        ].filter(Boolean).join('\n') : 'No budget data yet'}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function KpiStrip({
  year, totalYearBudg, monthsSet, totalRev, pacingPct,
  monthsInYearSoFar, withActualCount, projection, projDelta, onTrack, offTrack,
}: any) {
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title={`Budget ${year}`}
        value={totalYearBudg > 0 ? fmtKr(totalYearBudg) : '—'}
        microLabel={`${monthsSet} of 12 months set`}
      />
      <KpiCardUX
        title="Actual YTD"
        value={fmtKr(totalRev)}
        variant="stacked"
        stackedBars={[
          { label: 'Pacing %',     value: Math.min(100, pacingPct),               max: 100, color: UXP.lav    },
          { label: 'Year elapsed', value: monthsInYearSoFar * (100 / 12), max: 100, color: UXP.lavMid },
        ]}
        microLabel={`${withActualCount} of ${monthsInYearSoFar} closed`}
      />
      <KpiCardUX
        title="Projected"
        value={projection > 0 ? fmtKr(projection) : '—'}
        delta={projDelta}
        deltaGood
        microLabel="Linear extrapolation"
      />
      <KpiCardUX
        title="On track"
        value={`${onTrack}`}
        variant="stacked"
        stackedBars={(onTrack + offTrack) > 0 ? [
          { label: 'On track',  value: onTrack,  max: onTrack + offTrack, color: UXP.green },
          { label: 'Off track', value: offTrack, max: onTrack + offTrack, color: UXP.rose  },
        ] : undefined}
        microLabel={`${offTrack} off track`}
      />
    </div>
  )
}

// ── Coach card ──────────────────────────────────────────────────────
function CoachCard({ coach }: { coach: any }) {
  const onPace = coach.projected && coach.budget
    ? Number(coach.projected.revenue ?? 0) >= Number(coach.budget.revenue_target ?? 0)
    : null
  const tone: 'good' | 'bad' | 'warning' = onPace == null ? 'warning' : onPace ? 'good' : 'bad'
  const palette = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep, accent: UXP.green },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText,  accent: UXP.rose  },
    warning: { bg: UXP.lavFill,   fg: UXP.lavText,   accent: UXP.coral },
  }[tone]
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
      display:       'grid',
      gap:           10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          padding:      '3px 8px',
          background:   palette.bg,
          color:        palette.fg,
          borderRadius: 999,
          fontSize:     9,
          fontWeight:   600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase' as const,
        }}>
          AI coach
        </span>
        {coach.budget?.revenue_target && coach.projected?.revenue != null && (
          <span style={{ fontSize: 10, color: UXP.ink3 }}>
            {fmtKr(Number(coach.mtd?.revenue ?? 0))} MTD · projected {fmtKr(Number(coach.projected.revenue))} vs {fmtKr(Number(coach.budget.revenue_target))} target
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: UXP.ink1, lineHeight: 1.55 }}>
        {coach.narrative}
      </div>
      {coach.labour_is_the_lever && (
        <a href="/scheduling" style={{
          alignSelf:    'flex-start' as const,
          padding:      '4px 10px',
          background:   palette.bg,
          color:        palette.fg,
          border:       `0.5px solid ${palette.accent}22`,
          borderRadius: 999,
          fontSize:     10,
          fontWeight:   500,
          textDecoration: 'none',
        }}>Open scheduling →</a>
      )}
    </div>
  )
}

// ── Monthly BreakdownTable ──────────────────────────────────────────
function MonthlyBreakdown({ rows, loading, onEdit, totalRev, totalYearBudg }: any) {
  if (loading) {
    return <Card title={`Monthly budgets`} subtitle="Loading…"><Empty>Loading…</Empty></Card>
  }
  if (rows.length === 0) {
    return <Card title="Monthly budgets" subtitle="No budget rows"><Empty>No budget data yet.</Empty></Card>
  }
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Monthly budgets</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Click a row to edit or analyse
        </div>
      </div>
      <BreakdownTable<BudgetRow>
        columns={[
          { key: 'month', header: 'Month', align: 'left', render: (r) => (
            <button type="button" onClick={() => onEdit(r)} style={inlineLinkBtn}>
              <span style={{ color: UXP.ink1, fontWeight: 500 }}>{MONTHS[r.month - 1]}</span>
            </button>
          ) },
          { key: 'budget_rev', header: 'Budgeted', align: 'right', render: (r) =>
            r.budget?.revenue_target ? fmtKr(r.budget.revenue_target) : <span style={{ color: UXP.ink4 }}>Not set</span>
          },
          { key: 'actual_rev', header: 'Actual', align: 'right', render: (r) =>
            r.actual ? fmtKr(r.actual.revenue) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'variance', header: 'Variance', align: 'right', render: (r) => {
            if (!r.budget?.revenue_target || !r.actual) return <span style={{ color: UXP.ink4 }}>—</span>
            const v = (r.actual.revenue - r.budget.revenue_target)
            const pct = (v / r.budget.revenue_target) * 100
            return <DeltaChip value={`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`} positiveIsGood />
          } },
          { key: 'food_pct', header: 'Food %', align: 'right', render: (r) =>
            r.actual?.food_pct ? fmtPct(r.actual.food_pct) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'staff_pct', header: 'Staff %', align: 'right', render: (r) =>
            r.actual?.staff_pct ? fmtPct(r.actual.staff_pct) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'margin', header: 'Margin', align: 'right', render: (r) =>
            r.actual?.margin_pct != null ? fmtPct(r.actual.margin_pct) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'status', header: 'Status', align: 'right', render: (r) => {
            if (!r.budget) return <Status tone="neutral">Not set</Status>
            if (!r.actual) return <Status tone="lav">Planned</Status>
            const hit = r.actual.revenue >= r.budget.revenue_target
            return <Status tone={hit ? 'good' : 'bad'}>{hit ? 'On track' : 'Off track'}</Status>
          } },
        ]}
        sections={[{ rows }]}
        footer={{
          label: 'YTD',
          cells: {
            budget_rev: fmtKr(totalYearBudg),
            actual_rev: fmtKr(totalRev),
            variance:   '',
            food_pct:   '',
            staff_pct:  '',
            margin:     '',
            status:     '',
          },
        }}
        rowKey={(row) => String(row.month)}
      />
    </div>
  )
}

function Status({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'lav' | 'neutral' }) {
  const palette = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText  },
    lav:     { bg: UXP.lavFill,   fg: UXP.lavText   },
    neutral: { bg: UXP.subtleBg,  fg: UXP.ink4      },
  }[tone]
  return (
    <span style={{
      display:        'inline-block',
      fontSize:       9,
      padding:        '2px 7px',
      borderRadius:   6,
      background:     palette.bg,
      color:          palette.fg,
      fontWeight:     500,
      letterSpacing:  '0.02em',
    }}>{children}</span>
  )
}

// ── Edit drawer ──────────────────────────────────────────────────────
function EditDrawer({
  row, form, saving, analysing, analysis, onChange, onSave, onCancel, onAnalyse,
}: any) {
  return (
    <div role="dialog" aria-label="Edit budget" style={drawerStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            Edit budget
          </div>
          <div style={{ fontSize: 17, fontWeight: 500, color: UXP.ink1, marginTop: 2 }}>
            {MONTHS[row.month - 1]}
          </div>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 16 }}>×</button>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <FormField label="Revenue target (kr)">
          <input type="number" value={form.revenue_target}
                 onChange={e => onChange({ ...form, revenue_target: e.target.value })}
                 style={formInput} />
        </FormField>
        <FormField label="Food cost target (%)">
          <input type="number" value={form.food_cost_pct_target}
                 onChange={e => onChange({ ...form, food_cost_pct_target: e.target.value })}
                 style={formInput} />
        </FormField>
        <FormField label="Staff cost target (%)">
          <input type="number" value={form.staff_cost_pct_target}
                 onChange={e => onChange({ ...form, staff_cost_pct_target: e.target.value })}
                 style={formInput} />
        </FormField>
        <FormField label="Net profit target (kr)">
          <input type="number" value={form.net_profit_target}
                 onChange={e => onChange({ ...form, net_profit_target: e.target.value })}
                 style={formInput} />
        </FormField>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <button type="button" onClick={onSave} disabled={saving} style={primaryBtn}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onAnalyse} disabled={analysing} style={ghostBtn}>
          ✦ {analysing ? 'Analysing…' : 'Analyse'}
        </button>
      </div>

      {analysis && (
        <div style={{
          marginTop:    14,
          padding:      '12px 14px',
          background:   UXP.lavFill,
          color:        UXP.lavText,
          borderRadius: UXP.r_md,
          fontSize:     11,
          lineHeight:   1.55,
        }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>{analysis.headline || 'AI verdict'}</div>
          {Array.isArray(analysis.analysis) && analysis.analysis.map((line: string, i: number) => (
            <div key={i} style={{ marginTop: 4 }}>{line}</div>
          ))}
          {Array.isArray(analysis.recommendations) && analysis.recommendations.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>
                Recommendations
              </div>
              {analysis.recommendations.map((r: string, i: number) => (
                <div key={i} style={{ marginTop: 4 }}>• {r}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Suggestions modal ───────────────────────────────────────────────
function SuggestionsModal({
  year, suggestions, applying, feedbackByMonth, onRecord, onApply, onClose, businessId,
}: any) {
  return (
    <div role="dialog" aria-label="AI suggestions" style={{
      position:    'fixed' as const,
      inset:       0,
      background:  'rgba(58,53,80,0.32)',
      display:     'flex',
      alignItems:  'center',
      justifyContent: 'center',
      padding:     20,
      zIndex:      1000,
    }}>
      <div style={{
        background:    UXP.cardBg,
        borderRadius:  UXP.r_lg,
        width:         '100%',
        maxWidth:      720,
        maxHeight:     '90vh',
        overflow:      'hidden' as const,
        display:       'flex',
        flexDirection: 'column' as const,
        border:        `0.5px solid ${UXP.border}`,
      }}>
        <div style={{ padding: '14px 18px', borderBottom: `0.5px solid ${UXP.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1 }}>AI budget for {year}</div>
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
              Review each month, give feedback, then apply the whole set.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{
            background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 16,
          }}>×</button>
        </div>

        {suggestions.overall_strategy && (
          <div style={{ padding: '10px 18px', background: UXP.lavFill, color: UXP.lavText, fontSize: 11, lineHeight: 1.5, borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
            <span style={{ fontWeight: 500 }}>Strategy: </span>{suggestions.overall_strategy}
          </div>
        )}

        <div style={{ overflowY: 'auto' as const, flex: 1, padding: '6px 18px 14px' }}>
          {suggestions.monthly?.map((s: any) => (
            <div key={s.month} style={{ padding: '10px 0', borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontWeight: 500, color: UXP.ink1, fontSize: 12 }}>{MONTHS[s.month - 1]}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <FeedbackButtons
                    businessId={businessId}
                    year={year}
                    month={s.month}
                    currentReaction={feedbackByMonth[s.month]}
                    onRecord={(r: string) => onRecord(s.month, r)}
                  />
                  <span style={{ fontSize: 12, color: UXP.lavText, fontWeight: 500, fontVariantNumeric: 'tabular-nums' as const }}>
                    {fmtKr(s.revenue_target)}
                  </span>
                </div>
              </div>
              <div style={{ fontSize: 10, color: UXP.ink3 }}>
                Food {s.food_cost_pct_target}% · Staff {s.staff_cost_pct_target}% · Profit {fmtKr(s.net_profit_target)}
              </div>
              {s.reasoning && (
                <div style={{ fontSize: 10, color: UXP.ink4, fontStyle: 'italic' as const, marginTop: 4 }}>
                  {s.reasoning}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: '12px 18px', borderTop: `0.5px solid ${UXP.borderSoft}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
          <button type="button" onClick={onApply} disabled={applying} style={primaryBtn}>
            {applying ? 'Applying…' : 'Apply all'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FeedbackButtons({ businessId, year, month, currentReaction, onRecord }: any) {
  const [saving, setSaving] = useState<string | null>(null)
  async function record(reaction: string) {
    if (!businessId || saving) return
    setSaving(reaction)
    try {
      const r = await fetch('/api/budgets/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, year, month, reaction }),
      })
      if (r.ok) onRecord(reaction)
    } catch {}
    setSaving(null)
  }
  const btn = (reaction: string, glyph: string, title: string) => {
    const active = currentReaction === reaction
    return (
      <button
        key={reaction}
        type="button"
        onClick={() => record(reaction)}
        disabled={saving !== null}
        title={title}
        style={{
          padding:      '2px 6px',
          background:   active ? UXP.lav : 'transparent',
          color:        active ? '#fff'  : UXP.ink3,
          border:       `0.5px solid ${active ? UXP.lav : UXP.border}`,
          borderRadius: 4,
          fontSize:     10,
          fontWeight:   500,
          cursor:       saving === null ? 'pointer' : 'wait',
          opacity:      saving === reaction ? 0.6 : 1,
          fontFamily:   'inherit',
        }}
      >{glyph}</button>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {btn('too_low',    '↑', 'Target too low')}
      {btn('just_right', '✓', 'Just right')}
      {btn('too_high',   '↓', 'Target too high')}
    </div>
  )
}

// ── Atoms / styles ──────────────────────────────────────────────────
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>{children}</div>
}

function Banner({ tone, text, onClose }: { tone: 'bad' | 'good'; text: string; onClose?: () => void }) {
  const palette = tone === 'bad'
    ? { bg: UXP.roseFill,  border: UXP.rose,  fg: UXP.roseText  }
    : { bg: UXP.greenFill, border: UXP.green, fg: UXP.greenDeep }
  return (
    <div style={{
      background:    palette.bg,
      border:        `0.5px solid ${palette.border}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 14px',
      fontSize:      12,
      color:         palette.fg,
      display:       'flex',
      justifyContent: 'space-between',
      alignItems:    'center',
      gap:           12,
    }}>
      <span style={{ flex: 1 }}>{text}</span>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: palette.fg, fontSize: 16 }}>×</button>
      )}
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
      <span style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</span>
      {children}
    </label>
  )
}

const inlineLinkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0,
  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' as const,
}

const drawerStyle: React.CSSProperties = {
  position:   'fixed' as const,
  top:        0, right: 0, bottom: 0,
  width:      'min(420px, 100%)',
  background: UXP.cardBg,
  borderLeft: `0.5px solid ${UXP.border}`,
  boxShadow:  '-8px 0 24px rgba(58,53,80,0.08)',
  padding:    '18px 22px',
  overflow:   'auto' as const,
  zIndex:     50,
}

const formInput: React.CSSProperties = {
  padding:      '6px 10px',
  background:   UXP.cardBg,
  color:        UXP.ink1,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 7,
  fontSize:     11,
  fontFamily:   'inherit',
}

const primaryBtn: React.CSSProperties = {
  padding:      '6px 14px',
  background:   UXP.lavDeep,
  color:        '#fff',
  border:       'none',
  borderRadius: 999,
  fontSize:     11,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}

const ghostBtn: React.CSSProperties = {
  padding:      '6px 12px',
  background:   UXP.cardBg,
  color:        UXP.ink2,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 999,
  fontSize:     11,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}
