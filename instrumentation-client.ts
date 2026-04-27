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

  // Replay integration is intentionally NOT installed (would add ~100 KB
  // gzipped to every client bundle). The replay sample-rate options that
  // used to live here were inert without the integration, so removed.
  // If we ever want crash replays, add `Sentry.replayIntegration()` to
  // an `integrations: [...]` array AND restore the rate options.
  // (Sprint 1.5 perf cleanup, FIXES §0dd.)

  environment: process.env.NODE_ENV,
  enabled:     process.env.NODE_ENV === 'production' && !!DSN,

  beforeSend:  scrubSentryEvent,
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
