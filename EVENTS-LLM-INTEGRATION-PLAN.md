# Events → LLM Forecast Integration — Plan (parked)

> Last updated: 2026-06-01
> Status: parked. Resume when recipe-cost surfaces Phase 1 ships and seeding has settled. Owner trigger to revisit: this doc explicitly + an "ok let's wire events" message.

## TL;DR

About half the Ticketmaster plumbing already exists from an earlier pass (fetcher + impact scorer + daily cron) but is dormant — no API key is set, no business has lat/lng, and nothing in the forecast consumes the impact output. Four narrow gaps close the loop. The LLM-prediction story sits on Piece 4 (the soft enrichment layer) — events become a pre-filtered prompt block, the LLM judges day-of-week × event-size compounding contextually, and the existing `[0.5, 1.5]` clamp caps blast radius.

---

## What's already built

| File | LOC | Status |
|---|---:|---|
| `lib/events/ticketmaster.ts` | 175 | Stockholm-only Discovery API fetcher, segment→category mapping, normalises to `NormalizedEvent` |
| `lib/events/impact.ts`       | 186 | Per-business impact scorer with haversine + distance falloff (5km→0.2), temporal curve, category base lifts, capacity weight |
| `app/api/cron/events-sync`   | —   | Daily 04:00 UTC cron; upserts to `events` table; soft-fails when API key missing (current state) |

The fetcher uses the **Discovery API** (per-query city search). The docs Paul pasted are for the **Discovery Feed** (bulk per-country daily .gz). Both surface the same event records; Discovery Feed is the better scaling choice at our customer scale (1 call per country per day; client-side spatial filter).

## What's missing — the four gaps

1. **`TICKETMASTER_API_KEY` not set.** Cron returns `skipped` every day. Zero data flowing.
2. **No business lat/lng.** `businesses.address` exists but isn't geocoded. `impact.ts` takes lat/lng as input — without it, the scorer can't fire.
3. **No forecast hookup.** `lib/forecast/llm-adjust.ts` (Piece 4) mentions named events in a guard comment but doesn't receive event context.
4. **Stockholm-only.** Chicce is in Eskilstuna; the current fetch misses its events. Multi-country/multi-city expansion needed before this helps any non-Stockholm customer.

## How events feed the LLM forecast (Piece 4)

Pipeline:
```
Deterministic baseline (DOW × seasonal × recency)
        │
        ▼
Recency layer (4-week 2× weight, this-week scaler)
        │
        ▼
Piece 4 LLM nudge — INSERT EVENTS HERE
   ↳ output clamped [0.5, 1.5]
        │
        ▼
Final forecast
```

Prompt context per forecast date, after pre-filtering:
```
Date: 2026-06-21 (Sat)
Deterministic baseline: 48,200 SEK
Recent context: last 4 Saturdays avg 46,800 SEK; trailing 7d trend flat
Events within 5 km on this date:
  - Bruce Springsteen at Friends Arena, 19:30 local, est 50k capacity (hotevent)
    distance 2.1 km, day-of, raw impact estimate +28%
  - "Sommarkrysset" outdoor festival at Skansen, 13:00–22:00, large
    distance 0.7 km, day-of, raw impact estimate +15%
```

The LLM then judges contextually:
- Do these compound? (multi-event days are non-linear)
- Is Saturday already busy enough that lift is marginal?
- Does this customer's base benefit from arena crowds (fine dining vs casual)?
- Day-of-week × event interaction (Tuesday concert ≠ Saturday concert)

Why through the LLM and not just `baseline × lift_pct`:
- Same event affects fine dining and casual pizzeria differently — hard to encode statically.
- Multi-event compounding is non-linear.
- DOW × event interaction is exactly the LLM's strength.
- Clamp caps blast radius if the LLM over-reacts.

## Trust gate — pre-filter before events hit the prompt

Drop events from the prompt entirely unless ALL of:
- `lift_pct >= 5 %` (below = noise)
- Venue `lat`/`lng` present (else can't trust distance)
- Either capacity OR `hotevent` flag (else can't size it)

Otherwise the LLM gets anchored to an event-day mental frame even when the event is tiny, and the prompt's signal-to-noise drops.

## Risks — what would make this WORSE than no event signal

1. **False positives → overstaffing → wage burn.** Tiny indoor comedy show fed in as "event near venue" → LLM nudges +5 % → owner adds a server → ~1,000 SEK wasted per occurrence. Pre-filter is the defence; clamp caps upside.
2. **Forecast contamination.** If event signal becomes load-bearing, vendor outage crashes forecast. Defence: events are enrichment over deterministic baseline; missing events → Piece 4 falls through to existing prompt with no event block, deterministic baseline still ships.
3. **Distance miscalibration.** `5km → 0.2` falloff is a default with zero real-world calibration. For a quiet city restaurant 1 km may already be too far; for a destination restaurant near a stadium 10 km matters. The calibration loop (next section) is where this gets tuned over time.
4. **No business lat/lng → silent zero signal.** Honest-incomplete: if we can't geocode the business, forecast simply runs without event context. Right default but means geocoding-at-onboarding is the unlock for the whole feature.

## Calibration loop

Constants in `impact.ts` are honestly admitted as "educated v1 defaults — no calibration data yet". Piggy-back on `ai_forecast_outcomes`:

Add two columns per outcome row:
- `event_context_summary` — what events the LLM saw (or null)
- `event_lift_estimate` — what impact function thought day-of lift would be

After 4–6 weeks compare:
- Predicted-with-events vs actual on event days
- Predicted-with-events vs actual on no-event days
- Tune base-lift constants per category toward observed mean error

This is the "Plan §C" the existing code comment refers to. Also unbuilt.

## Unlock chain (effort estimate)

| Step | Effort | What it unlocks |
|---|---|---|
| 1. Geocode businesses at onboarding | half day | Biggest single lever — unblocks impact scoring for every customer |
| 2. Set API key + extend fetcher to Discovery Feed; pull per country in `businesses.country` distinct set | 1 day | Multi-country / multi-city data flowing |
| 3. Wire impact output into Piece 4 prompt + pre-filter rules + `event_context_summary` write-back | half day | LLM forecast starts using event signal |
| 4. AttentionPanel card on `/dashboard` ("This week within 5 km: …") | half day | Owners read directly; forecast lift is a side benefit |
| 5. Calibrate after 6 weeks | passive | Tune lift constants from observed error |

Steps 1–3 are the smallest viable end-to-end slice. Step 4 makes it owner-visible. Step 5 is the long tail.

## Open scope questions (resolve when picking this back up)

- **Country scope for v1**: SE only, or SE + NO + GB (the current locale set)?
- **Geocoding provider**: built-in Supabase / Postgres extension; Mapbox Geocoding free tier; or rely on Fortnox address as the snapshot? (One-time per business; cheap regardless.)
- **AttentionPanel vs separate Events page**: card on `/dashboard` is the minimal surface; a dedicated `/events` page is overkill at our scale until ≥5 customers in cities with weekly major events.
- **Eskilstuna depth**: Discovery Feed includes regional Swedish events but smaller venues (Munktell Konsert, Sundbyholm Slott) may be under-covered. Need to check coverage before assuming Chicce gets useful signal.
- **Festival overlap**: multi-day events (e.g. Way Out West) currently land as 3 separate event rows. Impact scorer would double-count. Need de-duplication by (attraction, venue, week) at ingest.

## When to resume

This is parked because:
- Recipe-cost surfaces (Phase 1) is the active strategic build per the 2026-05-31 manual-pass verdict.
- Events integration only pays off when ≥1 customer has high-impact venues nearby (Vero qualifies; Chicce maybe doesn't).
- The owner-facing trust story benefits from being built AFTER recipe-cost lands — that surface trains owners on "honest-incomplete-state" patterns that events would inherit.

Trigger to resume: recipe-cost Phase 1 shipped + owner explicitly references this doc.
