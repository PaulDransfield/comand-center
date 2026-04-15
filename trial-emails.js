/**
 * trial-emails.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends trial reminder emails using Resend (resend.com — free tier: 3000/month).
 *
 * Deploy as a Supabase Edge Function or a Vercel Cron Job:
 *   vercel.json → { "crons": [{ "path": "/api/cron/trial-emails", "schedule": "0 9 * * *" }] }
 *
 * This runs daily at 09:00 and sends the right email to the right users.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

const resend   = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const APP_NAME = 'Command Center';
const APP_URL  = process.env.NEXT_PUBLIC_APP_URL || 'https://commandcenter.se';
const FROM     = 'Command Center <hello@commandcenter.se>';

// ── CRON HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Verify this is a legitimate cron call (Vercel sets this header)
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = await sendTrialEmails();
  res.json(results);
}

async function sendTrialEmails() {
  const now    = new Date();
  const log    = [];

  // ── Fetch all active trial orgs with their owner email ──────────────────
  const { data: orgs } = await supabase
    .from('organisations')
    .select(`
      id, name, trial_end,
      organisation_members!inner (
        role,
        users!inner ( email, full_name )
      )
    `)
    .eq('plan', 'trial')
    .eq('is_active', true)
    .eq('organisation_members.role', 'owner');

  if (!orgs) return { sent: 0, errors: 0 };

  for (const org of orgs) {
    const trialEnd     = new Date(org.trial_end);
    const graceEnd     = new Date(trialEnd.getTime() + 7 * 86400000);
    const daysLeft     = Math.ceil((trialEnd - now) / 86400000);
    const graceDaysLeft= Math.ceil((graceEnd  - now) / 86400000);

    const owner = org.organisation_members?.[0]?.users;
    if (!owner?.email) continue;

    let emailType = null;

    // ── Decide which email to send ─────────────────────────────────────
    if      (daysLeft === 7)  emailType = '7_days';
    else if (daysLeft === 3)  emailType = '3_days';
    else if (daysLeft === 1)  emailType = '1_day';
    else if (daysLeft === 0)  emailType = 'expired';
    else if (graceDaysLeft === 3) emailType = 'grace_3_days';
    else if (graceDaysLeft === 1) emailType = 'grace_1_day';

    if (!emailType) continue;

    // ── Check we haven't already sent this email today ─────────────────
    const { data: alreadySent } = await supabase
      .from('email_log')
      .select('id')
      .eq('org_id', org.id)
      .eq('email_type', emailType)
      .gte('sent_at', new Date(now - 86400000).toISOString())
      .maybeSingle();

    if (alreadySent) continue;

    // ── Send the email ─────────────────────────────────────────────────
    try {
      await sendEmail(emailType, owner.email, {
        name:          owner.full_name || 'there',
        org_name:      org.name,
        days_left:     daysLeft,
        grace_days:    graceDaysLeft,
        trial_end:     trialEnd.toLocaleDateString('sv-SE'),
        upgrade_url:   `${APP_URL}/upgrade?org=${org.id}`,
      });

      // Log the send so we don't duplicate
      await supabase.from('email_log').insert({
        org_id:     org.id,
        email_type: emailType,
        sent_to:    owner.email,
        sent_at:    now.toISOString(),
      });

      log.push({ org: org.name, email: emailType, to: owner.email });
    } catch (err) {
      console.error(`Email failed for ${org.name}:`, err);
      log.push({ org: org.name, email: emailType, error: err.message });
    }
  }

  return { sent: log.filter(l => !l.error).length, errors: log.filter(l => l.error).length, log };
}

// ── EMAIL TEMPLATES ──────────────────────────────────────────────────────────

async function sendEmail(type, to, data) {
  const templates = {

    '7_days': {
      subject: `${data.days_left} days left in your ${APP_NAME} trial`,
      html: emailHtml(`
        <h2>Your trial ends in ${data.days_left} days</h2>
        <p>Hi ${data.name},</p>
        <p>Just a reminder that your <strong>${APP_NAME}</strong> trial for <strong>${data.org_name}</strong>
        ends on <strong>${data.trial_end}</strong>.</p>
        <p>You've had full access to AI-powered financial insights, automated reporting, and invoice processing.
        Don't lose access — upgrade today and keep everything running.</p>
        ${upgradeBtn(data.upgrade_url)}
        <p style="color:#6b6860;font-size:13px">Questions? Reply to this email and we'll help.</p>
      `),
    },

    '3_days': {
      subject: `Only 3 days left — upgrade ${APP_NAME} now`,
      html: emailHtml(`
        <h2 style="color:#854F0B">3 days remaining</h2>
        <p>Hi ${data.name},</p>
        <p>Your <strong>${APP_NAME}</strong> trial ends in <strong>3 days</strong> on ${data.trial_end}.</p>
        <p>After that, you'll lose access to your financial dashboard, AI chat, and automated reports.</p>
        <p>Upgrade takes less than 2 minutes.</p>
        ${upgradeBtn(data.upgrade_url)}
      `),
    },

    '1_day': {
      subject: `Last chance — your trial ends tomorrow`,
      html: emailHtml(`
        <h2 style="color:#A32D2D">Your trial ends tomorrow</h2>
        <p>Hi ${data.name},</p>
        <p>This is your last reminder. Your <strong>${APP_NAME}</strong> trial for
        <strong>${data.org_name}</strong> expires tomorrow.</p>
        <p>Upgrade now to avoid any interruption to your service.</p>
        ${upgradeBtn(data.upgrade_url, 'Upgrade now — 2 minutes')}
      `),
    },

    'expired': {
      subject: `Your ${APP_NAME} trial has ended`,
      html: emailHtml(`
        <h2>Your trial has ended</h2>
        <p>Hi ${data.name},</p>
        <p>Your <strong>${APP_NAME}</strong> trial has ended. Your data is safe —
        we've kept everything for you during a <strong>7-day grace period</strong>.</p>
        <p>You can still log in and view your data in read-only mode.
        Upgrade in the next ${data.grace_days} days to restore full access.</p>
        ${upgradeBtn(data.upgrade_url, 'Restore full access')}
      `),
    },

    'grace_3_days': {
      subject: `3 days to save your ${APP_NAME} data`,
      html: emailHtml(`
        <h2 style="color:#854F0B">Your data will be locked in 3 days</h2>
        <p>Hi ${data.name},</p>
        <p>Your grace period ends in <strong>3 days</strong>. After that, your
        <strong>${APP_NAME}</strong> account will be locked and you will no longer be able
        to access your financial data, documents, or chat history.</p>
        <p>Your data will be preserved for 90 days after locking, but you will need
        to upgrade to access it again.</p>
        ${upgradeBtn(data.upgrade_url, 'Unlock my account')}
      `),
    },

    'grace_1_day': {
      subject: `Final warning: account locks tomorrow`,
      html: emailHtml(`
        <h2 style="color:#A32D2D">Account locks tomorrow</h2>
        <p>Hi ${data.name},</p>
        <p>This is your final notice. Your <strong>${APP_NAME}</strong> account will be
        locked tomorrow. All your financial data, documents, and reports will become
        inaccessible.</p>
        <p>Upgrade now — it takes 2 minutes and your account will be restored instantly.</p>
        ${upgradeBtn(data.upgrade_url, 'Upgrade now')}
        <p style="color:#6b6860;font-size:13px">
          Need help? Reply to this email and we'll sort it out.
        </p>
      `),
    },

  };

  const template = templates[type];
  if (!template) throw new Error(`Unknown email type: ${type}`);

  await resend.emails.send({
    from:    FROM,
    to,
    subject: template.subject,
    html:    template.html,
  });
}

// ── EMAIL HTML WRAPPER ───────────────────────────────────────────────────────

function emailHtml(body) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f4f1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f1;padding:40px 20px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <!-- Header -->
  <tr><td style="background:#1E2761;padding:24px 32px">
    <span style="color:white;font-size:18px;font-weight:600;letter-spacing:.02em">Command Center</span>
  </td></tr>
  <!-- Body -->
  <tr><td style="padding:32px;color:#1a1917;font-size:15px;line-height:1.7">
    ${body}
  </td></tr>
  <!-- Footer -->
  <tr><td style="padding:20px 32px;border-top:1px solid #e2e0db;color:#9b9690;font-size:12px;line-height:1.6">
    Command Center · Restaurant Business Intelligence<br>
    You're receiving this because you signed up for a trial.<br>
    <a href="${APP_URL}/unsubscribe" style="color:#9b9690">Unsubscribe</a>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function upgradeBtn(url, label = 'Upgrade now') {
  return `<p style="margin:24px 0">
    <a href="${url}" style="display:inline-block;background:#1E2761;color:white;
      text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;
      font-size:15px">${label}</a>
  </p>`;
}
