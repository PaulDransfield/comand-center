# Claude Code — VAT Channel-Misrouting: Did the Hotfix Ship, and Is It Still Firing? (READ-ONLY)

## Purpose

Weeks ago we **confirmed a live bug**: code infers sales channel from VAT rate, so generic 6% food revenue (e.g. Vero's account 3053 "Försäljning varor 6% moms Sv") is mis-bucketed into `takeaway_revenue` (~48,468 SEK, April, still firing daily as of the verdict). A fix was scoped (`lib/sweden/vat.ts` + remove VAT→channel inference at four sites + rewrite the AI system prompt + re-derive affected periods). The conversation then moved to the learning loop and **never confirmed the fix shipped.**

Before any other pipeline work: **establish whether the hotfix is live, and whether the bug is still misrouting revenue today.** This is the one piece of potentially-live customer-facing wrongness outstanding.

This is a **READ-ONLY status check.** Determine state; fix nothing. If it's still firing, we scope the remediation as a separate, deliberate step.

## HARD RULES

- **No writes.** `SELECT` / `git log` / file reads only. No code changes, no migrations, no re-derive, no deploy.
- Print every query and every file/commit reference checked.
- Scope to the live businesses with the exposure: **Vero Italiano** (confirmed affected) and **Chicce** (was clean until its accountant adds a 6% account — check whether that's happened).
- Deliverable: `docs/investigation/vat-hotfix-status.md` + a three-line chat summary. No remediation.

## Part A — Did the fix ship? (code + git)

1. **Does `lib/sweden/vat.ts` exist?** If yes, does it carry the date-effective food-rate logic and the explicit "VAT rate must not infer sales channel" principle? If it doesn't exist, the hotfix almost certainly never shipped.
2. **Check the four known inference sites** for whether VAT→channel was removed:
   - `lib/fortnox/classify.ts` (~119-132, `classifyByVat` — the `6% → takeaway` line)
   - `lib/fortnox/api/voucher-to-aggregator.ts` (~250-256, the live path)
   - `lib/fortnox/resultatrapport-parser.ts` (~696)
   - `app/api/fortnox/extract-worker/route.ts` (~811-816, **and** the system prompt ~387-393 that instructed "6% = takeaway")
   For each: is the VAT→channel inference still present, or replaced by account/platform-keyword/POS-flag channel logic?
3. **Check `lib/pos/personalkollen.ts` (~307-323)** — does it still ignore the POS `is_take_away` flag when a 6% line is present?
4. **git log** the relevant paths for any commit referencing VAT / channel / takeaway / `vat.ts` since the verdict date. Report commit shas + dates, or "no such commit."

## Part B — Is it still firing? (data)

Regardless of code state, check the live data for current misrouting:

1. **Vero `takeaway_revenue`**, monthly, Jan–May 2026: is account 3053 (or any generic 6% food revenue) still landing in `takeaway_revenue`? Is the artificial step at/after April still present?
2. **Vero takeaway %** by month — is it still showing the inflated ~12% (vs the true ~7.8%), or has it corrected?
3. **Chicce** — has its accountant added any 6% revenue account since the verdict? If so, is Chicce now mis-bucketing too (the bug spreading as predicted)?
4. **Most recent ingest** — does the latest daily run still misroute, i.e. is this still happening *today*, not just historically?

## Deliverable — the status verdict

`docs/investigation/vat-hotfix-status.md`:

- **Shipped?** YES / NO / PARTIAL, with the commit evidence (or its absence) and the per-site code state.
- **Still firing?** YES / NO, with current Vero takeaway% and whether the latest ingest misroutes.
- **Spread?** Has Chicce (or any other business) started misrouting since the verdict?
- **If still firing:** the current blast radius (SEK mis-bucketed, periods affected, whether historical rows were ever re-derived) — so we can scope remediation deliberately.
- Every query / commit / file checked. **No fix.**

Three-line chat summary: (1) did the hotfix ship; (2) is the bug still misrouting revenue today; (3) has it spread beyond Vero.
