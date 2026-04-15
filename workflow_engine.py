#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════╗
║  Invoice Workflow Engine — Restaurang Björken                        ║
║                                                                      ║
║  What this does (plain English):                                     ║
║  Watches a folder for new invoices. When one appears, it reads it,  ║
║  pulls out the key numbers, updates your financial tracker, checks  ║
║  for anything unusual, and logs everything.                          ║
║                                                                      ║
║  Think of it as a smart accountant running in the background.        ║
╚══════════════════════════════════════════════════════════════════════╝

Usage:
    python3 workflow_engine.py              # Start watching + web dashboard
    python3 workflow_engine.py --process invoice.txt   # Process one file
    python3 workflow_engine.py --simulate               # Run demo
    python3 workflow_engine.py --status                 # Print current state
"""

import json, re, os, sys, sqlite3, hashlib, threading, time, shutil, argparse
import http.server, urllib.parse, socketserver
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional

# ── PATHS ────────────────────────────────────────────────────────────
BASE     = Path(__file__).parent
CONFIG_F = BASE / "config" / "workflow_config.json"
DB_FILE  = BASE / "db" / "workflow.db"
LOG_FILE = BASE / "logs" / "workflow.log"
INBOX    = BASE / "inbox"
PROCESSED= BASE / "processed"
FLAGGED  = BASE / "flagged"

# ══════════════════════════════════════════════════════════════════════
# MODULE 1 — CONFIGURATION LOADER
# Reads the config/workflow_config.json file.
# You can edit that file to change thresholds without touching code.
# ══════════════════════════════════════════════════════════════════════

def load_config() -> dict:
    """Load and validate configuration. Returns defaults if file missing."""
    if CONFIG_F.exists():
        with open(CONFIG_F) as f:
            return json.load(f)
    # Minimal fallback defaults
    return {
        "thresholds": {"food_pct_warn":31,"food_pct_over":35,"staff_pct_warn":40,
                        "staff_pct_over":50,"rent_pct_warn":13,"rent_pct_over":16,
                        "profit_margin_warn":12,"profit_margin_critical":7,
                        "single_invoice_warn_amount":40000,"price_increase_alert_pct":5},
        "categories":  {"food":["menigo","sysco","livsmedel","råvaror","dryck"],
                        "staff":["lön","personal","arbetsgivaravgift"],
                        "rent": ["hyra","lokal","fastighet","el","vattenfall"],
                        "other":["fortnox","försäkring","telia"]},
        "known_suppliers": {},
        "baseline":    {"revenue":505900,"staff":224978,"food":149300,
                        "rent":64500,"other":28422,"period":"Mars 2026"},
        "reconciliation": {"match_tolerance_sek":1,"payment_warning_days":5,"overdue_flag_days":1},
    }

CFG = load_config()


# ══════════════════════════════════════════════════════════════════════
# MODULE 2 — DATABASE (SQLite)
# SQLite is like a simple spreadsheet that lives in a single file.
# We use it to store every invoice, every notification, and the
# running financial totals. It persists between restarts.
# ══════════════════════════════════════════════════════════════════════

def init_db():
    """Create tables if they don't exist yet."""
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Every processed invoice gets a row here
    c.execute("""CREATE TABLE IF NOT EXISTS invoices (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        file_hash    TEXT UNIQUE,       -- prevents double-processing
        filename     TEXT,
        processed_at TEXT,
        vendor       TEXT,
        invoice_date TEXT,
        due_date     TEXT,
        amount_ex_vat REAL,
        vat_amount    REAL,
        total_inc_vat REAL,
        category     TEXT,
        status       TEXT DEFAULT 'pending',  -- pending/paid/overdue/flagged
        matched_bank_tx TEXT,
        raw_text     TEXT,
        extracted_json TEXT
    )""")

    # Running monthly totals — updated after each invoice
    c.execute("""CREATE TABLE IF NOT EXISTS monthly_totals (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        period   TEXT UNIQUE,
        revenue  REAL DEFAULT 0,
        staff    REAL DEFAULT 0,
        food     REAL DEFAULT 0,
        rent     REAL DEFAULT 0,
        other    REAL DEFAULT 0,
        invoice_count INTEGER DEFAULT 0,
        last_updated  TEXT
    )""")

    # Every alert/notification gets logged here
    c.execute("""CREATE TABLE IF NOT EXISTS notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT,
        level      TEXT,   -- info/warn/alert/critical
        category   TEXT,
        title      TEXT,
        detail     TEXT,
        invoice_id INTEGER,
        acknowledged INTEGER DEFAULT 0
    )""")

    # Reconciliation: match invoices to bank transactions
    c.execute("""CREATE TABLE IF NOT EXISTS bank_transactions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_date     TEXT,
        description TEXT,
        amount      REAL,
        balance     REAL,
        matched_invoice_id INTEGER,
        imported_at TEXT
    )""")

    conn.commit()
    conn.close()


def get_db():
    """Return a database connection. Used as a context manager."""
    return sqlite3.connect(DB_FILE)


def get_current_totals(period: str) -> dict:
    """Read current month totals from DB, or return baseline from config."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT revenue,staff,food,rent,other FROM monthly_totals WHERE period=?",
            (period,)
        ).fetchone()
    if row:
        rev,staff,food,rent,other = row
        tc = staff+food+rent+other
        profit = rev - tc
        return {"revenue":rev,"staff":staff,"food":food,"rent":rent,"other":other,
                "total_costs":tc,"profit":profit,
                "profit_pct": round(profit/rev*100,2) if rev else 0,
                "staff_pct":  round(staff/rev*100,1)  if rev else 0,
                "food_pct":   round(food/rev*100,1)   if rev else 0,
                "rent_pct":   round(rent/rev*100,1)   if rev else 0,
                "other_pct":  round(other/rev*100,1)  if rev else 0}
    # Fall back to config baseline
    b = CFG["baseline"]
    rev = b["revenue"]; staff=b["staff"]; food=b["food"]; rent=b["rent"]; other=b["other"]
    tc = staff+food+rent+other; profit=rev-tc
    return {"revenue":rev,"staff":staff,"food":food,"rent":rent,"other":other,
            "total_costs":tc,"profit":profit,
            "profit_pct": round(profit/rev*100,2),
            "staff_pct":  round(staff/rev*100,1),
            "food_pct":   round(food/rev*100,1),
            "rent_pct":   round(rent/rev*100,1),
            "other_pct":  round(other/rev*100,1)}


def upsert_totals(period: str, category: str, amount: float):
    """Add an invoice amount to the running monthly total."""
    with get_db() as conn:
        conn.execute("""INSERT INTO monthly_totals (period,revenue,staff,food,rent,other,invoice_count,last_updated)
            VALUES (?,0,0,0,0,0,0,?)
            ON CONFLICT(period) DO NOTHING""",
            (period, now_str()))
        if category in ("staff","food","rent","other"):
            conn.execute(f"""UPDATE monthly_totals
                SET {category} = {category} + ?,
                    invoice_count = invoice_count + 1,
                    last_updated = ?
                WHERE period = ?""", (amount, now_str(), period))
        conn.commit()


# ══════════════════════════════════════════════════════════════════════
# MODULE 3 — INVOICE EXTRACTOR
# ══════════════════════════════════════════════════════════════════════

class InvoiceExtractor:
    """
    Reads raw invoice text and pulls out the key fields.
    Uses pattern matching (regex) — no AI needed for structured invoices.
    If Claude API is available, uses it for ambiguous formats.
    """

    # Common Swedish amount patterns — handles: 34 157,00  /  34157.00  /  34 157 kr
    AMOUNT_PATTERNS = [
        r'att betala[:\s]+([0-9\s]+[,\.][0-9]{2})\s*kr',
        r'totalt[:\s]+([0-9\s]+[,\.][0-9]{2})\s*kr',
        r'summa[:\s]+([0-9\s]+[,\.][0-9]{2})\s*kr',
        r'total[:\s]+([0-9\s]+[,\.][0-9]{2})\s*kr',
        r'([0-9]{1,3}(?:\s[0-9]{3})*[,\.][0-9]{2})\s*kr\s*$',
    ]
    DATE_PATTERNS = [
        r'fakturadatum[:\s]+(\d{4}-\d{2}-\d{2})',
        r'datum[:\s]+(\d{4}-\d{2}-\d{2})',
        r'(\d{4}-\d{2}-\d{2})',
    ]
    DUE_PATTERNS = [
        r'förfallodatum[:\s]+(\d{4}-\d{2}-\d{2})',
        r'förfaller[:\s]+(\d{4}-\d{2}-\d{2})',
        r'betalas senast[:\s]+(\d{4}-\d{2}-\d{2})',
    ]
    INV_NUM_PATTERNS = [
        r'fakturanummer[:\s]+([A-Za-z0-9\-]+)',
        r'faktura nr[:\s]+([A-Za-z0-9\-]+)',
        r'faktura[:\s]+([A-Za-z0-9\-]+)',
    ]
    VENDOR_PATTERNS = [
        r'^([A-ZÅÄÖ][A-ZÅÄÖa-zåäö &\.\-]+(?:AB|KB|HB|Inc\.?)?)',
        r'från[:\s]+([^\n]+)',
        r'leverantör[:\s]+([^\n]+)',
    ]

    def extract(self, text: str, filename: str = "") -> dict:
        """Main extraction — returns structured dict from raw invoice text."""
        lower = text.lower()
        result = {
            "vendor":        self._extract_vendor(text),
            "invoice_date":  self._extract_date(lower, self.DATE_PATTERNS),
            "due_date":      self._extract_date(lower, self.DUE_PATTERNS),
            "invoice_number":self._extract_pattern(lower, self.INV_NUM_PATTERNS),
            "amount_ex_vat": 0.0,
            "vat_amount":    0.0,
            "total_inc_vat": 0.0,
            "line_items":    [],
            "raw_text":      text,
            "source_file":   filename,
            "extracted_at":  now_str(),
        }

        # Extract amounts
        result["total_inc_vat"] = self._extract_amount(lower)
        result["vat_amount"]    = self._extract_vat(lower)
        result["amount_ex_vat"] = round(result["total_inc_vat"] - result["vat_amount"], 2)

        # If no inc-vat total found, try ex-vat
        if result["total_inc_vat"] == 0:
            result["amount_ex_vat"] = self._extract_net(lower)
            result["total_inc_vat"] = result["amount_ex_vat"] + result["vat_amount"]

        # Extract line items (tab/semicolon-separated rows)
        result["line_items"] = self._extract_line_items(text)

        return result

    def _extract_vendor(self, text: str) -> str:
        lines = text.strip().split('\n')
        # First non-empty line is usually the vendor name
        for line in lines[:4]:
            line = line.strip()
            if len(line) > 3 and not re.match(r'^\d', line):
                # Clean up — remove "From:" prefix etc.
                line = re.sub(r'^(från|leverantör|avsändare)[:\s]+', '', line, flags=re.I)
                return line[:80]
        # Fallback: match pattern
        return self._extract_pattern(text, self.VENDOR_PATTERNS) or "Unknown vendor"

    def _extract_date(self, text: str, patterns: list) -> Optional[str]:
        for pat in patterns:
            m = re.search(pat, text, re.I)
            if m:
                return m.group(1).strip()
        return None

    def _extract_pattern(self, text: str, patterns: list) -> Optional[str]:
        for pat in patterns:
            m = re.search(pat, text, re.I)
            if m:
                return m.group(1).strip()
        return None

    def _parse_amount(self, s: str) -> float:
        """Convert Swedish number format '34 157,00' → 34157.0"""
        s = s.replace(' ', '').replace('\xa0', '')
        # Determine decimal separator
        if ',' in s and '.' in s:
            if s.rindex(',') > s.rindex('.'):
                s = s.replace('.', '').replace(',', '.')
            else:
                s = s.replace(',', '')
        elif ',' in s:
            # Swedish: 34157,00 → 34157.00
            parts = s.split(',')
            if len(parts[-1]) <= 2:
                s = s.replace(',', '.')
            else:
                s = s.replace(',', '')
        try:
            return float(s)
        except ValueError:
            return 0.0

    def _extract_amount(self, text: str) -> float:
        for pat in self.AMOUNT_PATTERNS:
            m = re.search(pat, text, re.I | re.M)
            if m:
                val = self._parse_amount(m.group(1))
                if val > 0:
                    return val
        return 0.0

    def _extract_vat(self, text: str) -> float:
        for pat in [r'moms\s*(?:25%|12%|6%)?[:\s]+([0-9\s,\.]+)\s*kr',
                    r'mervärdesskatt[:\s]+([0-9\s,\.]+)\s*kr']:
            m = re.search(pat, text, re.I)
            if m:
                val = self._parse_amount(m.group(1))
                if val > 0:
                    return val
        return 0.0

    def _extract_net(self, text: str) -> float:
        for pat in [r'nettosumma[:\s]+([0-9\s,\.]+)\s*kr',
                    r'netto[:\s]+([0-9\s,\.]+)\s*kr',
                    r'exkl\. moms[:\s]+([0-9\s,\.]+)\s*kr']:
            m = re.search(pat, text, re.I)
            if m:
                val = self._parse_amount(m.group(1))
                if val > 0:
                    return val
        return 0.0

    def _extract_line_items(self, text: str) -> list:
        """Extract tabular line items from invoice text."""
        items = []
        lines = text.split('\n')
        for line in lines:
            # Look for lines with a number at the end (likely a price)
            m = re.match(
                r'^(.{5,50}?)\s+(\d+)\s+(?:st|kg|l|pcs)?\s+([0-9\s,\.]+)\s*kr?\s*([0-9\s,\.]+)\s*kr',
                line, re.I)
            if m:
                items.append({
                    "description": m.group(1).strip(),
                    "qty":         int(m.group(2)),
                    "unit_price":  self._parse_amount(m.group(3)),
                    "total":       self._parse_amount(m.group(4)),
                })
        return items


# ══════════════════════════════════════════════════════════════════════
# MODULE 4 — CATEGORISER
# Decides: is this invoice Food, Staff, Rent, or Other?
# Uses keyword matching against the config rules.
# ══════════════════════════════════════════════════════════════════════

class Categoriser:

    def categorise(self, extracted: dict) -> tuple[str, float]:
        """
        Returns (category, confidence_0_to_1).
        Checks vendor name first (most reliable), then full text.
        """
        vendor_lower = (extracted.get("vendor") or "").lower()
        text_lower   = (extracted.get("raw_text") or "").lower()

        # Step 1: Check known suppliers first (highest confidence)
        for supplier_name, info in CFG.get("known_suppliers", {}).items():
            if supplier_name.lower() in vendor_lower:
                return info["category"], 0.97

        # Step 2: Keyword matching on vendor name (high confidence)
        valid_cats = ["food","staff","rent","other"]
        for cat, keywords in CFG["categories"].items():
            if cat not in valid_cats: continue
            for kw in keywords:
                if kw in vendor_lower:
                    return cat, 0.88

        # Step 3: Keyword matching on full text (medium confidence)
        scores = {cat: 0 for cat in valid_cats}
        for cat, keywords in CFG["categories"].items():
            if cat not in ["food","staff","rent","other"]: continue
            for kw in keywords:
                if kw in text_lower:
                    scores[cat] += 1

        best_cat   = max(scores, key=scores.get)
        best_score = scores[best_cat]
        if best_score > 0:
            confidence = min(0.80, 0.50 + best_score * 0.05)
            return best_cat, round(confidence, 2)

        # Step 4: Amount-based heuristic (low confidence)
        amount = extracted.get("amount_ex_vat", 0)
        if 50000 < amount < 100000:
            return "rent", 0.40   # large fixed monthly payment → probably rent
        if amount > 3000:
            return "food", 0.35   # medium-large → probably food supplier

        return "other", 0.30

    def get_payment_days(self, vendor: str) -> Optional[int]:
        """Look up standard payment terms for known suppliers."""
        for name, info in CFG.get("known_suppliers", {}).items():
            if name.lower() in vendor.lower():
                return info.get("payment_days")
        return None

    def get_typical_range(self, vendor: str) -> Optional[tuple]:
        """Return (min, max) typical invoice range for a known supplier."""
        for name, info in CFG.get("known_suppliers", {}).items():
            if name.lower() in vendor.lower():
                r = info.get("typical_range")
                if r and len(r) == 2:
                    return tuple(r)
        return None


# ══════════════════════════════════════════════════════════════════════
# MODULE 5 — ANOMALY DETECTOR
# Runs checks after each invoice to catch anything unusual.
# ══════════════════════════════════════════════════════════════════════

class AnomalyDetector:

    def check(self, extracted: dict, category: str, period: str) -> list:
        """
        Runs all checks. Returns list of notification dicts.
        """
        alerts = []
        vendor = extracted.get("vendor", "Unknown")
        amount = extracted.get("amount_ex_vat", 0)
        t = CFG["thresholds"]

        # ── Check 1: Is this a new (unknown) supplier? ──────────────
        is_known = any(
            name.lower() in vendor.lower()
            for name in CFG.get("known_suppliers", {})
        )
        if not is_known and t.get("new_supplier_alert", True):
            alerts.append(self._alert(
                "warn", "new_supplier",
                f"New supplier detected: {vendor}",
                f"Amount: {kr(amount)} | Category auto-assigned: {category} | "
                f"Consider adding to known_suppliers in config."
            ))

        # ── Check 2: Unusually large invoice ─────────────────────────
        warn_amt = t.get("single_invoice_warn_amount", 40000)
        if amount > warn_amt:
            alerts.append(self._alert(
                "warn", "large_invoice",
                f"Large invoice: {kr(amount)} from {vendor}",
                f"Exceeds single-invoice warning threshold of {kr(warn_amt)}."
            ))

        # ── Check 3: Price change vs historical ──────────────────────
        typical = Categoriser().get_typical_range(vendor)
        if typical:
            lo, hi = typical
            pct_over = t.get("price_increase_alert_pct", 5)
            if amount > hi * (1 + pct_over/100):
                increase_pct = round((amount - hi) / hi * 100, 1)
                alerts.append(self._alert(
                    "alert", "price_increase",
                    f"Price increase detected: {vendor} +{increase_pct}%",
                    f"Invoice: {kr(amount)} | Typical max: {kr(hi)} | "
                    f"Increase: {increase_pct}% above normal range."
                ))

        # ── Check 4: After adding this invoice, do thresholds breach? ─
        totals = get_current_totals(period)
        alerts += self._check_threshold_breach(totals, category, amount, period)

        # ── Check 5: Payment due soon / overdue ──────────────────────
        due = extracted.get("due_date")
        if due:
            alerts += self._check_payment_date(due, vendor, amount)

        return alerts

    def _check_threshold_breach(self, totals: dict, category: str,
                                 new_amount: float, period: str) -> list:
        """Re-check percentages after adding this invoice."""
        alerts = []
        rev = totals["revenue"]
        if rev == 0:
            return alerts

        # Project new total after this invoice lands
        new_cat_total = totals.get(category, 0) + new_amount
        new_pct = round(new_cat_total / rev * 100, 1)
        t = CFG["thresholds"]

        thresholds_map = {
            "food":  (t["food_pct_warn"],  t["food_pct_over"]),
            "staff": (t["staff_pct_warn"], t["staff_pct_over"]),
            "rent":  (t["rent_pct_warn"],  t["rent_pct_over"]),
            "other": (t["other_pct_warn"], t["other_pct_over"]),
        }
        if category not in thresholds_map:
            return alerts

        warn_pct, over_pct = thresholds_map[category]
        old_pct = totals.get(f"{category}_pct", 0)

        if new_pct > over_pct and old_pct <= over_pct:
            # Just crossed the "over" threshold
            alerts.append(self._alert(
                "critical", f"{category}_over_threshold",
                f"{category.title()} costs crossed {over_pct}% threshold → now {new_pct}%",
                f"Revenue: {kr(rev)} | {category.title()} will be: {kr(new_cat_total)} ({new_pct}%)"
            ))
        elif new_pct > warn_pct and old_pct <= warn_pct:
            alerts.append(self._alert(
                "warn", f"{category}_warn_threshold",
                f"{category.title()} costs approaching limit: {new_pct}%",
                f"Warning threshold: {warn_pct}% | Revenue: {kr(rev)}"
            ))
        return alerts

    def _check_payment_date(self, due_str: str, vendor: str, amount: float) -> list:
        alerts = []
        try:
            due  = datetime.strptime(due_str, "%Y-%m-%d").date()
            today= datetime.now().date()
            days = (due - today).days
            warn = CFG["reconciliation"]["payment_warning_days"]
            over = CFG["reconciliation"]["overdue_flag_days"]
            if days < -over:
                alerts.append(self._alert(
                    "critical", "overdue",
                    f"OVERDUE: {vendor} — {kr(amount)}",
                    f"Due: {due_str} ({abs(days)} days ago). Requires immediate attention."
                ))
            elif days <= warn:
                alerts.append(self._alert(
                    "warn", "payment_due_soon",
                    f"Payment due in {days} days: {vendor} — {kr(amount)}",
                    f"Due date: {due_str}"
                ))
        except Exception:
            pass
        return alerts

    def _alert(self, level: str, category: str, title: str, detail: str) -> dict:
        return {"level": level, "category": category, "title": title,
                "detail": detail, "created_at": now_str()}


# ══════════════════════════════════════════════════════════════════════
# MODULE 6 — RECONCILIATION ENGINE
# Matches invoices to bank transactions.
# ══════════════════════════════════════════════════════════════════════

class Reconciler:

    def import_bank_csv(self, csv_text: str) -> int:
        """
        Parse a Handelsbanken CSV and store transactions.
        Returns number of rows imported.
        """
        lines  = [l.strip() for l in csv_text.split('\n') if l.strip()]
        imported = 0
        with get_db() as conn:
            for line in lines[1:]:  # skip header
                parts = line.split(';')
                if len(parts) < 4:
                    continue
                try:
                    tx_date  = parts[0].strip().strip('"')
                    desc     = parts[1].strip().strip('"')
                    amount   = float(parts[2].replace(' ','').replace(',','.').strip('"'))
                    balance  = float(parts[3].replace(' ','').replace(',','.').strip('"'))
                    conn.execute("""INSERT OR IGNORE INTO bank_transactions
                        (tx_date,description,amount,balance,imported_at)
                        VALUES (?,?,?,?,?)""",
                        (tx_date, desc, amount, balance, now_str()))
                    imported += 1
                except Exception:
                    continue
            conn.commit()
        return imported

    def auto_match(self) -> int:
        """
        Try to match unmatched bank transactions to unpaid invoices.
        Matches on amount (within tolerance) and approximate date.
        Returns number of new matches found.
        """
        tol = CFG["reconciliation"]["match_tolerance_sek"]
        matched = 0
        with get_db() as conn:
            # Get unmatched bank outflows
            txs = conn.execute("""SELECT id, tx_date, amount
                FROM bank_transactions
                WHERE matched_invoice_id IS NULL AND amount < 0""").fetchall()
            # Get unpaid invoices
            invoices = conn.execute("""SELECT id, amount_ex_vat, total_inc_vat, due_date
                FROM invoices WHERE status='pending'""").fetchall()

            for tx_id, tx_date, tx_amount in txs:
                for inv_id, ex_vat, inc_vat, due_date in invoices:
                    # Match if bank amount ≈ invoice total (within tolerance)
                    if abs(abs(tx_amount) - inc_vat) <= tol:
                        conn.execute("""UPDATE bank_transactions
                            SET matched_invoice_id=? WHERE id=?""", (inv_id, tx_id))
                        conn.execute("""UPDATE invoices
                            SET status='paid', matched_bank_tx=? WHERE id=?""",
                            (str(tx_id), inv_id))
                        matched += 1
                        break
            conn.commit()
        return matched

    def get_unpaid_summary(self) -> list:
        """Return list of unpaid invoices with days until due."""
        with get_db() as conn:
            rows = conn.execute("""SELECT id, vendor, amount_ex_vat, due_date
                FROM invoices WHERE status='pending'
                ORDER BY due_date ASC""").fetchall()
        today = datetime.now().date()
        result = []
        for inv_id, vendor, amount, due_str in rows:
            days = None
            if due_str:
                try:
                    due  = datetime.strptime(due_str, "%Y-%m-%d").date()
                    days = (due - today).days
                except Exception:
                    pass
            result.append({"id":inv_id,"vendor":vendor,"amount":amount,
                            "due_date":due_str,"days_until_due":days})
        return result


# ══════════════════════════════════════════════════════════════════════
# MODULE 7 — THE WORKFLOW PIPELINE
# This is the main sequence: read file → extract → categorise →
# update tracker → check anomalies → log → notify
# ══════════════════════════════════════════════════════════════════════

class WorkflowPipeline:

    def __init__(self):
        self.extractor   = InvoiceExtractor()
        self.categoriser = Categoriser()
        self.detector    = AnomalyDetector()
        self.reconciler  = Reconciler()

    def process_file(self, filepath: Path) -> dict:
        """
        Full pipeline for one invoice file.
        Returns a result dict with every step's output.
        """
        result = {
            "file":     str(filepath),
            "steps":    [],
            "success":  False,
            "invoice":  None,
            "category": None,
            "alerts":   [],
        }

        log_msg(f"Starting pipeline: {filepath.name}")

        try:
            # ── STEP 1: Read file ──────────────────────────────────────
            self._step(result, 1, "Read file")
            file_hash = self._hash_file(filepath)

            # Check for duplicates
            with get_db() as conn:
                dup = conn.execute("SELECT id FROM invoices WHERE file_hash=?",
                                   (file_hash,)).fetchone()
            if dup:
                self._done(result, 1, f"Duplicate — already processed (id={dup[0]})")
                result["success"] = True
                return result
            self._done(result, 1, f"Read {filepath.stat().st_size} bytes · hash {file_hash[:8]}…")

            # ── STEP 2: Extract cost data ─────────────────────────────
            self._step(result, 2, "Extract invoice data")
            raw_text  = self._read_file(filepath)
            extracted = self.extractor.extract(raw_text, filepath.name)
            result["invoice"] = extracted
            self._done(result, 2,
                f"Vendor: {extracted['vendor']} | "
                f"Amount: {kr(extracted['total_inc_vat'])} | "
                f"Date: {extracted['invoice_date']} | "
                f"Due: {extracted['due_date']} | "
                f"{len(extracted['line_items'])} line items")

            # ── STEP 3: Categorise ────────────────────────────────────
            self._step(result, 3, "Categorise")
            category, confidence = self.categoriser.categorise(extracted)
            result["category"] = category
            self._done(result, 3, f"→ {category.upper()} (confidence {confidence*100:.0f}%)")

            # ── STEP 4: Update live tracker ───────────────────────────
            self._step(result, 4, "Update tracker totals")
            period = self._derive_period(extracted.get("invoice_date"))
            upsert_totals(period, category, extracted["amount_ex_vat"])
            self._done(result, 4,
                f"Added {kr(extracted['amount_ex_vat'])} to {category} "
                f"bucket for {period}")

            # ── STEP 5: Recalculate & log ─────────────────────────────
            self._step(result, 5, "Recalculate percentages")
            totals = get_current_totals(period)
            self._done(result, 5,
                f"Revenue {kr(totals['revenue'])} | "
                f"Staff {totals['staff_pct']}% | "
                f"Food {totals['food_pct']}% | "
                f"Profit {totals['profit_pct']}%")

            # ── STEP 6: Anomaly checks ────────────────────────────────
            self._step(result, 6, "Check for anomalies")
            alerts = self.detector.check(extracted, category, period)
            result["alerts"] = alerts
            if alerts:
                self._save_notifications(alerts)
                self._done(result, 6,
                    f"{len(alerts)} alert(s): " +
                    " | ".join(a["title"] for a in alerts[:2]))
            else:
                self._done(result, 6, "No anomalies detected ✓")

            # ── STEP 7: Save to DB + add to chat context ──────────────
            self._step(result, 7, "Save & index for chat")
            pay_days = self.categoriser.get_payment_days(extracted["vendor"])
            due = extracted.get("due_date")
            if not due and pay_days and extracted.get("invoice_date"):
                try:
                    inv_dt = datetime.strptime(extracted["invoice_date"], "%Y-%m-%d")
                    due    = (inv_dt + timedelta(days=pay_days)).strftime("%Y-%m-%d")
                    extracted["due_date"] = due
                except Exception:
                    pass

            with get_db() as conn:
                conn.execute("""INSERT OR IGNORE INTO invoices
                    (file_hash,filename,processed_at,vendor,invoice_date,due_date,
                     amount_ex_vat,vat_amount,total_inc_vat,category,status,raw_text,extracted_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    file_hash, filepath.name, now_str(),
                    extracted["vendor"], extracted.get("invoice_date"),
                    extracted.get("due_date"),
                    extracted["amount_ex_vat"], extracted["vat_amount"],
                    extracted["total_inc_vat"], category, "pending",
                    raw_text, json.dumps(extracted)))
                conn.commit()

            self._done(result, 7,
                f"Saved to DB · Due: {extracted.get('due_date','unknown')} · "
                f"Added to chat context")

            # ── STEP 8: Reconcile with bank ───────────────────────────
            self._step(result, 8, "Reconcile with bank transactions")
            matched = self.reconciler.auto_match()
            self._done(result, 8,
                f"{matched} new bank match(es) found" if matched
                else "No bank match yet — invoice remains pending")

            # Move file to processed folder
            dest = PROCESSED / filepath.name
            if filepath.exists():
                shutil.move(str(filepath), str(dest))

            # If flagged, also copy to flagged folder
            if any(a["level"] in ("alert","critical") for a in alerts):
                shutil.copy2(str(dest), str(FLAGGED / filepath.name))

            result["success"] = True
            log_msg(f"✓ Pipeline complete: {filepath.name} → {category} {kr(extracted['amount_ex_vat'])}")

        except Exception as e:
            result["steps"].append({
                "step": len(result["steps"])+1,
                "label": "Error",
                "status": "error",
                "detail": str(e)
            })
            log_msg(f"✗ Pipeline error on {filepath.name}: {e}")

        return result

    # ── Helpers ──────────────────────────────────────────────────────

    def _step(self, result, n, label):
        result["steps"].append({"step":n,"label":label,"status":"running","detail":""})

    def _done(self, result, n, detail):
        for s in result["steps"]:
            if s["step"] == n:
                s["status"] = "done"
                s["detail"] = detail
                break

    def _hash_file(self, fp: Path) -> str:
        return hashlib.sha256(fp.read_bytes()).hexdigest()

    def _read_file(self, fp: Path) -> str:
        try:
            return fp.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return fp.read_text(encoding="latin-1")

    def _derive_period(self, date_str: Optional[str]) -> str:
        """Turn '2026-03-12' → 'Mars 2026'"""
        months_sv = ["Jan","Feb","Mars","Apr","Maj","Jun",
                     "Jul","Aug","Sep","Okt","Nov","Dec"]
        if date_str:
            try:
                dt = datetime.strptime(date_str, "%Y-%m-%d")
                return f"{months_sv[dt.month-1]} {dt.year}"
            except Exception:
                pass
        return CFG["baseline"]["period"]

    def _save_notifications(self, alerts: list):
        with get_db() as conn:
            for a in alerts:
                conn.execute("""INSERT INTO notifications
                    (created_at,level,category,title,detail)
                    VALUES (?,?,?,?,?)""",
                    (a["created_at"],a["level"],a["category"],a["title"],a["detail"]))
            conn.commit()


# ══════════════════════════════════════════════════════════════════════
# MODULE 8 — FILE WATCHER
# Uses watchdog to monitor the inbox folder for new files.
# Runs the pipeline automatically on every new file.
# ══════════════════════════════════════════════════════════════════════

class InvoiceWatcher:
    """Watches the inbox folder using polling (no external deps beyond watchdog)."""

    def __init__(self, pipeline: WorkflowPipeline):
        self.pipeline = pipeline
        self.seen     = set()
        self.running  = False

    def start(self):
        self.running = True
        log_msg(f"Watching {INBOX} for new invoices…")
        self._poll_loop()

    def _poll_loop(self):
        interval = CFG["watch"]["poll_interval_sec"]
        supported = set(CFG["watch"]["supported_formats"])
        while self.running:
            try:
                for fp in INBOX.iterdir():
                    if fp.is_file() and fp.suffix.lower() in supported:
                        key = (fp.name, fp.stat().st_mtime)
                        if key not in self.seen:
                            self.seen.add(key)
                            log_msg(f"Detected: {fp.name}")
                            # Small delay to ensure file is fully written
                            time.sleep(0.5)
                            self.pipeline.process_file(fp)
            except Exception as e:
                log_msg(f"Watcher error: {e}")
            time.sleep(interval)

    def stop(self):
        self.running = False


# ══════════════════════════════════════════════════════════════════════
# MODULE 9 — DAILY SUMMARY GENERATOR
# ══════════════════════════════════════════════════════════════════════

def generate_daily_summary() -> dict:
    """Generate a summary of today's activity."""
    today = datetime.now().date().isoformat()
    with get_db() as conn:
        invoices_today = conn.execute("""SELECT vendor,category,amount_ex_vat,status
            FROM invoices WHERE date(processed_at)=?""", (today,)).fetchall()
        alerts_today   = conn.execute("""SELECT level,title
            FROM notifications WHERE date(created_at)=? AND acknowledged=0""",
            (today,)).fetchall()
        unpaid = conn.execute("""SELECT COUNT(*), SUM(amount_ex_vat)
            FROM invoices WHERE status='pending'""").fetchone()

    total_processed = sum(row[2] for row in invoices_today)
    by_category     = {}
    for _, cat, amt, _ in invoices_today:
        by_category[cat] = by_category.get(cat, 0) + amt

    return {
        "date":              today,
        "invoices_processed":len(invoices_today),
        "total_amount":      total_processed,
        "by_category":       by_category,
        "alerts":            len(alerts_today),
        "critical_alerts":   sum(1 for level,_ in alerts_today if level=="critical"),
        "unpaid_count":      unpaid[0] or 0,
        "unpaid_total":      unpaid[1] or 0,
        "invoices":          [{"vendor":v,"category":c,"amount":a,"status":s}
                               for v,c,a,s in invoices_today],
    }


# ══════════════════════════════════════════════════════════════════════
# MODULE 10 — HTTP DASHBOARD SERVER
# Serves a JSON API + minimal HTML dashboard on localhost:8765
# The main UI (workflow_dashboard.html) calls this API.
# ══════════════════════════════════════════════════════════════════════

class DashboardHandler(http.server.BaseHTTPRequestHandler):

    def do_GET(self):
        parsed  = urllib.parse.urlparse(self.path)
        path    = parsed.path
        params  = dict(urllib.parse.parse_qsl(parsed.query))

        if path == "/api/status":
            self._json(self._get_status())
        elif path == "/api/invoices":
            self._json(self._get_invoices())
        elif path == "/api/notifications":
            self._json(self._get_notifications())
        elif path == "/api/totals":
            period = params.get("period", CFG["baseline"]["period"])
            self._json(get_current_totals(period))
        elif path == "/api/summary":
            self._json(generate_daily_summary())
        elif path == "/api/unpaid":
            self._json(Reconciler().get_unpaid_summary())
        elif path == "/api/config":
            self._json(CFG)
        elif path == "/api/simulate":
            result = self._simulate_invoice(params.get("type", "food"))
            self._json(result)
        else:
            self._json({"error": "Not found", "path": path}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length).decode()
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/acknowledge":
            data = json.loads(body)
            with get_db() as conn:
                conn.execute("UPDATE notifications SET acknowledged=1 WHERE id=?",
                             (data.get("id"),))
                conn.commit()
            self._json({"ok": True})
        elif parsed.path == "/api/save_config":
            data = json.loads(body)
            with open(CONFIG_F, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            global CFG
            CFG = load_config()
            self._json({"ok": True})
        elif parsed.path == "/api/import_bank":
            data = json.loads(body)
            n = Reconciler().import_bank_csv(data.get("csv", ""))
            matched = Reconciler().auto_match()
            self._json({"imported": n, "matched": matched})
        else:
            self._json({"error": "Not found"}, 404)

    def _json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type",  "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args): pass   # suppress HTTP request logs

    def _get_status(self) -> dict:
        with get_db() as conn:
            inv_count = conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0]
            notif_count = conn.execute(
                "SELECT COUNT(*) FROM notifications WHERE acknowledged=0").fetchone()[0]
            pending_count = conn.execute(
                "SELECT COUNT(*) FROM invoices WHERE status='pending'").fetchone()[0]
        return {
            "status":       "running",
            "invoices":     inv_count,
            "notifications":notif_count,
            "pending":      pending_count,
            "watch_folder": str(INBOX),
            "timestamp":    now_str(),
        }

    def _get_invoices(self) -> list:
        with get_db() as conn:
            rows = conn.execute("""SELECT id,vendor,invoice_date,due_date,
                amount_ex_vat,total_inc_vat,category,status,processed_at
                FROM invoices ORDER BY processed_at DESC LIMIT 50""").fetchall()
        return [{"id":r[0],"vendor":r[1],"invoice_date":r[2],"due_date":r[3],
                 "amount_ex_vat":r[4],"total_inc_vat":r[5],"category":r[6],
                 "status":r[7],"processed_at":r[8]} for r in rows]

    def _get_notifications(self) -> list:
        with get_db() as conn:
            rows = conn.execute("""SELECT id,created_at,level,category,title,detail,acknowledged
                FROM notifications ORDER BY created_at DESC LIMIT 100""").fetchall()
        return [{"id":r[0],"created_at":r[1],"level":r[2],"category":r[3],
                 "title":r[4],"detail":r[5],"acknowledged":r[6]} for r in rows]

    def _simulate_invoice(self, inv_type: str) -> dict:
        """Create a sample invoice file and process it — for demo/testing."""
        samples = {
            "food": (
                "Menigo Foodservice AB\nFakturanummer: TEST-001\n"
                "Fakturadatum: 2026-04-02\nFörfallodatum: 2026-05-02\n"
                "Kycklingfilé 5kg 12st 700kr 8 400 kr\n"
                "Nötkött 3kg 8st 1600kr 12 800 kr\n"
                "Nettosumma: 28 000 kr\nMoms 12%: 3 360 kr\nAtt betala: 31 360 kr"
            ),
            "staff": (
                "Personalkörning April 2026\nLöneutbetalning\n"
                "Erik Svensson Lön 42 000 kr\nMaria Lindqvist Lön 28 500 kr\n"
                "Totala löner: 168 000 kr\nArbetsgivaravgifter: 56 700 kr\n"
                "Att betala: 224 700 kr"
            ),
            "rent": (
                "Björkens Fastigheter KB\nFaktura HF-2026-041\n"
                "Fakturadatum: 2026-04-01\nFörfallodatum: 2026-04-01\n"
                "Bashyra april 2026: 38 000 kr\nEl och värme: 7 200 kr\n"
                "Nettosumma: 52 000 kr\nMoms 25%: 13 000 kr\nAtt betala: 65 000 kr"
            ),
            "large": (
                "Okänd Leverantör AB\nFakturanummer: UK-001\n"
                "Fakturadatum: 2026-04-02\n"
                "Utrustning kök: 1 st 55 000 kr\n"
                "Att betala: 68 750 kr\nMoms: 13 750 kr\nNetto: 55 000 kr"
            ),
        }
        text = samples.get(inv_type, samples["food"])
        tmp  = INBOX / f"SIMULATE_{inv_type}_{int(time.time())}.txt"
        tmp.write_text(text)
        pipeline = WorkflowPipeline()
        return pipeline.process_file(tmp)


# ══════════════════════════════════════════════════════════════════════
# UTILITIES
# ══════════════════════════════════════════════════════════════════════

def kr(n: float) -> str:
    return f"{abs(int(n)):,}".replace(",", " ") + " kr"

def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log_msg(msg: str):
    entry = f"[{now_str()}] {msg}"
    print(entry)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(entry + "\n")
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Björken Invoice Workflow Engine")
    parser.add_argument("--process",  metavar="FILE",  help="Process a single file")
    parser.add_argument("--simulate", metavar="TYPE",  help="Simulate invoice: food|staff|rent|large",
                        nargs="?", const="food")
    parser.add_argument("--status",   action="store_true", help="Print current status")
    parser.add_argument("--summary",  action="store_true", help="Print daily summary")
    parser.add_argument("--port",     type=int, default=8765, help="Dashboard port (default 8765)")
    parser.add_argument("--watch",    action="store_true", help="Watch inbox + start dashboard")
    args = parser.parse_args()

    # Always initialise DB first
    init_db()

    if args.status:
        totals = get_current_totals(CFG["baseline"]["period"])
        print(json.dumps(totals, indent=2, ensure_ascii=False))
        return

    if args.summary:
        print(json.dumps(generate_daily_summary(), indent=2, ensure_ascii=False))
        return

    if args.process:
        pipeline = WorkflowPipeline()
        result   = pipeline.process_file(Path(args.process))
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
        return

    if args.simulate:
        handler  = DashboardHandler.__new__(DashboardHandler)
        result   = handler._simulate_invoice(args.simulate)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
        return

    # Default: start dashboard + file watcher
    log_msg(f"Starting Björken Workflow Engine on port {args.port}")
    log_msg(f"Dashboard: http://localhost:{args.port}/api/status")
    log_msg(f"Inbox:     {INBOX}")

    # Start HTTP dashboard in background thread
    server = socketserver.ThreadingTCPServer(("", args.port), DashboardHandler)
    server.daemon_threads = True
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    log_msg(f"Dashboard API running on http://localhost:{args.port}")

    # Start file watcher (blocks)
    pipeline = WorkflowPipeline()
    watcher  = InvoiceWatcher(pipeline)
    try:
        watcher.start()
    except KeyboardInterrupt:
        watcher.stop()
        log_msg("Workflow engine stopped.")


if __name__ == "__main__":
    main()
