# Piece 3 Implementation Prompt — Activate Deferred Signals

> Fourth implementation piece of the Prediction System architecture (`PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`).
> Written 2026-05-10 against architecture v3 + Piece 2 completion report.
> Time budget: 2-3 days focused work (roughly half the size of Piece 2).
> Output: four signals that currently default to neutral get real data flowing through them. Phase A model bumps from v1.0.1 → v1.1.0.

---

## Context — read this before doing anything

Piece 2 shipped `dailyForecast()` with all 9 multipliers wired through, but four of them are stubbed:

| Signal | Current Piece 2 state | Piece 3 goal |
|---|---|---|
| `school_holiday` | always `applied_factor: 1.0`, snapshot tagged `'piece_3_seasonal_norms_pending'` | Real lookup against M056 `school_holidays` table |
| `klamdag` | uses `national_default_0.90` | Per-business klämdag history median |
| `yoy_same_weekday` | always `available: false` | Activates once a business hits ≥365 days of history |
| `weather_change_vs_seasonal` | always 1.0, tagged `'piece_3_seasonal_norms_pending'` | Multi-year weather norms with current-week deviation |

Vero's diagnostic data from Piece 2 (`PIECE-2-COMPLETION-REPORT.md` Phase A findings) showed a structural January 2026 over-prediction (+201% bias) that no static window can fix. Piece 3 doesn't directly solve that — but enabling these four signals adds context the LLM in Piece 4 can use, and the YoY signal becomes Vero's self-healing path once she hits 2026-11-24.

Three things to internalize:

1. **Same discipline as Pieces 0-2.** Investigation pass first, halt-and-report on contradictions, then execute.

2. **No model behaviour change for live forecasts UNLESS the signal has data.** Each new signal must be backwards-compatible: if data isn't available for a business yet, fall back to the Piece 2 neutral value. Vero benefits from school_holiday + klamdag history immediately; YoY only activates Nov 2026; weather_change activates ~now (we backfilled 3 years).

3. **Two existing memory notes are load-bearing here:**
   - `project_forecast_trend_term_followup.md` — the recent-trend factor we deferred from Piece 2. Optional Stream E if Phase A capture data has matured.
   - `feedback_check_constraint_drift.md` — Piece 3 adds new tables and possibly enum values; check CHECK constraints if you do.

---

## Pre-flight: facts confirmed in Piece 2 completion report

Before reading the work streams, internalize:

1. **`lib/forecast/daily.ts` is the single chokepoint for all signals.** Don't add per-surface logic. Every multiplier composes inside `dailyForecast()` in the order architecture §3 specifies.
2. **Model version is `consolidated_v1.0.1`.** Piece 3 bumps to `1.1.0` (semver: minor bump = new signals, no breaking change to the snapshot shape).
3. **`inputs_snapshot consolidated_v1`** is the persistent contract. Piece 3 fills in fields that already exist; doesn't change the shape.
4. **Short-history mode** (Piece 2's v1.0.1 fix): for businesses with <180 days history, baseline window is 4 weeks unweighted instead of 12 weeks × 2.0. Piece 3's signals MUST respect this — for example, klamdag history won't be useful if the business hasn't had a klämdag in its 6-month window yet, so fall back to national default.
5. **`captureForecastOutcome()`** is the only audit ledger writer. Piece 3 doesn't need to change it.
6. **Phase A view (`v_forecast_mape_by_surface`, M065) and admin endpoint (`/api/admin/forecast-mape`)** are the validation gate. After Piece 3 ships, the model_version field in `daily_forecast_outcomes` lets us split MAPE by version: `1.0.1` rows vs `1.1.0` rows side-by-side.
7. **`businesses.kommun`** is populated for both Vero rows (M054 from Piece 0). Chicce + future customers need their kommun set during onboarding for school_holiday lookups to work.

---

## What to do

Five work streams. A-D are the deferred signals. E is the conditional trend-term work — only ship if Phase A data has matured to validate against.

### Stream A — school_holidays population (Day 1, ~6 hours)

#### A.1 Investigation

1. Read `sql/M056-SCHOOL-HOLIDAYS.sql` — schema only, no data. Confirm column shape (`kommun_id`, `lan_code`, `year`, `name`, `start_date`, `end_date`).
2. Read `lib/holidays/sweden.ts` — note the pattern (pure compute, no DB). School holidays differ from public holidays: they're per-kommun and require external data, can't be pure-computed.
3. Determine the data source. Two candidates:
   - **Skolverket** publishes school year start/end via their open data API (https://www.skolverket.se/skolverkets-statistik). May or may not include holiday windows specifically.
   - **Per-kommun calendars** (e.g. stockholm.se publishes "läsårstider" with höstlov / sportlov / påsklov / sommarlov dates). More authoritative; harder to scrape uniformly.
4. The pragmatic answer: **manual seed file for Sweden's biggest kommuns** (Stockholm 0180, Göteborg 1480, Malmö 1280, plus the kommuns of any active customers). Skolverket's full per-kommun coverage is not stable enough to scrape reliably.

#### A.2 Implementation

Two parts:

1. **Seed migration `sql/M067-SCHOOL-HOLIDAYS-SE-SEED.sql`** — INSERTs known holiday windows for the top 5-10 Swedish kommuns covering 2025-2027. Include höstlov (autumn), jullov (Christmas), sportlov (winter), påsklov (Easter), sommarlov (summer). Manual data, sourced from kommun websites; document each row's source URL in a comment.

2. **`lib/forecast/school-holidays.ts`** helper:
   ```typescript
   export interface SchoolHoliday {
     kommun_id:  string
     name:       string
     start_date: string
     end_date:   string
   }
   export async function getSchoolHolidayForDate(
     db: any, kommun_id: string, date: Date
   ): Promise<SchoolHoliday | null>
   ```

3. **Wire into `dailyForecast()`** — replace the stubbed `schoolHolidayInfo` block. When a school holiday is active for the business's kommun on the forecast date:
   - `applied_factor`: lookup from prior occurrences (avg revenue ratio vs same-weekday-non-holiday). For sparse data: cluster default per holiday type (sportlov=0.85, sommarlov=0.95, etc — restaurant-specific baseline; document choices).
   - `name`: holiday name in Swedish
   - `active: true`

4. **Annual refresh cron at `app/api/cron/school-holidays-refresh/route.ts`** — triggered yearly to extend the seed forward. For now, can be a no-op until Skolverket integration is plausible.

#### A.3 Acceptance

- M067 applied; `SELECT COUNT(*) FROM school_holidays` returns ~30-50 rows (5 holiday windows × 5+ kommuns × 2-3 years)
- `dailyForecast()` for a Vero date inside Stockholm sportlov returns `school_holiday.active: true` with the kommun ID populated and an applied_factor < 1.0
- Snapshot drops the `'piece_3_seasonal_norms_pending'` flag for school_holiday

---

### Stream B — klamdag history (Day 1, ~3 hours)

#### B.1 Investigation

1. Re-read `computeKlamdag()` in `lib/forecast/daily.ts`. Currently detects klämdag days correctly but uses `national_default_0.90` as the factor.
2. Verify Vero has any klämdag days in her 6-month history. Quick SQL:
   ```sql
   SELECT date, revenue FROM daily_metrics WHERE business_id = '<vero>' AND revenue > 0;
   ```
   Cross-reference against Swedish public holidays. Probable klämdag days: late Apr (around Walpurgis/Valborg + 1 May), early Jun (around National Day), late Dec (Christmas Eve area).
3. If Vero's history has <2 klämdag observations, the architecture's `MIN_SAMPLES.klamdag = 2` guardrail keeps the national default. Confirm via investigation.

#### B.2 Implementation

Extend `computeKlamdag()` to query history when adjacent-holiday detection fires:

```typescript
async function computeKlamdagWithHistory(
  date: Date,
  holidays: Holiday[],
  dailyMetrics: any[],   // already loaded
  asOfDate: Date,
): Promise<KlamdagResult>
```

Logic:
1. Existing detection identifies if today is a klämdag (adjacent to a holiday)
2. If yes: walk dailyMetrics history backward, identify all prior klämdag dates (each one's adjacent-holiday match)
3. For each historical klämdag, find the same-weekday actual (e.g. ANY non-klämdag Friday) for context
4. Compute median ratio: actual_klamdag_revenue / actual_normal_same_weekday_revenue
5. Sample size N samples ≥ 2 → use median
6. Otherwise → fall back to national_default_0.90

Snapshot fields already exist (`samples_used`, `applied_factor`, `fallback_used`). Just populate accurately.

#### B.3 Acceptance

- For a forecast on a known klämdag (e.g. 2026-04-30 Walpurgis Eve eve, or May 1 + 1 day), if Vero has ≥2 prior klämdag observations the factor uses the median; otherwise national default
- Snapshot accurately reports `samples_used`
- A test that runs `dailyForecast()` for a known-klämdag date in Vero's history and validates the multiplier

---

### Stream C — yoy_same_weekday activation (Day 2, ~3 hours)

#### C.1 Investigation

1. Architecture §3 deferred this for Vero specifically until 2026-11-24 (one year after first positive day).
2. The signal SHOULD activate for any business with ≥365 days of history regardless. Check Chicce: opened ~May 2025, will hit a year May 2026 — close to now.
3. Verify the data shape. For a forecast on 2026-05-15 (Friday): look up the SAME WEEKDAY in 2025-05 (Friday closest to the same calendar week). That's 2025-05-16 (Friday).

#### C.2 Implementation

In `dailyForecast()`, replace the stubbed yoy_same_weekday block:

```typescript
const yoyTarget = subtractDays(date, 364)   // 52 weeks back, same weekday
const { data: yoyRow } = await db
  .from('daily_metrics')
  .select('date, revenue')
  .eq('business_id', businessId)
  .eq('date', ymd(yoyTarget))
  .gt('revenue', 0)
  .maybeSingle()

if (yoyRow) {
  // Available — apply as a small blend factor with weekday baseline
  // Architecture decision: weight 30% YoY + 70% weekday recency-baseline
  // when YoY available, otherwise 100% weekday-baseline
  const yoyValue = Number(yoyRow.revenue)
  weekdayBaseline = weekdayBaseline * 0.7 + yoyValue * 0.3
  yoyAvailable = true
}
```

Note: 30/70 split is conservative. Architecture §3 doesn't prescribe — Piece 4 can adjust via LLM if it sees the YoY value and the weekday-baseline diverge wildly.

Snapshot:
```json
"yoy_same_weekday": {
  "available": true,
  "weekday": 5,
  "revenue": 65000,
  "samples": 1
}
```

#### C.3 Acceptance

- For Chicce after enough history accrues, `yoy_same_weekday.available: true`
- For Vero before 2026-11-24, still `available: false` with a clearer reason than "piece_2_uses_yoy_same_month_only"
- Backfill rerun on Chicce shows YoY active for forecast_dates ≥ 2026-05-15 (one year past Chicce's earliest date)

---

### Stream D — weather_change_vs_seasonal (Day 2, ~4 hours)

#### D.1 Investigation

1. `weather_daily` has ~3 years of history per Piece 0 backfill. Each row has `temp_avg`, `precip_mm`, `weather_code`, `summary`.
2. The signal compares THIS week's forecast weather to the same calendar week in PRIOR years. If this week is unusually warm/cold/wet vs seasonal norm, apply a lift factor.

#### D.2 Implementation

```typescript
async function computeWeatherChangeFactor(
  db: any,
  businessId: string,
  forecastDate: Date,
  forecastWeather: any,
  asOfDate: Date,
): Promise<{
  factor: number
  available: boolean
  reason?: string
  detail: { current_temp: number; seasonal_norm: number; deviation: number }
}>
```

Logic:
1. Compute calendar-week of forecast_date (ISO week)
2. Pull weather_daily for same calendar-week from each available prior year (1, 2, 3 years back)
3. Compute seasonal mean (temp_avg, precip_mm averaged across years)
4. Compute deviation: this_week - seasonal_norm
5. Apply factor:
   - +5°C above norm → +5% revenue boost
   - −5°C below norm → −3% revenue cut (asymmetric — heat boosts more than cold dampens, restaurant pattern)
   - precip > 2× seasonal → −5%
   - Clamp to [0.92, 1.10]

Conservative defaults until we've validated. Architecture §3 sample-size guardrail says `1 prior year same calendar week` minimum.

Snapshot:
```json
"weather_change_vs_seasonal": {
  "available": true,
  "applied_factor": 1.04,
  "current_temp": 22.5,
  "seasonal_norm": 17.0,
  "deviation_c": 5.5,
  "samples_used": 3
}
```

#### D.3 Acceptance

- Vero forecast for a hot day shows `applied_factor > 1.0`
- Vero forecast for a normal day shows `applied_factor ≈ 1.0`
- For dates with <1 year of weather history, falls back to `available: false, applied_factor: 1.0`

---

### Stream E (CONDITIONAL) — recent_trend_factor

#### E.1 When to ship this

ONLY ship Stream E if:
- ≥2 weeks of Phase A live captures have accumulated (≥30 resolved rows for `consolidated_daily` per business beyond the backfill), AND
- ≥2 customers show the January-style "model over-predicts during seasonal transitions" pattern

If only Vero's seen this so far, **defer Stream E to Piece 4**. Stream E without comparison data is signal-engineering without validation, the same anti-pattern Piece 2's completion report flagged.

#### E.2 Implementation (when triggered)

Per `project_forecast_trend_term_followup.md` memory: linear regression on last 28 days × week, R² > 0.3 gate, half-strength projection, clamp [0.80, 1.20]. Surface in `inputs_snapshot.recent_trend`.

---

## What NOT to do in Piece 3

- DO NOT add new tables beyond M067 (school_holidays seed). All other signals use existing tables (`weather_daily`, `daily_metrics`).
- DO NOT change the `inputs_snapshot consolidated_v1` shape. Fill in deferred fields, don't add new ones.
- DO NOT bump model_version past `1.1.0` — that's Piece 4's prerogative when LLM adjustment lands.
- DO NOT add the trend term unless Stream E's data condition is met (see E.1).
- DO NOT modify `lib/forecast/audit.ts` or the daily-forecast-reconciler — those are Piece 1 territory.

---

## What to flag and pause for

If during investigation any of the following turns up, **stop and report:**

1. M056's schema differs from the migration file (e.g. column names changed, `kommun_id` → `kommun_code`)
2. Skolverket's API isn't usable for our purposes AND no manual seed data is reachable for Stockholm/Göteborg
3. `dailyForecast()`'s short-history mode interferes with school_holiday history lookup (e.g. 4-week window prevents detecting any prior school holidays)
4. `weather_daily` has fewer than 365 days of history for ANY business (would defer Stream D entirely)
5. YoY same-weekday lookup returns wildly volatile values (single sample → hard to apply, may need ≥3 prior years before activating)

---

## Acceptance gates (overall)

Piece 3 is complete when:

- [ ] M067 school holidays seed applied; lookup helper works
- [ ] `dailyForecast()` four-signals stubbing replaced; snapshot drops `piece_3_seasonal_norms_pending` tags
- [ ] `model_version` bumped to `consolidated_v1.1.0`
- [ ] Re-run Vero backfill via the admin endpoint; new MAPE captured under `1.1.0` model version
- [ ] M065 view query split by model_version shows `1.0.1` vs `1.1.0` side-by-side; expect modest improvement on closed months (mostly through klamdag history, smaller from school_holiday + weather_change; YoY won't help Vero until November)
- [ ] Stream E shipped IF data condition met, OR explicit deferral note in completion report
- [ ] All TypeScript clean (`npx tsc --noEmit` zero output)
- [ ] No customer-visible behaviour change beyond MAPE improvement

---

## Output

1. M067 migration applied
2. New code: school-holidays helper, klamdag history extension, yoy_same_weekday activation, weather_change_vs_seasonal computer
3. `PIECE-3-COMPLETION-REPORT.md` summarising:
   - Deviations from spec
   - MAPE numbers per model_version (1.0.1 vs 1.1.0)
   - Whether Stream E shipped and why
   - Architecture corrections to fold into v3.2

The completion report is the input to Piece 4's implementation prompt. Don't skip it.
