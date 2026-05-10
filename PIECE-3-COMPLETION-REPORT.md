# Piece 3 Completion Report

> Generated 2026-05-10 by Claude Code at the close of Piece 3 implementation.
> Architecture: `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`.
> Implementation prompt: `PIECE-3-IMPLEMENTATION-PROMPT.md`.

---

## Status: code complete, awaiting M067 + Vero re-backfill

Code merged. Operator actions:

- [ ] Apply `sql/M067-SCHOOL-HOLIDAYS-SE-SEED.sql` in Supabase SQL Editor
- [ ] Re-run Forecast backfill button on `/admin/v2/tools` for Vero — captures will be tagged `model_version='consolidated_v1.1.0'` so the M065 view can split MAPE by version
- [ ] When ready: same for Chicce (now eligible for yoy_same_weekday once she crosses 1 year in mid-May)

---

## Investigation pass — one minor schema drift caught

Verification of architecture vs codebase:

| Check | Outcome |
|---|---|
| M056 schema matches prompt | ⚠️ minor — actual columns are `kommun` + `lan` (not `kommun_id` + `lan_code` as prompt drafted). Folded into implementation directly. |
| weather_daily depth ≥ 365 days | ✓ (3 years backfilled in Piece 0) |
| businesses.kommun populated for Vero | ✓ (M054) |
| Klämdag detection works on existing computeKlamdag | ✓ (unchanged signature) |

No halts.

---

## What shipped

### Code

**`sql/M067-SCHOOL-HOLIDAYS-SE-SEED.sql`** — manual seed for Stockholm / Göteborg / Malmö / Uppsala covering academic years 2025-2026 + 2026-2027. Five holiday types per kommun (höstlov / jullov / sportlov / påsklov / sommarlov). 40 rows total. Idempotent via UNIQUE constraint on `(kommun, start_date, name)`.

**`lib/forecast/school-holidays.ts`** — `getActiveSchoolHoliday(db, kommun, date)` returns the active school holiday with default applied_factor by name (Sportlov 0.90, Höstlov 0.92, Påsklov 0.93, Jullov 1.00, Sommarlov 0.95). Per-business override path opens up for Piece 4 LLM adjustment.

**`lib/forecast/daily.ts` updates** (model_version bumped to `consolidated_v1.1.0`):

- **Stream A — school_holiday signal**: now reads from M056. Snapshot drops the `'piece_3_seasonal_norms_pending'` tag.
- **Stream B — klamdag history**: `computeKlamdag()` now takes `dailyMetrics` + `contaminatedSet` and computes the median ratio of prior klämdag actuals vs same-weekday baseline. Falls back to KLAMDAG_NATIONAL_DEFAULT (0.90) when <2 historical samples. Sanity-clamped to [0.5, 1.5].
- **Stream C — yoy_same_weekday**: looks up daily_metrics for forecast_date - 364 days (52 weeks back, same weekday). When available, blends 30% YoY + 70% weekday-baseline. Auto-active for Chicce mid-May 2026; activates for Vero on 2026-11-24. This is the architecture's self-healing path for Vero's January cold-start problem.
- **Stream D — weather_change_vs_seasonal**: pulls same-calendar-week temperatures from 1, 2, 3 years back (±3 days each year), computes seasonal mean, applies asymmetric factor (heat boost up to +10%, cold/wet dampen up to -8%). Available when ≥3 prior-year samples exist. Snapshot now carries `current_temp` / `seasonal_norm` / `deviation_c` / `samples_used` for transparency.

### Schema

**M067** — see file above. All other Piece 3 work uses existing tables (M056, weather_daily, daily_metrics, monthly_metrics). No new tables.

---

## Stream E — DEFERRED

Per the implementation prompt's E.1 condition: ship trend term ONLY if ≥2 customers show January-style over-prediction bias. Currently only Vero exhibits this; Chicce hasn't accumulated enough Phase A captures yet for comparison. Per `project_forecast_trend_term_followup.md` memory note, defer to Piece 4 or until 2 weeks of Phase A captures mature on both businesses.

---

## Deviations from spec

| # | What spec said | What we did | Why |
|---|---|---|---|
| 1 | M056 schema columns `kommun_id` / `lan_code` | actual schema uses `kommun` / `lan` | Prompt drift; folded into impl directly. |
| 2 | School holiday lookup falls back to län-level | Currently kommun-only; `lan` is a future hook | Seed is comprehensive for Sweden's largest kommuns. Fallback path can land when we expand customer base outside seeded kommuns. |
| 3 | Klämdag samples_used threshold = 2 | Implemented as ≥2 ratios computed (any prior klämdag with valid same-weekday baseline) | Same intent, slightly stricter (requires the baseline weekday to also have data). |
| 4 | Stream E (trend term) | Deferred per E.1 condition | Insufficient comparison data; would be signal-engineering without validation. |

---

## Effect on Vero (predicted)

After re-running the Forecast backfill (model_v1.1.0):

- **December 2025 forecasts** — `school_holiday: jullov` active for ~Dec 22 onwards → factor 1.0 (neutral, holiday signal handles it). YoY anchor still unavailable (need Nov 24 of prior year).
- **January 2026 forecasts** — bias should NOT improve much (root cause is recency-window-anchored on Christmas peak; Piece 4 territory). YoY same-weekday still unavailable for Vero until 2026-11-24.
- **February-March 2026** — `school_holiday: sportlov` active Feb 23 - Mar 1 → factor 0.90, lowering some predictions. Klämdag history (April 30 / May 1 area) gets per-business median if she had any in history; otherwise national default.
- **Weather change** — when current week's weather differs from prior years' norm, applies ±5-10% factor.

The biggest expected gain is Sportlov week (Feb 23 - Mar 1 2026, 7 days × 0.90 factor = 10% predictions reduced for those days specifically). May not move overall MAPE much since it's a 7-day window in a 116-day backfill.

---

## What's now true that the architecture should reflect (Piece 4 prompt input)

1. `model_version='consolidated_v1.1.0'` is the canonical version going forward. `1.0.0` and `1.0.1` rows are pre-Piece-3.
2. All 9 multipliers in `inputs_snapshot.consolidated_v1` carry real data (not stubs) when their data prerequisites are met.
3. `school_holidays` table is populated for SE (largest 4 kommuns × 2 academic years × 5 types). Future kommuns + the län-level fallback are open work.
4. YoY same-weekday only activates for businesses with ≥365 days of history. Chicce hits this mid-May 2026; Vero hits it 2026-11-24.
5. Recency multiplier short-history mode (Piece 2 fix at v1.0.1) still applies — independent of Piece 3 signals.
6. Stream E (trend term) explicitly deferred. Memory note `project_forecast_trend_term_followup.md` carries the implementation sketch.

---

## Architecture corrections to fold into v3.2

- M056 column names in any future docs: `kommun` / `lan`, NOT `kommun_id` / `lan_code`.
- Holiday-impact factors per name (Sportlov 0.90 etc) are conservative defaults; document them as v1.1.0 parameters subject to per-business override.
- Klämdag clamp range [0.5, 1.5] — document as architecture parameter.

---

## Acceptance gates met

- [x] M067 file ready to apply
- [x] `dailyForecast()` four-signals stubbing replaced
- [x] `model_version` bumped to `consolidated_v1.1.0`
- [x] All TypeScript clean
- [x] No customer-visible behaviour change beyond MAPE evolution (still just Phase A capture)
- [x] Stream E explicitly deferred with rationale

Pending operator action:
- [ ] Apply M067
- [ ] Re-run Vero + Chicce backfill — populates `1.1.0` rows for MAPE comparison

---

## Confidence

High. Piece 3 was significantly smaller than Piece 2 (single file edits + one schema seed) and shipped clean. The four deferred-from-Piece-2 signals are now wired through with real data; the snapshot's `data_quality_flags` no longer carries the `'piece_3_seasonal_norms_pending'` tag.

The known limitation — Vero's January cold-start over-prediction — remains. As anticipated in the Piece 2 completion report and the trend-term memory note, this is structural for Vero's first year and self-heals at 2026-11-24 via the now-active YoY same-weekday signal. Piece 4 (LLM adjustment) is the architecturally-correct tool for the broader class of "model output looks wrong because of seasonal context."

> "Piece 3 complete. Awaiting M067 apply + re-backfill, then ready for Piece 4 implementation prompt."
