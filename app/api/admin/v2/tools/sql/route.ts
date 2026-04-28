// app/api/admin/v2/tools/sql/route.ts
//
// Admin v2 Tools — read-only SQL runner. POST { query, limit } → execute
// via admin_run_sql RPC (M037). Every successful run is audited; rejects
// are NOT audited (they never touched data).
//
// Defence in depth:
//   1. JS regex validation here (primary). Same checks as the RPC, run
//      first so we never round-trip an obviously-bad query.
//   2. RPC re-validates inside Postgres + wraps in a SELECT subquery.
//   3. RPC sets statement_timeout=10s + lock_timeout=2s.
//   4. RPC capped at 1000 rows.
//   5. RPC EXECUTE granted only to service_role.
//
// The audit row's payload is intentionally minimal — { query, row_count,
// duration_ms, truncated, limit }. Never the rows themselves; admin SQL
// could include PII and the audit log is meant to be a record of
// activity, not a data sink.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const MAX_QUERY_LENGTH = 50_000   // ~50 KB; pathological queries fail closed.
const DEFAULT_LIMIT    = 100
const MAX_LIMIT        = 1_000

// Same forbidden-word list the RPC uses. Keep them in lockstep.
const FORBIDDEN_WORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT',
  'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'COPY', 'DO', 'CALL',
  'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER',
  'LOCK', 'NOTIFY', 'LISTEN', 'UNLISTEN',
  'RESET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START',
  'PREPARE', 'DEALLOCATE', 'SECURITY', 'DEFINER',
]
const FORBIDDEN_RX = new RegExp(`\\b(${FORBIDDEN_WORDS.join('|')})\\b`, 'i')

const ALLOWED_FIRST_TOKEN_RX = /^(select|with|table|values|explain)\s/i

type ValidationResult =
  | { ok: true;  cleaned: string }
  | { ok: false; error:   string }

function validateQuery(raw: string): ValidationResult {
  if (typeof raw !== 'string') return { ok: false, error: 'query must be a string' }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, error: 'query is empty' }
  if (trimmed.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `query exceeds ${MAX_QUERY_LENGTH} characters` }
  }

  // Strip a single trailing semicolon. Reject any other.
  const cleaned = trimmed.replace(/;\s*$/, '')
  if (cleaned.includes(';')) {
    return { ok: false, error: 'multi-statement queries are not allowed' }
  }

  // Strip comments for the first-token + keyword checks (literal strings
  // are NOT stripped — a forbidden word inside a string literal would still
  // get flagged. That's a known false-positive but acceptable for an admin
  // tool: just rename the alias or use a different cast.).
  const noComments = cleaned
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()

  if (!ALLOWED_FIRST_TOKEN_RX.test(noComments)) {
    return { ok: false, error: 'only SELECT / WITH / TABLE / VALUES / EXPLAIN queries are allowed' }
  }

  if (FORBIDDEN_RX.test(noComments)) {
    const match = noComments.match(FORBIDDEN_RX)
    return { ok: false, error: `query contains a forbidden keyword: ${match?.[1]}. Writes / DDL / control statements are not allowed.` }
  }

  return { ok: true, cleaned }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const validation = validateQuery(body?.query)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error, kind: 'validation' }, { status: 400 })
  }

  const limit = Math.max(1, Math.min(parseInt(String(body?.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT))

  const db = createAdminClient()

  const startedAt = Date.now()
  const { data, error } = await db.rpc('admin_run_sql', {
    p_query: validation.cleaned,
    p_limit: limit,
  })

  if (error) {
    // RPC missing → M037 not yet applied. Surface a clear hint.
    if (error.code === 'PGRST202' || /admin_run_sql/i.test(String(error.message))) {
      return NextResponse.json({
        error: 'admin_run_sql RPC missing — run M037-ADMIN-SQL-RUNNER.sql in Supabase SQL Editor.',
        kind: 'rpc_missing',
      }, { status: 503 })
    }
    return NextResponse.json({
      error: error.message,
      code:  error.code ?? null,
      hint:  (error as any)?.hint ?? null,
      kind:  'execution',
    }, { status: 400 })
  }

  const result = data as {
    rows:        any[]
    row_count:   number
    duration_ms: number
    limit:       number
    truncated:   boolean
  }

  // Derive column order from the first row's JSONB-normalised keys.
  // (See M037 comment about JSONB key ordering — not the original SELECT
  // column order, but deterministic.)
  const columns = result.rows.length > 0
    ? Object.keys(result.rows[0])
    : []

  // Audit. Payload is intentionally minimal — never log the actual rows.
  await recordAdminAction(db as any, {
    action: ADMIN_ACTIONS.SQL_RUN,
    payload: {
      surface:     'admin_v2',
      query:       validation.cleaned,
      query_chars: validation.cleaned.length,
      row_count:   result.row_count,
      duration_ms: result.duration_ms,
      truncated:   result.truncated,
      limit:       result.limit,
    },
    req,
  })

  return NextResponse.json({
    columns,
    rows:         result.rows,
    row_count:    result.row_count,
    duration_ms:  result.duration_ms,
    limit:        result.limit,
    truncated:    result.truncated,
    network_ms:   Date.now() - startedAt,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
