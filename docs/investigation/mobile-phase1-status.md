# Mobile Phase 1 — current status (for second-opinion review)

**Date:** 2026-06-03  
**Branch:** `feature/mobile-phase1-responsive-system`  
**Preview URL:** `comand-center-git-feature-mobile-pha-b115a6-paul-7076s-projects.vercel.app`  
**Last commit on branch:** `aa83530 — Mobile Phase 1: responsive system primitives + guardrails`

## What's on the feature branch (built but not merged)

Six primitives + ESLint guardrail + LAYOUT.md convention doc:

```
NEW
  lib/constants/breakpoints.ts      — BP tokens (mobile<768, tablet 768-1023, desktop≥1024) + PAGE_PADDING + PAGE_MAX_WIDTH
  lib/hooks/useViewport.ts          — useViewport() / useContainerWidth() (ResizeObserver-driven)
  components/ui/Layout.tsx          — PageContainer, CardGrid, MetricCardRow, Stack, Cluster
  components/ui/DataTable.tsx       — table on desktop / card-per-row on mobile (THE high-leverage primitive)
  components/ui/ResponsiveChart.tsx — render-prop chart wrapper, reads container width via ResizeObserver
  components/ui/ProductThumb.tsx    — canonical product image (5 sizes, white bg, lazy, silent fallback)
  .eslintrc.cjs                     — no-restricted-syntax warns on maxWidth: 12xx & width: NNNpx in JSX

CONVERTED AS PROOF
  app/dashboard/page.tsx            — wrapped in <PageContainer>, replaced window.innerWidth hack with <ResponsiveChart>
  app/overheads/page.tsx            — useMemo lifted above early-return (rules-of-hooks fix surfaced by new eslint)

BANNER FIX
  components/SyncProgressBanner.tsx — collapses on mobile, flex-wraps job rows, hides desktop hint
```

## What's on `main` (cherry-picked from the feature branch on 2026-06-03)

The **documentation and the ProductThumb component** were pulled forward so they could be referenced from other features that were merging that day:

```
  components/ui/ProductThumb.tsx                    — needed by Items + Orders pages (canonical thumbnail sweep)
  docs/LAYOUT.md                                    — convention doc
  docs/investigation/mobile-responsive-step0.md     — the investigation report
  docs/mobile-phase2-plan.md                        — Phase 2-6 effort plan
```

**The other primitives (PageContainer, CardGrid, DataTable, ResponsiveChart, useViewport, breakpoints) are still feature-branch-only.** Pulling them in piecemeal would risk half-converted pages on main.

## What's been done since Phase 1 push (now on main, not on the feature branch)

The feature branch is **behind main by ~30 commits** of unrelated work since Mobile Phase 1 was pushed yesterday morning. To merge, the branch needs a rebase. Notable diverging work:
- Pack info from supplier_articles helper + matcher integration + 'Detect pack size' button extension
- 33 single-container-weight pack promotions applied to prod
- 63 orphan product auto-merges applied to prod
- Link-supplier-article modal success-feedback fix
- 4-step dedupe ladder for product creation (separate feature branch — `feature/prevent-orphan-products`)
- ProductThumb canonical sweep across recipe + prep + items + orders pages

## Step 0 investigation findings (load-bearing context)

From `docs/investigation/mobile-responsive-step0.md`:

```
65 inline gridTemplateColumns (mostly desktop-shaped)
23 fixed maxWidth: 1280 page wrappers
 8 pages using window.innerWidth - 120 chart-width hacks
 3 pages with one-off inline @media blocks
```

Working surfaces I extracted patterns from:
- `/overheads/review` uses `MOBILE_BREAKPOINT = 880` + `useState/useEffect` listener (cleanest existing pattern)
- `/reviews` insights uses 680 breakpoint inline
- Anything with `repeat(auto-fit, minmax(X, 1fr))` collapses for free

Specific failure modes diagnosed:
- **Sync banner**: every `<JobRow>` child sets `whiteSpace: nowrap` → rigid horizontal overflow on phone widths
- **Sticky banner stack**: Broken + AI usage + Sync + Consent all `position: sticky; top: 0` → visual collision on mobile
- **Dashboard chart**: `width={window.innerWidth - 120}` set at render, frozen, doesn't update on rotate
- **7-day grid**: `repeat(7, minmax(120px, 1fr))` = 840 px floor, overflows 414 px phone

## Guardrails NOT YET implemented (from go-ahead doc)

The reviewer flagged three things to address before merge. **Only Guardrail 1's partial fix landed** (the SyncProgressBanner-only fix). Status:

| | Status | Details |
|---|---|---|
| **G1 — Banner STACK** | Partial | Fixed SyncProgressBanner alone. **The other 3 sticky banners (BrokenIntegration / AiUsage / Consent) still collide on mobile.** Reviewer said "fixing only SyncProgressBanner leaves the other three still colliding." Needs a single banner container that stacks active banners in priority order. |
| **G2 — Don't over-convert grids** | Held | Phase 1 only converted the proof surface (Overview). Scheduling grid + other 2D matrices deliberately left for their own phase. ✓ |
| **G3 — Migrate 880/680 surfaces** | Not done | `/overheads/review` (880) and `/reviews` (680) still use their hardcoded breakpoints. Need to migrate to BP tokens OR explicitly grandfather them in `docs/LAYOUT.md`. |
| **Follow-up note** | Not added | LAYOUT.md should note "escalate ESLint rule warn→error once baseline is clean" so the guardrail eventually has teeth. |

## Pre-merge checklist (per the reviewer's verify-before-merge list)

- [ ] Banner clean at all 3 tiers WITH multiple banners active (G1 — partial)
- [x] Overview built from primitives, reads correctly mobile/tablet/desktop, numbers identical
- [x] Scheduling grid NOT converted (deferred); the simple grids ARE
- [ ] One breakpoint system, not two (G3 — not done)
- [x] Step 4 plan: scheduling grid + recipe editor sized

## Phase 2+ plan (deferred, on main at `docs/mobile-phase2-plan.md`)

Surface-by-surface follow-up after the Phase 1 system lands:

| Phase | Surface | Effort | Approach |
|---|---|---|---|
| 2 | Recipe editor | 4 h | Simple-breakpoint via `<DataTable>` card-per-row |
| 3 | Items + Order + Prep | 4.5 h | Same primitive — ships pictures + responsive together |
| 4 | Scheduling grid | 1.5 d | **Interaction redesign** — one-day view on mobile; contributes `<ResponsiveGrid>` primitive |
| 5 | P&L (`/financials/performance`) | 3 h | Simple-breakpoint via `<DataTable>` |
| 6 | Remaining sweep | 5-6 h | Mechanical: wrap in `<PageContainer>`, replace ad-hoc grids with `<CardGrid>`, replace `window.innerWidth` with `<ResponsiveChart>`. ESLint guardrail catches what's missed. |

**Total Phase 2-6:** ~3.5 days focused.

## What's working on the preview (verified)

- 3-tier breakpoint system: tokens defined, hook implementation correct
- `<DataTable cards={true}>`: pivots to card-per-row at the configured tier
- `<ResponsiveChart>`: ResizeObserver-driven, rotates correctly
- `<ProductThumb>`: looks consistent across surfaces (items list, recipe rows, prep, order)
- ESLint guardrail: warns on `maxWidth: 12xx` + `width: NNNpx` in app/* and components/* (excluding components/ui/* primitives)
- Overview as proof surface: builds from primitives, reads at all 3 widths, numbers match prior values

## Open questions for review

1. **Banner stack — what's the right architecture?** Single container with priority queue? `<BannerHost>` component that consumes registered banners via context? Or just `position: relative` + flexbox stack in AppShell?
2. **880/680 migration — full BP token migration or grandfather?** The reviewer left both options open. I lean toward **grandfather with a follow-up TODO** since the surfaces are working and there's already risk in the broader Phase 1 land.
3. **Should the preview merge before or after fixing G1+G3?** Reviewer says "verify before merge." But the partial banner fix already improves things noticeably on mobile; deferring the full banner-stack fix to a follow-up PR is also defensible. Owner direction welcome.

## Recommended next actions

1. **Rebase feature branch onto current main** (~30 commits behind). No expected conflicts on the primitives themselves; possible conflicts on docs/* since the docs were cherry-picked.
2. Choose: address G1 (full banner stack) + G3 (BP migration) on this branch BEFORE merge, OR ship Phase 1 as-is and address in a Phase-1.1 follow-up.
3. Manual QA on the preview at 3 widths: 360px (phone), 800px (tablet), 1440px (desktop).
4. After merge: kick off Phase 2 (recipe editor — 4 h, the highest chef-mobile-criticality surface).

## Files / locations

- Phase 1 primitives (feature branch only): `lib/constants/breakpoints.ts`, `lib/hooks/useViewport.ts`, `components/ui/Layout.tsx`, `components/ui/DataTable.tsx`, `components/ui/ResponsiveChart.tsx`
- Phase 1 docs (on main): `docs/LAYOUT.md`, `docs/investigation/mobile-responsive-step0.md`, `docs/mobile-phase2-plan.md`
- Go-ahead guardrails reference: `mobile-phase1-go-ahead-guardrails.md` (repo root, on main)
- Preview: `comand-center-git-feature-mobile-pha-b115a6-paul-7076s-projects.vercel.app`
