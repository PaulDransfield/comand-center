# CommandCenter — Predictive Architecture & Self-Learning

> Companion to `APP-PIPELINE-FLOWCHART.md`. That one shows the data flow;
> this one shows *how the system gets smarter over time*.
> Hand both to a design AI together.

The predictive surface has two intertwined jobs:

1. **Predict the future** — revenue tomorrow, labour next week, food cost next
   month, anomalies right now.
2. **Learn from being wrong** — capture every prediction against the actual,
   trim the bias, decay the bad signals, promote the good ones.

The architecture is deliberately **layered with safety clamps**. The fast,
deterministic layers run first; the heavier, more expressive AI layers
adjust on top with hard clamps so they can never make a confident-wrong
recommendation that would burn cash if the model misfires.

---

## 1. The three-layer prediction stack

Every numeric forecast in CommandCenter (revenue, labour, budget) goes
through the same three layers. Each layer can be the final answer; later
layers are enrichment that can soft-fail back to the previous one.

```mermaid
flowchart TB
    subgraph L0["Layer 0 — Deterministic baseline (always runs)"]
        DET_HIST["Historical 12-week mean<br/>per (day_of_week, hour)"]
        DET_RECENCY["Recency weighting:<br/>last 4 weeks × 2.0<br/>(via lib/forecast/recency.ts)"]
        DET_PULLFW["This-week pull-forward scaler<br/>(today's run-rate ÷ baseline)"]
        DET_SEASON["Seasonality<br/>(month-of-year shape)"]
        DET_OUT["Deterministic prediction<br/>+ confidence interval"]
    end

    subgraph L1["Layer 1 — Historical anchor + clamps"]
        L1_ANCHOR["Last-year actual<br/>monthly anchor<br/>(tracker_data)"]
        L1_STRETCH["Max +15% stretch<br/>(no extrapolated YTD)"]
        L1_GAP["Data-gap detector<br/>(stage='new'?<br/>missing months?)"]
        L1_FLOOR["Food cost floor<br/>28-32% clamped<br/>server-side"]
        L1_OUT["Anchored prediction<br/>(or honest-incomplete<br/>when no comparable history)"]
    end

    subgraph L2["Layer 2 — LLM adjustment (enrichment, never load-bearing)"]
        L2_CTX["Context: holidays,<br/>events, weather hints,<br/>local knowledge"]
        L2_HAIKU["Haiku 4.5<br/>+ prompt caching<br/>+ tool use"]
        L2_OUTPUT["Multiplier in [0.5, 1.5]<br/>(HARD CLAMP server-side —<br/>never trust raw output)"]
        L2_SOFT["Soft-fail to L1<br/>if Haiku errors,<br/>times out, or returns<br/>out-of-range value"]
    end

    L0_HIST_DATA["daily_metrics +<br/>revenue_logs +<br/>staff_logs"] --> DET_HIST
    DET_HIST --> DET_RECENCY --> DET_PULLFW --> DET_SEASON --> DET_OUT

    DET_OUT --> L1_ANCHOR
    TRACKER["tracker_data<br/>(closed months,<br/>provisional filter)"] --> L1_ANCHOR
    L1_ANCHOR --> L1_GAP --> L1_STRETCH --> L1_FLOOR --> L1_OUT

    L1_OUT --> L2_CTX
    HOL["lib/holidays/sweden.ts<br/>(17 SE days)"] --> L2_CTX
    EV["events<br/>(Ticketmaster, parked)"] -.-> L2_CTX
    L2_CTX --> L2_HAIKU --> L2_OUTPUT --> L2_SOFT

    L2_SOFT --> FINAL["Final prediction<br/>+ source label<br/>(deterministic /<br/>anchored / llm_adjusted)"]
    L1_OUT --> FINAL

    FINAL --> CAPTURE["ai_forecast_outcomes<br/>(captured at month-end<br/>vs actual)"]

    classDef l0 fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef l1 fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef l2 fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef store fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef out fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class DET_HIST,DET_RECENCY,DET_PULLFW,DET_SEASON,DET_OUT l0
    class L1_ANCHOR,L1_STRETCH,L1_GAP,L1_FLOOR,L1_OUT l1
    class L2_CTX,L2_HAIKU,L2_OUTPUT,L2_SOFT l2
    class L0_HIST_DATA,TRACKER,HOL,EV,CAPTURE store
    class FINAL out
```

### Why three layers, not one?

A single all-LLM forecaster would be confidently wrong on cold-start, slow,
expensive, and impossible to debug. A pure-arithmetic forecaster would miss
known shocks (Ascension Thursday, Midsummer, a Eurovision night in town).

Layering gives:

- **Layer 0 always answers** — no external dependency. If Anthropic is
  down, the dashboard still loads with a number.
- **Layer 1 adds memory** — last year's June is the strongest signal for
  this June at a restaurant.
- **Layer 2 adds judgement** — Haiku reads the holiday calendar and a
  short business-state preamble (from `lib/ai/scope.ts`) to nudge the
  number ±50%. Clamped server-side so it can't go feral.

The two final surfaces (deterministic + LLM-adjusted) are graded
**side-by-side** in `ai_forecast_outcomes`. Over months we can see whether
the LLM layer is actually adding signal or just noise.

---

## 2. Where each prediction comes from

```mermaid
flowchart LR
    subgraph PRED["Prediction targets"]
        P_REV["Revenue forecast<br/>per day / week / month"]
        P_LAB["Labour requirement<br/>per shift block"]
        P_FOOD["Food cost forecast<br/>per recipe / budget"]
        P_BUDGET["Monthly budget<br/>targets"]
        P_ANOM["Anomaly detection<br/>(today's outliers)"]
        P_PRICE["Supplier price creep<br/>(month-over-month delta)"]
    end

    subgraph PATH["Path through the stack"]
        REV_FLOW["L0 + L1 + L2<br/>(full three layers)"]
        LAB_FLOW["L0 demand → labour<br/>conversion + L2<br/>asymmetric (cuts only)"]
        FOOD_FLOW["Recipe cost engine<br/>+ ingredient-level<br/>variance from invoices"]
        BUDGET_FLOW["L1 anchor + L0 trend<br/>+ owner stretch %"]
        ANOM_FLOW["Statistical bands<br/>(z-score on 30-day<br/>rolling) + Haiku<br/>explanation"]
        PRICE_FLOW["per-supplier-per-product<br/>median Δ + Haiku<br/>plain-English alert"]
    end

    P_REV --> REV_FLOW
    P_LAB --> LAB_FLOW
    P_FOOD --> FOOD_FLOW
    P_BUDGET --> BUDGET_FLOW
    P_ANOM --> ANOM_FLOW
    P_PRICE --> PRICE_FLOW

    REV_FLOW --> S_FORECAST["forecasts table"]
    LAB_FLOW --> S_SCHED["scheduling_<br/>recommendations"]
    FOOD_FLOW --> S_RECIPES["recipes (live cost)"]
    BUDGET_FLOW --> S_BUDGET["budgets table"]
    ANOM_FLOW --> S_ALERTS["alerts table"]
    PRICE_FLOW --> S_EMAIL["monthly digest<br/>email"]

    classDef pred fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef path fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    class P_REV,P_LAB,P_FOOD,P_BUDGET,P_ANOM,P_PRICE pred
    class REV_FLOW,LAB_FLOW,FOOD_FLOW,BUDGET_FLOW,ANOM_FLOW,PRICE_FLOW path
    class S_FORECAST,S_SCHED,S_RECIPES,S_BUDGET,S_ALERTS,S_EMAIL store
```

---

## 3. Self-learning — three feedback loops

The system learns through **outcome capture** at three different timescales.
Each loop has the same shape: prediction → observation → bias correction →
better prediction next time.

### 3a. The forecast calibration loop (monthly)

```mermaid
flowchart LR
    PREDICT["Forecast made<br/>(any of 6 agents +<br/>any forecast surface)"] --> WAIT["Wait for the<br/>actual to land"]
    WAIT --> ACTUAL["Actual from<br/>daily_metrics /<br/>monthly_metrics"]
    ACTUAL --> CAPTURE["ai_forecast_outcomes<br/>(prediction, actual,<br/>source layer,<br/>error, MAPE)"]

    CAPTURE --> RECONCILE["Forecast calibration cron<br/>1st of month, 04:00 UTC<br/>(pure arithmetic — no LLM)"]
    RECONCILE --> AGG["Aggregate per<br/>(org, business, metric,<br/>source layer):<br/>median bias, MAPE,<br/>over/under skew"]
    AGG --> WRITE["forecast_calibration table<br/>(accuracy + bias_factor<br/>per business)"]

    WRITE --> FEEDBACK["Next month's forecasts<br/>multiply by bias_factor<br/>(only when MAPE &gt; threshold)"]
    FEEDBACK --> PREDICT

    OWNER["Owner feedback UI<br/>(thumbs up/down on<br/>a prediction)"] --> CAPTURE

    classDef step fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef cron fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef owner fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class PREDICT,WAIT,ACTUAL,AGG,FEEDBACK step
    class CAPTURE,WRITE store
    class RECONCILE cron
    class OWNER owner
```

**Why pure arithmetic?** The calibration job runs unsupervised once a month
and its output multiplies *every* future forecast. An LLM hallucinating a
bias factor of 1.4 would silently inflate every prediction. Median bias
across a measured sample is auditable.

**Cold-start protection**: bias factor is only applied when (a) MAPE
crosses a threshold AND (b) there is comparable history. The 2026-01 Vero
"+200% over-forecast" bug came from a ratio multiplier without a
comparable-history gate; the post-mortem hardened this.

### 3b. The matcher correction loop (continuous)

Every time the owner corrects a matcher decision in `/inventory/review`,
two things happen: the visible decision flips, and a hidden quality signal
updates the alias's reputation.

```mermaid
flowchart TB
    LINE["Supplier invoice line<br/>matched to product X<br/>via alias A<br/>(match_method='fuzzy')"] --> SHOW["Surface in<br/>/inventory/review<br/>OR in items modal"]
    SHOW --> OWNER{"Owner action"}

    OWNER -- "confirm" --> PROMOTE["alias A flipped to<br/>match_method='owner_confirmed'<br/>(now protected at<br/>Gate 0c safeguard)"]
    OWNER -- "repoint" --> REPOINT["alias A's product_id<br/>updated; history<br/>back-fills to new product"]
    OWNER -- "skip supplier" --> CLASSIFY["supplier_classifications<br/>(business_id, supplier,<br/>'not_inventory')"]

    PROMOTE --> OUTCOME["inventory_review_outcomes<br/>(context, decision,<br/>business, alias_id)"]
    REPOINT --> OUTCOME
    CLASSIFY --> OUTCOME

    OUTCOME --> RECORD["product_aliases_record_<br/>correction(alias_id, n)<br/>RPC fires"]
    RECORD --> COUNT["product_aliases.<br/>corrections_against<br/>increments"]
    COUNT --> DEMOTE{"corrections_against<br/>≥ 2?"}
    DEMOTE -- yes --> KILL["alias deactivated<br/>(is_active=false)<br/>+ outcome row<br/>('rebate_guard_backfill')"]
    DEMOTE -- no --> KEEP["alias stays active<br/>but flagged in audit"]

    OUTCOME --> METRICS["Watch metrics:<br/>- agreement_pct<br/>- queue depth trend<br/>- normalization re-confirm rate"]
    METRICS --> EMAIL["Phase D watch email<br/>(if regression detected)"]

    classDef input fill:#ffe4c2,stroke:#d97706,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef sig fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef alert fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    class LINE,SHOW,OWNER input
    class PROMOTE,REPOINT,CLASSIFY,OUTCOME,COUNT,KEEP,KILL store
    class RECORD,DEMOTE,METRICS sig
    class EMAIL alert
```

**Three quality signals** the matcher watches over time:

1. **Agreement %** — share of new lines the matcher decided correctly
   (verified by owner not touching them within N days).
2. **Queue depth trend** — is `/inventory/review` getting longer or shorter?
3. **Normalization re-confirm rate** — owner confirming the same product
   under a different description variant. High rate = the normaliser is
   too strict.

When any signal moves the wrong way, an email digest fires. The matcher
itself doesn't auto-retrain on owner corrections (that would be unsafe at
restaurant scale) — instead the corrections become data for the next
manual matcher rule update.

### 3c. The category dictionary feedback loop (slow, per-tenant)

The BAS account → operator bucket dictionary (`lib/overheads/basBuckets.ts`)
is global, but every business has its own override layer at
`supplier_classifications`. When an owner says "Frimurarholmen AB is my
landlord, never food, regardless of BAS account", that overrides the
global decision for that one business.

```mermaid
flowchart LR
    GLOBAL["lib/overheads/<br/>basBuckets.ts<br/>(87 BAS codes →<br/>35 buckets)"] --> DECIDE["Categorize<br/>tracker_line_item"]
    PERBIZ["supplier_classifications<br/>(per business override)"] --> DECIDE
    DESCRULES["lib/inventory/<br/>description-rules.ts<br/>(deposits, rent,<br/>logistics)"] --> DECIDE

    DECIDE --> SHOW["/overheads<br/>subcategory breakdown<br/>+ drilldown"]
    SHOW --> OWNER_REV["Owner reviews<br/>flag cards"]
    OWNER_REV --> CORRECT{"Wrong category?"}
    CORRECT -- "yes (one biz)" --> PERBIZ
    CORRECT -- "yes (everyone)" --> ENG["Engineering review<br/>(don't auto-mutate<br/>global dict)"]
    ENG --> DICTUP["Manual dict update<br/>+ pre-COMMIT verify<br/>by SPEND not row count"]
    DICTUP --> GLOBAL

    classDef dict fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef gate fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef ui fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class GLOBAL,DESCRULES dict
    class PERBIZ store
    class CORRECT,ENG,DICTUP gate
    class SHOW,OWNER_REV ui
```

**Key principle**: the global dictionary is updated by humans, never by
the runtime. A miscoded invoice could otherwise cause an "auto-resolve"
that silently de-globalises a category for everyone. The Fortnox AB case
in the audit log is the cautionary example — 22 SaaS lines were
miscoded to 4xxx food accounts at one customer; an auto-resolver would
have wrongly removed Fortnox AB from the global SaaS list for everyone.

---

## 4. Safety mechanisms — why this never goes feral

The predictive layer talks to live owner decisions. A wrong forecast burns
labour cash; a wrong food-cost number kills menu pricing. Five hard rules
keep the system safe:

### Rule 1 — Honest-incomplete > confident-wrong

Every cost / forecast surface MUST distinguish "I don't know" from "the
answer is zero." When the cost engine can't bridge a unit, it returns
`null` and the UI shows an "Incomplete cost" badge. When the forecast
calibrator has no comparable history, it skips the bias multiplier
instead of defaulting to 1.0 (which would mask a real cold-start).

### Rule 2 — Asymmetric scheduling

The scheduling AI can only **recommend cuts**, never adds. Reasoning:
suggesting "schedule 1 more server Saturday" creates owner liability if
demand doesn't materialise; suggesting "you could cut 2 hours from the
prep shift Wednesday" only costs money if the owner actively follows it.
The asymmetry is enforced in the prompt AND in the post-processing.

### Rule 3 — LLM is enrichment, never load-bearing

Every AI surface has a deterministic backup path that ships the same
final shape. Piece 4 LLM adjustment soft-fails to the L1 anchored
forecast. Ask CC has tool-use fallbacks. AI bulk recipe importer
falls back to "draft saved, fix manually" on parse error. The product
keeps working when Anthropic's API is down.

### Rule 4 — Clamps everywhere

- LLM forecast multiplier: `[0.5, 1.5]` server-side
- Food cost floor: 28-32%
- Budget stretch from last-year actual: max +15%
- Recipe yield: 0-10 portions per cover
- Method text: 20k chars
- Pre-order party size: 1-500
- AI daily spend: `MAX_DAILY_GLOBAL_USD=150` kill switch

Clamps are the single biggest reason a "10× forecast" or "1000 portion
per cover" never reaches production.

### Rule 5 — Trust gates on AI tool use

The Ask CC chat agent has 15 tools (revisor / vouchers / inventory /
operations). Before any cross-tenant boundary, `requireBusinessAccess()`
verifies the caller's org owns the business. Before any AI call,
`checkAndIncrementAiLimit()` enforces the daily quota atomically. Before
any matcher decision, the four-signal Gate 0 precedence runs in a
fixed order so no later rule can undo an earlier safeguard.

---

## 5. The "comparable history" gate — cold-start handling

The single most-broken assumption in restaurant prediction is "we have
enough history to forecast." A new restaurant, a new menu, a new POS
provider, a single missing month — any of these makes the L0 deterministic
output meaningless.

```mermaid
flowchart TB
    REQ["Forecast requested for<br/>(business, period)"] --> CHECK{"Comparable<br/>history check"}

    CHECK --> Q1["Q1: business_stage<br/>= 'new'?"]
    CHECK --> Q2["Q2: ≥ 8 weeks<br/>continuous data<br/>in period family?"]
    CHECK --> Q3["Q3: Same-month-<br/>last-year exists<br/>and non-zero?"]
    CHECK --> Q4["Q4: ≥ 1 closed month<br/>in tracker_data?"]

    Q1 -- "yes (new)" --> SKIP_ANCHOR["Skip last-year anchor<br/>(no comparable data)"]
    Q2 -- "no" --> SKIP_DET["Mark L0 confidence low"]
    Q3 -- "no" --> SKIP_ANCHOR
    Q4 -- "no" --> SKIP_ANCHOR

    SKIP_ANCHOR --> FALLBACK["Fall back to:<br/>1. Owner-set targets<br/>2. Industry benchmark<br/>3. 'Not enough data' honest"]
    SKIP_DET --> FALLBACK

    Q1 -- "no (established)" --> NORMAL["Normal three-layer flow<br/>(L0 + L1 + L2)"]
    Q2 -- "yes" --> NORMAL
    Q3 -- "yes" --> NORMAL
    Q4 -- "yes" --> NORMAL

    NORMAL --> FORECAST["Forecast issued<br/>with confidence label"]
    FALLBACK --> FORECAST

    classDef question fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef skip fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef ok fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef out fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class CHECK,Q1,Q2,Q3,Q4 question
    class SKIP_ANCHOR,SKIP_DET,FALLBACK skip
    class NORMAL ok
    class FORECAST out
```

---

## 6. What "learning" means concretely

The system doesn't fine-tune models. It learns by **moving data into the
context** that future predictions see. Three storage rails carry the
learned state forward:

| Rail | What it stores | Used by |
|---|---|---|
| `forecast_calibration` | Bias factor + MAPE per (business, metric, source layer) | Every forecast multiplied here before display |
| `ai_forecast_outcomes` | Each prediction vs actual + source layer attribution | Calibration cron + side-by-side grading of L1 vs L2 |
| `product_aliases.corrections_against` | Demerit count per alias | Matcher Gate 0c — demoted aliases lose their veto power |
| `inventory_review_outcomes` | Every owner matcher correction | Phase D watch metrics + future matcher rule training data |
| `supplier_classifications` | Per-business "always not_inventory" overrides | Matcher Gate 0a (always wins over global) |
| `forecast_calibration.business_stage` | Onboarding state (new / 1y / 3y) | Cold-start gate skips last-year anchor |

When a new model lands (e.g. Sonnet 4.7 → 5.0), nothing migrates: the
rails are model-agnostic. The bias factor for revenue at Vero is the same
number regardless of which Claude generation produced the underlying
prediction.

---

## 7. What's not built yet (predictive roadmap)

The architecture has empty seats reserved for these:

- **Waste log → demand calibration** — actual produced-vs-sold per dish
  would re-train `recipes.portions_per_cover` from real data instead of
  owner guesses. Reservoir: `prep_sessions.completed_at` + a new
  `waste_log` table.
- **POS demand → prep auto-fill** — `pos_menu_items.recipe_id` links POS
  sales to recipes. Once owner-mapped, historical sales can predict
  covers without manual entry. Doc: `POS-RECIPE-MAPPING-PLAN.md`.
- **Booking provider integration** — SuperbExperience / OpenTable /
  ResDiary / Caspeco feed external cover counts directly into the prep
  + scheduling layers. Doc: `BOOKING-API-COVERS-PLAN.md`.
- **Live bank feeds (PSD2)** — direct cash position + cash flow feed,
  closes the gap between accounting (Fortnox) and reality. Doc:
  `LIVE-BANK-FEEDS-PLAN.md`. Trigger: ~15-25 paying customers.
- **Events → LLM forecast wiring** — Ticketmaster API + Stockholm
  geocoding → "Eurovision night, +30% expected." Doc:
  `EVENTS-LLM-INTEGRATION-PLAN.md`. ~Half-built; dormant until owner
  triggers.
- **Recipe-level waste reconciliation** — compare `waste_pct` baked
  into recipe cost vs actual waste from produced-vs-sold. Closes the
  food-cost calibration loop the same way `forecast_calibration` closes
  revenue.

All of these are reservoirs of additional context for the L2 LLM layer to
read from; none change the three-layer shape.

---

## Summary — the architecture in one paragraph

CommandCenter predicts by stacking three layers (deterministic baseline →
historical anchor → LLM adjustment), with hard clamps at every boundary
so a model failure can't cause a confident-wrong number to ship. It learns
by capturing every prediction in `ai_forecast_outcomes`, every owner
correction in `inventory_review_outcomes`, and every matcher demerit in
`product_aliases.corrections_against` — then turning those streams into
bias factors, alias demotions, and per-business overrides that ride
forward into the next prediction. The LLM is enrichment, never
load-bearing; the deterministic backup always answers. The owner sees
honest-incomplete badges instead of fabricated numbers when the data
isn't there. That's the whole game.
