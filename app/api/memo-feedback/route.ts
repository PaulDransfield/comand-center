// @ts-nocheck
// app/api/memo-feedback/route.ts
//
// Public endpoint recording thumbs up / down on a Monday memo.
//
// GET  /api/memo-feedback?briefing=<id>&rating=up|down&token=<sig>
//   → renders a small confirmation page with a "Confirm" button. We use a
//     two-step flow (GET confirm → POST write) because email clients like
//     Gmail prefetch links for security scanning — a one-click GET that
//     writes would register phantom votes, sometimes both up and down.
//
// POST /api/memo-feedback
//   body: { briefing_id, rating, token, comment? }
//   → verifies the token and upserts the vote. Also accepts a follow-up
//     comment written from the thank-you page textarea.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { verifyFeedback }            from '@/lib/email/feedback-token'

export const dynamic = 'force-dynamic'

function htmlPage(body: string, title = 'CommandCenter'): Response {
  const page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;background:#f5f5f0;font-family:Georgia,serif;color:#1a1f2e;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:480px;width:100%;background:#fff;border:1px solid #d4d4d0;border-radius:12px;padding:32px 28px;box-shadow:0 2px 12px rgba(0,0,0,.04)}
  h1{font-size:22px;font-weight:500;margin:0 0 12px;line-height:1.3}
  p{font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px}
  .row{display:flex;gap:10px;margin-top:20px}
  button,.btn{display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;border-radius:8px;border:none;cursor:pointer;text-decoration:none;font-family:-apple-system,Segoe UI,sans-serif}
  .primary{background:#1a1f2e;color:#fff}
  .ghost{background:#fff;color:#6b7280;border:1px solid #d4d4d0}
  .meta{font-size:12px;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px;font-family:-apple-system,Segoe UI,sans-serif}
  textarea{width:100%;min-height:110px;border:1px solid #d4d4d0;border-radius:8px;padding:12px;font-family:inherit;font-size:14px;box-sizing:border-box;resize:vertical}
  .ok{color:#059669}.bad{color:#dc2626}
</style></head>
<body><div class="card">${body}</div></body></html>`
  return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}

// ── GET: confirmation page ──────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const u        = new URL(req.url)
  const briefing = u.searchParams.get('briefing') ?? ''
  const rating   = u.searchParams.get('rating')   ?? ''
  const token    = u.searchParams.get('token')    ?? ''

  if (!briefing || !rating || !token || !verifyFeedback(briefing, rating, token)) {
    return htmlPage(`
      <div class="meta">CommandCenter</div>
      <h1>Link expired or invalid</h1>
      <p>This feedback link could not be verified. Please open the most recent Monday memo and try again.</p>
    `, 'Invalid link')
  }

  const label = rating === 'up' ? 'Useful' : 'Not useful'
  const tone  = rating === 'up' ? 'ok' : 'bad'

  return htmlPage(`
    <div class="meta">Monday memo · feedback</div>
    <h1>Mark this memo as <span class="${tone}">${label}</span>?</h1>
    <p>Your rating helps us tune what the AI manager focuses on each week. One click to confirm.</p>
    <form method="POST" action="/api/memo-feedback">
      <input type="hidden" name="briefing_id" value="${briefing}">
      <input type="hidden" name="rating"      value="${rating}">
      <input type="hidden" name="token"       value="${token}">
      <div class="row">
        <button type="submit" class="primary">Confirm</button>
        <a class="btn ghost" href="about:blank">Cancel</a>
      </div>
    </form>
  `, 'Confirm feedback')
}

// ── POST: write the vote (or follow-up comment) ─────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {}
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    body = await req.json().catch(() => ({}))
  } else {
    // form POST from the confirmation page
    const form = await req.formData().catch(() => null)
    if (form) body = Object.fromEntries(form.entries())
  }

  const briefingId = String(body.briefing_id ?? '')
  const rating     = String(body.rating      ?? '')
  const token      = String(body.token       ?? '')
  const comment    = body.comment != null ? String(body.comment).slice(0, 2000) : null

  if (!briefingId || !verifyFeedback(briefingId, rating, token)) {
    return htmlPage(`
      <div class="meta">CommandCenter</div>
      <h1>Link expired or invalid</h1>
      <p>We couldn't verify that request. If you were trying to send feedback, open the most recent Monday memo and click the rating again.</p>
    `, 'Invalid link')
  }

  const db = createAdminClient()

  // Fetch briefing to derive org + business ids (avoids trusting the client)
  const { data: br } = await db
    .from('briefings')
    .select('id, org_id, business_id')
    .eq('id', briefingId)
    .maybeSingle()

  if (!br) {
    return htmlPage(`
      <div class="meta">CommandCenter</div>
      <h1>Memo not found</h1>
      <p>That memo reference no longer exists. No vote was recorded.</p>
    `, 'Not found')
  }

  // Upsert — one vote per memo, latest rating / comment wins
  const row: any = {
    briefing_id: br.id,
    org_id:      br.org_id,
    business_id: br.business_id,
    rating,
  }
  if (comment !== null) row.comment = comment

  await db.from('memo_feedback').upsert(row, { onConflict: 'briefing_id' })

  // After a comment-only submission, show a simple "saved" acknowledgement.
  if (comment !== null) {
    return htmlPage(`
      <div class="meta">CommandCenter · feedback saved</div>
      <h1>Got it — thanks for the detail.</h1>
      <p>Your note is logged with this week's memo rating. You can close this tab.</p>
    `, 'Feedback saved')
  }

  // Otherwise offer the optional comment step.
  const label = rating === 'up' ? 'glad it landed' : 'sorry it missed'
  return htmlPage(`
    <div class="meta">Monday memo · rating saved</div>
    <h1>Thanks — ${label}.</h1>
    <p>If you want, tell us what made the difference. This goes straight to the team tuning the AI.</p>
    <form method="POST" action="/api/memo-feedback">
      <input type="hidden" name="briefing_id" value="${br.id}">
      <input type="hidden" name="rating"      value="${rating}">
      <input type="hidden" name="token"       value="${token}">
      <textarea name="comment" placeholder="Anything specific — what landed, what missed, what you'd like next week."></textarea>
      <div class="row">
        <button type="submit" class="primary">Send</button>
        <a class="btn ghost" href="about:blank">No thanks</a>
      </div>
    </form>
  `, 'Rating saved')
}
