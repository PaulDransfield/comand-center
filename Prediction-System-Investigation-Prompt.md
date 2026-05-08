# CLAUDE CODE — PREDICTION SYSTEM INVESTIGATION
> Generated 2026-05-08
> Read-only investigation. No code changes. Single deliverable: a markdown report.

---

## What this is

We're scoping a substantial future project: an architecturally-sound prediction system for restaurant revenue that uses every available signal (year-over-year, recent weeks, weather, holidays, possibly more), and that **measurably improves over time** through a feedback loop comparing predictions to actuals.

Before designing anything, we need to map ground truth: every prediction the system currently produces, every data signal that could feed a future prediction, and crucially — whether prediction-vs-actual reconciliation exists anywhere today.

This investigation produces a markdown report. No code changes. The report informs an architecture document we'll write afterward.

---

## Hard constraints

- **Read-only.** Don't modify any files. No migrations. No tooling changes.
- **Don't propose architectures, libraries, or patterns.** Just describe what exists.
- **Don't speculate on what data "should" exist.** Describe what does.
- **Don't try to consolidate or unify anything.** Just map what's there separately.
- **Don't compare to external products.** No competitive context.
- **No FIXES.md entry, no commits.**
- **Don't implement audit logging or reconciliation as part of this investigation.** That's the work that comes after.

If you find issues in adjacent code (bugs, dead code, performance problems), note them in a "Bonus observations" section but do not act on them.

---

## Twelve questions to answer

### Section A — Every prediction pathway in the system today

#### 1. Inventory every place the system predicts a future number

Think broadly. Not just `predicted_revenue`. Anywhere code says "given X, we expect Y."

For each pathway, document:
- Logical name (e.g., "scheduling-AI revenue forecast", "weather-demand prediction", "anomaly baseline expectation", "P&L tracker forward projection", "budget variance forecast", "Monday Memo predictions")
- File path of the primary computation
- Endpoint that exposes it (if any)
- Where the prediction is *consumed* in the UI (which page, which component)
- The math/logic in plain language: what inputs go in, what number comes out
- Time horizon (next day? next 7 days? next 30 days? next quarter?)
- Granularity (daily? weekly? monthly?)
- Per-business or cross-business?

I'd estimate there are at least 4-6 distinct prediction pathways. Find them all.

#### 2. The two we already know about — confirm details

For `/api/scheduling/ai-suggestion` (the chart's predicted bars and labour scheduling card):
- Where does `est_revenue` come from in the code? Is it Claude-generated, math-derived, or hybrid?
- What inputs does the LLM see (if LLM)? Past N weeks? Weather? Holidays? Anomaly history?
- How long does generation take per business per call? What's the cost profile per call?
- Cache lifetime?
- What happens if the LLM's output is malformed or out-of-range — fallback logic?

For `/api/weather/demand-forecast` (the dashboard demand outlook):
- Confirm `lib/weather/demand.ts` is the primary computation
- What does the rolling-baseline-times-weather-bucket math actually do, step by step?
- Is anything LLM-touched in this pathway, or is it pure math?
- How does the holiday case work — confirmed `baseline_revenue` returned as-is for holidays per dashboard investigation?

#### 3. Implicit predictions that might not look like predictions

Some "predictions" are baked into other features and may not be obvious:
- The labour scheduling agent's "if you keep this schedule, labour will be 45%" — is that a prediction or a calculation?
- Anomaly detection's "expected" baseline — when the system flags "OB supplement spike +78%", what's the baseline 78% is measured against? How is that baseline computed and is it itself a prediction?
- The Monday Memo briefing — does it predict next week's numbers? Where does that data come from?
- Budget vs actual variance — does it project current trajectory forward?

Document each. Many of these are math-derived, not LLM-generated, but they're all making implicit predictions and they all could feed (or compete with) a unified prediction system.

---

### Section B — Every data signal available

#### 4. Currently captured per-business data

Map the database tables and columns that track historical signal-rich data per business:
- `daily_metrics` — confirm columns: revenue, labour_cost, labour_pct, total_covers, anything else?
- `tracker_data` — what monthly P&L fields are stored?
- POS-derived fields — what's available per-business depending on integration?
- Personalkollen-derived fields — what's available per-business?
- Anything else relevant (events, manual notes, custom fields, holiday overrides)?

For each, note:
- How far back does data go for Vero specifically?
- How far back for typical/expected new customer onboarding?
- Are there gaps (missing days), and how does the system handle them?

#### 5. External signal sources currently integrated

Beyond business-specific data, what external signals does the system pull?
- Weather (Open-Meteo / SMHI confirmed) — what fields? How far ahead?
- Holidays (per dashboard investigation, `lib/holidays/sweden.ts` etc.) — full list? Public holidays only or also school holidays, vacation periods?
- Anything else: economic indicators, FX rates, events feed, news?

#### 6. Signals the architecture *could* use but doesn't today

This is the speculative-but-grounded list. From the codebase, what would be plausible to add:
- Day-of-month patterns (payday effects) — derivable from `daily_metrics`, no new external data needed
- Year-over-year same-day — derivable from `daily_metrics` if data goes back ≥ 12 months
- Recent trend (4-week, 8-week moving averages) — derivable
- Weather *change* relative to seasonal norm — derivable from weather history
- Klämdag (squeeze-day) effects around public holidays — derivable from holiday calendar
- School holiday periods (sportlov, höstlov, summer) — would require external data (Skolverket has this; not necessarily integrated)
- Local events (matches, concerts, markets) — would require new external integration
- Salary cycles (Sweden's 25th-of-month payday) — derivable but probably not currently leveraged

For each: is it derivable from existing data, requires light external integration, or requires substantial new infrastructure?

#### 7. Signal availability by customer

Critical for cross-customer architecture:
- Which signals are universally available (any business has them) — date, weather, holidays
- Which depend on integration depth — POS-derived covers, departments, Personalkollen labour
- Which are explicitly per-business-locale — Swedish holidays vs Norwegian holidays vs UK holidays
- Are there businesses in the current/near-term customer base where critical signals are missing?

For Vero specifically, what's the actual completeness of the data going back N months?

---

### Section C — The reconciliation gap

#### 8. Is prediction-vs-actual reconciliation logged anywhere today?

This is the most important question in this investigation.

- Is there any table, column, or log where the system stores "we predicted X and the actual was Y"?
- For the scheduling-AI's `est_revenue`: when the day's actual revenue arrives, is the delta computed and stored anywhere? Is it shown in the UI anywhere ("we predicted 28k, you did 31k")?
- For weather-demand's `predicted_revenue`: same question — is the delta logged?
- For anomaly detection: when an anomaly is dismissed or proven correct, is anything stored about the resolution?

Strong prior: the answer is "no, nothing is logged." But the investigation should confirm this and find the closest-existing-thing if any.

#### 9. Data freshness and reconciliation timing

When the actual number lands for any given metric, how quickly is it usable?
- Daily revenue from POS — when does today's actual become available in `daily_metrics`? End of day? Next morning? When the POS syncs?
- Are there backfills or corrections that retroactively change historical numbers? If yes, how often?
- Labour cost from Personalkollen — same question
- Are timestamps stored for "when was this row last touched" so you can detect schema drift or backfills?

This affects when a reconciliation job *could* run reliably.

#### 10. Existing AI/LLM usage in the codebase

Map every place LLMs are currently used:
- Anomaly description rewriting (Haiku, per dashboard investigation, in `lib/alerts/detector.ts`)
- Scheduling agent's `est_revenue` generation (if confirmed LLM-generated in #2)
- Monday Memo content generation
- Overheads explanation (`overhead_flags.ai_explanation`, per overheads investigation)
- Anywhere else?

For each: which model is used (Sonnet, Haiku, Opus), what's the cost profile per call, how often it runs.

This matters for architecture: a learning system that adds an LLM "pattern extraction" pass needs to fit alongside existing LLM calls without budget surprises.

---

### Section D — Data quality realities

#### 11. The actual state of Vero's data

For the one real customer:
- How many days of complete `daily_metrics` rows are there?
- How many days have gaps or null values?
- How many days are flagged as anomalies (which might pollute baselines if not handled)?
- Are there days where revenue was recorded but covers wasn't? Or vice versa?
- Are there obvious data quality issues — duplicate rows, timezone bugs, suspicious zero values?

This is the "would ML actually work today" reality check.

#### 12. Schema and migration history of relevant tables

Have the prediction-relevant tables had recent schema changes that might affect historical data interpretation?
- Has `daily_metrics` schema changed in the last 6 months?
- Were any columns added that didn't backfill, so older rows have nulls?
- Any column renames or semantic changes ("this used to mean X, now means Y")?

This matters because a learning system trained on data with a schema change in the middle will silently learn the wrong patterns.

---

## Bonus questions worth answering if easy

- Does the codebase have any existing "experiment framework" or A/B testing infrastructure that prediction-vs-actual could plug into?
- Is there existing analytics tracking on what predictions operators look at (which days they hover, click)?
- Are there any feature flags currently controlling prediction-related behavior?
- What's the largest historical dataset the system has access to in aggregate (across all customers including dummy/test data)?

---

## Deliverable

Single markdown file at repo root: `PREDICTION-SYSTEM-INVESTIGATION-2026-05-08.md`. Don't commit it; Paul reads and decides next steps.

Structure:

```
# Prediction System Investigation
> Generated by Claude Code on [date]
> Read-only. Maps every prediction pathway, every available signal, and the reconciliation gap.

## Section A — Prediction pathways

### 1. Full inventory
[Table or list with each pathway: name, file path, endpoint, UI consumer,
math/logic in plain language, horizon, granularity, scope]

### 2. The two known pathways — confirmed details
[scheduling-AI: code path, LLM-or-math, LLM inputs, cost profile, fallbacks]
[weather-demand: code path, math step-by-step, LLM-touched-or-not, holiday handling]

### 3. Implicit predictions
[Each: described, classified as prediction-or-calculation, where it surfaces]

## Section B — Available signals

### 4. Per-business captured data
[Table per source: where data lives, depth for Vero, depth for typical customer, gap handling]

### 5. External signals integrated
[Weather, holidays, anything else — fields, depth, refresh cadence]

### 6. Plausible additional signals
[Each: derivable-from-existing, light-integration, or substantial-new-infra]

### 7. Signal availability by customer profile
[Universal vs integration-dependent vs locale-specific. Vero's actual completeness.]

## Section C — Reconciliation gap

### 8. Is reconciliation logged anywhere?
[Direct answer with evidence. Closest-existing-thing if any.]

### 9. Data freshness
[Per signal: when actual lands, backfill behavior, timestamp tracking]

### 10. Existing LLM usage
[Each: model used, cost profile, frequency]

## Section D — Data quality

### 11. Vero's actual data state
[Completeness, gaps, anomaly contamination, suspicious values]

### 12. Schema history
[Recent changes that affect historical interpretation]

## Bonus observations
[Adjacent issues found but not acted on]

## Summary — what a learning prediction system would need to be built
[One paragraph naming:
- The prediction pathways that would be consolidated or kept separate
- The signals genuinely available today vs requiring new work
- The reconciliation infrastructure that does NOT exist (and what's the lift to build it)
- The data quality realities that constrain what ML can do today
- The customer-base reality (single customer = limited learning, must architect for cross-customer future)]
```

End with this exact line:

> "Investigation complete. No code changed. Ready for review."

Then stop.

---

## Time budget

2-3 hours. This is wider than the scheduling/overheads/dashboard investigations because it spans the entire prediction surface rather than one feature.

If you're approaching 3.5 hours, surface what you've covered well versus what was harder to map and submit a partial report rather than burning time. It's better to have 9 of 12 questions answered well than 12 answered superficially.

---

## What success looks like

After Paul reads the report, he can answer:

1. **How many distinct prediction pathways exist today?** Two? Five? More?
2. **Are predictions ever reconciled against actuals anywhere?** (Strong prior: no.)
3. **What's the actual completeness of Vero's data?** Enough for any learning, or too gappy?
4. **Which signals are immediately available, which need light work, which need substantial new infrastructure?**
5. **What does the existing LLM usage look like cost-wise?** Adding one more LLM layer — affordable or budget concern?
6. **Could a reconciliation/audit logging layer be added independently of any prediction architecture work?** What's the minimal slice — one table, a few endpoint changes?

If those questions are answerable from the report, the next step is a real architecture document — not another investigation.

---

## What I'm explicitly NOT asking for

- Architecture proposals
- Library or model recommendations
- Cost/value analysis
- Comparison against other products
- Performance optimization
- Schema migration suggestions or new table designs
- LLM prompt engineering suggestions
- ML model recommendations

If you find issues in any of these areas during the investigation, note them in "Bonus observations" but do not act on them.

---

## A note on the most important question

**Question 8 — "Is prediction-vs-actual reconciliation logged anywhere today?" — is the highest-priority question in this investigation.**

If the answer is "no, nothing is logged," that confirms the foundational gap and shapes everything downstream. If the answer is surprising — e.g., there's a partial audit table somewhere we forgot about, or the scheduling agent already logs its predictions to a `forecast_audit` table — that changes the architecture significantly.

Spend extra time here if other questions are easy.
