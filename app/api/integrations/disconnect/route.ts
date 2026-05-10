// app/api/integrations/disconnect/route.ts
//
// Owner-facing disconnect for any integration. Replaces the broken
// client-side Supabase UPDATE on /integrations page which:
//   1. Used the user's RLS-bound client (can't write to integrations)
//   2. Had no business_id filter (would attempt to disconnect every
//      same-provider integration across the org's businesses)
//   3. Had no error handling (silent failure → "I clicked disconnect
//      but nothing happened" UX, observed twice today)
//
// Inputs (POST JSON body):
//   - provider:    required ('fortnox', 'personalkollen', 'caspeco', etc.)
//   - business_id: optional. If supplied, scopes to that one integration.
//                  If omitted, disconnects all of the org's integrations
//                  for the named provider (matches old per-provider UI).
//
// Side effects:
//   - integrations.status = 'disconnected'
//   - credentials_enc = NULL  (revokes the OAuth token / API key locally)
//   - For Fortnox specifically: ALSO clears fortnox_backfill_state so a
//     reconnect doesn't try to resume a stale backfill from the old token
//
// Does NOT revoke at the upstream provider (Fortnox / Caspeco / PK). The
// customer can revoke from their provider's dashboard if they want full
// teardown. We just stop USING the credentials.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const provider   = String(body?.provider ?? '').trim()
  const businessId = body?.business_id ? String(body.business_id).trim() : null

  if (!provider) {
    return NextResponse.json({ error: 'provider required' }, { status: 400 })
  }

  const db = createAdminClient()

  // Find the integration(s) we're about to disconnect — used both for
  // ownership verification AND for any provider-specific cleanup
  // (Fortnox needs its backfill_state cleared).
  let q = db
    .from('integrations')
    .select('id, business_id, provider')
    .eq('org_id', auth.orgId)
    .eq('provider', provider)
  if (businessId) q = q.eq('business_id', businessId)
  const { data: rows, error: lookupErr } = await q
  if (lookupErr) {
    return NextResponse.json({ error: `Lookup failed: ${lookupErr.message}` }, { status: 500 })
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({
      ok:      true,
      message: 'Nothing to disconnect (no matching integration).',
      count:   0,
    })
  }

  // Provider-specific pre-cleanup
  if (provider === 'fortnox') {
    const integrationIds = rows.map(r => r.id)
    await db.from('fortnox_backfill_state').delete().in('integration_id', integrationIds)
  }

  // The actual disconnect. Service-role client → bypasses RLS that was
  // blocking the user-side UPDATE.
  let updateQ = db
    .from('integrations')
    .update({
      status:               'disconnected',
      credentials_enc:      null,
      // Reset Fortnox backfill state on the integrations row too, so a
      // reconnect doesn't see stale "completed" status from a prior token.
      backfill_status:      'idle',
      backfill_progress:    null,
      backfill_error:       null,
      backfill_started_at:  null,
      backfill_finished_at: null,
      last_error:           null,
      updated_at:           new Date().toISOString(),
    }, { count: 'exact' })
    .eq('org_id', auth.orgId)
    .eq('provider', provider)
  if (businessId) updateQ = updateQ.eq('business_id', businessId)
  const { error: updErr, count } = await updateQ

  if (updErr) {
    return NextResponse.json({ error: `Disconnect failed: ${updErr.message}` }, { status: 500 })
  }

  return NextResponse.json({
    ok:           true,
    provider,
    business_id:  businessId,
    count:        count ?? rows.length,
    integration_ids: rows.map(r => r.id),
  })
}
