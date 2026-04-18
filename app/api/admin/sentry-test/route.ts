// app/api/admin/sentry-test/route.ts
//
// TEMPORARY — delete after Sentry verification.
//
// Produces two controlled events we can inspect in the Sentry dashboard:
//   1. An uncaught throw that hits @sentry/nextjs auto-instrumentation.
//      Used to verify: source maps resolve, event fires, scrubber strips
//      embedded tokens from the error message.
//   2. A structured captureError() call with context.
//      Used to verify: setSentryUser attached org/user/plan, captureError
//      extras survive the beforeSend hook, no cookies leak through.
//
// Protected by ADMIN_SECRET. Call with:
//   GET  /api/admin/sentry-test?mode=throw    → uncaught
//   GET  /api/admin/sentry-test?mode=capture  → handled (returns 200)

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { captureError } from '@/lib/monitoring/sentry'

function authorised(req: NextRequest): boolean {
  const secret = req.headers.get('x-admin-secret')
              ?? req.nextUrl.searchParams.get('secret')
  const expected = process.env.ADMIN_SECRET
  return !!expected && secret === expected
}

// Fake tokens embedded verbatim so we can confirm the scrubber redacted them
// before the event left our server. These are NOT real secrets.
const POISONED_MESSAGE =
  'sentry scrubber test: Bearer eyJfake.payload.sig sb-llzmixkrysduztsvmfzi-auth-token ' +
  'sk_live_fake_stripe_key_123 whsec_fake_stripe_webhook re_fake_resend_token ' +
  'sk-ant-api03-fake-anthropic-key'

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const mode = req.nextUrl.searchParams.get('mode') ?? 'capture'

  if (mode === 'throw') {
    // Uncaught path — Sentry's auto-instrumentation should capture.
    throw new Error(POISONED_MESSAGE)
  }

  // Handled path — round-trips through our wrapper.
  try {
    throw new Error(POISONED_MESSAGE)
  } catch (e) {
    captureError(e, {
      route:           'api/admin/sentry-test',
      phase:           'verification',
      poisoned_bearer: 'Bearer eyJcontext.fake.sig',
      poisoned_stripe: 'sk_live_context_fake',
      note:            'Every token above should appear as [REDACTED] in Sentry.',
    })
  }

  return NextResponse.json({
    ok:  true,
    msg: 'Sentry captureError fired. Check dashboard; tokens should be scrubbed.',
  })
}
