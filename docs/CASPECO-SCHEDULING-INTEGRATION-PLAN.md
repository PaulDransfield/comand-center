# Caspeco Scheduling Integration — Scope

> Status: SCOPE (not built). Companion to `AI-SCHEDULING-PLAN.md` (the PK-based grid) and `docs/SWEDISH-LABOUR-COMPLIANCE.md`.
> Written 2026-06-10.

## 1. Goal & product principle

Make the CommandCenter scheduling grid work for **Caspeco** customers (e.g. Chicce), not just Personalkollen ones — and crucially:

> **The schedule should feel familiar to whichever system the customer already uses, only cleaner.**
> - A **PK** customer should see a PK-shaped schedule (same mental model, terminology, layout) — just easier to read.
> - A **Caspeco** customer should see a Caspeco-shaped schedule — same idea.

One canonical engine underneath; a **source-aware skin** on top. The owner never has to relearn how to read a roster.

## 2. Current state (what exists)

| Layer | PK | Caspeco |
|---|---|---|
| **Canonical grid tables** (M100): `staff_profiles`, `staff_shifts`, `staff_shift_templates` | ✅ populated by `lib/scheduling/pk-sync.ts` | ❌ not populated (Chicce: 0 shifts, 1 orphan profile) |
| **Roster** | PK `/staffs/` → `staff_profiles` | ✅ `/api/v1/Employees` → `caspeco_employees` (84, incl. `is_minor` via M150) — but a SEPARATE table, not the grid |
| **Schedule (planned shifts)** | PK `/work-periods/` → `staff_shifts` | ❌ **no validated endpoint** (see §4) |
| **Sections / locations** | derived from PK costgroup | `/api/v1/Stations` (have it) |
| **Grid + AI + compliance** | read the canonical tables → works | inert (no canonical data) |

The grid, the AI recommender (`/api/scheduling/ai-recommend`), and the compliance engine (`lib/scheduling/compliance.ts`) all read **only** the canonical tables. So the entire problem reduces to: **populate the canonical tables from Caspeco** + **skin the presentation per source**.

## 3. Architecture: canonical model + source adapters + source-aware skin

```
   PK API ──► pk-sync ──┐
                        ├──► staff_profiles / staff_shifts / staff_shift_templates  ──►  grid + AI + compliance
 Caspeco API ─► caspeco-sync ┘            (canonical, source-agnostic)                         │
                                                                                              ▼
                                                                          source-aware SKIN (PK preset | Caspeco preset)
```

- **Adapters** are the only source-specific data code. Each maps its provider's roster + schedule into the canonical shape. PK's already exists; this plan adds the Caspeco one.
- **Engine** (grid render, AI, compliance, OB math, labour rules) stays 100% source-agnostic — already true today.
- **Skin** is a presentation preset keyed off the business's scheduling source, so the layout/labels feel native.

This is the same "single writer, trusted reads" discipline used elsewhere: adapters write the canonical tables; everything downstream trusts them.

## 4. The gating dependency — Caspeco schedule endpoint (must resolve first)

Our adapter (`lib/pos/caspeco.ts`) currently exposes: `Employees`, `Stations`, `Articles`, `Booking/Bookings` (gated `booking.getall`), `Booking/Units` (gated `unit.getall`). **None of these is the staff schedule** — Bookings are guest reservations, not shifts.

**Open, blocking question: does Caspeco expose a planned-schedule / shifts endpoint to the API, and what permission does it need?** Caspeco's scheduling module clearly has the data (the customer rosters in it), but we have neither the endpoint name nor the permission confirmed. Likely candidates to probe: a `Schedule`/`Shifts`/`WorkingHours`/`Pass` resource, probably permission-gated like Booking.

**Phase 0 is discovery** (below). Until a schedule endpoint is confirmed + permission granted, Phase 2 can't be built — and a Caspeco customer's grid stays roster-only. This must be stated plainly to any Caspeco customer: scheduling depends on Caspeco granting the permission.

(Caspeco for Chicce is also currently `status='disconnected'` — reconnect needed before any sync.)

## 5. Data mapping (Caspeco → canonical)

| Canonical | Source | Notes |
|---|---|---|
| `staff_profiles.staff_uid` | `caspeco-<caspeco_employee_id>` | stable per-provider id, mirrors the `caspeco-…` convention already used in `staff_logs` |
| `staff_profiles.display_name` | `caspeco_employees.full_name` | already synced |
| `staff_profiles.is_minor` / `birth_date` | `caspeco_employees` (M150) | already derived — flows straight through |
| `staff_profiles.salary_type` / rates | Caspeco employment/contract | from `raw_payload.employments[]` |
| `staff_profiles.primary_section` | Caspeco station/profession | `/api/v1/Stations` + `current_station_id` |
| `staff_shift_templates` | Caspeco stations/shift types | dedupe by (station, shift-type) like PK templates |
| `staff_shifts.*` (date, start/end, breaks, staff_uid, section) | **Caspeco schedule endpoint** | **blocked on §4** |
| `staff_shifts.estimated_cost` | rate × hours (existing cost model) | reuse current cost logic |

## 6. Source-aware presentation (the "looks like PK / looks like Caspeco" part)

One grid component, a `schedulingSource` ∈ {`personalkollen`,`caspeco`} on the business drives a **preset**:

- **PK preset** — keep the current PK-style layout (rows = templates/staff, PK terminology like "period", PK colour conventions). The "easier" upgrades apply here: clearer hour/cost columns, readable shift blocks, sticky day headers, the compliance/OB badges.
- **Caspeco preset** — mirror Caspeco's native scheduling look (its station-based grouping, its shift/"pass" terminology, its colour language) so a Caspeco user recognises it instantly — same underlying grid, Caspeco vocabulary + grouping.

Implementation: a small `lib/scheduling/presets.ts` mapping source → { row grouping, labels/i18n keys, colour rule, shift-block style }. The grid reads the preset; no forks of the component. Default preset when source unknown.

"Easier" (applies to both skins): legible shift blocks, person/section totals, the forecast + target-% header, holiday/weekend shading, and the new compliance + OB-share cues — i.e. the source's familiarity **plus** CommandCenter's clarity and the labour-rule intelligence they don't get natively.

## 7. Write-back stance

PK is read-only for us (we never write back; owner applies changes in PK). Default the same for Caspeco unless their API supports schedule writes AND the customer wants it. So "Apply AI suggestion" stays the existing **manual/clipboard** model: CommandCenter recommends, the owner enters the change in their source system. Revisit write-back only if Caspeco exposes a safe schedule-write endpoint.

## 8. Dedup (both PK + Caspeco connected)

Rare but possible. Each shift carries a provider-prefixed id (`pk_…` / `caspeco-…`), so canonical rows don't collide. If a business has both, pick ONE scheduling source (a `scheduling_source` setting) as authoritative for the grid to avoid double-rostering — mirrors the revenue dedup discipline in `aggregate.ts`.

## 9. Phasing

| Phase | Scope | Depends on | Rough effort |
|---|---|---|---|
| **0 — Discovery** | Probe Caspeco for a schedule/shifts endpoint + permission name; confirm shift shape (times, breaks, station, employee). Use `scripts/diag-caspeco-probe.mjs`. Get the customer to grant the permission. | Caspeco partner/customer approval | days (external) |
| **1 — Roster → grid** ✅ SHIPPED (M151) | Caspeco `Employees` → `staff_profiles` (+`is_minor`); `businesses.scheduling_source`; `lib/scheduling/caspeco-sync.ts` wired into the sync. Chicce: 76 active staff now in the canonical grid. | none | done |
| **2 — Schedule → grid** | Caspeco schedule endpoint → `staff_shifts`; cost + breaks; idempotent upsert by `caspeco-<shift_id>`. Lights up grid + AI + compliance for Caspeco. | **Phase 0 (blocked)** | ~1–2 days |
| **3 — Source-aware skin** ✅ SHIPPED | `lib/scheduling/presets.ts` (PK + Caspeco + generic). Grid reads `scheduling_source`: source badge, view-toggle labels (PK "By shift" / Caspeco "By station"), source-aware default view (Caspeco → staff view), source-aware sync button (Caspeco → resync). | Phase 1 | done |
| **4 — Polish/"easier"** | Readability pass on both skins; surface CHECK 7/8 + OB-share per cell (engine already computes). | Phase 3 | ~1 day |

Phases 1 + 3 are **done** — a Caspeco customer's grid now shows their real staff with a Caspeco-shaped skin. Phase 2 (actual shifts) is the value unlock and is gated on Phase 0 (Caspeco schedule-endpoint permission).

## 10. Already done (foundation)

- Canonical grid model (M100) + PK adapter + AI recommender + compliance engine + OB math + labour ruleset.
- Caspeco roster with `is_minor`/`birth_date` (M142 + M150) — Phase 1's staff source is ready.
- Per-business labour config + minor settings UI (M149) — source-agnostic, already applies.

## 11. Open questions / risks

1. **Does Caspeco expose a schedule endpoint + permission?** (Phase 0 — the make-or-break.) If not, Caspeco customers get roster + manual entry only.
2. Does Caspeco's schedule carry **break** times and **section/station** per shift? (needed for the 10h/24h cap, rast, OB).
3. **Timezone** handling on Caspeco timestamps (the compliance + OB math assume local clock; we added `start_time_local`/`end_time_local` for this).
4. Caspeco **reconnect** + token longevity (currently disconnected for Chicce).
5. Should `scheduling_source` be explicit owner choice or auto-detected from connected integrations?
