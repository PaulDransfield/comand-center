"""
Format-agnostic extractor for Swedish Resultatrapport PDFs (Visma export).

Auto-detects two layouts:
  • Yearly per-month: 13 columns (2501..2512 + Ack), values in tkr
  • Monthly:           3 columns (period / ackumulerat / period_fg_år), values in kr

Public API:
    extract(pdf_path) -> (rows, columns)
        rows    = [{"account": str, "label": str, "values": {col: float|None}}]
        columns = ordered list of column labels detected from the header

See CLAUDE.md for the full rules. The short version:
  1. Get word coordinates (don't use extract_text).
  2. Detect column right-edges from the header row.
  3. Bucket numeric tokens into columns by x1 (handles thousand-space orphans).
  4. Group by row using the label's y-position (handles vertical wraps).
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Optional

import pdfplumber


# Header tokens that uniquely identify the yearly per-month format.
YEARLY_MONTH_TOKENS = {
    "2501", "2502", "2503", "2504", "2505", "2506",
    "2507", "2508", "2509", "2510", "2511", "2512", "Ack",
}

# Matches a Swedish numeric token: optional minus, digits, optional decimals.
# The thousand-separator space splits a number into multiple such tokens.
NUM_RE = re.compile(r"^-?\d+(?:,\d+)?$")

# Page-header text that may otherwise be picked up as a row label.
HEADER_PREFIXES = (
    "Period 20",        # "Period 2026-02-01 - 2026-02-28"
    "Räkenskapsår",
    "Utskrivet",
    "Senaste vernr",
    "VERO",             # company name
    "Belopp",           # "Belopp uttrycks i tusentals kronor"
    "Resultatrapport",
)


def parse_swedish_number(s: str) -> float:
    """'1 207,3' -> 1207.3, '-89,80' -> -89.80, '1 985 188,80' -> 1985188.80"""
    return float(s.replace(" ", "").replace(",", "."))


def detect_columns(page) -> Optional[list[tuple[float, float, str]]]:
    """Auto-detect value-column intervals from the header row.

    Returns [(prev_x1, this_x1, label)] sorted left to right, or None
    if no recognizable header is found.
    """
    words = page.extract_words()

    def _intervals_from_rights(rights_labels: list[tuple[float, str]]):
        """Build intervals from a list of (right_edge_x1, label) pairs."""
        rights_labels = sorted(rights_labels)
        if len(rights_labels) > 1:
            spacings = [
                rights_labels[i + 1][0] - rights_labels[i][0]
                for i in range(len(rights_labels) - 1)
            ]
            avg_w = sum(spacings) / len(spacings)
        else:
            avg_w = 50  # fallback; unused with multi-column reports
        intervals = []
        # First column's lower bound is set one column-width to the left
        # of its right edge — wide enough to capture orphan thousand-prefix
        # tokens, narrow enough to exclude account numbers (far left).
        prev = rights_labels[0][0] - avg_w
        for x1, label in rights_labels:
            intervals.append((prev, x1, label))
            prev = x1
        return intervals

    # --- Format A: yearly per-month ---
    yearly = [
        (w["x1"], w["text"]) for w in words
        if w["text"] in YEARLY_MONTH_TOKENS and w["top"] < 100
    ]
    if len(yearly) >= 5:
        return _intervals_from_rights(yearly)

    # --- Format B: monthly per-period ---
    # Anchor on "Ackumulerat" — present in this format and not the yearly.
    ack = next((w for w in words if w["text"] == "Ackumulerat"), None)
    if not ack:
        return None

    header_top = ack["top"]
    header_words = sorted(
        [w for w in words if abs(w["top"] - header_top) < 3 and w["x0"] > 300],
        key=lambda w: w["x0"],
    )
    # Cluster header tokens into column groups by horizontal gaps.
    # ("Period fg år" is three words; "Period" and "Ackumulerat" are one each.)
    groups, cur = [], []
    for w in header_words:
        if cur and w["x0"] - cur[-1]["x1"] > 15:
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)

    rights_labels = []
    for g in groups:
        right = max(w["x1"] for w in g)
        label = "_".join(w["text"] for w in g).lower()
        rights_labels.append((right, label))
    return _intervals_from_rights(rights_labels)


def assign_to_column(word, intervals, slack: float = 3.0) -> Optional[str]:
    """First column whose right edge >= word's right edge (within slack)."""
    wx1 = word["x1"]
    for low_x1, high_x1, label in intervals:
        if low_x1 < wx1 <= high_x1 + slack:
            return label
    return None


def extract(pdf_path: str) -> tuple[list[dict], list[str]]:
    """Extract a Resultatrapport PDF.

    Returns (rows, columns).
    Raises ValueError if no recognizable format is detected.
    """
    rows = []
    columns: Optional[list[str]] = None

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            intervals = detect_columns(page)
            if not intervals:
                continue

            page_columns = [iv[2] for iv in intervals]
            if columns is None:
                columns = page_columns

            top_max = page.height - 15  # exclude footer line ('1/4', '2/2', …)
            words = page.extract_words()

            label_words: list[dict] = []
            value_words: list[tuple[float, str, float, str]] = []

            for w in words:
                # Skip the yearly-format header tokens at top of page
                if w["text"] in YEARLY_MONTH_TOKENS and w["top"] < 100:
                    continue
                # Skip page header / footer
                if w["top"] < 95 or w["top"] > top_max:
                    continue

                if NUM_RE.match(w["text"]):
                    col = assign_to_column(w, intervals)
                    if col:
                        value_words.append((w["top"], col, w["x0"], w["text"]))
                    else:
                        # Numeric word outside the value zone (typically a
                        # 4-digit account number). Anchor it as part of the
                        # row label so the row is preserved.
                        label_words.append(w)
                else:
                    label_words.append(w)

            # Group label words into rows by `top` (one PDF visual line each).
            label_words.sort(key=lambda w: (w["top"], w["x0"]))
            row_anchors: list[tuple[float, str]] = []
            current_top, current_parts = None, []
            for w in label_words:
                if current_top is None or abs(w["top"] - current_top) > 3:
                    if current_parts:
                        row_anchors.append((current_top, " ".join(current_parts)))
                    current_top, current_parts = w["top"], [w["text"]]
                else:
                    current_parts.append(w["text"])
            if current_parts:
                row_anchors.append((current_top, " ".join(current_parts)))

            # Build a row record for each anchor that has values nearby.
            for top, label in row_anchors:
                if any(label.startswith(p) for p in HEADER_PREFIXES):
                    continue
                if label == "Period Ackumulerat Period fg år":
                    continue

                bucket: dict[str, list[tuple[float, float, str]]] = defaultdict(list)
                for vtop, col, x0, text in value_words:
                    if abs(vtop - top) <= 8:  # ±8 pt absorbs vertical wraps
                        bucket[col].append((x0, vtop, text))

                if not bucket:
                    continue  # heading-only row (e.g. "RÖRELSENS INTÄKTER")

                values: dict[str, Optional[float]] = {}
                for col in page_columns:
                    parts = bucket.get(col, [])
                    if not parts:
                        values[col] = None
                        continue
                    # Sort by visual order: y first (handles wrap), then x.
                    parts.sort(key=lambda t: (round(t[1], 0), t[0]))
                    joined = " ".join(p[2] for p in parts)
                    values[col] = parse_swedish_number(joined)

                # Pull leading 3-4 digit account number out of the label.
                m = re.match(r"^(\d{3,4})\s+(.*)$", label)
                if m:
                    account, name = m.group(1), m.group(2)
                else:
                    account, name = "", label

                rows.append({"account": account, "label": name, "values": values})

    if columns is None:
        raise ValueError(
            f"Could not detect a Resultatrapport format in {pdf_path}. "
            "Expected either yearly (2501..2512 + Ack) or monthly "
            "(Period / Ackumulerat / Period fg år) headers."
        )
    return rows, columns
