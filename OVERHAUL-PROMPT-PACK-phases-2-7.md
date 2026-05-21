# CommandCenter UI Overhaul — Prompt Pack (Phases 2–7)

> Companion to `OVERHAUL-PROMPT-1-foundation.md`. Run Phase 1 first, verify its Vercel preview, then work through these in order.
> **One branch + one Vercel preview per phase. Verify before starting the next.** Do not paste more than one phase at a time.
>
> Every phase inherits the Phase 1 rules: pastel `UXP` tokens (additive, never touch `colors.ts`), `next/font` (Spline Sans body / Fraunces display + numbers), `fmtKr`/`fmtPct`/`fmtNum`/`labourTier` from existing libs, `SyncIndicator` untouched, **REPLACE don't append** (name and delete the old elements on each page), inline styles only, charts stay inline SVG, no new dependencies, `tsc --noEmit` clean, landing page `app/page.tsx` never touched.
>
> **The fidelity rule, every phase:** use exact values from the component specs — `0.5px` hairlines never rounded to `1px`, every number `fontVariantNumeric:'tabular-nums'`, big numbers `letterSpacing:'-0.02em'`, display font on KPI numbers and titles. Reuse the four `components/ux/*` components; do not hand-roll new card/table/chart code per page.

---

## PHASE 2 — Nav rewrite + pilot the system on Dashboard

> **Goal:** replace the navy labelled `SidebarV2` with the full-Nory 46px icon rail + per-page top toolbar, and prove the whole system on one real, complex page (`/dashboard`) before rolling out. **Decision locked: full Nory rail (Option B), not a reskin of the old sidebar.**

**The prompt to paste:**

> Branch `ux/overhaul-2-nav-and-dashboard`. We are switching CommandCenter to a two-level navigation (icon rail = areas, top toolbar tabs = pages within an area) and piloting the new design system on the dashboard. Use the `components/ux/*` built in Phase 1. REPLACE, don't append.
>
> **Task 1 — Build the icon rail as the new sidebar.** Create `components/ux/RailNav.tsx`: a fixed **46px** wide, full-height rail, `background:'#fff'`, right border `0.5px solid rgba(58,53,80,0.06)`. Top: a 28×28 lavender brand chip (`#a99ce6`, white `ti-command` icon). Then one icon per AREA (not per page). Active area = 32×30 chip `background:'#ece8f8'`, icon `#7d6cc9`; inactive icon `rgba(58,53,80,0.38)`, 16px. Settings icon pinned to the bottom. Each icon has an `aria-label` and a hover tooltip with the area name. The six areas and the routes they own:
> ```
> Insights   (ti-chart-pie)      → /dashboard /group /financials/performance /forecast /budget /revenue /reviews  + Suppliers (Phase 5)
> Schedule   (ti-calendar-event) → /scheduling /scheduling/ai /staff /departments
> Inventory  (ti-box)            → (Phase 6 demo pages: items /recipes /counts /waste)
> Bookkeeping(ti-file-invoice)   → /invoices /overheads /overheads/review /overheads/upload /revisor
> Alerts     (ti-alert-triangle) → /alerts
> Ask CC     (ti-sparkles)       → /notebook
> Settings   (ti-settings, bottom)→ /settings /settings/*
> ```
> `/weather` and all V1 admin routes are NOT in the customer rail.
>
> **Task 2 — Build the top toolbar with area tabs.** In `AppShellUX` (from Phase 1), the top toolbar shows: the area name as an `Insights ▾`-style dropdown whose menu lists that area's pages (the page tabs), then the active page as a second `[page] ▾` pill, then the date stepper (◄ label ►), optional `Compare ▾`, and the far-right `Ask CC` pill. Switching pages happens from the top dropdown, not the rail. The active page maps to the current route.
>
> **Task 3 — Switch `AppShell.tsx` to mount `RailNav` + `AppShellUX`** instead of `SidebarV2`. Preserve every gate and side-effect currently in `components/AppShell.tsx` (RoleGate, PlanGate, OnboardingGate, BackgroundSync, ConsentBanner, AiUsageBanner, MobileNav). Keep `<SyncIndicator />` — mount it inside the rail (icon-only/collapsed mode). Mobile: the rail collapses to the existing `MobileNav` bottom bar (don't rebuild mobile nav, just keep it).
>
> **Task 4 — Rebuild `/dashboard` (`app/dashboard/page.tsx`) onto the new system.** This is the pilot. Wrap it in `AppShellUX` with `section="Insights"`, `activeKey="overview"`, the date stepper wired to its existing date state. REPLACE the inline-constructed KPI cards (the audit flagged the dashboard builds cards inline — delete that code) with `components/ux/KpiCard`. The Revenue card uses `variant="channels"` (Lunch/Middag/Take-away split), the margin card `variant="stacked"`, the labour card `variant="targetBand"` driven by `labourTier()`. REPLACE the chart with `components/ux/PairedBarChart` (the existing `OverviewChart` stays available but the dashboard uses the new component for the headline chart). Keep all existing data fetching exactly as is — only the presentation changes.
>
> **Constraints:** the dashboard's data, routes, and API calls are unchanged. The page must render identically in data terms, only restyled. Other pages still use the old shell this phase — only `/dashboard` moves. `tsc --noEmit` clean.
>
> **Report back:** Vercel preview URL; screenshot of the new rail + dashboard; confirmation `SyncIndicator` still mounts and works; confirmation no other page regressed; the `RailNav` area→route map as built.

---

## PHASE 3 — Insights pages (the analytics core)

> **Goal:** every page that lives under the Insights area, onto the new system. These run on real, live data (audit confirms all real).

**The prompt to paste:**

> Branch `ux/overhaul-3-insights`. Move these pages onto `AppShellUX` (section `"Insights"`) + the `components/ux/*` components, real data unchanged, REPLACE don't append. For each page, delete the old bespoke cards/tables/charts and use `KpiCard` / `PairedBarChart` / `BreakdownTable`.
>
> - **`app/financials/performance/page.tsx`** (this is "Flash P&L", 1478 lines — be careful). Target layout: per-location COLUMN cards (one column per business), each stacking Sales → CoGS → Cost of labour → Flash profit, each metric with a delta chip and a muted grey comparison sub-pill (the forecast/prior figure). Add the Best/Worst/All toggle and the filter-pill row with counts. activeKey `"performance"`.
> - **`app/forecast/page.tsx`** — model-confidence/MAPE chip in the title row; three `KpiCard`s (tomorrow with P25/P75 sub-text, next-7-days, today's driver/attribution); a forecast-vs-actual chart with a P25–P75 band and an "idag" divider separating actuals from forecast. activeKey `"forecast"`.
> - **`app/budget/page.tsx`** — three `KpiCard`s (budget / actual-so-far / month projection); a `BreakdownTable` per cost line with a month-consumed progress bar column (category colours: revenue navy, CoGS coral, labour lav, overhead amber) and variance chips; muted resultat footer. activeKey `"budget"`.
> - **`app/revenue/page.tsx`** — daily revenue/covers; `KpiCard`s + `PairedBarChart` + a daily `BreakdownTable`. activeKey `"revenue"`.
> - **`app/reviews/page.tsx`** — four `KpiCard`s (rating / replied / needs-reply / avg-response); rating-over-time + a star-distribution `BreakdownTable`; the review feed with AI-reply and a tone-rewrite popover; the platform filter (Google live; TripAdvisor/Foodora/Uber Eats as future menu items). activeKey `"reviews"`.
> - **`app/group/page.tsx`** — multi-business roll-up; `KpiCard`s + a per-location `BreakdownTable`. activeKey `"group"`.
>
> **Report back:** preview URL; per-page before/after screenshots; confirm each page's data layer is untouched and only presentation changed.

---

## PHASE 4 — Schedule & workforce area

> **Goal:** the Schedule area pages onto the new system. These are real and live.

**The prompt to paste:**

> Branch `ux/overhaul-4-schedule`. Move onto `AppShellUX` (section `"Schedule & workforce"`) + `components/ux/*`, real data unchanged, REPLACE don't append.
>
> - **`app/staff/page.tsx`** — four `KpiCard`s (team / hours / labour cost / late arrivals); employee `BreakdownTable` with role, hours, OB, cost, late count, and a labour% tier chip per row driven by `labourTier()` (indigo low / green on-target / amber watch / rose over); muted total row. activeKey `"staff"`.
> - **`app/departments/page.tsx`** + `[id]` — revenue-by-department bars (`PairedBarChart` or the existing dept-coloured bars) with a Revenue/Cost/Margin toggle; total + best-margin `KpiCard`s; `BreakdownTable` with staff cost, labour% tier chips, margin. activeKey `"departments"`.
> - **`app/scheduling/page.tsx`** and **`app/scheduling/ai/page.tsx`** — keep the existing `AiSchedulePanel` / `AiHoursReductionMap` / `RotaDay` SVGs but re-skin their colours to `UXP` (lavender bars, coral/amber accents) and wrap the page in `AppShellUX`. Do NOT rebuild the scheduling logic — only restyle the shell and the SVG palette. activeKey `"scheduling"`.
>
> **Report back:** preview URL; screenshots; confirm `labourTier()` is the single source for all labour colour decisions (no inline thresholds); confirm scheduling logic untouched.

---

## PHASE 5 — Bookkeeping area + Suppliers (the Fortnox moat)

> **Goal:** the Fortnox-deep pages — your differentiator. These are real. Plus the new Suppliers cost-intelligence page (Phase 2 of the build guide), also from real Fortnox data.

**The prompt to paste:**

> Branch `ux/overhaul-5-bookkeeping`. Move onto `AppShellUX` (section `"Bookkeeping"`) + `components/ux/*`, REPLACE don't append. This area is intentionally NOT a Nory mirror — it's CommandCenter's own Fortnox workflow; design it cleanly in the pastel system but don't force a Nory template.
>
> - **`app/invoices/page.tsx`** — "Synkad från Fortnox" indicator in the toolbar; four `KpiCard`s (count / total / due-soon / flagged); invoice `BreakdownTable` with a **BAS-konto column** (e.g. `4010 · Råvaror`), flagged rows tinted rose, status chips. activeKey `"invoices"`.
> - **`app/overheads/page.tsx`** + **`/review`** + **`/upload`** — the flag-review workflow: a "Ladda upp PDF" action in the toolbar; a two-pane layout — left flag list (item, reason, amount), right detail pane (amount vs 6-month average, an "✦ CC föreslår" AI-classification suggestion box with the suggested BAS account, an editable account dropdown, Bekräfta/Avvisa/Visa PDF actions). activeKey `"overheads"`.
> - **`app/revisor/page.tsx`** + **`[bizId]/[year]/[month]`** — accountant view: org-nr + "Avstämd" status in the title; four close-the-month `KpiCard`s (Intäkter 3xxx / Kostnader 4–7xxx / Resultat / Moms); a ledger `BreakdownTable` by BAS account with debet/kredit/verifikat columns; an "Exportera SIE" action. activeKey `"revisor"`.
> - **NEW `app/suppliers/page.tsx`** — supplier cost intelligence from Fortnox invoice lines grouped by supplier + BAS account: a `BreakdownTable` with supplier, last price, Δ vs trailing average (delta chips), period spend, a sparkline trend column; flagged rows for price rises > threshold. Real data via a new `/api/suppliers/rollup` route following the existing API pattern (`createAdminClient` + `unstable_noStore`). Add this page as a tab under the **Insights** area (it's analytics, not bookkeeping). activeKey `"suppliers"`.
>
> **Report back:** preview URL; screenshots; confirm BAS classification renders from real Fortnox data; confirm the new suppliers route follows the existing API/caching pattern.

---

## PHASE 6 — Demo/vision pages (Inventory, Recipes, Waste, full Schedule grid)

> **Goal:** make the app look complete by adding the not-yet-built pages with clearly-marked mock data, so the product demos and pitches show the full vision — without faking that it's live.

**The prompt to paste:**

> Branch `ux/overhaul-6-vision-pages`. Create NEW routes for the not-yet-built features, populated with mock data, each carrying a visible demo banner. These render the agreed mockups. REPLACE don't append (these are new files so mostly additive, but don't duplicate existing components — reuse `components/ux/*`).
>
> **Task 1 — `components/ux/DemoDataBanner.tsx`**: a slim dismissible strip at the top of the page content, `background:'#fbf2eb'`, text `#8a4f24`, `fontSize:11`, a `ti-flask` or `ti-alert-triangle` icon, copy: "Demo data — this feature is in development." Props: `dismissible` (default true).
>
> **Task 2 — isolate all mock data in `lib/mock/`** (e.g. `lib/mock/inventory.ts`, `recipes.ts`, `waste.ts`, `schedule.ts`) so it's trivially swappable for real data later. Never inline mock data into the page components.
>
> **Task 3 — build these routes under the Inventory area** (rail icon `ti-box`), each wrapped in `AppShellUX` (section `"Inventory setup"`) with the `DemoDataBanner` at top:
> - `app/inventory/items/page.tsx` — item master: list (Namn/Typ/Kategori/Huvudleverantör/Beställningsenhet/Pris/Moms) via `BreakdownTable`, filters, a per-item detail drawer (supplier/pack/case, storage areas, count-unit conversions). "1–50 av 418" pagination footer.
> - `app/inventory/recipes/page.tsx` — Menyrecept list (name/type/sale price/food cost %/GP%) + a recipe editor drawer (auto-computed cost & GP, ingredient lines with qty/unit/cost pulling from the mock item master).
> - `app/inventory/waste/page.tsx` — KPI cards + reason/value charts (`PairedBarChart`) + ingredient leaderboard + the "% of total waste" item `BreakdownTable` with topp-anledning chips.
> - `app/inventory/counts/page.tsx` — stock-count report: per-ingredient Vara/Varians/Ingående/Leverans/Överfört/Utgående/Förbrukat/Sålt with a SUMMA footer.
>
> **Task 4 — full Schedule grid** at `app/scheduling/grid/page.tsx` (Schedule area): the rota grid — days across, department groups, employee rows with contracted-hours, shift blocks, Otillgänglig markers, dashed open shifts, the header strip with Prognos/Mål and Utkast status, the AI "Skapa schema" button + "184 timmar tillagda" toast (Acceptera/Ångra), and the Publicera ▾ menu (Submit for approval / Publish). Mock data from `lib/mock/schedule.ts`, `DemoDataBanner` at top.
>
> **Constraints:** every vision page MUST show the `DemoDataBanner`. No vision page may appear in a recorded live demo until real — but they're fine in the app for showing the full picture. All mock data isolated in `lib/mock/`.
>
> **Report back:** preview URL; screenshots of each vision page with the banner visible; confirm all mock data lives in `lib/mock/` and pages reuse `components/ux/*`.

---

## PHASE 7 — Cleanup & cutover

**The prompt to paste:**

> Branch `ux/overhaul-7-cleanup`. Final consolidation now that every page uses the new system. REPLACE don't append.
>
> - Confirm every customer page is wrapped in `AppShellUX` + `RailNav`. Move any stragglers.
> - Delete the old `components/ui/SidebarV2.tsx` and the old `components/AppShell.tsx` sidebar path **once grep confirms nothing imports them**. (Keep the gates/side-effects — fold them into the new shell if not already.)
> - Remove the V1 admin **routes** (`/admin`, `/admin/overview`, `/admin/customers`, `/admin/agents`, `/admin/health`, `/admin/audit`) — V2 supersedes them. Confirm no links point to V1 first.
> - Remove `/weather` from any customer nav (keep the route if still used by admin/dev).
> - Retire the now-unused legacy style-object exports in `lib/constants/colors.ts` (`KPI_CARD`, `CARD`, `FONT`, `BTN`) **only if** grep shows zero remaining consumers — migrate any stragglers to `UXP` first. Do NOT delete `colors.ts` wholesale (STATUS, DEPT_COLORS, deptColor() are still used).
> - Final pass: `grep -r "kr kr"` clean, `tsc --noEmit` clean, all hairlines `0.5px`, all numbers tabular-nums.
>
> **Report back:** preview URL; the list of deleted files; confirmation of clean grep/tsc; a short note of anything that still imports the old system so we can finish it.

---

## Sequencing & ground rules

```
Phase 1  Foundation (tokens, fonts, 4 components, formatter, dead-code)   ← run first, already written
Phase 2  Nav rewrite + pilot on Dashboard                                  ← the structural change
Phase 3  Insights pages (Flash P&L, Forecast, Budget, Revenue, Reviews, Group)
Phase 4  Schedule & workforce (Staff, Departments, Scheduling)
Phase 5  Bookkeeping (Invoices, Overheads, Revisor) + Suppliers
Phase 6  Vision/demo pages (Inventory, Recipes, Waste, Schedule grid) w/ DemoDataBanner
Phase 7  Cleanup & cutover
```

- One phase, one branch, one Vercel preview, verified before the next. Never batch phases.
- After each phase, paste the report back here and I'll tailor the next prompt to what actually shipped (file paths shift, surprises happen).
- The mockups in this conversation are the visual target for each page — match them, using the exact `UXP` values, not approximations.
- If Claude Code starts appending instead of replacing, or rounds `0.5px` to `1px`, or drops `tabular-nums` — stop it and point back to the fidelity rule. Those three are the whole difference between "looks like the mockup" and "looks slightly cheap."
