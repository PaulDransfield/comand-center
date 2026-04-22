// instrumentation-client.ts
// Runs in the browser. Initialises Sentry for client-side error tracking.

import * as Sentry from '@sentry/nextjs'
import { scrubSentryEvent } from './lib/monitoring/sentry-scrub'

// No fallback DSN — see sentry.server.config.ts for rationale.
const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: DSN,

  // Release is auto-injected into the client bundle by the Sentry webpack
  // plugin (configured in next.config.js with release.name). Don't set it
  // here — process.env.VERCEL_GIT_COMMIT_SHA is server-side only.

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
