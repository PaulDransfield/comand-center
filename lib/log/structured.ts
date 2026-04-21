// lib/log/structured.ts
//
// Emits one JSON-per-line log record to stdout. Vercel's log pipeline
// indexes these as structured fields, which means we can query them
// (`route:fortnox/extract status:failed`) instead of grepping strings.
//
// Use in cron routes, background workers, and anywhere the ops team
// needs to audit behaviour after the fact. For user-facing request
// logs, Next.js already captures the basics — use this when you want
// to record domain state (job_id, duration_ms, attempts, etc.).
//
// Not a replacement for Sentry: Sentry owns *errors*; this owns
// *events*. A sync finishing successfully is an event, not an error.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  route?:     string
  op?:        string
  org_id?:    string
  user_id?:   string
  duration_ms?: number
  status?:    string
  [k: string]: unknown
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}) {
  const record = {
    ts:    new Date().toISOString(),
    level,
    msg,
    ...fields,
  }
  // One-line JSON — Vercel's log parser picks it up as structured.
  // stderr for warn/error so Sentry's transport captures them.
  const line = JSON.stringify(record)
  if (level === 'error' || level === 'warn') {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info:  (msg: string, fields?: LogFields) => emit('info',  msg, fields),
  warn:  (msg: string, fields?: LogFields) => emit('warn',  msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
}

// Measures the wall time of an async operation and logs the result.
// Useful wrapper for sync pipeline steps, cron bodies, and API
// externalcalls where duration matters for debugging.
export async function timed<T>(
  name: string,
  fields: LogFields,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    log.info(`${name} ok`, { ...fields, duration_ms: Date.now() - start, status: 'success' })
    return result
  } catch (e: any) {
    log.error(`${name} failed`, {
      ...fields,
      duration_ms: Date.now() - start,
      status:      'error',
      error:       e?.message ?? String(e),
    })
    throw e
  }
}
