// lib/email/sendVerifyEmail.ts
//
// Sends the "confirm your email address" message to a fresh signup. We
// generate the confirmation link via Supabase admin (so we control the
// redirect target) and send the actual email through Resend so the
// branding + copy are ours rather than Supabase's defaults.
//
// Why not use Supabase's built-in confirmation emails:
//   - Their templates are unbranded and require custom SMTP setup to
//     not look like spam in production
//   - We already have Resend wired for cron + onboarding-success emails;
//     reusing that path keeps deliverability consistent
//   - Locale-aware subject/body via lib/email/i18n.ts
//
// The link Supabase returns goes through their /auth/v1/verify endpoint
// first (which validates the token + sets the session), then redirects
// to our `redirect_to` URL. We point that at /api/auth/callback?next=
// /onboarding so the confirmed user lands on the wizard with a session.

import { Resend } from 'resend'
import { getEmailMessages } from '@/lib/email/i18n'

interface SendVerifyEmailArgs {
  /** Supabase admin client (createAdminClient) — caller already has it. */
  supabaseAdmin: any
  /** Recipient address. */
  email:         string
  /** What the user typed during signup; used in the greeting. */
  fullName?:     string | null
  /** Locale for the email copy. Defaults to en-GB inside getEmailMessages. */
  locale?:       string | null
  /** Absolute base URL for the redirect target (e.g. https://comandcenter.se). */
  appOrigin:     string
}

export interface SendVerifyEmailResult {
  ok:           boolean
  /** Resend message id when sent successfully. */
  messageId?:   string
  /** Action link returned by Supabase — useful for surfacing in dev when
   *  Resend isn't configured. */
  actionLink?:  string
  error?:       string
}

export async function sendVerifyEmail(args: SendVerifyEmailArgs): Promise<SendVerifyEmailResult> {
  const { supabaseAdmin, email, fullName, locale, appOrigin } = args

  // Generate the magic verification link. `type: 'signup'` is the right
  // shape for the post-createUser confirmation flow. The redirectTo URL
  // is where Supabase forwards the browser AFTER it verifies the token
  // and prepares the session — our /api/auth/callback consumes the code
  // param and finishes the sign-in.
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'signup',
    email,
    options: {
      redirectTo: `${appOrigin}/api/auth/callback?next=/onboarding`,
    },
  })
  if (error || !data?.properties?.action_link) {
    return { ok: false, error: error?.message ?? 'No action_link returned' }
  }

  const actionLink = data.properties.action_link as string

  // If Resend isn't configured (preview env without secrets), don't
  // throw — return the link so caller can log it / surface to admin.
  // The signup endpoint treats this as a soft-warn rather than a 500.
  if (!process.env.RESEND_API_KEY) {
    console.warn('[sendVerifyEmail] RESEND_API_KEY not set — link not emailed')
    return { ok: false, actionLink, error: 'RESEND_API_KEY not configured' }
  }

  const t = await getEmailMessages(locale)
  const subject = t('verifyEmail.subject')
  const greeting = fullName
    ? t('verifyEmail.greetingNamed', { name: fullName })
    : t('verifyEmail.greetingPlain')
  const intro       = t('verifyEmail.intro')
  const cta         = t('verifyEmail.cta')
  const fallback    = t('verifyEmail.fallback')
  const ignoreLine  = t('verifyEmail.ignoreLine')
  const supportLine = t('verifyEmail.supportLine')

  // Inline HTML — keep it simple and dependency-free. The subject of
  // every transactional email follows our common.from pattern via the
  // sender name; recipients see "CommandCenter <hello@comandcenter.se>".
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
