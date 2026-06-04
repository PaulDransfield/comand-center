# CommandCenter — New Business Setup Guide

> Hand this to a Claude conversation if you want help walking through any of these steps. It's a self-contained operator manual: each step lists what you click, what you'll see, how long it takes, and what to do if it doesn't behave.

Last updated: 2026-06-04. Product live at https://comandcenter.se.

---

## What you need before you start

- [ ] **Org-nr (organisationsnummer)** — 10 digits, the registered Swedish company number for the new business.
- [ ] **A business email** for the primary owner login.
- [ ] **Fortnox login** for the business (admin role) — you'll OAuth from inside CommandCenter.
- [ ] **Personalkollen login** (if you use PK for staff) — same flow.
- [ ] **Last-year P&L PDF** if the restaurant has been trading for >1 year. Optional but it bootstraps forecasts.
- [ ] **A list of the dishes you sell** — menu text, PDF, Word doc, or photos. The bulk importer accepts all four.
- [ ] **The "opening days"** — which days of the week the restaurant trades.

---

## Step 1 — Create the account

1. Go to https://comandcenter.se and click **Get started** (or **Book a demo** if you don't have a plan yet).
2. Fill the signup form:
   - Email
   - Password
   - Full name
   - Organisation name (this is the legal-entity name, not the dish brand)
3. Check your inbox for the verification email. Click the link inside.
   - If it doesn't arrive within 2 min, check spam. Owner has a re-send affordance on the "check your inbox" screen.
4. The verification link drops you straight into onboarding.

---

## Step 2 — Onboarding wizard

The wizard is 3 steps now (Restaurant → Systems → Done). Aim for 5 minutes.

### Restaurant step
- **Address** — the trading address. Used for holiday + weather data.
- **Organisationsnummer** — 10 digits with a hyphen, e.g. `559123-4567`. Validated against the Swedish Luhn check; bad numbers are caught on the spot.
- **Business stage**:
  - `new` — under 1 year trading. The budget AI skips historical anchoring and uses industry benchmarks.
  - `established_1y` — 1–3 years. Anchored on last-year actuals + max 15 % stretch.
  - `established_3y` — 3+ years. Multi-year anchor.
- **Opening days** — tick Monday–Sunday for the days you trade. Used by scheduling AI + holiday view.
- **Cost targets** — your goals for food %, staff %, total cost %. Used by the budget AI as a "stretch" target rather than gospel.

### Systems step
- **Last-year P&L PDF** (optional, only if stage ≠ new). Drag it in. Claude parses it and seeds the forecast.
- You can skip this if you don't have it; the forecast just starts cold and warms over the first 30 days.

### Done step
Just a confirmation. Click **Go to dashboard**.

---

## Step 3 — Connect Fortnox

This is the most important integration and the one that takes longest in the background.

1. From the sidebar, go to **Integrations** → **Fortnox** card → **Connect**.
2. **Confirmation modal pops up first** — you'll see the business name + a tick-box confirmation. Make sure the business name shown is correct before clicking Continue (this prevents cross-tenant OAuth — see notes below).
3. Fortnox OAuth screen. **Log in as the customer's Fortnox admin**, not yourself.
4. **Approve the scopes**. You need ALL THREE for PDF access:
   - `archive`
   - `inbox`
   - `connectfile`
   - Plus the usual `supplierinvoice`, `voucher`, `companyinformation` etc.
   - **If you connected before with only the partial scope set, you must disconnect first and re-OAuth.** Fortnox doesn't grant new scopes on re-auth alone.
5. You're returned to CommandCenter. The Fortnox card should now show **Connected**.

### What happens next (you wait, in the background)
- The 12-month backfill worker kicks off. It fetches a year of supplier invoices + Resultatrapport PDFs.
- Expect this to take **30 min – 4 hours** depending on Fortnox API rate limits and how many invoices you have. (Vero had 1071 invoices and it took ~3 hours.)
- You'll see a sync banner at the top of CommandCenter while it runs. It auto-clears when done.
- When complete: `/financials/performance`, `/tracker`, `/overheads`, `/suppliers` all start showing real data.

### If something looks wrong
- **Stuck at "Connecting…"** on the OAuth callback → URL was missing `business_id`. Re-pick the business in the sidebar, try again.
- **`base64url` decoded mismatch** error → known browser-cache issue; close the tab, reopen, retry.
- **No PDFs showing** on suppliers/overheads even though invoices are listed → you connected without the `archive` + `inbox` + `connectfile` trio. Disconnect, reconnect.

---

## Step 4 — Connect Personalkollen (or another POS / staff system)

Same flow as Fortnox.

1. **Integrations** → **Personalkollen** → **Connect**.
2. The business-confirmation modal appears. Tick + Continue.
3. PK OAuth, log in as the customer's PK admin.
4. Returned to CommandCenter, **Connected**.

PK starts syncing immediately. The first sync pulls 90 days of staff logs + shifts; expect a few minutes.

If you DON'T use PK, the system also has connectors for Onslip, Ancon, and Swess for revenue-only data. Same pattern.

---

## Step 5 — Wait for the catalogue to build

After Fortnox is connected and the invoice backfill is partway through, the inventory pipeline starts populating the product catalogue automatically.

- `/inventory/items` will start filling up.
- The matcher classifies every supplier line into one of:
  - Auto-matched (exact or fuzzy) — green
  - Needs review — coral, lands in `/inventory/review`
  - Not inventory (rent / fees / cleaning) — filtered out
- The PDF extractor pulls product names from each invoice's attached PDF (Vero ended up with 374+ products this way).

**Don't touch anything yet.** Let it run for 2-4 hours.

---

## Step 6 — Work through the inventory review queue

Once the catalogue stops growing, go to `/inventory/review`.

- Each card shows a supplier line the matcher couldn't auto-classify.
- Pick the right product from the catalogue dropdown, or create a new one.
- The matcher learns from owner_confirmed decisions and gets better at similar lines next time.
- Use the "Skip ALL from supplier" button on any supplier that's NOT inventory (landlords, agency staff, software subscriptions etc.).

**Aim to drain the queue to under 50 items in your first session.** Lines stay in the queue forever until handled, so it doesn't have to be done in one go.

---

## Step 7 — Bulk-import recipes

Go to `/inventory/recipes` → **Bulk import**.

### Input formats (any of these)
- Paste menu text directly
- Upload a PDF menu
- Upload a Word doc (.docx, NOT .doc)
- Upload menu photos (vision-extracted)
- **Multiple files at once** — Sonnet processes them in one pass, cross-file sub-recipe references preserved.

### After "Draft recipes"
Sonnet returns drafts. **Duplicate detection runs automatically** — any draft that matches an existing recipe in your book by name gets:
- A coral banner: "Already in your recipe book — will be SKIPPED"
- A **Skip** checkbox (checked by default — uncheck to overwrite)
- The duplicate-check re-runs as you rename, so the banner clears when the collision breaks.

Review each draft:
- Name, type, portions, selling price (inc-VAT)
- Sub-recipes show a lavender SUB badge
- Sub-recipes can be defined once and referenced from parents (e.g. "Strawberry Compote" used in 3 desserts)
- Ingredients — each maps to a product in the catalogue OR a sub-recipe reference

Click **Create N recipes** when you're happy. Subs save first, then parents.

### Cost per draft
- ~$0.10 for text input
- ~$0.25–$0.50 with vision (PDF / image / Word)
- This counts against your daily AI quota — see Settings → AI usage.

---

## Step 8 — Tag sub-recipes correctly

If the bulk importer didn't catch a sub-recipe (e.g. you imported a "Whole Tiramisu Tray" as type=dessert), you can flip it manually.

1. Open the recipe.
2. In the header, next to the portion count, tick the **Sub-recipe** pill.
3. Save. It now appears in the Sub-recipes filter on the list and in the ingredient picker's sub-recipe tab.

This matters because:
- Dish-level margin metrics only roll up actual dishes (not subs)
- Other recipes can consume a sub-recipe by weight if the sub has a yield defined

---

## Step 9 — Add dish photos

1. Open a recipe. Top-left of the header you'll see a **+ Add photo** tile (or the existing photo).
2. Click → file picker → choose JPG/PNG/WebP/GIF (max 10 MB).
3. Photo appears immediately. Click again to replace. Small × removes.
4. Thumbnails surface on `/inventory/recipes` (the list), the prep list, and the order list.

---

## Step 10 — (Optional) Promote sub-recipes to the inventory catalogue

If you want a sub-recipe to be sellable as a single article (POS mapping), or you want to stock-count it as a distinct item:

1. Open the sub-recipe.
2. Click **Promote to inventory** in the header.
3. A catalogue product is created with `source_recipe_id` pointing back at the recipe. The cost is live-derived from the recipe — no manual sync needed.
4. The button changes to a non-actionable "In inventory" pill. Un-promote from the Connected sales articles section below if needed.

Renaming the recipe later auto-syncs the catalogue product's name. You don't need to "update" anything.

---

## Step 11 — Use the prep list

Daily kitchen workflow.

1. Go to **Prep list** (sidebar — top-level).
2. Enter expected covers for the service.
3. The system auto-fills per-dish portion shares from each recipe's `portions_per_cover` setting (set this on each recipe header).
4. Add pre-orders (party bookings) — they add on top of the share-driven covers.
5. Click **Start prep**. Lines are frozen at session start; in-service edits to recipes flow into text fields (method/notes) but quantities stay stable.
6. The kitchen ticks lines off as they prep. Modal opens on tap for editing.

Only one active session per business at a time.

---

## Step 12 — Use the order list

After prep is done, the order list aggregates what to buy.

1. Go to **Order list**.
2. Select the prep sessions + pre-orders to include.
3. **Build** generates a supplier-grouped shopping list with the **Needed** quantity per product.
4. The owner / chef writes the **Order qty** (free-form text — "2 jars", "10 kg") next to each line. This is intentionally loose — chef judgement on pack sizes.
5. **Copy for chat/email** per supplier packs the lines into plain text ready for WhatsApp / email.

No stock subtraction yet — that's Phase 2 work.

---

## Step 13 — Daily / weekly checks

These run automatically; you just look at them.

- `/dashboard` — KPIs for today, revenue forecast, attention panel for anomalies
- `/financials/performance` — Week/Month/Quarter view of revenue, food, labour, overheads, net margin
- `/tracker` — monthly P&L
- `/alerts` — anomalies (revenue drop, cost spike, late arrivals)
- `/scheduling/grid` — labour cost view + AI scheduling recommendations (Mondays)
- `/reviews` — Google reviews summary with 5-things-to-improve + 5-things-customers-love cards
- `/ai` — Ask CC: natural language Q&A against your business data

---

## Common gotchas

- **Fortnox PDFs don't appear** → you need the `archive` + `inbox` + `connectfile` scope trio. Re-OAuth.
- **Recipe page won't load after I added a column** → SQL migration not applied yet. Apply the relevant `sql/M125-...sql` file in Supabase SQL Editor.
- **"Already exists" on bulk import** → duplicate detection working as designed. Uncheck Skip to overwrite, or rename the draft.
- **Cost shows "Incomplete"** instead of GP % → one or more ingredients are missing prices OR have a unit mismatch (e.g. recipe wants "30 g of egg" but the product is sold per "st" without a weight-per-piece set). Open the recipe → fix the flagged ingredient.
- **A product was archived by mistake** → it'll show as missing in any recipe that uses it. Un-archive from `/inventory/items/[id]` or run `scripts/diag/repoint-dedup-orphans.mjs` if it was a dedup over-merge.
- **Onboarding stuck at /upgrade** → OnboardingGate runs BEFORE PlanGate. If you see /upgrade and haven't finished onboarding, navigate to /onboarding manually.

---

## If you want Claude to walk you through

Paste this whole document into a Claude chat with a prompt like:

> I'm onboarding a new restaurant into CommandCenter today. Walk me through the steps from the attached guide. Stop after each step and let me confirm before moving to the next. I'll tell you which point I'm at right now.

Claude will use the document as a script and keep you on track.

---

## Reference info

- Live URL: https://comandcenter.se
- Supabase project: https://llzmixkrysduztsvmfzi.supabase.co
- Support email: hello@comandcenter.se
- Owner: Paul Dransfield
