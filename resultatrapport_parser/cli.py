"""
Command-line interface for the Resultatrapport parser.

Usage:
    python cli.py path/to/report.pdf
    python cli.py path/to/report.pdf --validate-only
    python cli.py path/to/report.pdf --csv out.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import sys

from extract import extract
from categorize import categorize, gross_margin, reconcile, CATEGORIES


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse a Swedish Resultatrapport PDF.")
    parser.add_argument("pdf", help="Path to the Resultatrapport PDF.")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only run reconciliation. Exit 0 if clean, non-zero otherwise.",
    )
    parser.add_argument(
        "--csv",
        metavar="PATH",
        help="Also write categorized aggregates as CSV to this path.",
    )
    args = parser.parse_args()

    try:
        rows, columns = extract(args.pdf)
    except Exception as exc:
        print(f"ERROR: extraction failed: {exc}", file=sys.stderr)
        return 2

    agg = categorize(rows, columns)
    ok, recon = reconcile(rows, agg, columns)

    if args.validate_only:
        for r in recon:
            print(
                f"{r['column']:<14}  computed={r['computed']:>14.2f}  "
                f"target={r['target']:>14.2f}  diff={r['diff']:>+8.2f}  "
                f"{'✓' if r['ok'] else '✗'}"
            )
        return 0 if ok else 1

    margins = gross_margin(agg, columns)

    output = {
        "format": _format_label(columns),
        "columns": columns,
        "row_count": len(rows),
        "reconciliation": {"ok": ok, "details": recon},
        "revenue_by_category": {
            cat: {c: round(agg.get(("revenue", cat), {}).get(c, 0.0), 2)
                  for c in columns}
            for cat in CATEGORIES + ["rounding"]
        },
        "cogs_by_category": {
            cat: {c: round(agg.get(("cogs", cat), {}).get(c, 0.0), 2)
                  for c in columns}
            for cat in CATEGORIES
        },
        "gross_margin_pct_by_category": {
            cat: {
                c: (round(margins[cat][c][3], 2)
                    if margins[cat][c][3] is not None else None)
                for c in columns
            }
            for cat in CATEGORIES
        },
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))

    if args.csv:
        _write_csv(args.csv, agg, margins, columns)
        print(f"\nWrote {args.csv}", file=sys.stderr)

    return 0 if ok else 1


def _format_label(columns: list[str]) -> str:
    if columns and columns[0].startswith("25") and len(columns) >= 13:
        return "yearly_per_month"
    if "ackumulerat" in columns:
        return "monthly_per_period"
    return "unknown"


def _write_csv(path: str, agg, margins, columns: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["bucket", "category"] + columns)
        for (bucket, cat), vals in sorted(agg.items()):
            w.writerow([bucket, cat] + [round(vals[c], 2) for c in columns])
        w.writerow([])
        w.writerow(["margin_%", "category"] + columns)
        for cat in CATEGORIES:
            row = ["", cat]
            for c in columns:
                pct = margins[cat][c][3]
                row.append(round(pct, 1) if pct is not None else "")
            w.writerow(row)


if __name__ == "__main__":
    sys.exit(main())
