// @ts-nocheck
// app/api/beta/signup/route.ts
//
// Handles beta program applications.
// Stores them in a beta_signups table and notifies via Slack.
//
// Required SQL (run in Supabase SQL Editor):
//
// CREATE TABLE beta_signups (
//   id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   name             TEXT NOT NULL,
//   email            TEXT UNIQUE NOT NULL,
//   restaurant_name  TEXT NOT NULL,
//   locations        TEXT,
//   pos_system       TEXT,
//   accounting       TEXT,
//   biggest_pain     TEXT,
//   referral         TEXT,
//   status           TEXT DEFAULT 'pending'
//                    CHECK (status IN ('pending','approved','rejected','onboarded')),
//   notes            TEXT,
//   approved_at      TIMESTAMPTZ,
//   created_at       TIMESTAMPTZ DEFAULT now()
// );
// -- No RLS needed â€” only accessible via service role key (admin only)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)

  const { name, email, restaurant_name, locations, pos_system, accounting, biggest_pain, referral } = body ?? {}

  if (!name?.trim() || !email?.trim() || !restaurant_name?.trim()) {
    return NextResponse.json({ error: 'Name, email, and restaurant name are required.' }, { status: 400 })
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Save to database
  const { error } = await supabase.from('beta_signups').insert({
    name, email, restaurant_name, locations, pos_system, accounting, biggest_pain, referral,
    status: 'pending',
  })

  if (error) {
    // Check for duplicate email
    if (error.code === '23505') {
      return NextResponse.json({
        error: 'This email is already registered for the beta. We\'ll be in touch soon!',
      }, { status: 409 })
    }
    console.error('Beta signup error:', error)
    return NextResponse.json({ error: 'Failed to save your application. Please try again.' }, { status: 500 })
  }

  // Send Slack notification (fire-and-forget â€” don't block the response)
  notifySlack({ name, email, restaurant_name, locations, pos_system, accounting }).catch(console.error)

  return NextResponse.json({ ok: true })
}

async function notifySlack(data: {
  name:            string
  email:           string
  restaurant_name: string
  locations:       string
  pos_system:      string
  accounting:      string
}) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return

  await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      text: `ðŸŽ‰ New beta signup: ${data.name} from ${data.restaurant_name}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `ðŸŽ‰ New beta application` }},
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Name:*\n${data.name}` },
          { type: 'mrkdwn', text: `*Restaurant:*\n${data.restaurant_name}` },
          { type: 'mrkdwn', text: `*Email:*\n${data.email}` },
          { type: 'mrkdwn', text: `*Locations:*\n${data.locations}` },
          { type: 'mrkdwn', text: `*POS:*\n${data.pos_system || 'Not specified'}` },
          { type: 'mrkdwn', text: `*Accounting:*\n${data.accounting || 'Not specified'}` },
        ]},
        { type: 'actions', elements: [{
          type:  'button',
          text:  { type: 'plain_text', text: 'View in Admin Dashboard' },
          url:   `${process.env.NEXT_PUBLIC_APP_URL}/admin#beta`,
          style: 'primary',
        }]},
      ],
    }),
  })
}
