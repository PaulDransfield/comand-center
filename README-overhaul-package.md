# CommandCenter UI Overhaul — Package README

This is the complete package for overhauling the CommandCenter app UI to the pastel-lavender design system, plus the new public landing page. Built from the agreed mockups, the codebase audit, and the phased build strategy.

---

## What's in this package

| File | What it is | How to use it |
|---|---|---|
| `OVERHAUL-PROMPT-1-foundation.md` | Phase 1 Claude Code prompt — the shared system | **Paste into Claude Code first.** Builds tokens, fonts, the 4 reusable components, fixes the `kr kr` bug, deletes dead code. Nothing user-visible yet. |
| `OVERHAUL-PROMPT-PACK-phases-2-7.md` | Phases 2–7 Claude Code prompts | Run **in order, one at a time**, after Phase 1's preview is verified. Nav rewrite → Insights → Schedule → Bookkeeping → Vision pages → Cleanup. |
| `commandcenter-landing.html` | The public marketing landing page | Self-contained. Open in a browser; deploy as `app/page.tsx`'s output or a static page. New pricing (1995/4995/9995), no Nory comparison, no founding tier. |
| `commandcenter-landing-v1-backup.html` | Previous landing version | Backup only — ignore unless you want something from the old draft. |
| `BUILD-GUIDE-operations-platform.md` | The 6-phase product build strategy | The business/product roadmap (what to build when). The overhaul prompts are the *UI* layer; this is the *capability* layer. |
| `NORDIC-PLAN-ADDENDUM-operations-pivot.md` | Strategy reconciliation | Why inventory/recipes/scheduling are gated (paying pilot + a hire), not built now. |
| `demo-recording-storyboard.md` | Script for the real product demo video | Use once Phase 2–5 pages are built and live. Films only real screens. |

The **mockups themselves live in this conversation** — every page was rendered as a visual. Those are the pixel target for each page; the prompts reference them.

---

## The order of operations

1. **Run Phase 1** (`OVERHAUL-PROMPT-1-foundation.md`). Paste the prompt block into Claude Code. When it pushes a Vercel preview, check: fonts are Spline Sans / Fraunces, the four `components/ux/*` exist, `grep "kr kr"` is clean, dead files deleted.
2. **Paste Phase 1's report back to me.** I tailor Phase 2 to what actually shipped (file paths and surprises shift).
3. **Run Phase 2** (nav rewrite + dashboard pilot). This is the big structural change — the 46px rail replaces the navy sidebar. Verify the rail works and the dashboard looks like the mockup before going further.
4. **Phases 3 → 7 in order.** One branch, one preview, verified each time. Never batch.

---

## Why fidelity slipped before, and what's fixed

Past Claude Code rebuilds felt lower-quality than the mockups for concrete reasons, all now addressed in Phase 1:

- **Fonts** — the app fell back to the system font stack; the mockups use tuned web fonts. Phase 1 loads Spline Sans + Fraunces via `next/font`. *(Biggest single fix.)*
- **Hairlines** — `0.5px` borders were getting rounded to chunky `1px`. The prompts mandate `0.5px`, never rounded.
- **Numbers** — missing `tabular-nums` and `letter-spacing` made figures look loose. Now required on every number.
- **Interpretation loss** — Claude Code was reconstructing intent from descriptions. Phase 1 gives it **exact style values**, not prose, for the four components every page reuses.
- **Tidy mock data hid breakage** — components are now tested against long names, 9-figure numbers, nulls, and negatives before they're trusted.

If a rebuilt page ever looks "slightly cheap" again, the cause is almost always one of those five — point Claude Code back to the fidelity rule.

---

## The non-negotiables (repeated in every prompt)

- **REPLACE, don't append** — name and delete the old elements on each page. (Documented Claude Code failure mode.)
- Additive tokens only — never edit `colors.ts`; add to `UXP`.
- Reuse the four `components/ux/*` — don't hand-roll cards/tables/charts per page.
- Don't touch `SyncIndicator`'s three defensive properties.
- Don't touch `app/page.tsx` (landing) during app phases — it has its own intentional palette.
- Inline styles only, charts stay inline SVG, no new dependencies.
- One phase, one branch, one preview, verified before the next.
- Vision pages (inventory/recipes/waste/schedule grid) always show the `DemoDataBanner` and never appear in a recorded live demo until real.

---

## Page → area map (the new nav)

- **Insights:** Dashboard, Group, Flash P&L (`/financials/performance`), Forecast, Budget, Revenue, Reviews, Suppliers
- **Schedule & workforce:** Scheduling, Scheduling AI, Schedule grid (demo), Staff, Departments
- **Inventory setup (demo):** Items, Recipes, Counts, Waste
- **Bookkeeping:** Invoices, Overheads (+review/upload), Revisor
- **Alerts:** Alerts
- **Ask CC:** Notebook
- **Settings (bottom of rail):** Settings + sub-pages

Dropped from customer nav: `/weather`, all V1 admin routes.
