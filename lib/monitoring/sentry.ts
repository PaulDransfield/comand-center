// lib/monitoring/sentry.ts
//
// Thin wrapper so the rest of the codebase imports from here rather than
// @sentry/nextjs directly. Two goals:
//   1. Consistent no-op when NEXT_PUBLIC_SENTRY_DSN is unset (local dev)
//   2. One place to tweak capture shape if Sentry's API changes

import * as Sentry from '@sentry/nextjs'

function sentryEnabled(): boolean {
  return process.env.NODE_ENV === 'production' && !!process.env.NEXT_PUBLIC_SENTRY_DSN
}

/**
 * Attach user/org context to the current Sentry scope. Called from
 * `getRequestAuth` as soon as we know who the caller is, so every error
 * captured in the rest of the request is tagged with the customer.
 */
export function setSentryUser(input: { orgId: string; userId: string; plan?: string }): void {
  if (!sentryEnabled()) return
  try {
    Sentry.setUser({ id: input.userId, segment: input.orgId })
    if (input.plan) Sentry.setTag('plan', input.plan)
    Sentry.setTag('org_id', input.orgId)
  } catch { /* swallow — monitoring should never break the request */ }
}

/**
 * Capture a caught error with structured extra context. Use at silent-catch
 * sites where losing the error would mean missing compliance / data integrity
 * signals (aggregation failures, audit-log failures, AI usage tracking).
 *
 * Prefer this over raw `console.error` for places the ops team needs to see.
 */
export function captureError(err: unknown, context?: Record<string, any>): void {
  if (!sentryEnabled()) {
    // In dev, still log so the developer sees it.
    console.error('[captureError]', err, context)
    return
  }
  try {
    Sentry.withScope(scope => {
      if (context) {
        for (const [k, v] of Object.entries(context)) {
          scope.setExtra(k, v)
        }
      }
      scope.setLevel('error')
      Sentry.captureException(err)
    })
  } catch {
    // Monitoring failure must never break the caller.
  }
}

/**
 * Lighter-weight capture for non-error events worth surfacing (e.g. "booster
 * activation failed but fell back"). Tagged as `warning` level in Sentry.
 */
export function captureWarning(message: string, context?: Record<string, any>): void {
  if (!sentryEnabled()) {
    console.warn('[captureWarning]', message, context)
    return
  }
  try {
    Sentry.withScope(scope => {
      if (context) {
        for (const [k, v] of Object.entries(context)) scope.setExtra(k, v)
      }
      scope.setLevel('warning')
      Sentry.captureMessage(message)
    })
  } catch {}
}
