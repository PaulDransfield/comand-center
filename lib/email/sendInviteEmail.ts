// lib/email/sendInviteEmail.ts
//
// Sends the "you've been invited to CommandCenter — set your password"
// message when an admin or owner adds a new user to an org. Mirrors the
// sendVerifyEmail pattern: generate the action link via Supabase admin
// (so we control the redirect target), send the actual email through
// Resend so the branding + copy are ours.
//
// Why not Supabase's built-in invite email:
//   - Supabase sends from their default SMTP with their templates ("noreply@
//     mail.app.supabase.io" + generic copy) which feels like a phishing
//     attempt to first-time recipients.
//   - We already have Resend wired for verify + cron emails; reusing keeps
//     deliverability consistent and the brand intact.
//
// Link type: `'invite'` — Supabase's invite flow generates a one-time
// link that, when clicked, lets the user set their own password before
// landing on the redirectTo URL. This is the right shape for "fresh user,
// no password yet" — they shouldn't see the regular login screen.

import { Resend } from 'resend'

interface SendInviteEmailArgs {
  supabaseAdmin: any
  email:         string
  /** What the inviter typed (admin) or the org name; used in greeting copy. */
  orgName?:      string | null
  inviterName?:  string | null
  appOrigin:     string
}

export interface SendInviteEmailResult {
  ok:           boolean
  messageId?:   string
  actionLink?:  string
  error?:       string
}

export async function sendInviteEmail(args: SendInviteEmailArgs): Promise<SendInviteEmailResult> {
  const { supabaseAdmin, email, orgName, inviterName, appOrigin } = args

  // generateLink with type='invite' returns a single-use URL that takes
  // the user to a Supabase-hosted password-set page first, then redirects
  // to our `redirectTo`. After landing there, the user has a session +
  // a chosen password.
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'invite',
    email,
    options: {
      redirectTo: `${appOrigin}/auth/handle?next=/dashboard`,
    },
  })
  if (error || !data?.properties?.action_link) {
    return { ok: false, error: error?.message ?? 'No action_link returned' }
  }

  const actionLink = data.properties.action_link as string

  if (!process.env.RESEND_API_KEY) {
    console.warn('[sendInviteEmail] RESEND_API_KEY not set — link not emailed')
    return { ok: false, actionLink, error: 'RESEND_API_KEY not configured' }
  }

  const subject = orgName
    ? `You've been invited to ${orgName} on CommandCenter`
    : `You've been invited to CommandCenter`
  const greeting = `Hello,`
  const intro = inviterName
    ? `${escapeHtml(inviterName)} has invited you to join ${orgName ? escapeHtml(orgName) : 'their team'} on CommandCenter — restaurant business intelligence for owners and managers.`
    : orgName
      ? `You've been invited to join ${escapeHtml(orgName)} on CommandCenter — restaurant business intelligence for owners and managers.`
      : `You've been invited to join CommandCenter — restaurant business intelligence for owners and managers.`
  const cta         = 'Set your password & sign in'
  const fallback    = 'If the button above doesn\'t work, copy this link into your browser:'
  const ignoreLine  = `If you weren't expecting this invitation, you can safely ignore this email.`
  const supportLine = `Questions? Reply to this email or write to support@comandcenter.se`

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <div style="max-width:520px;margin:32px auto;padding:32px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#1a1f2e;margin-bottom:20px;">CommandCenter</div>
    <p style="font-size:15px;margin:0 0 12px;">${greeting}</p>
    <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 24px;">${intro}</p>
    <p style="margin:0 0 28px;">
      <a href="${actionLink}" style="display:inline-block;padding:12px 22px;background:#1a1f2e;color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${escapeHtml(cta)}</a>
    </p>
    <p style="font-size:12px;color:#6b7280;line-height:1.5;margin:0 0 6px;">${escapeHtml(fallback)}</p>
    <p style="font-size:12px;color:#6b7280;line-height:1.5;word-break:break-all;margin:0 0 24px;"><a href="${actionLink}" style="color:#6366f1;">${escapeHtml(actionLink)}</a></p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">
    <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0 0 6px;">${escapeHtml(ignoreLine)}</p>
    <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0;">${escapeHtml(supportLine)}</p>
  </div>
</body></html>`

  try {
    const resend = new Resend(process.env.RESEND_API_KEY!)
    const send = await resend.emails.send({
      from:    'CommandCenter <hello@comandcenter.se>',
      to:      email,
      subject,
      html,
    })
    if ((send as any)?.error) {
      return { ok: false, actionLink, error: (send as any).error?.message ?? 'Resend error' }
    }
    return { ok: true, messageId: (send as any)?.data?.id, actionLink }
  } catch (e: any) {
    return { ok: false, actionLink, error: e?.message ?? 'Resend threw' }
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
