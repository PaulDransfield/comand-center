# "Add another business" — current state, gaps, proposed flow

> Drafted 2026-05-11. Surfaced while looking at how Vero would add a second location after her initial onboarding. The bare path exists; the surrounding policy + data-capture story doesn't. Not blocking anything today — captures the gap so when the second-location customer lands, we don't ship a half-baked flow.

## Current state

### The path that works

1. Owner navigates to `/settings`.
2. "Restaurants" card → **"Add location"** button (`app/settings/page.tsx:206`).
3. Modal opens, three fields: **name**, **city**, **type** (dropdown of restaurant types).
4. Submit → `POST /api/businesses/add` (`app/api/businesses/add/route.ts`).
5. Row inserted into `businesses` with `org_id = auth.orgId`, `is_active = true`, `currency = 'SEK'`, default cost targets (food 31% / staff 35% / margin 15%).
6. New business appears in the sidebar switcher.

### What the API currently enforces

- Auth required (`getRequestAuth`).
- Rate limit: 20 inserts/hour per user (`rateLimit('biz-add:${userId}')`).
- Server-side enum validation for `business_stage` (allows null) and `country` (whitelist SE/NO/GB, else null → DB default 'SE').
- Server-side shape validation for `opening_days` JSONB.

### What the modal currently sends

Only `name`, `city`, `type`. Every other field on the API contract (`address`, `org_number`, `opening_days`, `business_stage`, `country`, cost targets) is omitted, so the DB defaults apply.

## Gaps

### 1. No plan-limit enforcement

`lib/stripe/config.ts:114-194` defines per-plan business caps:

| Plan      | `limits.businesses` |
|-----------|---------------------|
| Founding  | 3                   |
| Solo      | 1                   |
| Group     | 5                   |
| Chain     | Infinity            |

Neither `/api/businesses/add` nor the settings UI reads these. A Solo customer can add a second, third, twentieth location — the only ceiling is the 20/hour anti-abuse rate limit. This is a billing-correctness gap, not a security one, but at scale it matters.

### 2. Stripped-down data capture vs onboarding wizard

Onboarding (`/onboarding`) collects, per business:

- Name
- Address
- **Organisationsnummer** (validated via `lib/sweden/orgnr.ts`, stored at `organisations.org_number` via the shared helper `lib/sweden/applyOrgNumber.ts`)
- **Business stage** (`new` / `established_1y` / `established_3y`) — used by the budget AI to skip historical anchoring for brand-new businesses
- **Opening days** (Mon–Sun) — used by predictive models and the scheduling cron
- Cost targets (food / staff / margin)
- Country (drives holiday calendar routing — `lib/holidays/index.ts`)
- Optional last-year P&L PDF (only when stage ≠ 'new') — feeds Fortnox extraction stack

The "Add location" modal collects: **name, city, type**.

Consequences for a Vero-adds-second-business flow today:
- Budget AI runs against `business_stage = null` (won't apply the new-business skip-historical-anchor rule)
- Scheduling AI runs against `opening_days = open every day` (the column default), which is wrong for almost any real restaurant
- No org number → can't tie the new business to Fortnox at all (Fortnox is org-nr-scoped on the integration upsert, per `feedback_fortnox_business_id_required.md`)
- No country pick → holidays default to SE, fine in practice but silently wrong if a customer expands across borders

### 3. No integration onboarding for the new business

After insert, the owner is dropped back on the settings page. To make the new business actually useful, she has to:

1. Know to navigate to `/integrations`.
2. Know to switch the sidebar to the new business first.
3. Click through Personalkollen connect (or whichever POS she uses).
4. Click through Fortnox OAuth — which per `feedback_fortnox_business_id_required.md` requires the correct business_id in the connect URL, which only resolves correctly if she's switched the sidebar.
5. Optional: upload last-year P&L PDF and walk it through the validators + AI auditor + owner review.

None of this is discoverable from the "Add location" flow. The integration steps are independently solid (Vero's onboarding 2026-05-09 confirmed the flow works) but they're not stitched into the add-business journey.

## Proposed flow

### A. Route the existing onboarding wizard for second+ businesses

The cleanest fix: clicking "Add location" routes the owner into the existing `/onboarding` wizard, parametrised to **append** a business instead of create the first one. This reuses every form, validator, and integration step that already works.

Wizard step changes:
- Restaurant step: same form as initial onboarding — name, address, org-nr (validated), stage, opening days, cost targets, country. Pre-filled where reasonable (country defaults to the org's other businesses' country).
- Systems step: same Personalkollen + Fortnox connect flow, scoped to the new business_id. Optional last-year P&L PDF.
- Done step: drop her on the new business's dashboard with the sidebar switched.

Routing affordance: `/onboarding?append=1` or `/onboarding/add-business`. The onboarding gate (`components/AppShell.tsx` → `OnboardingGate`) already treats an org with ≥1 business as "completed" — adding the append flag bypasses the gate without changing its meaning.

### B. Plan-limit enforcement at three points

1. **Settings page** — read the current plan + count businesses; disable the "Add location" button when at limit, with copy that links to `/upgrade`. (`SELECT plan FROM organisations` + `SELECT count(*) FROM businesses WHERE org_id = $1 AND is_active = true`.)
2. **API** — `/api/businesses/add` checks `PLANS[org.plan].limits.businesses` against the current active count before insert. Returns 402 (Payment Required) with `{ error: 'plan_limit_reached', upgrade_to: 'group' }` so the UI can react.
3. **Onboarding-append entry** — the same check at the wizard entry, since route B uses the same backend.

`Infinity` is treated as "no cap" for Chain — `count >= Infinity` is always false in JS, no edge case.

### C. Soft deprecation of the bare modal

The three-field modal stays for now but redirects to the wizard on "Add". Quietly removed once the wizard route is in. Alternatively: keep the modal for `type='cafe' | 'food_truck' | 'catering'` (non-Fortnox/PK businesses) where the full wizard is overkill — TBD with you.

## Sequencing

| Step | Effort | Risk | Notes |
|---|---|---|---|
| 1. Plan-limit check in `/api/businesses/add` + 402 response | 15 min | Low | Pure server change. Unlocks the UI work below. |
| 2. Settings UI: read plan, disable button + upgrade CTA | 30 min | Low | Reads `organisations.plan` already; just plumb a `limits.businesses` check. |
| 3. Onboarding wizard: append-mode | 1–2 h | Medium | Need to factor the wizard so it doesn't assume "first business". Reuses every existing form. |
| 4. Replace the three-field modal with a wizard-redirect | 15 min | Low | Single button change in `app/settings/page.tsx`. |
| 5. Integration step gating in wizard | 30 min | Low | Already works in onboarding; just verify it works with `append=1`. |

Total: roughly half a day's work for a clean second-business story. Worth doing **before** the second-location customer lands rather than after — onboarding the first multi-location group with a half-finished flow burns trust.

## Open questions

- **Plan-limit guard for downgrades.** If a Group customer has 4 businesses and downgrades to Solo (limit 1), what happens to the extra 3? Hide them? Keep them visible read-only? Block the downgrade? Stripe webhook side, not in scope here but the policy needs deciding.
- **Founding plan ambiguity.** Founding limit is 3 (per `lib/stripe/config.ts:83`). Founding customers are buying a 24-month price-lock; we should probably allow them to add up to the Founding cap during the lock window without forcing an upgrade.
- **Sidebar UX when ≥5 businesses.** Today's switcher scales fine for 1–3, gets crowded at 6+. Chain-tier UX is a separate piece — flag for ROADMAP.
- **Org-nr collision check.** If the owner adds a second business with the same org-nr as an existing one, that's probably a department of the same company, not a new business. Should we detect and offer to split into departments inside the existing business?

## References

- `app/api/businesses/add/route.ts` — current insert endpoint
- `app/settings/page.tsx:206` — current entry point
- `app/onboarding/page.tsx` — wizard to reuse
- `lib/stripe/config.ts:107-194` — plan definitions
- `lib/sweden/applyOrgNumber.ts` — org-nr persistence helper
- `lib/holidays/index.ts` — country-routed holiday module
- `components/AppShell.tsx` — OnboardingGate logic
- Memory: `feedback_fortnox_business_id_required.md`, `feedback_auth_gate_sequence.md`
