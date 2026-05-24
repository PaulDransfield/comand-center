-- M095 — integrations.last_alert_sent_at
--
-- The watchdog cron checks every 30 min for integrations in
-- status='needs_reauth' or 'error' and emails the org owner. To avoid
-- spamming the same alert every 30 min, it stamps last_alert_sent_at
-- and skips rows alerted in the last 24h.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS integrations_needs_alert_idx
  ON public.integrations (status, last_alert_sent_at)
  WHERE status IN ('needs_reauth', 'error');
