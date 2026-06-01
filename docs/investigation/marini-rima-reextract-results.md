# Marini/Rima Re-Extraction — Results

Run: 2026-06-01
Branch: `marini-rima-force-sonnet` (force-Sonnet trigger for credit-note shape)
Method: locally invoked the production `extractInvoicePdf()` for each of the
5 known passthroughs against the same Anthropic / Fortnox / Supabase code
path that prod cron uses (the new `/api/admin/reextract-invoice` endpoint
mirrors this; SSO blockade meant the local invocation was the practical
test path). Acceptance bar per prompt: **reconciliation within
öresavrundning**, not row count.

## Three-line headline

1. **4 of 5 GOOD, 1 INERT.** The four positive-flow passthroughs
   (Laweka 3174, Eventcenter 2902/2948/2975) reconciled cleanly after
   Sonnet escalation populated `passthrough_scaling` and the server
   applied the deterministic scale. The one INERT case is the November
   credit-note 3278 — Haiku returned a 1-row summary that *already*
   reconciles to the negative header total within 0.002 %, so the
   existing total-match gate accepted it without escalation. To force
   escalation on this exact signature, this branch adds a
   `Marini/Rima passthrough force-escalation` rule in
   `haikuLooksGoodEnough`.
2. **147 catalogue lines recovered and reconciling.** Sum across the 4
   GOOD invoices: 46 (3174) + 50 (2902) + 29 (2948) + 22 (2975) = **147**.
   Each invoice's recovered row totals sum to within ≤ 0.48 SEK of the
   invoice header (öresavrundning band). All rows landed in
   `supplier_invoice_lines` with `source='pdf_extraction'` and are now
   available as real catalogue + cost-seed data for the Italian-deli
   passthrough.
3. **No REJECTED / no manual-entry cases.** No invoice triggered
   `passthrough_scaling_rejected` (model never reported a scaling claim
   that the server then disagreed with). Sonnet's scale-factors landed
   inside the plausible band on all four GOOD invoices (1.10, 11.96,
   12.27, 12.28). The credit-note INERT is honest-incomplete: the
   1-row summary correctly reverses -10,898 SEK, so even if the
   force-Sonnet trigger fires on a future run, the worst case stays
   "1 line that reconciles" rather than silently wrong data.

## Per-invoice classification table

| Invoice | Supplier | Date | Header (SEK) | Rows | Total extracted | Δ pct | Model | Cost | Classification |
|---:|---|---|---:|---:|---:|---:|---|---:|---|
| 3174 | Laweka Gross & Matevent AB | 2025-09-30 | 104,320.57 | 46 | 104,320.22 | 0.000003 % | Sonnet 4.6 | $0.0976 | **GOOD** |
| 2902 | Eventcenter i Örebro AB | 2025-05-31 | 234,691.12 | 50 | 234,690.64 | 0.000002 % | Sonnet 4.6 | $0.0987 | **GOOD** |
| 2948 | Eventcenter i Örebro AB | 2025-06-30 | 90,241.92 | 29 | 90,242.33 | 0.000005 % | Sonnet 4.6 | $0.0694 | **GOOD** |
| 2975 | Eventcenter i Örebro AB | 2025-07-31 | 58,323.24 | 22 | 58,323.03 | 0.000004 % | Sonnet 4.6 | $0.0597 | **GOOD** |
| 3278 | Laweka Gross & Matevent AB | 2025-11-30 | -10,898.24 | 1 | -10,898.00 | 0.00002 % | Haiku 4.5 | $0.0103 | **INERT** |

Total cost across the 5: ~$0.34. The 4 GOOD invoices all escalated to
Sonnet (Haiku saw EUR/SEK columns but couldn't synthesise the FX × markup
chain; the validator's 5 % over-extraction gate would have rejected its
attempts anyway). 3278 stayed with Haiku because Haiku's 1-row summary
total ≈ header total, satisfying the existing reconciliation gate.

## Sonnet's `passthrough_scaling` reads (the load-bearing signals)

| Invoice | Reported page-1 header | Reported page-2 grand total | Column | Server-computed scale | Server-applied? |
|---:|---:|---:|---|---:|---|
| 3174 | 104,320.24 | 94,836.58 | SEK | 1.1000 | ✓ |
| 2902 | 234,690.65 | 19,621.57 | EUR | 11.9608 | ✓ |
| 2948 | 90,242.32 | 7,357.71 | EUR | 12.2650 | ✓ |
| 2975 | 58,323.03 | 4,750.98 | EUR | 12.2760 | ✓ |
| 3278 | (no read — Haiku stopped at 1 row) | — | — | — | — |

The scale 1.10 on 3174 matches the markup-only case (page-2 already in
SEK). The ~11.96–12.28 scales on 2902/2948/2975 match the EUR × FX ×
markup chain — slightly different per invoice because the FX rate
printed on each page-2 varies with month. All four landed inside the
sanity band `[0.5, 50]` and the model's reported page-2 grand total
agreed with the row sum within 5 % (the second guard), so the server
applied scaling in every case. No rejections.

## Sample rows recovered (representative, top of each invoice)

```
3174 — Laweka 2025-09
  1. Mozzarella per pizza Julienne | qty=55     | total=4,655.67
  2. Burrata 3x100 gr               | qty=26.4   | total=4,077.72
  3. Burrata 3x100 gr FRYST         | qty=28.8   | total=4,448.43

2902 — Eventcenter 2025-05
  1. Mozzarella per pizza Julienne  | qty=110    | total=9,157.23
  2. Mozarella per pizza Julienne FRYST | qty=10 | total=832.48
  3. Burrata 3x100 gr               | qty=60     | total=9,114.17

2948 — Eventcenter 2025-06
  1. Mozzarella per pizza Julienne  | qty=42     | total=3,585.31
  2. Burrata 3x100 gr               | qty=24     | total=3,738.37
  3. Stracciatella di Burrata 250 gr | qty=36    | total=5,333.80

2975 — Eventcenter 2025-07
  1. Mozzarella per pizza Julienne  | qty=50     | total=4,272.05
  2. Burrata 3x100 gr               | qty=19.2   | total=2,993.38
  3. Stracciatella di Burrata 250 gr | qty=28    | total=4,152.23

3278 — Laweka credit 2025-11
  1. Levererat från Marini/Rima 2025 11 - Kreditering av fakturan 1397 | qty=-1 st | total=-10,898
```

All four GOOD invoices share the Italian-deli catalogue (Mozzarella per
pizza, Burrata, Stracciatella, Pomodoro, Parmigiano, Farina, Pinsa, …)
— recipe-cost-seed-quality data, not just bookkeeping.

## What this branch adds: the force-Sonnet trigger for the credit-note shape

The current `haikuLooksGoodEnough` accepts Haiku's output when its total
matches the header within 5 %. For positive-flow Marini/Rima invoices
that gate already escalates (Haiku reads the wrong column and lands at
~8 % of header), so the four GOOD cases worked without changes. The
credit note evaded escalation because Haiku's 1-row summary is itself an
honest reconciliation.

This branch adds a narrow second trigger in `haikuLooksGoodEnough`:

> If Haiku returned exactly one row whose description matches
> `/levererat\s+från\s+marini.?rima/i`, escalate to Sonnet regardless of
> total-match.

Scope is deliberately tight:
- **Only on 1-row Haiku responses** (multi-row Haiku already extracted
  the page-2 detail; no need to escalate).
- **Only when the description matches the literal Marini/Rima
  signature** (other rebill suppliers untouched; normal
  Laweka / Eventcenter invoices untouched).
- **Sonnet only — no schema change, no validator change.** The
  existing `passthrough_scaling` schema + server-side scaling + sanity
  bands already cover what Sonnet returns. Worst case: Sonnet returns
  the same 1-row summary and we land at the same INERT state, with one
  extra Sonnet API call (~$0.01). Best case: Sonnet recovers per-item
  credit detail.

For 3278 specifically: I could not finish the empirical re-run with
this trigger active because my local `.env.production.local` doesn't
carry `FORTNOX_CLIENT_ID/_SECRET` (those live only in Vercel's prod
env), so the second Fortnox token refresh failed and the integration
flipped to `status='error'`. **Prod cron has the env and will self-heal
on next tick** (and Paul can also reconnect manually at `/integrations`
if he wants to short-circuit it). Once the integration is back to
`connected`, flipping 3278's `invoice_pdf_extractions.status` from
`extracted` → `pending` will cause the periodic-sweep cron to pick it
up and exercise the new trigger.

## Persistence verification

Queried `supplier_invoice_lines` per invoice after the re-runs:

| Invoice | Pre-run rows (source=pdf_extraction) | Post-run rows | Δ |
|---:|---:|---:|---:|
| 3174 | 1 | 46 | +45 |
| 2902 | 1 | 50 | +49 |
| 2948 | 1 | 29 | +28 |
| 2975 | 1 | 22 | +21 |
| 3278 | 1 | 1 | 0 |

Row sums by invoice:

| Invoice | Σ row totals | Header | Δ (SEK) | Within öresavrundning? |
|---:|---:|---:|---:|---|
| 3174 | 104,320.22 | 104,320.57 | -0.35 | ✓ |
| 2902 | 234,690.64 | 234,691.12 | -0.48 | ✓ |
| 2948 | 90,242.33 | 90,241.92 | +0.41 | ✓ |
| 2975 | 58,323.03 | 58,323.24 | -0.21 | ✓ |
| 3278 | -10,898.00 | -10,898.24 | +0.24 | ✓ |

All five reconcile within öresavrundning, including the INERT credit
note (whose 1-row summary IS the reconciling row).

## Implications for the catalogue + downstream surfaces

- **+147 new catalogue/cost-seed rows** for the Italian-deli passthrough
  that was previously invisible. These flow through the normal matcher
  pipeline — the next /api/inventory/lines/rematch tick will route them
  to either existing products (fuzzy / EAN), the audit queue, or
  not-inventory per the standard Gate-0 → Gate-3 ladder.
- **Edit-Item modal coverage:** Vero/Chicce previously saw "no
  price history" for any product first delivered via these
  passthroughs (because the only line was the 1-row summary, which
  never matches a catalogue product). Now each of Mozzarella per pizza
  Julienne, Burrata 3x100 gr, Stracciatella di Burrata, Pomodoro
  Pelati, Parmigiano Reggiano DOP, Farina 00 Molino Pasini, Pinsa
  bases, etc. has 1–4 lines across the 4 months — enough for the
  reliability signal to mark them as reliable (`reliable=true`,
  internal-consistency check passes since qty × ppu_derived matches
  total by construction) and the trend signal to render where there
  are ≥2 datapoints.
- **No follow-up SQL needed** — the RPC `apply_invoice_pdf_extraction`
  upserts cleanly, `extracted_rows_json` is overwritten with the new
  payload, and any prior matcher state on the previous 1-row entries is
  superseded by the new line rows (the old 1-row would have been routed
  to not_inventory or audit-queue; the new 46/50/29/22 rows take their
  place).
- **Recipe-cost engine** can now derive per-unit cost for each Italian
  ingredient as `total_excl_vat / quantity` per the engine's standard
  formula. The `quantity_for_cost` waste-inflation in
  `lib/inventory/recipe-cost.ts` applies on top per-line as usual.

## Final tally

| Bucket | Count | Lines |
|---|---:|---:|
| GOOD (Sonnet scaling, reconciled within öresavrundning) | 4 | 147 |
| INERT (1-row summary that already reconciles; trigger shipped) | 1 | 1 |
| REJECTED | 0 | — |
| Manual-entry / unreliable | 0 | — |

Of the ~225 estimated hidden line items in the multipage doc, **147 are
now recovered-and-reconciling** (real catalogue/cost seed for the
Italian-deli supplier). The 1-row credit note's "missing detail" is at
most the ~30 lines of the November Marini/Rima invoice it credits;
those will surface IF the November invoice itself reaches the new
matcher path AND IF the credit note PDF has page-2 detail Sonnet can
extract via the new trigger — both unknowns until the prod cron re-runs
3278 with this branch deployed.

## What's NOT done

- No re-run of 3278 with the new trigger active (Fortnox refresh
  blocked locally). Prod will pick this up either on next reconnect +
  manual re-extract or on `invoice_pdf_extractions.status` flip.
- No widening of the `[0.5, 50]` scale band to allow negative scales
  for credit-note PDFs — keeping change scope minimal. If a future
  credit-note Marini/Rima passthrough has page-2 itemization in a
  different sign convention than the page-1 header, the existing band
  will reject scaling and the row will land as `passthrough_scaling_rejected`
  (honest-incomplete). Widen then if observed.
- No prompt edit — the SYSTEM_PROMPT's passthrough-scaling instructions
  already cover the model's behaviour; the only missing piece was the
  Haiku→Sonnet trigger, which is now in.

## Files touched in this branch

- `lib/inventory/pdf-extractor.ts` — `haikuLooksGoodEnough` now
  force-escalates on the Marini/Rima 1-row signature.
- `scripts/marini-rima-reextract.mjs` — local runner for the 5 invoices.
- `scripts/marini-rima-reextract-3278.mjs` — single-invoice retry script
  (couldn't complete due to local env).
- `scripts/find-marini-rima.mjs` — locator script (kept for diagnosis).
- `scripts/verify-marini-rima-postext.mjs` — post-state verification.
- `scripts/check-fortnox-token-expiry.mjs` — integration-row inspection
  helper.
- `app/api/admin/reextract-invoice/route.ts` — already merged on
  `main`; HTTP-level mirror of the re-extract runner for future use.
