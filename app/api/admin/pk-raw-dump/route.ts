// @ts-nocheck
// app/api/admin/pk-raw-dump/route.ts
//
// TEMPORARY — delete after VAT investigation (Task #83).
//
// Pulls ONE Personalkollen sale and returns the raw, unmapped object.
// Point: reveal every field name PK actually returns, including any Swedish-
// language fields (moms, moms_procent, netto, rabat, ...) that our current
// adapter ignores. Compare against PK's dashboard figures to figure out which
// field matches "Försäljning ex. moms".
//
// GET /api/admin/pk-raw-dump?integration_id=...&secret=ADMIN_SECRET
//     [&from=YYYY-MM-DD&to=YYYY-MM-DD]

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/integrations/encryption'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') ?? req.headers.get('x-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const integrationId = req.nextUrl.searchParams.get('integration_id')
  const from = req.nextUrl.searchParams.get('from') ?? '2026-04-17'
  const to   = req.nextUrl.searchParams.get('to')   ?? '2026-04-18'

  const db = createAdminClient()

  let integ
  if (integrationId) {
    const { data } = await db.from('integrations')
      .select('id, credentials_enc, provider')
      .eq('id', integrationId).maybeSingle()
    integ = data
  } else {
    // Default to first connected PK integration
    const { data } = await db.from('integrations')
      .select('id, credentials_enc, provider')
      .eq('provider', 'personalkollen')
      .eq('status', 'connected')
      .limit(1).maybeSingle()
    integ = data
  }
  if (!integ) return NextResponse.json({ error: 'no PK integration found' }, { status: 404 })

  const token = decrypt(integ.credentials_enc)

  // Fetch raw sales — no mapping. Up to 5 sales to see variance across order types.
  const url = `https://personalkollen.se/api/sales/?sale_time__gte=${from}&sale_time__lte=${to}&page_size=5`
  const r = await fetch(url, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  })
  if (!r.ok) {
    const text = await r.text()
    return NextResponse.json({ error: `PK API ${r.status}`, body: text.slice(0, 500) }, { status: 500 })
  }
  const json: any = await r.json()
  const raw = json?.results ?? []

  // For each sale, also fetch the first item detail to see item-level fields.
  const samples = []
  for (const s of raw.slice(0, 5)) {
    const itemDetails: any[] = []
    for (const item of (s.items ?? []).slice(0, 3)) {
      if (!item.url) { itemDetails.push({ item, note: 'no url' }); continue }
      try {
        const ir = await fetch(item.url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } })
        if (ir.ok) itemDetails.push(await ir.json())
        else       itemDetails.push({ item, err: ir.status })
      } catch (e: any) { itemDetails.push({ item, err: e.message }) }
    }
    samples.push({ sale: s, item_details: itemDetails })
  }

  return NextResponse.json({
    fetched_from: url,
    total_returned: raw.length,
    sample_field_names: Object.keys(raw[0] ?? {}),
    sample_payment_field_names: Object.keys(raw[0]?.payments?.[0] ?? {}),
    sample_item_field_names_stub: Object.keys(raw[0]?.items?.[0] ?? {}),
    samples,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
