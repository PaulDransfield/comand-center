// app/api/cron/inventory-rematch-business/route.ts
//
// DEPRECATED-AS-OWN-WORKER, NOW A PROXY.
//
// Was a standalone rematch worker mirroring /api/inventory/lines/rematch.
// Two routes drifted: the user-facing route got the deadline-aware
// self-chain patch (2026-05-30); this one didn't. PDF-extraction chains
// kept hitting the 800s Vercel wall on big businesses and stranding the
// state row at status='running'.
//
// Fixed by collapsing into a thin proxy: every cron-rematch call now
// forwards to /api/inventory/lines/rematch with cron-secret auth so a
// single patched worker handles every rematch path (UI clicks, PDF
// extraction chains, manual extractions, ops kicks).
//
// Same external contract preserved:
//   POST /api/cron/inventory-rematch-business
//   Body: { business_id, only_not_inventory? }
//   Auth: Bearer CRON_SECRET or ADMIN_SECRET
//
// Callers (do NOT need to change):
//   - app/api/cron/inventory-pdf-extract-business/route.ts (chain after extraction)
//   - app/api/inventory/extractions/[id]/route.ts (chain after manual extraction)
//
// Future cleanup: redirect the two callers above to hit
// /api/inventory/lines/rematch directly and delete this proxy.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  noStore()

  const adminSecret = process.env.ADMIN_SECRET
  const cronSecret  = process.env.CRON_SECRET
  const headerAuth  = req.headers.get('authorization') ?? ''
  if (!(adminSecret && headerAuth === `Bearer ${adminSecret}`) &&
      !(cronSecret  && headerAuth === `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base || !cronSecret) {
    return NextResponse.json({ error: 'app_url_or_cron_secret_missing' }, { status: 500 })
  }

  // Forward to the patched worker. Preserve every field the caller sent
  // (only_not_inventory, chained_from, etc.) so behaviour is identical
  // to a direct POST. The patched route ignores unknown fields.
  const res = await fetch(`${base}/api/inventory/lines/rematch`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${cronSecret}`,
    },
    body: JSON.stringify(body),
  })

  // Pass through the status + JSON body so the caller gets the same
  // shape as before (legacy callers parse {ok, status, business_id, ...}).
  const json = await res.json().catch(() => ({ ok: false, error: 'proxy_response_not_json' }))
  return NextResponse.json(json, { status: res.status })
}
