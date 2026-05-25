# Inventory Pipeline — the routine from "connect Fortnox" to "catalogue + recipes"

> The seamless, repeatable path so onboarding a new customer's inventory needs
> **zero manual debugging**. Written 2026-05-25 after the Vero shake-out.
>
> Companion: INVENTORY-PATH-B-PDF-EXTRACTION.md (extraction internals),
> project memory `project_vero_invoices_no_line_text`, ONBOARDING-CONCIERGE-PLAN.md.

---

## 0. The one truth that drives the whole design

**Fortnox supplier invoices store the bookkeeping rows (account + amount) in the
API — NOT the product line items.** The actual articles live on the **attached
PDF**. So for most customers the API import produces invoice lines with **empty
descriptions**, and the catalogue is built by **reading the PDFs** (vision), not
from the API rows. This is the normal case, not an edge case. (Chicce + Vero both.)

If you ever see "catalogue empty / 0 products" with invoices imported, the
question is **"has PDF extraction run against these lines yet?"** — not "is the
data missing."

---

## 1. The pipeline (ordered — order is load-bearing)

```
Connect Fortnox (OAuth, PDF scopes: archive + inbox + connectfile)
   │
   ▼
1. LINE BACKFILL        /api/inventory/lines/backfill → lib/inventory/backfill-worker.ts
   · pulls supplier invoices (default 4 months), writes supplier_invoice_lines
   · most lines have empty raw_description (API has no item text)
   · self-chains across the 800s cap (cursor in inventory_backfill_state)
   │  on COMPLETION ──┐
   ▼                  │ triggerPdfExtraction(businessId)
2. PDF EXTRACTION      /api/cron/inventory-pdf-extract-business → lib/inventory/pdf-extraction-worker.ts
   · findCandidates = invoices with an empty-description line, not yet terminal
   · fetches each invoice's PDF (FileConnections) → Sonnet vision → real line items
   · writes invoice_pdf_extractions rows (extracted / needs_review / no_pdf / failed)
   · runs ~50-60 invoices per ~13-min run, then leaves status; re-kicked by the sweep
   │  on COMPLETION ──┐
   ▼                  │ kickCatalogueAutobuild(businessId) + kickMatcher(...)
3. CATALOGUE AUTO-BUILD /api/admin/onboard/catalogue-autobuild (cron-callable, self-chaining)
   · Haiku classifies the now-described needs_review lines into
     create_new / approve_existing / skip_non_inventory / review
   · applies confidence ≥0.65 non-review → CREATES products + aliases, links lines
   · self-chains chunk-by-chunk (cron) until the catalogue is built
   │
   ▼
4. MATCHER (ongoing)   /api/cron/inventory-lines-sync (daily) + inventory-rematch-business
   · new invoices auto-match to existing products/aliases (no AI needed)
   · only NEW/unknown items fall to review
   │
   ▼
5. RECIPES (owner/AI)  /api/admin/onboard/recipes-draft (Phase 3) + manual
   · Sonnet drafts ingredient lists from the catalogue per POS menu item
```

**Why order matters:** PDF extraction must run AFTER the line backfill writes the
lines, and catalogue auto-build must run AFTER extraction fills the descriptions.
The original Vero bug was extraction firing at connect-time *before* the lines
existed → 0 candidates → marked done → never retried → empty catalogue.

---

## 2. System rules (invariants — don't break these)

1. **Extraction is triggered by line-backfill COMPLETION, not at connect-time.**
   `runInventoryBackfill` calls `triggerPdfExtraction()` after `complete()`. Do
   NOT move PDF extraction earlier or run it concurrently with the backfill.

2. **Catalogue auto-build is triggered by extraction COMPLETION.**
   `runWithAutoChain`'s done-branch calls `kickCatalogueAutobuild()`. The matcher
   only LINKS to existing products; auto-build is what CREATES them from
   descriptions. Both fire on completion.

3. **Two safety nets, both idempotent:**
   - `inventory-pdf-extract-sweep` (every 30 min, 06–22 UTC) kicks every business
     with invoice lines — re-drives extraction if a trigger dropped.
   - Catalogue auto-build self-chains (cron, `chain` counter, MAX_CHAIN=20) until
     no hop classifies or applies anything.
   `findCandidates` skips terminal invoices, so re-runs are cheap no-ops.

4. **PDF scopes are mandatory.** The Fortnox connection needs `archive` + `inbox`
   + `connectfile` to fetch files. Without them: metadata only, no PDFs. Symptom:
   extractions all `no_pdf`/`lookup_failed` despite attachments existing in
   Fortnox. Fix: re-OAuth with the scopes (see `reference_fortnox_scopes`).

5. **The suggestions cache must persist** (`inventory_review_suggestions`). Write
   it with delete-then-insert, NEVER `.upsert({ onConflict })` — the unique index
   is partial in prod and PostgREST rejects it (the error is swallowed → silent
   cache failure → auto-build loops). See `feedback_postgrest_upsert_partial_indexes`.

6. **Apply from the in-memory classifier result**, not only a cache re-read — so a
   cache hiccup can't make auto-build apply nothing.

6b. **Auto-build does ONE bounded chunk (~80 groups) per invocation.** The Haiku
   prompt grows with the catalogue (products + aliases as context), so a bigger
   batch can blow the 300s function cap (it did on Vero: `FUNCTION_INVOCATION_TIMEOUT`).
   The cron self-chain / board chaining drains the rest one chunk at a time. Don't
   raise the per-call chunk to "go faster" — it times out and breaks the chain.

7. **Look-back window = 4 months** for inventory (kitchens don't hold older stock).
   `lib/inventory/backfill-worker.ts` default; overridable via `months_back`.

8. **Manual `+ Add article`** (`/inventory/items` + `/inventory/counts/[id]`,
   `POST /api/inventory/items`) is the fallback/supplement — owners add anything
   the PDFs miss, especially while counting. NOT the primary path.

---

## 3. Verify / operate

- **Live progress (read-only):** `node scripts/diag-vero-pdf-progress.mjs`
  (point `biz` at the business) — shows extraction status breakdown, product
  count, and match_status counts. Re-run to watch it climb.
- **Manual kicks (admin):** the board `/admin/v2/onboard/[businessId]` —
  "Invoice scanner" stage + "Auto-build" button. Or curl the cron endpoints with
  `CRON_SECRET` / `x-admin-secret`.
- **Healthy run looks like:** extractions climbing with `failed=0`; some `no_pdf`
  is normal (invoices genuinely without an attachment); products climbing after
  auto-build; needs_review shrinking as the matcher links.

---

## 4. What broke on Vero (so we don't repeat it)

1. Extraction fired at connect-time before lines existed → 0 candidates → done →
   never retried. **Fixed:** backfill-completion triggers extraction + the sweep
   now re-drives any business with lines.
2. `inventory_review_suggestions` upsert silently failed (partial-index trap) →
   auto-build re-classified forever + applied nothing. **Fixed:** delete-then-insert.
3. Auto-build read the cache instead of the in-memory result. **Fixed:** apply
   from in-memory ∪ cache.
4. Misdiagnosed as "no data / manual only." **Reality:** items were on the PDFs
   the whole time; the pipeline just never ran. The product DOES pull from PDFs.
```
