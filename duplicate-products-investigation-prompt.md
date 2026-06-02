# Claude Code — Duplicate Products & Stranded Costs (READ-ONLY investigation)

## Purpose

The link-picker fix surfaced that **19 burrata supplier lines at Chicce are matched to 6 separate products** ("Burrata 125g", "Mozzarella Burrata 8x125g", "Burrata 3x100 gr", "Burrata 3x100 gr FRYST", "Stracciatella di Burrata 250g", "Stracciatella di Burrata 250 gr") — roughly 2 real items (burrata, stracciatella) fragmented across 6 catalogue entries because the same item arrived under varying invoice descriptions and each spawned its own product.

This likely isn't unique to burrata — it's probably a **pattern**, and it matters beyond tidiness: if a recipe links to one fragment ("Burrata 125g") while recent invoices landed on another ("Mozzarella Burrata 8x125g"), the recipe costs off a product with no recent price **while the actual price sits on a different fragment**. So some "incomplete cost" recipes may not be missing data — their cost is **stranded on a duplicate they're not linked to**.

**Quantify the fragmentation and, critically, how much of the incomplete-cost problem is actually stranded-cost.** Read-only — diagnose, don't merge.

## HARD RULES
- **READ-ONLY.** `SELECT` / analysis only. No merges, repoints, writes, or migrations.
- Print every query. Bound to characterising shape + magnitude, not enumerating every product.
- Scope: Chicce + Vero `products` / `product_aliases` / `supplier_invoice_lines` / recipes.
- Deliverable: `docs/investigation/duplicate-products.md` + three-line chat summary. **No consolidation performed.**

## Step 1 — Size the fragmentation

1. **Duplicate clusters:** find products that are plausibly the same real item under different names. Heuristics (combine, don't rely on one): products whose aliases trace to the same supplier article code; products with high name-similarity (normalised — strip pack sizes, "FRYST", units, casing); products sharing a normalised description root. Report **how many clusters** and **how many products collapse into them** (e.g. "burrata = 6 products → ~2 real items"). Give the rough catalogue-wide duplicate count per business.
2. **Concentration:** is fragmentation concentrated in a few high-name-variation suppliers (the Italian imports — Laweka/Il Molino with verbose names like "Mozzarella per pizza Julienne" — are prime suspects), or spread evenly? Concentration → a targeted pass; spread → a systematic dedup. This shapes the response.
3. **Severity tiers:** of the duplicate clusters, how many are clean merges (clearly same item) vs ambiguous (e.g. "Burrata 3x100" vs "Burrata 125g" might be genuinely different pack formats of the same product, or different products) — so we don't auto-merge things that are actually distinct.

## Step 2 — The stranded-cost link (the number that matters most)

Connect duplicates to the incomplete-cost recipes:
1. For each recipe currently showing **incomplete cost**, check its ingredients: is any ingredient a product with **no recent price** while a **duplicate of that product DOES have a recent price** (the cost is stranded on a sibling fragment)?
2. **The headline:** of the ~7 Chicce incomplete-cost dishes (and Vero's), **how many would complete** if their ingredient were repointed/consolidated onto the duplicate that holds the recent price? I.e. how much "incomplete cost" is actually "cost stranded on a duplicate" vs genuinely-missing data?
3. This decides priority: if most incomplete-cost dishes are stranded-cost, **dedup is a cost-recovery task** (faster path to complete costs than hunting missing prices). If few, dedup is tidy-up and the incomplete costs are genuinely missing data.

## Step 3 — Response shape (scope, don't build)

- Given Steps 1–2, what's the right response: **manual consolidation via the new picker** (fine for a handful of clusters), or a **systematic dedup pass** (if the count is large)?
- If systematic: what would a safe dedup look like — repoint all a cluster's aliases onto one canonical product, archive the emptied duplicates (archive, never hard-delete — referential integrity), recipes following the canonical product's price. Note the repoint endpoint already does the pointer-move non-destructively + reversibly.
- Flag the ambiguous clusters (Step 1.3) as **manual-decision only** — never auto-merge a "3x100 vs 125g" that might be genuinely distinct pack formats.
- Estimate: if the clean clusters are consolidated, how many incomplete-cost recipes complete, and how many duplicate products disappear from the catalogue.

## Deliverable

`docs/investigation/duplicate-products.md` + three-line chat summary:
1. Fragmentation size — how many duplicate clusters / products collapse, per business, and is it concentrated by supplier or spread;
2. **The stranded-cost number** — of the incomplete-cost recipes, how many would COMPLETE via consolidation (i.e. how much incomplete-cost is actually stranded-on-a-duplicate, not missing data);
3. Response — manual-via-picker (handful) or systematic dedup pass (large), how many ambiguous clusters need manual decision, and the catalogue-cleanup + cost-recovery magnitude if the clean ones are consolidated.

Every query listed. No merges, no writes.
