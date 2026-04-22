// sentry.edge.config.ts
// Runs in Vercel Edge middleware (auth checks before pages load).

import * as Sentry from '@sentry/nextjs'
import { scrubSentryEvent } from './lib/monitoring/sentry-scrub'

// No fallback DSN — see sentry.server.config.ts for rationale.
const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: DSN,
  release: process.env.VERCEL_GIT_COMMIT_SHA,  // must match next.config.js upload release
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  enabled:     process.env.NODE_ENV === 'production' && !!DSN,
  beforeSend:  scrubSentryEvent,
})
