// @ts-nocheck
// app/api/admin/audit-log/route.ts
// Returns the last N rows of admin_audit_log, optionally filtered.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const orgId  = searchParams.get('org_id')
  const action = searchParams.get('action')
  const limit  = Math.min(parseInt(searchParams.get('limit') || '200'), 500)

  const db = createAdminClient()
  let q = db.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(limit)
  if (orgId)  q = q.eq('org_id', orgId)
  if (action) q = q.eq('action', action)

  const { data: rows, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Enrich with org names
  const orgIds = [...new Set((rows ?? []).map((r: any) => r.org_id).filter(Boolean))]
  const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
  const orgMap: Record<string, string> = {}
  for (const o of orgs ?? []) orgMap[o.id] = o.name

  const enriched = (rows ?? []).map((r: any) => ({
    ...r,
    org_name: r.org_id ? (orgMap[r.org_id] ?? r.org_id.slice(0, 8)) : null,
  }))

  return NextResponse.json({ rows: enriched })
}
