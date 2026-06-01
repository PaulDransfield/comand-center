# Booking-API → prep-list covers (future seam)

> Status: PLAN ONLY (not implemented). Written 2026-06-01 alongside the
> manual covers auto-fill (M117). Owner explicitly flagged: "eventually
> i want that covers booking live linked to when we connect booking
> apps through there api". This file records the seam so when we wire
> the first booking API there's no architecture surprise.

## Today (M117 — manual covers)

Owner types "200" into the covers input on `/inventory/recipes/prep`,
clicks Apply, every dish with `recipes.portions_per_cover` set gets
auto-filled. Single source: the owner's number, transient (not
persisted on the session).

## Tomorrow (booking-API auto-fill)

Same UI, same auto-fill math. Difference: the covers number arrives
from a booking platform (SuperbExperience, OpenTable, ResDiary,
Caspeco bookings, whatever the owner's restaurant uses) — pre-filled
for the relevant service date with the count of confirmed bookings.

### What "covers" means precisely

For booking-driven auto-fill, covers must be a defined number for a
defined service. Decisions to make at integration time:

- **Service date**: prep done today is usually for tomorrow's lunch
  + dinner. The page needs a date picker (defaults tomorrow). Booking
  API queries against that date.
- **Lunch vs dinner**: most restaurants prep separately. We may need
  two sessions per service day, each with its own covers number.
- **Confirmed vs predicted**: bookings are confirmed-to-date; walk-ins
  are unknown. The auto-fill source could expose both — "47 confirmed
  + 50 predicted walk-ins = 97 total" — with the owner free to nudge.

### Schema additions when we wire the first API

Add to `prep_sessions`:
- `service_date date` — what the session is prepping for
- `service_slot text` (`'lunch'|'dinner'|'all_day'`) — when relevant
- `covers_source text` — `'manual' | 'booking_api'`
- `covers_count integer` — the number used
- `covers_provider text` — `'superb_experience' | 'opentable' | …`
- `covers_ref text` — booking provider's stable query id (date/slot
  hash) so we can re-sync without dupes

Why persist these on the session? Two reasons:
1. Audit: "we prepped for 200 because the booking system said 200,
   that's why food cost was high — they cancelled 30 same-day."
2. Future feature: per-session calibration. If booking_api consistently
   under-predicts walk-ins for Friday dinner, AI can warn next time.

### Integration shape (per-provider)

Each booking provider needs:
- OAuth flow at `/api/integrations/booking-<name>` (mirrors the
  Fortnox / Personalkollen pattern).
- A "fetch covers" helper `lib/bookings/<name>.ts` exposing
  `getCoversForDate(integration, date, slot?) -> { count, source_ref }`.
- A dispatcher `lib/bookings/index.ts` that picks the helper based on
  the business's connected booking integration.

### UI changes when integrated

The covers input grows a small "Fetch from <provider>" button next to
Apply. Clicking it calls the dispatcher, fills the input, and the
existing Apply button does the same math as today. Owner can still
override the number — booking systems are inputs to the prep
decision, not the only voice.

Optional improvement once we have the data: predicted-vs-actual
covers chart on a completed session, sourced from POS sales (M097).
Calibrates the share `portions_per_cover` values over time.

### What NOT to change

The auto-fill math (`qty = round(covers × portions_per_cover)`) stays
identical. The per-dish mix share stays on the recipe row. The session
freeze-at-save invariant is unchanged. We're swapping the SOURCE of
the covers number, not the algorithm.

### Trigger to revisit

This file becomes active work when the owner is ready to connect a
specific booking provider. Don't build proactively — booking APIs vary
wildly in auth and data shape, and building against a hypothetical
provider wastes effort.

---

**Related:**
- `M117-RECIPE-PORTIONS-PER-COVER.sql` — the mix share field this all
  depends on
- `M097-POS-SALES.sql` — the actuals side for future calibration
- `feedback_prep_list_architecture.md` — the v1 manual flow and the
  POS-link seam for demand prediction (separate from this booking seam)
