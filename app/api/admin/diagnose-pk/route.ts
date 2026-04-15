// @ts-nocheck
// app/api/admin/diagnose-pk/route.ts
// TEMPORARY — checks whether Personalkollen /sales/ returns POS data for connected integrations.
// Remove after investigation is complete.
// Call: GET /api/admin/diagnose-pk?secret=commandcenter123

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'

export const dynamic    = 'force-dynamic'
export const maxDuration = 30

const BASE = 'https://personalkollen.se/api'

async function pkFetch(endpoint: string, token: string) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) return { error: res.status, statusText: res.statusText }
  return res.json()
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== 'commandcenter123') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  // Get all Personalkollen integrations
  const { data: integrations } = await db
    .from('integrations')
    .select('id, business_id, credentials_enc, status, last_sync_at')
    .eq('provider', 'personalkollen')
    .eq('status', 'connected')

  if (!integrations?.length) {
    return NextResponse.json({ error: 'No connected Personalkollen integrations found' })
  }

  const today     = new Date().toISOString().slice(0, 10)
  const monthAgo  = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const yearAgo   = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)

  const results = []

  for (const integ of integrations) {
    const token = decrypt(integ.credentials_enc)
    if (!token) { results.push({ integration_id: integ.id, error: 'Decrypt failed' }); continue }

    // 1. List all workplaces — confirms POS workplaces are visible
    const workplaces = await pkFetch('/workplaces/', token)

    // 2. Check /sales/ for last 30 days
    const sales30 = await pkFetch(`/sales/?sale_time__gte=${monthAgo}&sale_time__lte=${today}`, token)

    // 3. Check /sales/ for last 365 days (wider net)
    const sales365 = await pkFetch(`/sales/?sale_time__gte=${yearAgo}&sale_time__lte=${today}`, token)

    // 4. Check /sales/ with no date filter (first page only)
    const salesAll = await pkFetch('/sales/?page_size=5', token)

    results.push({
      integration_id:   integ.id,
      business_id:      integ.business_id,
      last_sync_at:     integ.last_sync_at,

      workplaces: {
        count:    workplaces.results?.length ?? workplaces.error ?? 0,
        // Show name + description + whether it has a POS key
        list:     (workplaces.results ?? []).map((w: any) => ({
          name:            w.description,
          id:              w.short_identifier,
          url:             w.url,
          // Personalkollen returns POS connection details if available
          pos_provider:    w.pos_provider ?? w.cash_register_provider ?? null,
          pos_status:      w.pos_status ?? w.cash_register_status ?? null,
        })),
      },

      sales_last_30_days: {
        count:       sales30.results?.length ?? 0,
        total_pages: sales30.count ?? 0,
        sample:      (sales30.results ?? []).slice(0, 3).map((s: any) => ({
          uid:          s.uid,
          sale_time:    s.sale_time,
          workplace:    s.workplace,
          payments:     s.payments,
          num_guests:   s.number_of_guests,
          is_take_away: s.is_take_away,
        })),
      },

      sales_last_365_days: {
        total_count: sales365.count ?? 0,
        page_count:  sales365.results?.length ?? 0,
      },

      sales_all_no_filter: {
        total_count: salesAll.count ?? 0,
        page_count:  salesAll.results?.length ?? 0,
        sample:      (salesAll.results ?? []).slice(0, 2),
      },
    })
  }

  return NextResponse.json({ integrations_checked: results.length, results })
}
