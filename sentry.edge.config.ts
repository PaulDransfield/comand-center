// sentry.edge.config.ts
// Runs in Vercel Edge middleware (e.g. auth checks before pages load).

import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: 'https://e6da0dbd759e3972ded7b25c4d23984b@o4511222636216320.ingest.de.sentry.io/4511222639755344',

  tracesSampleRate: 0.1,

  environment: process.env.NODE_ENV,
  enabled: process.env.NODE_ENV === 'production',
})
