// app/api/support/route.ts
//
// In-app "Contact us" — a reliable alternative to mailto: links. A logged-in
// user submits a message; we email the right inbox via Resend (security@ for
// security reports, billing@ for billing, support@ otherwise) with their
// identity + context auto-attached, send them a confirmation, and log the
// ticket to support_tickets.
//
// POST { category: 'support'|'security'|'billing', subject?, message, business_id?, page? }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email/send'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INBOX: Record<string, string> = {
  support:  'support@comandcenter.se',
  security: 'security@comandcenter.se',
  billing:  'billing@comandcenter.se',
}
const VALID = new Set(Object.keys(INBOX))
const FROM = 'CommandCenter <hello@comandcenter.se>'

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const category = String(body.category ?? 'support').trim()
  if (!VALID.has(category)) return NextResponse.json({ error: 'invalid category' }, { status: 400 })
  const message = String(body.message ?? '').trim()
  if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 })
  if (message.length > 5000) return NextResponse.json({ error: 'message too long (max 5000)' }, { status: 400 })
  const subject  = String(body.subject ?? '').trim().slice(0, 200)
  const page     = body.page ? String(body.page).trim().slice(0, 300) : null
  const businessId = body.business_id ? String(body.business_id).trim() : null

  const db = createAdminClient()

  // Identity + context — fetched server-side so it can't be spoofed.
  let userEmail: string | null = null
  let userName:  string | null = null
  try {
    const { data: u } = await db.auth.admin.getUserById(auth.userId)
    userEmail = u?.user?.email ?? null
    userName  = (u?.user?.user_metadata as any)?.full_name ?? null
  } catch { /* best-effort */ }

  const { data: org } = await db.from('organisations').select('name, plan').eq('id', auth.orgId).maybeSingle()
  let businessName: string | null = null
  if (businessId) {
    const { data: biz } = await db.from('businesses').select('name').eq('id', businessId).maybeSingle()
    businessName = biz?.name ?? null
  }

  const inbox = INBOX[category]
  const priority = category === 'security' ? 'high' : 'normal'
  const title = subject || `${category[0].toUpperCase()}${category.slice(1)} request`

  // ── Log the ticket first (so the message survives even if email fails) ──
  let ticketId: string | null = null
  try {
    const { data: ticket } = await db.from('support_tickets').insert({
      org_id:        auth.orgId,
      user_id:       auth.userId,
      business_id:   businessId,
      category,
      title,
      message,
      contact_email: userEmail,
      contact_name:  userName,
      page,
      status:        'open',
      priority,
    }).select('id').maybeSingle()
    ticketId = ticket?.id ?? null
  } catch { /* non-fatal — email is the primary channel */ }

  // ── Email the team ──────────────────────────────────────────────
  const ctxRows = [
    ['From',     `${userName ? `${userName} · ` : ''}${userEmail ?? auth.userId}`],
    ['Org',      `${org?.name ?? auth.orgId} (${org?.plan ?? auth.plan})`],
    ['Business', businessName ?? '—'],
    ['Category', category],
    ['Page',     page ?? '—'],
    ['Ticket',   ticketId ?? '—'],
  ]
  const html = `
    <div style="font-family:system-ui,sans-serif;font-size:14px;color:#1a1f2e;line-height:1.6">
      <h2 style="font-size:16px;margin:0 0 12px">${esc(title)}</h2>
      <table style="border-collapse:collapse;margin-bottom:16px;font-size:13px;color:#374151">
        ${ctxRows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#9ca3af">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
      </table>
      <div style="white-space:pre-wrap;padding:12px 14px;background:#f6f7f9;border-radius:8px">${esc(message)}</div>
    </div>`
  const text = `${title}\n\n${ctxRows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${message}`

  const teamSend = await sendEmail({
    from:    FROM,
    to:      inbox,
    subject: `[${category}] ${title}`,
    html, text,
    reply_to: userEmail ?? undefined,
    context: { route: 'api/support', org_id: auth.orgId, category, ticket_id: ticketId },
  })

  // Best-effort confirmation to the user.
  if (userEmail) {
    await sendEmail({
      from:    FROM,
      to:      userEmail,
      subject: `We got your message — ${title}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#1a1f2e;line-height:1.7">
        <p>Thanks for reaching out — we've received your ${esc(category)} message and will reply to this address.</p>
        <p style="color:#6b7280">For reference, here's what you sent:</p>
        <div style="white-space:pre-wrap;padding:12px 14px;background:#f6f7f9;border-radius:8px;color:#374151">${esc(message)}</div>
        <p style="color:#9ca3af;font-size:12px;margin-top:16px">CommandCenter · comandcenter.se</p>
      </div>`,
      text: `Thanks for reaching out — we've received your ${category} message and will reply to this address.\n\nWhat you sent:\n${message}\n\nCommandCenter · comandcenter.se`,
      context: { route: 'api/support', kind: 'confirmation', org_id: auth.orgId },
    }).catch(() => {})
  }

  if (ticketId) {
    await db.from('support_tickets').update({ email_status: teamSend.ok ? 'sent' : 'failed' }).eq('id', ticketId)
  }

  if (!teamSend.ok) {
    // Email failed but the ticket is stored — tell the user honestly.
    return NextResponse.json({
      ok: false,
      stored: !!ticketId,
      error: 'We saved your message but the email notification failed. We can still see it — or email ' + inbox + ' directly.',
    }, { status: 502 })
  }

  return NextResponse.json({ ok: true, ticket_id: ticketId }, { headers: { 'Cache-Control': 'no-store' } })
}
