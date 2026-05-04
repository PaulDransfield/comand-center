# Fix prompt — Scheduling

Real progress on this page. Encoding is fixed, English throughout, the Why column is gone, the DoW row exists. A few structural reorderings and one persistent formatting bug to squash.

Stay on the same branch.

---

## 1. Sidebar sync indicator — build the shared component

Current: sidebar shows `Spued 3mago` (no space, corrupted word). This is the seventh page showing this bug in a different broken form.

Per the Staff page fix prompt: create `components/ui/SyncIndicator.tsx` as a single shared component. Grep the codebase for every inline sidebar sync render and replace them all with imports of this one component. If the Staff prompt hasn't been applied yet, apply it now — don't patch this page in isolation.

Until that component exists and ships on every page, don't mark any further phase as "done".

## 2. Double `kr` suffix everywhere — formatting bug

Values across this page render with doubled currency suffix:

- `9,225 kr kr`
- `12,225 kr kr`
- `8,849 kr kr`
- `−9,752 kr kr` (in both the hero save indicator and the SAVING summary)
- `save 2,513 kr kr`
- `save 2,908 kr kr`

Root cause: a value is being formatted with the `kr` suffix by one function, then a template string appends `kr` again. Example:

```tsx
const formatted = formatKr(value)        // returns "9,225 kr"
return <>{formatted} kr</>                // renders "9,225 kr kr"
```

Fix:
1. Pick one canonical formatter — `formatKr(value)` that returns `"9 225 kr"` (note the space, per `en-GB` spacing rule in the design system)
2. Remove every hand-appended ` kr` in JSX — use only the formatter's output
3. Grep for `kr</` and `kr }` patterns to find all hand-appended instances

After fixing the double-`kr`, also apply Swedish-style digit grouping. The current output `9,225 kr` uses US comma grouping. Per `DESIGN.md § Cross-cutting behaviour rules`, it should be `9 225 kr` (space as thousands separator, space before `kr`):

```tsx
function formatKr(value: number): string {
  if (value == null) return '—'
  return value.toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
```

Apply across every page, not just Scheduling. This is also a global fix.

## 3. Swap the order of DoW summary and schedule table

Current order:
1. Hero
2. AI-suggested schedule (detailed table, 7 day rows)
3. By day of week summary
4. Weekly AI observations
5. By day of week summary (duplicate — see #4)

Spec order per `DESIGN.md § 8`:
1. Hero
2. **By day of week** — summary tiles (primary visual, overview)
3. **AI-suggested schedule** — detailed table (drill-in, details)
4. Optional AI observations

Reasoning: the summary answers "what's the overall pattern this week?" in 2 seconds. The detailed table answers "on which specific day and how much?" in 30 seconds. Summary goes first.

Move the `By day of week` card above the schedule table.

## 4. Delete the duplicate DoW row at the bottom

Looking at the screenshot, there are two identical `By day of week` card rows rendered. Same data, same layout. Delete the second one — keep only the one that's now at the top of the page (after the move in #3).

## 5. Handle `Weekly AI observations`

Current: a grey collapsed row titled `Weekly AI observations` with a dropdown caret and `available on Group plan` text. Clicking does nothing visible.

Two options:

**Option A — remove entirely.** If this isn't implemented yet, remove the row. Don't ship dead UI. The hero already conveys the key insight.

**Option B — move behind a help icon.** Next to the `AI-suggested schedule` card title, add a small `ⓘ` icon. On click, show a popover with the AI observations content. The popover says "Available on Group plan" with a CTA button if that's the gating model. Don't use a collapsed-row-with-no-expand-behaviour pattern.

Preferred: Option A for now. Add back as Option B later if the feature gets built.

## 6. Standardise weather format across rows

Inconsistent formats across rows:

- Mon: `2-4°C` (no precip)
- Wed: `1-5°C · 1.8mm` (with precip)
- Thu: `2-4°C · 4.5mm`
- Fri: `1-6°C · 1.5mm`
- Sat: `1-12°C · 0.9mm`

Standardise:
- Always show temp range as `{min}–{max}°C` (en-dash, not hyphen)
- Only show precip when > 0.3 mm
- When precip is shown, format as `{value} mm` with a space
- Separator between temp and precip: ` · ` (dot with spaces)

Example: `2–4°C`, or `1–5°C · 1.8 mm`

## 7. Verify the hero's `trim 4 days, keep 2` math

Hero says `trim 4 days, keep 2`. Let's count from the table:

- Mon 04-27: YOUR PLAN 45h → AI 45h → "no change suggested" (keep)
- Tue 04-28: YOUR PLAN 56.5h → AI 45.8h → change (trim)
- Wed 04-29: YOUR PLAN 64.5h → AI 65.3h → "no change" text (keep)
- Thu 04-30: YOUR PLAN 72h → AI 65.3h → change (trim)
- Fri 05-01: YOUR PLAN 137.5h → AI 128.3h → change with save (trim)
- Sat 05-02: YOUR PLAN 139.8h → AI 128h → change with save (trim)
- Sun 05-03: YOUR PLAN 0h → AI 0h → no-schedule day

That's 4 trims (Tue, Thu, Fri, Sat), 2 keeps (Mon, Wed), 1 off-day (Sun). Matches the hero's `trim 4, keep 2`. ✓

Numbers are correct, but the `Sun` row is being counted as neither trim nor keep. Update the hero template to be explicit:

```
AI can save 9 752 kr — trim 4 days, keep 2, Sun off.
```

Or just acknowledge the 7th day is off without belabouring it — the current text is fine if users understand Sun is always zero-scheduled.

## 8. Clean up "no change" text consistency

The AI SUGGESTION column shows `no change` on Wed and something like `45h / 12,225 kr kr` on Mon (which also says "no change" per the value being identical to YOUR PLAN). Make this consistent:

- When AI's hours = your hours: render as italic grey `no change`, no numbers
- When they differ: render the new hours + cost delta

Don't show `no change` text AND numbers on different rows for the same logical state.

## 9. Verify DoW card colouring matches bar colouring elsewhere

The DoW cards show:
- MON: `Overstaffed` (yellow background)
- TUE: `Overstaffed` (yellow background)
- WED: `Overstaffed` (yellow background)
- THU: `On target` (green dot/text)
- FRI: `Lean` (green-ish)
- SAT: `Lean` (green-ish)
- SUN: `0 days of data` (light grey)

The yellow is amber which reads as warning — correct for overstaffed. Green for on-target and lean. Good.

But the MARGIN column in the schedule table uses:
- Red for negative (Mon -4%)
- Amber for 30–50% (Tue 31%)
- Green for 50%+ (Wed 41% is listed as green which is borderline)

Confirm the thresholds match the rest of the app's semantic colours. Check `DESIGN.md § Cross-cutting behaviour rules` for consistency.

## 10. `Apply to schedule →` button — confirm it does something

The green `Apply to schedule →` button in the hero is the page's primary CTA. Confirm it's wired — if not implemented yet, either (a) wire it to the existing apply handler or (b) style as disabled with a tooltip `Coming soon`. Don't ship a button that looks live but does nothing.

---

## Verification

- [ ] `SyncIndicator` shared component exists and is used everywhere — no inline sidebar sync renders anywhere
- [ ] No double `kr` anywhere (grep `kr kr` should find zero matches)
- [ ] Numbers use Swedish spacing: `9 752 kr` not `9,752 kr`
- [ ] DoW summary card is above the schedule table, not below
- [ ] Only one DoW card, not two
- [ ] Weekly AI observations is either gone or a help-icon popover (not a dead collapsed row)
- [ ] Weather format consistent: en-dash in temp range, precip only when > 0.3 mm, ` · ` separator
- [ ] `no change` vs numbers rendering is consistent across all rows
- [ ] Apply-to-schedule button is wired or clearly disabled

Push when done.

---

## Note on the global fixes

Two items need to happen at the component level, not page level:

1. `SyncIndicator` — referenced in Staff and Scheduling fixes, still not built
2. `formatKr` — needs centralising so double-`kr` bugs stop happening

Build both. Apply app-wide. Then come back to complete remaining phase fixes.
