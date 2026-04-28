// app/api/admin/v2/audit/export/route.ts
//
// CSV export of filtered admin_audit_log rows for the Admin v2 Audit tab.
//
// Same filter shape as the sibling /audit GET (action, org_id, actor,
// surface, from, to). NO cursor — exports the entire matching slice
// in one response, hard-capped at 10 000 rows so a single click can't
// pull a multi-GB blob into the browser. The cap is generous: at the
// volume admin actions land (single-digit per day), 10k rows is
// ~3 years of history.
//
// Response: text/csv with Content-Disposition attachment so browsers
// trigger the download dialog instead of rendering. Includes a
// generated-at timestamp in the filename for reproducibility.
//
// Why no streaming: the row cap makes the response ~2-5 MB max, well
// inside the Vercel response budget. Streaming would add complexity
// (manual ReadableStream + chunk encoding) for no real benefit.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const HARD_CAP = 10_000

const COLUMNS = [
  'created_at', 'action', 'actor', 'surface',
  'org_id', 'org_name', 'integration_id',
  'target_type', 'target_id',
  'ip_address', 'user_agent',
  'payload_json',
] as const

function csvEscape(v: any): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  // Quote if the value contains a comma, quote, newline, or carriage return.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
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
  const surface = url.searchParams.get('surface')
  const from    = url.searchParams.get('from')
  const to      = url.searchParams.get('to')

  const db = createAdminClient()

  let q = db.from('admin_audit_log')
            .select('id, created_at, actor, action, org_id, integration_id, target_type, target_id, payload, ip_address, user_agent')
            .order('created_at', { ascending: false })
            .order('id',         { ascending: false })
            .limit(HARD_CAP)

  if (action) q = q.eq('action', action)
  if (orgId)  q = q.eq('org_id', orgId)
  if (actor)  q = q.ilike('actor', `%${actor}%`)
  if (from)   q = q.gte('created_at', from)
  if (to)     q = q.lte('created_at', to)
  if (surface === 'admin_v2') {
    q = q.eq('payload->>surface', 'admin_v2')
  } else if (surface === 'admin_v1') {
    q = q.or('payload->>surface.is.null,payload->>surface.neq.admin_v2')
  }

  const { data, error } = await q
  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({
        error: 'admin_audit_log table missing — run sql/M010-admin-audit-log.sql.',
      }, { status: 503 })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  const rows = data ?? []

  // Enrich with org name.
  const orgIds = [...new Set(rows.map((r: any) => r.org_id).filter(Boolean))] as string[]
  const orgMap: Record<string, string> = {}
  if (orgIds.length > 0) {
    const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgMap[o.id] = o.name
  }

  // Build CSV string.
  const lines: string[] = []
  lines.push(COLUMNS.join(','))

  for (const r of rows as any[]) {
    const row: Record<string, any> = {
      created_at:     r.created_at,
      action:         r.action,
      actor:          r.actor,
      surface:        r?.payload?.surface ?? 'admin_v1',
      org_id:         r.org_id,
      org_name:       r.org_id ? (orgMap[r.org_id] ?? null) : null,
      integration_id: r.integration_id,
      target_type:    r.target_type,
      target_id:      r.target_id,
      ip_address:     r.ip_address,
      user_agent:     r.user_agent,
      payload_json:   r.payload ? JSON.stringify(r.payload) : '',
    }
    lines.push(COLUMNS.map(c => csvEscape(row[c])).join(','))
  }

  // Surface row-cap warning as a comment line. Many CSV consumers
  // (Excel, pandas) ignore '#' lines but it's still readable to humans.
  if (rows.length === HARD_CAP) {
    lines.unshift(`# WARNING: result truncated at ${HARD_CAP} rows. Narrow filters (date range, action, org) to export all matches.`)
  }

  const csv = lines.join('\r\n') + '\r\n'

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `admin-audit-${stamp}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store',
      'X-Row-Count':         String(rows.length),
      'X-Truncated':         rows.length === HARD_CAP ? 'true' : 'false',
    },
  })
}
