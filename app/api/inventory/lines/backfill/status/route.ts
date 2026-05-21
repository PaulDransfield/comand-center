// app/api/inventory/lines/backfill/status/route.ts
//
// Read-side companion to the kick endpoint one directory up. Returns
// the latest inventory_backfill_state row for the given business so
// the admin UI / future page can poll for live progress while the
// background worker grinds.
//
// Returns 404 if no state row exists yet (i.e. no backfill ever run
// for this business). 'completed' / 'failed' rows are also returned —
// the UI is responsible for displaying them as final states and
// stopping the poll.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export async function GET(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = (url.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: row, error } = await db
    .from('inventory_backfill_state')
    .select('status, progress, error_message, started_at, finished_at, updated_at')
    .eq('business_id', businessId)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ status: 'not_started' }, {
      status: 404,
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  }

  return NextResponse.json(row, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
