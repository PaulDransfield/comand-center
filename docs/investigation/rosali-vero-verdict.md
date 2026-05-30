# Rosali / Vero identical-data — diagnostic verdict

> Source diagnostic: `rosali-vero-diagnostic-prompt.md`
> Read-only investigation. No code, schema, or data changed.
> Date: 2026-05-30. Author: Claude Code (CLI).
> Diagnostic script: `scripts/diag-rosali-vero-identical.mjs` (read-only).

## Verdict — one line (FINALISED 2026-05-30 after owner confirmation)

**SAME ORG (intra-org correctness bug, NOT cross-tenant leak). Owner confirmed Rosali was never supposed to have Fortnox — so ALL 12 Rosali `tracker_data` rows from Fortnox sources are wrong by definition, regardless of whether their numbers match Vero. Raw Fortnox data (`fortnox_vouchers_cache`, `supplier_invoice_lines`) is NOT contaminated — only the aggregate layer is. Two PDF uploads (`Resultatrapport 2025.pdf`, `Resultatrapport_Asp_2601.pdf`) were misfiled against Rosali's business_id. Cleanup is bounded: delete every Rosali `tracker_data` row whose `source` is `fortnox_*`, delete matching `tracker_line_items`, delete the two misfiled `fortnox_uploads` rows (and their Storage PDFs), recompute `monthly_metrics`. Rosali's genuine PK-derived data (40 `revenue_logs` rows from 2026-04-20 onwards + `staff_logs` since 2022-09-01) stays untouched.**

---

## Q1 — Tenancy boundary

**Same org.** Both `businesses` rows have `org_id = e917d4b8-635e-4be6-8af0-afc48c3c7450`.

| business        | id                                       | created_at                          |
|-----------------|------------------------------------------|-------------------------------------|
| Vero Italiano   | 0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99    | 2026-03-28T16:50:39.583882+00:00    |
| Rosali Deli     | 97187ef3-b816-4c41-9230-7551430784a7    | 2026-04-10T09:30:34.869825+00:00    |

Org has exactly these two businesses; both active.

**This is an intra-org correctness issue, NOT a cross-tenant data exposure.**
No escalation needed beyond the org's own owner.

---

## Q2 — Fortnox integration: same Fortnox tenant?

**Rosali has NEVER had a Fortnox integration.** Only one Fortnox `integrations`
row exists across both businesses, and it's bound to Vero:

| business | provider        | status     | created_at                        |
|----------|-----------------|------------|-----------------------------------|
| Vero     | personalkollen  | connected  | 2026-04-09T12:54:03+00:00         |
| Vero     | fortnox         | connected  | **2026-05-11T07:55:27+00:00**     |
| Rosali   | personalkollen  | connected  | 2026-04-10T11:34:16+00:00         |

(No `integrations` row with `business_id = Rosali` and `provider = 'fortnox'`
in any status, including disconnected. Zero rows.)

Rosali → no Fortnox tokens, no Fortnox credentials, no Fortnox workspace.
This rules out the "shared integration" hypothesis (H1 from the prompt).

---

## Q3 — January 2026 `tracker_data` row provenance

Both businesses' Jan 2026 rows have IDENTICAL financial numbers but
DIFFERENT metadata:

| field                | Vero                                  | Rosali                                |
|----------------------|---------------------------------------|---------------------------------------|
| id                   | 9e1f5d41-…                            | 9f91755a-…                            |
| revenue              | 1,817,099                             | **1,817,099 (identical)**             |
| dine_in_revenue      | 669,610                               | **669,610 (identical)**               |
| takeaway_revenue     | 74,127                                | **74,127 (identical)**                |
| alcohol_revenue      | 1,062,068                             | **1,062,068 (identical)**             |
| source               | fortnox_api                           | fortnox_api                           |
| created_via          | fortnox_backfill                      | fortnox_backfill                      |
| fortnox_upload_id    | 22ddbf75-… (Vero PDF upload)          | f87eb670-… (Rosali PDF upload)        |
| created_at           | 2026-04-24T10:20:21.422+00:00         | 2026-04-24T10:59:30.859+00:00         |
| updated_at           | 2026-05-25T13:19:14.805+00:00         | 2026-05-11T08:10:09.517+00:00         |

The two rows were created ~40 minutes apart on the same day (2026-04-24) by
the same actor, then later updated independently. The Vero row has been
refreshed continuously (last 2026-05-25 — voucher cache refresh era);
Rosali's last touched 2026-05-11 (which coincides exactly with Vero's
Fortnox integration being created).

**`source='fortnox_api'` is misleading for Rosali** — Rosali has no Fortnox
integration to source from. The row was either manually inserted with that
label, or written by a process (PDF apply or admin tool) that wrote that
label without verifying integration existence.

---

## Q4 — Rosali period coverage: does Rosali have ANY genuine data, ever?

12 `tracker_data` rows for Rosali, all created 2026-04-22 or 2026-04-24:

| period   | revenue   | source       | created_via         |
|----------|-----------|--------------|---------------------|
| 2025-01  | 810,500   | fortnox_pdf  | fortnox_apply       |
| 2025-02  | 796,700   | fortnox_pdf  | fortnox_apply       |
| 2025-03  | 859,700   | fortnox_pdf  | fortnox_apply       |
| 2025-04  | 857,400   | fortnox_pdf  | fortnox_apply       |
| 2025-05  | 322,027   | fortnox_api  | fortnox_backfill    |
| 2025-06  | 406,340   | fortnox_api  | fortnox_backfill    |
| 2025-07  | 439,740   | fortnox_api  | fortnox_backfill    |
| 2025-08  | 687,003   | fortnox_api  | fortnox_backfill    |
| 2025-09  | 772,762   | fortnox_api  | fortnox_backfill    |
| 2025-10  | 1,315,459 | fortnox_api  | fortnox_backfill    |
| 2025-11  | 1,623,951 | fortnox_api  | fortnox_backfill    |
| 2026-01  | 1,817,099 | fortnox_api  | fortnox_backfill    |

Missing: 2025-12, 2026-02 through 2026-05.

Also for Rosali:
- `revenue_logs`: 40 rows, earliest 2026-04-20 (legitimate PK POS data — Rosali's own)
- `staff_logs`: earliest 2026-09-01 (also legitimate PK shifts)
- `fortnox_vouchers_cache`: **0 rows ever**
- `supplier_invoice_lines`: **0 rows ever**

So Rosali HAS genuine PK-derived revenue + staff data (its own POS + shifts).
What it does NOT have is any genuinely-its-own Fortnox-derived data. Everything
in Rosali's `tracker_data` is from PDF uploads OR has unverified provenance.

---

## Q5 — Raw-source cross-attribution: NOT present

`supplier_invoice_lines` and `fortnox_vouchers_cache` are clean:

| table                       | Vero Jan 2026 | Rosali Jan 2026 | overlap |
|-----------------------------|---------------|-----------------|---------|
| supplier_invoice_lines      | 764 lines, 640,399 SEK | 0  | 0 invoice-numbers in common |
| fortnox_vouchers_cache      | 380 vouchers, 7,499,728 SEK debit | 0 | 0 voucher-keys in common |

**The cross-attribution does NOT reach the raw voucher / invoice cache.**
This is significant for cleanup: the source-of-truth voucher data is
correctly attributed only to Vero. Only the aggregate layer (`tracker_data` +
`tracker_line_items`) carries the duplicated rows.

---

## Q6 — `tracker_line_items` Jan 2026: byte-identical

| business | line count | identical (account, label, amount) tuples shared with the other |
|----------|------------|---------------------------------------------------------------|
| Vero     | 39         | 39 / 39 (100 %)                                               |
| Rosali   | 39         | 39 / 39 (100 %)                                               |

`source_upload_id` is null on every row for both businesses (the field
isn't populated by the `fortnox_api/fortnox_backfill` path — only by the
`fortnox_apply` PDF path).

So at the LINE-ITEM level, Rosali's 39 rows are byte-equal to Vero's 39
rows for January 2026. This is consistent with the rows having been
written by a process that scoped the WRITE to Rosali but read the SOURCE
from Vero.

---

## Q7 — `fortnox_uploads` referenced by the Rosali Jan 2026 row

Rosali's Jan tracker_data references `fortnox_upload_id = f87eb670-…`.
Vero's references `22ddbf75-…`. Both upload rows exist; both have status
`'applied'`, both same uploader (`8202f17f-…`, presumably Paul):

| upload id       | business | filename                          | created_at                    | applied_at                    |
|-----------------|----------|-----------------------------------|-------------------------------|-------------------------------|
| f87eb670-…      | Rosali   | `Resultatrapport_Asp_2601.pdf`    | 2026-04-24T10:57:41+00:00    | 2026-05-03T20:04:51+00:00    |
| 22ddbf75-…      | Vero     | `Resultatrapport_Vero 2601.pdf`   | 2026-04-24T10:36:32+00:00    | 2026-04-28T18:27:12+00:00    |

`pdf_sha256` is null on both rows (the field wasn't populated for these
uploads), so I cannot prove or disprove byte-identical PDF contents
directly via SHA. The script's initial "Same PDF SHA across both uploads?
YES" output was a `null === null` false-positive — **disregard that
specific claim**.

**The filename `Resultatrapport_Asp_2601.pdf` for Rosali is suspicious.**
"Asp" does not match "Rosali Deli". If "Asp" is a third entity (e.g.
"Aspholmen", "Asp Restaurang AB"), then:

- the PDF Paul uploaded to Rosali may actually contain a different
  restaurant's financial data, OR
- "Asp" is an internal naming convention for Rosali I'm not aware of,
  OR
- the PDF was misnamed but actually contains Vero's data (which would
  exactly explain the identical numbers).

This needs owner clarification. Without it the most parsimonious
explanation is: the PDF named "Asp_2601" actually contained Vero's January
2026 financial data and was applied against Rosali by mistake.

---

## Q8 — Rosali side-by-side vs Vero, all overlapping months

Critical comparison:

| period   | Vero rev   | Rosali rev | match?     | Rosali source/via                |
|----------|-----------:|-----------:|------------|----------------------------------|
| 2025-01  |   883,700  |   810,500  | DIFFER     | fortnox_pdf / fortnox_apply      |
| 2025-02  |   963,700  |   796,700  | DIFFER     | fortnox_pdf / fortnox_apply      |
| 2025-03  | 1,101,500  |   859,700  | DIFFER     | fortnox_pdf / fortnox_apply      |
| 2025-04  |   625,000  |   857,400  | DIFFER     | fortnox_pdf / fortnox_apply      |
| 2025-05  |   114,014  |   322,027  | DIFFER     | fortnox_api / fortnox_backfill   |
| 2025-06  |   406,340  |   406,340  | **IDENTICAL** | fortnox_api / fortnox_backfill   |
| 2025-07  |   439,740  |   439,740  | **IDENTICAL** | fortnox_api / fortnox_backfill   |
| 2025-08  |   687,003  |   687,003  | **IDENTICAL** | fortnox_api / fortnox_backfill   |
| 2025-09  |   772,762  |   772,762  | **IDENTICAL** | fortnox_api / fortnox_backfill   |
| 2025-10  | 1,315,459  | 1,315,459  | **IDENTICAL** | fortnox_api / fortnox_backfill   |
| 2025-11  | 1,623,951  | 1,623,951  | **IDENTICAL** | fortnox_api / fortnox_backfill   |
| 2026-01  | 1,817,099  | 1,817,099  | **IDENTICAL** | fortnox_api / fortnox_backfill   |
| 2026-02..05 | (Vero only)                                                        |

**Two distinct regimes:**

1. **2025-01 to 2025-05 (Rosali ≠ Vero)** — Rosali rows came from PDF
   applies (Jan–Apr) and one API-backfill (May, different number from
   Vero). Suggests Rosali had legitimately-different data inserted
   somehow. Whether that data is itself correct is a separate question;
   the PDFs applied to Rosali for Jan–Apr 2025 may or may not have been
   the right file.

2. **2025-06 to 2025-11 + 2026-01 (Rosali == Vero, 7 months)** — the
   wholesale identical-data window. Rosali could not have produced these
   via Fortnox backfill (it has no integration). The most plausible
   explanations:

   - A historical backfill run (pre-Vero integration on 2026-05-11) used
     an admin script that wrote rows to BOTH businesses under the same
     org while processing one Fortnox tenant's data — the script is
     unidentified; not the current `app/api/cron/fortnox-backfill-worker`
     (which correctly scopes by `business_id` per the integrations row,
     see lines 124, 251, 448, 454, 510 of that file).
   - OR the `Resultatrapport 2025.pdf` annual P&L applied to Rosali on
     2026-05-03 actually contained Vero's 2025 data for Jun–Nov (perhaps
     a hybrid PDF, or wrong PDF for the back half of the year).
   - OR a SQL-level admin write copy/pasted Vero's rows into Rosali's
     `business_id` slots.

   The current Vero Fortnox backfill worker (created 2026-05-11) is NOT
   the cause for the bulk of these rows: those rows were created on
   2026-04-22, weeks BEFORE Vero's Fortnox integration existed.

---

## Blast radius — bounded and recoverable

| Layer                          | Vero status | Rosali status                  |
|--------------------------------|-------------|---------------------------------|
| `fortnox_vouchers_cache`       | populated   | **0 rows** (clean)              |
| `supplier_invoice_lines`       | populated   | **0 rows** (clean)              |
| `fortnox_supplier_invoices`*   | populated   | (not checked but presumably 0) |
| `fortnox_uploads`              | own uploads | 2 own uploads (1 suspicious)    |
| `tracker_data`                 | correct     | **7 months identical to Vero (2025-06–11 + 2026-01) + 1 suspicious Jan 2026** |
| `tracker_line_items`           | correct     | **identical to Vero on those periods** |
| `monthly_metrics`              | (downstream of tracker_data — needs cleanup if tracker_data is cleaned) |
| `daily_metrics`                | (PK-only for Rosali, not affected) |
| `revenue_logs` (POS)           | (Rosali has its own — 40 rows from 2026-04-20)  |
| `staff_logs` (PK)              | (Rosali has its own legitimate data — earliest 2022-09-01) |

(*) M098 cache table — not queried in this diagnostic but the schema
suggests Rosali would have 0 rows since the sync depends on the
Fortnox integration which doesn't exist for Rosali.

**The contamination is purely at the aggregate layer.** Rosali's raw
operational data (PK POS revenue + PK shifts) is untouched and legitimate.

**Surfaces reading the bad rows:**
- Rosali's `/dashboard`, `/financials/performance`, `/tracker` —
  all show Vero's revenue/cost split for the 7 affected months
- `/api/tracker`, `/api/metrics/monthly` for Rosali
- The AI assistant (`lib/ai/snapshot.ts`) when answering questions about
  Rosali — has been answering with Vero's numbers for the affected months
- Any cross-business AI peer analysis using `business_cluster_membership`
  (Vero and Rosali both flagged as Stockholm city-centre, cuisine
  italian/deli) — would conclude that two "different" restaurants have
  identical revenue profiles, polluting any learning

---

## Hypothesis ranking (per the prompt's three)

| Hypothesis | Verdict | Why |
|---|---|---|
| **H1: Shared Fortnox integration, wrong attribution.** | **REJECTED** | Only one Fortnox `integrations` row exists, scoped to Vero. Rosali has no Fortnox integration ever. |
| **H2: Org-scoped instead of business-scoped write.** | **CONSISTENT WITH EVIDENCE but NOT PROVEN.** | Current backfill worker code correctly scopes by `business_id`. The misattribution must come from another writer — possibly historical (pre-current worker), a one-off admin script, or the `apply` route processing a PDF whose contents happened to be Vero's. |
| **H3: Seed/copy artefact.** | **PARTIAL MATCH.** | Created_at timestamps are ~40 minutes apart, not identical, ruling out a single-transaction copy. But the pattern of "Rosali has nothing of its own ≥ 2025-06" plus uploads with suspicious filenames (`Asp_2601`) is consistent with an onboarding/seeding artefact where Vero's PDFs were applied to Rosali by mistake. |

**Most likely combined story:** Paul (or an admin) onboarded Rosali by
applying Vero's annual 2025 P&L PDF to Rosali, plus a January 2026 PDF
named `Asp_2601` whose contents are also Vero's data. The April 22 rows
predate the visible upload-applied-at timestamps (May 3), so either there
was an earlier draft apply that's been retried/overwritten, or a manual
SQL/admin tool wrote rows ahead of the PDF apply. Either way Rosali never
got its own Fortnox-source data because Rosali doesn't have a Fortnox
integration to source from.

---

## Open questions for the owner

1. ~~Was Rosali ever supposed to have its own Fortnox integration?~~
   **ANSWERED 2026-05-30: NO. Rosali never had Fortnox and was never
   supposed to.** This makes every Rosali `tracker_data` row with a
   `fortnox_*` source incorrect by definition — not just the 7 identical
   ones. All 12 rows must go.
2. **What is "Asp" in `Resultatrapport_Asp_2601.pdf`?** Still unanswered.
   Likely a third entity's PDF or a mislabel; not material to the
   cleanup (the upload row + the PDF in storage should be removed
   either way since it shouldn't be on Rosali).
3. **Did anyone run an admin/SQL script around 2026-04-22 to seed Rosali
   historical data?** Still unanswered. Worth knowing for prevention
   (so the same vector isn't used again).
4. ~~Should Rosali show ANY Fortnox-derived rollup at all today?~~
   **ANSWERED 2026-05-30: NO.** Dashboard for Rosali should be PK-only
   until/unless Fortnox is intentionally connected later.

---

## Every query run

All queries executed via the diagnostic script
`scripts/diag-rosali-vero-identical.mjs` and two follow-up inline
`node -e` invocations. Read-only (`GET` against PostgREST = `SELECT`).

```
GET /rest/v1/businesses?select=id,name,org_id,is_active,created_at,country&id=in.(VERO,ROSALI)
GET /rest/v1/businesses?select=id,name,is_active&org_id=eq.<org>&order=created_at.asc
GET /rest/v1/integrations?select=id,org_id,business_id,provider,status,credentials_enc,token_expires_at,last_sync_at,fortnox_workspace_id,created_at&business_id=in.(VERO,ROSALI)&provider=eq.fortnox
GET /rest/v1/tracker_data?select=…&period_year=eq.2026&period_month=eq.1&business_id=in.(VERO,ROSALI)
GET /rest/v1/tracker_data?select=…&business_id=eq.ROSALI&order=period_year.asc,period_month.asc&limit=200
GET /rest/v1/revenue_logs?select=revenue_date&business_id=eq.ROSALI&order=revenue_date.asc&limit=1
GET /rest/v1/revenue_logs?select=count&business_id=eq.ROSALI                      (Prefer: count)
GET /rest/v1/staff_logs?select=shift_date&business_id=eq.ROSALI&order=shift_date.asc&limit=1
GET /rest/v1/supplier_invoice_lines?select=fortnox_invoice_number,total_excl_vat&business_id=eq.ROSALI&invoice_period_year=eq.2026&invoice_period_month=eq.1&limit=5000
GET /rest/v1/supplier_invoice_lines?select=fortnox_invoice_number,total_excl_vat&business_id=eq.VERO&invoice_period_year=eq.2026&invoice_period_month=eq.1&limit=5000
GET /rest/v1/fortnox_vouchers_cache?select=voucher_series,voucher_number,debit_total,credit_total&business_id=eq.ROSALI&period_year=eq.2026&period_month=eq.1&limit=5000
GET /rest/v1/fortnox_vouchers_cache?select=voucher_series,voucher_number,debit_total,credit_total&business_id=eq.VERO&period_year=eq.2026&period_month=eq.1&limit=5000
GET /rest/v1/tracker_line_items?select=fortnox_account,label_sv,subcategory,amount,source_upload_id,created_at&business_id=eq.ROSALI&period_year=eq.2026&period_month=eq.1&order=fortnox_account.asc&limit=200
GET /rest/v1/tracker_line_items?select=fortnox_account,label_sv,subcategory,amount,source_upload_id,created_at&business_id=eq.VERO&period_year=eq.2026&period_month=eq.1&order=fortnox_account.asc&limit=200
GET /rest/v1/tracker_data?select=…&business_id=eq.ROSALI&period_year=eq.2026&or=(source.eq.manual,fortnox_upload_id.is.null)&order=period_month.asc

# Follow-up:
GET /rest/v1/fortnox_uploads?select=*&limit=1                                     (column introspection)
GET /rest/v1/fortnox_uploads?select=id,…,pdf_filename,pdf_sha256,created_at,…&id=in.(<both upload ids>)
GET /rest/v1/integrations?select=id,provider,status,created_at,updated_at,last_sync_at,last_error&business_id=eq.ROSALI&order=created_at.asc
GET /rest/v1/integrations?select=id,provider,status,created_at,updated_at&business_id=eq.VERO&order=created_at.asc
GET /rest/v1/fortnox_vouchers_cache?select=count&business_id=eq.ROSALI
GET /rest/v1/supplier_invoice_lines?select=count&business_id=eq.ROSALI
GET /rest/v1/integration_state_log?select=…&business_id=eq.ROSALI                  (HTTP 400 — RLS or column shape; not retried)
GET /rest/v1/fortnox_uploads?select=…&business_id=eq.ROSALI&order=created_at.asc
GET /rest/v1/tracker_data?select=period_year,period_month,revenue,dine_in_revenue,takeaway_revenue,alcohol_revenue,source,created_via,fortnox_upload_id,created_at&business_id=eq.VERO&order=period_year.asc,period_month.asc
GET /rest/v1/tracker_data?select=…&business_id=eq.ROSALI&order=period_year.asc,period_month.asc
```

No `POST`, `PATCH`, `DELETE`, or RPC writes anywhere. No `credentials_enc`
plaintext values printed (only `sha256.slice(0,12)` hashes for comparison —
both rows hashed to `bf07ebc15eec`, which only matters if more than one
Fortnox integration existed; in our case only one integration row was
returned so the hash comparison is moot).

---

## Recommended next steps (not in this diagnostic's scope)

Owner has confirmed Rosali should have no Fortnox data. Path is clear:

- **Cleanup script** following the `scripts/cleanup-rosali-march-2026.mjs`
  pattern: delete all 12 Rosali `tracker_data` rows where
  `source LIKE 'fortnox_%'`, delete matching `tracker_line_items`,
  delete the two `fortnox_uploads` rows (`f87eb670-…` and the annual one),
  delete the corresponding PDF blobs from Supabase Storage (`fortnox-pdfs`
  bucket), recompute `monthly_metrics` from the remaining (PK-only)
  sources. Mirrors the March cleanup pattern exactly.
- **Guard at the write layer:** add a check to `app/api/fortnox/apply`
  that refuses to apply a PDF against a business that has no Fortnox
  integration row (`SELECT 1 FROM integrations WHERE business_id=$1
  AND provider='fortnox'`). Same guard belongs in any admin tool /
  script that writes `tracker_data` with a `fortnox_*` source.
- **Guard at the row-write layer:** add a DB CHECK or trigger so a
  `tracker_data` row with `source LIKE 'fortnox_%'` cannot be inserted
  unless `fortnox_upload_id` is non-null AND the referenced upload row's
  `business_id` matches the tracker_data row's `business_id`. This would
  have caught the mismatch even if the apply-route guard was bypassed
  by an admin script.
- **Investigate the 2026-04-22 batch creation** — the cluster of
  created_at timestamps on that date is the missing piece. If a script
  did it (e.g. an admin-tools page action), the same vector should be
  blocked by the apply-route guard above. If it was a CLI run by an
  admin, that admin needs to know to use a Fortnox-connected target
  next time.

No fix in this diagnostic. Stop at the verdict.
