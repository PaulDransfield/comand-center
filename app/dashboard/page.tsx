'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import { deptColor, deptBg, DEPT_COLORS, KPI_CARD, CC_DARK, CC_PURPLE } from '@/lib/constants/colors'

interface Business {
  id: string; name: string; city: string | null
  revenue: number; staff_cost: number; food_cost: number; net_profit: number
  margin: number; staffPct: number; foodPct: number
  target_margin_pct: number; target_staff_pct: number; target_food_pct: number
  is_active: boolean
}
interface Alert { id: string; severity: string; title: string; description: string; created_at: string }
interface MonthBar { period_month: number; revenue: number; net_profit: number; staff_cost: number }
interface StaffSummary { logged_hours: number; scheduled_hours: number; staff_cost_actual: number; shifts_logged: number }
interface Forecast { period_month: number; revenue_forecast: number; staff_cost_forecast: number; margin_forecast: number }

const fmtKr  = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
const fmtPct = (n: number) => n.toFixed(1) + '%'
const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function KpiCard({ label, value, sub, ok, delta, href }: any) {
  const content = (
    <div style={{ background: 'white', borderRadius: 12, padding: '16px 18px', border: `0.5px solid ${ok === false ? '#fecaca' : '#e5e7eb'}`, cursor: href ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: '#111', marginBottom: 4 }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {delta && <span style={{ fontSize: 11, fontWeight: 600, color: ok === false ? '#dc2626' : ok === true ? '#15803d' : '#9ca3af' }}>{delta}</span>}
        {sub && <span style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</span>}
      </div>
    </div>
  )
  return href ? <a href={href} style={{ textDecoration: 'none' }}>{content}</a> : content
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div style={{ height: 4, background: '#f3f4f6', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.3s' }} />
    </div>
  )
}

export default function DashboardPage() {
  const now  = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1

  const [businesses,   setBusinesses]   = useState<Business[]>([])
  const [selected,     setSelected]     = useState<Business | null>(null)
  const [alerts,       setAlerts]       = useState<Alert[]>([])
  const [chartData,    setChartData]    = useState<MonthBar[]>([])
  const [setupPending, setSetupPending] = useState(false)
  const [staffData,    setStaffData]    = useState<StaffSummary | null>(null)
  const [forecasts,    setForecasts]    = useState<Forecast[]>([])
  const [deptData,     setDeptData]     = useState<any>(null)
  const [posData,      setPosData]      = useState<any>(null)
  const [staffRevData, setStaffRevData] = useState<any>(null)
  const [loading,      setLoading]      = useState(true)
  const [greeting,     setGreeting]     = useState('Good morning')
  const [lastSync,     setLastSync]     = useState<string | null>(null)
  const [showUpgradeBanner, setShowUpgradeBanner] = useState(false)
  const [upgradedPlan,     setUpgradedPlan]     = useState('')

  // Show success banner when Stripe redirects back after payment.
  // Reads from window.location.search — safe because this is a client component.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('upgrade') === 'success') {
      setUpgradedPlan(params.get('plan') ?? '')
      setShowUpgradeBanner(true)
      const t = setTimeout(() => setShowUpgradeBanner(false), 8000)
      return () => clearTimeout(t)
    }
  }, [])

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const sync = () => {
        const saved = localStorage.getItem('cc_selected_biz')
        const biz = (saved && data.find((b: any) => b.id === saved)) ? data.find((b: any) => b.id === saved) : data[0]
        if (biz) { setSelected(biz); localStorage.setItem('cc_selected_biz', biz.id) }
      }
      sync()
      window.addEventListener('storage', sync)
    }).catch(() => {})
  }, [])

  // Fetch all dashboard data when selected business changes
  useEffect(() => {
    if (!selected) return
    setLoading(true)
    const bizId = (selected as any).id ?? selected
    const year  = now.getFullYear()
    const month2 = now.getMonth() + 1
    const fromDate = `${year}-${String(month2).padStart(2,'0')}-01`
    const toDate   = now.toISOString().slice(0,10)

    Promise.all([
      fetch(`/api/tracker?business_id=${bizId}&year=${year}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/forecast?business_id=${bizId}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/departments?year=${year}&business_id=${bizId}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/staff?from=${fromDate}&to=${toDate}&business_id=${bizId}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/revenue-detail?business_id=${bizId}&from=${fromDate}&to=${toDate}`).then(r => r.json()).catch(() => null),
      fetch(`/api/staff-revenue?business_id=${bizId}&from=${fromDate}&to=${toDate}`).then(r => r.json()).catch(() => null),
    ]).then(([trackerData, forecastData, deptRes, staffRes, revDetail, staffRevDetail]) => {
      if (Array.isArray(trackerData?.rows)) setChartData(trackerData.rows)
      // If no tracker data and no staff data, likely still being set up
      const hasAnyData = (trackerData?.rows?.length > 0) || (staffRes?.summary?.shifts_logged > 0)
      setSetupPending(!hasAnyData)
      if (Array.isArray(forecastData?.forecasts)) setForecasts(forecastData.forecasts)
      if (deptRes?.totals) setDeptData(deptRes)
      if (staffRes?.summary) setStaffData(staffRes.summary)
      if (revDetail?.summary) setPosData(revDetail.summary)
      if (staffRevDetail?.summary?.avg_staff_pct !== undefined) setStaffRevData(staffRevDetail.summary)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [selected])

  const nextForecast = forecasts.find(f => f.period_month === month + 1) ?? forecasts.find(f => f.period_month > month)
  const thisMonthTracker = chartData.find(r => r.period_month === month)
  const lastMonthTracker = chartData.find(r => r.period_month === month - 1)

  // Live staff cost % from daily join
  const liveStaffPct     = staffRevData?.avg_staff_pct ?? null
  const daysOverTarget   = staffRevData?.days_over_target ?? 0
  const targetStaffPct   = selected?.target_staff_pct ?? 40

  // Live POS channel data for this month
  const liveRevenue  = posData?.total_revenue    ?? 0
  const dineIn       = posData?.total_dine_in    ?? 0
  const takeaway     = posData?.total_takeaway   ?? 0
  const foodRevenue  = posData?.total_food_revenue ?? 0
  const bevRevenue   = posData?.total_bev_revenue  ?? 0
  const hasChannels  = dineIn > 0 || takeaway > 0
  const hasFoodBev   = foodRevenue > 0 || bevRevenue > 0

  // Live food cost % — uses POS revenue (updates daily) rather than monthly tracker entry
  const trackerFoodCost = (thisMonthTracker as any)?.food_cost ?? selected?.food_cost ?? 0
  const liveFoodCostPct = trackerFoodCost > 0 && liveRevenue > 0
    ? (trackerFoodCost / liveRevenue * 100)
    : 0

  const ytdRevenue = chartData.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
  const ytdProfit  = chartData.reduce((s, r) => s + Number(r.net_profit ?? 0), 0)
  const maxRev     = Math.max(...chartData.map(r => Number(r.revenue ?? 0)), 1)

  // Top departments this year
  const topDepts = deptData
    ? Object.entries(deptData.totals ?? {})
        .sort((a: any, b: any) => b[1].cost - a[1].cost)
        .slice(0, 4)
    : []

  // DEPT_COLORS and deptColor imported from @/lib/constants/colors

  return (
    <AppShell>
      <div className="page-wrap">

        {/* Header */}
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>
              {greeting} 
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#9ca3af' }}>
              {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              {lastSync && ` · Last sync ${new Date(lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={selected?.id ?? ''}
              onChange={e => {
                const biz = businesses.find(b => b.id === e.target.value)
                if (biz) { setSelected(biz); localStorage.setItem('cc_selected_biz', biz.id) }
              }}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button onClick={() => window.location.reload()} style={{ padding: '8px 14px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 12, cursor: 'pointer', color: '#374151' }}>Refresh</button>
          </div>
        </div>

        {/* Upgrade success — shown when Stripe redirects back after payment */}
        {showUpgradeBanner && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>🎉</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#15803d' }}>
                  You&apos;re now on the {upgradedPlan ? upgradedPlan.charAt(0).toUpperCase() + upgradedPlan.slice(1) : 'new'} plan
                </div>
                <div style={{ fontSize: 12, color: '#4b7c59' }}>All features are now unlocked. Welcome aboard.</div>
              </div>
            </div>
            <button onClick={() => setShowUpgradeBanner(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#15803d', fontSize: 18, lineHeight: 1, padding: '0 4px' }}>×</button>
          </div>
        )}

        {setupPending && !loading && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '16px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#92400e', marginBottom: 2 }}>Your dashboard is being set up</div>
              <div style={{ fontSize: 13, color: '#b45309' }}>We are connecting your data. This usually takes less than 30 minutes. You will receive an email when everything is ready.</div>
            </div>
            <a href="/integrations" style={{ fontSize: 12, padding: '7px 14px', background: '#1a1f2e', color: 'white', borderRadius: 8, textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap' as const }}>
              Check integrations →
            </a>
          </div>
        )}

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Loading dashboard...</div>
        ) : !selected ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            No restaurants found. <a href="/settings" style={{ color: '#6366f1' }}>Add one in settings →</a>
          </div>
        ) : (
          <>
            {/* Row 1 — Key financials (5 cards) */}
            <div className="grid-5" style={{ marginBottom: 16 }}>
              <KpiCard
                label="Revenue this month"
                value={fmtKr(thisMonthTracker?.revenue ?? selected.revenue)}
                sub={`${MONTHS[month-1]} ${year}`}
                ok={selected.revenue > 0}
                delta={selected.revenue > 0 ? '• Live' : 'No data'}
                href="/tracker"
              />
              <KpiCard
                label="Net profit"
                value={fmtKr(thisMonthTracker?.net_profit ?? selected.net_profit)}
                sub={fmtPct(selected.margin) + ' margin'}
                ok={selected.margin >= selected.target_margin_pct}
                delta={selected.margin >= selected.target_margin_pct ? '+ On target' : '- Below target'}
                href="/tracker"
              />
              <KpiCard
                label="Staff cost"
                value={liveStaffPct !== null ? fmtPct(liveStaffPct) : fmtPct(selected.staffPct)}
                sub={liveStaffPct !== null ? `Live · target ${fmtPct(targetStaffPct)}` : `Target ${fmtPct(selected.target_staff_pct)}`}
                ok={(liveStaffPct ?? selected.staffPct) <= (selected.target_staff_pct) || selected.staffPct === 0}
                delta={liveStaffPct !== null
                  ? (daysOverTarget > 0 ? `${daysOverTarget} days over target` : '+ All days on target')
                  : (staffData ? fmtKr(staffData.staff_cost_actual) : '—')}
                href="/staff"
              />
              <KpiCard
                label="Food cost"
                value={liveFoodCostPct > 0 ? fmtPct(liveFoodCostPct) : fmtPct(selected.foodPct)}
                sub={liveFoodCostPct > 0 ? `Live · target ${fmtPct(selected.target_food_pct)}` : `Target ${fmtPct(selected.target_food_pct)}`}
                ok={(liveFoodCostPct > 0 ? liveFoodCostPct : selected.foodPct) <= selected.target_food_pct || selected.foodPct === 0}
                delta={liveFoodCostPct > 0
                  ? (liveFoodCostPct <= selected.target_food_pct ? '+ On target' : '- Over target')
                  : (selected.foodPct <= selected.target_food_pct ? '+ On target' : '- Over target')}
                href="/food-bev"
              />
              <KpiCard
                label="Next month forecast"
                value={nextForecast ? fmtKr(nextForecast.revenue_forecast) : '—'}
                sub={nextForecast ? `${MONTHS[nextForecast.period_month-1]} · ${fmtPct(nextForecast.margin_forecast)} margin` : 'Run sync to generate'}
                ok={null}
                delta={nextForecast ? `Staff ${fmtKr(nextForecast.staff_cost_forecast)}` : null}
                href="/forecast"
              />
            </div>

            {/* Row 2 — Staff + Alerts */}
            <div className="layout-three-col" style={{ marginBottom: 12 }}>

              {/* Staff this month */}
              <div style={{ background: 'white', borderRadius: 12, padding: '16px 18px', border: '0.5px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Staff this month</div>
                  <a href="/staff" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>View all →</a>
                </div>
                {staffData ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                      {[
                        { label: 'Hours logged', value: staffData.logged_hours + 'h', bar: staffData.logged_hours, max: Math.max(staffData.logged_hours, staffData.scheduled_hours), color: '#1a1f2e' },
                        { label: 'Scheduled',    value: staffData.scheduled_hours + 'h', bar: staffData.scheduled_hours, max: Math.max(staffData.logged_hours, staffData.scheduled_hours), color: '#e5e7eb' },
                      ].map(item => (
                        <div key={item.label}>
                          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>{item.label}</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>{item.value}</div>
                          <MiniBar value={item.bar} max={item.max} color={item.color} />
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '0.5px solid #f3f4f6' }}>
                      <div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>Actual cost</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>{fmtKr(staffData.staff_cost_actual)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>Shifts</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>{staffData.shifts_logged}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>Variance</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: staffData.logged_hours > staffData.scheduled_hours ? '#dc2626' : '#15803d' }}>
                          {staffData.logged_hours > staffData.scheduled_hours ? '+' : ''}{Math.round((staffData.logged_hours - staffData.scheduled_hours) * 10) / 10}h
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: 20 }}>
                    Connect Personalkollen to see staff data
                  </div>
                )}
              </div>

              {/* Departments */}
              <div style={{ background: 'white', borderRadius: 12, padding: '16px 18px', border: '0.5px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Top departments (YTD)</div>
                  <a href="/departments" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>View all →</a>
                </div>
                {topDepts.length > 0 ? (
                  topDepts.map(([dept, data]: any) => {
                    const totalCost = Object.values(deptData.totals ?? {}).reduce((s: number, d: any) => s + d.cost, 0)
                    const pct = totalCost > 0 ? ((data as any).cost / totalCost) * 100 : 0
                    const color = DEPT_COLORS[dept] ?? '#9ca3af'
                    return (
                      <div key={dept} style={{ marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                            <span style={{ fontSize: 12, color: '#374151' }}>{dept}</span>
                            <span style={{ fontSize: 11, color: '#9ca3af' }}>{data.staff} staff</span>
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{fmtKr((data as any).cost)}</span>
                        </div>
                        <MiniBar value={(data as any).cost} max={(topDepts[0]?.[1] as any)?.cost ?? 1} color={color} />
                      </div>
                    )
                  })
                ) : (
                  <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: 20 }}>
                    Sync Personalkollen to see department data
                  </div>
                )}
              </div>

              {/* Alerts */}
              <div style={{ background: 'white', borderRadius: 12, padding: '16px 18px', border: '0.5px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Alerts</div>
                  <a href="/alerts" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>View all →</a>
                </div>
                {alerts.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', padding: '20px 0', gap: 8 }}>
                    <div style={{ fontSize: 24 }}>OK</div>
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>All clear — no active alerts</div>
                  </div>
                ) : alerts.map(a => (
                  <div key={a.id} style={{ marginBottom: 10, padding: '8px 10px', background: '#fafafa', borderRadius: 8, borderLeft: `3px solid ${a.severity === 'critical' || a.severity === 'high' ? '#dc2626' : '#f59e0b'}` }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{a.title}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{a.description?.slice(0, 60)}{a.description?.length > 60 ? '...' : ''}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Row 2.5 — Live channel breakdown (only shown when POS provides channel data) */}
            {(hasChannels || hasFoodBev) && (
              <div style={{ display: 'grid', gridTemplateColumns: hasChannels && hasFoodBev ? '1fr 1fr' : '1fr', gap: 12, marginBottom: 12 }}>

                {/* Dine-in vs Takeaway */}
                {hasChannels && (
                  <div style={{ background: 'white', borderRadius: 12, padding: '16px 18px', border: '0.5px solid #e5e7eb' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Sales channels — {MONTHS[month-1]}</div>
                      <a href="/revenue" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>Full detail →</a>
                    </div>
                    {/* Stacked bar */}
                    <div style={{ display: 'flex', height: 16, borderRadius: 8, overflow: 'hidden', marginBottom: 12, background: '#f3f4f6' }}>
                      {liveRevenue > 0 && (
                        <>
                          {dineIn > 0 && <div style={{ width: `${(dineIn / liveRevenue) * 100}%`, background: '#1a1f2e', transition: 'width 0.4s' }} />}
                          {takeaway > 0 && <div style={{ width: `${(takeaway / liveRevenue) * 100}%`, background: '#6366f1', transition: 'width 0.4s' }} />}
                        </>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      {[
                        { color: '#1a1f2e', label: 'Dine-in',  value: dineIn,    pct: liveRevenue > 0 ? Math.round(dineIn / liveRevenue * 100) : 0 },
                        { color: '#6366f1', label: 'Takeaway', value: takeaway,  pct: liveRevenue > 0 ? Math.round(takeaway / liveRevenue * 100) : 0 },
                      ].map(ch => (
                        <div key={ch.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, background: ch.color, marginTop: 3, flexShrink: 0 }} />
                          <div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{ch.label}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>{fmtKr(ch.value)}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{ch.pct}% of revenue</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Food vs Beverage */}
                {hasFoodBev && (
                  <div style={{ background: 'white', borderRadius: 12, padding: '16px 18px', border: '0.5px solid #e5e7eb' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Food & beverage — {MONTHS[month-1]}</div>
                      <a href="/revenue" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>Full detail →</a>
                    </div>
                    {/* Stacked bar */}
                    <div style={{ display: 'flex', height: 16, borderRadius: 8, overflow: 'hidden', marginBottom: 12, background: '#f3f4f6' }}>
                      {liveRevenue > 0 && (
                        <>
                          {foodRevenue > 0 && <div style={{ width: `${(foodRevenue / liveRevenue) * 100}%`, background: '#f59e0b', transition: 'width 0.4s' }} />}
                          {bevRevenue > 0 && <div style={{ width: `${(bevRevenue / liveRevenue) * 100}%`, background: '#10b981', transition: 'width 0.4s' }} />}
                        </>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      {[
                        { color: '#f59e0b', label: 'Food',      value: foodRevenue, pct: liveRevenue > 0 ? Math.round(foodRevenue / liveRevenue * 100) : 0 },
                        { color: '#10b981', label: 'Beverage',  value: bevRevenue,  pct: liveRevenue > 0 ? Math.round(bevRevenue  / liveRevenue * 100) : 0 },
                      ].map(ch => (
                        <div key={ch.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, background: ch.color, marginTop: 3, flexShrink: 0 }} />
                          <div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{ch.label}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>{fmtKr(ch.value)}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{ch.pct}% of revenue</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Live food cost % if tracker data available */}
                    {liveFoodCostPct > 0 && (
                      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '0.5px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>Food cost % <span style={{ fontSize: 10, background: '#f0fdf4', color: '#15803d', padding: '1px 5px', borderRadius: 4, fontWeight: 600, marginLeft: 4 }}>LIVE</span></span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: liveFoodCostPct <= selected!.target_food_pct ? '#15803d' : '#dc2626' }}>{fmtPct(liveFoodCostPct)}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Row 3 — Revenue chart + YTD summary */}
            <div className="layout-chart-side" style={{ marginBottom: 12 }}>

              {/* Revenue bar chart */}
              <div style={{ background: 'white', borderRadius: 12, padding: '18px 20px', border: '0.5px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Revenue vs net profit — {year}</div>
                  <a href="/tracker" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>Full P&L →</a>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
                  {MONTHS.map((mon, i) => {
                    const m    = i + 1
                    const row  = chartData.find(r => r.period_month === m)
                    const fRow = forecasts.find(f => f.period_month === m)
                    const rev  = Number(row?.revenue ?? 0)
                    const net  = Number(row?.net_profit ?? 0)
                    const fRev = Number(fRow?.revenue_forecast ?? 0)
                    const isCurrent = m === month
                    const isFuture  = m > month

                    return (
                      <div key={mon} style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 2 }}>
                        {isFuture && fRev > 0 ? (
                          // Future month — show forecast as dashed
                          <div style={{ width: '100%', flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
                            <div style={{ flex: 1, height: `${(fRev / maxRev) * 100}%`, background: 'repeating-linear-gradient(45deg, #e5e7eb, #e5e7eb 2px, white 2px, white 6px)', borderRadius: '3px 3px 0 0', minHeight: 2 }} />
                          </div>
                        ) : rev > 0 ? (
                          <div style={{ width: '100%', flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
                            <div style={{ flex: 3, height: `${(rev / maxRev) * 100}%`, background: isCurrent ? '#6366f1' : '#1a1f2e', borderRadius: '3px 3px 0 0', minHeight: 2, opacity: 0.9 }} />
                            {net > 0 && <div style={{ flex: 2, height: `${(net / maxRev) * 100}%`, background: '#10b981', borderRadius: '3px 3px 0 0', minHeight: 2 }} />}
                          </div>
                        ) : (
                          <div style={{ width: '100%', flex: 1, display: 'flex', alignItems: 'flex-end' }}>
                            <div style={{ width: '100%', height: 2, background: '#f3f4f6' }} />
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: isCurrent ? '#6366f1' : '#9ca3af', fontWeight: isCurrent ? 700 : 400 }}>{mon}</div>
                      </div>
                    )
                  })}
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
                  {[
                    { color: '#1a1f2e', label: 'Revenue' },
                    { color: '#10b981', label: 'Net profit' },
                    { color: '#e5e7eb', label: 'Forecast', dashed: true },
                  ].map(l => (
                    <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 12, height: 8, borderRadius: 2, background: l.dashed ? 'repeating-linear-gradient(45deg, #9ca3af, #9ca3af 1px, white 1px, white 3px)' : l.color, border: l.dashed ? '1px solid #e5e7eb' : 'none' }} />
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{l.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* YTD summary */}
              <div style={{ background: 'white', borderRadius: 12, padding: '16px 18px', border: '0.5px solid #e5e7eb' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 14 }}>YTD summary — {year}</div>
                {[
                  { label: 'Total revenue',     value: fmtKr(ytdRevenue),  color: '#111' },
                  { label: 'Total net profit',  value: fmtKr(ytdProfit),   color: ytdProfit > 0 ? '#15803d' : '#dc2626' },
                  { label: 'Avg margin',
                    value: fmtPct(chartData.length > 0 ? chartData.reduce((s,r) => s + Number(r.net_profit ?? 0), 0) / Math.max(ytdRevenue, 1) * 100 : 0),
                    color: '#111' },
                  { label: 'Months with data', value: `${chartData.filter(r => Number(r.revenue ?? 0) > 0).length} / 12`, color: '#9ca3af' },
                  { label: 'Active alerts',     value: String(alerts.length), color: alerts.length > 0 ? '#dc2626' : '#15803d' },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '0.5px solid #f3f4f6' }}>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{row.label}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: row.color }}>{row.value}</span>
                  </div>
                ))}

                {nextForecast && (
                  <div style={{ marginTop: 14, padding: '10px 12px', background: 'white', borderRadius: 8, border: '1px solid #e0e7ff' }}>
                    <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 600, marginBottom: 4 }}>
                      {MONTHS[nextForecast.period_month - 1]} forecast
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>{fmtKr(nextForecast.revenue_forecast)}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtPct(nextForecast.margin_forecast)} margin</div>
                  </div>
                )}
              </div>
            </div>

            {/* Row 4 — Quick actions */}
            <div className="quick-actions">
              {[
                { label: '+ Upload invoice',    href: '/invoices',     icon: '', desc: 'AI extracts data automatically' },
                { label: 'Log covers',          href: '/covers',       icon: '', desc: `Today's guests and revenue` },
                { label: 'Ask the AI',          href: '/notebook',     icon: '', desc: 'Analyse your data instantly' },
                { label: 'View forecast',       href: '/forecast',     icon: '', desc: 'Next month prediction' },
              ].map(a => (
                <a key={a.href} href={a.href} style={{ textDecoration: 'none', background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ fontSize: 20 }}>{a.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{a.label}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{a.desc}</div>
                  </div>
                </a>
              ))}
            </div>
          </>
        )}
      </div>

      {/* AI panel — sees the current business KPIs and chart data */}
      <AskAI
        page="dashboard"
        context={selected ? [
          `Business: ${selected.name}${selected.city ? ', ' + selected.city : ''}`,
          `This month revenue: ${fmtKr(thisMonthTracker?.revenue ?? 0)}`,
          `This month net profit: ${fmtKr(thisMonthTracker?.net_profit ?? 0)}`,
          `Staff cost: ${fmtKr(selected.staff_cost)} (${liveStaffPct !== null ? fmtPct(liveStaffPct) + ' live avg' : fmtPct(selected.staffPct)} of revenue, target ${fmtPct(selected.target_staff_pct)})`,
          liveStaffPct !== null ? `Live staff cost %: ${fmtPct(liveStaffPct)} avg this month · ${daysOverTarget} days over ${fmtPct(targetStaffPct)} target` : '',
          `Food cost: ${fmtKr(selected.food_cost)} (${fmtPct(selected.foodPct)} of revenue, target ${fmtPct(selected.target_food_pct)})`,
          `Net margin: ${fmtPct(selected.margin)} (target ${fmtPct(selected.target_margin_pct)})`,
          `YTD revenue: ${fmtKr(ytdRevenue)}`,
          `YTD profit: ${fmtKr(ytdProfit)}`,
          staffData ? `Shifts logged this month: ${staffData.shifts_logged}, hours: ${staffData.logged_hours}` : '',
          chartData.length > 0 ? `Monthly revenue (this year): ${chartData.map(r => `${MONTHS[r.period_month-1]}: ${fmtKr(r.revenue)}`).join(', ')}` : '',
          topDepts.length > 0 ? `Top departments by cost: ${topDepts.map(([name, d]: any) => `${name}: ${fmtKr(d.cost)}`).join(', ')}` : '',
        ].filter(Boolean).join('\n') : 'No business selected'}
      />
    </AppShell>
  )
}
