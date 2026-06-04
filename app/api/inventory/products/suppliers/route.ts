// app/api/inventory/products/suppliers/route.ts
//
// GET — distinct default_supplier_name values across the business's
// active product catalogue. Drives the supplier filter in the recipe
// ingredient picker.
//
// ?business_id=<uuid>

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Walk all active products and collect distinct supplier names + counts
  // in memory. Paginate so businesses with >1000 products still work.
  const counts = new Map<string, number>()
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('products')
      .select('default_supplier_name')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .not('default_supplier_name', 'is', null)
      .order('id')
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    for (const row of data) {
      const name = (row.default_supplier_name ?? '').trim()
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    if (data.length < 1000) break
    from += 1000
  }

  const suppliers = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'sv'))

  return NextResponse.json({ suppliers }, { headers: { 'Cache-Control': 'no-store' } })
}
