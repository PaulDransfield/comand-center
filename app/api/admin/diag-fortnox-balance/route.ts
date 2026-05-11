// app/api/admin/diag-fortnox-balance/route.ts
//
// One-shot diagnostic: call Fortnox /3/accounts/{n}?financialyear={fyId}
// for a list of bank accounts and dump the raw response. Lets us see
// EXACTLY what Fortnox returns for BalanceCarriedForward / OpeningBalance
// / Year etc. so we know which field actually carries the year-start
// balance for this account type.
//
// Auth: session-only (no admin secret yet — this is a read-only diag).
// GET /api/admin/diag-fortnox-balance?business_id=X[&accounts=1910,1930,1940]
//
// Default accounts: 1910,1912,1914,1915,1930

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { fetchFinancialYears } from '@/lib/fortnox/api/financial-years'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'
export const maxDuration     = 30

const FORTNOX_API = 'https://api.fortnox.se/3'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = String(req.nextUrl.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const accountsParam = String(req.nextUrl.searchParams.get('accounts') ?? '1910,1912,1914,1915,1930').trim()
  const accounts = accountsParam.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id,org_id').eq('id', businessId).eq('org_id', auth.orgId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // Step 1: token
  let token: string | null
  try { token = await getFreshFortnoxAccessToken(db, auth.orgId, businessId) }
  catch (e: any) { return NextResponse.json({ error: 'token_refresh_failed', detail: e?.message }, { status: 502 }) }
  if (!token) return NextResponse.json({ error: 'no_fortnox_connection' }, { status: 404 })

  // Step 2: fiscal years
  let years
  try { ({ years } = await fetchFinancialYears(token)) }
  catch (e: any) { return NextResponse.json({ error: 'fiscal_years_fetch_failed', detail: e?.message }, { status: 502 }) }

  const todayIso = new Date().toISOString().slice(0, 10)
  const currentYear = years.find(y => y.FromDate <= todayIso && y.ToDate >= todayIso) ?? years[0]

  // Step 3: per-account fetch — return raw JSON for each
  const results: any[] = []
  for (const account of accounts) {
    const url = `${FORTNOX_API}/accounts/${account}?financialyear=${currentYear.Id}`
    let httpStatus = 0
    let body: any = null
    let errorText: string | null = null
    try {
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      })
      httpStatus = r.status
      const text = await r.text()
      try { body = JSON.parse(text) } catch { errorText = text.slice(0, 500) }
    } catch (e: any) {
      errorText = String(e?.message ?? e)
    }
    results.push({
      account,
      url,
      http_status:        httpStatus,
      raw_response:       body,
      error_text:         errorText,
      // Extract candidate fields so we can see what's populated
      extracted: body?.Account ? {
        Number:                 body.Account.Number,
        Description:            body.Account.Description,
        Active:                 body.Account.Active,
        Year:                   body.Account.Year,
        BalanceCarriedForward:  body.Account.BalanceCarriedForward,
        BalanceBroughtForward:  body.Account.BalanceBroughtForward,
        OpeningBalance:         body.Account.OpeningBalance,
        Balance:                body.Account.Balance,
        Project:                body.Account.Project,
        CostCenter:             body.Account.CostCenter,
        SRU:                    body.Account.SRU,
        VATCode:                body.Account.VATCode,
      } : null,
    })
  }

  return NextResponse.json({
    business_id:       businessId,
    fiscal_years_seen: years.map(y => ({ id: y.Id, from: y.FromDate, to: y.ToDate })),
    current_year_id:   currentYear.Id,
    accounts_probed:   accounts,
    results,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
