// app/api/vat/route.ts
// Returns VAT breakdown for a business and period.
// Swedish VAT rates: 25% (alcohol/goods), 12% (food), 6% (rare)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  const cookieName  = 'sb-llzmixkrysduztsvmfzi-auth-token'
  const cookieValue = req.cookies.get(cookieName)?.value
  if (!cookieValue) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let userId = '', orgId = ''
  try {
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(accessToken)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    userId = user.id
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', userId).single()
    if (!m) return NextResponse.json({ error: 'No org' }, { status: 404 })
    orgId = m.org_id
  } catch { return NextResponse.json({ error: 'Auth failed' }, { status: 401 }) }

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const year  = parseInt(searchParams.get('year')  ?? String(new Date().getFullYear()))
  const month = parseInt(searchParams.get('month') ?? String(new Date().getMonth() + 1))

  const db = createAdminClient()

  // Get tracker data for this period
  let q = db.from('tracker_data')
    .select('business_id, revenue, staff_cost, food_cost, rent_cost, other_cost')
    .eq('org_id', orgId)
    .eq('period_year', year)
    .eq('period_month', month)

  if (businessId) q = q.eq('business_id', businessId)

  const { data: rows } = await q

  if (!rows?.length) return NextResponse.json([])

  const round = (n: number) => Math.round(n * 100) / 100

  const results = rows.map(row => {
    const revenue = Number(row.revenue ?? 0)

    // Swedish restaurant typical split:
    // ~45% alcohol/high-margin items at 25% VAT
    // ~55% food/soft drinks at 12% VAT
    const gross_25 = revenue * 0.45
    const gross_12 = revenue * 0.55

    const net_25 = gross_25 / 1.25
    const net_12 = gross_12 / 1.12

    const vat_out_25 = gross_25 - net_25
    const vat_out_12 = gross_12 - net_12

    // Input VAT on purchases
    const food  = Number(row.food_cost  ?? 0)
    const other = Number(row.rent_cost  ?? 0) + Number(row.other_cost ?? 0)

    const vat_in_12 = (food / 1.12) * 0.12
    const vat_in_25 = (other / 1.25) * 0.25 * 0.3

    const vat_payable = vat_out_25 + vat_out_12 - vat_in_25 - vat_in_12

    return {
      business_id:      row.business_id,
      period_year:      year,
      period_month:     month,
      // Net revenue (ex-VAT) by rate
      revenue_25_net:   round(net_25),
      revenue_12_net:   round(net_12),
      revenue_total_net: round(net_25 + net_12),
      // VAT collected on sales
      vat_collected_25: round(vat_out_25),
      vat_collected_12: round(vat_out_12),
      vat_collected:    round(vat_out_25 + vat_out_12),
      // VAT paid on purchases (input VAT)
      vat_paid_25:      round(vat_in_25),
      vat_paid_12:      round(vat_in_12),
      vat_paid:         round(vat_in_25 + vat_in_12),
      // Net payable to Skatteverket
      vat_payable:      round(vat_payable),
      source:           'estimated',
      note:             'Estimated 45/55 split. Connect Fortnox for exact account-level figures.',
    }
  })

  return NextResponse.json(results)
}
