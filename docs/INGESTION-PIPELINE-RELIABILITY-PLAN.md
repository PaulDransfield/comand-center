# Ingestion pipeline reliability — plan

> Status: Phase 1 in build (2026-06-06).
> Trigger: 2026-06-06 incident — file_id silently null on ~99% of `fortnox_supplier_invoices` rows because the daily sync never asked Fortnox for it. Symptom was "PDF not available" on basically every supplier-article View PDF click. Root cause was a class of failure (silent partial ingestion with no completeness contract), not a bug in any one file.

## Goal

Every byte of data that flows into CommandCenter from an external source (Fortnox today, POS connectors tomorrow) carries a contract: which fields were expected, which were populated, when, by whom. A field silently going missing — because of an API change, a missed sync step, a transient error swallowed at the wrong layer — must become impossible to hide.

Everything else in the app derives from this layer. A silent gap here ripples through articles, prices, recipes, costs, GP%, prep, orders, the AI surfaces. We're not optimising for speed at the ingestion edge; we're optimising for honesty.

## The five pieces (full plan)

1. **Ingestion ledger** — every API call we make to an external source writes a row to `ingestion_log` with expected/populated field arrays. Permanent audit trail.
2. **Row-level completeness flag** — every ingested row carries `ingestion_status` (complete / partial / header_only / failed) + `ingestion_meta` jsonb. Read sites check this before rendering.
3. **Coverage cron + ops alert** — daily job computes per-source × per-field population %, compares to baseline, emails ops on regression.
4. **Single ingestion path per resource** — retire the split where the supplier-sync cron and pdf-extraction-worker both touch `fortnox_supplier_invoices`. One path that fetches everything Fortnox can give us in one go; worker becomes retry-failed-rows backfill.
5. **Data quality dashboard** at `/admin/data-quality` — last-sync, coverage %, error rate, stale flag per source. Customer-trimmed view at `/integrations`.

This document scopes Phase 1 only. Phases 2-5 ship as separate sessions.

## Phase 1 scope

Build the **foundation** every later phase needs:
- A. `ingestion_log` table — single global, columns `source / resource / business_id / started_at / finished_at / expected_fields jsonb / populated_fields jsonb / status / error / context jsonb`.
- B. Row-level columns on `fortnox_supplier_invoices` — `ingestion_status text` + `ingestion_meta jsonb`. Pattern ready for any future ingestion target via the same column pair.
- C. `lib/ingestion/ledger.ts` helper module — `openLedger() / completeLedger() / computeRowStatus()`. Defensive: ledger write failures don't break the actual sync (log + continue).
- D. Wire Fortnox supplier-sync cron as the first user. Every batch upsert annotates rows with `ingestion_status`, every API call writes a ledger row.
- E. Backfill existing rows — every existing `fortnox_supplier_invoices` row gets `ingestion_status='header_only'` (truthful — we never fetched file_id) so the read side can already trust the flag.

**Out of scope for Phase 1** (deferred to Phases 2-5):
- Fixing the supplier-sync to actually populate file_id at ingestion (Phase 2)
- One-shot backfill that walks every row and fills file_id (Phase 2)
- Coverage cron / ops alert (Phase 3)
- Retiring the supplier-sync / pdf-extraction-worker split (Phase 4)
- Admin / customer dashboards (Phase 5)

## Schema decisions made

**Single `ingestion_log` table, not per-source.**
Reasoning: cross-source coverage queries (e.g. "total ingestion errors today across Fortnox + PK + Stripe") are the most common use case once the dashboard ships. Per-source tables would force UNION ALL queries at every read site. Trade: typed columns are nicer than `source text` discriminator, but cost > benefit at this scale.

**`expected_fields` / `populated_fields` as `jsonb` arrays of strings.**
Reasoning: field sets change as APIs evolve. A typed schema would force a migration every time. jsonb lets us version the expected set per call without ALTER TABLEs.

**Row-level `ingestion_status` as `text` (not enum), CHECK constrained.**
Reasoning: easy to extend without an ALTER TYPE. Allowed values: `complete`, `partial`, `header_only`, `failed`. CHECK keeps it honest.

**`ingestion_meta jsonb` carries per-row context** — last ledger_id, fields-missing list, last error message. Single column means we can add fields without migrations as the pattern matures.

## Files Phase 1 touches

- `sql/M135-INGESTION-LEDGER.sql` (new) — table + columns + check + indexes + backfill
- `lib/ingestion/ledger.ts` (new) — helper API
- `app/api/cron/fortnox-supplier-sync/route.ts` (edit) — first user. Open ledger per batch, annotate rows on upsert, close ledger on success/error
- `app/api/inventory/invoice-pdf/route.ts` (edit) — when status is `header_only` or `partial`, show "Not yet checked — retry next sync" rather than "no PDF on Fortnox" (corrects today's lie)
- `docs/INGESTION-PIPELINE-RELIABILITY-PLAN.md` (this doc)

## Acceptance — Phase 1

- Every existing `fortnox_supplier_invoices` row has a truthful `ingestion_status` (`header_only` for the ~1,800 rows that never got file_id; `complete` for the handful that ran through the PDF worker).
- The next Fortnox supplier-sync cron writes ledger rows for every API call it makes.
- "No PDF" UI message differentiates between "we asked Fortnox and it has nothing" vs "we haven't checked yet" — the second message points to the retry path.
- `npx tsc --noEmit` clean. Idempotent SQL.

## Trigger to start Phase 2

Phase 1 has been in production for one full daily sync cycle AND owner has spot-checked `/admin/data-quality` or queried `ingestion_log` once to confirm the ledger is populating. Phase 2 then closes the file_id gap with the completeness flag already in place to verify the fix.
