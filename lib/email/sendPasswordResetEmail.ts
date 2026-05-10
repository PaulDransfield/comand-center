// lib/email/sendPasswordResetEmail.ts
//
// Sends the "reset your password" message — used by the admin "Send
// password reset" action. Same pattern as sendVerifyEmail / sendInviteEmail:
// Supabase admin generates the recovery link; Resend sends a branded email
// with our copy + brand.
//
// Link type: `'recovery'` — Supabase's password-recovery flow. Single-use
// link that lets the user set a new password and signs them in. Works for
// existing users; doesn't require knowing the current password.

import { Resend } from 'resend'

interface SendPasswordResetEmailArgs {
  supabaseAdmin: any
  email:         string
  appOrigin:     string
  /** Who triggered this — for the audit trail in the email body. */
  triggeredBy?:  'admin' | 'self'
}

export interface SendPasswordResetEmailResult {
  ok:           boolean
  messageId?:   string
  actionLink?:  string
  error?:       string
}

export async function sendPasswordResetEmail(args: SendPasswordResetEmailArgs): Promise<SendPasswordResetEmailResult> {
  const { supabaseAdmin, email, appOrigin, triggeredBy } = args

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'recovery',
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
    console.warn('[sendPasswordResetEmail] RESEND_API_KEY not set — link not emailed')
    return { ok: false, actionLink, error: 'RESEND_API_KEY not configured' }
  }

  const subject = 'Reset your CommandCenter password'
  const greeting = 'Hello,'
  const intro = triggeredBy === 'admin'
    ? 'A CommandCenter administrator has triggered a password reset on your account. Click the button below to choose a new password.'
    : 'You requested a password reset for your CommandCenter account. Click the button below to choose a new password.'
  const cta         = 'Reset password'
  const fallback    = 'If the button above doesn\'t work, copy this link into your browser:'
  const validityLine = 'This link expires in 1 hour.'
  const ignoreLine  = `If you didn't request this, you can safely ignore this email — your password won't change.`
  const supportLine = `Questions? Reply to this email or write to support@comandcenter.se`

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <div style="max-width:520px;margin:32px auto;padding:32px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#1a1f2e;margin-bottom:20px;">CommandCenter</div>
    <p style="font-size:15px;margin:0 0 12px;">${escapeHtml(greeting)}</p>
    <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 24px;">${escapeHtml(intro)}</p>
    <p style="margin:0 0 28px;">
      <a href="${actionLink}" style="display:inline-block;padding:12px 22px;background:#1a1f2e;color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${escapeHtml(cta)}</a>
    </p>
    <p style="font-size:12px;color:#6b7280;line-height:1.5;margin:0 0 6px;">${escapeHtml(validityLine)}</p>
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
