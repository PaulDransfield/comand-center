// sentry.server.config.ts
// Runs on the server (API routes, server components).
// Captures crashes in our data-fetching code, Supabase queries, Stripe calls etc.

import * as Sentry from '@sentry/nextjs'
import { scrubSentryEvent } from './lib/monitoring/sentry-scrub'

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
        ?? 'https://e6da0dbd759e3972ded7b25c4d23984b@o4511222636216320.ingest.de.sentry.io/4511222639755344'

Sentry.init({
  dsn: DSN,

  // 10 % of transactions get a full perf trace. Raise temporarily during a
  // performance investigation; otherwise keep low to stay in free-tier quota.
  tracesSampleRate: 0.1,

  environment: process.env.NODE_ENV,
  enabled:     process.env.NODE_ENV === 'production' && !!DSN,

  // Redact obvious secrets (auth cookies, bearer tokens, API keys) before
  // events leave our server. Sentry is a US processor — GDPR defence-in-depth.
  beforeSend: scrubSentryEvent,
})
