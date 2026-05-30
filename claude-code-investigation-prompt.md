# Claude Code — Investigation Prompt (READ-ONLY reconnaissance)

## What this is

Before we implement a set of new subsystems (invoice extraction & learning, inventory categorization, recipe costing, production logging, prep lists, waste trending), I need a precise map of the **current live system**. This task is **investigation only**. You will produce a written report. You will not change anything.

## HARD RULES — read carefully

The app is **in production and actively used by paying customers**. Therefore:

- **Read-only. Build nothing, propose nothing, fix nothing.** No code changes, no refactors, no "while I'm here" improvements.
- **No database mutations.** No migrations, no `INSERT/UPDATE/DELETE/ALTER/DROP`, no seed scripts, no schema changes.
- **Prefer the repo as the source of truth.** Read migration files, ORM/schema definitions, generated Supabase types, and application code rather than querying the production database. If you believe a live query is genuinely necessary, **stop and list the exact read-only query for human approval first** — do not run it.
- **No deploys, no branch pushes, no package installs.** A scratch branch for notes is fine; do not push.
- **If something is unknown or you can't find it, say "not found" — do not guess or infer.** A precise "not found" is more useful than a plausible assumption.
- Deliverable is **one Markdown report** (path below). Do not start designing the new system.

## Deliverable

Write `docs/investigation/current-state-report.md` with one section per numbered area below, in the same order. For schema, give **exact** table names, column names, types, nullability, foreign keys, indexes, and any RLS policies — copied from the migrations/schema, not paraphrased. For code, cite **file paths** and short relevant snippets. End with two sections: **"Surprises / risks / inconsistencies"** and **"Questions I couldn't answer from the codebase."**

---

## Investigation areas

### 1. Repo & stack orientation
- Top-level directory layout (app routes, `lib/`, API handlers, background jobs, migrations).
- Confirm framework/stack versions actually in use (Next.js, TypeScript, Supabase client, etc.).
- How migrations are defined and applied (tool, naming convention — e.g. the `M0xx` scheme — and where they live).
- The current AI model identifiers actually referenced in code (exact model strings), and where prompts/model routing live.

### 2. Multi-tenancy & franchise model
This is the most important section. The new work assumes a shared cross-customer layer plus per-customer (and per-location) data.
- How are **customers / tenants** represented? (column like `customer_id`/`tenant_id`, separate schemas, or otherwise.)
- Is there any concept of a **group → location** hierarchy (for franchises) today? If so, exact tables/columns.
- How is tenant isolation enforced — **RLS policies**? List them for the relevant tables.
- Is there **any** table today that is intentionally shared across all tenants? If so, which and how is it protected?

### 3. Invoice ingestion & extraction pipeline (current)
- Where the PDF pull from Fortnox happens and how invoices arrive.
- The **pdfplumber → structure-detection → extraction** flow: file paths, which models, and the **exact JSON schema** the extractor currently emits (paste it).
- The current **server-side validation checks** — list each one.
- Idempotency: is there a uniqueness key on invoices (e.g. Fortnox invoice id per tenant)? How are re-pulls/duplicates handled today?

### 4. Categorization (current) — the thing we're replacing
- Exactly how line items get categorized now, and how the **"other" / unresolved bucket** works.
- When a human **manually re-sorts** an item, **where (if anywhere) is that correction written**? Is it persisted at all, or lost?
- Is there any existing **alias / mapping / supplier-nomenclature** table? Any learning/feedback mechanism? (We believe there is none — confirm.)
- Is the category taxonomy **fixed or free-form**, and is it **per-tenant or shared**? Exact tables.

### 5. Fortnox integration surface
- What is actually pulled today: invoices only, or also **bookings (account + VAT code per line)**, the **chart of accounts (BAS)**, Resultatrapport? List each.
- Critically: **is the existing Fortnox booking (BAS account + VAT) captured per invoice line anywhere?** (Build step 1 of the new design depends on this.)
- Sync mechanism (REST polling, webhooks, cron), cadence, and where OAuth tokens/credentials are stored.

### 6. Inventory & articles (current)
- Tables for articles/inventory: exact columns, especially **unit**, **current cost**, currency, and how cost is sourced (latest invoice? average?).
- Are **units normalized** at all today (kg/L/pcs), or stored as raw invoice text?
- Is there any **supplier** table, and how are suppliers identified (org-nr, free text)? Any handling of **multiple legal entities** per supplier?

### 7. Recipes (current)
- Recipe tables: structure, ingredient lines, how an ingredient links to an article.
- Is there **recipe composition** (a recipe inside a recipe)? **Waste %** per line? **Selling price / margin** fields? **VAT** on sell price?
- Any **franchise/location variant** concept (master vs per-location), or single-tenant only?
- Any **versioning / created-at snapshot** of recipe cost?

### 8. Tax / VAT / currency (current)
- Are **VAT rates / tax codes** stored per line today? Where?
- **Is any food VAT rate hard-coded anywhere** (search for `0.12` / `12` / `0.06` / `6` in tax context)? Flag every location — this matters because of the temporary 6% food rate.
- Are **BAS account codes** stored on lines?
- Is anything **multi-currency** today (currency field, FX rate storage), or SEK-only?

### 9. Background jobs & scheduling
- What mechanism exists for scheduled/batch work (Vercel Cron, Supabase scheduled functions, edge functions, a queue)? 
- List any jobs that run today and where they're defined. (The new design needs nightly/weekly batch jobs.)
- Any existing **embedding / vector** usage (pgvector, etc.)? We may need it for retrieval.

### 10. Photo capture, storage & mobile surface
- Is there a **mobile app or responsive surface** today, and any existing **photo/file upload**? 
- Where are uploads stored (Supabase Storage buckets, region)? Any existing image-handling code?

### 11. Existing UI patterns to match
- Any existing **review queue, alerts feed, or approval workflow** UI we should reuse rather than reinvent.
- Where design tokens live (confirm `lib/constants/tokens.ts`, `colors.ts`) and the inline-style convention.

### 12. Known data-quality issues
- Confirm/locate the known issues: the `opening_days` column not read by forecasters, and the pre-`M047` `tracker_data` rows with null `created_via`. Note any other dangling/nullable audit columns or partial migrations you encounter.

---

## Output reminder

One file: `docs/investigation/current-state-report.md`. Exact names and paths, not paraphrase. "Not found" where unknown. **No design, no code, no changes** — reconnaissance only. When done, summarize in chat: the 5 things most likely to force a change in our planned design, and the riskiest unknown.
