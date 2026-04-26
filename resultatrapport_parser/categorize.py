"""
Categorize Resultatrapport rows by VAT rate and account number.

Designed to be column-agnostic — works equally well with the 13-column yearly
format and the 3-column monthly format. The same CATEGORY_MAP applies to both.

See CLAUDE.md for the rules. Short version:
  • 12 % VAT → food
  • 25 % VAT → drinks (alcohol)
  • Wolt / Foodora (3072) → takeaway, with platform commission in 6050
"""

from __future__ import annotations

# account → (bucket, category)
CATEGORY_MAP: dict[str, tuple[str, str]] = {
    # Revenue
    "3010": ("revenue", "food"),      # Avdrag mat personal — staff meal value
    "3051": ("revenue", "drinks"),    # 25% VAT — alcohol & other 25%-rated
    "3052": ("revenue", "food"),      # 12% VAT — dine-in food
    "3072": ("revenue", "takeaway"),  # Wolt / Foodora
    "3740": ("revenue", "rounding"),  # Öres- och kronutjämning

    # Cost of goods
    "4000": ("cogs", "food"),         # Inköp varor från Sverige
    "4010": ("cogs", "food"),         # General/food inventory  (caveat below)
    "4011": ("cogs", "drinks"),       # Alcohol inventory
    "6050": ("cogs", "takeaway"),     # Platform commission
}

CATEGORIES = ["food", "drinks", "takeaway"]


def categorize(rows: list[dict], columns: list[str]) -> dict[tuple[str, str], dict[str, float]]:
    """Aggregate categorized rows into {(bucket, category): {col: value}}."""
    agg: dict[tuple[str, str], dict[str, float]] = {}
    for r in rows:
        key = CATEGORY_MAP.get(r["account"])
        if not key:
            continue
        agg.setdefault(key, {c: 0.0 for c in columns})
        for c in columns:
            v = r["values"].get(c)
            if v is not None:
                agg[key][c] += v
    return agg


def gross_margin(agg, columns) -> dict[str, dict[str, tuple[float, float, float, float | None]]]:
    """Per-category, per-column: (revenue, cogs, gross, margin_pct).

    NOTE: cogs is signed negative in the source data, so gross margin is
    revenue + cogs (not revenue - cogs). See CLAUDE.md.
    """
    out: dict[str, dict[str, tuple[float, float, float, float | None]]] = {}
    for cat in CATEGORIES:
        out[cat] = {}
        for c in columns:
            rev = agg.get(("revenue", cat), {}).get(c, 0.0)
            cog = agg.get(("cogs", cat), {}).get(c, 0.0)
            gm = rev + cog
            pct = (gm / rev * 100) if rev else None
            out[cat][c] = (rev, cog, gm, pct)
    return out


def reconcile(rows: list[dict], agg, columns: list[str], tolerance: float = 0.05):
    """Cross-check categorized revenue against `Summa nettoomsättning` row.

    Returns (ok: bool, results: list[dict]). `ok` is True iff every column
    reconciles within tolerance. Always call this before trusting output.
    """
    summa = next(
        (r for r in rows if r["label"].startswith("Summa nettoomsättning")),
        None,
    )
    if not summa:
        return False, [{"error": "Summa nettoomsättning row not found"}]

    results = []
    all_ok = True
    for c in columns:
        target = summa["values"].get(c) or 0.0
        computed = sum(
            agg.get(("revenue", cat), {}).get(c, 0.0)
            for cat in CATEGORIES + ["rounding"]
        )
        diff = computed - target
        ok = abs(diff) < tolerance
        all_ok &= ok
        results.append({
            "column": c,
            "computed": round(computed, 2),
            "target": round(target, 2),
            "diff": round(diff, 2),
            "ok": ok,
        })
    return all_ok, results
