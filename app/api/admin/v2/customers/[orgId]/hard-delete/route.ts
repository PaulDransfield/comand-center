// app/api/admin/v2/customers/[orgId]/hard-delete/route.ts
//
// Hard delete wrapper. CRITICAL: per the plan, the audit row must be
// written BEFORE the delete runs, AND the audit insert must SUCCEED for
// the delete to proceed. (Reverses the usual non-fatal-audit pattern —
// for hard delete specifically the audit row IS the safety net.)
//
// Body: { reason: string, typed_confirm: string }
// typed_confirm must equal the org's `name` exactly (case-sensitive).
//
// This endpoint records the audit + then proxies to the existing
// /api/admin/customers/[orgId]/delete endpoint which does the actual
// cascade purge (300+ lines, deeply tested). Don't reimplement.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const REASON_MIN = 10

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const reason       = String(body?.reason ?? '').trim()
  const typedConfirm = String(body?.typed_confirm ?? '')

  if (reason.length < REASON_MIN) {
    return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify the typed-confirmation matches the org's name exactly.
  const { data: org } = await db
    .from('organisations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle()
  if (!org) return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })
  if (typedConfirm !== org.name) {
    return NextResponse.json({
      error: `typed_confirm must equal "${org.name}" exactly`,
    }, { status: 400 })
  }

  // ── Audit FIRST, audit MUST succeed ────────────────────────────────
  // The library's recordAdminAction is non-fatal by default; we re-implement
  // a strict version here so a missing audit row blocks the delete.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
          ?? req.headers.get('x-real-ip')
          ?? null
  const ua = req.headers.get('user-agent') ?? null

  const { error: auditErr } = await db.from('admin_audit_log').insert({
    actor:        'admin',
    action:       ADMIN_ACTIONS.HARD_DELETE,
    org_id:       orgId,
    target_type:  'org',
    target_id:    orgId,
    payload:      { reason, surface: 'admin_v2', org_name: org.name, typed_confirm: typedConfirm },
    ip_address:   ip,
    user_agent:   ua,
  })
  if (auditErr) {
    // Strict path — without audit we don't proceed.
    return NextResponse.json({
      error: `audit write failed — refusing to delete: ${auditErr.message}`,
    }, { status: 500 })
  }

  // ── Proxy to existing delete endpoint via direct internal fetch ────
  // Reuses the old endpoint's 300+ lines of cascade logic. It expects
  // body { confirm: "DELETE <name>" }.
  const protocol = req.headers.get('x-forwarded-proto') ?? 'https'
  const host     = req.headers.get('host')
  const url      = `${protocol}://${host}/api/admin/customers/${orgId}/delete`
  const adminSecret = req.headers.get('x-admin-secret') ?? ''

  const proxyRes = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-admin-secret':  adminSecret,
    },
    body: JSON.stringify({ confirm: `DELETE ${org.name}` }),
  })
  const proxyBody = await proxyRes.json().catch(() => ({}))

  if (!proxyRes.ok) {
    // Audit row already written; surface the failure.
    return NextResponse.json({
      error: proxyBody?.error ?? `hard-delete proxy failed (status ${proxyRes.status})`,
      audit_recorded: true,
    }, { status: proxyRes.status })
  }

  return NextResponse.json({
    ok: true,
    org_name: org.name,
    reason,
    cascade: proxyBody,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
