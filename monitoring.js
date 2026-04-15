/**
 * monitoring.js
 * lib/monitoring/monitoring.js
 * ─────────────────────────────────────────────────────────────────
 * Proactive monitoring system for Command Center.
 *
 * Files:
 *   lib/monitoring/health-checker.js  — integration health checks
 *   lib/monitoring/alerting.js        — Slack + SMS notifications
 *   lib/monitoring/analytics.js       — usage tracking + DAU/MAU
 *   pages/api/cron/health-check.js    — Vercel cron endpoint
 * ─────────────────────────────────────────────────────────────────
 */


// ══════════════════════════════════════════════════════════════════
// lib/monitoring/health-checker.js
// Runs health checks on all active integrations
// Called hourly by Vercel Cron
// ══════════════════════════════════════════════════════════════════

const HEALTH_TIMEOUT_MS = 8000;  // 8 second timeout per check

/**
 * checkFortnoxHealth(integration)
 * Validates Fortnox connection by fetching a lightweight endpoint.
 * Also checks token expiry so we can proactively refresh before it expires.
 */
export async function checkFortnoxHealth(integration) {
  const start = Date.now();
  try {
    // Decrypt credentials (never log them)
    const { access_token, expires_at } = decryptCredentials(integration.credentials_enc);

    // Check token expiry
    const expiresAt   = new Date(expires_at);
    const daysLeft    = Math.ceil((expiresAt - new Date()) / 86400000);
    const tokenWarning = daysLeft <= 7;

    if (daysLeft <= 0) {
      return { status:'error', error_code:'TOKEN_EXPIRED', error_message:'Fortnox access token has expired — needs re-authorisation', token_days_left:0, response_time_ms:0 };
    }

    // Lightweight API call to validate token
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const resp = await fetch('https://api.fortnox.se/3/companyinformation', {
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const ms = Date.now() - start;

    if (resp.status === 401) return { status:'error', error_code:'TOKEN_INVALID', error_message:'Fortnox token rejected — re-authorisation required', response_time_ms:ms };
    if (resp.status === 429) return { status:'warn',  error_code:'RATE_LIMITED',  error_message:'Fortnox API rate limit hit', response_time_ms:ms };
    if (!resp.ok)            return { status:'error', error_code:`HTTP_${resp.status}`, error_message:`Fortnox returned ${resp.status}`, response_time_ms:ms };

    return {
      status:          tokenWarning ? 'warn' : 'ok',
      response_time_ms:ms,
      token_days_left: daysLeft,
      error_message:   tokenWarning ? `Token expires in ${daysLeft} days — refresh soon` : null,
    };
  } catch (err) {
    return {
      status:           err.name === 'AbortError' ? 'error' : 'unreachable',
      error_code:       err.name === 'AbortError' ? 'TIMEOUT' : 'CONNECTION_ERROR',
      error_message:    err.message,
      response_time_ms: Date.now() - start,
    };
  }
}

/**
 * checkCaspecoHealth(integration)
 */
export async function checkCaspecoHealth(integration) {
  const start = Date.now();
  try {
    const { api_key, venue_id } = decryptCredentials(integration.credentials_enc);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const resp = await fetch(`https://api.caspeco.se/v1/venues/${venue_id}/status`, {
      headers: { 'X-API-Key': api_key },
      signal:  controller.signal,
    });
    const ms   = Date.now() - start;

    if (!resp.ok) return { status:'error', error_code:`HTTP_${resp.status}`, error_message:`Caspeco returned ${resp.status}`, response_time_ms:ms };
    return { status: ms > 3000 ? 'warn' : 'ok', response_time_ms:ms };
  } catch (err) {
    return { status:'error', error_code:'CONNECTION_ERROR', error_message:err.message, response_time_ms:Date.now()-start };
  }
}

/**
 * checkAnconHealth(integration)
 */
export async function checkAnconHealth(integration) {
  const start = Date.now();
  try {
    const { api_url, api_key } = decryptCredentials(integration.credentials_enc);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const resp = await fetch(`${api_url}/health`, { headers:{ 'Authorization':`Bearer ${api_key}` }, signal:controller.signal });
    const ms   = Date.now() - start;
    if (!resp.ok) return { status:'error', error_code:`HTTP_${resp.status}`, error_message:`Ancon returned ${resp.status}`, response_time_ms:ms };
    return { status:'ok', response_time_ms:ms };
  } catch (err) {
    return { status:'error', error_code:'CONNECTION_ERROR', error_message:err.message, response_time_ms:Date.now()-start };
  }
}

/**
 * runAllHealthChecks(supabase)
 * Runs checks for every active integration.
 * Saves results to integration_health_checks table.
 * Returns summary for alerting.
 */
export async function runAllHealthChecks(supabase) {
  const { data: integrations } = await supabase
    .from('integrations')
    .select('id, org_id, business_id, provider, credentials_enc, config')
    .eq('status', 'connected')  // only check connected integrations
    .not('credentials_enc', 'is', null);

  if (!integrations?.length) return { checked:0, errors:[], warnings:[] };

  const checkers = { fortnox:checkFortnoxHealth, caspeco:checkCaspecoHealth, ancon:checkAnconHealth };
  const errors   = [];
  const warnings = [];
  let   checked  = 0;

  // Run all checks in parallel batches of 10
  const BATCH = 10;
  for (let i = 0; i < integrations.length; i += BATCH) {
    const batch   = integrations.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (integ) => {
        const checker = checkers[integ.provider];
        if (!checker) return;

        const result  = await checker(integ);
        checked++;

        // Save to DB
        await supabase.from('integration_health_checks').insert({
          org_id:          integ.org_id,
          business_id:     integ.business_id,
          provider:        integ.provider,
          status:          result.status,
          response_time_ms:result.response_time_ms,
          error_code:      result.error_code || null,
          error_message:   result.error_message || null,
          token_days_left: result.token_days_left || null,
          token_expires_at:result.token_expires_at || null,
        });

        // Update integration status
        if (result.status !== 'ok') {
          await supabase.from('integrations').update({
            status:     result.status === 'error' ? 'error' : 'warning',
            last_error: result.error_message,
            updated_at: new Date().toISOString(),
          }).eq('id', integ.id);
        } else {
          await supabase.from('integrations').update({
            status:     'connected',
            last_error: null,
            last_sync_at: new Date().toISOString(),
          }).eq('id', integ.id);
        }

        if (result.status === 'error')   errors.push({ org_id:integ.org_id, provider:integ.provider, error:result.error_message });
        if (result.status === 'warn')    warnings.push({ org_id:integ.org_id, provider:integ.provider, warn:result.error_message });
      })
    );
  }

  return { checked, errors, warnings };
}


// ══════════════════════════════════════════════════════════════════
// lib/monitoring/alerting.js
// Sends alerts when multiple users hit the same error
// ══════════════════════════════════════════════════════════════════

const ALERT_THRESHOLD = 2;  // alert when 2+ orgs have same error

/**
 * processHealthResults(results, supabase)
 * Groups errors by provider, creates alerts if threshold exceeded.
 */
export async function processHealthResults(results, supabase) {
  const { errors, warnings } = results;

  // Group by provider
  const errorsByProvider = {};
  errors.forEach(e => {
    if (!errorsByProvider[e.provider]) errorsByProvider[e.provider] = [];
    errorsByProvider[e.provider].push(e.org_id);
  });

  for (const [provider, orgIds] of Object.entries(errorsByProvider)) {
    const count = [...new Set(orgIds)].length;  // unique orgs

    if (count >= ALERT_THRESHOLD) {
      // Upsert alert (deduplicated by fingerprint)
      const fingerprint = `${provider}_errors_${new Date().toISOString().slice(0,10)}`;
      const { data: alert } = await supabase.rpc('upsert_alert', {
        p_level:         count >= 5 ? 'critical' : 'error',
        p_category:      'integration',
        p_title:         `${provider.charAt(0).toUpperCase()+provider.slice(1)} errors — ${count} org${count>1?'s':''} affected`,
        p_body:          `${count} organisations are experiencing ${provider} integration errors. This may indicate a provider outage.`,
        p_fingerprint:   fingerprint,
        p_affected_orgs: count,
        p_provider:      provider,
      });

      // Only notify if this is a new alert (not an update)
      if (alert?.data?.notified_slack === false) {
        await notifySlack(provider, count, orgIds, count >= 5 ? 'critical' : 'error');
        if (count >= 5) await notifySMS(provider, count);

        await supabase.from('system_alerts').update({
          notified_slack: true,
          notified_at:    new Date().toISOString(),
        }).eq('id', alert.data.id);
      }
    }
  }

  // Token expiry warnings
  const tokenWarnings = warnings.filter(w => w.warn?.includes('expires'));
  if (tokenWarnings.length >= 3) {
    await notifySlack('fortnox', tokenWarnings.length, [], 'warning', 'Token renewal needed');
  }
}

/**
 * notifySlack(provider, affectedCount, orgIds, level, customMsg)
 */
export async function notifySlack(provider, affectedCount, orgIds, level='error', customMsg=null) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) { console.warn('SLACK_WEBHOOK_URL not set'); return; }

  const emoji     = { critical:'🚨', error:'❌', warning:'⚠️', info:'ℹ️' }[level] || '⚠️';
  const colourHex = { critical:'#E85B5B', error:'#F5A623', warning:'#F5A623', info:'#5B9CF6' }[level] || '#F5A623';

  const payload = {
    text:        `${emoji} Command Center Alert — ${provider} integration`,
    attachments: [{
      color:    colourHex,
      fallback: `${provider} integration ${level}: ${affectedCount} orgs affected`,
      blocks: [
        { type:'header', text:{ type:'plain_text', text:`${emoji} ${provider.toUpperCase()} Integration ${level.toUpperCase()}` }},
        { type:'section', fields:[
          { type:'mrkdwn', text:`*Provider:*\n${provider}` },
          { type:'mrkdwn', text:`*Orgs affected:*\n${affectedCount}` },
          { type:'mrkdwn', text:`*Level:*\n${level}` },
          { type:'mrkdwn', text:`*Time:*\n${new Date().toISOString()}` },
        ]},
        ...(customMsg ? [{ type:'section', text:{ type:'mrkdwn', text:customMsg }}] : []),
        { type:'actions', elements:[{
          type:'button', text:{ type:'plain_text', text:'View Admin Dashboard' },
          url: `${process.env.NEXT_PUBLIC_APP_URL}/admin/alerts`, style:'primary',
        }]},
      ],
    }],
  };

  try {
    const resp = await fetch(webhookUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!resp.ok) console.error('Slack webhook failed:', resp.status);
  } catch (err) {
    console.error('Slack notification failed:', err);
  }
}

/**
 * notifySMS(provider, affectedCount)
 * Sends SMS via Twilio for critical alerts.
 */
export async function notifySMS(provider, affectedCount) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const toNumber   = process.env.ADMIN_PHONE_NUMBER;

  if (!accountSid || !toNumber) { console.warn('Twilio not configured'); return; }

  const message = `🚨 CRITICAL: ${provider} down — ${affectedCount} orgs affected. Check admin dashboard.`;

  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
      body: new URLSearchParams({ To:toNumber, From:fromNumber, Body:message }),
    });
    if (!resp.ok) console.error('SMS failed:', await resp.text());
  } catch (err) {
    console.error('SMS notification failed:', err);
  }
}


// ══════════════════════════════════════════════════════════════════
// lib/monitoring/analytics.js
// Usage tracking for DAU/MAU, feature usage, churning detection
// ══════════════════════════════════════════════════════════════════

/**
 * recordActivity(orgId, userId, activityType, supabase)
 * Call this whenever a user does something significant.
 * activityType: 'login' | 'ai_query' | 'doc_upload' | 'export' | 'integration_sync'
 */
export async function recordActivity(orgId, userId, activityType, supabase) {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  // Update activity summary (upsert)
  const updates = {
    updated_at:   now.toISOString(),
    is_churning:  false,
  };
  if (activityType === 'login')      { updates.last_login      = now.toISOString(); updates.logins_30d     = 1; }
  if (activityType === 'ai_query')   { updates.last_ai_query   = now.toISOString(); updates.ai_queries_30d = 1; }
  if (activityType === 'doc_upload') { updates.last_doc_upload = now.toISOString(); }

  // In production use a proper atomic increment via a stored procedure
  await supabase.from('user_activity_summary').upsert({ org_id:orgId, ...updates });
}

/**
 * detectChurningAccounts(supabase)
 * Marks accounts as churning if no login in 30+ days.
 * Called daily by cron.
 */
export async function detectChurningAccounts(supabase) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();

  // Find orgs with no activity in 30 days
  const { data: inactive } = await supabase
    .from('user_activity_summary')
    .select('org_id, last_login')
    .or(`last_login.lt.${cutoff},last_login.is.null`)
    .eq('is_churning', false);

  if (!inactive?.length) return [];

  // Mark as churning
  await supabase.from('user_activity_summary').upsert(
    inactive.map(r => ({ org_id:r.org_id, is_churning:true, updated_at:new Date().toISOString() }))
  );

  // Create support tickets for churning users if they're on a paid plan
  for (const { org_id } of inactive) {
    const { data:org } = await supabase.from('organisations').select('plan,name').eq('id',org_id).single();
    if (org?.plan !== 'trial' && org?.plan !== 'free') {
      await supabase.from('support_tickets').insert({
        org_id,
        subject:        `Inactive account check-in — ${org.name}`,
        status:         'open',
        priority:       'low',
        category:       'general',
        is_auto_created: true,
        diagnostic_snapshot: { inactive_days:30, plan:org.plan },
      });
    }
  }

  return inactive;
}

/**
 * getAnalyticsSummary(supabase)
 * Returns DAU/MAU, feature usage, and AI cost breakdown.
 * Used by admin dashboard overview.
 */
export async function getAnalyticsSummary(supabase) {
  const now        = new Date();
  const month      = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const day1Ago    = new Date(now - 86400000).toISOString();
  const day7Ago    = new Date(now - 7*86400000).toISOString();
  const day30Ago   = new Date(now - 30*86400000).toISOString();

  const [dauR, wauR, mauR, usageR, churningR] = await Promise.all([
    // DAU: orgs active in last 24h
    supabase.from('user_activity_summary').select('org_id', {count:'exact',head:true}).gte('last_login', day1Ago),
    // WAU
    supabase.from('user_activity_summary').select('org_id', {count:'exact',head:true}).gte('last_login', day7Ago),
    // MAU
    supabase.from('user_activity_summary').select('org_id', {count:'exact',head:true}).gte('last_login', day30Ago),
    // AI usage this month
    supabase.from('ai_usage').select('total_tokens,total_requests,total_cost_usd').eq('month', month),
    // Churning accounts
    supabase.from('user_activity_summary').select('org_id', {count:'exact',head:true}).eq('is_churning', true),
  ]);

  const totalTokens  = usageR.data?.reduce((s,r) => s + (r.total_tokens||0), 0) || 0;
  const totalCostUsd = usageR.data?.reduce((s,r) => s + parseFloat(r.total_cost_usd||0), 0) || 0;

  return {
    dau:           dauR.count || 0,
    wau:           wauR.count || 0,
    mau:           mauR.count || 0,
    churning:      churningR.count || 0,
    ai_tokens_month:  totalTokens,
    ai_cost_usd_month:totalCostUsd,
    ai_requests_month: usageR.data?.reduce((s,r) => s + (r.total_requests||0), 0) || 0,
  };
}


// ══════════════════════════════════════════════════════════════════
// pages/api/cron/health-check.js
// Vercel Cron endpoint — runs every hour
// Register in vercel.json: { "path":"/api/cron/health-check", "schedule":"0 * * * *" }
// ══════════════════════════════════════════════════════════════════
export const healthCheckCronCode = `
import { createAdminClient }    from '@/lib/supabase/server';
import { runAllHealthChecks }   from '@/lib/monitoring/health-checker';
import { processHealthResults } from '@/lib/monitoring/alerting';

export default async function handler(req, res) {
  // Verify this is called by Vercel Cron (not a random HTTP request)
  if (req.headers.authorization !== \`Bearer \${process.env.CRON_SECRET}\`) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const supabase = createAdminClient();
  const started  = Date.now();

  try {
    const results = await runAllHealthChecks(supabase);
    await processHealthResults(results, supabase);

    res.json({
      ok:       true,
      checked:  results.checked,
      errors:   results.errors.length,
      warnings: results.warnings.length,
      duration: Date.now() - started,
    });
  } catch (err) {
    console.error('Health check cron failed:', err);
    res.status(500).json({ error: err.message });
  }
}
`;


// ══════════════════════════════════════════════════════════════════
// ENVIRONMENT VARIABLES NEEDED
// ══════════════════════════════════════════════════════════════════
const ENV_VARS_NEEDED = `
# Slack webhook (create at api.slack.com/apps → Incoming Webhooks)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...

# Twilio SMS (optional — for critical alerts only)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+46...
ADMIN_PHONE_NUMBER=+46701234567

# Admin 2FA (TOTP secret — generate with: node -e "require('crypto').randomBytes(20).toString('hex')")
ADMIN_TOTP_SECRET=...
ADMIN_IP_WHITELIST=194.x.x.x,85.x.x.x  # optional, comma-separated

# Cron auth
CRON_SECRET=any-random-secret-string
`;

// ══════════════════════════════════════════════════════════════════
// STUB for credential decryption (replace with real implementation)
// ══════════════════════════════════════════════════════════════════
function decryptCredentials(encryptedJson) {
  // This calls your AES-256-GCM decryption from credential-encryption.js
  // return decrypt(encryptedJson, process.env.CREDENTIAL_ENCRYPTION_KEY);
  return JSON.parse(encryptedJson || '{}');  // DEMO ONLY — replace with real decrypt
}
