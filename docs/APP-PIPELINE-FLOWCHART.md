# CommandCenter — End-to-End Pipeline Flowchart

> Hand this whole file to Claude.ai / ChatGPT / Figma-AI and ask for a visual mockup.
> Every diagram below is in Mermaid syntax — most AI tools render Mermaid natively.
> If your target tool doesn't, the section text above each diagram is plain English
> the AI can re-draw from.

The pipeline has five pillars:

1. **Ingress** — Fortnox, Personalkollen, POS, Google, FX (data flowing IN)
2. **Inventory + Food Cost** — invoices → products → recipes → live cost (the engine)
3. **Prep + Orders + Waste** — kitchen-facing operational layer
4. **Scheduling + Labour** — PK shifts + AI suggestions → labour cost
5. **Aggregation + Monthly Outcomes** — single-writer rollup → dashboards, P&L, AI insights

A sixth layer wraps everything: **AI agents** (anomaly, forecast, briefing, scheduling)
and **feedback loops** (forecast outcomes, alias corrections, owner reviews) that
re-train the system over time.

---

## 1. Master pipeline — everything at a glance

```mermaid
flowchart TB
    subgraph INGRESS["INGRESS — external data sources"]
        FORTNOX["Fortnox<br/>(OAuth)<br/>vouchers, supplier<br/>invoices, BAS, P&amp;L"]
        PK["Personalkollen<br/>(OAuth)<br/>shifts, costs,<br/>departments"]
        POS["POS via PK<br/>(Onslip / Ancon /<br/>Swess)<br/>revenue, covers,<br/>VAT split"]
        GOOGLE["Google Places<br/>reviews (themes)"]
        ECB["ECB<br/>daily FX rates"]
        TM["Ticketmaster<br/>(parked)"]
    end

    subgraph SYNC["SYNC LAYER — cron-driven"]
        MASTER["/api/cron/master-sync<br/>daily 05:00 UTC"]
        FNSYNC["/api/cron/fortnox-sync<br/>+ pdf-backfill<br/>every 6h"]
        SCHEDSYNC["/api/cron/scheduling-sync<br/>PK shifts"]
        FX["/api/cron/fx-rates-update<br/>daily"]
        REVSYNC["/api/cron/reviews-sync"]
    end

    subgraph STORE["STORAGE — Supabase Postgres"]
        TBL_VOUCH["fortnox vouchers<br/>+ pdf cache"]
        TBL_LINES["supplier_invoice_lines<br/>(extracted from PDF)"]
        TBL_PROD["products<br/>+ product_aliases"]
        TBL_REC["recipes<br/>+ recipe_ingredients<br/>+ sub-recipes"]
        TBL_STAFF["staff_logs<br/>(PK shifts)"]
        TBL_REV["revenue_logs<br/>(POS, VAT-classified)"]
        TBL_TRACK["tracker_data<br/>+ tracker_line_items<br/>(monthly P&amp;L)"]
        TBL_PREP["prep_sessions<br/>+ pre_orders"]
        TBL_DAILY["daily_metrics +<br/>monthly_metrics"]
    end

    subgraph PROC["PROCESSING — the engines"]
        EXTRACT["PDF extractor<br/>(Sonnet vision)"]
        MATCHER["Matcher<br/>lib/inventory/matcher.ts<br/>5 gates"]
        COST["Cost engine<br/>lib/inventory/recipe-cost.ts<br/>w/ FX + density bridges"]
        AGGREG["Aggregator<br/>lib/sync/aggregate.ts<br/>(single writer)"]
        ROLLUP["Finance rollup<br/>lib/finance/projectRollup.ts<br/>VAT classifier"]
        WORKER["AI agents<br/>(anomaly, forecast,<br/>briefing, scheduling)"]
    end

    subgraph SURFACE["READ SURFACES — what the owner sees"]
        DASH["/dashboard<br/>KPI cards + attention"]
        PERF["/financials/performance<br/>revenue, food, labour,<br/>overheads, net-margin"]
        TRACKER["/tracker<br/>monthly P&amp;L"]
        FORECAST["/forecast<br/>predicted vs actual"]
        ITEMS["/inventory/items<br/>articles + cost"]
        RECIPES["/inventory/recipes<br/>dishes + GP%"]
        PREP["/inventory/recipes/prep<br/>kitchen prep list"]
        ORDERS["/inventory/orders<br/>supplier shopping list"]
        SCHED["/scheduling/grid"]
        OVER["/overheads<br/>BAS-bucketed cost"]
        ASKCC["/ai — Ask CC<br/>(15 tools)"]
    end

    FORTNOX --> FNSYNC
    PK --> MASTER
    POS --> MASTER
    GOOGLE --> REVSYNC
    ECB --> FX
    PK --> SCHEDSYNC

    FNSYNC --> TBL_VOUCH
    FNSYNC --> EXTRACT
    EXTRACT --> TBL_LINES
    MASTER --> TBL_STAFF
    MASTER --> TBL_REV
    SCHEDSYNC --> TBL_STAFF

    TBL_LINES --> MATCHER
    MATCHER --> TBL_PROD
    TBL_PROD --> COST
    TBL_REC --> COST
    FX --> COST

    TBL_LINES --> ROLLUP
    TBL_VOUCH --> ROLLUP
    ROLLUP --> TBL_TRACK

    TBL_REV --> AGGREG
    TBL_STAFF --> AGGREG
    TBL_TRACK --> AGGREG
    AGGREG --> TBL_DAILY

    TBL_DAILY --> WORKER
    TBL_TRACK --> WORKER

    TBL_DAILY --> DASH
    TBL_TRACK --> TRACKER
    TBL_TRACK --> PERF
    TBL_DAILY --> PERF
    TBL_PROD --> ITEMS
    COST --> RECIPES
    TBL_REC --> RECIPES
    COST --> PREP
    TBL_PREP --> PREP
    TBL_PREP --> ORDERS
    TBL_STAFF --> SCHED
    TBL_TRACK --> OVER
    TBL_TRACK --> ASKCC
    TBL_PROD --> ASKCC
    WORKER --> FORECAST
    WORKER --> DASH

    classDef ingress fill:#ffe4c2,stroke:#d97706,color:#1f1f1f
    classDef sync fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef proc fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef surface fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class FORTNOX,PK,POS,GOOGLE,ECB,TM ingress
    class MASTER,FNSYNC,SCHEDSYNC,FX,REVSYNC sync
    class TBL_VOUCH,TBL_LINES,TBL_PROD,TBL_REC,TBL_STAFF,TBL_REV,TBL_TRACK,TBL_PREP,TBL_DAILY store
    class EXTRACT,MATCHER,COST,AGGREG,ROLLUP,WORKER proc
    class DASH,PERF,TRACKER,FORECAST,ITEMS,RECIPES,PREP,ORDERS,SCHED,OVER,ASKCC surface
```

---

## 2. Inventory + Food Cost — the matcher → cost engine

This is the most complex pillar. It turns raw Fortnox supplier invoices into
live recipe costs and dish-level gross-margin numbers.

```mermaid
flowchart TB
    INVOICE["Fortnox supplier invoice<br/>(via OAuth API)"] --> HASPDF{"Has PDF<br/>attached?"}
    HASPDF -- yes --> PDFEXTRACT["PDF Extractor<br/>(Sonnet vision +<br/>extended thinking)"]
    HASPDF -- no --> NOPDF["status='no_pdf'<br/>(owner action)"]

    PDFEXTRACT --> VALIDATE["Validators<br/>10 rule-based checks +<br/>Haiku AI auditor"]
    VALIDATE --> EXTRACTED["supplier_invoice_lines<br/>kind, description, qty,<br/>price, currency, BAS account"]

    EXTRACTED --> MATCHER{"Matcher<br/>lib/inventory/matcher.ts"}

    subgraph GATES["5-gate matcher (precedence)"]
        G0a["Gate 0a<br/>per-business override<br/>(supplier_classifications)"]
        G0b["Gate 0b<br/>description rules<br/>(deposits, logistics,<br/>rebates, rent)"]
        G0c["Gate 0c<br/>global supplier dict<br/>(owner_confirmed safeguard)"]
        G0d["Gate 0d<br/>BAS account fallthrough<br/>(non-food account = skip)"]
        G1["Gate 1<br/>exact alias hit<br/>(article_no + description)"]
        G2["Gate 2<br/>fuzzy match<br/>(normalised description)"]
    end

    MATCHER --> G0a --> G0b --> G0c --> G0d --> G1 --> G2

    G0a -- skip --> NOTINV["match_status='not_inventory'"]
    G0b -- skip --> NOTINV
    G0c -- skip --> NOTINV
    G0d -- skip --> NOTINV
    G1 -- hit --> MATCHED["match_status='matched'<br/>(via product_alias_id)"]
    G2 -- hit --> MATCHED
    G2 -- miss --> REVIEW["match_status='needs_review'"]

    REVIEW --> QUEUE["/inventory/review<br/>owner queue"]
    QUEUE --> OWNER["Owner reviews<br/>create / link / repoint /<br/>skip-supplier"]
    OWNER --> ALIAS["product_aliases<br/>(match_method:<br/>'owner_confirmed' /<br/>'owner_linked')"]
    OWNER --> MATCHED

    MATCHED --> PROD["products<br/>(name, category,<br/>pack_size, base_unit,<br/>density, weight_per_piece,<br/>volume_per_piece)"]

    PROD --> ENRICH["LLM enrichers<br/>(parked or owner-triggered)"]
    ENRICH -- density --> PROD
    ENRICH -- weight/piece --> PROD
    ENRICH -- pack-size --> PROD

    classDef alert fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef good fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef neutral fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    class NOPDF,REVIEW,QUEUE alert
    class MATCHED,PROD good
    class NOTINV,ALIAS neutral
```

---

## 3. Recipe + Cost engine — products → live dish margin

```mermaid
flowchart TB
    OWNER["Owner authors recipe"] --> AUTHOR{"Authoring path"}
    AUTHOR -- manual --> EDITOR["/inventory/recipes/[id]<br/>full-page editor"]
    AUTHOR -- bulk --> IMPORT["/inventory/recipes/import<br/>AI parses PDF/Word/<br/>image/text"]
    IMPORT --> SONNET["Sonnet vision/text<br/>extracts dishes +<br/>sub-recipes + ingredients"]
    SONNET --> EDITOR

    EDITOR --> RECIPE["recipes table<br/>name, type, portions,<br/>selling_price, menu_price,<br/>yield_amount, yield_unit,<br/>method, portions_per_cover"]
    EDITOR --> INGREDIENTS["recipe_ingredients<br/>(product_id OR subrecipe_id,<br/>qty, unit, waste_pct, notes)"]

    RECIPE --> COSTENGINE["Cost engine<br/>lib/inventory/recipe-cost.ts<br/>computeRecipeCost()"]
    INGREDIENTS --> COSTENGINE

    subgraph COSTFLOW["For each ingredient line"]
        LOOKUP["1. Look up product<br/>latest_price_sek<br/>(FX-converted)"]
        UNITCONV["2. Convert qty to<br/>product base_unit<br/>(g / ml / st)"]
        BRIDGES{"Family mismatch?"}
        DENSITY["mass↔volume<br/>(density_g_per_ml)<br/>M120"]
        WEIGHTPC["mass↔count<br/>(weight_per_piece_g)<br/>M122"]
        VOLPC["volume↔count<br/>(volume_per_piece_ml)<br/>M136"]
        WASTE["3. inflate qty for<br/>waste_pct"]
        LINECOST["4. line_cost =<br/>qty × cost_per_base_unit"]
        INCOMPLETE["honest-incomplete:<br/>return null + flag<br/>(unit_mismatch /<br/>missing_price)"]
    end

    COSTENGINE --> LOOKUP --> UNITCONV --> BRIDGES
    BRIDGES -- mass vs volume --> DENSITY --> WASTE
    BRIDGES -- mass vs count --> WEIGHTPC --> WASTE
    BRIDGES -- volume vs count --> VOLPC --> WASTE
    BRIDGES -- same family --> WASTE
    BRIDGES -- unknown bridge --> INCOMPLETE

    WASTE --> LINECOST
    LINECOST --> TOTAL["Recipe total_cost +<br/>cost_per_portion +<br/>missing_prices count +<br/>unit_mismatches count"]

    TOTAL --> GP["GP% = (price - cost) / price<br/>GP kr = price - cost"]
    GP --> SURFACES{"Surfaces in"}
    SURFACES --> R1["/inventory/recipes<br/>(dish list w/ GP%)"]
    SURFACES --> R2["/inventory/items<br/>(used-in-recipes section)"]
    SURFACES --> R3["/inventory/recipes/prep<br/>(prep aggregation)"]
    SURFACES --> R4["AI Ask CC tools<br/>(recipe lookup)"]

    classDef step fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef bridge fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    classDef warning fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef result fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    class LOOKUP,UNITCONV,WASTE,LINECOST step
    class DENSITY,WEIGHTPC,VOLPC bridge
    class INCOMPLETE warning
    class TOTAL,GP,R1,R2,R3,R4 result
```

**Key invariant**: the cost engine never shows a confident-but-wrong number.
When a unit can't be bridged or a product price is unknown, it returns `null`
and the UI renders an "Incomplete cost" badge instead of a GP%.

---

## 4. Prep + Orders + Waste — kitchen-facing operations

```mermaid
flowchart TB
    subgraph DEMAND["Demand input"]
        COVERS["Manual cover count<br/>(today's bookings)"]
        PREORDER["Pre-orders<br/>prep_pre_orders<br/>(party_name, party_size,<br/>items, service_date)"]
        MIXSHARE["recipes.portions_per_cover<br/>(per-dish demand share)"]
    end

    subgraph PREPENG["Prep engine<br/>lib/inventory/prep-list.ts"]
        AGGREGATE["aggregatePrepRequirements()<br/>walks recipe tree,<br/>accumulates QTY<br/>(not money)"]
        SHARED["Shared components<br/>roll up across dishes<br/>(e.g. Pinsa Red Sauce<br/>across Margherita + Parma)"]
        HONEST["Honest-incomplete:<br/>yield-less subs flag<br/>'sub_no_yield' — don't<br/>roll up further"]
    end

    COVERS --> AGGREGATE
    PREORDER --> AGGREGATE
    MIXSHARE --> AGGREGATE
    AGGREGATE --> SHARED --> HONEST

    HONEST --> SESSION["prep_sessions<br/>+ prep_session_lines<br/>FROZEN at save<br/>(qty snapshots survive<br/>recipe edits mid-service)"]

    SESSION --> KITCHEN["Kitchen workflow<br/>/inventory/recipes/prep"]
    KITCHEN --> CHECK["Chef checks off lines<br/>(toggleLine)"]
    KITCHEN --> RECIPE_CARD["Recipe card modal<br/>(read-only on phone —<br/>method, ingredients,<br/>thumbnails)"]
    KITCHEN --> COMPLETE["Complete session"]

    SESSION --> ORDERBUILD["Order builder<br/>POST /api/inventory/<br/>orders/build"]
    ORDERBUILD --> SHOPPING["Smart shopping list<br/>/inventory/orders"]
    SHOPPING --> SUPPLIER_GROUPS["Per-supplier groups<br/>(latest-supplier lookup<br/>across product_aliases)"]
    SUPPLIER_GROUPS --> COPYPACK["Copy for chat/email<br/>(plain text per supplier)"]

    SESSION -.->|future| WASTE["Waste log<br/>(actual produced vs<br/>actual sold)"]
    WASTE -.->|future| BASELINE["Calibrate<br/>portions_per_cover<br/>from real data"]
    BASELINE -.-> MIXSHARE

    classDef input fill:#ffe4c2,stroke:#d97706,color:#1f1f1f
    classDef engine fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef ui fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    classDef future fill:#f5f5f5,stroke:#a3a3a3,color:#737373,stroke-dasharray:5 5
    class COVERS,PREORDER,MIXSHARE input
    class AGGREGATE,SHARED,HONEST,ORDERBUILD engine
    class SESSION store
    class KITCHEN,CHECK,RECIPE_CARD,COMPLETE,SHOPPING,SUPPLIER_GROUPS,COPYPACK ui
    class WASTE,BASELINE future
```

**Waste status**: currently lives as `recipe_ingredients.waste_pct` (baked
into cost calc). A first-class `waste_log` table comparing produced-vs-sold
is the natural next step but not built yet.

---

## 5. Scheduling + Labour cost

```mermaid
flowchart TB
    subgraph PK_DATA["Personalkollen (source of truth)"]
        PK_SCHED["Scheduled shifts<br/>(pk_log_url contains<br/>'_scheduled')"]
        PK_LOGGED["Logged shifts<br/>(actuals, post-trading)"]
        PK_RATES["Hourly rates, OB%,<br/>employment dates"]
    end

    SYNCJOB["/api/cron/scheduling-sync<br/>+ /api/cron/master-sync"] --> PK_SCHED
    SYNCJOB --> PK_LOGGED
    SYNCJOB --> PK_RATES

    PK_SCHED --> STAFFLOGS["staff_logs<br/>(both scheduled +<br/>logged, dedup'd<br/>by (pk_staff_url,<br/>shift_date))"]
    PK_LOGGED --> STAFFLOGS
    PK_RATES --> STAFFLOGS

    STAFFLOGS --> SCHEDGRID["/scheduling/grid<br/>(week view, per dept)"]
    STAFFLOGS --> AGGREGATOR["Aggregator<br/>lib/sync/aggregate.ts<br/>(scheduled = today's<br/>cost during trading)"]

    AGGREGATOR --> AGREEMENT{"PK vs Fortnox<br/>agreement check<br/>(70-130% band)"}
    AGREEMENT -- in band --> STAFF_COST["daily_metrics.staff_cost<br/>cost_source='pk_agrees'"]
    AGREEMENT -- out of band --> STAFF_FN["daily_metrics.staff_cost<br/>cost_source='fortnox_pk_disagrees'<br/>(triggers ops email)"]

    STAFF_COST --> DAILY["daily_metrics +<br/>monthly_metrics"]
    STAFF_FN --> DAILY

    DAILY --> DASH_LABOUR["/dashboard staff cost tile"]
    DAILY --> PERF_LABOUR["/financials/performance<br/>labour panel"]

    subgraph AI_SCHED["Weekly AI scheduling agent"]
        AICRON["/api/cron/scheduling-<br/>optimization<br/>Mon 07:00 UTC<br/>(Sonnet 4.6)"]
        DEMAND["Read 12wk demand<br/>+ recency weighting<br/>+ holidays + events"]
        ASYMMETRIC["ASYMMETRIC RULE:<br/>only RECOMMEND CUTS<br/>(never add hours —<br/>liability if demand misses)"]
        SUGGEST["scheduling_<br/>recommendations table"]
    end

    DAILY --> DEMAND
    STAFFLOGS --> DEMAND
    AICRON --> DEMAND --> ASYMMETRIC --> SUGGEST
    SUGGEST --> DASH_LABOUR
    SUGGEST --> ATTENTION["Attention panel<br/>+ Monday digest email"]

    classDef source fill:#ffe4c2,stroke:#d97706,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef engine fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef ai fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef ui fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class PK_SCHED,PK_LOGGED,PK_RATES source
    class STAFFLOGS,DAILY store
    class AGGREGATOR,AGREEMENT,DEMAND,ASYMMETRIC engine
    class AICRON,SUGGEST ai
    class SCHEDGRID,DASH_LABOUR,PERF_LABOUR,ATTENTION ui
```

---

## 6. Aggregation + Monthly P&L — single writer pattern

```mermaid
flowchart TB
    subgraph SOURCES["Daily source data"]
        REV_LOGS["revenue_logs<br/>(POS / PK department<br/>VAT-classified:<br/>25% alcohol,<br/>12% dine-in,<br/>6% takeaway)"]
        STAFF_LOGS["staff_logs<br/>(PK shifts<br/>scheduled + logged)"]
        TRACKER["tracker_data<br/>(Fortnox monthly P&amp;L)"]
        LINE_ITEMS["tracker_line_items<br/>(BAS account detail)"]
    end

    subgraph WRITER["SINGLE WRITER chokepoints"]
        AGG["lib/sync/aggregate.ts<br/>(daily/monthly metrics)"]
        ROLLUP["lib/finance/projectRollup.ts<br/>(Fortnox → tracker_data)"]
        CONVENTIONS["lib/finance/conventions.ts<br/>(sign convention:<br/>revenue +, costs +,<br/>financial signed)"]
        VAT["lib/sweden/vat.ts<br/>+ BAS classifier<br/>(M115 bucket dict)"]
    end

    REV_LOGS --> AGG
    STAFF_LOGS --> AGG
    TRACKER --> AGG

    FN_PDF["Fortnox PDF<br/>(or API voucher)"] --> EXTRACT_FN["Resultatrapport parser<br/>(deterministic) +<br/>Sonnet vision fallback"]
    EXTRACT_FN --> VALIDATORS["10 rule-based checks +<br/>Haiku AI auditor +<br/>owner ack flow<br/>(/api/fortnox/apply)"]
    VALIDATORS --> ROLLUP
    ROLLUP --> CONVENTIONS
    CONVENTIONS --> VAT
    VAT --> TRACKER
    VAT --> LINE_ITEMS

    AGG --> DAILY_M["daily_metrics"]
    AGG --> MONTHLY_M["monthly_metrics"]

    subgraph FIELDS["Per-month P&amp;L row"]
        F_REV["revenue<br/>(+ dine_in, takeaway,<br/>alcohol breakdown)"]
        F_FOOD["food_cost"]
        F_STAFF["staff_cost<br/>(+ cost_source)"]
        F_OTHER["other_cost<br/>(BAS-bucketed)"]
        F_DEP["depreciation"]
        F_FIN["financial<br/>(signed)"]
        F_NET["net_profit =<br/>revenue - food -<br/>staff - other -<br/>depreciation + financial"]
        F_MARGIN["margin_pct"]
    end

    TRACKER --> FIELDS

    F_NET --> SURFACES{"Read surfaces"}
    F_MARGIN --> SURFACES
    DAILY_M --> SURFACES
    MONTHLY_M --> SURFACES

    SURFACES --> DASH["/dashboard<br/>KPI cards +<br/>OverviewChart"]
    SURFACES --> PERF["/financials/performance<br/>Week/Month/Quarter/YTD<br/>+ waterfall + donut"]
    SURFACES --> TRACKER_UI["/tracker<br/>monthly P&amp;L grid"]
    SURFACES --> FORECAST_UI["/forecast<br/>predicted vs actual"]
    SURFACES --> OVER_UI["/overheads<br/>BAS bucket drilldown"]
    SURFACES --> BUDGET["/budget<br/>cost targets"]

    classDef source fill:#ffe4c2,stroke:#d97706,color:#1f1f1f
    classDef writer fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef field fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef ui fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class REV_LOGS,STAFF_LOGS,TRACKER,LINE_ITEMS,FN_PDF source
    class AGG,ROLLUP,CONVENTIONS,VAT,EXTRACT_FN,VALIDATORS writer
    class DAILY_M,MONTHLY_M store
    class F_REV,F_FOOD,F_STAFF,F_OTHER,F_DEP,F_FIN,F_NET,F_MARGIN field
    class DASH,PERF,TRACKER_UI,FORECAST_UI,OVER_UI,BUDGET ui
```

**Invariant**: only `projectRollup` writes `tracker_data` rows. Every downstream
read trusts the persisted `net_profit` verbatim — no recomputation in the UI.

---

## 7. AI agents + Forecast adjustment

```mermaid
flowchart TB
    subgraph AGENTS["6 background agents"]
        ANOM["Anomaly detection<br/>nightly 06:00 UTC<br/>(Haiku 4.5)"]
        ONBOARD["Onboarding success<br/>on first sync<br/>(Haiku)"]
        MONDAY["Monday briefing<br/>Mon 07:00 UTC<br/>(Haiku)"]
        CALIB["Forecast calibration<br/>1st of month<br/>(arithmetic)"]
        CREEP["Supplier price creep<br/>1st of month<br/>(Haiku)"]
        SCHEDOPT["Scheduling optimisation<br/>Mon 07:00 UTC<br/>(Sonnet 4.6)"]
    end

    subgraph FORECAST["Forecast layered model"]
        DETERM["Deterministic<br/>(seasonality + 12wk<br/>recency-weighted mean +<br/>pull-forward scaler)"]
        ANCHOR["Last-year actual<br/>monthly anchor<br/>(max +15% stretch)"]
        LLM_ADJ["Piece 4 LLM adjustment<br/>(Haiku, [0.5,1.5] clamp,<br/>soft-fail to deterministic)"]
        CALIB_FACTOR["forecast_calibration<br/>(accuracy +<br/>bias factor per business)"]
    end

    HISTORY["Historical data<br/>(daily_metrics + tracker)"] --> DETERM
    HOLIDAYS["lib/holidays/sweden.ts<br/>(17 SE days)"] --> DETERM
    EVENTS["Ticketmaster (parked)"] -.-> LLM_ADJ
    TRACKER["tracker_data"] --> ANCHOR
    CALIB_FACTOR --> DETERM

    DETERM --> LLM_ADJ
    ANCHOR --> LLM_ADJ
    LLM_ADJ --> FCAST["forecasts table"]
    FCAST --> OUTCOMES["ai_forecast_outcomes<br/>(captured at month-end<br/>vs actuals)"]
    OUTCOMES --> CALIB --> CALIB_FACTOR

    AGENTS --> ALERTS["alerts table<br/>+ email digest"]
    ALERTS --> DASH["/dashboard<br/>attention panel"]
    ALERTS --> EMAIL_DIGEST["Daily ops emails<br/>(disagreements +<br/>manual tracker audit)"]

    ASKCC["Ask CC chat<br/>/ai page<br/>(Sonnet 4.6 +<br/>15 tools)"] --> READ{"Reads"}
    READ --> TRACKER
    READ --> RECIPES["recipes + cost"]
    READ --> REV["revenue + labour"]
    READ --> REVIEWS["Google reviews"]

    SCHEDOPT --> SCHEDREC["scheduling_<br/>recommendations"]
    SCHEDREC --> DASH
    ANOM --> ALERTS
    CREEP --> EMAIL_DIGEST

    classDef agent fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef model fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef store fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef ui fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class ANOM,ONBOARD,MONDAY,CALIB,CREEP,SCHEDOPT,ASKCC agent
    class DETERM,ANCHOR,LLM_ADJ,CALIB_FACTOR model
    class FCAST,OUTCOMES,SCHEDREC,ALERTS store
    class DASH,EMAIL_DIGEST ui
```

---

## 8. Owner journey — from invoice to action

This is the **business-facing view**: what an owner does week-to-week to keep
food cost and labour under control.

```mermaid
flowchart LR
    subgraph PASSIVE["Passive (system runs in background)"]
        AUTO_SYNC["Fortnox + PK<br/>sync every 6h"]
        AUTO_EXTRACT["PDF extracts<br/>land in supplier_<br/>invoice_lines"]
        AUTO_MATCH["Matcher classifies<br/>matched / not_inventory /<br/>needs_review"]
        AUTO_COST["Cost engine re-prices<br/>every recipe live"]
    end

    subgraph DAILY["Daily owner check (5 min)"]
        D_DASH["Check /dashboard<br/>attention panel"]
        D_ALERTS["Triage alerts<br/>(anomalies, disagreements)"]
        D_REVIEW["Clear /inventory/review<br/>queue (~5-15 lines/day<br/>once steady-state)"]
    end

    subgraph WEEKLY["Weekly owner work (30 min)"]
        W_MONDAY["Read Monday digest<br/>email"]
        W_LABOUR["Apply scheduling AI<br/>cut suggestions"]
        W_GP["Review /inventory/recipes<br/>dish GP%s — fix<br/>'Incomplete cost' badges"]
        W_REVIEWS["Read /reviews insights<br/>(improve cards + love cards)"]
    end

    subgraph MONTHLY["Monthly owner work (2h)"]
        M_PNL["Upload Fortnox<br/>Resultatrapport PDF<br/>(or wait for API sync)"]
        M_TRACKER["Verify /tracker P&amp;L<br/>against accountant"]
        M_FORECAST["Compare forecast vs<br/>actual (calibration loop)"]
        M_BUDGET["Adjust /budget targets<br/>for next month"]
        M_ASKCC["Generate report via<br/>Ask CC<br/>(margin PDF / Word)"]
    end

    subgraph KITCHEN["Kitchen (daily, owner-set then chef-driven)"]
        K_PREORDER["Owner adds pre-orders"]
        K_COVERS["Owner enters covers<br/>(or accept POS estimate)"]
        K_PREP["Chef opens prep list<br/>(read-only recipe card)"]
        K_CHECK["Chef checks off lines<br/>during prep"]
        K_ORDER["Owner builds shopping<br/>list at /inventory/orders<br/>sends to supplier"]
    end

    AUTO_SYNC --> AUTO_EXTRACT --> AUTO_MATCH --> AUTO_COST
    AUTO_COST -.-> D_DASH
    AUTO_MATCH -.-> D_REVIEW
    D_DASH --> D_ALERTS

    AUTO_COST -.-> W_GP
    W_MONDAY --> W_LABOUR

    M_PNL --> M_TRACKER --> M_FORECAST --> M_BUDGET

    K_PREORDER --> K_COVERS --> K_PREP --> K_CHECK
    K_CHECK --> K_ORDER

    classDef passive fill:#e0e7ff,stroke:#4f46e5,color:#1f1f1f
    classDef daily fill:#fef3e0,stroke:#d97706,color:#1f1f1f
    classDef weekly fill:#fce7f3,stroke:#be185d,color:#1f1f1f
    classDef monthly fill:#dcfce7,stroke:#16a34a,color:#1f1f1f
    classDef kitchen fill:#f3e8ff,stroke:#7c3aed,color:#1f1f1f
    class AUTO_SYNC,AUTO_EXTRACT,AUTO_MATCH,AUTO_COST passive
    class D_DASH,D_ALERTS,D_REVIEW daily
    class W_MONDAY,W_LABOUR,W_GP,W_REVIEWS weekly
    class M_PNL,M_TRACKER,M_FORECAST,M_BUDGET,M_ASKCC monthly
    class K_PREORDER,K_COVERS,K_PREP,K_CHECK,K_ORDER kitchen
```

---

## Visual design hints (for the mockup AI)

If you're handing this to Claude.ai for a UI mockup, lean on these design tokens
the app already uses:

- **Palette**: lavender (`#7c3aed` deep, `#e0e7ff` fill) for primary actions /
  selected state. Coral (`#d97706`) for warnings + "incomplete" badges. Mint
  (`#16a34a`) for healthy GP / success. Ink scale ink1 (darkest) → ink4 (subtle).
- **Layout**: sticky sidebar nav on desktop, bottom tab bar on mobile. Cards
  with soft shadow + 0.5px border + 10px radius. Tabular numerics throughout.
- **Mobile pattern**: tap row → open modal (NEVER navigate to editor). Owner
  edits in full-page editors; chefs read-only on the kitchen surfaces.
- **Honest-incomplete principle** is a UI requirement: never show a confident
  number when the underlying data is incomplete. Use a coral badge with the
  reason instead.
- **Article uniformity**: same `<ProductThumb>` shape everywhere (xs/sm/md/lg/xl
  sizes) so a product looks the same on the catalogue, in a recipe, on a prep
  list, in an order, and in stock count.

---

## File pointers (for handing to the design AI)

If the AI you're handing this to has codebase access, these are the canonical
files behind each pillar:

| Pillar | Canonical files |
|---|---|
| Matcher | `lib/inventory/matcher.ts` + `lib/inventory/description-rules.ts` |
| Cost engine | `lib/inventory/recipe-cost.ts` + `lib/inventory/unit-conversion.ts` |
| Prep | `lib/inventory/prep-list.ts` + `app/inventory/recipes/prep/page.tsx` |
| Aggregator | `lib/sync/aggregate.ts` + `lib/finance/conventions.ts` |
| Rollup | `lib/finance/projectRollup.ts` + `lib/fortnox/resultatrapport-parser.ts` |
| BAS dictionary | `lib/overheads/basBuckets.ts` |
| Holidays | `lib/holidays/sweden.ts` + `lib/holidays/index.ts` |
| AI models | `lib/ai/models.ts` (never hardcode model strings) |
| Scope rule | `lib/ai/scope.ts` (every predictive AI surface imports this) |
