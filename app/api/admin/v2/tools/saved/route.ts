// app/api/admin/v2/tools/saved/route.ts
//
// Saved investigations from the Tools tab.
//
// GET  → list (most-recently-used first; optional ?org_id= filter)
// POST → create { label, query, notes?, org_id? }
//
// "Bumping" an existing entry's last_used_at on re-run is handled by
// the SQL runner itself (PR 9) once a saved_query_id query param is
// passed in. PR 10 just provides the catalogue.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

const MAX_LABEL = 120
const MAX_QUERY = 50_000
const MAX_NOTES = 4_000

const isMissingTable = (err: any) => {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('could not find the table')
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  const url   = new URL(req.url)
  const orgId = url.searchParams.get('org_id')

  const db = createAdminClient()

  let q = db.from('admin_saved_queries')
            .select('id, label, query, notes, org_id, created_by, created_at, last_used_at, run_count')
            .order('last_used_at', { ascending: false, nullsFirst: false })
            .order('created_at',   { ascending: false })
            .limit(200)
  if (orgId) q = q.eq('org_id', orgId)

  const { data, error } = await q
  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({
        items: [], table_missing: true,
        note: 'admin_saved_queries table missing — run M038-ADMIN-NOTES-AND-SAVED-QUERIES.sql.',
      }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  // Org-name enrichment for the entries that have one.
  const orgIds = [...new Set((data ?? []).map((r: any) => r.org_id).filter(Boolean))] as string[]
  const orgMap: Record<string, string> = {}
  if (orgIds.length) {
    const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgMap[o.id] = o.name
  }
  const enriched = (data ?? []).map((r: any) => ({ ...r, org_name: r.org_id ? (orgMap[r.org_id] ?? null) : null }))

  return NextResponse.json({ items: enriched, table_missing: false }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  const label = typeof body?.label === 'string' ? body.label.trim() : ''
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : null
  const orgId = typeof body?.org_id === 'string' && body.org_id ? body.org_id : null

  if (!label)                       return NextResponse.json({ error: 'label is required' }, { status: 400 })
  if (label.length > MAX_LABEL)     return NextResponse.json({ error: `label exceeds ${MAX_LABEL} characters` }, { status: 400 })
  if (!query)                       return NextResponse.json({ error: 'query is required' }, { status: 400 })
  if (query.length > MAX_QUERY)     return NextResponse.json({ error: `query exceeds ${MAX_QUERY} characters` }, { status: 400 })
  if (notes && notes.length > MAX_NOTES) return NextResponse.json({ error: `notes exceeds ${MAX_NOTES} characters` }, { status: 400 })

  const db = createAdminClient()

  // Verify the org exists if one was supplied.
  if (orgId) {
    const { data: org, error: orgErr } = await db.from('organisations').select('id').eq('id', orgId).maybeSingle()
    if (orgErr) return NextResponse.json({ error: orgErr.message }, { status: 500 })
    if (!org)   return NextResponse.json({ error: 'org_id not found' }, { status: 400 })
  }

  const { data: row, error } = await db
    .from('admin_saved_queries')
    .insert({ label, query, notes, org_id: orgId })
    .select('id, label, query, notes, org_id, created_by, created_at, last_used_at, run_count')
    .single()
  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({
        error: 'admin_saved_queries table missing — run M038-ADMIN-NOTES-AND-SAVED-QUERIES.sql.',
        kind:  'table_missing',
      }, { status: 503 })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  await recordAdminAction(db as any, {
    action:     ADMIN_ACTIONS.INVESTIGATION_SAVE,
    orgId:      orgId ?? null,
    targetType: orgId ? 'org' : 'system',
    targetId:   orgId ?? null,
    payload:    { surface: 'admin_v2', saved_query_id: row.id, label, query_chars: query.length, has_org: !!orgId },
    req,
  })

  return NextResponse.json({ item: row }, { status: 201 })
}
