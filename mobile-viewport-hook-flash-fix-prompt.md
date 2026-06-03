# Claude Code — Mobile: Fix the "loads mobile then flips to desktop" Flash (it's the viewport hook, not the layout)

## The real symptom (this changes the diagnosis)

The dashboard **renders correctly as mobile (stacked, no overflow) on first paint, then switches to the broken desktop layout.** This is NOT a missing-responsive-layout problem — the responsive layout EXISTS and works on initial render. It's a **viewport-detection misfire**: after hydration, the JS that decides "mobile vs desktop" computes "desktop" on a phone and flips the layout, causing the overflow.

So previous "convert the grids" attempts missed because the grids ARE converted — they're being *told they're on desktop* by a hook measuring the wrong width. **Fix the measurement, not the layout.**

Read `/mnt/skills/public/frontend-design/SKILL.md`. No new libraries. Feature branch + preview.

## Step 1 — Find why the breakpoint decision flips to desktop after mount

Inspect `lib/hooks/useViewport.ts` (and `useContainerWidth`) — whatever makes the mobile/tablet/desktop decision:
1. **What width does it read?** `window.innerWidth`? `document.documentElement.clientWidth`? A container's `getBoundingClientRect`/ResizeObserver width? 
2. **The likely bug — measuring overflowed content, not the viewport:** if it reads a clientWidth/container width AFTER the content has overflowed, it measures how wide the content sprawled (desktop-wide), concludes "desktop," renders desktop, which confirms the overflow — a feedback loop. On a 360px phone it should read ~360, but if it's reading a grown container it reads ~1100 and picks desktop. **Confirm exactly which width it reads and what that width evaluates to on a 360px viewport.**
3. **SSR/hydration default:** server renders with no `window` → defaults to a tier (currently mobile, correct), client hydrates, `useEffect` measures → if the measurement is wrong it flips to desktop. The flash is server-mobile → client-wrongly-desktop.
4. Report the exact line + width source + what it returns at 360px.

## Step 2 — Fix at the shared hook (so EVERY surface benefits)

`useViewport()` is the foundational primitive every responsive surface depends on. If it misreads width post-hydration, **every** converted surface flips to desktop after load — which explains why "I converted it, still shows desktop" kept happening across surfaces. So this is likely not a dashboard bug at all but a bug in the shared hook.
- Fix the hook to read the **true viewport width** (`window.innerWidth` / `visualViewport`), NOT a container width that can be corrupted by overflow, and NOT a measurement taken after content has sprawled.
- Ensure it measures correctly on mount AND updates on resize/rotate, without the flip.
- If there's an SSR default-then-flip, make the post-hydration measurement correct so it doesn't flip to a wrong tier.

## Step 3 — Prove no flash + correct detection

- At **360px**: the hook must report `mobile` and STAY mobile (no flip to desktop after hydration). Report what tier it computes at 360 / 800 / 1440.
- No layout flash: page loads mobile and stays mobile — confirm the stacked layout doesn't snap to the overflowing desktop grid after load.
- `scrollWidth === clientWidth` at 360px after full hydration (not just first paint).
- Screenshot at 360px AFTER the flip-window (give it a second post-load) showing it stayed stacked.

## Step 4 — Confirm the blast radius (is this why MULTIPLE surfaces looked broken?)

If the bug is in the shared `useViewport()`, it affected every surface using it.
- Confirm: do the OTHER surfaces (recipe editor, Items, etc.) also flip mobile→desktop after load? If yes, this one hook fix repairs all of them at once — verify a couple.
- This likely consolidates the whole "mobile keeps being broken" saga into one root cause (the hook), the same way the silent-null batch bug was one root cause behind many false symptoms.

## Hard rules
- Fix the WIDTH MEASUREMENT in the shared hook, not the layouts (the layouts are already converted — they're being told the wrong tier).
- Read true viewport width (`window.innerWidth`/`visualViewport`), never a container width corruptible by overflow.
- Acceptance = computes `mobile` and STAYS mobile at 360px post-hydration, no flash, scrollWidth===clientWidth — with screenshot taken AFTER the flip-window.
- One shared-hook fix should repair every surface — verify the blast radius.
- Layout/logic unchanged otherwise; numbers + honest-incomplete states identical.
- Feature branch + preview; verify on the deployed preview.

## Deliverable
The viewport-hook fix + proof of no flash, on a feature branch + preview.

Three-line chat summary:
1. The root cause — what width the hook read and why it flipped to desktop on a phone (the overflow feedback loop? SSR-hydration mismatch?), now fixed to read true viewport width;
2. Proof — at 360px it computes mobile and STAYS mobile (no flash), scrollWidth===clientWidth post-hydration, screenshot after the flip-window;
3. Blast radius — was this the shared hook breaking MULTIPLE surfaces (so this one fix repairs them all), or dashboard-only.
