// sentry.server.config.ts
// Runs on the server (API routes, server components).
// Captures crashes in your data-fetching code, Supabase queries, Stripe calls etc.

import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: 'https://e6da0dbd759e3972ded7b25c4d23984b@o4511222636216320.ingest.de.sentry.io/4511222639755344',

  // Capture every server-side error — these are the ones that matter most.
  tracesSampleRate: 0.1,

  environment: process.env.NODE_ENV,
  enabled: process.env.NODE_ENV === 'production',
})
