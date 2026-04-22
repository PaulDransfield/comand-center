// @ts-nocheck
// Sends confirmation email to customer after onboarding completes.
// Must be authenticated — otherwise anyone can trigger our domain to email
// any org's members. We accept org_id in body for backward-compat with the
// /api/onboarding/complete caller, but REQUIRE the session org to match.
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const { org_id, business_name, city, systems } = await req.json()
    if (!org_id) return NextResponse.json({ error: 'org_id required' }, { status: 400 })

    // Caller cannot target another org — only themselves.
    if (org_id !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const db = createAdminClient()

    // Get user email
    const { data: member } = await db
      .from('organisation_members')
      .select('user_id')
      .eq('org_id', org_id)
      .limit(1)
      .maybeSingle()

    if (!member) return NextResponse.json({ error: 'No member found' }, { status: 404 })

    const { data: { user } } = await db.auth.admin.getUserById(member.user_id)
    if (!user?.email) return NextResponse.json({ error: 'No email' }, { status: 404 })

    const systemList = Object.entries(systems ?? {})
      .filter(([, v]) => v && v !== 'none' && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') || 'Not specified'

    // Send confirmation email via shared helper — 10s timeout + Sentry capture.
    const { sendEmail } = await import('@/lib/email/send')
    const emailResult = await sendEmail({
      from:    'CommandCenter <hello@comandcenter.se>',
      to:      user.email,
      subject: 'Your CommandCenter account is being set up',
      context: { kind: 'onboarding_confirmation', user_id: user.id, business_name },
      html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#1a1f2e">
            <div style="font-size:20px;font-weight:700;margin-bottom:24px">CommandCenter</div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:12px">We've received your setup request</h1>
            <p style="font-size:15px;color:#374151;line-height:1.7;margin-bottom:20px">
              Thanks for signing up${business_name ? ` — we'll get ${business_name} connected` : ''}. Our team is now setting up your integrations.
            </p>
            <div style="background:#f9fafb;border-radius:10px;padding:18px 20px;margin-bottom:24px;font-size:13px;color:#374151">
              <div style="font-weight:600;margin-bottom:8px">What you told us:</div>
              ${city ? `<div>Location: ${city}</div>` : ''}
              ${systemList !== 'Not specified' ? `<div>Systems: ${systemList}</div>` : ''}
            </div>
            <p style="font-size:14px;color:#374151;line-height:1.7;margin-bottom:8px">
              <strong>What happens next:</strong>
            </p>
            <ul style="font-size:14px;color:#374151;line-height:1.9;margin:0 0 24px;padding-left:20px">
              <li>We connect your systems — usually within a few hours</li>
              <li>Your data syncs automatically</li>
              <li>You'll get another email when your dashboard is live</li>
            </ul>
            <p style="font-size:13px;color:#6b7280">
              Questions? Reply to this email or contact paul@laweka.com
            </p>
            <div style="margin-top:40px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
              CommandCenter · Dransfield Invest AB · comandcenter.se
            </div>
          </div>
        `,
    })

    // sendEmail already captured any failure to Sentry with context.
    // Success path needs nothing more; non-fatal for the caller.
    void emailResult

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('confirm-email error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
