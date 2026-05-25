-- M103 — Stripe webhook idempotency hardening
-- =================================================================
-- The webhook today inserts a dedup row BEFORE running handleEvent.
-- If the Vercel function gets killed between the dedup insert and
-- handleEvent completing (OOM, timeout, network blip), the next
-- Stripe retry sees the duplicate row, treats it as already-processed,
-- and silently skips — leading to under-billing.
--
-- Fix: add a processed_at column. The dedup row marks intent to process;
-- only after handleEvent completes do we set processed_at. The dedup
-- check becomes:
--   - row missing               → fresh event, claim it
--   - row exists, processed_at  → genuine duplicate, skip safely
--   - row exists, NULL processed_at, claimed >60s ago → stale, take over
--   - row exists, NULL processed_at, claimed <60s ago → concurrent worker
--                                                       (return 429 so
--                                                       Stripe retries)
--
-- Idempotent.

-- Add the column if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stripe_processed_events'
      AND column_name = 'processed_at'
  ) THEN
    ALTER TABLE public.stripe_processed_events
      ADD COLUMN processed_at TIMESTAMPTZ,
      ADD COLUMN claimed_at   TIMESTAMPTZ;
    RAISE NOTICE 'M103: added processed_at + claimed_at to stripe_processed_events';
  ELSE
    RAISE NOTICE 'M103: stripe_processed_events already has processed_at — skipping schema change';
  END IF;
END $$;

-- Backfill: existing rows are all already-processed (the old code
-- inserted the row AFTER handleEvent — wait actually it was BEFORE.
-- But since the function would only have responded 200 to Stripe if
-- handleEvent completed, every existing row represents a completed
-- event from Stripe's POV. Safe to mark them all processed.
UPDATE public.stripe_processed_events
SET processed_at = COALESCE(processed_at, created_at, NOW()),
    claimed_at   = COALESCE(claimed_at,   created_at, NOW())
WHERE processed_at IS NULL;

-- Index for the dedup hot-path: lookups are by event_id (already PK)
-- and stale-check filters by processed_at IS NULL. A partial index
-- keeps the cost trivial — only in-flight events sit in it.
CREATE INDEX IF NOT EXISTS idx_stripe_processed_in_flight
  ON public.stripe_processed_events (claimed_at)
  WHERE processed_at IS NULL;

-- ── Claim RPC ──────────────────────────────────────────────────────
-- Atomic claim-or-detect-duplicate. Returns one of:
--   'claimed'       — fresh event, caller should run handleEvent
--   'duplicate'     — already processed, caller should return 200 to Stripe
--   'concurrent'    — another worker is processing it right now (< stale_ms),
--                     caller should return 429 so Stripe retries
--   'stale_takeover'— previous worker died mid-flight, caller should run
--                     handleEvent again (idempotent handlers required)
CREATE OR REPLACE FUNCTION claim_stripe_event(
  p_event_id   TEXT,
  p_event_type TEXT,
  p_stale_ms   INTEGER DEFAULT 60000
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_processed_at TIMESTAMPTZ;
  existing_claimed_at   TIMESTAMPTZ;
  stale_threshold       TIMESTAMPTZ;
BEGIN
  stale_threshold := NOW() - (p_stale_ms || ' milliseconds')::INTERVAL;

  -- Try the optimistic insert first. Most events are fresh.
  BEGIN
    INSERT INTO stripe_processed_events (event_id, event_type, claimed_at)
    VALUES (p_event_id, p_event_type, NOW());
    RETURN 'claimed';
  EXCEPTION WHEN unique_violation THEN
    -- Row exists — figure out which state it's in
    SELECT processed_at, claimed_at
      INTO existing_processed_at, existing_claimed_at
    FROM stripe_processed_events
    WHERE event_id = p_event_id;

    IF existing_processed_at IS NOT NULL THEN
      RETURN 'duplicate';
    END IF;

    IF existing_claimed_at IS NULL OR existing_claimed_at < stale_threshold THEN
      -- Previous worker died. Re-claim by bumping claimed_at.
      UPDATE stripe_processed_events
      SET claimed_at = NOW()
      WHERE event_id = p_event_id;
      RETURN 'stale_takeover';
    END IF;

    -- Another worker is actively processing — back off
    RETURN 'concurrent';
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_stripe_event(TEXT, TEXT, INTEGER) TO service_role;

-- Helper: mark an event processed (called after handleEvent succeeds)
CREATE OR REPLACE FUNCTION mark_stripe_event_processed(p_event_id TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE stripe_processed_events
  SET processed_at = NOW()
  WHERE event_id = p_event_id;
$$;

GRANT EXECUTE ON FUNCTION mark_stripe_event_processed(TEXT) TO service_role;

-- Verification:
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('claim_stripe_event', 'mark_stripe_event_processed');
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'stripe_processed_events';
