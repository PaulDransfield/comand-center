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

const isMissingTable = (err: any) => {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('could not find the table')
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
  if (error) {
    // Missing table = migration not run. Return a friendly empty response so
    // the admin UI can render a helpful message instead of a raw 500.
    if (isMissingTable(error)) {
      return NextResponse.json({
        rows: [],
        _table_missing: true,
        _hint: 'Run sql/M010-admin-audit-log.sql in Supabase SQL Editor to enable the audit log.',
      })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  // Enrich with org names — skip the lookup entirely if no rows reference an org
  // (the `.in('id', [])` call on an empty array can itself throw on some
  // PostgREST versions, and would waste a round trip anyway).
  const orgIds = [...new Set((rows ?? []).map((r: any) => r.org_id).filter(Boolean))]
  const orgMap: Record<string, string> = {}
  if (orgIds.length > 0) {
    const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgMap[o.id] = o.name
  }

  const enriched = (rows ?? []).map((r: any) => ({
    ...r,
    org_name: r.org_id ? (orgMap[r.org_id] ?? r.org_id.slice(0, 8)) : null,
  }))

  return NextResponse.json({ rows: enriched })
}
