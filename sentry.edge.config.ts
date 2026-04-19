// sentry.edge.config.ts
// Runs in Vercel Edge middleware (auth checks before pages load).

import * as Sentry from '@sentry/nextjs'
import { scrubSentryEvent } from './lib/monitoring/sentry-scrub'

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
        ?? 'https://e6da0dbd759e3972ded7b25c4d23984b@o4511222636216320.ingest.de.sentry.io/4511222639755344'

Sentry.init({
  dsn: DSN,
  release: process.env.VERCEL_GIT_COMMIT_SHA,  // must match next.config.js upload release
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  enabled:     process.env.NODE_ENV === 'production' && !!DSN,
  beforeSend:  scrubSentryEvent,
})
