// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

async function getAuth(req: NextRequest) {
  const raw = req.cookies.get('sb-llzmixkrysduztsvmfzi-auth-token')?.value
  if (!raw) return null
  try {
    let token = raw
    try { const d = decodeURIComponent(raw); const p = JSON.parse(d); token = Array.isArray(p) ? p[0] : (p.access_token ?? raw) } catch {}
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(token)
    if (!user) return null
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', user.id).single()
    return m ? { userId: user.id, orgId: m.org_id } : null
  } catch { return null }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const params = new URL(req.url).searchParams
  const year       = parseInt(params.get('year') ?? String(new Date().getFullYear()))
  const businessId = params.get('business_id')
  const db   = createAdminClient()

  // Get all staff logs for this year — actual worked shifts only (not scheduled)
  let query = db
    .from('staff_logs')
    .select('period_month, staff_name, staff_group, hours_worked, cost_actual, shift_date')
    .eq('org_id', auth.orgId)
    .eq('period_year', year)
    .gt('cost_actual', 0)

  if (businessId) query = query.eq('business_id', businessId)

  const { data: logs } = await query

  if (!logs?.length) return NextResponse.json({ departments: [], monthly: [], totals: {}, staff: [] })

  // Get unique departments
  const deptSet = new Set<string>()
  for (const l of logs) deptSet.add(l.staff_group ?? 'Unknown')
  const departments = Array.from(deptSet).sort()

  // Build monthly breakdown
  const monthlyMap: Record<string, any> = {}
  const totals: Record<string, { cost: number; hours: number; staff: Set<string> }> = {}
  const staffMap: Record<string, { name: string; group: string; cost: number; hours: number; shifts: number }> = {}

  for (const l of logs) {
    const month = l.period_month
    const dept  = l.staff_group ?? 'Unknown'
    const cost  = Number(l.cost_actual  ?? 0)
    const hours = Number(l.hours_worked ?? 0)
    const name  = l.staff_name ?? 'Unknown'

    // Monthly
    const key = `${year}-${month}`
    if (!monthlyMap[key]) monthlyMap[key] = { year, month }
    if (!monthlyMap[key][dept]) monthlyMap[key][dept] = { cost: 0, hours: 0 }
    monthlyMap[key][dept].cost  += cost
    monthlyMap[key][dept].hours += hours

    // Totals
    if (!totals[dept]) totals[dept] = { cost: 0, hours: 0, staff: new Set() }
    totals[dept].cost  += cost
    totals[dept].hours += hours
    totals[dept].staff.add(name)

    // Per staff
    const sk = `${name}__${dept}`
    if (!staffMap[sk]) staffMap[sk] = { name, group: dept, cost: 0, hours: 0, shifts: 0 }
    staffMap[sk].cost   += cost
    staffMap[sk].hours  += hours
    staffMap[sk].shifts += 1
  }

  // Sort monthly
  const monthly = Object.values(monthlyMap).sort((a: any, b: any) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month
  )

  // Serialise totals (convert Set to count)
  const totalsOut: Record<string, any> = {}
  for (const [dept, data] of Object.entries(totals)) {
    totalsOut[dept] = { cost: data.cost, hours: data.hours, staff: data.staff.size }
  }

  const staff = Object.values(staffMap).map(s => ({
    ...s,
    cost:  Math.round(s.cost),
    hours: Math.round(s.hours * 10) / 10,
  }))

  return NextResponse.json({ departments, monthly, totals: totalsOut, staff })
}
