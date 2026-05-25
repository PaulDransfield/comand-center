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

-- Schema migration:
--   Existing M018 table has columns (event_id, event_type, processed_at NOT NULL).
--   Need to:
--     1. Add claimed_at column (tracks "I'm in-flight on this event")
--     2. Drop NOT NULL on processed_at so claims can have NULL until done
--     3. Backfill claimed_at = processed_at for existing rows (which all
--        represent completed events under the old semantics)
DO $$
BEGIN
  -- Step 1: add claimed_at if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stripe_processed_events'
      AND column_name = 'claimed_at'
  ) THEN
    ALTER TABLE public.stripe_processed_events
      ADD COLUMN claimed_at TIMESTAMPTZ;
    RAISE NOTICE 'M103: added claimed_at to stripe_processed_events';
  ELSE
    RAISE NOTICE 'M103: claimed_at already present — skipping ADD';
  END IF;

  -- Step 2: drop NOT NULL on processed_at if present (new code stores
  -- NULL during processing and sets it once handleEvent completes)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stripe_processed_events'
      AND column_name = 'processed_at'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.stripe_processed_events
      ALTER COLUMN processed_at DROP NOT NULL,
      ALTER COLUMN processed_at DROP DEFAULT;
    RAISE NOTICE 'M103: dropped NOT NULL + DEFAULT on processed_at';
  ELSE
    RAISE NOTICE 'M103: processed_at already nullable or missing — skipping NOT NULL drop';
  END IF;
END $$;

-- Step 3: backfill claimed_at for existing rows. Every existing row
-- represents a completed event (old code only succeeded — and thus
-- only persisted — when handleEvent ran to completion), so claimed_at
-- should equal processed_at.
UPDATE public.stripe_processed_events
SET claimed_at = processed_at
WHERE claimed_at IS NULL
  AND processed_at IS NOT NULL;

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
