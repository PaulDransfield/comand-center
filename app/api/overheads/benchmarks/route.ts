// app/api/overheads/benchmarks/route.ts
// Returns the industry benchmark row per subcategory so /overheads can
// render "your X% vs median Y% from N restaurants" chips.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { requireFinanceAccess } from '@/lib/auth/require-role'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden

  const db = createAdminClient()
  const { data, error } = await db
    .from('industry_benchmarks')
    .select('subcategory, sample_size, median_kr, p25_kr, p75_kr, generated_at')
    .order('median_kr', { ascending: false })

  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      return NextResponse.json({ benchmarks: [], empty: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ benchmarks: data ?? [] })
}
