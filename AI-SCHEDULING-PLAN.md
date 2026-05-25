# AI Scheduling — architecture + build plan

> Drafted 2026-05-25 after the user requested a deeper take on bringing back the AI-recommended schedule. Companion mockup at `cc_ai_recommended_schedule_en.html`. **Plan only — not yet implemented.** Revisit when the inventory-pipeline shipping work cools and the second multi-site customer onboarding is in sight.

---

## 1. What this delivers

A `/scheduling` page that:

- **Pulls the actual roster from Personalkollen** into a weekly grid (rows = staff, columns = days, cells = planned shifts).
- **Shows per-day demand context** alongside the schedule: forecast revenue, planned cost, planned hours, projected staff %, weather, holidays.
- **Surfaces AI-recommended changes inline** — per-shift suggestions (cut this shift, add an open shift here, move someone from Tuesday to Friday) with reasoning and SEK impact.
- **Lets the owner approve or override** each suggestion individually, then writes the accepted changes back to Personalkollen so the source of truth stays in PK.
- **Learns from owner overrides** the same way the bulk-review AI does — recent owner corrections become in-context examples for the next AI run.

The page is **advisory-first**. The AI never writes to PK without the owner clicking "Apply." Phase 1 ships read-only insight. Phase 2 adds the write-back. Phase 3 adds AI-builds-the-week.

---

## 2. UX summary (from the mockup)

Key elements from `cc_ai_recommended_schedule_en.html` informing the build:

| Element | Purpose |
|---|---|
| **Top banner** | "AI recommends N changes save X kr this week" — owner-visible value framing, with "Generate suggestion" CTA |
| **Day column header** | Date, weather icon, forecast revenue, planned hours, projected staff % chip |
| **Section group header** | Management / Front of House / Kitchen / Bar — collapsible, shows section totals |
| **Recommended-staff row** | Under each section header: AI's suggested headcount per day for THAT section |
| **Staff row** | Avatar + name, per-day shift cells |
| **Planned shift cell** | Striped lavender background = scheduled in PK with role + start-end times |
| **AI suggestion cell** | Dashed orange border = AI proposes adding/modifying this shift, not yet in PK |
| **Time-off cell** | Solid blue = approved time off |
| **Open shift placeholder** | Dashed lavender outline "+ Open shift" — empty slot the AI thinks needs filling |
| **Footer legend** + **"Apply & send to Personalkollen"** | Apply approved suggestions and push back to PK |

Decision implicit in the mockup: **the AI is allowed to recommend ADDING shifts, not just cutting.** This is a deliberate departure from the current `SCHEDULING_ASYMMETRY` rule (`lib/ai/rules.ts`). See §7.

---

## 3. Data architecture

### 3.1 What PK gives us (verify during Phase 0 probe)

We currently capture, per shift (`staff_logs` table):
- staff_uid, shift_date, scheduled vs logged signature, work_time net of breaks, estimated_salary, sale_center

We probably DO NOT yet capture (but PK likely exposes):
- **Shift start + end times** (we have totals but not the time window)
- **Position / role** per shift (server, chef, bartender, supervisor)
- **Section / department** at shift-level granularity
- **Break length** per shift
- **Shift type** (regular, open, holiday, sick, requested-off)

We almost certainly don't capture:
- **Staff contracts** — full-time vs part-time, max hours/week, contracted minimum
- **Availability** — days/times the staff member is willing to work
- **Position assignments at hire time** (vs at shift time)

**Phase 0 must include**: probe PK's API surface to map exactly which endpoints expose what. Start from `lib/pos/personalkollen.ts` and the `feedback_pk_api_gotchas` memory. Probably 4-6 hours of poking + writing a `scripts/probe-pk-schedule-api.mjs`.

### 3.2 New tables to add

**`staff_profiles`** — one row per staff per business, refreshed nightly from PK + derived patterns:

```sql
staff_profiles (
  staff_uid, business_id, org_id,
  display_name, full_name, email,
  primary_position TEXT,             -- 'server' | 'chef' | 'bartender' | 'supervisor' | 'gm'
  primary_section TEXT,              -- 'foh' | 'kitchen' | 'bar' | 'management'
  contract_type TEXT,                -- 'full_time' | 'part_time' | 'hourly' | 'visstid'
  contracted_hours_per_week NUMERIC, -- nullable
  hourly_rate_sek NUMERIC,
  ob_eligible BOOLEAN,
  hired_at DATE,
  -- Derived from observed shift history (refreshed nightly):
  typical_days JSONB,                -- { mon: 0.9, tue: 0.1, wed: 0.0, ... } 12-week trailing
  typical_shift_window TEXT,         -- 'opener' | 'midday' | 'closer' | 'split'
  versatility_score NUMERIC,         -- 0-1, fraction of total sections worked
  punctuality_score NUMERIC,         -- 0-1, scheduled-start vs logged-start agreement
  no_show_rate NUMERIC,              -- 0-1 over last 90 days
  last_refreshed_at TIMESTAMPTZ
)
```

**`staff_shifts`** — per-shift detail beyond what `staff_logs` aggregates (only added if PK has the data):

```sql
staff_shifts (
  id, business_id, staff_uid, shift_date,
  start_time TIMESTAMPTZ, end_time TIMESTAMPTZ,
  position TEXT, section TEXT,
  break_minutes INTEGER,
  shift_type TEXT,                   -- 'regular' | 'open' | 'on_call' | 'holiday' | 'sick'
  pk_shift_id TEXT,                  -- PK's stable id for write-back idempotency
  is_ai_suggested BOOLEAN DEFAULT FALSE,
  ai_suggestion_id UUID REFERENCES schedule_ai_suggestions(id),
  applied_at TIMESTAMPTZ,
  applied_by UUID,                   -- user_id of owner who clicked Apply
  source TEXT,                       -- 'pk_sync' | 'ai_generated' | 'manual_override'
  raw_data JSONB,
  ...
)
```

**`schedule_ai_suggestions`** — one row per AI-recommended change:

```sql
schedule_ai_suggestions (
  id, business_id, week_iso,
  staff_uid, shift_date,
  action TEXT,                       -- 'cut' | 'add' | 'reduce' | 'extend' | 'reassign'
  before JSONB,                      -- what's currently planned
  proposed JSONB,                    -- what AI suggests
  reasoning TEXT,
  est_sek_saving NUMERIC,
  confidence NUMERIC,
  status TEXT,                       -- 'pending' | 'applied' | 'rejected' | 'expired'
  applied_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ,
  ai_model TEXT, tokens_input INTEGER, tokens_output INTEGER
)
```

**`staff_performance_signals`** — owner-supplied micro-ratings (Phase 3):

```sql
staff_performance_signals (
  id, business_id, staff_uid,
  dimension TEXT,                    -- 'closer_confidence' | 'rush_capability' | 'section_fit' | 'demand_pull'
  score INTEGER,                     -- typically 1-5
  shift_id UUID REFERENCES staff_shifts(id) NULL,
  notes TEXT,                        -- optional, owner-typed
  source TEXT,                       -- 'post_shift_prompt' | 'weekly_review' | 'manual'
  recorded_at TIMESTAMPTZ, recorded_by UUID
)
```

### 3.3 The AI input contract

The scheduling AI receives a single context payload assembled by `lib/ai/scheduling-context.ts`:

```typescript
{
  business:        { id, name, country, opening_days, cost_targets, business_stage }
  week:            { iso: '2026-W22', from: 'Mon', to: 'Sun' }
  demand_forecast: per_day_revenue, per_day_covers, weather, holidays
  current_schedule: per_day_shifts[] from staff_shifts
  staff:           profiles[] (typical_days, versatility, rates, performance signals)
  history:         last_12_weeks_planned_vs_actual cost %
  rules:           { target_staff_pct, allow_ai_adds: boolean, max_consecutive_days, ... }
  recent_overrides: last 30 days of `schedule_ai_suggestions` where status=rejected — LEARN
}
```

AI returns `schedule_ai_suggestions` rows. UI shows them inline. Owner clicks Apply per-suggestion OR Apply-all. Applied suggestions write to PK + insert into `staff_shifts` with `is_ai_suggested=true`.

---

## 4. Build phases

### Phase 0 — PK API discovery (½ day)

- Probe `personalkollen.se`'s API for: per-shift detail endpoint (start/end/position/section), staff contracts endpoint, availability endpoint, write-back endpoints
- Document what's available vs not in this file
- Decision gate: if PK doesn't expose enough metadata, Phase 2 reduces in scope (we can still display + recommend, just less granular)

### Phase 1 — Grid display + insight overlay (2 days)

Goal: owner can see "this is what's planned this week, here's where we'll land cost-wise, here's what the AI thinks."

- Schema: `staff_profiles` (with auto-refresh cron) + `staff_shifts` if PK exposes detail
- PK sync extension: pull schedule for current + next week into `staff_shifts`, refresh `staff_profiles.typical_*` fields nightly
- API: `GET /api/scheduling/week?business_id=&week=YYYY-Www` returns the full grid payload
- UI: `/scheduling` page implementing the mockup, **without** the AI suggestion overlay (no orange dashed cells yet) — show planned shifts, section groupings, per-day totals
- AI insight banner: read existing `/api/scheduling/ai-suggestion` recommendations, surface "Project N% staff cost this week" + "Y kr above target" at the top

### Phase 2 — AI suggestions inline + apply-back (3 days)

- Schema: `schedule_ai_suggestions`
- New endpoint `POST /api/scheduling/ai-recommend` — runs the planner, writes suggestion rows, returns them
- UI: render suggestions as the orange dashed cells in the mockup. Per-cell **Approve / Modify / Reject** controls (NEVER auto-apply). Modify opens an inline editor for shift time/role/staff swap. Bulk "Apply all approved" at the bottom applies only the cells the owner has explicitly approved.
- PK write-back (`lib/pos/personalkollen-write.ts`): only if PK has a write API. If not, "Apply" updates `staff_shifts` locally + opens PK in a new tab with copy-paste-ready instructions.
- Learning loop: every Approve/Modify/Reject inserts into the suggestion row's status + records owner reasoning for next AI run. Modifications are particularly valuable signal — they show what the AI got CLOSE but not RIGHT.

### Phase 3 — Performance signals (1-2 days)

- Schema: `staff_performance_signals`
- Surgical UI prompts:
  - **After each close**: card on dashboard "Was [Closer] the right choice for tonight?" → quick rating
  - **End of week**: "Any staff that customers asked for by name?" → multi-select
  - **First time someone covers new section**: "Should [Name] become regular in [Section]?" → yes/maybe/no
- Feed scores into `staff_profiles` aggregated metrics (e.g., `closer_confidence: 0.87`)
- Scheduling AI's prompt gets a "Owner-validated strengths" block per staff

### Phase 4 — AI builds the week from scratch (3-5 days)

- New endpoint `POST /api/scheduling/ai-generate` — given empty week + constraints, AI produces the full schedule
- Constraints input UI: target staff %, mandatory minimum coverage per section, who's off, who can't work which days
- Generation returns a full set of `schedule_ai_suggestions` with `action='add'` for every shift
- Owner reviews, tweaks per-cell, applies

---

## 5. AI design

### Model + cost

- **Sonnet 4.6** with extended thinking — scheduling is genuinely a reasoning task, not classification. Worth the cost.
- Estimated cost per generation: ~$0.20 per week per business (rich context, ~30k input tokens with prompt cache)
- Prompt cache the staff profiles + business rules; only the variable week-specific data isn't cached

### Asymmetric rule revision

Current `SCHEDULING_ASYMMETRY` rule says "cuts only, never adds." Phase 2 onward needs to revisit this:

- **Recommendation:** keep cuts as the AI's default behavior, but allow adds when ALL of:
  - Forecast revenue is meaningfully above the trailing 12-week median
  - At least one day of similar forecast in the last 8 weeks ran above target labour %
  - The added shift is within an existing staff member's typical_days pattern (low commitment risk)
  - Owner has opted in via a settings toggle (default off)
- **NEW rule for the AI:** for every "add" suggestion, the AI MUST quantify the downside — what's the cash burn if revenue doesn't materialise? Owner sees this in the suggestion banner.

This goes into `lib/ai/rules.ts` as `SCHEDULING_ASYMMETRIC_V2` and the owner-toggle lives on `businesses.scheduling_ai_allow_adds`.

### Learning loop

Same pattern as the inventory bulk-review AI:
- Every Reject inserts into `schedule_ai_suggestions` with reasoning
- Next generation reads the last 30 days of rejections as in-context examples ("AI suggested X but owner rejected because Y — LEARN")
- Over time the AI's suggestions tighten to the owner's actual preferences

### Calibration

Track per-business "AI suggestion accept rate" — if it dips below 50% the AI is generating noise, surface a "AI is wrong too often, want to retune?" admin alert.

---

## 6. PK write-back — feasibility unknowns

The riskiest unknown for the whole plan. Two scenarios:

**A. PK has a documented write API.** Best case. We POST shift changes, PK accepts, our `staff_shifts.applied_at` records the round-trip.

**B. PK is read-only for third parties.** Likely. Then Phase 2's "Apply" button:
- Updates our `staff_shifts` table locally (so the AI sees the applied state next time)
- Generates a clipboard-friendly text summary ("Tuesday: schedule Anna 11:00-15:00 as server")
- Opens PK in a new tab pointed at the right week
- Owner manually applies in PK — sync picks it up on next nightly pull

Phase 0 must answer this before Phase 2 design is finalised. Memory note: the `project_pk_contracts_parked` memo says "Probe PK API for un-wired endpoints when revisited" — that's now.

---

## 7. Performance scoring — guardrails

Sweden has strict employment-law rules around documenting staff performance. The scoring system must be:

- **Explicitly scoped as a scheduling tool, not an HR tool.** UI copy says "This helps the AI schedule you better — it doesn't go in employee records."
- **Aggregated only.** Owner never sees a single owner-supplied rating attributed to a specific shift in a way that could be used to build a "performance file."
- **Time-windowed.** Scores older than 6 months don't influence the AI. Avoids permanent records of one bad shift.
- **Owner-only inputs.** Not collaborative — no other staff or managers leaving comments about a colleague.
- **No firing/raise integration.** The scores never appear in the upgrade flow or any HR-adjacent surface.

Worth a 30-minute review by someone with Swedish-employment-law context before Phase 3 launches. The risk isn't catastrophic but it's avoidable.

---

## 8. Risks + open questions

| Risk | Mitigation |
|---|---|
| **PK write API doesn't exist** | Phase 2 fallback: clipboard-friendly export + manual PK update |
| **AI suggests adds that owner rejects every time** | Track accept rate; if <50% disable adds for that business |
| **Staff profiles drift** when someone changes roles | Nightly refresh from PK + 12-week pattern window means it self-corrects in 2-3 weeks |
| **Performance scoring becomes an HR document** | Strict legal review + UI copy + 6-month decay |
| **Owners game the schedule** to pretend they hit target | Compare planned vs actual labour cost from PK — surface gap on dashboard |
| **AI doesn't account for skills the owner knows but hasn't rated** | Phase 3 performance prompts only ask for what's actionable; owner can always manually override the AI |
| **Cost runaway from AI calls** | Per-week generations cached 24h server-side; bulk regen capped to 1×/day per business |

### Open questions for the owner

1. **Where does the weekly target staff % come from?** Existing `businesses.target_staff_pct`, or weekly-adjustable on this page, or AI-derived from revenue forecast?
2. ~~**Approval model.**~~ **RESOLVED 2026-05-25:** AI always suggests, owner reviews + approves OR modifies before apply. Never auto-apply, never apply without owner pass. Both per-cell tweaks and "Apply all approved" available. The owner stays in control of every shift change that goes back to PK.
3. **Edit history.** When owner overrides AI's suggestion with their own change, is that change written back to PK? Or just to our `staff_shifts` for AI's next round of learning?
4. **Multi-business scope.** Do AI suggestions cross business boundaries (e.g., move someone from Vero to Chicce for one shift)? Almost certainly NO — separate Fortnox orgs make this messy — but worth confirming.
5. **Suggestion expiry.** A suggestion made on Monday for next Tuesday should expire by Tuesday morning — that's fine. But what about suggestions made for the current week as the week progresses?

---

## 9. Recommended sequencing

Real-world build order I'd recommend:

1. **Phase 0** — PK API probe (4-6 hours)
2. **Phase 1** — Grid + insight banner (2 days, ships immediately useful work)
3. **Customer feedback** — show Chicce + Vero, see if they actually use it before building further
4. **Phase 3** — Performance signals FIRST (before Phase 2), because:
   - Owner gets value with no AI noise risk
   - Builds the dataset needed for high-quality AI later
   - Tests whether owners will actually rate consistently
5. **Phase 2** — AI suggestions inline + apply-back
6. **Phase 4** — AI builds full week

Reversing 2 and 3 is the key non-obvious sequencing call. The AI suggestions are only as good as the data underneath them; build the data first.

**Effort total:** ~8-10 days for everything. Easy to ship Phase 1 + Phase 3 in a single week (~3-4 days) and let those bake before committing to the heavier write-back work.

---

## 10. Dependencies / parallel work

- **Variance loop** (M097, just shipped) — separate but the pattern matters: performance scoring → AI input pipeline is parallel to POS sales → variance calc, same architecture style.
- **Fortnox cache** (M098) — independent, no shared work.
- **Holiday module** — already powers OverviewChart red weekend labels; just reuse `getHolidaysForCountry()` for the day-header weather/holiday icons.

---

## 11. What we're NOT building

Explicit out-of-scope so we don't bloat:

- Shift swapping between staff (PK handles this; we don't try to replicate)
- Time-off request workflow (PK)
- Payroll calculations (PK + Fortnox)
- Multi-week future planning beyond 2 weeks (the AI's signal degrades fast past 2 weeks)
- Mobile app (web-responsive is enough for owner use; staff use PK's app)
- Staff-facing views (owner-only tool; staff continue using PK)

---

## 12. Open file references

- `cc_ai_recommended_schedule_en.html` — UI mockup
- `lib/pos/personalkollen.ts` — PK sync code (existing)
- `lib/ai/rules.ts` — scheduling asymmetry rule + benchmarks (will be revised)
- `lib/sync/aggregate.ts` — staff_logs aggregation (will be cross-referenced)
- `app/api/scheduling/ai-suggestion/route.ts` — existing weekly cron endpoint (will evolve)
- Memory: `project_pk_contracts_parked.md`, `feedback_scheduling_asymmetric.md`, `feedback_pk_api_gotchas.md`
