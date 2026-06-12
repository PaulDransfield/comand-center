# Onboarding — connect Fortnox first, then auto-fill

> Owner decisions locked 2026-06-12 (via in-app prompt). Goal: when a new user picks Fortnox, connect immediately, pull company info, prefill the wizard, and start syncing earlier.

## Owner decisions
- **Flow shape:** connect-first. The FIRST thing is "How do you do your books?". Picking Fortnox connects right away (OAuth), then the restaurant-details step opens prefilled.
- **Prefilled fields:** **lock the legal fields** — org-nr + legal name come straight from Fortnox, read-only (Fortnox is the legal source of truth). Display name + address/city editable.
- **Non-Fortnox:** owners on another system / none fall through to the current **manual** onboarding, unchanged.

## Foundations — ✅ SHIPPED (2026-06-12)
- **OAuth `return_to`** (`app/api/integrations/fortnox/route.ts`): connect reads `return_to=onboarding` (allow-listed) into the signed state; the callback **awaits** the company-identity sync (so the row is populated before redirect) and sends the user back to `/onboarding?fortnox=connected&business_id=…` instead of `/integrations/fortnox/verify`. Normal connect (no `return_to`) is unchanged.
- **Company address persisted** (`lib/fortnox/company-identity.ts`): `syncBusinessIdentityFromFortnox` now backfills `businesses.address` (street + zip, since there's no zip column) when ours is empty — alongside the existing org_number / legal_name / city / country. So onboarding can prefill the address too.
- **`/api/businesses/update` extended**: now also patches `address`, `country`, `opening_days`, `business_stage`, `target_food_pct`, `target_staff_pct`, `target_margin_pct` (additive — settings behaviour unchanged). This is the stub-fill path.

## Remaining — onboarding page UI (`app/onboarding/page.tsx`, ~547 lines)
Build as a **contained** change (gate step 0 behind a choice; keep the existing form intact) to avoid risking the critical signup flow:

1. **State:** `mode: 'choose' | 'form'` (default `'choose'`), `fortnoxConnected: boolean`, `legalInfo: { legal_name, org_number } | null`, `connecting`.
2. **Step 0 — `mode==='choose'`:** "How do you do your books?" → **[Connect Fortnox]** / **[Other / I'll enter manually]**.
   - *Connect Fortnox* → `connectFortnox()`: POST `/api/businesses/add` with a placeholder name (e.g. `'New restaurant'`) + `country: 'SE'` to get a stub `business_id`, then `window.location.href = /api/integrations/fortnox?action=connect&business_id=<id>&return_to=onboarding`.
   - *Manual* → `setMode('form')` (existing form, unchanged).
3. **Rehydrate on return** (mount effect): if `?fortnox=connected&business_id=X` → set `businessId`, `fortnoxConnected=true`, `mode='form'`; fetch the business identity (needs `legal_name, org_number, address, city, country` — confirm `/api/businesses` GET returns these, else add a small read), prefill `form` (restaurantName ← legal_name, address, city, country, orgNumber), set `legalInfo`, set `systems.accounting='Fortnox'`, then `history.replaceState` to clean the URL.
4. **Step 0 — `mode==='form'`:** existing restaurant form, PLUS when `fortnoxConnected`: a read-only "From Fortnox" panel showing **Legal name** + **Org-nr** (locked); hide the manual org-nr input; keep display name / address / city / stage / days / targets editable.
5. **`saveAndContinue`:** if `businessId` already exists (stub from connect) → POST `/api/businesses/update` (now supports all the fields) instead of `/api/businesses/add`. Manual path keeps using `/add`.
6. **Move the accounting selector** out of the Systems step (it's chosen in step 0 now). Staff/POS selectors stay.

### Edge cases to handle
- User cancels at Fortnox → callback error path currently redirects to `/integrations`; for onboarding, ideally back to `/onboarding?fortnox_error=1` (the error redirect is before state-verify, so this needs the state decoded in the error branch — minor follow-up; acceptable to leave as-is for v1).
- Stub left behind if user abandons after connect → the OnboardingGate already treats "has ≥1 business" as complete-ish; a placeholder-named stub is acceptable, and the next visit resumes. Consider a cleanup later.
- Re-entry / refresh mid-flow → rehydrate from the businesses row each load.

## Why this is the right shape
The data plumbing (company identity + backfill on connect) already existed; this is mostly a wizard reorder. Connecting first means org-nr/name/address are correct from Fortnox (the legal source of truth), the owner types less, and the 12-month backfill + inventory pipeline start at connect time instead of after the whole wizard — so data is flowing before they finish onboarding.
