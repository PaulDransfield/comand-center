# Rosali Deli — Fortnox-data cleanup plan

> Source diagnostic: `docs/investigation/rosali-vero-verdict.md`
> Precedent script: `scripts/cleanup-rosali-march-2026.mjs` (similar shape, smaller scope)
> Status: SCOPE / RFC. Awaiting owner go-ahead before any DELETE runs.
> Live state: 12 contaminated `tracker_data` rows + ~470 `tracker_line_items`
> + 2 misfiled `fortnox_uploads` + 2 PDFs in Storage. All other Rosali data
> (POS revenue, PK shifts) is legitimate and must NOT be touched.

## 1. Problem recap

Owner confirmed Rosali Deli was never supposed to have Fortnox connected.
Every Rosali `tracker_data` row sourced from Fortnox is therefore
wrong-by-definition. The verdict already proved:

- Raw Fortnox data (`fortnox_vouchers_cache`, `supplier_invoice_lines`)
  is NOT contaminated for Rosali — both have zero rows.
- Contamination is bounded to the aggregate layer:
  `tracker_data` + `tracker_line_items` + two `fortnox_uploads` PDFs.
- Rosali's PK POS data (`revenue_logs` 40 rows from 2026-04-20+) and
  PK shift data (`staff_logs` from 2022-09-01+) are legitimate and
  must remain untouched.

## 2. Goals & non-goals

**Goals**

- Remove every Rosali row whose source is `fortnox_*`, regardless of
  whether its numbers match Vero or not (the 5 that differ are wrong
  for the same reason the 7 that match are wrong).
- Remove the two misfiled `fortnox_uploads` rows and their PDF blobs
  in the `fortnox-pdfs` Storage bucket.
- Recompute Rosali's `monthly_metrics` for every affected period so
  downstream readers (`/dashboard`, `/financials/performance`,
  `/api/tracker`, AI snapshot) reflect PK-only truth.
- Preserve full pre-delete state to a backup file so the operation
  is reversible if needed.
- Leave Vero's data, Rosali's PK data, and any other business untouched.

**Non-goals**

- Building the schema/route-level guards that would prevent recurrence
  (the `source='fortnox_*'` + no-integration mismatch). Scoped
  separately at the bottom of this doc; not in the cleanup script.
- Investigating who/what created the April 22 batch (still unknown;
  worth doing but doesn't block cleanup).
- Identifying what "Asp" in `Resultatrapport_Asp_2601.pdf` actually
  refers to. The file is misfiled either way; cleanup deletes it.
- Cleaning up similar contamination on any other business. The
  diagnostic only checked Vero and Rosali. **A separate sweep is
  worth running before this cleanup script ships, to confirm no
  third business has Fortnox-source rows without an integration —
  see §8 "Pre-cleanup safety sweep" below.**

## 3. Owner decisions needed before running

### 3.1 PDF blob deletion

`fortnox_uploads` rows reference PDFs in the Supabase Storage
`fortnox-pdfs` bucket via `pdf_storage_path`. Two options:

- **α) Delete the rows AND the PDF blobs.** Clean state.
- **β) Delete the rows but keep the PDFs in storage.** Audit trail
  of what was uploaded; small storage cost; orphan blobs that nothing
  references.

**Recommendation:** **α (delete both).** The backup JSON file
(§4 Phase 2) preserves the row metadata — PDF filename, uploader,
applied_at — so the audit trail survives without keeping ~2 binary
blobs around forever. If the owner wants a copy of either PDF for
archival, download them to local disk during the dry-run inventory
phase before any DELETE runs.

### 3.2 Recompute strategy

After deleting Rosali's Fortnox-source rows, `monthly_metrics` for
the 12 affected periods will be stale (they include the now-deleted
revenue/cost numbers). Two options:

- **a) Recompute via `/api/admin/reaggregate`.** Idiomatic; runs the
  same aggregator as everywhere else. Requires service-role auth.
  Per CLAUDE.md, this endpoint exists ("New `/api/admin/reaggregate`
  backfills historical data").
- **b) Replicate the recompute logic inline** in the cleanup script
  (the precedent `cleanup-rosali-march-2026.mjs` does this — it computes
  staff_cost from PK staff_logs + revenue=0 and upserts monthly_metrics
  directly).

**Recommendation:** **a, with b as fallback.** Reuse the aggregator
endpoint when available; if it times out or errors for any period,
fall back to the inline recompute pattern from the precedent script.

### 3.3 How long can Rosali's dashboard be in a transitional state?

There's a window between (i) deleting tracker_data and (ii) the
recompute completing where Rosali's `/dashboard` would show
zero revenue / NaN margins. Window length: a few seconds per period
under normal load; up to ~30s total for all 12 periods.

- **Acceptable** because Rosali is the smaller of two businesses and
  the dashboard is owner-facing only (not customer-facing). Risk of
  the owner happening to look at Rosali's dashboard in those 30s
  is minimal.
- **Mitigation:** run during low-activity hours (early UTC morning)
  and complete all DELETE + recompute within one script invocation
  so the transitional window is as short as possible.

---

## 4. Script architecture

**Filename:** `scripts/cleanup-rosali-fortnox-contamination.mjs`

**Convention:** mirrors `scripts/cleanup-rosali-march-2026.mjs` for env
loading + PostgREST fetch helpers + console output styling.

**Modes (CLI flags):**

| Flag                 | Behaviour |
|----------------------|-----------|
| (no flag) / `--dry`  | **DEFAULT.** Inventory only. Reads everything that would be deleted, writes the backup JSON, prints counts + SEK totals. Zero writes. |
| `--apply`            | Actually executes the deletes + recompute. Requires interactive confirmation prompt (see §5). |
| `--restore <path>`   | (FUTURE — not in v1.) Re-insert rows from a backup JSON file. Manual SQL is fine for v1. |

**Operational structure (5 phases):**

```
Phase 1 — Inventory (read-only)
  Phase 1a: enumerate Rosali tracker_data with source LIKE 'fortnox_%'
  Phase 1b: enumerate corresponding tracker_line_items
  Phase 1c: enumerate the 2 fortnox_uploads + read pdf_storage_path
  Phase 1d: enumerate Rosali revenue_logs + staff_logs to confirm what stays
  Phase 1e: enumerate Rosali monthly_metrics rows that need recompute
  Print summary: counts, SEK totals, periods affected.
  ABORT if counts don't match expected (12 tracker_data, 2 uploads).

Phase 2 — Backup (writes a single JSON file)
  Write docs/investigation/cleanup-backups/rosali-<ISO>.json containing
  every row from Phase 1 (tracker_data, tracker_line_items, fortnox_uploads
  with pdf_storage_path, original monthly_metrics, all serialized).
  Refuse to proceed if backup write fails.
  In dry mode: stop here. Print "Dry run complete — backup written."

Phase 3 — Delete (gated)
  Confirmation prompt:
    "About to delete 12 tracker_data + ~470 tracker_line_items
     + 2 fortnox_uploads + 2 PDF blobs for Rosali Deli.
     Backup written to <path>.
     Type 'ROSALI' to confirm:"

  In FK-safe order:
    3a. DELETE tracker_line_items WHERE business_id=ROSALI
        AND period_year IN (2025,2026) AND period_month IN (1..11,1)
        — using the exact (year, month) tuples from Phase 1, not a range
    3b. DELETE tracker_data WHERE id IN (<the 12 ids from Phase 1>)
    3c. DELETE fortnox_uploads WHERE id IN (<the 2 ids>)
    3d. storage.remove(['<each pdf_storage_path>']) on bucket 'fortnox-pdfs'

  Each step logs:
    - rows-affected count
    - elapsed ms
  Each step ABORTS the script on error; subsequent steps don't run.

Phase 4 — Recompute monthly_metrics
  For each (business=ROSALI, year, month) tuple from Phase 1:
    POST /api/admin/reaggregate { business_id: ROSALI, year, month }
      with x-admin-secret header (or service-role bearer; check endpoint).
    On 200, log success.
    On error or timeout, fall back to inline recompute (precedent
    cleanup-rosali-march-2026.mjs pattern):
      - Read PK staff_logs for that month
      - Compute staff_cost, hours, shifts
      - Upsert monthly_metrics with revenue=0, computed staff_cost,
        cost_source='pk' (or 'none' if no PK data either)

Phase 5 — Verify
  Re-read Rosali tracker_data, monthly_metrics, fortnox_uploads.
  Print:
    - Remaining tracker_data rows for Rosali (expected: 0)
    - Remaining fortnox_uploads for Rosali (expected: 0)
    - Recomputed monthly_metrics: per-month revenue + staff_cost
    - Rosali revenue_logs count (expected: unchanged from Phase 1)
    - Rosali staff_logs count (expected: unchanged from Phase 1)
  If anything unexpected, print red WARNING but don't auto-rollback —
  point operator at the backup file.
```

## 5. Safety mechanisms (must-haves)

1. **Default mode is dry-run.** `node scripts/cleanup-rosali-fortnox-contamination.mjs`
   without flags writes the backup and prints the inventory, full stop.
   Only `--apply` runs DELETE.
2. **Hard-coded `business_id = ROSALI`.** The script never accepts a
   business_id from CLI or env. Pinned in source. If the operator
   wants to apply this pattern to a different business, they fork
   the script.
3. **Source filter pinned to `fortnox_*`.** The DELETE WHERE clauses
   include explicit `source LIKE 'fortnox_%'` (Phase 1a) — even a
   bug in row enumeration cannot accidentally delete a `manual` or
   `pos` row.
4. **Expected-count assertion.** Phase 1 expects exactly 12
   tracker_data rows and exactly 2 fortnox_uploads. If the inventory
   returns very different numbers (say, 0 or 50), the script aborts
   with a message telling the operator to re-run the diagnostic
   first. This catches the case where something has changed in prod
   between diagnostic and cleanup (e.g. someone cleaned up partially
   by hand).
5. **Interactive confirmation.** Even with `--apply`, the script
   reads a confirmation token from stdin. The token is `ROSALI` (not
   "yes" or "y" — has to be deliberate). Mismatched token aborts.
6. **Backup before any DELETE.** Phase 2 must succeed before Phase 3
   runs. Backup file path is printed prominently.
7. **No ALTER, no DROP, no schema change** anywhere in the script.
   Pure data DELETEs + storage DELETEs + monthly_metrics UPSERT.
8. **Each phase has an early-abort.** If Phase 3a fails, 3b doesn't
   run. If 3b fails, 3c/3d don't run. The backup remains as the
   recovery anchor for any half-completed state.
9. **No credentials printed.** No `credentials_enc` or token values
   logged. Pre-existing rule from the diagnostic script.
10. **Single env source.** `.env.production.local` only (same as
    diagnostic script + precedent cleanup). Refuses to run if
    `SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_URL`
    is missing.

## 6. Rollback plan

If the cleanup is run and the owner later says "actually I wanted
those rows":

1. Open the backup JSON file (`docs/investigation/cleanup-backups/rosali-<ISO>.json`).
2. The file contains complete row data for every deleted row,
   including all columns + original IDs.
3. Restore via PostgREST `POST /rest/v1/<table>` with the saved
   payloads. UUIDs are preserved so FK references stay consistent.
4. PDFs in Storage: the backup JSON has the `pdf_storage_path` but
   NOT the binary content. **If the owner wants the PDF binaries
   back, download them to local disk during the dry-run phase
   before running `--apply`.** This is called out in the operator
   runbook (§9 below).

Rollback is full-text restoration; no data loss. Worst case = an hour
of manual SQL.

For monthly_metrics: the backup also captures the pre-cleanup
monthly_metrics rows. Restore those via UPSERT to undo the recompute.

## 7. Risks & mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Script deletes rows from another business by mistake | Very low | High | business_id pinned in source, source filter pinned, expected-count assertion, dry-run default |
| Cron job re-creates contaminated rows during the cleanup window | Low | Medium | Cleanup window is < 60s. The two crons that could touch this (`fortnox-backfill-worker`, `fortnox-supplier-sync`) skip Rosali because Rosali has no Fortnox integration. The path that originally wrote these rows is NOT in code today — the diagnostic showed they pre-date Vero's only integration. |
| `/api/admin/reaggregate` endpoint behaves differently than expected | Medium | Low | Fallback inline recompute mirrors `cleanup-rosali-march-2026.mjs` exactly |
| Storage delete fails after row delete succeeds (orphan blobs) | Low | Low | Try-catch around storage delete; log warning but don't roll back. Orphan blobs can be swept later. |
| Backup file write fails | Very low | High | Abort entire run before any DELETE. Backup precedes delete in code. |
| Operator accidentally runs `--apply` without dry-run first | Low | High | Confirmation prompt requires typing `ROSALI` (not "yes") |
| FK cascade unexpectedly deletes more than intended | Low | High | Run a `pg_constraint` introspection FIRST (see §8) to enumerate every FK touching the affected tables. If any unexpected CASCADE exists, abort and re-scope. |
| The 12-row count changes between diagnostic and cleanup | Low | Medium | Expected-count assertion in Phase 1 aborts if count drift > 20%. Operator can re-run diagnostic and re-scope. |
| Rosali's PK revenue_logs / staff_logs get touched | Very low | High | Script never references these tables in any DELETE or UPDATE. They're only read in Phase 1d and Phase 5 for verification. |
| Rosali's `daily_metrics` becomes inconsistent with `monthly_metrics` after recompute | Low | Low | `monthly_metrics` rollup is the source-of-truth for `/tracker`; daily_metrics is mostly PK-derived and doesn't see tracker_data anyway. If there's drift, the daily aggregator's next nightly run rebuilds it. |
| Vero's data is affected | Very low | Critical | Script never touches `business_id = VERO`. Defensive: any WHERE clause that mentions business_id is `WHERE business_id = '97187ef3-…'` (Rosali UUID hardcoded). |

## 8. Pre-cleanup safety sweep (DO BEFORE the cleanup script ships)

Before running ANY destructive operation, prove the contamination is
bounded to Rosali by sweeping the whole DB for the same pattern. New
small read-only script `scripts/diag-fortnox-source-no-integration.mjs`:

```javascript
// For every business: count tracker_data rows with source LIKE 'fortnox_%'
// AND no integrations row with provider='fortnox' for that business.
// Expected output: only Rosali. If any other business shows up,
// the cleanup scope changes.
```

This is a ~30-line script. Worth running before the cleanup script
is even written. If it returns more than just Rosali, this plan
needs updating to handle the broader case (or to ship the cleanup
script as a per-business utility, not Rosali-specific).

Also worth checking: `pg_constraint` introspection on
`tracker_data`, `tracker_line_items`, `fortnox_uploads` to enumerate
any FK we don't know about (especially CASCADE behaviour). Done via
one PostgREST call to `information_schema.referential_constraints` or
via a `pg_constraint` view. Two-line read; should match the assumed
order in §4 Phase 3.

## 9. Operator runbook

The script should print this runbook (or a short version) on first
invocation. Plain-text steps for the operator (Paul or admin):

1. **Confirm low-traffic window** (early UTC morning works).
2. **Run diagnostic again** to verify state hasn't drifted:
   `node scripts/diag-rosali-vero-identical.mjs`
3. **Run sweep** to confirm contamination is Rosali-only:
   `node scripts/diag-fortnox-source-no-integration.mjs`
4. **Run cleanup in dry-run mode:**
   `node scripts/cleanup-rosali-fortnox-contamination.mjs`
   Read the inventory output. Confirm counts match expected (12 + ~470 + 2).
   Note the backup file path.
5. **(Optional)** Download the two PDFs from Supabase Storage UI if
   you want a local copy. The script can't easily fetch binaries, and
   the backup JSON doesn't include them. Once you run `--apply`, the
   PDFs are gone from Storage.
6. **Run apply:**
   `node scripts/cleanup-rosali-fortnox-contamination.mjs --apply`
   Type `ROSALI` at the prompt.
7. **Verify** the script's Phase 5 output: Rosali has 0 fortnox tracker_data
   rows, recomputed monthly_metrics reflect PK data only.
8. **Sanity-check the dashboard:** open `/dashboard` with Rosali
   selected. Revenue tile should reflect PK POS data only. Cost split
   should be PK staff cost only. Margin = -staff_cost / 0 = N/A.
9. **Tell the owner** the cleanup is done + summarise: "Removed 12
   Fortnox-source rows and 2 misfiled PDFs. Rosali's POS and staff
   data unchanged. Dashboard now reflects PK-only truth."

## 10. Estimated effort

- **Pre-cleanup sweep script** (`diag-fortnox-source-no-integration.mjs`):
  ~30 LOC, ~30 minutes.
- **Cleanup script** (`cleanup-rosali-fortnox-contamination.mjs`):
  ~250 LOC. Read existing precedent script and adapt. ~3 hours of
  focused work including the inline-recompute fallback. The precedent
  script is well-commented and most patterns drop in directly.
- **Backup directory + first run**:
  Create `docs/investigation/cleanup-backups/.gitkeep`. Add directory
  to `.gitignore` if backups should NOT be committed (recommended —
  they contain financial data even if not credentials).
- **Operator time to run**: ~10 minutes (dry-run + verify + apply +
  verify). Mostly waiting for the recompute.

Total: **half a day** including script + sweep + execution + monitoring.

## 11. Open questions

1. **§3.1: delete PDF blobs too, or keep them?** Recommended α (delete).
2. **§3.3: any specific time-of-day constraint** for the apply run?
   (Default: early UTC morning when traffic is lowest.)
3. **Is the operator Paul, or an admin?** Determines whether the
   script needs to log who ran it (for audit). Recommend: log the
   OS username + hostname + git commit SHA into the backup JSON
   header regardless.
4. **Should the cleanup also delete `inventory_backfill_state` for
   Rosali if any exists?** (Unchecked in the diagnostic; probably
   zero rows since Rosali has no Fortnox, but worth confirming in
   the pre-cleanup sweep.)
5. **Anything in `fortnox_supersede_links` reference the 2 uploads?**
   If yes, those need to be deleted too (or the FK will block).
   Worth adding to the FK introspection in §8.

## 11b. Interaction with the 2026-04-01 Swedish food-VAT rule change

Worth noting explicitly because the two bugs (Rosali cross-attribution +
VAT misrouting) overlap in time but are independent.

**Rosali's contaminated periods are entirely PRE-cutoff:**

| Contaminated period | Relative to 2026-04-01 cutoff |
|---|---|
| 2025-01 through 2025-11 (11 months) | pre-cutoff (12 % food rate in effect) |
| 2026-01 | pre-cutoff |
| (no contaminated rows ≥ 2026-04) | — |

So none of the rows being deleted carry the VAT-misrouting bug. The
`classifyByVat` logic that mis-tags 6 %-moms revenue as `takeaway` only
matters for periods ≥ 2026-04-01, and Rosali has zero of those in the
contaminated set.

**Rosali's PK data is entirely POST-cutoff:**

`revenue_logs` for Rosali starts 2026-04-20. Every legitimate Rosali POS
row was logged AFTER Sweden's food-VAT rate change. So when the cleanup
script's Phase 4 recomputes Rosali's `monthly_metrics` from PK data, it
runs PK rows through `lib/pos/personalkollen.ts:307-309` — the same
classifier the VAT plan flags as buggy.

In practice this doesn't change the cleanup outcome because:
- `monthly_metrics` does NOT have `dine_in_revenue` / `takeaway_revenue`
  columns (per verdict §12.1 — M029's split columns only landed on
  `tracker_data`). So the PK recompute writes total revenue + staff cost,
  not a VAT-derived split.
- Rosali's `tracker_data` will have ZERO rows after cleanup (since the
  source of those splits was Fortnox, which is being removed). No
  downstream surface reads a dine_in/takeaway split for Rosali post-cleanup.

But it does mean **two ordering implications:**

1. **Cleanup is independent of the VAT fix.** Either can ship first. The
   cleanup does not depend on `VAT-MISROUTING-FIX-PLAN.md` being merged.
2. **If Rosali ever gets a Fortnox integration AFTER cleanup**, the VAT
   fix should already be in place — otherwise Rosali's first April 2026+
   `tracker_data` row will fire the same `classifyByVat` bug Vero hit.
   Cross-referenced in `VAT-MISROUTING-FIX-PLAN.md` §11.

**Action for this plan:** none changes. The cleanup script can ship
today regardless of VAT fix status. Document the dependency for the
day Rosali's Fortnox does get connected — handled in §12 below.

## 12. Separate follow-up work (NOT in this script)

These are real fixes but separate scope:

- **Rosali Fortnox onboarding gate** — when/if Rosali ever connects
  Fortnox, the VAT misrouting fix (`VAT-MISROUTING-FIX-PLAN.md`
  Phase 1 minimum) must ship first. Otherwise the first April 2026+
  `tracker_data` row created from Rosali's Fortnox vouchers will fire
  the `classifyByVat` 6 %-moms-→-takeaway bug. Easy check at connect
  time: feature-flag the OAuth callback to refuse Rosali's connect
  until the VAT fix is in main.
- **Add `/api/fortnox/apply` guard** — refuse to apply a PDF against
  a business with no `integrations` row for `provider='fortnox'`.
  Catches the most common future vector.
- **Add DB CHECK / trigger on `tracker_data`** — refuse INSERT with
  `source LIKE 'fortnox_%'` unless `fortnox_upload_id IS NOT NULL`
  AND the referenced upload's `business_id` matches the new row's
  `business_id`. Catches admin-script bypasses.
- **Investigate the April 22 batch** — the cluster of created_at
  timestamps on that date suggests a single batch operation. If
  it was a known admin tool, the guards above need to apply there
  too. If unknown, that mystery should be solved before any new
  admin tools ship.
- **Document the precedent** — `scripts/cleanup-rosali-march-2026.mjs`
  was a one-off; the new cleanup script + this plan turn the pattern
  into a reusable shape. Worth adding a short README in `scripts/`
  describing the "diagnose → backup → confirm → delete → recompute →
  verify" shape so the next cleanup uses the same gates.

---

*End of plan. Owner go-ahead needed on §3.1 (delete PDFs or keep) before
the script gets written. Everything else has reasonable defaults that the
script can implement and the operator can override via dry-run inspection.*
