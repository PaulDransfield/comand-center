// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { captureError, captureWarning } from '@/lib/monitoring/sentry'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const getAuth = getRequestAuth

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { restaurantName, city, staffSystem, accounting, pos, contactTime, phone } = body

  const db = createAdminClient()

  // Save to onboarding_progress
  await db.from('onboarding_progress').upsert({
    org_id:      auth.orgId,
    step:        'setup_requested',
    metadata: {
      restaurantName, city,
      staffSystem, accounting, pos,
      contactTime, phone,
      userEmail:   auth.email,
      requestedAt: new Date().toISOString(),
    },
  }, { onConflict: 'org_id' })

  // Log to admin for follow-up. If admin_log has schema drift we don't
  // want to block the customer's request, but we MUST know about it —
  // a setup request the admin team never sees is a lost lead. Capture
  // to Sentry as a warning so the ops team investigates within hours.
  const { error: adminLogErr } = await db.from('admin_log').insert({
    event_type:  'setup_request',
    description: `New setup request from ${auth.email} — ${restaurantName} (${city})`,
    metadata: {
      org_id:        auth.orgId,
      user_email:    auth.email,
      restaurant:    restaurantName,
      city,
      staff_system:  staffSystem,
      accounting,
      pos,
      contact_time:  contactTime,
      phone,
    },
  })
  if (adminLogErr) {
    captureWarning('admin_log insert failed on setup-request', {
      route:     'onboarding/setup-request',
      error:     adminLogErr.message,
      org_id:    auth.orgId,
      user_email: auth.email,
    })
  }

  // Send notification email via shared sendEmail helper (timeout + Sentry capture).
  const { sendEmail } = await import('@/lib/email/send')
  await sendEmail({
    from:    'CommandCenter <noreply@comandcenter.se>',
    to:      process.env.OPS_EMAIL ?? 'paul@comandcenter.se',
    subject: `New setup request: ${restaurantName}`,
    html: `
      <h2>New setup request</h2>
      <p><strong>Restaurant:</strong> ${restaurantName} (${city})</p>
      <p><strong>Customer email:</strong> ${auth.email}</p>
      <p><strong>Staff system:</strong> ${staffSystem || 'Not specified'}</p>
      <p><strong>Accounting:</strong> ${accounting || 'Not specified'}</p>
      <p><strong>POS:</strong> ${pos || 'Not specified'}</p>
      <p><strong>Best time to contact:</strong> ${contactTime || 'Anytime'}</p>
      <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
      <hr/>
      <p><a href="https://app.supabase.com/project/llzmixkrysduztsvmfzi">View in Supabase</a></p>
    `,
    context: {
      kind:        'setup_request',
      org_id:      auth.orgId,
      user_email:  auth.email,
      restaurant:  restaurantName,
    },
  })

  return NextResponse.json({ ok: true })
}
