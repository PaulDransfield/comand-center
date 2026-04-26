"""
End-to-end smoke tests for the Resultatrapport parser.

Run with: python tests/test_smoke.py
Exit code 0 = all green, non-zero = something regressed.

If you add a fix or a new mapping, add an assertion here so the next agent
can't reintroduce the bug.
"""

import os
import sys
from pathlib import Path

# Make sibling modules importable when running this file directly
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from extract import extract
from categorize import categorize, reconcile
from tests.expected import (
    YEARLY_BERAKNAT, YEARLY_NETTO_BY_MONTH, MONTHLY_NETTO,
)


# Path to test PDFs — override with TEST_PDF_DIR env var when running locally.
PDF_DIR = Path(os.environ.get("TEST_PDF_DIR", "/mnt/user-data/uploads"))
PDF_YEARLY  = PDF_DIR / "Resultatrapport_2025_12_mån__1_.pdf"
PDF_MONTHLY = PDF_DIR / "Resultatrapport_2602.pdf"


def _check(label: str, condition: bool, detail: str = "") -> bool:
    mark = "✓" if condition else "✗"
    print(f"  {mark} {label}{(' — ' + detail) if detail else ''}")
    return condition


def test_yearly_format():
    print(f"\n[Format A] {PDF_YEARLY.name}")
    rows, columns = extract(str(PDF_YEARLY))
    ok = True

    ok &= _check(
        "13 columns detected (12 months + Ack)",
        columns == ["2501","2502","2503","2504","2505","2506",
                    "2507","2508","2509","2510","2511","2512","Ack"],
    )
    ok &= _check("at least 70 rows extracted", len(rows) >= 70,
                 f"got {len(rows)}")

    # Revenue reconciliation
    agg = categorize(rows, columns)
    recon_ok, recon = reconcile(rows, agg, columns)
    ok &= _check("revenue reconciliation passes", recon_ok)

    for r in recon:
        target = YEARLY_NETTO_BY_MONTH.get(r["column"])
        ok &= _check(
            f"netto target matches expected for {r['column']}",
            abs(r["target"] - target) < 0.05,
            f"target={r['target']} expected={target}",
        )

    # Stronger check: sum of all leaf accounts (incl. 8999) matches BERÄKNAT.
    monthly_sum = {c: 0.0 for c in columns}
    for r in rows:
        if not r["account"].isdigit():
            continue
        if r["label"].startswith(("Summa", "BERÄKNAT")):
            continue
        for c in columns:
            v = r["values"].get(c)
            if v is not None:
                monthly_sum[c] += v
    for col, expected in YEARLY_BERAKNAT.items():
        ok &= _check(
            f"BERÄKNAT cross-check for {col}",
            abs(round(monthly_sum[col], 1) - expected) < 0.05,
            f"computed={round(monthly_sum[col], 1)} expected={expected}",
        )
    return ok


def test_monthly_format():
    print(f"\n[Format B] {PDF_MONTHLY.name}")
    rows, columns = extract(str(PDF_MONTHLY))
    ok = True

    ok &= _check(
        "3 columns detected (period / ackumulerat / period_fg_år)",
        set(columns) == {"period", "ackumulerat", "period_fg_år"},
    )

    agg = categorize(rows, columns)
    recon_ok, recon = reconcile(rows, agg, columns)
    ok &= _check("revenue reconciliation passes", recon_ok)

    for r in recon:
        expected = MONTHLY_NETTO[r["column"]]
        ok &= _check(
            f"netto target matches expected for {r['column']}",
            abs(r["target"] - expected) < 0.05,
            f"target={r['target']} expected={expected}",
        )

    # Account 3010 (Avdrag mat personal) is new in 2026 — verify it parses.
    ok &= _check(
        "account 3010 (Avdrag mat personal) is captured",
        any(r["account"] == "3010" for r in rows),
    )
    return ok


def test_cross_format_consistency():
    """Format-A column 2502 should match Format-B period_fg_år, ~tkr precision."""
    print("\n[Cross-format consistency: Feb 2025 = Format-B period_fg_år]")
    yearly_rows, _  = extract(str(PDF_YEARLY))
    monthly_rows, _ = extract(str(PDF_MONTHLY))
    ok = True

    # Compare a couple of revenue rows
    for acc in ("3051", "3052"):
        ya = next((r for r in yearly_rows  if r["account"] == acc), None)
        mo = next((r for r in monthly_rows if r["account"] == acc), None)
        if not ya or not mo:
            ok &= _check(f"both files contain {acc}", False)
            continue
        # Yearly is in tkr, monthly in kr — convert.
        yearly_kr = ya["values"]["2502"] * 1000.0
        monthly_kr = mo["values"]["period_fg_år"]
        # Allow up to 500 SEK rounding error (tkr is rounded to 0.1 tkr = 100 SEK,
        # so worst-case difference is ~50 SEK; allow 500 for safety).
        ok &= _check(
            f"account {acc}: 2502 ≈ period_fg_år",
            abs(yearly_kr - monthly_kr) < 500,
            f"yearly_kr={yearly_kr:.2f} monthly_kr={monthly_kr:.2f}",
        )
    return ok


if __name__ == "__main__":
    results = [
        test_yearly_format(),
        test_monthly_format(),
        test_cross_format_consistency(),
    ]
    if all(results):
        print("\nALL TESTS PASS")
        sys.exit(0)
    else:
        print("\nFAILURES PRESENT")
        sys.exit(1)
