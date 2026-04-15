// instrumentation-client.ts
// Runs in the browser. Initialises Sentry for client-side error tracking.

import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: 'https://e6da0dbd759e3972ded7b25c4d23984b@o4511222636216320.ingest.de.sentry.io/4511222639755344',

  tracesSampleRate: 0.1,

  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.0,

  environment: process.env.NODE_ENV,
  enabled:     process.env.NODE_ENV === 'production',
})
