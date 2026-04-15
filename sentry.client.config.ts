// sentry.client.config.ts
// Runs in the browser. Captures JS errors, unhandled promise rejections,
// and performance data from the user's session.

import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: 'https://e6da0dbd759e3972ded7b25c4d23984b@o4511222636216320.ingest.de.sentry.io/4511222639755344',

  // 10% of sessions recorded for performance — enough to spot slow pages
  // without burning through your Sentry quota.
  tracesSampleRate: 0.1,

  // Only record replays when an error actually happens — saves quota.
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.0,

  // Don't clutter Sentry with noise from browser extensions or local dev.
  environment: process.env.NODE_ENV,
  enabled: process.env.NODE_ENV === 'production',
})
