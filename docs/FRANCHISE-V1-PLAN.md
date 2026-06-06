# Franchise v1 — Spec + plan

> 2026-06-06. Decisions captured during the Session 25 brainstorm with Paul.
> No code yet. Pre-implementation reference for the build when it's
> commissioned. Triggers and open items at the end.

## 1. What v1 ships

A franchise tier on the CommandCenter platform that lets a franchisor
(Chicce HQ) maintain a canonical recipe book, clone it into franchisee
locations, lock the recipe structure so franchisees can't change what the
customer eats, and see chain-wide food-cost performance — while
franchisees still own their local prices, suppliers, P&L, staff,
scheduling, and cash.

**Concretely v1 lets the franchisor:**

- Maintain master recipes (ingredients, quantities, method, portions,
  yield) in their existing CommandCenter org.
- Draft → publish → stage-roll-out to selected franchisees (test a new
  dish at 2 locations before chain rollout).
- See a chain dashboard with per-franchisee KPI strips and a
  recipe-variance tab that flags outliers (e.g. one franchisee's
  Mozzarella costs 30% more than the rest).
- Set the menu price chain-wide, with an opt-in per-franchisee flag that
  delegates price control to a specific trusted franchisee.

**And lets a franchisee:**

- Accept an invite and have the master recipe book cloned into their
  catalogue automatically.
- Run their own business normally — invoices, prices, P&L, scheduling,
  cash — without any sharing back to HQ except aggregated food-cost
  performance.
- Edit anything that's not structure-locked (price if delegated, supplier
  mapping always, per-recipe notes, sub-recipe yields for local
  cooking-reduction).
- See "Master updated this recipe" notifications when HQ publishes
  changes.

**v1 does NOT ship (deferred to v2 unless flagged):**

- Audit/version history of master changes (v1 just stamps `updated_at`)
- Ingredient-spec abstraction layer (becomes load-bearing at ~10+
  franchisees; the M130 `recipe_import_draft` mechanism handles v1)
- Region/group layer for multi-region chains
- Multi-brand under one franchisor
- Localisation / translation of master recipes
- Bottom-up "I improved this recipe" promotion flow
- Self-serve invite codes (v1 = email invite + support hand-holding)

---

## 2. Decision matrix (the pinned answers)

| Question | Decision | Why |
|---|---|---|
| Lock level | **Structure-locked** | Ingredients / qty / method / portions / yield = read-only at franchisee. Price + supplier mapping + per-recipe notes = editable. Customer experience stays consistent; local economics stay local. |
| Direction | **Top-down only** | HQ creates and edits master recipes. Franchisees consume. v2 considers bottom-up. |
| Menu price ownership | **Franchisor by default, per-franchisee override flag** | HQ sets price chain-wide. Specific trusted franchisees can be granted independent price control via a whole-franchisee flag (Slottsgatan = trusted, Gothenburg = locked). |
| Mix share (`portions_per_cover`) | **HQ default + franchisee override** | HQ seeds it at clone time. Franchisee can tune for local market patterns (Stockholm over-indexes pasta, Gothenburg over-indexes pizza). |
| HQ visibility | **Recipe-level variance, aggregated only** | HQ sees food cost % per recipe per franchisee + can flag outliers. No raw supplier invoices, no per-supplier prices. "Consistency without surveillance." |
| Update flow | **Publish-first with staged rollout** | HQ tweaks in draft, hits Publish, selects which franchisees get it. Enables test-rollout to N locations before chain-wide. Same mechanism for "stage to 2 then everyone" and "publish to everyone now." |
| Org model | **Cross-org** | Chicce stays as its own org (becomes the franchisor org). Future franchisees are separate orgs linked via `organisations.parent_org_id`. Separate Stripe subs. Separate auth. Each franchisee can leave the network without losing their data. |
| Billing | **Separate independent subscriptions** | HQ pays Franchisor tier (full scope). Each franchisee pays their own Franchisee tier (similar to Solo, slightly more). Two pricing tiers added to Stripe. |
| Brand scoping | **Single brand per franchisor (v1)** | No multi-brand layer below the franchisor org. Out of scope until proven need. |
| Franchisee scale horizon | **2 in the v1 window** | Approach 1 (clone products by name, M130 placeholder for misses) is plenty. Ingredient spec layer becomes load-bearing at ~10+; deferred. |
| Invite mechanism | **Email invite + support-driven** | HQ enters franchisee's email, system sends invite link, franchisee accepts. Support hand-holds the first 2-3 onboardings. Self-serve invite codes deferred until the playbook is proven. |
| Chain dashboard primary view | **Franchisee-first** | Landing tab = list of franchisees with per-location KPI strips (food % / GP / revenue / labour). Click into one → see their dashboard read-only. Recipe-variance grid is a secondary tab. |

---

## 3. Org / billing model

### 3.1 Org structure

- `organisations.parent_org_id UUID NULL REFERENCES organisations(id)` — set on franchisee orgs; points to the franchisor org.
- `organisations.franchise_role TEXT NULL CHECK (franchise_role IN ('franchisor', 'franchisee'))` — NULL = standalone Solo/Group/Chain customer (the existing model, unchanged).
- An org's `franchise_role` is a stable property — Chicce is a franchisor; Slottsgatan-as-franchisee (if it ever becomes one separately) would be a franchisee.

**Chicce-specific note:** Chicce keeps its existing org and gets
`franchise_role = 'franchisor'` set when the feature ships. Slottsgatan
the business stays inside Chicce's org as the franchisor's own restaurant
location. Future franchisees (Gothenburg etc.) sign up as separate orgs
that link via `parent_org_id` and accept the franchise agreement.

### 3.2 Stripe wiring

- **Franchisor tier** — new product / price in Stripe. Higher than Chain.
  Per CLAUDE.md the existing tiers are Solo 1,995 / Group 4,995 / Chain
  9,995. Franchisor probably ~14,995–19,995 monthly; pin during pricing
  page review.
- **Franchisee tier** — new product / price. Similar to Solo with a small
  uplift (~2,495–2,995 monthly). Pin during pricing review.
- Each franchisee org is its own Stripe customer. Independent invoicing,
  card, billing cycle. Franchisor doesn't see franchisee invoices.
- `organisation_members` continues to gate access per org. A franchisor
  employee added to a franchisee org would have to be invited separately
  (no implicit cross-org access for v1 — the chain dashboard reads
  aggregate stats via a server-side helper that bypasses RLS for the
  parent-org owner specifically).

### 3.3 Franchise agreement layer (legal — NOT optional for v1)

Sweden's Franchise Disclosure Act 2006 means the franchisee accepting the
invite is implicitly accepting the franchisor's recipe-IP licensing
terms. Easiest implementation:

- Stored agreement text on `organisations.franchise_agreement_md` at the
  franchisor org level (markdown, ~1 page boilerplate).
- Tickbox at invite acceptance time.
- Stamp `organisations.franchise_agreement_accepted_at` on the franchisee
  org when ticked.
- Franchisor can update the agreement text — franchisees see a
  "re-confirm agreement" prompt on next sign-in.

---

## 4. Schema diff (additive — non-destructive)

All idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).

### 4.1 `organisations` (existing table — additive columns)

```sql
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS parent_org_id UUID REFERENCES organisations(id),
  ADD COLUMN IF NOT EXISTS franchise_role TEXT,
  ADD COLUMN IF NOT EXISTS franchise_agreement_md TEXT,
  ADD COLUMN IF NOT EXISTS franchise_agreement_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS franchisee_price_override_allowed BOOLEAN NOT NULL DEFAULT false;
-- franchisee_price_override_allowed = whole-franchisee flag (per the
-- "Slottsgatan trusted, Gothenburg locked" decision). When TRUE,
-- franchisee can edit menu_price; when FALSE, price is locked top-down.

ALTER TABLE organisations
  ADD CONSTRAINT organisations_franchise_role_chk
  CHECK (franchise_role IS NULL OR franchise_role IN ('franchisor', 'franchisee'));
```

### 4.2 `recipes` (existing table — additive columns)

```sql
ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS source_recipe_id UUID REFERENCES recipes(id),
  -- Already used by sub-recipes; semantics extended: also the link from
  -- a franchisee-cloned recipe to its master.
  ADD COLUMN IF NOT EXISTS structure_locked_at TIMESTAMPTZ,
  -- NULL = unlocked. NOT NULL = structural fields read-only at franchisee.
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  -- NULL = draft (HQ-only, not visible at franchisees yet).
  -- Set when HQ hits Publish.
  ADD COLUMN IF NOT EXISTS published_to_business_ids UUID[];
  -- NULL = all linked franchisees. Array = staged rollout (just these
  -- franchisees see it). Matches the publish-first decision.
```

### 4.3 New table — recipe publish log

```sql
CREATE TABLE IF NOT EXISTS recipe_publish_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_recipe_id  UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  franchisor_org_id UUID NOT NULL REFERENCES organisations(id),
  published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by      UUID,                       -- auth.users id
  target_franchisee_business_ids UUID[],        -- NULL = all linked
  change_summary    TEXT,                       -- HQ-typed "what changed"
  recipe_snapshot   JSONB NOT NULL              -- full recipe state at publish
);
CREATE INDEX recipe_publish_log_master_idx ON recipe_publish_log (master_recipe_id, published_at DESC);
```

**Purpose:** every Publish action snapshots the master recipe state +
records who received it. Powers the "what changed?" diff at franchisee +
the franchisor's own audit trail. Storing `recipe_snapshot` as JSONB
means we can show franchisees a clean diff without needing a full
versioning system in v1.

### 4.4 New table — recipe variance cache (chain dashboard)

```sql
CREATE TABLE IF NOT EXISTS recipe_variance_cache (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_recipe_id         UUID NOT NULL REFERENCES recipes(id),
  franchisee_business_id   UUID NOT NULL REFERENCES businesses(id),
  food_cost_sek            NUMERIC,
  food_cost_pct            NUMERIC,
  gp_pct                   NUMERIC,
  variance_vs_chain_avg    NUMERIC,             -- (this − avg) / avg
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (master_recipe_id, franchisee_business_id)
);
CREATE INDEX recipe_variance_master_idx ON recipe_variance_cache (master_recipe_id);
CREATE INDEX recipe_variance_franchisee_idx ON recipe_variance_cache (franchisee_business_id);
```

**Purpose:** the chain dashboard's recipe-variance tab reads this table.
Computed by a daily cron (proposed `recipe-variance-refresh`, 04:00 UTC)
that recomputes food cost % per recipe per franchisee using the existing
cost engine. Cached so HQ's dashboard loads fast.

### 4.5 RLS additions (the structural lock enforcement)

Existing `recipes_org_isolation` policy: `org_id = ANY(current_user_org_ids())`.

Add a structural-fields-write policy:

```sql
CREATE POLICY recipes_structural_lock ON recipes
  FOR UPDATE
  USING (
    -- Caller can read any recipe their org owns (existing pattern).
    org_id = ANY(current_user_org_ids())
  )
  WITH CHECK (
    -- Can write structural fields only if:
    --   (a) recipe is not locked, OR
    --   (b) caller's org is the franchisor (matches source_recipe_id's owner).
    structure_locked_at IS NULL
    OR org_id IN (
      SELECT id FROM organisations
      WHERE franchise_role = 'franchisor'
        AND id = ANY(current_user_org_ids())
    )
  );
```

API endpoints (PATCH `/api/inventory/recipes/[id]`,
`/api/inventory/recipes/[id]/ingredients/...`) also enforce the lock at
the application layer — defence in depth. The lock applies to:
`name`, `type`, `portions`, `yield_amount`, `yield_unit`, `method`,
`is_subrecipe`, plus `recipe_ingredients` writes for that recipe.

The lock does NOT apply to: `menu_price` / `selling_price_ex_vat` (gated
separately by `franchisee_price_override_allowed`), `notes`,
`portions_per_cover` (franchisee-overridable per the mix-share decision),
`image_url`, supplier-mapping fields on `recipe_ingredients` (none today
— mappings live on `product_aliases` which is per-business already).

---

## 5. API surface (additions + modifications)

### 5.1 New endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/franchise/invite` | Franchisor invites a franchisee by email. Generates a signed invite token + sends email via Resend. |
| `POST` | `/api/franchise/accept` | Franchisee accepts invite (tickbox the agreement, link `parent_org_id`). |
| `POST` | `/api/franchise/recipes/[id]/publish` | HQ publishes a master recipe to specified franchisees (or all). Clones into target franchisees' businesses, writes `recipe_publish_log` snapshot, sends in-app notifications. |
| `POST` | `/api/franchise/recipes/[id]/unpublish` | HQ retires a master recipe — archives at all franchisees. |
| `GET` | `/api/franchise/dashboard` | Franchisor's chain dashboard data: per-franchisee KPI strip + recipe-variance roll-up. |
| `GET` | `/api/franchise/dashboard/recipe-variance` | Recipe-variance tab data (reads `recipe_variance_cache`). |
| `GET` | `/api/franchise/notifications` | Franchisee sees pending master-recipe updates with diffs. |

### 5.2 Modified endpoints

| Endpoint | Change |
|---|---|
| `PATCH /api/inventory/recipes/[id]` | Enforces structural lock at app layer; rejects field writes when caller's org isn't the franchisor and the recipe is `structure_locked_at IS NOT NULL`. Honest 403 with which field is locked. |
| `PATCH /api/inventory/recipes/[id]/ingredients/[ingId]` | Same gate. |
| `POST /api/inventory/recipes` | Franchisee creating a non-source recipe = allowed (their own private dish). Tagged with `source_recipe_id = NULL` so it's clearly distinguishable from a master clone. |

### 5.3 New cron

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/recipe-variance-refresh` | `0 4 * * *` (daily) | Recomputes `recipe_variance_cache` per master recipe per franchisee using the existing cost engine + each franchisee's latest prices. Mirrors the supplier-price-creep + forecast-calibration cron pattern. |

---

## 6. UI surfaces

### 6.1 HQ (franchisor) — new + modified screens

**`/franchise/network` — chain dashboard (new)**
- Landing tab: **Franchisees** — list of franchisee businesses with
  per-location KPI strips: food cost %, GP %, revenue (current month),
  labour %, +/- vs chain avg. Click into one → that franchisee's
  existing dashboard rendered read-only.
- Secondary tab: **Recipe variance** — table of master recipes. For each
  recipe: cost % at each franchisee, variance vs chain avg, outliers
  flagged coral. Click into a recipe → side-by-side per-franchisee
  ingredient-by-ingredient comparison (where it diverges + by how much).
- Tertiary tab: **Network** — invite a new franchisee form (email +
  agreement preview).

**`/inventory/recipes` (existing — modified)**
- Adds a "Master" / "My recipes" / "All" filter pill row at the top for
  HQ. Master recipes get a small "MASTER" lavender pill.
- Recipe drawer has a "Publish" panel at the top: draft state, lock
  status, target-franchisees picker, Publish button.

### 6.2 Franchisee — new + modified screens

**Recipe list (`/inventory/recipes`) — modified**
- Master-derived recipes get a small "MASTER" coral pill so chef knows
  they can't change the structure. Hovering / tapping the pill shows a
  tooltip: "Locked by Chicce HQ. Notify HQ to request a change."
- Editable fields are visually distinguishable (lavender focus ring on
  inputs that ARE editable; the rest are read-only labels).

**Recipe drawer — modified**
- Locked sections display the value with a small lock icon.
- A "View change history" link surfaces the `recipe_publish_log`
  entries for that recipe (timestamps + change summary text from HQ).

**`/franchise/inbox` — notification surface (new — small)**
- Lists pending master updates with diffs and an "Acknowledge" button.
- For locked recipes, updates auto-apply; this is informational ("HQ
  updated the Margherita — Mozzarella from 300g to 280g").
- If HQ marks a recipe as "delegated for price" — the franchisee sees an
  unlock event here.

### 6.3 Onboarding for new franchisees

A modal at first sign-in after accepting invite:
1. Welcome + franchise agreement re-confirm
2. "We're copying Chicce HQ's recipe book into your catalogue. This may
   take a moment." Progress: N of M recipes cloned, K products linked, L
   placeholders created (M130 path).
3. "Done. Your kitchen tablet is ready."

---

## 7. The clone flow (mechanics)

When `POST /api/franchise/recipes/[id]/publish` fires for a target
franchisee:

1. **Snapshot master.** Read master recipe + all its
   `recipe_ingredients` + the recipes referenced via `subrecipe_id`
   (sub-recipes cascade).
2. **Mirror into franchisee's business.**
   - INSERT into `recipes` (franchisee's `business_id`, `org_id`) with
     `source_recipe_id = master.id`, `structure_locked_at = NOW()`,
     `menu_price = master.menu_price`, `portions_per_cover = master.portions_per_cover`.
   - For each ingredient: try to match the master's
     `recipe_ingredients.product_id` (name + unit) against the
     franchisee's catalogue.
     - **Match found** → use that product_id.
     - **No match** → create a product in franchisee's catalogue with
       `created_via = 'recipe_import_draft'` (M130). The matcher will
       pair it to a real article when an invoice arrives.
3. **Sub-recipes first.** If the master recipe references sub-recipes,
   recursively clone those before the parent so `subrecipe_id` resolves.
4. **Log the publish event.** Insert into `recipe_publish_log`.
5. **Notify.** Insert an in-app notification record (existing or new
   notification system — TBD; the in-app banner / `/franchise/inbox`
   tab).

### Subsequent master edits

When HQ edits a master recipe + re-publishes:

- Recipe is structure-locked at the franchisee → ingredients/quantities/
  method update IN PLACE at the franchisee. Notification banner: "HQ
  updated this recipe."
- Recipe is unlocked at the franchisee (rare in v1 — only happens if
  franchisee explicitly forked) → notification "HQ updated this. View
  changes / Accept / Decline."
- Recipe is structure-locked AND franchisee has
  `franchisee_price_override_allowed = false` → `menu_price` updates too.
- Franchisee has `franchisee_price_override_allowed = true` → master
  edit updates everything EXCEPT menu_price.

### Master archive

HQ archives a master recipe → archive at all franchisees automatically.
Show a "Retired by HQ" banner.

---

## 8. Chain dashboard — what HQ actually sees

### 8.1 Franchisees tab (landing)

Stack of cards, one per franchisee:

```
┌──────────────────────────────────────────────────────────────┐
│ Chicce Gothenburg                                            │
│ Food cost: 28.4%   GP: 71.6%   Revenue MTD: 245,000 kr      │
│ Labour: 32.1%      Margin: 12.3%                             │
│ ├─ -2.1pp vs chain avg food cost ✓                           │
│ └─ Click for details →                                       │
└──────────────────────────────────────────────────────────────┘
```

Click into one → render the franchisee's own `/dashboard` route in a
read-only mode (banner: "Read-only view of Chicce Gothenburg as HQ").

### 8.2 Recipe variance tab

Table:

| Master recipe | Slottsgatan | Gothenburg | Stockholm | Chain avg | Worst variance |
|---|---|---|---|---|---|
| Margherita | 28.1% | 27.9% | 32.4% ⚠ | 29.5% | **+9.8% at Stockholm** |
| Pinsa Chevre | 31.0% | 30.5% | 30.8% | 30.7% | within 1% |
| Carpaccio | 36.2% ⚠ | 28.1% | 27.4% | 30.6% | **+18% at Slottsgatan** |

Click into Margherita → ingredient-by-ingredient breakdown showing where
each franchisee's cost differs. Coral highlight on the line item driving
the variance. Action affordance: "Investigate with Slottsgatan" or
similar — opens a pre-filled email / notification to that franchisee.

---

## 9. Edge cases handled in v1

| Case | v1 behaviour |
|---|---|
| Franchisee leaves the network | Recipes stay (they paid for the data). `structure_locked_at` is cleared automatically so they can edit. `source_recipe_id` is preserved for audit but `parent_org_id` is nulled. |
| Master archives a recipe | All franchisee copies auto-archive. Coral "Retired by HQ" banner. Existing recipe history is preserved. |
| New franchisee has existing CommandCenter recipes (unlikely in v1) | Existing recipes stay. Master clone process auto-handles name collisions by suffixing the franchisee's existing one with "(local)". |
| Sub-recipe sharing | Sub-recipes cascade with parent at clone time + edit time. Locking the parent locks the sub. |
| HQ accidentally publishes mid-edit | Publish-first flow protects this — drafts aren't visible at franchisees until Publish is clicked. |
| Two franchisor staff edit master simultaneously | Last-write-wins on the master draft (same as recipes today). The Publish snapshot is atomic. |
| Franchisee tries to edit a locked field | API returns 403 with the field name. UI disables the input + shows the lock icon. RLS as defence-in-depth. |
| HQ revokes `franchisee_price_override_allowed` for a franchisee | On next publish, that franchisee's `menu_price` updates to master's value. No retroactive overwrite of historical sales data. |

---

## 10. What's deferred to v2 (mentioned for completeness)

- **Audit / version history of master changes.** v1 has `recipe_publish_log` snapshots; v2 would add a per-field change log + rollback.
- **Ingredient spec layer.** Becomes load-bearing at ~10+ franchisees when "update Mozzarella spec across all franchisees" needs to be one action instead of N. The M130 approach is fine at 2–3.
- **Region / group layer.** Multi-region chains where some recipes only apply to certain regions.
- **Multi-brand.** A franchisor running Chicce + a steakhouse concept + a cocktail bar under one org.
- **Localisation.** Recipe name / method auto-translation when franchisees are in different language markets.
- **Bottom-up improvement promotion.** Franchisee develops a better variant → can propose it back to HQ → HQ promotes to master.
- **Cross-franchisee benchmarking dashboards beyond food cost.** Labour, scheduling, retention, customer reviews.

---

## 11. Triggers — when to start building

The v1 build only kicks off when at least one of:

1. **A second Chicce location is signing a franchise agreement** and the
   owner wants the platform to be ready to support them on day 1.
2. **A non-Chicce franchise operator** signals interest in CommandCenter
   as a chain tool, indicating the feature has demand beyond Chicce.
3. **Paul explicitly commissions the build** for sales/positioning
   reasons (e.g. landing-page tier story needs the Franchisor tier live).

Until then, this doc is the reference. Updates to this doc are welcome
(refining decisions, adding edge cases as they're noticed) without
triggering a build.

---

## 12. Open items requiring a position before build

- **Franchisor / Franchisee tier pricing** — confirm with the pricing
  page sweep.
- **In-app notification system shape** — there's no existing generic
  notifications infra in the platform; the `/franchise/inbox` tab would
  be the first. Could either build a generic notifications table for
  reuse or piggyback on banner display patterns. Decide before build.
- **Email templating for invites** — Resend already wires the
  transactional email pipeline; the invite + acceptance notification
  templates need design.
- **The franchise agreement boilerplate text** — Paul drafts in
  consultation with legal counsel before any v1 onboarding.

---

## 13. Acceptance criteria for v1 ship

- Chicce can publish a recipe to a hypothetical "Chicce Gothenburg"
  franchisee org and the recipe arrives in their kitchen tablet's recipe
  list within seconds.
- Editing a locked field at the franchisee returns a 403 with which
  field is locked. UI shows a lock icon.
- Editing the structure at HQ + re-publishing updates the franchisee
  copy in place + surfaces a banner notification.
- The chain dashboard shows two franchisee KPI strips that match what
  each franchisee sees on their own dashboard.
- Recipe variance tab shows at least one master recipe with per-
  franchisee food cost %.
- New franchisee onboarding clones the master recipe book + creates
  M130 placeholder products for anything the franchisee's catalogue
  doesn't already have.
- Franchisee invoices flowing in via Fortnox subsequently pair to the
  M130 placeholders via the existing matcher.
- Both pricing tiers are live in Stripe; new sign-ups can pick them.
- Franchise agreement ticking is captured at `organisations.franchise_agreement_accepted_at`.

---

*Source decisions captured 2026-06-06. Brainstorm trail in session
chat history. Schema diff additive throughout — applying this spec
doesn't break standalone Solo / Group / Chain customers.*
