// app/api/admin/sentry-test/route.ts
//
// TEMPORARY — delete after Sentry verification.
//
// Produces two controlled events we can inspect in the Sentry dashboard:
//   1. An uncaught throw that hits @sentry/nextjs auto-instrumentation.
//      Used to verify: source maps resolve, event fires, scrubber strips
//      embedded tokens from the error message.
//   2. A structured captureError() call with context.
//      Used to verify: setSentryUser attached user/org/plan, captureError
//      extras survive the beforeSend hook, no cookies leak through.
//
// Protected by ADMIN_SECRET. Call with:
//   GET  /api/admin/sentry-test?mode=throw    → uncaught
//   GET  /api/admin/sentry-test?mode=capture  → handled (returns 200)

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { captureError, setSentryUser } from '@/lib/monitoring/sentry'

function authorised(req: NextRequest): boolean {
  const secret = req.headers.get('x-admin-secret')
              ?? req.nextUrl.searchParams.get('secret')
  const expected = process.env.ADMIN_SECRET
  return !!expected && secret === expected
}

// Fake tokens shaped like the real things. None are valid. Used purely to
// confirm the scrubber redacts them before the event leaves our server.
const POISONED_MESSAGE =
  'sentry scrubber test: ' +
  'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.ABCdefGHIjklMNOpqr ' +
  'sb-llzmixkrysduztsvmfzi-auth-token ' +
  'sk_live_51AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ' +
  'whsec_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ' +
  're_AbCdEfGhIjKlMnOpQrStUv ' +
  'sk-ant-api03-ABCdef123ghi456jkl789mno'

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  // Attach synthetic user/org/plan context so we can verify setSentryUser →
  // event tags wiring without needing a real logged-in session.
  setSentryUser({
    orgId:  '00000000-0000-0000-0000-0000sentrytest',
    userId: '00000000-0000-0000-0000-0000sentryusr1',
    plan:   'trial',
  })

  const mode = req.nextUrl.searchParams.get('mode') ?? 'capture'

  if (mode === 'throw') {
    throw new Error(POISONED_MESSAGE)
  }

  try {
    throw new Error(POISONED_MESSAGE)
  } catch (e) {
    captureError(e, {
      route:           'api/admin/sentry-test',
      phase:           'verification',
      poisoned_bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJjdHgiOiJ4In0.signaturePayload',
      poisoned_stripe: 'sk_live_51AbCdEfGhIjKlMnOpQrStUvWxYz9876543210',
      note:            'Every token above should appear as [REDACTED] in Sentry.',
    })
  }

  return NextResponse.json({
    ok:  true,
    msg: 'Sentry captureError fired. Check dashboard; tokens should be scrubbed.',
  })
}
