// app/api/me/broken-integrations/route.ts
//
// GET → list every integration in the user's org with status
// needs_reauth / error. Used by the AppShell banner to alert owners
// without making them dig through /integrations.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ broken: [] })   // unauth: silently empty so AppShell doesn't error on login screens

  const db = createAdminClient()
  const { data, error } = await db
    .from('integrations')
    .select('id, business_id, provider, status, last_error, business:businesses(name)')
    .eq('org_id', auth.orgId)
    .in('status', ['needs_reauth', 'error'])
    .limit(20)
  if (error) return NextResponse.json({ broken: [] })

  return NextResponse.json({
    broken: (data ?? []).map((r: any) => ({
      id:            r.id,
      business_id:   r.business_id,
      business_name: (r.business as any)?.name ?? '(unnamed)',
      provider:      r.provider,
      status:        r.status,
      last_error:    r.last_error?.slice(0, 200) ?? null,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
