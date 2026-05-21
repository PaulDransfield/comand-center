# CommandCenter Build Guide — Intelligence Layer → Operations Platform

> Drafted 2026-05-20. Companion to THE-NORDIC-PLAN.md and NORDIC-PLAN-ADDENDUM-operations-pivot.md.
> Purpose: the sequenced build plan for growing CommandCenter into a full Nory-equivalent **slowly**, never building all of it at once.
> Style matches the Nordic Plan: `lib/` paths, tables, phase gates, success criteria. Living document — update at each gate.

---

## 0. How to read this document

The mockups we built describe the **destination** (full Nory: inventory, recipes, counts, waste, scheduling-as-system-of-record, multi-platform reviews). This guide is the **route** — six phases, each one shippable, each gated so you don't start the next until the previous is paying for itself.

**The one rule that governs everything below:** never start a phase whose data the customer can't yet supply or whose ongoing burden you can't yet support. The order is chosen so each phase runs on data you *already have* before it asks the customer for data they have to *enter*.

Three burden tiers, used throughout:
- 🟢 **Auto-data** — runs on Fortnox/Personalkollen/POS we already ingest. No customer entry.
- 🟡 **Light entry** — one-time or occasional customer setup, tolerable self-serve.
- 🔴 **Heavy entry** — ongoing per-shift / per-week / per-item work. Needs onboarding services + a gate.

---

## 1. Phase map at a glance

| Phase | Theme | Burden | Gate to start | Shippable solo? |
|---|---|---|---|---|
| **1** | Intelligence core | 🟢 | none — start now | yes |
| **2** | Cost intelligence (no counts) | 🟢🟡 | Phase 1 shipped | yes |
| **3** | Advisory scheduling | 🟢 | 1 customer asks | yes |
| **4** | Reviews aggregation | 🟡 | Phase 1 shipped | yes |
| **5** | Item master + recipes | 🔴 | paying pilot + a hire | no |
| **6** | Counts + waste + true GP + scheduling-as-record | 🔴 | Phase 5 populated for 1 site | no |

Phases 1–4 are the company the Nordic Plan describes and are buildable by one founder. Phases 5–6 are the operations pivot; they are gated on help and a committed pilot. **Do 1→2→3/4 in order. Treat 5→6 as a separate program that begins only when both gates are green.**

---

## PHASE 1 — Intelligence core 🟢
*Goal: every screen that runs on data we already ingest. This is the Nordic Plan as written, plus Cash as the wedge. No new customer burden.*

### Screens in scope
Sales/Overview, Flash P&L (per-location columns), Labour (roll-up + per-location detail), Cash management (30-day projection — our differentiator), Budgets.

### Build
- **Shared UI shell first** (everything else depends on it):
  - `components/AppShell.tsx` — 46px icon rail + top toolbar (Insights ▾ / section ▾ / date stepper / Compare ▾ / Ask CC pill)
  - `components/KpiCard.tsx` — the internal-bar card (number + delta + channel split + stacked bar). This is the signature element; build it once, reuse everywhere.
  - `components/PairedBarChart.tsx` — clustered bars + line overlay on secondary axis + legend
  - `components/BreakdownTable.tsx` — multi-section table, green↗/red↘ delta chips, muted SUMMA/Total footer
  - `lib/format/kr.ts` — `formatKr()` Swedish locale (`toLocaleString('en-GB').replace(/,/g,' ')` → `9 551 kr`)
  - `lib/utils/labourTier.ts` — four-tier (low <30 / on-target 30–35 / watch 35–50 / over >50)
  - Design tokens (pastel lavender) additive in `lib/constants/tokens.ts` — never edit `colors.ts`
- **Sales/Overview** — KPI cards (Revenue channel-split / Gross margin Faktisk-Teoretisk / Labour target-band), Sales-v-Forecast three-series chart (Faktisk / Prognos-live / Prognos + Snittnota lines), channel breakdown table, product-categories chart, products list, sales-by-location table.
- **Flash P&L** — per-location column layout, filter pills with counts, Best/Worst/All toggle, four metric blocks per column (Sales/CoGS/Cost of labour/Flash profit) with grey comparison sub-pills. *Note: CoGS here = booked Fortnox cost, not recipe-derived — honest for Phase 1.*
- **Labour** — two scopes: all-locations roll-up (KPIs, COL%+SPLH chart, three-section table) and single-location detail (department distribution + shift-types donut).
- **Cash management** — 30-day projection chart (actual + projected lines), position tiles (today / 30-day / lowest point), upcoming in/out list. *Already partly shipped per Nordic Plan §2.*
- **Budgets** — budget vs actual per category; cheap, stands alone.

### Data — all already flowing
Fortnox (P&L, COGS, invoices), Personalkollen (hours), POS (revenue). No new ingestion except hourly (Nordic Plan §5 weeks 1–3, runs in parallel).

### Success criteria
- All five screens live on real Vero + Rosali data
- `formatKr()` and `KpiCard` reused across every page (no per-page reimplementation)
- Cash projection visible and matching Fortnox within tolerance

### Do NOT in Phase 1
Theoretical GP, Gap, stock-count language, recipe anything. Flash P&L CoGS is booked-cost only.

---

## PHASE 2 — Cost intelligence without counts 🟢🟡
*Goal: occupy the "Inventory" nav slot with supplier cost intelligence from Fortnox — the value of inventory insight without the burden of stock counts.*

### Screens in scope
**Suppliers & cost of goods** (the page already mocked): supplier / BAS category / last price / Δ vs avg / spend / trend, filters, flagged-rows for price rises.

### Build
- `lib/cogs/supplier-rollup.ts` — group Fortnox invoice lines by supplier + BAS account (4xxx), compute period spend, last unit price where derivable, Δ vs trailing average
- `components/SupplierTable.tsx` — reuses `BreakdownTable` with sparkline column
- Anomaly flag: supplier price rise > X% → surfaces in Alerts and "Ask CC" insight

### Data
🟢 Fortnox invoices (already ingested). 🟡 Optional: light per-supplier BAS-category confirmation if auto-classification is uncertain.

### Success criterion
COGS-as-% and the worst price-mover surfaced from real Fortnox data, no manual item entry.

### Why this is the right "inventory" for now
It delivers the *insight* operators want (where is food cost creeping?) using data we already have, and is honest about not being a counted variance. It holds the nav slot until Phase 5/6 earn the real reconciliation.

---

## PHASE 3 — Advisory scheduling 🟢
*Goal: scheduling that suggests, writing back to Personalkollen — NOT replacing it. Read-and-recommend, not system-of-record.*

### Screens in scope
"Your plan vs AI applied" advisory view (already mocked): hero comparison (your plan vs AI applied), saving strip, per-change rows with deltas, "Apply & send to Personalkollen".

### Build
- `lib/schedule/optimise.ts` — take PK's existing roster + the hourly forecast (from Nordic Plan §5), propose trims/adds against the labour target band
- Write-back: push approved changes *to Personalkollen* via its API (advisory layer on top, not a replacement clock-in system)
- `components/ScheduleDelta.tsx` — the change-row list with per-change kr / pp / hours impact

### Data
🟢 PK roster + hourly forecast. No new customer behaviour — they still live in PK.

### Gate
Start when ≥1 customer explicitly asks for scheduling help. Until then, the Labour page's suggestion panel covers the need.

### Hard line
This is **advisory**. The full rota grid, contracted-hours tracking, open shifts, templates, approval workflow, and the ML tweak-loop (the screens in image set "Schedule & Workforce") are **Phase 6** — they make CC the system of record and partially replace PK. Do not build those here.

---

## PHASE 4 — Reviews aggregation 🟡
*Goal: the reviews page, one platform at a time, with the operational-insight cross-reference that's uniquely ours.*

### Screens in scope
Reviews (already mocked): four KPI cards, rating-over-time, star distribution, review feed with AI reply + tone rewrite (Friendly/Professional/Concise), platform filter.

### Build — sequence the integrations, don't do them at once
1. **Google Business Profile** first (easiest API, highest volume) — `lib/reviews/google.ts`
2. AI reply in brand voice + tone rewrite — `lib/reviews/reply.ts` (this is a real conversational-AI feature; budget it)
3. **Operational-insight panel** — cross-reference a complaint against PK staffing for that shift ("ran a server short Fri 20:00"). This is the bit Nory can't do because we hold the PK data. Build it early; it's the differentiator.
4. Then, one at a time as customers ask: TripAdvisor → Foodora → Uber Eats. Each is its own `lib/reviews/{platform}.ts`; some lack public review APIs — verify before promising.

### Data
🟡 Per-platform OAuth/API connection (one-time per customer per platform).

### Success criterion
Google reviews aggregated, AI reply shipping, operational-insight panel live on at least one real complaint.

---

## PHASE 5 — Item master + recipe costings 🔴 (THE GATE)
*Goal: the data foundation that everything in Phase 6 depends on. This is the iceberg. Do not start without both gate conditions.*

### Gate conditions (BOTH required)
1. ≥1 paying customer has **explicitly asked** for true food-cost/GP reconciliation and will act as a co-build pilot.
2. There is a **second pair of hands** (hire or co-founder) — because this phase adds an ongoing onboarding-services motion one person cannot also sell, build, and support.

### Screens in scope
Inventory item master (the 418-item list), per-item setup drawer, Menu recipes list, recipe editor drawer.

### Build
- **Data model — the hard part:**
  - `items` — name, type, category (ontology), main_supplier, supplier_code, pack_size, unit, packs_per_case, price_ex_tax, vat, per-location storage_areas
  - `item_count_units` — count-as conversions (e.g. ea AND case 24×1) so staff can count either
  - `recipes` — dish, sale_price, type
  - `recipe_ingredients` — recipe_id, item_id, qty, unit → auto-cost from `items.price`, auto-compute food cost + theoretical GP
  - Unit-conversion engine: kg/g/l/ml/ea/case — the quiet source of most bugs in this category. Build and test it in isolation first.
- **Category ontology** — the Alcohol/Bakery/Dairy/Meat… taxonomy, editable per customer
- **Onboarding tooling** (not optional at this scale): CSV/invoice-assisted item import, supplier-catalogue import, an "Ask CC to draft this recipe" AI assist to cut recipe-entry time

### The honest cost (write it into customer pricing)
~418 items/location + 60–120 costed recipes = **days of skilled work per customer**, and it goes stale on every recipe change or supplier price move. This is why the gate requires a hire — someone owns onboarding/maintenance. Price it as a setup fee + higher tier floor; do not bury it in self-serve.

### Success criterion
One pilot location fully populated: every menu item costed, theoretical GP computing automatically, kept current for 4 weeks without falling stale.

---

## PHASE 6 — Counts, waste, true GP, scheduling-as-record 🔴
*Goal: the full operations product. Only meaningful once Phase 5 is populated for a real site, because every number here is downstream of items + recipes.*

### Gate condition
Phase 5 populated and maintained for ≥1 site for ≥4 weeks (proves the data foundation survives contact with a real kitchen).

### Screens in scope
Mobile stock-count flow, Stock-count reconciliation report, Inventory GP reconciliation (now with *real* theoretical GP), Waste page (+ item table), and the full **Schedule & Workforce** rota grid with AI auto-build + approval workflow.

### Build — in this internal order
1. **Mobile stock-count flow** — count-by-storage-area, +/− unit steppers, count-as-case-or-unit. `app/(mobile)/count/`
2. **Reconciliation engine** — `lib/inventory/reconcile.ts`: opening + deliveries − transfers − closing = used; used vs theoretical (from recipes × sales) = variance. The whole GP page hangs off this.
3. **Stock-count report** + **Inventory GP page** — drop the "Väntar på Fortnox-synk" hedge; show real Actual/Theoretical/Gap.
4. **Waste capture** — per-event log (item, qty, reason, by-whom) → waste page reason/value charts, category donut, leaderboard, item table. 🔴 hardest adoption: staff logging every shift in a fourth app. Pair with manager nudges; expect attrition.
5. **Schedule & Workforce as system-of-record** — full rota grid, contracted hours, availability, open shifts, templates, AI "Create Schedule" from forecast, the tweak-feedback ML loop, and the **approval workflow** (manager builds → owner signs off → publish). Requires a **roles/permissions model** (manager vs owner). This deepest-integration step partially *replaces* Personalkollen — decide deliberately whether that's the relationship you want with PK.

### Success criteria
- Real counted variance on the GP page for the pilot site
- Waste logging sustained > 4 weeks without collapsing to zero (the true test)
- One full week rota built by AI, tweaked, approved by owner, published to staff

### The risk to keep naming
Phase 6 is where CC becomes an operations system of record. It's the stickiest outcome and the largest, highest-maintenance build. The mockups make it look done; it is the opposite of done. Enter it only with the team, the pilot, and the pricing all aligned.

---

## 2. Cross-cutting workstreams (run alongside, not as a phase)

| Workstream | Notes |
|---|---|
| **"Ask CC" assistant** | The sparkle pill on every page implies a conversational AI over the customer's data. Treat as its own roadmap item; start read-only (answer questions), not actions. Not free. |
| **Roles & permissions** | Needed by Phase 6 (manager vs owner approval). Design the model early even if enforced late. |
| **Hourly forecast** | Nordic Plan §5 weeks 1–3 — prerequisite for good Phase 3 scheduling and Phase 1 meal-period views. |
| **Swedish AB + Fortnox dev program** | Per memory: registering Dransfield Invest AB unblocks Fortnox developer access + DPAs. Blocks nothing in mockups but blocks production Fortnox. Do early. |
| **Onboarding services** | Becomes real at Phase 5. Plan the motion (who enters items/recipes) before the gate, not after. |

---

## 3. Sequencing summary

```
NOW ──► Phase 1 (intelligence core, shell, KPI cards)        🟢 solo
        │
        ├─► Phase 2 (supplier cost intelligence)              🟢🟡 solo
        ├─► Phase 4 (reviews — Google first)                  🟡 solo
        └─► Phase 3 (advisory scheduling)  [gate: a customer asks]  🟢 solo
                    │
                    ▼
            ═══ OPERATIONS PROGRAM ═══  [gate: paying pilot + a hire]
                    │
                    ├─► Phase 5 (item master + recipes)        🔴 needs help
                    └─► Phase 6 (counts, waste, true GP,        🔴 needs help
                                 scheduling-as-record)
```

Phases 1–4: ship in roughly that order, solo, over the next two quarters. Phases 5–6: a distinct program, started only when both gates are green. The destination is the full mockup set; the discipline is never building more of it at once than you can ship and support.

---

## 4. The next concrete step

Build Phase 1's **shared shell + the four reusable components** (`AppShell`, `KpiCard`, `PairedBarChart`, `BreakdownTable`) before any individual page. Every screen in every phase reuses them, so getting them right once is the highest-leverage work in the whole plan. Once they exist, each page becomes mostly data-wiring.

When ready, the next deliverable from here is a **Claude Code build prompt for Phase 1** — scoped to exactly the shell + those components + the five Phase-1 screens, nothing downstream.
