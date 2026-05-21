-- M077 — Review summary persistence + reply tracking
--
-- Two gaps from the original M074 review-intelligence layer:
--
--   1. Google Places returns BOTH per-review data AND the overall
--      summary (rating + total review count). M074 captured the
--      per-review rows; the summary was thrown away after each sync.
--      Result: a customer with 278 reviews on Google would see
--      "5 reviews" on the page (the Places API's per-call cap) — no
--      indication of the real total. This adds three columns on
--      `businesses` so the sync can persist the summary, and the
--      page can show "278 total · 5 most recent · 4.7★".
--
--   2. The original /reviews design (Phase 3 of OVERHAUL-PROMPT-PACK
--      §reviews) calls for KPIs: rating · replied · needs-reply ·
--      avg-response. We need a way to mark a review as replied and
--      record when. Google Places API doesn't expose reply-state
--      (that's a Google Business Profile API feature, behind owner
--      OAuth), so for now this is an owner-driven manual workflow:
--      owner replies on Google, then hits "Mark as replied" here.
--
-- Idempotent — all ALTERs are IF NOT EXISTS.

-- ── 1. Per-business review summary ──────────────────────────────────

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS google_review_count    INTEGER,
  ADD COLUMN IF NOT EXISTS google_overall_rating  NUMERIC(3, 2),
  ADD COLUMN IF NOT EXISTS google_last_sync_at    TIMESTAMPTZ;

COMMENT ON COLUMN public.businesses.google_review_count IS
  'Google Places userRatingCount — total reviews on Google Maps. Often far higher than the rows we have in review_raw (Places API caps content at the 5 most recent).';
COMMENT ON COLUMN public.businesses.google_overall_rating IS
  'Google Places rating field — average star rating across ALL reviews, not just the 5 we ingested.';
COMMENT ON COLUMN public.businesses.google_last_sync_at IS
  'When lib/reviews/sync.ts last successfully completed for this business.';

-- ── 2. Reply tracking on review_themes ──────────────────────────────

ALTER TABLE public.review_themes
  ADD COLUMN IF NOT EXISTS replied_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_text  TEXT,
  ADD COLUMN IF NOT EXISTS reply_tone  TEXT;

COMMENT ON COLUMN public.review_themes.replied_at IS
  'When the owner marked this review as replied. Manual until Google Business Profile OAuth lands. NULL = needs reply.';
COMMENT ON COLUMN public.review_themes.reply_text IS
  'The reply text the owner actually used (optional; useful for audit + future "draft from previous" feature).';
COMMENT ON COLUMN public.review_themes.reply_tone IS
  '"warm" | "professional" | "apologetic" — which tone the AI drafter used (if any). Helps the drafter learn preferences.';

-- Helper index for "needs-reply" KPI query.
CREATE INDEX IF NOT EXISTS review_themes_needs_reply_idx
  ON public.review_themes (business_id, published_at DESC)
  WHERE replied_at IS NULL;
