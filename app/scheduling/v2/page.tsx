'use client'
// @ts-nocheck
// app/scheduling/v2/page.tsx
//
// Parallel preview route for the new hours-first AI scheduling layout.
// Reuses the EXACT same data flow as /scheduling (ai-suggestion fetch +
// per-day acceptances + accept-all endpoint) so the original page stays
// unaffected and we can compare side-by-side. Original AiSchedulePanel
// stays live on /scheduling. Once Paul signs off, we can swap in the new
// component there and delete this preview route.
//
// FIXES §0pp (2026-04-28).

export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import dynamicImport from 'next/dynamic'
import TopBar from '@/components/ui/TopBar'
import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtHrs as fmtH } from '@/lib/format'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })
const AiHoursReductionMap = dynamicImport(() => import('@/components/scheduling/AiHoursReductionMap'), { ssr: false })

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

type Range = 'this_week' | 'next_week' | '2w' | '4w' | 'next_month'
const RANGE_LABELS: Record<Range, string> = {
  this_week:  'This week',
  next_week:  'Next week',
  '2w':       '2 weeks',
  '4w':       '4 weeks',
  next_month: 'Next month',
}

function getAiBounds(range: Range): { from: string; to: string; label: string } {
  const now = new Date()
  const dow = now.getDay() === 0 ? 7 : now.getDay()
  const thisMon = new Date(now); thisMon.setDate(now.getDate() - (dow - 1)); thisMon.setHours(0,0,0,0)
  const thisSun = new Date(thisMon); thisSun.setDate(thisMon.getDate() + 6)
  const nextMon = new Date(thisMon); nextMon.setDate(thisMon.getDate() + 7)
  let end: Date, label: string
  switch (range) {
    case 'this_week': return { from: localDate(thisMon), to: localDate(thisSun), label: 'This week' }
    case '2w':        end = new Date(nextMon); end.setDate(nextMon.getDate() + 13); label = 'Next 2 weeks'; break
    case '4w':        end = new Date(nextMon); end.setDate(nextMon.getDate() + 27); label = 'Next 4 weeks'; break
    case 'next_month': {
      const y = nextMon.getFullYear(), m = nextMon.getMonth() + 1
      const start = new Date(y, m, 1)
      end = new Date(y, m + 1, 0)
      return { from: localDate(start), to: localDate(end), label: `${MONTHS[start.getMonth()]} ${start.getFullYear()}` }
    }
    case 'next_week':
    default: {
      end = new Date(nextMon); end.setDate(nextMon.getDate() + 6); label = 'Next week'; break
    }
  }
  return { from: localDate(nextMon), to: localDate(end), label }
}

export default function SchedulingV2Page() {
  const [selectedBiz, setSelectedBiz] = useState('')
  const [aiRange,     setAiRange]     = useState<Range>('next_week')
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [acceptances, setAcceptances] = useState<Record<string, any>>({})

  // Sidebar business sync (same pattern as the rest of the app)
  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('cc_selected_biz')
      if (saved) setSelectedBiz(saved)
    }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const aiBounds = getAiBounds(aiRange)

  // ── Load AI suggestion ────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedBiz) return
    let cancelled = false
    setLoading(true); setError('')
    const qs = `business_id=${selectedBiz}&from=${aiBounds.from}&to=${aiBounds.to}`
    fetch(`/api/scheduling/ai-suggestion?${qs}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled) { if (j.error) setError(j.error); else setData(j) } })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedBiz, aiRange])

  // ── Load existing acceptances ─────────────────────────────────────────
  const loadAcceptances = useCallback(async () => {
    if (!selectedBiz) return
    try {
      const r = await fetch(`/api/scheduling/acceptances?business_id=${selectedBiz}&from=${aiBounds.from}&to=${aiBounds.to}`, { cache: 'no-store' })
      const j = await r.json()
      if (r.ok) {
        const map: Record<string, any> = {}
        for (const row of (j.rows ?? [])) map[row.date] = row
        setAcceptances(map)
      }
    } catch { /* non-fatal */ }
  }, [selectedBiz, aiBounds.from, aiBounds.to])
  useEffect(() => { loadAcceptances() }, [loadAcceptances])

  // ── Apply all (delegates to existing /api/scheduling/accept-all) ─────
  async function acceptAll(rows: any[]) {
    const payload = rows.map(r => ({
      date:            r.date,
      ai_hours:        r.ai_hours,
      ai_cost_kr:      r.ai_cost_kr,
      current_hours:   r.current_hours,
      current_cost_kr: r.current_cost_kr,
      est_revenue_kr:  r.est_revenue_kr,
    }))
    const optimistic: Record<string, any> = { ...acceptances }
    for (const r of rows) optimistic[r.date] = { ...r, decided_at: new Date().toISOString() }
    setAcceptances(optimistic)
    try {
      const r = await fetch('/api/scheduling/accept-all', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: selectedBiz, rows: payload }),
      })
      if (!r.ok) {
        const j = await r.json()
        throw new Error(j.error ?? 'accept-all failed')
      }
      // Reload from server so we get the canonical batch_id + decided_at.
      loadAcceptances()
    } catch (e: any) {
      setAcceptances(acceptances)
      alert(`Couldn't apply all: ${e.message}`)
    }
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>

        <TopBar
          crumbs={[{ label: 'Scheduling', href: '/scheduling' }, { label: 'New layout (preview)', active: true }]}
          rightSlot={
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {(['this_week','next_week','2w','4w','next_month'] as Range[]).map(r => (
                <button
                  key={r}
                  onClick={() => setAiRange(r)}
                  style={{
                    padding:      '6px 12px',
                    border:       'none',
                    background:   aiRange === r ? UX.indigoTint : 'transparent',
                    color:        aiRange === r ? UX.ink1 : UX.ink3,
                    fontSize:     UX.fsBody,
                    fontWeight:   aiRange === r ? UX.fwMedium : UX.fwRegular,
                    borderRadius: UX.r_md,
                    cursor:       'pointer',
                  }}
                >
                  {RANGE_LABELS[r]}
                </button>
              ))}
            </div>
          }
        />

        {/* Preview-mode banner — makes the comparison context unambiguous. */}
        <div style={{
          background:   UX.indigoBg,
          border:       `1px solid ${UX.indigoLight}`,
          borderRadius: UX.r_lg,
          padding:      '10px 14px',
          marginBottom: 14,
          fontSize:     12,
          color:        UX.ink2,
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'space-between',
        }}>
          <span>
            <strong style={{ color: UX.ink1 }}>Preview layout</strong> — driven by the same AI data as the original page. Apply still writes to the live schedule.
          </span>
          <a href="/scheduling" style={{ color: UX.indigo, fontWeight: UX.fwMedium, textDecoration: 'none' }}>
            ← Original layout
          </a>
        </div>

        <AiHoursReductionMap
          loading={loading}
          error={error}
          data={data}
          rangeLabel={aiBounds.label}
          acceptances={acceptances}
          onAcceptAll={acceptAll}
          fmt={fmtKr}
          fmtHrs={fmtH}
        />

        {/* Reuse the AskAI floating button — same enrichments fire on this page. */}
        <AskAI
          page="scheduling"
          context={data ? [
            `Period: ${aiBounds.from} to ${aiBounds.to} (${aiBounds.label})`,
            `AI recommendation: cut ${data.summary?.current_hours - data.summary?.suggested_hours}h, save ${data.summary?.saving_kr} kr`,
            `Days flagged for manager decision: ${data.summary?.under_staffed_days}`,
          ].join('\n') : 'Loading scheduling preview'}
        />
      </div>
    </AppShell>
  )
}
