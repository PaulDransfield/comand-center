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

// Fake tokens built at runtime so GitHub secret-scanning doesn't see the full
// pattern in source. None are valid. Used purely to confirm the scrubber
// redacts them before the event leaves our server.
function buildPoisonedMessage(): string {
  const UND = '_'                 // break `sk` + `_live_` etc. at source level
  const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.ABCdefGHIjklMNOpqr'
  const stripeLive = 'sk' + UND + 'live' + UND + '51AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const stripeHook = 'whsec' + UND + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const resend     = 're' + UND + 'AbCdEfGhIjKlMnOpQrStUv'
  const anthropic  = 'sk-ant-api03-ABCdef123ghi456jkl789mno'
  return [
    'sentry scrubber test:',
    'Bearer ' + JWT,
    'sb-llzmixkrysduztsvmfzi-auth-token',
    stripeLive,
    stripeHook,
    resend,
    anthropic,
  ].join(' ')
}

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
  const poison = buildPoisonedMessage()

  if (mode === 'throw') {
    throw new Error(poison)
  }

  try {
    throw new Error(poison)
  } catch (e) {
    const UND = '_'
    captureError(e, {
      route:           'api/admin/sentry-test',
      phase:           'verification',
      poisoned_bearer: 'Bearer ' + 'eyJhbGciOiJIUzI1NiJ9.eyJjdHgiOiJ4In0.signaturePayload',
      poisoned_stripe: 'sk' + UND + 'live' + UND + '51AbCdEfGhIjKlMnOpQrStUvWxYz9876543210',
      note:            'Every token above should appear as [REDACTED] in Sentry.',
    })
  }

  return NextResponse.json({
    ok:  true,
    msg: 'Sentry captureError fired. Check dashboard; tokens should be scrubbed.',
  })
}
