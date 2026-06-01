# Claude Code — Verify the Overhead Backfill BEFORE COMMIT (by-spend believability)

## Purpose

The BAS→bucket dictionary build is sound and ready, but before flipping the DRY backfill from ROLLBACK to COMMIT, verify the thing that actually determines whether `/overheads` shows a *true* cost structure: **are the high-spend accounts in the RIGHT buckets.** The honest-incomplete handling protects *unmapped* accounts (null → unchanged), but it does NOT protect against a *confidently-wrong* mapping — an 80-account hand-built dictionary is 80 chances to put one account in the wrong bucket, and a mis-bucketed account doesn't error, it just quietly reports (say) marketing as a utility. The verification is by **spend**, not row count, because the big-ticket accounts (rent, salaries, major COGS) are where a mis-map actually distorts the picture.

Read-only verification + a couple of coherence checks. No COMMIT until this passes — then owner flips to COMMIT and merges.

## Step 1 — By-spend bucket totals (the believability check)

Run the DRY backfill, then produce, **per business (Vero + Chicce)**:
1. **Bucket totals in kronor** (not row counts) — for each of the 24 operator buckets, the total spend that resolved into it. This is the breakdown `/overheads` will show.
2. **The high-spend accounts specifically** — list the top ~15 accounts by spend and the bucket each mapped to. These are the ones that matter; a mis-map here distorts the whole structure.
3. Present it so the owner can eyeball against reality: does **rent** show roughly the rent actually paid (~known monthly figure)? Are **salaries** in `salaries` (not scattered)? Are the big **COGS/food** accounts where they belong? Flag any high-spend account whose bucket looks surprising.

The gate: the large numbers must match what the owner knows these businesses spend. A precise-looking breakdown built on a mis-mapped high-spend account is the confident-wrong-number failure mode — catch it here, where it's a one-line dictionary fix, not after `/overheads` has shown a wrong structure.

## Step 2 — Channel/COGS vs overhead bucket coherence

The bucket list mixes `dine_in` / `takeaway` / `alcohol` (revenue/COGS-channel concepts) with overhead buckets (rent, utilities, consulting, etc.). Confirm this is **deliberate and coherent**, not incidental:
1. Is `/overheads`'s `SubcategoryBreakdown` intended as a **full P&L structure** (revenue + COGS + overheads) or specifically **operating overheads**? 
2. If it's mixing revenue/COGS buckets with cost buckets, confirm the surface presents them coherently — e.g. it does NOT sum a revenue bucket and a cost bucket into one misleading total, and the breakdown reads sensibly (sections, signs, grouping).
3. If the mix is incoherent on the surface (revenue and cost commingled in one rollup), flag it — the dictionary may be correct but the *presentation* needs the buckets grouped (income vs COGS vs overhead) rather than flat-listed.

Report whether the channel/COGS + overhead mix renders as a sensible structure or needs grouping.

## Step 3 — Spot-check the long tail of the mapping

Beyond the high-spend accounts:
1. List any accounts that mapped to `other` / `uncategorised` — are any of those actually mappable (a bucket exists, the dictionary just missed it)? Cheap accuracy win.
2. Confirm no account is in an obviously wrong bucket (a quick scan of all 80 → bucket pairs for anything that reads wrong, even low-spend).
3. Confirm any per-business-divergent account (if Step 0 of the build flagged one used differently at Vero vs Chicce) is handled per-business, not globally mis-applied.

## Step 4 — Confirm mechanics before COMMIT

- DRY shows the resolved counts + the by-spend totals above; nothing written yet (ROLLBACK).
- Idempotent (re-run = no-op), business-scoped, ownership-checked, additive, honest-incomplete preserved (no account → stays null).
- The persistent rule (both annual + monthly insert sites in `app/api/fortnox/apply`) uses the same dictionary, so future uploads bucket consistently with the backfill.

## Deliverable

A verification block: per-business by-spend bucket totals, the top-15-accounts→bucket table, the channel/COGS-vs-overhead coherence verdict, any long-tail mapping fixes, and a clear **go/no-go for COMMIT**.

Three-line chat summary: (1) do the high-spend buckets (rent, salaries, COGS) match reality by kronor, or is any big account mis-mapped; (2) does the dine_in/takeaway/alcohol + overhead mix render as a coherent structure on `/overheads` or need grouping; (3) go/no-go — any one-line dictionary fixes needed before the owner flips ROLLBACK→COMMIT and merges.
