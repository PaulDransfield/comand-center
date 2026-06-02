// app/api/inventory/retry-failed-extractions/route.ts
//
// POST { business_id } — resets every status='failed' invoice_pdf_extractions
// row whose error was 'pdf_lookup_failed' (i.e., transient — the PDF
// couldn't be fetched because the Fortnox token was dead at the time).
// Sets attempts=0 + status='pending' so the next extraction sweep picks
// them up. Then kicks the cron immediately for convenience.
//
// Use case (2026-05-24): the morning's invalid_grant race killed every
// in-flight extraction with 'no_token_available'. After re-OAuth, this
// endpoint un-strands those 629 rows in one click.
//
// Owner-callable (no admin secret needed) since it only touches rows
// for businesses the user has access to.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  // Optional filter — by default we ONLY retry pdf_lookup_failed since
  // that's the transient-token-issue class. Owner can pass all=true to
  // also retry real extraction failures (claude_call_failed,
  // total_mismatch, etc) but those usually need PDF / model fixes
  // rather than a re-run.
  const retryAll = body.all === true

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Build the filter. Reset rows where error message starts with
  // 'pdf_lookup_failed' (covers both 'no_token_available' and
  // 'token_refresh: FORTNOX_NEEDS_REAUTH' from earlier today).
  let q = db
    .from('invoice_pdf_extractions')
    .select('id, error_message')
    .eq('business_id', businessId)
    .eq('status', 'failed')
    .limit(2000)
  if (!retryAll) q = q.like('error_message', 'pdf_lookup_failed%')

  const { data: candidates, error: selErr } = await q
  if (selErr) return NextResponse.json({ error: `select: ${selErr.message}` }, { status: 500 })

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, reset: 0, message: 'no failed rows matching filter' })
  }

  // Reset in 100-id chunks to stay under Supabase's 16 KB HTTP header
  // cap (UND_ERR_HEADERS_OVERFLOW on 500-UUID slices, silently null in
  // supabase-js). See docs/investigation/no-price-root-cause.md.
  const ids = candidates.map(c => c.id)
  let reset = 0
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100)
    const { data: upd, error: uErr } = await db
      .from('invoice_pdf_extractions')
      .update({
        status:        'pending',
        attempts:      0,
        error_message: null,
        started_at:    null,
        completed_at:  null,
      })
      .in('id', slice)
      .select('id')
    if (uErr) return NextResponse.json({
      ok: false, reset, error: `update: ${uErr.message}`,
    }, { status: 500 })
    reset += upd?.length ?? 0
  }

  // Kick the extraction worker immediately so the user sees progress
  // instead of waiting for the next sweep tick (every 30 min).
  let kicked = false
  const base   = process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  const secret = process.env.CRON_SECRET
  if (base && secret) {
    fetch(`${base}/api/cron/inventory-pdf-extract-business`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: JSON.stringify({
        business_id:      businessId,
        reset_extracting: true,
        chain_rematch:    true,
      }),
    }).catch(err => console.error('[retry-failed] worker kick failed:', err?.message ?? err))
    kicked = true
  }

  return NextResponse.json({
    ok: true,
    scanned: candidates.length,
    reset,
    worker_kicked: kicked,
    message: `Reset ${reset} failed extractions. Worker is processing them in the background — check /inventory/extractions in a few minutes.`,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
