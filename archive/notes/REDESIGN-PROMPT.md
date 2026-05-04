# Claude Code prompt — apply the UX redesign, safely

Copy this whole file into Claude Code, or save it in the repo root and reference it with `@REDESIGN-PROMPT.md`. It sits alongside `@DESIGN.md`, which is the spec.

---

## Task

Apply the CommandCenter UX redesign specified in `@DESIGN.md`. That document is the single source of truth for what things look like and where they go. This document is the single source of truth for **how we ship it without breaking the app**.

If anything in this prompt conflicts with `DESIGN.md`, `DESIGN.md` wins on design. This document wins on process.

---

## Scope — non-negotiables

This redesign is **UX only**. No new features, no data changes, no plumbing changes. You may not:

- Change the data model, schema, or any SQL migration
- Change any API endpoint signature or response shape
- Change data-fetching logic (hooks, queries, fetch calls)
- Change business rules (labour target %, cuts-only AI policy, margin tiers)
- Install any new npm package — no chart library, no icon library, no component library
- Touch `lib/constants/colors.ts`, `app/globals.css`, or anything under `app/api/`, `db/`, `sql/`, `prisma/`
- Modify tests to make them pass — if a test breaks due to a DOM restructure, the test gets updated to assert the new DOM, not to skip the assertion

If you find yourself wanting to do any of the above, **stop and ask**.

---

## Pre-flight — the user runs this ONCE before anything else

Before Claude Code does anything, the user (me) does these in order:

1. **Confirm working directory is clean.** `git status` → no uncommitted changes. Commit or stash first.
2. **Confirm main builds and deploys cleanly today.** `npm run build` on `main` — if this fails, fix it before redesigning anything.
3. **Take baseline screenshots.** Open every page on the live app and screenshot it. Save them in `./baseline/` (gitignored) so you can compare each phase's output against the pre-change state.
4. **Confirm you have a preview/staging environment.** Vercel preview URLs, Netlify branch deploys, or a manual `npm run build && npm start` on a spare terminal all work. You need somewhere to verify each branch before merging.
5. **Create the redesign umbrella issue or checklist** in whatever tracker you use so you can tick off phases as they land.

Only after these five are done do we start Phase 0.

---

## Deployment model — branch per phase, verify before merge

The redesign ships in 10 phases (Phase 0 foundation + 9 pages). Each phase follows the same loop:

```
main
  │
  ├─ git checkout -b ux/phase-N-name
  │    │
  │    ├─ Claude Code implements phase
  │    ├─ npm run build passes
  │    ├─ commit
  │    │
  │    └─ user verifies in preview deploy
  │        │
  │        ├─ ✅ ok  → merge to main → deploy → next phase
  │        └─ ❌ bad → iterate on branch, or abandon and restart
  │
```

**Why branch per phase, not all phases on one branch:**

- Each phase is independently revertible. If Phase 5 ships and something breaks 3 days later, you `git revert` Phase 5's merge commit without losing Phases 1–4.
- Each phase gets its own preview deploy URL, so you can verify in an environment that matches production.
- If you lose interest or something goes wrong mid-redesign, the phases already merged keep working. No orphaned "v2" code.

**Why not a feature flag:** you don't need one. Git branches + revert cover the same rollback ability without adding flag infrastructure to maintain.

### Branch naming

```
ux/phase-0-foundation
ux/phase-1-overview
ux/phase-2-group
ux/phase-3-pnl
ux/phase-4-budget
ux/phase-5-forecast
ux/phase-6-revenue
ux/phase-7-staff
ux/phase-8-scheduling
ux/phase-9-departments
```

### Commit message pattern per phase

```
feat(ux): <phase summary>

Before:
- <what the page looked like>

After:
- <what the page looks like>

Files changed:
- <list>

Files explicitly NOT changed:
- lib/constants/colors.ts
- app/globals.css
- app/api/**
- <any data-fetching hook>

Rollback: git revert <this commit>
```

---

## How Claude Code works on each phase

For every phase:

1. **Before starting**, run `git checkout main && git pull` so you branch from the current production state.
2. Create the phase branch: `git checkout -b ux/phase-N-name`.
3. Read the relevant section of `DESIGN.md` and any earlier commits.
4. Implement the phase — only the files the spec says you can touch.
5. Run `npm run build` — must pass, no new warnings.
6. If the repo has lint (`npm run lint` or similar), run it — warnings may not increase.
7. Commit with the template above.
8. Push the branch. Report back with:
   - Branch name
   - Commit SHA
   - Exact list of files changed
   - Exact list of files you thought about touching but didn't, and why
   - The verification checklist for this phase (copied from below)
   - Any questions or ambiguities you encountered
9. **Stop.** Do not start the next phase until the user merges this one and deploys it.

---

## Phase 0 — Foundation

Branch: `ux/phase-0-foundation`

**Goal:** create every new shared piece so later phases slot in cleanly. Crucially, **no existing page changes in Phase 0.** The app should render identically to today after this ships.

### Do

1. Read `@DESIGN.md` end to end.
2. Run a repo audit. Report:
   - The real file paths for the 9 pages listed in `DESIGN.md § Per-page specifications`. If any path is wrong, stop and confirm.
   - Any existing component whose name would clash with a new component in the spec (`Sidebar`, `TopBar`, `KpiCard`, etc.). Do not replace these yet — note them and confirm strategy.
3. Create `lib/constants/tokens.ts` with the `UX` block from `DESIGN.md`.
4. Create all shared components listed in `DESIGN.md § Shared components` — empty but typed and exportable:
   - `components/ui/PageHero.tsx`
   - `components/ui/SupportingStats.tsx`
   - `components/ui/AttentionPanel.tsx`
   - `components/ui/Sparkline.tsx`
   - `components/ui/StatusPill.tsx`
   - `components/ui/SegmentedToggle.tsx`
   - `components/ui/TopBar.tsx`
5. **Do not** replace the existing `Sidebar` yet. Create `components/ui/SidebarV2.tsx` as the new version, but keep `Sidebar` in use. We swap it in Phase 1 so Phase 0 has zero visible impact.
6. **Do not** modify `AppShell` if it exists — create `components/ui/AppShellV2.tsx` alongside it. Same reason.
7. Run `npm run build`. Must pass.
8. Commit per template.

### Verification checklist (user does this before merging)

- [ ] `npm run build` passes locally
- [ ] Pull the branch, run dev server, click through every page in the app
- [ ] Every page looks **identical** to the baseline screenshots — no visible change
- [ ] No console errors
- [ ] New files exist at the paths above
- [ ] No files outside `lib/constants/tokens.ts` and `components/ui/*` have been modified

### If verification fails

`git branch -D ux/phase-0-foundation` and have Claude Code redo the audit. Phase 0 is pure addition — if it broke something, something was wrong with the audit.

### Merge + deploy

```bash
git checkout main
git merge --no-ff ux/phase-0-foundation
git push origin main
```

Deploy main. Confirm production still looks identical.

---

## Phase 1 — Overview

Branch: `ux/phase-1-overview`

**Spec:** `@DESIGN.md § 1. Overview`

**Critically important:** do not touch the `OverviewChart` component or any file it imports. That chart was built in a prior Claude Code session, and it's the one thing on this page that already works the way we want.

### Do

1. Replace the old `Sidebar` import with the new `SidebarV2` everywhere it's imported — grep for `import .* Sidebar` first. If `AppShell` exists and wraps pages, update it to use `AppShellV2`.
2. Redesign the page body:
   - Add `PageHero` above the chart. Hero content should use data the page already fetches — do not add new fetches.
   - Remove the top row of 4 KPI cards.
   - Remove the `NEXT 7 DAYS OREBRO` weather strip.
   - Remove the bottom P&L summary card with the 4 shortcut buttons.
   - Add the two-card supporting row: Departments list + AttentionPanel.
3. Build + commit.

### Verification checklist

- [ ] Build passes
- [ ] Sidebar shows 6 primary items + Alerts + Settings (not the old 11)
- [ ] Clicking sidebar items routes correctly to every other page (which still uses old layouts)
- [ ] The chart is unchanged: hover tooltip works, day filter opens, compare toggle works, period dropdown works, W/M toggle works
- [ ] No number appears twice on the Overview page
- [ ] Weather info appears only in the chart tooltip on future days, nowhere else
- [ ] The hero headline reads naturally — say it out loud, does it answer "how's this week going?"
- [ ] No console errors
- [ ] No regression on other pages (they still look exactly like today, just with the new sidebar)

### If verification fails mid-session

Iterate on the branch. Claude Code can keep pushing commits to the same branch until the checklist passes. Then squash-merge to main.

### If verification fails after merge to main

```bash
git revert -m 1 <merge-commit-sha>
git push origin main
```

Redeploy. Overview is back to its old layout, everything else is fine.

---

## Phases 2–9 — one per page

Same loop for each. Branches and specs:

| # | Branch | Spec | Key moves |
|---|---|---|---|
| 2 | `ux/phase-2-group` | `@DESIGN.md § 2` | Location cards grid + AI bullets |
| 3 | `ux/phase-3-pnl` | `@DESIGN.md § 3` | Inline month bars with expand-in-place |
| 4 | `ux/phase-4-budget` | `@DESIGN.md § 4` | Progress bars per month + status tally |
| 5 | `ux/phase-5-forecast` | `@DESIGN.md § 5` | Single full-year line chart + flags |
| 6 | `ux/phase-6-revenue` | `@DESIGN.md § 6` | Daily stacked bars + top days + mix |
| 7 | `ux/phase-7-staff` | `@DESIGN.md § 7` | Labour % chart + top 5 + insights sidebar |
| 8 | `ux/phase-8-scheduling` | `@DESIGN.md § 8` | Compact DoW row + side-by-side schedule |
| 9 | `ux/phase-9-departments` | `@DESIGN.md § 9` | Rows with sparklines + inline alerts |

### Generic verification checklist for every page phase

- [ ] Build passes, no new lint warnings
- [ ] Every metric that was on the old page is still accessible on the new page (possibly behind `View all →` or a row hover — but not removed)
- [ ] No number appears twice on the page
- [ ] Hero answers the page's implicit question (see `DESIGN.md` per-page sections)
- [ ] Drill-down links route correctly
- [ ] No console errors
- [ ] No files outside the page file and already-existing shared components got modified
- [ ] Only tokens from `UX` in `tokens.ts` are used for colours — no raw hex inline (exception: chart internals where SVG needs hex strings)
- [ ] Page renders correctly on narrow viewports (≥ 1024 px, which is their minimum supported width — do not need to redesign for mobile in this pass)

---

## Rollback playbook

### A phase's branch broke something (not merged yet)

No harm done. Either:

```bash
# fix it on the branch and re-push
git add . && git commit --amend && git push -f

# or nuke the branch and start over
git checkout main
git branch -D ux/phase-N-name
```

### A merged phase broke production

```bash
# find the merge commit
git log --oneline --merges | head

# revert it
git revert -m 1 <merge-commit-sha>
git push origin main
```

Redeploy. That one phase is rolled back; earlier phases stay live. Fix the phase on a new branch, remerge when ready.

### Multiple phases need rolling back

Revert in reverse order:

```bash
git revert -m 1 <phase-5-merge-sha>
git revert -m 1 <phase-4-merge-sha>
git revert -m 1 <phase-3-merge-sha>
git push origin main
```

### The foundation (Phase 0) broke something

Unlikely — it's pure addition. But if so, same revert procedure. Just be aware that reverting Phase 0 after Phases 1+ are merged will break those too, because they depend on Phase 0's new components. In that case, fix forward — don't revert Phase 0.

---

## What to do if something is ambiguous

Stop and ask. Examples of good questions:

- "The Group page currently has a `SyncLocationsButton` next to the header — spec doesn't mention it. Keep, move, or remove?"
- "The existing `KpiCard` component is used on 6 pages outside this redesign. Leave as-is, or update it to match the new token system?"
- "The Overview data query doesn't return `margin` directly — only `revenue` and `staff_cost`. Should I compute margin inline in the hero, or is there a hook that already does it?"
- "Hero headline for Forecast would need to mention 3 different months to be accurate — should I break the ≤ 14-word rule for this page?"

Examples of questions you already have answers to in `DESIGN.md`:

- "What colour should positive deltas be?" (green — `UX.greenInk`)
- "Should I install `recharts`?" (no, never)
- "Should I update the schema?" (no, never)
- "Should I delete the existing `colors.ts`?" (no, never)

---

## First message Claude Code should send back

Do not write any code in your first message. Reply with:

1. Confirmation you've read `DESIGN.md` in full and this prompt in full
2. The Phase 0 audit:
   - Real file paths for the 9 pages
   - Any component name clashes (with recommended strategy per clash)
   - Whether `AppShell` exists and what it does today
   - Whether the `OverviewChart` component exists and where it lives
3. Any clarifying questions you have before starting Phase 0
4. The exact branch name you'll create and the exact files you'll add in Phase 0

Only after I respond "go" do you start Phase 0.

---

## One more thing

The redesign is purely cosmetic. **The data layer must stay exactly as it is.** If you're ever unsure whether a change crosses the line from UX into system, assume it does and ask. Breaking the app is worse than taking an extra day to ship.
