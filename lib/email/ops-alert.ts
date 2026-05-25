// lib/email/ops-alert.ts
//
// Tiny convenience wrapper for internal ops alerts (cron failures,
// integration mass-outages, etc.). Plain-text body, sends to the OPS
// alert recipient configured via env. No HTML — these go to the
// founder's inbox and stay deliberately minimal.
//
// Configuration:
//   OPS_ALERT_EMAIL — recipient (defaults to paul@comandcenter.se)
//   OPS_ALERT_FROM  — sender (defaults to alerts@comandcenter.se)
//
// Caller is responsible for catching errors — this helper resolves with
// an SendEmailResult either way. Don't let a missed alert break the
// caller's main flow.

import { sendEmail, type SendEmailResult } from './send'

export interface OpsAlertArgs {
  subject: string
  /** Plain-text body. Will be wrapped in a minimal HTML envelope too. */
  body:    string
  /** Optional override of recipient (defaults to OPS_ALERT_EMAIL env). */
  to?:     string
}

export async function sendOpsEmail(args: OpsAlertArgs): Promise<SendEmailResult> {
  const to   = args.to ?? process.env.OPS_ALERT_EMAIL ?? 'paul@comandcenter.se'
  const from = process.env.OPS_ALERT_FROM ?? 'alerts@comandcenter.se'

  const html = `<pre style="font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-wrap: break-word; padding: 16px; background: #f8f9fb; border-radius: 6px;">${escapeHtml(args.body)}</pre>`

  return sendEmail({
    from,
    to,
    subject: args.subject,
    html,
    text:    args.body,
    context: { kind: 'ops_alert', subject: args.subject },
    timeoutMs: 8_000,
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
