# Owner actions pending — autonomous scheduling-build session 2026-05-25

Status of the AI scheduling build at the end of this session. **Phase 0 + Phase 1 shipped. Phase 2 pending.**

## Actions YOU need to take when back

### 1. Apply M100 SQL migration

File: `sql/M100-SCHEDULING.sql`. In Supabase SQL Editor, paste + run.

Creates five tables:
- `staff_shift_templates` — mirrored from PK
- `staff_shifts` — per-shift detail mirrored from PK
- `staff_profiles` — derived metadata + nightly pattern stats
- `schedule_ai_suggestions` — Phase 2 AI output cache
- `staff_performance_signals` — owner micro-ratings (Phase 3)

All with RLS via `current_user_org_ids()`. Idempotent.

### 2. Visit `/scheduling/grid` and click "Sync from PK"

- New page lives at `/scheduling/grid` (Schedule grid in the sidebar)
- Two views togglable: **By shift** (PK-native, rows = templates) and **By staff** (rows = staff members)
- Week navigation with Prev / This week / Next
- "Sync from PK" button pulls 12-week-back + 2-week-forward window into M100 tables on demand
- Once seeded, the nightly cron at 06:20 UTC keeps it fresh

**You'll need to do this once per business** (Vero, Rosalis). Check that:
- All staff appear with their actual shifts in the week
- Section auto-inference is sensible (some templates may land in "Other" — that's the keyword matcher not finding a hit; Phase 2 adds an owner-override UI)
- Holiday + weekend day-column colouring works
- Forecast revenue + projected staff % numbers populate (depend on existing forecasts data)

### 3. Test with both Vero and Rosalis

Vero's PK integration is in `status='error'` from the refresh-token races earlier — you'll need to re-OAuth at `/integrations` first. Rosalis was the customer whose schema example PNG you shared, so that's the one most likely to match the mockup faithfully.

### 4. Decide on Phase 2's AI add-suggestions

Plan §7 has a recommendation: keep "cuts only" as default, allow "adds" with explicit owner opt-in toggle per business. **Decide whether you want the AI to suggest adding shifts at all** before Phase 2 ships. The current `SCHEDULING_ASYMMETRY` rule says cuts only — your earlier instruction to "build the schedule" implies adds are OK. Just confirm.

---

## What was shipped this session

### Phase 0 — PK API discovery (DONE)

Probe script `scripts/probe-pk-schedule-api.mjs` ran against Vero's PK creds. Findings locked into `AI-SCHEDULING-PLAN.md §0`:

- `/work-periods/` has everything we need per shift (period_name, period_color, costgroup, breaks, OB, is_published, description)
- Templates derive from `(period_name, period_color, costgroup.short_identifier)` clusters (PK won't let us read `/periods/{id}/` directly)
- `/staffs/?with_employments=true` (already in use) has salary_type, hourly_rate, service_grade (contract %)
- **WRITE-BACK IS BLOCKED** — PK returns `Allow: GET, HEAD, OPTIONS` on /work-periods/. Phase 2's "Apply" button must fall back to clipboard export + open-PK-in-new-tab. No native write API for us.
- `/absences/` exists but 403 for our token — Semester detection falls back to regex on `period_name` for now

### M100 schema (DONE — needs SQL apply)

File: `sql/M100-SCHEDULING.sql`. Five tables defined; comprehensive RLS + indexes.

### PK sync helper (DONE)

`lib/scheduling/pk-sync.ts` exports `syncScheduleFromPK(db, businessId, token, opts)`:
- Pulls 12-week-back + 2-week-forward work-periods
- Dedupes templates by `(name, color, costgroup_short_id)`
- Maps PK colour keywords (red/blue/green/...) to UXP-compatible hexes
- Infers section bucket (kitchen / foh / bar / management / office) from name+costgroup keywords
- Marks shifts as `semester` / `sick` from name+description regex
- Refreshes `staff_profiles` at the end of every sync (derived stats: primary_section, typical_days, versatility, typical_shift_window)
- Idempotent on `pk_work_period_url`

### Cron + on-demand sync (DONE)

- `app/api/cron/scheduling-sync/route.ts` — nightly 06:20 UTC, runs sync for every PK-connected business. Wired in vercel.json.
- `app/api/scheduling/sync-now/route.ts` — owner-callable POST for the "Sync from PK" button

### `/scheduling/grid` page (DONE)

`app/scheduling/grid/page.tsx` — full Phase 1 implementation:
- KPI strip: planned cost / forecast revenue / projected % / gap-to-target
- 7-day grid with rich day-column headers (date, weekend/holiday colouring, forecast, planned hours, projected % chip)
- Section-grouped rows in both shift and staff views
- Colour-banded shift cells from `template.display_colour`
- Draft vs published opacity differentiation
- Semester blocks in muted blue (never overwritten)
- AI-suggested cells styled with dashed orange border (ready for Phase 2)
- View toggle remembered in localStorage per-business

### API endpoint (DONE)

`app/api/scheduling/week/route.ts` — single GET returns the full grid payload. Reads from M100 tables + joins forecast data + computes day aggregates + injects holiday data via `getHolidaysForCountry`.

---

## What's NEXT (Phase 2 + 3)

Plan recommends shipping Phase 3 (performance signals) BEFORE Phase 2 (AI suggestions). But Phase 3 needs you to be in the app interacting with shifts so the prompts have triggers. So next session:

1. Sit with Chicce or Vero owner for an hour, watch them use the grid
2. Decide which performance dimensions to actually prompt for
3. Build the post-shift prompt cards on the dashboard
4. Then layer in Phase 2: AI suggestions + per-cell Approve/Modify/Reject + the pre-publish review panel + clipboard export

Estimated: 5-7 days for Phase 2 + 3 combined.

---

## Commits this session

```
e54c4fe  feat(scheduling): Phase 0 + M100 schema + PK sync foundation
fc1e15d  feat(scheduling): Phase 1 — grid view + week summary + sync endpoints
```

Plus follow-up commit for the staff_profiles refresh logic.

---

## Background work that may still be running

- **AI bulk review loop** (Chicce inventory needs_review): was up to 1,115 / 1,504 groups cached when last checked. Should be ~complete by the time you're back. Visit `/inventory/review` and click "Apply all ≥85%" to bulk-resolve the suggestions.
