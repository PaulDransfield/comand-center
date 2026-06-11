# Staff & manager logins — plan

> Owner decisions locked 2026-06-10. Built incrementally; this tracks what's done vs next.

## Roles (final)

- **Owner** — everything (financials, billing, settings, user management). Unchanged.
- **Manager** — full operations **and full financials** (revenue + P&L + forecast + budget + overheads). Order lists, scheduling, inventory, recipes-with-cost. NOT: billing, settings, user management, AI assistant, group, admin. (The "chef" tier folds into manager.)
- **Staff** — kitchen/line. Prep list (view + complete, logged per person), recipes as **operational view (method + quantities, no money)**, stock counts (values shown — owner's call), waste. Nothing financial, no other-staff PII, one location only. **Real email login** so every prep completion is attributable.
- **Revisor** — existing, read-only month-end. Unchanged.

### Locked micro-decisions
- **Invites: owner only.** User management stays owner-only; owner assigns role + location.
- **Stock counts for staff: values shown** (no blind-count mode).
- **Prep accountability: full append-only history** (every check/uncheck, who + when, kept permanently).

## What already existed (foundation)
- Real RBAC: `lib/auth/permissions.ts` (`canAccessPath`, fail-closed allow-lists), `requireFinanceAccess`/`requireOwnerRole`/`requireBusinessAccess`, `organisation_members.role` + `business_ids` + `can_view_finances`.
- Prep completions already store `checked_by` + `checked_at` on `prep_session_lines`.
- Invite flow `/api/settings/team` (owner-only) + `sendInviteEmail`.

## Phase 1 — access model + audit infra ✅ SHIPPED (2026-06-10)
- `permissions.ts`: added **`staff`** role — tight allow-list (recipes/prep, counts, waste; everything else denied), and `canAccessBusiness` requires explicit scope (like revisor).
- `/api/settings/team`: `staff` is now invitable; **managers default to `can_view_finances = true`**; staff forced `false`; staff/revisor invites must be scoped; staff land on `/inventory/recipes/prep`.
- **M153** `prep_session_line_events` (append-only) + the toggle endpoint now records every check/uncheck with user + timestamp.

## Phase 2a — backend safety ✅ SHIPPED (2026-06-10)
- [x] **Cost stripped server-side for staff** on the recipe list (`/api/inventory/recipes` GET) AND detail (`/api/inventory/recipes/[id]` GET) — every money field (price, food cost, GP, per-ingredient cost) nulled before it leaves the server, so it can't leak through the UI.
- [x] **`requireOperator` guard** (owner/manager only) on every staff-reachable mutation: recipe create/patch/delete, ingredient add/edit/delete, promote, promote-bulk, import-parse, recipe image. Prep: create + patch + delete guarded; **the line toggle stays open** (staff's core action). The path allow-list isn't method-aware, so these per-route guards are what actually stop a staff login writing.

## Phase 2b — staff UI ✅ SHIPPED (2026-06-11)
- [x] **Team settings UI** — "Invite staff" button + Staff role in the invite modal (location-scoped, required) + staff role pill.
- [x] **Accountability surfaced** — prep GET resolves `checked_by` → name; prep page shows "Done by «Name» · 14:20" per completed line.
- [x] **Staff nav + landing** — `RoleGate` redirects staff (and revisor) to their home (`/inventory/recipes/prep`) instead of a dead "back to dashboard" loop; the rail + toolbar dropdowns now filter areas/pages by role (`useAuthSubject` + `canAccessPath`) so staff only see what they can reach.
- [x] **Recipe book read-only for staff** — list page hides the authoring buttons (add/import/AI-fill) + the promote/"Add to inventory" selection; cost was already stripped server-side (Phase 2a).

## Phase 2c — dedicated staff views ✅ SHIPPED (2026-06-11)
- [x] **Focused staff prep view** — `components/inventory/StaffPrepView.tsx`: loads the active session, shows lines with a big tap target + "Done by «Name» · time", and a read-only method/ingredients modal. The prep route (`/inventory/recipes/prep`) now branches by role (`PrepPageRouter`) so the owner page's create/manage hooks never run for staff.
- [x] **Scoped staff to prep + counts + waste** — removed the recipe list/detail (owner authoring editor) from the staff allow-list. Staff get method + quantities for what they prep via the prep view's modal; the recipes editor is never reachable. (The recipe cost-strip from Phase 2a stays as defense-in-depth.)

**Staff role is now ready to invite.** Surface = prep view (tick-off + method), stock counts, waste. Everything financial/authoring is denied + filtered out of the nav; every completion is attributed.

## Future options (not needed for launch)
- [ ] Dedicated read-only recipe *browse* for staff (look up a recipe not in today's prep), if owners want it.
- [ ] Manager view of the prep audit ("who prepped what this week") from `prep_session_line_events`.
- [ ] Staff-optimised counts/waste screens (currently the shared pages; usable but owner-shaped).

## Phase 3 — polish (later)
- [ ] Manager view of the prep audit ("who prepped what this week").
- [ ] Optional: link a staff login to its `staff_profiles` record (so "your shifts" could appear later).
- [ ] Consider per-location staff dashboards.

## Notes / gotchas
- The permission allow-list is **path-based, not HTTP-method-aware** — so granting staff the recipe *read* path also technically permits POST/PATCH to it. Phase 2 must add explicit role guards (manager/owner) on mutating recipe/prep endpoints, OR split read vs write paths.
- No staff users exist yet, so Phase 1 changes are inert until Phase 2 ships + the owner sends the first staff invite. Don't expose "Staff" in the team UI until the cost-strip + read-only recipe view land.
