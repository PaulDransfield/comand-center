// @ts-nocheck
// app/api/admin/diagnose/route.ts
// TEMPORARY — diagnoses what Personalkollen sales API returns for connected integrations.
// Remove after investigation is complete.
// Call: GET /api/admin/diagnose?secret=commandcenter123

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'

export const dynamic    = 'force-dynamic'
export const maxDuration = 30

const BASE = 'https://personalkollen.se/api'

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== 'commandcenter123') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  // Get all connected Personalkollen integrations
  const { data: integrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, credentials_enc')
    .eq('provider', 'personalkollen')
    .eq('status', 'connected')

  if (!integrations?.length) {
    return NextResponse.json({ error: 'No connected Personalkollen integrations found' })
  }

  const results = []

  for (const integ of integrations) {
    const token = decrypt(integ.credentials_enc)
    if (!token) { results.push({ integration_id: integ.id, error: 'Could not decrypt credentials' }); continue }

    const headers = { Authorization: `Token ${token}`, Accept: 'application/json' }

    // Check 1: How many sales total does the API have?
    const salesCountRes = await fetch(`${BASE}/sales/?limit=1`, { headers }).catch(() => null)
    const salesCountData = salesCountRes?.ok ? await salesCountRes.json() : null

    // Check 2: Get a sample of recent sales (last 30 days)
    const to   = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const sampleRes = await fetch(`${BASE}/sales/?sale_time__gte=${from}&sale_time__lte=${to}&limit=3`, { headers }).catch(() => null)
    const sampleData = sampleRes?.ok ? await sampleRes.json() : null

    // Check 3: What does a raw sale look like? (field names)
    const rawSale = sampleData?.results?.[0] ?? null

    results.push({
      integration_id:   integ.id,
      business_id:      integ.business_id,
      sales_api_status: salesCountRes?.status ?? 'failed',
      total_sales_in_pk: salesCountData?.count ?? 0,
      sales_last_30d:   sampleData?.count ?? 0,
      raw_sale_fields:  rawSale ? Object.keys(rawSale) : [],
      sale_time_sample: rawSale?.sale_time ?? rawSale?.time ?? rawSale?.date ?? null,
      payments_sample:  rawSale?.payments?.slice(0, 1) ?? null,
      amount_sample:    rawSale?.amount ?? null,
    })
  }

  return NextResponse.json({ integrations: integrations.length, results })
}
