# Claude Code prompt — redesign the AI schedule panel on Scheduling

Replace the current `AI-suggested schedule` table on `/operations/scheduling` with a before-and-after comparison pattern that shows the value of AI recommendations in both kroner and labour percentage. The percentage is the industry benchmark — restaurant operators read labour % first, kroner second.

This is a **replacement**, not an addition. The current implementation (from Phase 8) stays on the page until this work swaps it out. All existing data flows stay exactly the same.

Work on the same branch as the Phase 1–9 fix work (`ux/phase-1-overview`), or branch new if that's been merged.

---

## Scope — non-negotiables

- Do not change the data model, schema, or any API endpoint
- Do not change the AI prompt or its output format — read what the existing AI schedule recommendations endpoint returns
- Do not add npm packages
- Do not touch `lib/constants/colors.ts` or `app/globals.css`
- Reuse `SyncIndicator`, `AttentionPanel`, `StatusPill`, `Sparkline` from `components/ui/*` — don't reimplement inline
- Labour targets live in business settings, with a hardcoded fallback (see § 3)

If the AI endpoint doesn't already return labour % per day, compute it client-side from `staff_cost / predicted_sales * 100`. Both fields should already exist.

---

## 1. Remove the old UI

Delete the current `AI-suggested schedule` card body — the table with DAY / ACTION / WEATHER / YOUR PLAN / AI SUGGESTION / PREDICTED SALES / MARGIN columns.

Also delete:
- The blue `1 day look lighter than...` info strip above the table (the message moves into per-day rows if applicable)
- The `SCHEDULED / SUGGESTED / SAVING` summary numbers in the card header (replaced by the hero panel)

Keep the period toggle above it (`Next week / 2 weeks / 4 weeks / Next month`). The new panel renders inside the same period scope.

---

## 2. Tier thresholds — range target, shared with Staff page

**Target is a range, not a point:** 30–35% of revenue is the sweet spot.

Create a helper:

```ts
// lib/utils/labourTier.ts
import { UX } from '@/lib/constants/tokens'

export type LabourTier = 'low' | 'on-target' | 'watch' | 'over'

export interface LabourTierConfig {
  targetMin: number  // default 30
  targetMax: number  // default 35
  watchCeiling: number  // default 50 (target max + 15pp)
}

export const DEFAULT_TIER_CONFIG: LabourTierConfig = {
  targetMin: 30,
  targetMax: 35,
  watchCeiling: 50,
}

export function labourTier(pct: number, cfg: LabourTierConfig = DEFAULT_TIER_CONFIG): LabourTier {
  if (pct < cfg.targetMin) return 'low'
  if (pct <= cfg.targetMax) return 'on-target'
  if (pct <= cfg.watchCeiling) return 'watch'
  return 'over'
}

export function labourTierStyle(tier: LabourTier) {
  return {
    'low':       { bg: UX.indigoBg, ink: '#4338ca', label: 'below target' },
    'on-target': { bg: UX.greenBg,  ink: UX.greenInk, label: 'on target' },
    'watch':     { bg: UX.amberBg,  ink: UX.amberInk, label: 'watch' },
    'over':      { bg: UX.redBg,    ink: UX.redInk2, label: 'over' },
  }[tier]
}
```

**Four tiers instead of three:**

| Tier | Range (default) | Colour | Meaning |
|---|---|---|---|
| `low` | `< 30%` | Indigo | Below target — may indicate understaffing; operator should verify |
| `on-target` | `30–35%` | Green | Optimal |
| `watch` | `35–50%` | Amber | Target exceeded but recoverable |
| `over` | `> 50%` | Red | Significant overspend |

Why a `low` tier instead of folding it into green: a day running at 22% labour might look great on paper but could mean understaffing — slow service, missed covers, customer complaints. Flagging it in indigo lets the operator decide if that's a genuine efficiency win or a service-quality risk.

**Config source:**
```ts
const tierConfig = business.labour_tier_config ?? DEFAULT_TIER_CONFIG
```

If business settings have the fields `labour_target_min`, `labour_target_max`, `labour_watch_ceiling`, use those. Otherwise the default 30/35/50.

**This replaces the hardcoded tiers on the Staff page too.** The earlier STAFF-FIX prompt set Staff page to green ≤40 / amber 40–70 / red >70. Update Staff to use the same `labourTier()` helper so both pages agree. Staff page's `BEST DAY / HIGHEST COST DAY` callout cards and chart bar colouring all flow through this helper.

---

## 3. Build the hero comparison panel

The new panel sits where the old table header was. Three parts stacked:

### 3.1 — Two side-by-side stat cards with an arrow between

Grid: `1fr 52px 1fr`. Left card grey (`UX.subtleBg`), right card green-tinted (`#f0fdf4` bg, `UX.greenBorder` border).

Both sides show three stats:

**Left `YOUR PLAN` card:**
- **Scheduled hours** — e.g. `515.3 h`, sub `64 shifts across 7 days`
- **Staff cost** — `139 500 kr` with a tier pill showing labour % right next to it (e.g. `41.9%` in amber pill). Sub line: `{delta}pp over target` or `within target range` depending on tier
- **Projected margin** — `44.2%`, sub `on {predicted_sales} kr predicted sales`

**Right `WITH AI APPLIED` card:**
- **Scheduled hours** — `477.8 h` with a green chip showing hours delta `↓ 37.5 h`. Sub `5 days trimmed · 2 kept as-is`
- **Staff cost** — `129 949 kr` with the new labour % pill (e.g. `39.1%`, still amber because 35–50 band, but visibly closer to target). Sub: `↓ 9 551 kr · ↓ 2.8pp toward target`
- **Projected margin** — `47.1%` with green chip `↑ 2.9pp`, sub `same predicted sales`

**The labour % pills use the `labourTier()` helper** — tier colour is automatic based on the value. Someone running a day at 27% sees an indigo pill; 33% sees green; 42% amber; 60% red.

Stat values on the right card render in `UX.greenInk` when the direction is improvement. When AI can't improve a stat (rare, but possible), render in neutral `UX.ink1` — don't fake green.

### 3.2 — Green saving strip

Full width below the two stat cards. Background `UX.greenInk`, white text, padding `14px 18px`, border-radius `UX.r_md`.

**Two-line headline:**
```
−9 551 kr · labour 41.9% → 39.1%
saved this week · margin up 2.9pp · 100% of predicted revenue preserved
```

Big saving amount + labour % transition on line 1 (18-20px, weight 500). Supporting context on line 2 (11px, rgba(255,255,255,0.82)).

**Right side: two buttons:**
- Secondary (transparent with white border): `Review day-by-day` → smooth-scrolls to the day rows below
- Primary (white bg with green text): `Apply all changes →` → fires existing "apply all" handler

The labour % transition in the headline is non-negotiable — that's what operators read first. Kroner second.

### 3.3 — Why strip

Separate small card below the hero, `UX.subtleBg` background, 11×14px padding, `UX.border` 0.5px border, `UX.r_md` corners.

Small indigo info icon + explanation:

```
ⓘ  Why these cuts. {N} days next week match ≥3 past days with
    the same weather and booking pattern that averaged higher
    revenue per scheduled hour than you're staffing for. Target
    labour 30–35% of revenue — AI trims toward the target range,
    never past it, and never adds hours.
```

`{N}` comes from the AI response count. If the AI returns a custom `reasoning_text` field, render that instead — but preserve the "Why these cuts." bold lead-in.

---

## 4. Day-by-day breakdown rows

Below the Why strip, a small section header `DAY-BY-DAY BREAKDOWN` (11px uppercase grey, `UX.ink4`), then a legend row, then seven day rows.

### 4.1 — Legend row (once)

Small, inline, non-shouty. Single line showing the four tiers:

```
Labour % tier — [<30%] below   [30–35%] on target   [35–50%] watch   [>50%] over
```

Pills use `labourTierStyle()`. Font size 10px. The range numbers in brackets should come from `tierConfig`, not hardcoded — if a business configures different tiers, the legend reflects them.

### 4.2 — Row anatomy

Grid: `110px 1fr 190px`. Three zones.

**Left zone (110px):**
- Day name + date (`Tue 28 Apr`), 12px weight 500, `UX.ink1`
- Weather line (`overcast 1–10°C`), 10px `UX.ink4`, en-dash between temps

**Middle zone** — three sub-columns: `YOUR PLAN`, arrow glyph, `AI SUGGESTS`

Each plan sub-column:
- Small uppercase eyebrow (`YOUR PLAN` / `AI SUGGESTS`), 9px `UX.ink4`
- Hours value, 13px weight 500, `UX.ink1` (or `UX.greenInk` for AI side)
- Cost row: `{cost} kr` in 10px `UX.ink3`, followed by tier-coloured pill with labour %

The arrow glyph is a simple 12×12 SVG arrow (`→`), coloured `UX.greenInk` when AI is suggesting a change, `UX.ink5` when AI says no change.

**Right zone (190px):**
- Saving amount, 15px weight 500 `UX.greenInk`
- One-line labour context: `labour {new}% was {old}%`, 10px `UX.ink3` with the new % highlighted in the tier colour
- `Accept` button below, 11px, green outline

### 4.3 — Row variants

| State | Visual treatment | When it renders |
|---|---|---|
| **Normal** (AI suggests cut) | White bg, default border, Accept button visible | AI's `action_type === 'cut'` |
| **No change** (AI says keep) | Entire row opacity 0.7 — AI side shows `keep as-is` grey text, right zone `—` instead of saving, button hidden | AI's `action_type === 'no_change'` |
| **Judgment call** (AI needs bookings review) | Indigo left border 2.5px + indigo `BOOKINGS` badge next to AI suggestion, right zone reads `judgment call` in grey, button reads `Open bookings →` | AI's `action_type === 'review_bookings'` or equivalent |
| **Accepted** (user already accepted) | Green border + `#f7fcf5` tinted bg, Accept button becomes filled green with `Accepted ✓` text | local state `accepted_row_ids.includes(day.id)` |

**Edge case: AI suggests a cut but the predicted labour % is already in the `low` tier after the cut** — the cut is the right call but the row should include a small indigo note at the bottom of the right zone: `low staffing — verify service` in 10px. This is rare but important: AI is optimising for kroner, not service quality; the human should double-check.

### 4.4 — Row interactions

- **Click Accept** → fires existing single-day accept handler, marks row accepted, recomputes hero totals (see § 4.5)
- **Click `Open bookings →`** on judgment-call rows → routes to bookings view for that specific date. If no such route exists, opens a small modal listing that day's bookings with a `Keep / Cut` decision
- **Hover any row** → border darkens to `UX.borderSecondary`, cursor pointer if the row is actionable (not `no-change`)
- **Click anywhere on a normal row except the button** → expands to show hourly breakdown for that day (stretch goal — only if the data is already available)

### 4.5 — Hero recomputation on accept

When the user accepts individual rows, the hero must reflect **what's been accepted so far**, not still show the "all AI" state.

- Initial state: hero shows full `WITH AI APPLIED` — all recommendations applied
- After user accepts some rows: hero shows `WITH {N} OF {M} APPLIED` — totals computed from accepted rows' new values + unaccepted rows' current values
- After user accepts all: hero shows `ALL {M} APPLIED`, green-filled version of the `Apply all →` button in the saving strip changes to `Undo all` for 10 seconds in case of regret

The label `WITH AI APPLIED` is a dynamic string:
- 0 accepted: `WITH AI APPLIED` (still showing full potential)
- 1–M-1 accepted: `WITH {N} OF {M} APPLIED`
- All accepted: `ALL {M} APPLIED`

---

## 5. Summary footer strip

After the last day row, a single-line grey strip (`UX.subtleBg` bg, `UX.border` 0.5px border, 10×14px padding):

```
week labour 41.9% → 39.1% · 5 days with cuts · 2 days unchanged    total saving −9 551 kr
```

Left side muted `UX.ink3`, right side `UX.greenInk` weight 500. Font 11px throughout. Confirms the hero numbers at the end of the scroll.

---

## 6. Wiring to existing data

The existing `/operations/scheduling` page should already fetch:
- User schedule per day (hours, shifts, staff_cost)
- AI recommendations per day (suggested_hours, action_type, reasoning)
- Predicted sales per day
- Weather per day

Reuse all of it. The only new client-side computation:
- `labour_pct_current = staff_cost / predicted_sales * 100` per day
- `labour_pct_ai = (staff_cost * ai_hours / current_hours) / predicted_sales * 100` per day, unless the AI response already returns a direct `ai_staff_cost` or `ai_labour_pct` field
- Week aggregates sum the above

If any of these aren't available, flag in the first audit message and we'll decide whether to add a new endpoint.

---

## 7. Remaining page content

The rest of the Scheduling page stays:

1. **By day of week summary** — 7-tile grid showing output kr/h vs target, below the new hero panel per SCHEDULING-FIX ordering
2. **How this period performed** — historical row at the bottom

These sit below the new AI panel. Hero is the most important thing; DoW summary and historical are supporting.

---

## 8. Accessibility

- Every Accept button, Apply all button, Review button, row-expand interaction is keyboard accessible with visible focus ring (2px `UX.indigo`)
- Tier pills have `aria-label`: `aria-label="Labour 42 percent, watch tier"` (not just the number alone)
- Hero compare panel uses proper landmark semantics — two `<section>` elements with `aria-labelledby` pointing to their `YOUR PLAN` / `WITH AI APPLIED` headings, so screen readers announce them as distinct regions
- The `Apply all →` is the primary action — confirm it's first in tab order inside the saving strip (before `Review day-by-day`)
- Keyboard shortcut: `A` on a focused row accepts it, `B` on a judgment-call row opens bookings, `Shift+A` applies all. Non-essential but nice.

---

## 9. Settings hook (comments only for this PR)

Add a comment where the config should source from:

```ts
// TODO: surface in Settings → Business → Labour target range (min/max/watch ceiling)
const tierConfig: LabourTierConfig = {
  targetMin: business.labour_target_min ?? 30,
  targetMax: business.labour_target_max ?? 35,
  watchCeiling: business.labour_watch_ceiling ?? 50,
}
```

A future PR can add the three number inputs in Settings. For now the 30/35/50 defaults cover every business.

---

## Acceptance checklist

### Tier logic
- [ ] `lib/utils/labourTier.ts` created with four-tier logic (low/on-target/watch/over)
- [ ] Default config is 30/35/50 but reads from business settings if present
- [ ] `labourTierStyle()` returns correct colours for each tier
- [ ] Staff page updated to use `labourTier()` — same formula, no more hardcoded 40/70 thresholds
- [ ] Both pages show the same colour for the same labour % value

### Hero panel
- [ ] Old AI-suggested schedule table deleted
- [ ] Hero has left grey card + arrow + right green card
- [ ] Staff cost stat shows **both kroner and labour % pill** on both sides
- [ ] `YOUR PLAN` side labour % pill is tier-coloured using the helper
- [ ] `WITH AI APPLIED` side labour % pill is tier-coloured, typically one tier better
- [ ] Saving strip headline reads `−{kr} kr · labour {old}% → {new}%`
- [ ] Two buttons: `Review day-by-day` (secondary) and `Apply all changes →` (primary)
- [ ] Hero label is dynamic: `WITH AI APPLIED` → `WITH N OF M APPLIED` → `ALL M APPLIED`
- [ ] Hero totals recompute when individual rows are accepted

### Why strip
- [ ] Separate card below hero with indigo info icon
- [ ] Explanation mentions the 30–35% target range (pulled from config, not hardcoded)
- [ ] If AI returns custom reasoning text, renders that; otherwise uses the canned template

### Day rows
- [ ] Three-zone grid (110px / 1fr / 190px)
- [ ] Labour % pill shows next to cost on both `YOUR PLAN` and `AI SUGGESTS` sides
- [ ] Arrow colour reflects whether there's a change (green vs grey)
- [ ] Right zone reads `labour {new}% was {old}%`, not generic "margin"
- [ ] Four row variants work: normal, no-change, judgment-call, accepted
- [ ] Legend row appears once above the day rows, using config-driven ranges
- [ ] Low-tier-after-cut edge case shows `low staffing — verify service` note

### Footer + misc
- [ ] Summary footer strip confirms hero numbers
- [ ] Zero `kr kr` anywhere (use `formatKr()`)
- [ ] Swedish spacing `9 551 kr` not `9,551 kr`
- [ ] `SyncIndicator` in sidebar (not custom)
- [ ] Keyboard navigable with focus rings
- [ ] `aria-label` on tier pills includes tier name
- [ ] `npm run build` passes, no new warnings

---

## First message back

Before writing code, reply with:

1. Confirmation you've read this prompt and understand the four-tier range-based target
2. Audit of the current Scheduling page — where the old AI table component lives, where its data fetching is, what fields the API returns per day
3. Confirmation that labour % can be computed from existing fields (or flag which is missing)
4. Confirmation that the existing single-row `Accept` and `Apply all` handlers can be called from new UI without modification
5. Plan for updating the Staff page to use the new `labourTier()` helper — specifically, which component renders the bar colouring today and which renders the BEST DAY / HIGHEST COST DAY callouts
6. Any clarifying questions

Wait for "go" before writing code.

---

## Why this matters

The current AI schedule table looks like a report. Restaurant owners read it and think "that's nice to know." The new panel looks like a decision.

Operators read the hero and see:
- `YOUR PLAN: 41.9% labour` (amber — not terrible, not great)
- `WITH AI: 39.1% labour · −9 551 kr` (still amber, but 2.8pp closer to green, and 9k kr saved)

That's the value proposition in one glance. The day rows below are the receipts that prove it.

The four-tier range-based target (30–35% green) is the correct hospitality framing because every single-point target (40%, 35%, whatever) creates a cliff: a day at 34.9% feels identical to 35.1% but one is "green" and one is "amber". A range honours that ±2pp is noise, not signal.
