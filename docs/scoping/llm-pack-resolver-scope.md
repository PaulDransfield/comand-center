# LLM pack-size auto-resolver — Step 0 scope

**Status:** READ-ONLY investigation done 2026-06-02. Recommendation: **don't build the LLM piece yet. The data says this is a deterministic backfill, not an LLM problem.**

---

## The question

When a recipe ingredient renders "Olja Rapsolja 10 liter SE — 222 kr/Kolli, unit: recipe g vs invoice Kolli" — that's red because `pack_size` + `base_unit` aren't set on the product. The owner asked: can an LLM solve cases like this without customer interaction, since the name and price clearly imply the answer?

## Headline findings (diag: `scripts/diag/scope-llm-pack-resolver.mjs`)

| | Chicce | Vero |
|---|---|---|
| Total products | 1,248 | 989 |
| Missing `pack_size` or `base_unit` | 398 (32%) | 302 (31%) |
| ↳ Referenced by ≥1 recipe ingredient | **16** | **1** |
| ↳ Causing a UNIT-MISMATCH on a recipe row | **14** | **1** |
| ↳↳ Regex parser would solve right now | 5 | 0 |
| ↳↳ Regex residue (LLM opportunity)  | 9 | 1 |

**Two things to notice:**

1. **The vast majority of pack-less products (398 at Chicce) are catalogue noise — they're not used in any recipe.** The actually-painful set is the 14 mismatched ones. We're optimising for tens of products, not hundreds.

2. **The existing regex parser already solves 5/14 of the live pain at Chicce — including the owner's exact example, "Olja Rapsolja 10 liter SE → 10000 ml".** It's not being applied because nobody re-ran the backfill endpoint after these products were created. **Free win sitting on a shelf.**

## What the residue actually looks like

The 9 Chicce residue products the regex can't catch:

```
• Citron                                              — invoice unit: KG
• Hårdost Pecorino Romano 3k                          — invoice unit: KG
• Råa Vannamei 16/20 u/s IQF *                        — invoice unit: st
• Pepparrot Kg                                        — invoice unit: KG
• Innanlår skinnat Närke Kött                         — invoice unit: kg
• Äpple Granny Smith                                  — invoice unit: KG
• Gurka Kg                                            — invoice unit: KG
• Laxfilé Hiddenfjord färsk / salmo salar / odlad Norge  — invoice unit: kg
• Forellrom *                                         — invoice unit: kg
```

**Look at the invoice units.** 8 of 9 are sold by weight (`KG` / `kg`); 1 is sold by piece (`st`). When the supplier ships by weight, **the pack size IS the unit conversion factor.** "1 KG of citron" doesn't need to "infer" anything — `pack_size = 1000, base_unit = g` is mechanical.

The only one that genuinely needs LLM intelligence is **"Hårdost Pecorino Romano 3k"** — where "3k" probably means 3 kg per piece, not 1 kg per invoice unit. That's a single product. At Chicce. Total.

## Recommendation — two-phase, LLM only at the end

### Phase A (1–2 hours work, deterministic, solves ~13/15 of the live pain):

Two structural fixes, no LLM:

1. **Re-run the existing pack-size backfill** (`/api/inventory/items/backfill-pack-size`) over both businesses. Solves 5 immediately at Chicce (incl. "Olja Rapsolja 10 liter SE").

2. **Extend the parser** to fall back to `invoice_unit` when the name discloses nothing:
   - `invoice_unit ∈ {KG, kg}` → `pack_size=1000, base_unit=g`
   - `invoice_unit ∈ {L, LITER, liter}` → `pack_size=1000, base_unit=ml`
   - `invoice_unit ∈ {ST, STYCK, stk, pcs}` → `pack_size=1, base_unit=st`
   - `invoice_unit ∈ {CL}` → `pack_size=10, base_unit=ml`
   - `invoice_unit ∈ {DL}` → `pack_size=100, base_unit=ml`

   That solves another 8 at Chicce. Total Phase A: 13/14 mismatch products gone.

   Mark the resulting `pack_source = 'invoice_unit_inferred'` so it's auditable. Don't overwrite owner-set values.

### Phase B (deferred, LLM): the 1–2 residue per business

After Phase A ships, what's left is the genuinely ambiguous stuff — "Hårdost Pecorino Romano 3k" — where the LLM has to read intent from the name. **At the current volume that's ~1 product per business.** A Haiku batch sweep over the ungrounded-and-still-recipe-referenced products would cost cents per quarter; could even be a button on the recipes page instead of a cron.

**Honest-incomplete invariant for Phase B:** LLM only sets values when its confidence is high; never overwrites owner-set values; tags `pack_source = 'ai_inferred'` for audit. The Loka-vs-Lokalhyra lesson applies — don't let lexical similarity become a confident-wrong guess.

## Why not just build the LLM piece now?

- **Scale doesn't justify it.** 14 + 1 = 15 ingredient-affecting products across both businesses. Two SQL backfills clear 13 of them.
- **Phase A is the canonical fix.** Phase B is the residue mop-up. Building B first is solving the easy 10% before the structural 90%.
- **The pattern already exists.** Backfill endpoint exists; canonical unit table exists in `lib/inventory/unit-conversion.ts`. Phase A is wiring + a SQL pass.
- **Volume will grow.** As recipes get written and more products land in the catalogue, the residue grows too. By the time it crosses ~50 products per business, Phase B genuinely pays off — and by then Phase A has cleared the deterministic class so we're not asking the LLM to do regex's job.

## Risks of Phase A

| Risk | Mitigation |
|---|---|
| Inferring `pack_size=1000, base_unit=g` from `invoice_unit=KG` is wrong for any case where the supplier actually sells by carton-of-1kg-units. | Per-business invoice volume disagreement is the signal. Easy to spot: cost engine would predict a wildly different total than what's on the invoice. We already flag those (`rebate_guard`-style sanity). Plus: tag `pack_source='invoice_unit_inferred'` so owner can audit a sample. |
| Overwriting an owner-set value that they DELIBERATELY left null because the product is non-standard. | Backfill where `pack_size IS NULL AND base_unit IS NULL` only — never overwrite anything. |
| The `pack_source` column doesn't exist yet. | Adds it as a NULLABLE column in the same SQL migration. Default null = legacy / unknown provenance. |

## Build/no-build call

**Don't build Phase B (LLM) yet.** Re-run the existing backfill + add invoice_unit fallback parser. Reassess after Phase A ships and we count what's actually still red.

If the answer is "still 50+ across the catalogue once recipes scale," Phase B becomes a Haiku-once-a-day cron over `{product_id, name, invoice_unit, sample_supplier_line_text}` → JSON `{pack_size, base_unit, confidence}`. Honest-incomplete on `confidence < 0.85`.

## Deliverables

- This document.
- Diagnostic script committed at `scripts/diag/scope-llm-pack-resolver.mjs` (re-runnable; output above shows the snapshot at 2026-06-02).
- Recommendation: schedule **Phase A as the next inventory ticket**. Phase B is a follow-on only after Phase A's effect is measured.
