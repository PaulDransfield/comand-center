# Prediction Data Audit — 2026-06-08

> Full survey of every data source we have, what the daily forecaster
> uses, what it ignores, and how to close the gap. Triggered by Vero's
> +30 % summer-2026 bias which Phase 1 (v1.6.0 YoY-month damper) only
> partially fixes.

---

## Headline findings

1. **Scheduled staff hours correlate with same-day revenue at 0.80 Pearson** for Vero — and the forecaster doesn't use them at all. Strongest unused signal we have. On weekends (where current model has +75 % bias) the correlation is 0.69-0.76.
2. **Revenue mix shifts dramatically by season.** Vero winter is 60-70 % alcohol; summer is 62-70 % dine-in. The model treats revenue as one number and misses the entire mix story.
3. **Vero's 2025 daily_metrics are revenue=0** for Jan-Oct (Fortnox monthly P&L is the source, no daily granularity). This silently disables `yoy_same_weekday` lookups even though the monthly totals ARE in `monthly_metrics`. v1.6.0 closes most of this gap; backfilling synthetic daily values would close the rest.
4. **POS-recipe mapping is built (M097) but `pos_sales` is empty.** This is the bridge from raw POS revenue to dish-level demand. Owner-side mapping unlocks per-dish forecasting.
5. **`events_local` table is empty** — Ticketmaster integration scaffolded but not wired (no API key, no geocoded businesses).

---

## What the forecaster uses today

| Signal | Source table | Status |
|---|---|---|
| Weekday recency baseline | `daily_metrics` (last 12 wks, same weekday, 28d × 2 recency weight) | ✓ |
| YoY same-weekday blend | `daily_metrics` (52 wks back, 30 % YoY + 70 % baseline) | ✓ when daily history exists |
| YoY same-month anchor | `monthly_metrics` (trailing-12m growth multiplier, clamped 0.5-1.5×) | ✓ |
| **YoY same-month damper (v1.6.0)** | `monthly_metrics` (daily-avg derived seasonality pull) | ✓ shipped today |
| Weather lift | `weather_forecast` + cached history | ✓ |
| Weather change | Multi-year seasonal weather norm comparison | ✓ |
| Holiday lift | `holidays` (high/low impact classifier) | ✓ |
| Klamdag | Holiday calendar derived | ✓ |
| School holiday | `school_holidays` table | ✓ |
| Salary cycle | Day-of-month derived | ✓ |
| This-week scaler | `daily_metrics` recent same-week observations | ✓ |

**Total: 11 signals. All deterministic. All read-side; no live external calls.**

---

## What's available but NOT used

### Tier 1 — high impact, low effort

#### A. Scheduled staff hours
- **Source:** `staff_logs` filtered to `pk_log_url LIKE '%_scheduled'`
- **Available rows for Vero:** 11,574 rows since 2024-02-01
- **Signal strength:** **Pearson 0.80 vs revenue**, 0.69-0.76 on Fri/Sat
- **Why it's a leading indicator:** chefs roster the night BEFORE service based on expectation. Their judgment encodes information the recency-weighted baseline can't see (knowledge of upcoming events, reservation patterns, school holidays specific to local schools, etc.).
- **Forecaster integration:** treat `scheduled_hrs / typical_weekday_hrs` as a ratio multiplier on the weekday baseline. Clamp [0.6, 1.5].
- **Schema work:** none. Already populated by master-sync.
- **Risk:** customers who don't schedule ahead in PK won't surface this signal. Handled: when scheduled_hrs=0, fall through to current model.

#### B. Revenue mix decomposition
- **Source:** `tracker_data` (`dine_in_revenue`, `takeaway_revenue`, `alcohol_revenue`)
- **Available rows for Vero:** monthly back to 2025-01
- **Signal strength:** Vero's alcohol mix swings 25 %→63 % winter-to-summer. **Forecasting one number misses 25-40 % of the seasonal story.**
- **Forecaster integration:** forecast three streams independently (each with its own YoY-month anchor, recency weighting), sum to get total revenue.
- **Schema work:** none for monthly; would need daily mix decomposition for the daily forecaster — extractable from `revenue_logs.dine_in_revenue/takeaway_revenue/alcohol_revenue` columns (when populated by POS).
- **Risk:** when POS doesn't split by VAT rate, model falls back to whole-business forecast (current behaviour).

#### C. Per-department revenue patterns
- **Source:** `revenue_logs` filtered by provider (`pk_bella`, `pk_carne`, `pk__lbaren`, `pk_brus`, etc.)
- **Available rows for Vero:** 728 rows since 2025-11-24, 6 distinct departments
- **Signal strength:** Vero's bar (`pk__lbaren`) and kitchen (`pk_bella`/`pk_carne`) have different demand drivers. Forecasting at department level then summing should beat whole-business by 5-10 % MAPE.
- **Forecaster integration:** same engine, per-department iteration; sum at the end.
- **Schema work:** none. Just need a per-department call wrapper.
- **Risk:** departments with thin history fall back to whole-business.

### Tier 2 — medium impact, moderate effort

#### D. Synthetic daily backfill for 2025 from monthly_metrics
- **Problem:** Vero's `daily_metrics` for 2025 has rows with `revenue=0` because Fortnox P&L is monthly. This silently disables `yoy_same_weekday`.
- **Fix:** generate synthetic daily revenue values by distributing each month's total across its trading days, weighted by recent weekday patterns. Tag the rows with a source flag (e.g. `revenue_source = 'synthesized_from_monthly'`) so the engine can either use them or skip them.
- **Schema work:** add `revenue_source` column to `daily_metrics`.
- **Risk:** synthetic values are smoother than reality. Only use them as the fallback when the real-daily-data path returns nothing.

#### E. Forward-looking scheduled hours as multi-day signal
- **Source:** `staff_logs` scheduled rows for future dates
- **Available for Vero RIGHT NOW:** 0 (Vero doesn't forward-schedule in PK currently)
- **For customers who do forward-schedule:** this lets the forecaster predict tomorrow + 7-day forward with much higher confidence
- **Forecaster integration:** when `staff_logs.shift_date > today` rows exist, use them as a per-day multiplier
- **Schema work:** none
- **Risk:** customer-specific behavior. Wrap in an `if (schedule_data_present) { ... } else { fallback }`.

#### F. Cross-business benchmark
- **Source:** all businesses' `daily_metrics` aggregated by region (`businesses.country`, eventually `businesses.city`)
- **Signal strength:** when all Stockholm restaurants drop 20 % on a given Tuesday, that's a regional signal Vero benefits from
- **Forecaster integration:** compute a "regional weekday factor" = recent_regional_avg / same-weekday-last-month-regional. Multiply into the forecast.
- **Schema work:** none (existing tables). Need an admin RPC to compute the regional average.
- **Risk:** cold-start for the first few customers; current sample (Vero + Chicce + Rosali test) is too small.

### Tier 3 — high impact, high effort (needs external integration or owner input)

#### G. Reservations / bookings
- **Source:** `BOOKING-API-COVERS-PLAN.md` (parked)
- **Signal strength:** forward-looking covers are gold; reservation-driven restaurants would see MAPE drop 30-50 %
- **Schema work:** new `reservations` table; provider adapter (SuperbExperience / OpenTable / ResDiary / Caspeco)
- **Risk:** requires customer integration consent

#### H. Local events
- **Source:** `events_local` table, Ticketmaster API
- **Status:** scaffolded in `lib/events/ticketmaster.ts` + `lib/events/impact.ts` + `/api/cron/events-sync`; no API key set, businesses not geocoded
- **Signal strength:** concerts / matches near the restaurant explain otherwise-mysterious revenue spikes
- **Schema work:** `events_local` table exists; need to populate. `businesses.lat/lon` columns needed.
- **Risk:** Stockholm-only initially; expansion costs API quota

#### I. POS-recipe mapping → per-dish demand
- **Source:** `pos_sales` table (M097), populated when owner maps POS menu items to recipes
- **Status:** built; empty
- **Signal strength:** unlocks per-dish forecasting (huge for prep / waste optimisation; modest for revenue forecasting itself)
- **Schema work:** none — just owner mapping action
- **Risk:** depends on per-customer POS connector + recipe coverage

#### J. Fortnox voucher cash-flow timing
- **Source:** `fortnox_vouchers_cache` (1,628 rows for Vero since Jan 2026)
- **Signal strength:** daily 1xxx-account inflows are a near-real-time activity proxy that's faster than POS revenue reconciliation
- **Forecaster integration:** use as a "today is going well/badly" signal during service
- **Schema work:** none
- **Risk:** lags by 0-3 days depending on bookkeeper cadence; not a true real-time signal

### Tier 4 — known unknowns

- **Weather forecast vs realised weather** — model uses forecast at predict time, but doesn't re-check against actual weather to attribute error
- **Holiday-specific seasonality** — currently bucketed as "high/low impact"; Christmas Eve vs random May 1 are treated similarly
- **Business stage** (`businesses.business_stage`: new / 1y / 3y) — could modulate confidence intervals but currently not read by the forecaster
- **Anomaly attribution** — `alerts.confirmation_status='confirmed'` filters baseline; we don't yet learn from owner-classified anomalies (e.g. "this dip was a private event closure" → mark as recurring forecast adjustment)

---

## Recommended build order

### Phase 2 (next 2-3 weeks) — Tier 1 signals

Each Phase ships as a model version bump with full back-testing against `daily_forecast_outcomes`.

1. **v1.7.0 — scheduled staff multiplier**
   - Read `staff_logs` for the forecast date
   - Compute `staff_factor = scheduled_hrs / weekday_avg_scheduled_hrs`
   - Clamp [0.6, 1.5]
   - Multiply into forecast as `staff_factor_pct`
   - Capture in snapshot; back-test on Vero + Chicce
   - **Expected MAPE improvement: 5-10 pp on businesses that forward-schedule**

2. **v1.8.0 — three-stream revenue forecasting**
   - Split forecast into dine_in / takeaway / alcohol
   - Each stream gets its own YoY anchor + recency
   - Sum at the end
   - When stream data unavailable, fall back to whole-business
   - **Expected MAPE improvement: 5-15 pp during seasonal mix transitions**

3. **v1.9.0 — per-department forecasting**
   - Identify per-business department list from `revenue_logs.provider`
   - Forecast each department independently; sum
   - **Expected MAPE improvement: 3-8 pp on multi-department businesses**

### Phase 3 (4-6 weeks)

4. **v2.0.0 — synthetic daily backfill + regional benchmark**
   - One-off: synthesize daily values for 2025 from monthly_metrics
   - Enable `yoy_same_weekday` for all businesses
   - Add regional weekday factor (when ≥3 customers)
5. **v2.1.0 — forward-scheduled multi-day forecast** (depends on customer behavior; ships when ≥1 customer forward-schedules)

### Phase 4 (when owner unblocks)

6. **v3.0.0 — reservations + events + POS-mapped demand**
   - Reservations integration (one provider first)
   - Events API key + geocoding
   - POS-recipe mapping owner action

### Phase 5 — Learned coefficients (Q4 2026)

7. **v4.0.0 — multivariate regression learned from daily_forecast_outcomes**
   - Replace hardcoded weights (e.g. 30 % YoY + 70 % baseline) with per-business learned coefficients
   - Requires 6-12 months of resolved outcomes per business
   - Already have the audit infrastructure (Piece 1)

---

## What I'd ship THIS WEEK if you greenlight

**v1.7.0 — scheduled staff multiplier.** Tier 1, zero new schema, biggest single signal we're ignoring, validated against Vero data showing 0.80 correlation. Ships in a single push.

The other Tier 1 items (revenue mix decomposition, per-department) need slightly more design — they change the forecast SHAPE rather than just adding a multiplier. They'd be v1.8 / v1.9 over the following 2 weeks.

---

## Open questions for you

1. **Synthetic daily backfill for 2025:** safe to populate `daily_metrics` rows with derived values? Tagging the source so we know they're synthetic protects downstream code, but conceptually it's "creating data we didn't observe." Your call.
2. **Cross-business benchmark:** OK to use Vero's own data to inform Chicce's forecast and vice versa? Privacy-clean (no PII), but worth flagging.
3. **Events API key:** if you can get a Ticketmaster API key, I can wire the events signal end-to-end same day.
