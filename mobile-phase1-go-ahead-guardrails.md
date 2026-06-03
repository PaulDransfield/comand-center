# Claude Code — Mobile Phase 1: GO, with three build guardrails

Step 0 is solid — the system design is right, the primitives are well-chosen, the banner diagnosis is precise, and the quantified sweep (65 grids / 23 maxWidths / 8 chart hacks) confirms `<CardGrid>`, `<DataTable cards>`, and `<ResponsiveChart>` each kill a whole class of breakage. **Proceed with Step 1 (the system), Step 2 (banner), Step 3 (Overview from primitives), and Step 4 (plan only)** — with three constraints baked in, because Step 0 surfaced edges that need explicit handling.

## Guardrail 1 — Fix the banner STACK, not just SyncProgressBanner

Step 0 found the real collision is **four sticky banners** (BrokenIntegration / AiUsage / SyncProgress / Consent) each claiming `top:0`. Fixing only SyncProgressBanner's `whiteSpace:nowrap` leaves the other three still colliding on mobile. So:
- Build a single **banner container** that stacks the active banners in priority order (one owns `top:0`, the rest flow below it), rather than four independent sticky elements fighting for the top.
- On **mobile** tier: collapse to the existing 3px pip/strip by default (verify it works when MULTIPLE banners are active at once — that's the actual broken scenario).
- **Tablet**: rich content with `flex-wrap:wrap` on JobRow children (remove the `nowrap`).
- **Desktop**: current layout.
Verify with 2+ banners active simultaneously at mobile width — not just the sync banner alone.

## Guardrail 2 — Don't over-convert the 65 grids; leave the 2D matrices for their phase

The 65 inline grids are NOT homogeneous. `repeat(auto-fit, minmax(200px,1fr))` KPI strips collapse trivially → convert to `<CardGrid>`. But `repeat(7, minmax(120px,1fr))` calendar/scheduling matrices CANNOT just become `columns={{mobile:1}}` — a 7-day grid stacked to one column isn't a calendar. So:
- Convert only the **simple-collapse** grids in this phase.
- **Leave the 2D-matrix grids** (scheduling shift grid especially) untouched — they're explicitly deferred to their own interaction-redesign phase. Don't stretch `<CardGrid>` to cover them, and don't half-convert the scheduling grid into this phase.
- If a grid is ambiguous (is it a collapse-grid or a matrix?), flag it in the Step 4 plan rather than converting it.

## Guardrail 3 — Migrate the existing 880/680 surfaces to the new tiers (or grandfather explicitly)

The new system standardises on `mobile<768 / tablet 768–1023 / desktop≥1024`, but the working surfaces use hardcoded `880` (overheads/review) and `680` (reviews insights). If left as-is, you'd have TWO coexisting breakpoint systems — some pages break at 880, others at 768 — a subtle new inconsistency.
- Migrate `overheads/review` and `reviews` insights to the new `BP` tokens, OR
- If migrating them risks regression now, explicitly note them as grandfathered in `docs/LAYOUT.md` with a follow-up to migrate later.
Either is fine — just be deliberate, don't leave it implicit.

## Follow-up to note (not this phase) — escalate the guardrail once clean

The ESLint rule "warns, doesn't error" is right FOR NOW (23+65 legacy violations would make an error infuriating). But a warning everyone ignores is theatre. So note in `docs/LAYOUT.md`: **once the legacy fixed-width violations are migrated and the baseline is clean, escalate the rule from warn → error** so new violations are blocked, not just flagged. The guardrail's lasting value is catching the NEW fixed-width div added next month — make sure it eventually has teeth.

## Otherwise — as Step 0 specified
3-tier `BP` tokens + `useViewport()`, the primitives (`<PageContainer>`, `<CardGrid>`, `<MetricCardRow>`, `<DataTable cards>`, `<ResponsiveChart>`, `<ProductThumb>`), the ESLint warn-rule + `docs/LAYOUT.md`, banner fix, Overview rebuilt FROM the primitives (the proof the system works), numbers + honest-incomplete states unchanged. Read frontend-design SKILL.md; locked lavender tokens; Swedish formatting; no new libraries. Feature branch + preview; verify at all three widths before merge.

## Verify before merge
- Banner clean at all 3 tiers WITH multiple banners active (Guardrail 1).
- Overview built from primitives, reads correctly mobile/tablet/desktop, numbers identical.
- Scheduling grid NOT converted (deferred); the simple grids ARE (Guardrail 2).
- One breakpoint system, not two (Guardrail 3).
- Step 4 plan: scheduling grid + recipe editor sized (simple-breakpoint vs interaction-redesign, primitive used/contributed, effort each).
