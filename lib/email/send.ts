// lib/email/send.ts
//
// Shared wrapper around Resend's HTTP API. Replaces seven duplicated
// fetch() call sites, all of which previously had inconsistent error
// handling (some console.error, some swallow, none with timeout).
//
// Guarantees:
//   - 10-second timeout via AbortController — a hung Resend response
//     can no longer freeze a cron for the rest of its budget.
//   - Errors captured to Sentry with full context (to, subject, route)
//     so an undelivered critical alert is visible in ops, not lost.
//   - Structured log line on every attempt (success or failure) for
//     Vercel-log queries.
//   - Returns a typed result — callers can decide whether to re-try,
//     fall back (e.g. Slack), or surface to the user.
//
// Deliberately NOT using the Resend SDK — its fetch wrapper has a
// different error surface (throws on non-2xx) and no AbortController
// support in older versions. A thin fetch stays portable.

import { createHash } from 'crypto'
import { captureError } from '@/lib/monitoring/sentry'
import { log }          from '@/lib/log/structured'

export interface SendEmailArgs {
  from:        string
  to:          string | string[]
  subject:     string
  html:        string
  text?:       string
  reply_to?:   string
  headers?:    Record<string, string>
  /** Context for Sentry + logs — what triggered the send, which org/business, etc. */
  context?:    Record<string, any>
  /** Per-call timeout override. Default 10 000 ms. */
  timeoutMs?:  number
  /**
   * Idempotency key — Resend dedups identical (key + content) within 24h.
   * Provide when the caller needs exactly-once semantics across Vercel
   * function retries (e.g. cron-fired daily digests, post-payment receipts).
   * Default: auto-derived from sha1(from|to|subject|first-400-of-html) so
   * back-to-back identical sends get deduped even without an explicit key.
   * Max 256 chars per Resend docs.
   */
  idempotencyKey?: string
}

export interface SendEmailResult {
  ok:        boolean
  /** Resend's message id when successful; null on failure. */
  messageId: string | null
  status:    number | null
  error?:    string
}

export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    const err = 'RESEND_API_KEY not set'
    log.warn('resend skipped — no API key', { ...args.context, to_summary: Array.isArray(args.to) ? `${args.to.length} recipients` : args.to })
    return { ok: false, messageId: null, status: null, error: err }
  }

  const timeoutMs = args.timeoutMs ?? 10_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Derive an idempotency key when the caller didn't pass one. Resend
  // dedups (key + body) within 24h, so identical back-to-back sends get
  // collapsed even if a Vercel function retry resends them.
  // Max 256 chars per Resend; sha1 hex is 40, well under.
  const idemKey = args.idempotencyKey
    ?? createHash('sha1').update([
      args.from,
      Array.isArray(args.to) ? args.to.join(',') : args.to,
      args.subject,
      (args.html ?? '').slice(0, 400),
    ].join('|')).digest('hex')

  const started = Date.now()
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   `Bearer ${apiKey}`,
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        from:     args.from,
        to:       args.to,
        subject:  args.subject,
        html:     args.html,
        text:     args.text,
        reply_to: args.reply_to,
        headers:  args.headers,
      }),
    })

    const duration_ms = Date.now() - started

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      const errMsg = `Resend ${res.status}: ${bodyText.slice(0, 400)}`
      captureError(new Error(errMsg), {
        route:       'lib/email/send',
        op:          'resend.post',
        to_summary:  Array.isArray(args.to) ? `${args.to.length} recipients` : args.to,
        subject:     args.subject,
        status:      res.status,
        duration_ms,
        ...args.context,
      })
      log.error('resend send failed', {
        route:       'lib/email/send',
        duration_ms,
        http_status: res.status,
        subject:     args.subject,
        error:       errMsg,
        ...args.context,
      })
      return { ok: false, messageId: null, status: res.status, error: errMsg }
    }

    const json: any = await res.json().catch(() => ({}))
    log.info('resend send ok', {
      route:           'lib/email/send',
      duration_ms,
      http_status:     res.status,
      subject:         args.subject,
      message_id:      json?.id ?? null,
      idempotency_key: idemKey,
      ...args.context,
    })
    return { ok: true, messageId: json?.id ?? null, status: res.status }

  } catch (e: any) {
    const duration_ms = Date.now() - started
    const aborted = e?.name === 'AbortError'
    const errMsg = aborted
      ? `Resend timeout after ${timeoutMs}ms`
      : (e?.message ?? String(e))
    captureError(e, {
      route:       'lib/email/send',
      op:          aborted ? 'resend.timeout' : 'resend.fetch_error',
      to_summary:  Array.isArray(args.to) ? `${args.to.length} recipients` : args.to,
      subject:     args.subject,
      duration_ms,
      timeout_ms:  timeoutMs,
      ...args.context,
    })
    log.error(aborted ? 'resend timeout' : 'resend fetch error', {
      route:    'lib/email/send',
      duration_ms,
      subject:  args.subject,
      error:    errMsg,
      ...args.context,
    })
    return { ok: false, messageId: null, status: null, error: errMsg }
  } finally {
    clearTimeout(timer)
  }
}
