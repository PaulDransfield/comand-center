// instrumentation-client.ts
// Runs in the browser. Initialises Sentry for client-side error tracking.

import * as Sentry from '@sentry/nextjs'
import { scrubSentryEvent } from './lib/monitoring/sentry-scrub'

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
        ?? 'https://e6da0dbd759e3972ded7b25c4d23984b@o4511222636216320.ingest.de.sentry.io/4511222639755344'

Sentry.init({
  dsn: DSN,

  tracesSampleRate: 0.1,

  // Replay a short video of the DOM when a crash happens. 0 % session-replay
  // outside crashes keeps Sentry's replay quota untouched in normal usage.
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.0,

  environment: process.env.NODE_ENV,
  enabled:     process.env.NODE_ENV === 'production' && !!DSN,

  beforeSend:  scrubSentryEvent,
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
