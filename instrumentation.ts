// instrumentation.ts
// Next.js instrumentation file — runs once when the server starts.
// This is the correct place for Sentry server + edge init in Next.js 14+.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}
