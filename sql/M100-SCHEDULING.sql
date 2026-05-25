-- M100 — AI scheduling foundation
--
-- Schema for the /scheduling page + AI recommender + performance signals.
-- See AI-SCHEDULING-PLAN.md for the full design.
--
-- Five tables:
--   1. staff_shift_templates — PK shift templates (derived by deduping
--      work-periods data; PK doesn't expose /periods/ directly)
--   2. staff_shifts — per-shift detail synced from PK
--   3. staff_profiles — derived metadata + nightly-refreshed pattern stats
--   4. schedule_ai_suggestions — AI output cache + learning loop signal
--   5. staff_performance_signals — owner micro-ratings (closer confidence,
--      rush capability, section fit, demand pull)
--
-- Phase 0 PK probe confirmed:
--   - work-periods is read-only for us (PK won't accept writes)
--   - Templates derive from (period_name, period_color, costgroup) in work-periods
--   - Per-shift detail is rich: start/end, period_name, period_color, costgroup,
--     break_rule_description, additional_salaries, is_published, etc.

BEGIN;

-- ───────────────────────────────────────────────────────────────────
-- 1. staff_shift_templates
--
-- Derived from work-periods data by deduping (period_name, period_color,
-- costgroup_short_id). Rebuilt nightly. PK assigns templates an internal
-- ID but doesn't expose /periods/{id}/ to our token, so we use the
-- derived natural key.

CREATE TABLE IF NOT EXISTS staff_shift_templates (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id            UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  /** Natural key from PK — combination of these three uniquely identifies
   *  a template within a business. */
  name                   TEXT NOT NULL,                      -- e.g. "Kväll", "Pastakök Öppning"
  pk_period_color        TEXT,                                -- PK's colour keyword: "red", "yellow", "green", "blue", "purple"
  pk_costgroup_short_id  INTEGER,                             -- PK's costgroup numeric id, NULL when no costgroup

  /** Modal start/end times (most-common in the shifts seen using this template).
   *  Owners can override per-shift; these drive the "default times" hint in the UI. */
  modal_start_time       TIME,
  modal_end_time         TIME,

  /** Derived section bucket — chefs / foh / bar / management / office.
   *  Computed from costgroup name + template name keyword match; manual override
   *  via section_overridden=true. */
  section                TEXT,                                -- 'foh' | 'kitchen' | 'bar' | 'management' | 'office' | 'other'
  section_overridden     BOOLEAN NOT NULL DEFAULT FALSE,

  /** Hex colour for display — mapped from pk_period_color. Owner can override. */
  display_colour         TEXT,                                -- e.g. '#a99ce6'
  colour_overridden      BOOLEAN NOT NULL DEFAULT FALSE,

  /** Display ordering within the section. */
  sort_order             INTEGER NOT NULL DEFAULT 100,

  /** Stats refreshed nightly. */
  shifts_count_60d       INTEGER NOT NULL DEFAULT 0,         -- how often this template is used
  last_seen_on           DATE,                                -- most recent shift assigned to this template

  archived_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_shift_templates_natural_uniq UNIQUE (business_id, name, pk_period_color, pk_costgroup_short_id)
);

CREATE INDEX IF NOT EXISTS idx_sst_business_section
  ON staff_shift_templates (business_id, section, sort_order)
  WHERE archived_at IS NULL;

-- ───────────────────────────────────────────────────────────────────
-- 2. staff_shifts
--
-- One row per shift assignment. Source-of-truth is PK; we mirror.

CREATE TABLE IF NOT EXISTS staff_shifts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id            UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  /** PK identifiers for idempotent sync. work_period_url is unique across PK. */
  pk_work_period_url     TEXT,                                -- e.g. https://personalkollen.se/api/work-periods/29722665/
  pk_staff_url           TEXT,                                -- FK into PK
  pk_period_url          TEXT,                                -- the template's PK url (we can't fetch it but we store it)

  /** Local cross-references. */
  staff_uid              TEXT,                                -- our normalised staff identifier (matches staff_logs.pk_staff_url)
  shift_template_id      UUID REFERENCES staff_shift_templates(id) ON DELETE SET NULL,

  shift_date             DATE NOT NULL,
  start_at               TIMESTAMPTZ NOT NULL,                -- UTC, from PK's start
  end_at                 TIMESTAMPTZ NOT NULL,
  start_time_local       TIME,                                -- PK's start_time (HH:MM in business tz)
  end_time_local         TIME,

  staff_name             TEXT,                                -- denormalised PK staff_name
  period_name            TEXT,                                -- denormalised template name for quick filter
  description            TEXT,                                -- PK's shift description / notes
  estimated_cost         NUMERIC(12, 2),

  /** Shift kind discriminator — important for compliance + AI. */
  shift_kind             TEXT NOT NULL DEFAULT 'regular'
                              CHECK (shift_kind IN ('regular','semester','sick','on_call','open','holiday','other')),

  /** Break info — `breaks_seconds` from PK. Used by net-hours calc + break
   *  compliance check (>6h shift needs >=30min break per Swedish rules). */
  breaks_seconds         INTEGER NOT NULL DEFAULT 0,
  break_rule_name        TEXT,
  break_rule_description TEXT,

  /** OB / additional salaries — denormalised count + flag for AI scheduler. */
  has_ob                 BOOLEAN NOT NULL DEFAULT FALSE,
  ob_hours               NUMERIC(6, 2),

  /** Publication state — PK distinguishes draft from published shifts. */
  is_published           BOOLEAN NOT NULL DEFAULT FALSE,
  is_read_only           BOOLEAN NOT NULL DEFAULT FALSE,

  /** Provenance: where did this shift come from? */
  source                 TEXT NOT NULL DEFAULT 'pk_sync'
                              CHECK (source IN ('pk_sync','ai_generated','manual_override')),
  is_ai_suggested        BOOLEAN NOT NULL DEFAULT FALSE,
  ai_suggestion_id       UUID,                                -- FK to schedule_ai_suggestions added after table create
  applied_at             TIMESTAMPTZ,
  applied_by             UUID,                                -- user_id of owner who clicked Apply

  /** Raw PK response for debugging schema drift. */
  raw_data               JSONB,

  last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_shifts_pk_url_uniq UNIQUE (business_id, pk_work_period_url)
);

CREATE INDEX IF NOT EXISTS idx_staff_shifts_business_date
  ON staff_shifts (business_id, shift_date DESC);

CREATE INDEX IF NOT EXISTS idx_staff_shifts_staff_date
  ON staff_shifts (business_id, staff_uid, shift_date DESC);

CREATE INDEX IF NOT EXISTS idx_staff_shifts_template_date
  ON staff_shifts (business_id, shift_template_id, shift_date)
  WHERE shift_template_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_shifts_ai_suggested
  ON staff_shifts (business_id, is_ai_suggested, shift_date)
  WHERE is_ai_suggested;

-- ───────────────────────────────────────────────────────────────────
-- 3. staff_profiles
--
-- One row per staff member per business. Refreshed nightly by walking
-- staff_shifts + staff_logs + the PK /staffs/ payload. Owners never
-- edit this directly; everything is derived.

CREATE TABLE IF NOT EXISTS staff_profiles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id            UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  /** Staff identity — from PK. */
  pk_staff_url           TEXT NOT NULL,
  staff_uid              TEXT NOT NULL,                       -- matches staff_logs.pk_staff_url tail
  display_name           TEXT,
  full_name              TEXT,
  email                  TEXT,

  /** Contract / cost — from PK /staffs/?with_employments=true active employment. */
  salary_type            TEXT,                                -- 'hourly' | 'monthly' | 'fixed_per_day'
  hourly_rate_sek        NUMERIC(8, 2),
  monthly_salary_sek     NUMERIC(10, 2),
  fixed_cost_per_day_sek NUMERIC(10, 2),
  service_grade_pct      NUMERIC(5, 2),                       -- contract % (100 = full-time)
  hired_at               DATE,
  contract_end_at        DATE,

  /** Derived from shift history (12-week rolling window, refreshed nightly). */
  primary_section        TEXT,                                -- 'foh' | 'kitchen' | 'bar' | 'management' | 'office'
  typical_days           JSONB,                               -- { mon: 0.9, tue: 0.0, ... } fraction of weeks scheduled per day
  typical_shift_window   TEXT,                                -- 'opener' | 'midday' | 'closer' | 'split' | 'mixed'
  versatility_score      NUMERIC(4, 2),                       -- 0-1: fraction of distinct sections worked
  punctuality_score      NUMERIC(4, 2),                       -- 0-1: scheduled-start vs logged-start agreement
  no_show_rate           NUMERIC(4, 2),                       -- 0-1: fraction of scheduled shifts not logged

  /** Aggregated owner performance signals (computed from staff_performance_signals
   *  with 6-month time-decay; updated whenever a new signal is recorded). */
  closer_confidence      NUMERIC(4, 2),                       -- 0-1
  rush_capability        NUMERIC(4, 2),                       -- 0-1
  demand_pull            NUMERIC(4, 2),                       -- 0-1

  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  last_refreshed_at      TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_profiles_business_pk_url_uniq UNIQUE (business_id, pk_staff_url)
);

CREATE INDEX IF NOT EXISTS idx_staff_profiles_business_active
  ON staff_profiles (business_id, is_active);

CREATE INDEX IF NOT EXISTS idx_staff_profiles_staff_uid
  ON staff_profiles (business_id, staff_uid);

-- ───────────────────────────────────────────────────────────────────
-- 4. schedule_ai_suggestions
--
-- AI's per-change recommendations. Owner approves / modifies / rejects;
-- the resulting decision is the learning signal for next run.

CREATE TABLE IF NOT EXISTS schedule_ai_suggestions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id            UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  /** Week scope — ISO week so we can cache + invalidate predictably. */
  week_iso               TEXT NOT NULL,                       -- '2026-W22'
  shift_date             DATE,                                -- nullable for week-level recommendations

  /** Suggestion subject. */
  action                 TEXT NOT NULL CHECK (action IN ('cut','add','reduce','extend','reassign','swap_template')),
  target_staff_uid       TEXT,
  target_shift_id        UUID REFERENCES staff_shifts(id) ON DELETE SET NULL,
  target_template_id     UUID REFERENCES staff_shift_templates(id) ON DELETE SET NULL,

  /** What's currently planned vs what AI suggests (free-shape JSON). */
  before                 JSONB,
  proposed               JSONB,

  /** Owner-facing reasoning. */
  reasoning              TEXT,
  est_sek_saving         NUMERIC(10, 2),
  confidence             NUMERIC(4, 2),                       -- 0-1

  /** Owner outcome — drives the learning loop. */
  status                 TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','modified','rejected','applied','expired')),
  owner_action_at        TIMESTAMPTZ,
  owner_action_by        UUID,
  owner_reason           TEXT,                                -- when status='modified' or 'rejected'
  modified_to            JSONB,                               -- when status='modified', what owner changed it to

  ai_model               TEXT NOT NULL,
  tokens_input           INTEGER,
  tokens_output          INTEGER,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sas_business_week_status
  ON schedule_ai_suggestions (business_id, week_iso, status);

CREATE INDEX IF NOT EXISTS idx_sas_recent_rejections
  ON schedule_ai_suggestions (business_id, status, created_at DESC)
  WHERE status IN ('rejected','modified');

-- Now add the deferred FK on staff_shifts.ai_suggestion_id
ALTER TABLE staff_shifts
  ADD CONSTRAINT staff_shifts_ai_suggestion_fk
  FOREIGN KEY (ai_suggestion_id) REFERENCES schedule_ai_suggestions(id) ON DELETE SET NULL;

-- ───────────────────────────────────────────────────────────────────
-- 5. staff_performance_signals
--
-- Owner-supplied micro-ratings. SCHEDULING TOOL ONLY — not HR records.
-- Time-decayed (>6mo old doesn't influence AI). Aggregate ≥3 before
-- using. Owner-only inputs. Never surfaced to staff.

CREATE TABLE IF NOT EXISTS staff_performance_signals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id            UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  staff_uid              TEXT NOT NULL,

  dimension              TEXT NOT NULL CHECK (dimension IN ('closer_confidence','rush_capability','section_fit','demand_pull','other')),
  score                  INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  section                TEXT,                                -- relevant for section_fit
  shift_id               UUID REFERENCES staff_shifts(id) ON DELETE SET NULL,
  notes                  TEXT,                                -- optional owner-typed context

  source                 TEXT NOT NULL DEFAULT 'manual'
                              CHECK (source IN ('post_shift_prompt','weekly_review','manual','imported')),

  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by            UUID
);

CREATE INDEX IF NOT EXISTS idx_sps_staff_dimension_recent
  ON staff_performance_signals (business_id, staff_uid, dimension, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_sps_business_recent
  ON staff_performance_signals (business_id, recorded_at DESC);

-- ───────────────────────────────────────────────────────────────────
-- RLS — all five tables

ALTER TABLE staff_shift_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_shifts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_ai_suggestions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_performance_signals  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sst_org_isolation ON staff_shift_templates;
CREATE POLICY sst_org_isolation ON staff_shift_templates
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS ss_org_isolation ON staff_shifts;
CREATE POLICY ss_org_isolation ON staff_shifts
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS sp_org_isolation ON staff_profiles;
CREATE POLICY sp_org_isolation ON staff_profiles
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS sas_org_isolation ON schedule_ai_suggestions;
CREATE POLICY sas_org_isolation ON schedule_ai_suggestions
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS sps_org_isolation ON staff_performance_signals;
CREATE POLICY sps_org_isolation ON staff_performance_signals
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

-- updated_at triggers (uses set_updated_at() function from earlier migrations)
CREATE TRIGGER staff_shift_templates_set_updated_at
  BEFORE UPDATE ON staff_shift_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER staff_shifts_set_updated_at
  BEFORE UPDATE ON staff_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER staff_profiles_set_updated_at
  BEFORE UPDATE ON staff_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER schedule_ai_suggestions_set_updated_at
  BEFORE UPDATE ON schedule_ai_suggestions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
