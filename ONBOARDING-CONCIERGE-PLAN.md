# Concierge Onboarding Plan — "full setup without waiting"

> Goal: an admin (Paul or an onboarding hire) sits down and drives a brand-new
> customer from zero to **fully set up** — financials, invoices, PDF scans,
> staff/POS, a reviewed product catalogue, and costed recipes — in one session,
> at max safe speed, on one observable board, never blocked on a passive cron.
>
> Decisions locked 2026-05-25: **concierge-driven** (admin runs it), **full
> scope incl. catalogue + recipes**.

---

## 0. The honest constraint

One thing no plan makes instant: **Fortnox's own rate limit.** A full invoice
history is throttled at the API (2 concurrent/token; Vero's ~1,071 invoices ≈
2.5h of pulling). So "without waiting" does NOT mean "done in 5 minutes." It means:

1. **Front-load the fast wins** — financials backfill in minutes → live dashboard
   immediately, while the slow parts run behind it.
2. **Run the slow parts at max safe speed + fully observable** — no 30-minute
   cron gaps, no daytime-only idle, no manual re-kicks.
3. **The admin is never blocked** — one board shows every stage; one button drives
   the whole thing; anything stalled is re-kicked with one click.

The recipe step always needs human confirmation — AI gets it to *draft + confirm*
(hours) instead of *build from scratch* (days).

---

## 1. The onboarding stages (and what already exists)

| # | Stage | Trigger today | State source | Status |
|---|-------|---------------|--------------|--------|
| 0 | Customer record (org-nr, address, stage, opening days, targets) | Onboarding wizard | `organisations`, `businesses`, `onboarding_progress` | ✅ exists |
| 1 | Connect Fortnox (OAuth + biz-confirm) + Personalkollen (API key) | `/integrations` | `integrations` | ✅ exists |
| 2 | Financial backfill (12mo vouchers → P&L) | OAuth callback; self-chains | `integrations.backfill_status/_progress` | ✅ exists (resumable) |
| 3 | Invoice line backfill (supplier invoices → lines) | OAuth callback; self-chains | `inventory_backfill_state` | ✅ exists (resume fixed 2026-05-25) |
| 4 | PDF extraction (PDF-only invoices → Sonnet vision) | OAuth kick + 30-min sweep | `invoice_pdf_extractions` | ✅ exists; needs burst mode |
| 5 | Matcher → catalogue (lines → products/aliases, needs-review) | auto after extraction | `supplier_invoice_lines.match_status`, `products`, `product_aliases` | ✅ exists |
| 6 | Catalogue review (bulk-approve AI suggestions, skip-supplier, recategorise) | `/inventory/review`, ai-suggest | `product_aliases`, `supplier_classifications` | ✅ exists; wire into board |
| 7 | Recipe build (costed recipes incl. sub-recipes) | manual today | `recipes`, `recipe_ingredients` | ⚠️ human-heavy — needs AI drafting |
| 8 | Readiness verification ("definition of done") | `/integrations/fortnox/verify` (Fortnox only) | `fortnox-readiness` validators | ⚠️ extend to all stages |
| 9 | Handover (mark onboarded) | — | new | ❌ new |

Most of the machinery exists. The gaps are: **a single concierge board**, **burst
mode for the slow pipelines**, **recipe AI-drafting**, and **a whole-customer
definition-of-done**.

---

## 2. What we build

### A. Concierge Onboarding Board  `/admin/v2/onboard/[businessId]`
One screen per customer. For every stage (1–9):
- Live **state + counts + ETA** (reuse the normalised shape from `/api/me/sync-progress`,
  extended to all stages via a new `/api/admin/onboard/status?business_id=`).
- A **"Run now / Re-kick"** button per stage that calls the existing kick endpoints
  with `CRON_SECRET`/`ADMIN_SECRET` — bypassing the passive sweeps.
- A single **"Drive to completion"** button (see B).
- **Blockers** surfaced inline: `needs_reauth`, missing org-nr, validation failures,
  AI kill-switch hit, Fortnox 429 storms.
- A **definition-of-done checklist** with green ticks (see E).

### B. "Drive to completion" — burst orchestration (no cron changes)
The passive design (30-min sweep, daytime-only, fire-and-forget) is built for
steady-state, not onboarding. Rather than change global cron behaviour, the board
**keeps this one business saturated** while the admin is driving:

- New endpoint `POST /api/admin/onboard/drive { business_id }` — inspects current
  state across all pipelines and kicks whatever is next/stalled, then returns.
- The board polls `/status` every ~5s and calls `drive` whenever a stage is
  **idle-but-incomplete** — so the moment a PDF-extraction chain exhausts its
  ~750s budget, it's re-kicked immediately instead of waiting up to 30 min for
  the sweep. The line backfill + extractor already self-chain internally; `drive`
  just removes the *gaps between* chains.
- Scoped to the session — when the admin closes the board, normal crons take over
  and finish anything left. Zero risk to other tenants.

### C. Catalogue auto-build (compress stage 6)
Already have: matcher, `ai-suggest`, bulk-apply (≥65% confidence), `recategorise-other`,
skip-supplier. Wire a one-click **"Auto-build catalogue"** into the board that:
1. Runs `ai-suggest` across the whole needs-review queue.
2. Bulk-applies everything at/above the AI's own review threshold (0.65).
3. Runs `recategorise-other` to clear the "other" bucket.
4. Leaves only genuine ambiguities for human review, with the residual count shown
   as the stage's "remaining."

### D. Recipe AI-drafting (compress stage 7 — the real labour)
The "days of skilled work." To get it to draft+confirm:
- New `POST /api/inventory/recipes/draft { business_id }`: for each `pos_menu_items`
  row without a recipe, ask Claude (Haiku→Sonnet escalation, prompt-cached) to draft
  an ingredient list from the **matched product catalogue** — which products + a
  starting quantity/unit. Output is a `recipes` + `recipe_ingredients` draft flagged
  `is_draft=true`.
- Reuse the Session-20 cost engine: sub-recipes, unit conversion, FX, cost rollup all
  already work — drafts get costed automatically.
- A **fast review UI**: owner confirms/edits quantities per recipe (one screen, keyboard-
  driven), flips `is_draft=false`. Editing quantities ≪ building from scratch.
- Optional later: spreadsheet import (owner pastes an existing recipe sheet → parser →
  same draft path).

### E. Definition of done + handover (stages 8–9)
A whole-customer readiness check (extends the Fortnox-only validator set):
- Fortnox connected + financials present (≥N months)
- Invoices ingested (≥X% of list pulled) + PDF extraction ≥Y% complete
- Catalogue: 0 high-confidence pending; "other" bucket cleared
- Recipes: ≥N menu items costed (or owner-acknowledged "skip recipes for now")
- Personalkollen connected + first sync done
- Dashboard populated (daily_metrics non-empty)

`POST /api/admin/onboard/complete` records completion + timestamp; board flips to
"Onboarded".

### F. Cost guardrail during burst
Burst mode concentrates AI spend. Add a **per-customer scan-cost view + alert** on
`SUM(invoice_pdf_extractions.cost_usd)` so a single onboarding can't quietly trip the
global `MAX_DAILY_GLOBAL_USD` kill-switch mid-session. Surface the running $ on the board.

---

## 3. Phasing (ship in this order)

- **Phase 1 — Board + Drive — ✅ SHIPPED 2026-05-25.** `/admin/v2/onboard/[bizId]`
  + `/api/admin/onboard/status` + `/api/admin/onboard/drive` + `lib/onboard/snapshot.ts`.
  Read-model aggregates stage state from the authoritative tables; the board polls
  every 5s and (auto-drive on) kicks the next idle/stalled stage. Sequential drive
  order: financials → invoices → pdf (matching runs inline + via chain_rematch, so
  it's display-only). Reuses every existing kick endpoint. Burst is session-scoped.
- **Phase 2 — Catalogue auto-build — ✅ SHIPPED 2026-05-25.** Extracted the Haiku
  classifier into `lib/inventory/ai-suggest-core.ts` (shared by the review page +
  the worker). New `/api/admin/onboard/catalogue-autobuild` classifies ONE ~120-group
  chunk per call (cache-aware — skips already-classified groups; the board chains calls
  until done, so no single request nears the 300s cap) and applies every
  suggestion with confidence ≥0.65 and action≠review: create_new → product+alias+link,
  approve_existing → link to the suggested product, skip_non_inventory → not_inventory.
  Residual stays for the owner. Board shows an "Auto-build" button on the catalogue
  stage (one-shot — costs tokens, so not in the auto-drive loop). "other" bucket left
  to the nightly recategorise cron.
- **Phase 3 — Recipe AI-drafting — ✅ SHIPPED 2026-05-25.** `/api/admin/onboard/recipes-draft`
  drafts a recipe + ingredients for every POS menu item missing one: Sonnet 4.6 picks
  products from the MATCHED catalogue with per-portion quantities/units, we create the
  recipe (priced automatically by the Session-20 cost engine) + link the menu item.
  Drafts tagged in `notes` ("AI DRAFT — …"); owner reviews/edits quantities on the
  existing `/inventory/recipes` page (no migration, no new review UI). Board "Draft
  recipes" button on the Recipes stage (one-shot, costs tokens). Depends on POS menu
  items existing + a matched catalogue (refuses if catalogue empty).
- **Phase 4 — Definition-of-done checklist, handover, per-customer cost guard.**

---

## 4. Constraints / honest notes

- **Fortnox rate limit** caps invoice-pull speed — mitigated, not removed. Financials
  (fast) front-load value; invoices fill while the customer already uses the app.
- **Anthropic rate/cost** — burst needs the per-customer budget guard (F) so onboarding
  doesn't pause on the global kill-switch.
- **Recipes always need human confirmation** — AI gets it to draft+confirm.
- **No new crons / no global cron changes** in Phase 1 — burst is session-scoped via the
  board, so it can't affect other tenants.

---

*Companion: INVENTORY-CATALOGUE-PLAN.md (catalogue), INVENTORY-PATH-B-PDF-EXTRACTION.md
(scans), CLAUDE.md Session 15 (onboarding wizard + gates).*
