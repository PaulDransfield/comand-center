# Claude Code — Dashboard Mobile: Fix 3 Breaks + Regression Check (on MAIN)

## Context that matters

These breaks are on **merged main**, where Phase 1 verification claimed "Overview built from primitives, reads correctly at mobile/tablet/desktop, numbers identical." It does NOT — it horizontally overflows and doesn't stack on mobile. So either the verification didn't hold or it **regressed** (the status doc flagged a 30-commit rebase; the dashboard conversion may have been partially lost/overwritten). This is the designated *proof surface* — if it regressed silently, the ESLint guardrail that was meant to catch fixed-width violations didn't fire, and **other "converted" surfaces may have regressed too.** So: fix the three breaks AND determine whether this is isolated or symptomatic.

Read `/mnt/skills/public/frontend-design/SKILL.md`. Locked lavender tokens, Swedish formatting, no new libraries. Feature branch + preview, no prod deploy without review.

## The three breaks (from screenshots)

### Break 1 — Page-level horizontal overflow (the worst; fix first)
The whole dashboard is **wider than the viewport** — you can scroll it sideways (you never should). KPI cards (Covers cut off), demand-outlook strip (Tue cut off), what-needs-attention rows (actions truncated "Open sched…"), recent invoices (amounts cut off) all run off the right edge. The cards are sitting in their DESKTOP grid spilling off-screen, NOT stacking to single-column.
- **Find the fixed width.** Something in the dashboard's top-level container (or a child grid) has a fixed/min width exceeding phone width, overriding the responsive container. `repeat(N, minmax(Xpx,...))` with a px floor, a fixed `width`, or a `<CardGrid>` not actually applied.
- **Fix:** ensure the dashboard is wrapped in `<PageContainer>` and its card rows use `<CardGrid>` so they collapse 4→2→1. Verify NO horizontal scroll at 360px. This is the Phase 1 conversion that was supposed to be here — confirm it's actually applied to what's deployed.

### Break 2 — Chart axis-label density (Image 3)
The chart x-axis renders EVERY day "1 2 3 4 5 6 7 8 910111213…30" crammed/overlapping, illegible on mobile. `<ResponsiveChart>` got the container-width fix but not **label density**.
- On mobile, show every Nth label (e.g. every 5th day) or rotate/thin them — don't render all 30. The width fix alone doesn't solve label crowding.
- (Bars bunched in the first ~5 days may be correct — early June — but confirm it's data, not a render bug.)

### Break 3 — Labor-% card content collision (Image 3)
The Lowest/Highest labor cards render the date ("Tue 2 Jun") and the big percentage ("143.6%") **overlapping/colliding** — card-internal layout assumes desktop horizontal room. The card stacks fine at grid level, but its contents (pill label + date + big number) collide at narrow width.
- Fix the card-internal layout to stack/wrap (label, then date, then value) at mobile width instead of overlapping.

## Regression check (do this — it's why the fix matters beyond these 3 breaks)
1. **Why did the dashboard regress?** Compare what's on main now vs the Phase 1 dashboard conversion — was the `<PageContainer>`/`<CardGrid>` wrapping lost or overwritten in the 30-commit rebase/merge? Confirm the conversion is present in source, not just assumed.
2. **Did the ESLint guardrail fail to catch it?** The rule was meant to warn on fixed widths. If the dashboard has a fixed width that overflows, did the rule miss it (warning ignored? rule scope gap? the offending width in a form the regex doesn't match)? Note the gap.
3. **Is it isolated or symptomatic?** Quick check of the other "converted" surfaces (recipe editor, Items, anything Phase 1–2 touched) at phone width — did any others regress the same way, or is the dashboard the only one? If others regressed, this is a bigger rebase-damage problem; if isolated, just the dashboard.

## Hard rules
- Fix page overflow FIRST (it makes everything look broken). No horizontal scroll at 360px.
- Reuse existing primitives (`<PageContainer>`, `<CardGrid>`, `<ResponsiveChart>`) — confirm they're actually applied, don't rebuild.
- Chart: add mobile label-density handling to `<ResponsiveChart>` (so it's fixed for every chart, not just this one).
- Card-internal collisions: fix the labor-card layout to stack at mobile width.
- Layout only — all numbers + honest-incomplete states identical.
- Read frontend-design SKILL.md; locked lavender tokens; Swedish formatting.
- Feature branch + preview; verify at 360 / 800 / 1440 before merge.

## Deliverable
The three breaks fixed (no horizontal scroll, chart axis legible, labor cards not colliding) on a feature branch + preview, PLUS the regression-check findings.

Three-line chat summary:
1. Page overflow root cause (the fixed width found + fixed) — confirm no horizontal scroll at 360px and cards stack 4→2→1;
2. Chart axis-density + labor-card collision both fixed (and the axis fix lives in `<ResponsiveChart>` so it covers all charts);
3. Regression check — did the dashboard conversion get lost in the rebase, did the ESLint guardrail miss it (and why), and is it isolated to the dashboard or did other converted surfaces regress too.
