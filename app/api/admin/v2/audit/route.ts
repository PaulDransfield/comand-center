// app/api/admin/v2/audit/route.ts
//
// Admin v2 — audit log explorer (PR 8). Read-only.
//
// GET supports filtering by:
//   - action      (exact match against admin_audit_log.action)
//   - org_id      (exact match)
//   - actor       (substring, case-insensitive)
//   - surface     ('admin_v1' | 'admin_v2'; filters payload->>'surface')
//   - from / to   (ISO date strings, applied to created_at)
//
// Pagination: keyset on (created_at DESC, id DESC). Cursor is the
// base64 JSON of the last row's { created_at, id }. Why not OFFSET:
// admin_audit_log is append-only and grows linearly forever; offset
// pagination would scan + skip more rows on every "load more" click.
// Keyset is O(log n) per page regardless of depth.
//
// Per-page cap = 200; default = 50. CSV export goes through the
// sibling /export route (no cursor, hard cap 10 000 rows).
//
// Org-name enrichment is one extra round-trip — same pattern the v1
// audit-log route used. No tenant boundary issues because the admin
// surface is global.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 200

interface Cursor { created_at: string; id: string }

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof parsed?.created_at === 'string' && typeof parsed?.id === 'string') {
      return parsed
    }
  } catch {}
  return null
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

function isMissingTable(err: any): boolean {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('could not find the table')
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  const url    = new URL(req.url)
  const action  = url.searchParams.get('action')
  const orgId   = url.searchParams.get('org_id')
  const actor   = url.searchParams.get('actor')
  const surface = url.searchParams.get('surface')           // 'admin_v1' | 'admin_v2' | null
  const from    = url.searchParams.get('from')              // ISO datetime
  const to      = url.searchParams.get('to')                // ISO datetime
  const rawLim  = parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10)
  const limit   = Math.max(1, Math.min(isNaN(rawLim) ? DEFAULT_LIMIT : rawLim, MAX_LIMIT))
  const cursor  = decodeCursor(url.searchParams.get('cursor'))

  const db = createAdminClient()

  let q = db.from('admin_audit_log')
            .select('id, created_at, actor, action, org_id, integration_id, target_type, target_id, payload, ip_address, user_agent')
            .order('created_at', { ascending: false })
            .order('id',         { ascending: false })
            .limit(limit + 1)   // +1 to detect "has more"

  if (action) q = q.eq('action', action)
  if (orgId)  q = q.eq('org_id', orgId)
  if (actor)  q = q.ilike('actor', `%${actor}%`)
  if (from)   q = q.gte('created_at', from)
  if (to)     q = q.lte('created_at', to)

  // Surface filter: admin_v2 = explicit payload.surface flag (from PR 6 onwards).
  // admin_v1 = absence of that flag — payload->>'surface' IS NULL OR != 'admin_v2'.
  if (surface === 'admin_v2') {
    q = q.eq('payload->>surface', 'admin_v2')
  } else if (surface === 'admin_v1') {
    q = q.or('payload->>surface.is.null,payload->>surface.neq.admin_v2')
  }

  // Keyset cursor: rows strictly older than the cursor row.
  // PostgREST row-constructor inequality via or(): created_at < c.created_at
  // OR (created_at = c.created_at AND id < c.id).
  if (cursor) {
    q = q.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
  }

  const { data, error } = await q
  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({
        rows: [], next_cursor: null, has_more: false, table_missing: true,
        note: 'admin_audit_log table missing — run sql/M010-admin-audit-log.sql in Supabase SQL Editor.',
      }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  const rowsAll  = data ?? []
  const has_more = rowsAll.length > limit
  const rows     = has_more ? rowsAll.slice(0, limit) : rowsAll

  // Enrich with org name. Skip the round-trip if no rows reference an org.
  const orgIds = [...new Set(rows.map((r: any) => r.org_id).filter(Boolean))] as string[]
  const orgMap: Record<string, string> = {}
  if (orgIds.length > 0) {
    const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgMap[o.id] = o.name
  }

  const enriched = rows.map((r: any) => ({
    ...r,
    org_name: r.org_id ? (orgMap[r.org_id] ?? null) : null,
    surface:  r?.payload?.surface ?? 'admin_v1',
  }))

  const next_cursor = has_more
    ? encodeCursor({ created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id })
    : null

  return NextResponse.json({
    rows:        enriched,
    has_more,
    next_cursor,
    page_size:   limit,
    table_missing: false,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
