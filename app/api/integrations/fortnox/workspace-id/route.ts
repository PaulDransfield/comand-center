// app/api/integrations/fortnox/workspace-id/route.ts
//
// GET  ?business_id=… → returns { workspace_id }
// POST { business_id, pasted } → extracts hex from pasted URL and saves
//
// No Fortnox API exposes the workspace UUID — owner pastes the URL from
// their browser address bar (e.g. https://apps2.fortnox.se/app/{hex}/lf/…)
// once. We regex out the 32-hex segment and save it on the integration.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { extractWorkspaceId } from '@/lib/fortnox/web-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const businessId = String(new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data } = await db
    .from('integrations')
    .select('fortnox_workspace_id, status')
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .maybeSingle()
  return NextResponse.json({
    workspace_id: data?.fortnox_workspace_id ?? null,
    connected:    data?.status === 'connected',
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const pasted     = String(body.pasted     ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!pasted)     return NextResponse.json({ error: 'pasted URL required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const workspaceId = extractWorkspaceId(pasted)
  if (!workspaceId) {
    return NextResponse.json({
      error: 'Could not find a workspace id in that URL. It should look like https://apps2.fortnox.se/app/<32-hex-chars>/lf/…',
    }, { status: 400 })
  }

  const db = createAdminClient()
  const { data, error } = await db
    .from('integrations')
    .update({ fortnox_workspace_id: workspaceId })
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .select('id, fortnox_workspace_id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, workspace_id: data.fortnox_workspace_id })
}
