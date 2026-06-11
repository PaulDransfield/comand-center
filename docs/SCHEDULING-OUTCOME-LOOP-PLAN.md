# Scheduling outcome loop — scope (Option C)

> Status: **SCOPED, not built.** Companion to the scheduling feedback work (reason picker + Option A: confirmed/rejected feedback now flows into the `ai-recommend` prompt). This closes the remaining gap: validating whether *accepted* suggestions actually delivered.
> Captured 2026-06-11.

## 1. The problem (why A isn't enough)

Today the scheduling AI learns from owner **decisions** (reject / modify / approve), now including the reason. But a decision is not an **outcome**:

- When the owner approves a cut with `est_sek_saving: 1 400 kr`, **nothing ever checks whether that 1 400 kr actually materialised** — or whether revenue/service dropped because the floor was cut too thin.
- `est_sek_saving` is the model's own claim, never graded. So the AI cannot tell a *good* approved cut from a *regretted* one, and "approved" gets treated as unconditional success in Option A's positive examples.

For revenue forecasts this loop already exists (`daily_forecast_outcomes` + `cron/daily-forecast-reconciler`). **Scheduling has no equivalent.** C builds it.

## 2. What already exists to build on

| Asset | What it gives us | Where |
|---|---|---|
| `schedule_acceptances` | Per **accepted day**: `ai_hours`, `ai_cost_kr`, `current_hours`, `current_cost_kr`, `est_revenue_kr`, `decided_at`, `batch_id` | written by `accept-day` / `accept-all` |
| `schedule_ai_suggestions` | Per suggestion: `action`, `est_sek_saving`, `status` (`approved`/`applied`), `owner_action_at`, `shift_date`, `week_iso` | the AI output + owner decision |
| `daily_metrics` | **Actuals**: `revenue`, `staff_cost` per business per date | the master-sync aggregate |
| `cron/daily-forecast-reconciler` | The exact pattern to copy: walk past-dated pending rows, pull actuals, resolve or defer | reuse its shape |

The `schedule_acceptances` row is the natural unit: it already snapshots predicted (`ai_cost_kr`) vs the then-current cost and an `est_revenue_kr`. We just need to compare it to what actually happened.

## 3. The honest measurement problem (read first)

**We cannot cleanly attribute one cut's effect on a whole day.** Two hard limits:

1. **PK write-back blindness.** We *suggest*; the owner *applies the change manually in Personalkollen*. We never see the exact roster they ended up running — only the aggregate `daily_metrics.staff_cost` that syncs back. So per-suggestion causal attribution ("did Anna's −2h save exactly 380 kr") is not reliably observable.
2. **Confounding.** A day's labour % moves for many reasons (no-shows, walk-ins, weather). One suggestion is noise inside that.

**Therefore C measures at the DAY / WEEK level, not per-suggestion**, and frames results as *association, not proof*:

- **Saving realised?** For an accepted day, did actual `staff_cost` land at/below the predicted `ai_cost_kr` (within a tolerance band), vs the `current_cost_kr` baseline?
- **Revenue held?** Did actual `revenue` stay within a normal band of `est_revenue_kr` (and of the same-weekday 12-week baseline)? A cut "saved" labour but coincided with a revenue miss → **flagged, not celebrated.**

This keeps us honest-incomplete (the project's standing rule): we never claim a precise per-cut saving we can't see.

## 4. Schema (proposed)

One new table, mirroring `daily_forecast_outcomes`:

```
schedule_outcomes (
  id uuid pk,
  business_id uuid, org_id uuid,
  acceptance_id uuid  -> schedule_acceptances(id),   -- the accepted day
  outcome_date date,                                 -- the day being graded
  -- snapshots (frozen at acceptance):
  predicted_cost_kr numeric,      -- ai_cost_kr
  baseline_cost_kr  numeric,      -- current_cost_kr (what it would have cost unchanged)
  predicted_saving_kr numeric,    -- baseline - predicted
  est_revenue_kr numeric,
  -- actuals (filled by reconciler):
  actual_cost_kr numeric,
  actual_revenue_kr numeric,
  baseline_revenue_kr numeric,    -- same-weekday 12-week avg, for the "held?" test
  -- verdict:
  saving_realised_pct numeric,    -- (baseline - actual) / predicted_saving
  revenue_delta_pct numeric,      -- (actual - est_revenue) / est_revenue
  verdict text,                   -- 'delivered' | 'under_delivered' | 'revenue_risk' | 'unresolvable_*'
  resolution_status text,         -- 'pending' | 'resolved' | 'unresolvable_no_actual' | 'unresolvable_data_quality'
  resolved_at timestamptz,
  created_at timestamptz default now()
)
```

A `schedule_outcomes` row is **created when a day is accepted** (from the `schedule_acceptances` snapshot) and **resolved after the day passes**.

## 5. The reconciler (cron) — copy the forecast one

`app/api/cron/scheduling-outcome-reconciler` (new), modelled on `daily-forecast-reconciler`:

1. Pull `schedule_outcomes` where `outcome_date < today` and `resolution_status = 'pending'`.
2. For each, read `daily_metrics(revenue, staff_cost)` for `(business_id, outcome_date)`.
3. **Defer** if no actual yet and date is within 7 days (master-sync may still be backfilling). **Give up** past that → `unresolvable_no_actual`.
4. **Exclude anomaly days** — if a confirmed `anomaly_alerts` (revenue_spike/drop) exists on that date, mark `unresolvable_data_quality` (same guard the forecast reconciler uses). Grading against an admitted outlier is unfair.
5. Compute `saving_realised_pct`, `revenue_delta_pct`, and `baseline_revenue_kr` (same-weekday 12-week avg from `hourly_metrics`/`daily_metrics`).
6. Classify `verdict`:
   - `delivered` — actual cost ≤ predicted (within tolerance) AND revenue held (delta ≥ −X%).
   - `under_delivered` — saving fell short (owner likely didn't fully apply, or estimate was high).
   - `revenue_risk` — saving realised BUT revenue came in materially below est/baseline → the cut may have cost sales.
7. GDPR retention sweep (mirror the forecast reconciler's 3-year prune).

Schedule: daily, a little after the forecast reconciler (so `daily_metrics` is fresh).

## 6. Feeding it back (the payoff)

Two consumers, both small once the data exists:

- **Into `ai-recommend`** (extends Option A): add a `validated_outcomes` block — e.g. *"Your accepted cuts on Tue/Wed delivered the saving and revenue held; your Fri cut realised the saving but coincided with a 12% revenue miss — be cautious repeating Friday-evening cuts."* This upgrades Option A's positive examples from "approved" to **"approved AND it worked,"** and demotes the ones that backfired.
- **Owner-facing trust** (optional, high value): a small "Did the AI's cuts pay off?" card — *"Last 30 days: 8 of 11 accepted suggestions delivered (~6 200 kr saved, revenue held). 2 coincided with a revenue dip."* This is the honest scorecard that earns trust in the feature.

## 7. Trust gates (non-negotiable)

- Only grade `applied` (committed) acceptances, not bare `approved`, once we can distinguish them — `applied` means the owner actually ran it.
- Never grade anomaly days.
- Always frame as association; the owner-facing copy says "coincided with," never "caused."
- Honest-incomplete: if `daily_metrics` is missing/partial for the day, leave it unresolved rather than guessing.

## 8. Phasing

| Phase | Scope | Effort |
|---|---|---|
| C1 | `schedule_outcomes` table + write a row on each accept-day | small |
| C2 | Reconciler cron (resolve cost + revenue + verdict) | small-medium |
| C3 | `validated_outcomes` block in `ai-recommend` prompt | small |
| C4 | Owner-facing "did the cuts pay off?" scorecard | small-medium |

C1+C2 are the foundation; C3 is the AI payoff; C4 is the trust payoff. Each ships independently.

## 9. Open dependencies / risks

- **PK write-back blindness is the ceiling.** We measure day-level association, not per-cut causation. Don't oversell precision. (If a PK schedule-read ever lands — see `CASPECO-SCHEDULING-INTEGRATION-PLAN.md` for the source-aware model — per-suggestion attribution becomes possible.)
- Needs a defensible "revenue held" baseline — reuse the same-weekday 12-week average already computed in `ai-recommend` (`hourlyByWeekday`).
- Tolerance bands (saving %, revenue delta %) need one round of calibration against real resolved rows before the owner-facing scorecard is published.

## 10. Trigger to build

Owner asks to close the scheduling outcome loop, OR once enough `applied` acceptances accumulate to make resolved rows meaningful (~3–4 weeks of an owner actively accepting suggestions). Until then, Option A (decision-level feedback, now shipped) is the working learning loop.
