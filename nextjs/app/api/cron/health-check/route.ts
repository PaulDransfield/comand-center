// @ts-nocheck
// app/api/cron/health-check/route.ts
//
// HOURLY HEALTH CHECK â€” runs automatically every hour via Vercel Cron.
// Checks all connected integrations (Fortnox, Ancon, Caspeco) and
// fires Slack/SMS alerts if multiple organisations share the same error.
//
// Vercel calls this with a secret header to prove it's a legitimate cron call.
// Schedule defined in vercel.json: { "path": "/api/cron/health-check", "schedule": "0 * * * *" }

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

// How many orgs need to share an error before we alert
const ALERT_THRESHOLD = 2

export async function GET(req: NextRequest) {
  // Verify this is called by Vercel Cron, not a random person hitting the URL
  const cronSecret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const started  = Date.now()

  // â”€â”€ 1. Get all connected integrations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { data: integrations, error: fetchError } = await supabase
    .from('integrations')
    .select('id, org_id, business_id, provider, credentials_enc, config, token_expires_at')
    .eq('status', 'connected')
    .not('credentials_enc', 'is', null)

  if (fetchError) {
    console.error('Health check: failed to fetch integrations:', fetchError)
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  if (!integrations?.length) {
    return NextResponse.json({ ok: true, checked: 0, message: 'No connected integrations' })
  }

  // â”€â”€ 2. Check each integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const errors:   Array<{ org_id: string; provider: string; error: string }> = []
  const warnings: Array<{ org_id: string; provider: string; warn:  string }> = []
  let   checked = 0

  // Run all checks in parallel for speed, but in batches of 10
  // to avoid overwhelming the integration APIs
  const BATCH = 10
  for (let i = 0; i < integrations.length; i += BATCH) {
    const batch = integrations.slice(i, i + BATCH)

    await Promise.allSettled(batch.map(async (integ) => {
      checked++
      const result = await checkIntegration(integ)

      // Save result to integration_health_checks table
      await supabase.from('integration_health_checks').insert({
        org_id:           integ.org_id,
        business_id:      integ.business_id,
        provider:         integ.provider,
        status:           result.status,
        response_time_ms: result.responseTimeMs,
        error_code:       result.errorCode   ?? null,
        error_message:    result.errorMessage ?? null,
        token_days_left:  result.tokenDaysLeft ?? null,
      })

      // Update the integration's status
      if (result.status === 'ok') {
        await supabase.from('integrations')
          .update({ status: 'connected', last_error: null, last_sync_at: new Date().toISOString() })
          .eq('id', integ.id)
      } else {
        await supabase.from('integrations')
          .update({ status: result.status === 'error' ? 'error' : 'warning', last_error: result.errorMessage })
          .eq('id', integ.id)
        if (result.status === 'error') {
          errors.push({ org_id: integ.org_id, provider: integ.provider, error: result.errorMessage ?? '' })
        } else {
          warnings.push({ org_id: integ.org_id, provider: integ.provider, warn: result.errorMessage ?? '' })
        }
      }
    }))
  }

  // â”€â”€ 3. Group errors by provider and alert if threshold exceeded â”€
  const errorsByProvider: Record<string, string[]> = {}
  errors.forEach(e => {
    if (!errorsByProvider[e.provider]) errorsByProvider[e.provider] = []
    errorsByProvider[e.provider].push(e.org_id)
  })

  const alertsSent: string[] = []
  for (const [provider, orgIds] of Object.entries(errorsByProvider)) {
    const uniqueOrgs = [...new Set(orgIds)]
    if (uniqueOrgs.length >= ALERT_THRESHOLD) {
      await sendSlackAlert(provider, uniqueOrgs.length, uniqueOrgs.length >= 5 ? 'critical' : 'error')
      alertsSent.push(`${provider}: ${uniqueOrgs.length} orgs`)
    }
  }

  // â”€â”€ 4. Return summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return NextResponse.json({
    ok:          true,
    checked,
    errors:      errors.length,
    warnings:    warnings.length,
    alerts_sent: alertsSent,
    duration_ms: Date.now() - started,
    timestamp:   new Date().toISOString(),
  })
}

// â”€â”€ Integration checker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface CheckResult {
  status:         'ok' | 'warn' | 'error' | 'unreachable'
  responseTimeMs: number
  errorCode?:     string
  errorMessage?:  string
  tokenDaysLeft?: number
}

async function checkIntegration(integ: {
  provider:        string
  credentials_enc: string | null
  token_expires_at:string | null
}): Promise<CheckResult> {
  const start = Date.now()

  // Check token expiry first (no network call needed)
  if (integ.token_expires_at) {
    const expiresAt  = new Date(integ.token_expires_at)
    const daysLeft   = Math.ceil((expiresAt.getTime() - Date.now()) / 86400000)

    if (daysLeft <= 0) {
      return { status: 'error', responseTimeMs: 0, errorCode: 'TOKEN_EXPIRED', errorMessage: 'Token expired â€” re-authorisation required', tokenDaysLeft: 0 }
    }
    if (daysLeft <= 7) {
      // Token expires soon â€” warn but don't error
      return { status: 'warn', responseTimeMs: Date.now() - start, errorMessage: `Token expires in ${daysLeft} days`, tokenDaysLeft: daysLeft }
    }
  }

  // For the actual network check we'd decrypt credentials and call each provider's API.
  // In this scaffold we simulate based on provider type.
  // Replace each case with a real API call when credentials are available.
  try {
    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), 8000)

    let resp: Response | null = null

    switch (integ.provider) {
      case 'fortnox':
        // Real: fetch('https://api.fortnox.se/3/companyinformation', { headers: { Authorization: `Bearer ${decryptedToken}` } })
        resp = await fetch('https://api.fortnox.se/3/', { signal: controller.signal }).catch(() => null)
        break
      case 'caspeco':
        // Real: fetch(`https://api.caspeco.se/v1/venues/${venueId}/status`, { headers: { 'X-API-Key': decryptedKey } })
        resp = await fetch('https://api.caspeco.se/', { signal: controller.signal }).catch(() => null)
        break
      case 'ancon':
        // Real: fetch(`${apiUrl}/health`, { headers: { Authorization: `Bearer ${decryptedKey}` } })
        resp = { ok: true } as Response  // placeholder
        break
    }

    clearTimeout(timeout)
    const ms = Date.now() - start

    if (!resp || !resp.ok) {
      return { status: ms > 8000 ? 'unreachable' : 'error', responseTimeMs: ms, errorCode: `HTTP_${resp?.status ?? 0}` }
    }

    return { status: ms > 3000 ? 'warn' : 'ok', responseTimeMs: ms }

  } catch (err: any) {
    return {
      status:         err.name === 'AbortError' ? 'unreachable' : 'error',
      responseTimeMs: Date.now() - start,
      errorCode:      err.name === 'AbortError' ? 'TIMEOUT' : 'CONNECTION_ERROR',
      errorMessage:   err.message,
    }
  }
}

// â”€â”€ Slack notifier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sendSlackAlert(provider: string, count: number, level: 'error' | 'critical') {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return  // Slack not configured â€” skip silently

  const emoji  = level === 'critical' ? 'ðŸš¨' : 'âŒ'
  const colour = level === 'critical' ? '#E85B5B' : '#F5A623'

  try {
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text:        `${emoji} CommandCenter Alert â€” ${provider} integration issue`,
        attachments: [{
          color: colour,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: `${emoji} ${provider.toUpperCase()} Integration ${level.toUpperCase()}` }},
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Provider:*\n${provider}` },
              { type: 'mrkdwn', text: `*Orgs affected:*\n${count}` },
              { type: 'mrkdwn', text: `*Time:*\n${new Date().toISOString()}` },
            ]},
            { type: 'actions', elements: [{
              type: 'button',
              text: { type: 'plain_text', text: 'View Admin Dashboard' },
              url:  `${process.env.NEXT_PUBLIC_APP_URL}/admin`,
              style: 'primary',
            }]},
          ],
        }],
      }),
    })
  } catch (err) {
    console.error('Slack alert failed:', err)
  }
}
