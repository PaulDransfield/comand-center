// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

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

  // Log to admin for follow-up
  await db.from('admin_log').insert({
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
  }).catch(() => {}) // don't fail if admin_log has different schema

  // Send notification email via Resend if configured
  if (process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          from:    'CommandCenter <noreply@comandcenter.se>',
          to:      ['paul@laweka.com'],
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
        }),
      })
    } catch (e) {
      console.error('Email notification failed:', e)
    }
  }

  return NextResponse.json({ ok: true })
}
