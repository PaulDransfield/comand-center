// app/api/cron/integration-health-watchdog/route.ts
//
// Runs every 30 min. Finds integrations in status='needs_reauth' or
// 'error' that haven't been alerted in the last 24h, emails the org's
// primary owner with a one-click reconnect link, and stamps
// last_alert_sent_at so we don't spam.
//
// Without this, an integration breaks → owner only finds out when they
// click a feature that needs the API. At 20+ customers operators can't
// manually monitor. See SCALING-FORTNOX-AUTH.md.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret, checkAdminSecret } from '@/lib/admin/check-secret'
import { log } from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const ALERT_COOLDOWN_HOURS = 24

export async function GET(req: NextRequest)  { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }

async function handle(req: NextRequest) {
  noStore()
  if (!checkCronSecret(req) && !checkAdminSecret(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const cutoffIso = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString()

  // Find broken integrations not alerted recently. Two-status filter so
  // the cron also covers legacy 'error' rows (pre-M094 invalid_grant
  // path didn't flip needs_reauth).
  const { data: brokenRows, error } = await db
    .from('integrations')
    .select('id, org_id, business_id, provider, status, last_error, last_alert_sent_at, business:businesses(name), org:organisations(name)')
    .in('status', ['needs_reauth', 'error'])
    .or(`last_alert_sent_at.is.null,last_alert_sent_at.lt.${cutoffIso}`)
    .limit(200)
  if (error) {
    log.error('watchdog list failed', { route: 'cron/integration-health-watchdog', error: error.message })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!brokenRows || brokenRows.length === 0) {
    return NextResponse.json({ ok: true, alerted: 0, message: 'no broken integrations needing alert' })
  }

  // Resolve org owners — first email per org. M021/M033 pattern: load
  // owners via organisation_members.
  const orgIds = Array.from(new Set(brokenRows.map((r: any) => r.org_id)))
  const ownersByOrg = new Map<string, { email: string; name?: string }>()
  for (const orgId of orgIds) {
    const { data: member } = await db
      .from('organisation_members')
      .select('user_id, role')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!member) continue
    // Pull email from auth.users via the admin client
    const { data: userRes } = await db.auth.admin.getUserById(member.user_id)
    const email = userRes?.user?.email
    if (email) ownersByOrg.set(orgId, { email, name: userRes?.user?.user_metadata?.full_name as string | undefined })
  }

  const resendKey = process.env.RESEND_API_KEY
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'

  let alerted = 0
  const failures: any[] = []
  for (const row of brokenRows as any[]) {
    const owner = ownersByOrg.get(row.org_id)
    if (!owner) {
      failures.push({ id: row.id, reason: 'no_owner_email' })
      continue
    }
    const bizName  = (row.business as any)?.name ?? '(unnamed business)'
    const provider = String(row.provider).toUpperCase()
    const subject  = `[CommandCenter] ${provider} integration broken — reconnect needed (${bizName})`
    const reconnectUrl = `${appUrl}/integrations`
    const html = renderEmail({
      ownerName:    owner.name,
      provider,
      bizName,
      lastError:    row.last_error,
      reconnectUrl,
    })

    let emailOk = false
    if (resendKey) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    'CommandCenter <alerts@comandcenter.se>',
            to:      owner.email,
            subject,
            html,
          }),
        })
        emailOk = res.ok
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          failures.push({ id: row.id, email: owner.email, status: res.status, body: t.slice(0, 200) })
        }
      } catch (e: any) {
        failures.push({ id: row.id, email: owner.email, error: String(e?.message ?? e) })
      }
    } else {
      failures.push({ id: row.id, reason: 'no_resend_api_key' })
    }

    if (emailOk) {
      // Stamp last_alert_sent_at so we don't re-alert for 24h
      await db.from('integrations')
        .update({ last_alert_sent_at: new Date().toISOString() })
        .eq('id', row.id)
      alerted++
      log.info('watchdog alert sent', {
        route: 'cron/integration-health-watchdog',
        org_id: row.org_id, business_id: row.business_id,
        provider: row.provider, status: row.status,
      })
    }
  }

  return NextResponse.json({
    ok:        true,
    scanned:   brokenRows.length,
    alerted,
    failures:  failures.slice(0, 20),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

function renderEmail({ ownerName, provider, bizName, lastError, reconnectUrl }: {
  ownerName?: string; provider: string; bizName: string; lastError?: string | null; reconnectUrl: string
}): string {
  const greet = ownerName ? `Hi ${ownerName.split(' ')[0]},` : 'Hi,'
  const errBlock = lastError
    ? `<p style="background:#f9f4eb;border:1px solid #f3e5c5;padding:10px 14px;border-radius:6px;color:#5a4a16;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(lastError.slice(0, 400))}</p>`
    : ''
  return `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#1a1f2e;line-height:1.55;max-width:560px;margin:24px auto;padding:0 14px;">
  <h2 style="font-size:18px;margin-bottom:4px;color:#3a3550;">${escapeHtml(provider)} connection broken</h2>
  <p style="color:#6b7280;font-size:13px;margin-top:0;">${escapeHtml(bizName)}</p>
  <p>${greet}</p>
  <p>Your <strong>${escapeHtml(provider)}</strong> integration for <strong>${escapeHtml(bizName)}</strong> stopped working — the connection's refresh token expired or was rejected by ${escapeHtml(provider)}.</p>
  <p>While disconnected, sync paused. Recipe costs, invoice review and the Fortnox PDF viewer will be stale or unavailable until you reconnect.</p>
  ${errBlock}
  <p style="margin-top:24px;text-align:center;">
    <a href="${reconnectUrl}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block;">Reconnect ${escapeHtml(provider)}</a>
  </p>
  <p style="color:#6b7280;font-size:11px;margin-top:32px;">
    This alert is sent once per 24h per integration. You're receiving it because you're the primary owner of this CommandCenter organisation.
    <br><br>
    <a href="https://comandcenter.se" style="color:#7c3aed;text-decoration:none;">CommandCenter</a>
  </p>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
