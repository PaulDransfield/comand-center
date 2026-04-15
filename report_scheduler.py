#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════╗
║  Report Scheduler — Restaurang Björken                               ║
║                                                                      ║
║  Generates and schedules PDF reports automatically.                  ║
║                                                                      ║
║  Usage:                                                              ║
║    python3 report_scheduler.py --now daily       # generate now     ║
║    python3 report_scheduler.py --now weekly                          ║
║    python3 report_scheduler.py --now monthly                         ║
║    python3 report_scheduler.py --now quarterly                       ║
║    python3 report_scheduler.py --watch           # run scheduler     ║
║    python3 report_scheduler.py --status          # show next runs    ║
╚══════════════════════════════════════════════════════════════════════╝
"""

import json, os, sys, argparse, smtplib, sqlite3, threading, time, urllib.request
from pathlib import Path
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders
from io import BytesIO

# ReportLab — PDF generation
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether
)
from reportlab.graphics.shapes import Drawing, Rect, Line, String
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.charts.piecharts import Pie
from reportlab.graphics import renderPDF
from reportlab.graphics.widgets.markers import makeMarker

# ── PATHS ─────────────────────────────────────────────────────────
BASE     = Path(__file__).parent
CFG_FILE = BASE / "config" / "report_config.json"
OUTPUT   = BASE / "output"
QUEUE    = BASE / "queue"
LOG_FILE = BASE / "logs" / "scheduler.log"
DB_FILE  = BASE / "logs" / "scheduler.db"


# ══════════════════════════════════════════════════════════════════
# CONFIGURATION & DATA
# ══════════════════════════════════════════════════════════════════

def load_config():
    with open(CFG_FILE) as f:
        return json.load(f)

def get_data(cfg=None):
    """Return financial data from config, augmented with derived fields."""
    if cfg is None:
        cfg = load_config()
    d = cfg["data"].copy()
    d["total_costs"] = d["staff"] + d["food"] + d["rent"] + d["other"]
    d["profit"]      = d["revenue"] - d["total_costs"]
    d["margin"]      = round(d["profit"] / d["revenue"] * 100, 2) if d["revenue"] else 0
    d["staff_pct"]   = round(d["staff"]  / d["revenue"] * 100, 1) if d["revenue"] else 0
    d["food_pct"]    = round(d["food"]   / d["revenue"] * 100, 1) if d["revenue"] else 0
    d["rent_pct"]    = round(d["rent"]   / d["revenue"] * 100, 1) if d["revenue"] else 0
    d["other_pct"]   = round(d["other"]  / d["revenue"] * 100, 1) if d["revenue"] else 0
    # Period-on-period deltas
    d["rev_delta"]   = round((d["revenue"] - d["prev_revenue"]) / d["prev_revenue"] * 100, 1)
    d["staff_delta"] = round((d["staff"]   - d["prev_staff"])   / d["prev_staff"]   * 100, 1)
    d["food_delta"]  = round((d["food"]    - d["prev_food"])    / d["prev_food"]    * 100, 1)
    # Budget variance
    d["rev_vs_budget"]   = round((d["revenue"] - d["budget_revenue"]) / d["budget_revenue"] * 100, 1)
    d["staff_vs_budget"] = round((d["staff"]   - d["budget_staff"])   / d["budget_staff"]   * 100, 1)
    d["food_vs_budget"]  = round((d["food"]    - d["budget_food"])    / d["budget_food"]    * 100, 1)
    return d


# ══════════════════════════════════════════════════════════════════
# DESIGN SYSTEM — shared colours, styles, helpers
# ══════════════════════════════════════════════════════════════════

# Colour palette
NAVY   = colors.HexColor("#1E2761")
BLUE   = colors.HexColor("#185FA5")
BLUE_L = colors.HexColor("#E6F1FB")
GREEN  = colors.HexColor("#3B6D11")
GREEN_L= colors.HexColor("#EAF3DE")
RED    = colors.HexColor("#A32D2D")
RED_L  = colors.HexColor("#FCEBEB")
AMBER  = colors.HexColor("#854F0B")
AMBER_L= colors.HexColor("#FAEEDA")
TEAL   = colors.HexColor("#0F6E56")
TEAL_L = colors.HexColor("#E1F5EE")
CREAM  = colors.HexColor("#FAF8F4")
STONE  = colors.HexColor("#DDD9D2")
ASH    = colors.HexColor("#9B9690")
DARK   = colors.HexColor("#1A1917")

CHART_COLORS = [BLUE, GREEN, AMBER, colors.HexColor("#888780"),
                colors.HexColor("#4A7FC1"), colors.HexColor("#97BC62")]

def kr(n):
    return f"{abs(int(n)):,}".replace(",", " ") + " kr"

def pct(n, show_sign=False):
    sign = "+" if show_sign and n > 0 else ""
    return f"{sign}{n:.1f}%"

def delta_color(n, higher_good=True):
    if abs(n) < 0.5: return ASH
    if higher_good: return GREEN if n > 0 else RED
    return RED if n > 0 else GREEN

def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log(msg):
    entry = f"[{now_str()}] {msg}"
    print(entry)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(entry + "\n")
    except Exception:
        pass

def build_styles():
    """Create the shared paragraph style sheet."""
    s = getSampleStyleSheet()
    def add(name, parent="Normal", **kw):
        s.add(ParagraphStyle(name=name, parent=s[parent], **kw))

    add("ReportTitle",
        fontSize=22, textColor=NAVY, fontName="Helvetica-Bold",
        spaceAfter=4, alignment=TA_LEFT)
    add("ReportSubtitle",
        fontSize=13, textColor=ASH, fontName="Helvetica",
        spaceAfter=12, alignment=TA_LEFT)
    add("SectionHeader",
        fontSize=13, textColor=BLUE, fontName="Helvetica-Bold",
        spaceBefore=16, spaceAfter=6, alignment=TA_LEFT)
    add("SubHeader",
        fontSize=11, textColor=DARK, fontName="Helvetica-Bold",
        spaceBefore=10, spaceAfter=4)
    add("BJBodyText",
        fontSize=10, textColor=DARK, fontName="Helvetica",
        leading=16, spaceAfter=6, alignment=TA_JUSTIFY)
    add("BJCaption",
        fontSize=8, textColor=ASH, fontName="Helvetica",
        spaceAfter=4, alignment=TA_CENTER)
    add("KPIValue",
        fontSize=20, textColor=BLUE, fontName="Helvetica-Bold",
        spaceAfter=2, alignment=TA_CENTER)
    add("KPILabel",
        fontSize=8, textColor=ASH, fontName="Helvetica-Bold",
        alignment=TA_CENTER, spaceBefore=0, spaceAfter=0)
    add("InsightText",
        fontSize=10, textColor=DARK, fontName="Helvetica",
        leading=15, spaceAfter=4, leftIndent=10)
    add("BJFooter",
        fontSize=7, textColor=ASH, fontName="Helvetica",
        alignment=TA_CENTER)
    return s


# ══════════════════════════════════════════════════════════════════
# CHART BUILDERS (pure ReportLab graphics)
# ══════════════════════════════════════════════════════════════════

def make_bar_chart(labels, series, width=14*cm, height=6*cm, title="",
                   colors_list=None, show_values=True):
    """A clean grouped bar chart."""
    drawing = Drawing(width, height)
    chart   = VerticalBarChart()
    chart.x = 1.2*cm; chart.y = 1.5*cm
    chart.width  = width  - 2.2*cm
    chart.height = height - 2.5*cm

    chart.data        = series
    chart.categoryAxis.categoryNames = labels
    chart.categoryAxis.labels.fontName  = "Helvetica"
    chart.categoryAxis.labels.fontSize  = 7
    chart.categoryAxis.labels.fillColor = ASH
    chart.valueAxis.labels.fontName  = "Helvetica"
    chart.valueAxis.labels.fontSize  = 7
    chart.valueAxis.labels.fillColor = ASH
    chart.valueAxis.labelTextFormat  = lambda v: f"{int(v/1000)}k"
    chart.valueAxis.strokeColor      = STONE
    chart.valueAxis.gridStrokeColor  = STONE
    chart.valueAxis.gridStrokeWidth  = 0.3

    for i, s_data in enumerate(series):
        c = (colors_list or CHART_COLORS)[i % len(CHART_COLORS)]
        chart.bars[i].fillColor   = c
        chart.bars[i].strokeColor = colors.white
        chart.bars[i].strokeWidth = 0.5

    chart.barWidth   = 0.35
    chart.groupSpacing = 0.2
    drawing.add(chart)

    if title:
        drawing.add(String(width/2, height - 0.3*cm, title,
                           fontSize=8, fontName="Helvetica-Bold",
                           fillColor=DARK, textAnchor="middle"))
    return drawing


def make_donut_chart(labels, values, width=7*cm, height=7*cm,
                     colors_list=None):
    """A clean donut chart."""
    drawing = Drawing(width, height)
    pie = Pie()
    pie.x = int(width*0.15); pie.y = int(height*0.15)
    pie.width  = int(width  * 0.7)
    pie.height = int(height * 0.7)
    pie.data   = values
    pie.labels = [f"{v/sum(values)*100:.0f}%" for v in values]
    pie.innerRadiusFraction = 0.55  # donut hole

    for i in range(len(values)):
        c = (colors_list or CHART_COLORS)[i % len(CHART_COLORS)]
        pie.slices[i].fillColor   = c
        pie.slices[i].strokeColor = colors.white
        pie.slices[i].strokeWidth = 1.5
        pie.slices[i].labelRadius = 1.15
        pie.slices[i].fontSize    = 7
        pie.slices[i].fontName    = "Helvetica-Bold"
        pie.slices[i].fillColor   = c

    drawing.add(pie)
    return drawing


def make_line_chart(labels, series_data, series_names, width=14*cm, height=6*cm,
                    title="", colors_list=None, y_label_fmt=None):
    """A clean line chart for trends."""
    drawing = Drawing(width, height)
    chart   = LinePlot()
    chart.x = 1.5*cm; chart.y = 1.5*cm
    chart.width  = width  - 2.2*cm
    chart.height = height - 2.5*cm

    # Build data as (x, y) pairs
    chart.data = [
        [(i, v) for i, v in enumerate(series)]
        for series in series_data
    ]

    chart.xValueAxis.labels.fontName  = "Helvetica"
    chart.xValueAxis.labels.fontSize  = 7
    chart.xValueAxis.labels.fillColor = ASH
    chart.xValueAxis.valueMin = 0
    chart.xValueAxis.valueMax = len(labels) - 1
    chart.xValueAxis.valueStep= 1
    chart.xValueAxis.labelTextFormat = lambda v: labels[int(v)] if 0 <= int(v) < len(labels) else ""

    chart.yValueAxis.labels.fontName  = "Helvetica"
    chart.yValueAxis.labels.fontSize  = 7
    chart.yValueAxis.labels.fillColor = ASH
    if y_label_fmt:
        chart.yValueAxis.labelTextFormat = y_label_fmt
    else:
        chart.yValueAxis.labelTextFormat = lambda v: f"{int(v/1000)}k"
    chart.yValueAxis.gridStrokeColor  = STONE
    chart.yValueAxis.gridStrokeWidth  = 0.3

    for i, name in enumerate(series_names):
        c = (colors_list or CHART_COLORS)[i % len(CHART_COLORS)]
        chart.lines[i].strokeColor = c
        chart.lines[i].strokeWidth = 2
        chart.lines[i].symbol      = makeMarker("FilledCircle")
        chart.lines[i].symbol.fillColor   = c
        chart.lines[i].symbol.strokeColor = colors.white
        chart.lines[i].symbol.size        = 4

    drawing.add(chart)
    if title:
        drawing.add(String(width/2, height-0.3*cm, title,
                           fontSize=8, fontName="Helvetica-Bold",
                           fillColor=DARK, textAnchor="middle"))
    return drawing


# ══════════════════════════════════════════════════════════════════
# SHARED LAYOUT COMPONENTS
# ══════════════════════════════════════════════════════════════════

def page_header(canvas, doc, company, report_type, period):
    """Header on every page."""
    canvas.saveState()
    w = doc.width + doc.leftMargin + doc.rightMargin
    # Top band
    canvas.setFillColor(NAVY)
    canvas.rect(0, A4[1]-0.8*cm, w, 0.8*cm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(doc.leftMargin, A4[1]-0.55*cm, company)
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(w-doc.rightMargin, A4[1]-0.55*cm,
                           f"{report_type}  ·  {period}")
    # Bottom footer
    canvas.setFillColor(ASH)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(doc.leftMargin, 0.5*cm,
                      f"Generated {now_str()}  ·  Confidential")
    canvas.drawRightString(w-doc.rightMargin, 0.5*cm,
                           f"Page {doc.page}")
    canvas.restoreState()


def kpi_row(styles, items):
    """
    A row of 4 KPI boxes.
    items: list of (label, value, sub, trend_pct, higher_good)
    """
    table_data = [[],[]]
    col_w = [4.5*cm, 4.5*cm, 4.5*cm, 4.5*cm]

    for label, value, sub, trend, higher_good in items:
        color = DARK
        if trend is not None:
            color = delta_color(trend, higher_good)

        # Row 0: value
        table_data[0].append(Paragraph(value, styles["KPIValue"]))
        # Row 1: label + sub
        txt = f"<b>{label}</b>"
        if sub: txt += f"<br/><font size='7' color='#{ASH.hexval()[2:]}'>{sub}</font>"
        if trend is not None:
            sign = "▲" if trend > 0 else "▼"
            hex_col = color.hexval()[2:]
            txt += f"<br/><font size='7' color='#{hex_col}'>{sign} {abs(trend):.1f}%</font>"
        table_data[1].append(Paragraph(txt, styles["KPILabel"]))

    table = Table([table_data[0], table_data[1]],
                  colWidths=col_w, rowHeights=[1.0*cm, 1.0*cm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), CREAM),
        ("LINEAFTER",  (0,0), (2,-1), 0.5, STONE),
        ("TOPPADDING",    (0,0),(-1,-1), 6),
        ("BOTTOMPADDING", (0,0),(-1,-1), 6),
        ("LEFTPADDING",   (0,0),(-1,-1), 8),
        ("RIGHTPADDING",  (0,0),(-1,-1), 8),
        ("VALIGN",        (0,0),(-1,-1), "MIDDLE"),
        ("BOX",           (0,0),(-1,-1), 0.5, STONE),
    ]))
    return table


def section_divider(title, styles, color=BLUE):
    """Blue rule + section title."""
    return KeepTogether([
        HRFlowable(width="100%", thickness=1.5, color=color, spaceAfter=4),
        Paragraph(title, styles["SectionHeader"]),
    ])


def insight_box(insights, styles, title="AI Insights"):
    """Amber-tinted box with AI-generated insights."""
    rows = []
    for i, text in enumerate(insights):
        rows.append(Paragraph(f"<b>{i+1}.</b> {text}", styles["InsightText"]))
    table = Table([[rows]], colWidths=["100%"])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), AMBER_L),
        ("BOX",        (0,0),(-1,-1), 0.5, AMBER),
        ("TOPPADDING",    (0,0),(-1,-1), 8),
        ("BOTTOMPADDING", (0,0),(-1,-1), 8),
        ("LEFTPADDING",   (0,0),(-1,-1), 12),
        ("RIGHTPADDING",  (0,0),(-1,-1), 12),
    ]))
    return KeepTogether([
        Paragraph(f"✦ {title}", ParagraphStyle(
            "InsightHeader", fontSize=9, fontName="Helvetica-Bold",
            textColor=AMBER, spaceBefore=8, spaceAfter=4)),
        table,
    ])


def cost_table(d, styles, show_budget=False):
    """Standard cost breakdown table."""
    headers = ["Category", "Amount", "% of Revenue", "vs Prior"]
    if show_budget: headers.append("vs Budget")

    rows = [headers]
    cats = [
        ("Personal",        d["staff"], d["staff_pct"],
         round((d["staff"]-d["prev_staff"])/d["prev_staff"]*100,1),
         round((d["staff"]-d["budget_staff"])/d["budget_staff"]*100,1) if show_budget else None),
        ("Råvaror & dryck",  d["food"],  d["food_pct"],
         round((d["food"]-d["prev_food"])/d["prev_food"]*100,1),
         round((d["food"]-d["budget_food"])/d["budget_food"]*100,1) if show_budget else None),
        ("Lokal & fastighet",d["rent"],  d["rent_pct"],
         0.0, None),
        ("Övrigt",           d["other"], d["other_pct"],
         round((d["other"]-d.get("prev_other",d["other"]))/max(d.get("prev_other",1),1)*100,1),
         None),
    ]
    for name, amt, pct_val, delta, bud_delta in cats:
        row = [name, kr(amt), pct(pct_val),
               pct(delta, show_sign=True)]
        if show_budget and bud_delta is not None:
            row.append(pct(bud_delta, show_sign=True))
        elif show_budget:
            row.append("—")
        rows.append(row)

    # Totals row
    tc    = d["total_costs"]
    tc_pct= round(tc/d["revenue"]*100,1)
    rows.append(["Total Costs", kr(tc), pct(tc_pct), "—",
                 "—"] if show_budget else ["Total Costs", kr(tc), pct(tc_pct), "—"])

    col_w = [5.5*cm, 3.5*cm, 3.0*cm, 3.0*cm]
    if show_budget: col_w.append(2.5*cm)

    table = Table(rows, colWidths=col_w, repeatRows=1)
    style = [
        ("BACKGROUND",    (0,0), (-1,0),  BLUE),
        ("TEXTCOLOR",     (0,0), (-1,0),  colors.white),
        ("FONTNAME",      (0,0), (-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,-1), 9),
        ("BACKGROUND",    (0,-1),(-1,-1), BLUE_L),
        ("FONTNAME",      (0,-1),(-1,-1), "Helvetica-Bold"),
        ("ROWBACKGROUNDS",(0,1), (-1,-2), [colors.white, CREAM]),
        ("GRID",          (0,0), (-1,-1), 0.3, STONE),
        ("TOPPADDING",    (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING",   (0,0), (-1,-1), 6),
        ("RIGHTPADDING",  (0,0), (-1,-1), 6),
        ("ALIGN",         (1,0), (-1,-1), "RIGHT"),
    ]
    # Colour deltas red/green
    for i, (_, __, ___, delta, ____) in enumerate(cats, 1):
        col = RED if delta > 5 else (GREEN if delta < -5 else DARK)
        style.append(("TEXTCOLOR", (3,i), (3,i), col))

    table.setStyle(TableStyle(style))
    return table


# ══════════════════════════════════════════════════════════════════
# AI INSIGHTS GENERATOR
# ══════════════════════════════════════════════════════════════════

def generate_insights(d, report_type, api_key=""):
    """
    Generate 3-5 AI insights using Claude API.
    Falls back to rule-based insights if API unavailable.
    """
    if api_key:
        try:
            prompt = f"""You are a restaurant financial analyst for {d.get('company','Restaurang Björken')}.

Generate {3 if report_type=='daily' else 4 if report_type=='weekly' else 5} specific, data-driven insights for a {report_type} financial report.

Data:
- Revenue: {kr(d['revenue'])} ({pct(d['rev_delta'], True)} vs prior period)
- Staff costs: {kr(d['staff'])} ({pct(d['staff_pct'])} of revenue, {pct(d['staff_delta'], True)} vs prior)
- Food & Bev: {kr(d['food'])} ({pct(d['food_pct'])} of revenue, {pct(d['food_delta'], True)} vs prior)
- Rent: {kr(d['rent'])} ({pct(d['rent_pct'])} of revenue)
- Net profit: {kr(d['profit'])} ({pct(d['margin'])} margin)

Write each insight as ONE sentence (max 20 words). Be specific with numbers. Focus on the most important point.
Format: JSON array of strings. Example: ["Food costs rose 8% due to Menigo price increase in March.", "..."]
Return ONLY the JSON array."""

            data = json.dumps({
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 400,
                "messages": [{"role": "user", "content": prompt}]
            }).encode()
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=data,
                headers={"Content-Type": "application/json",
                         "x-api-key": api_key,
                         "anthropic-version": "2023-06-01"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read())
                text = result["content"][0]["text"]
                text = text.strip().lstrip("```json").rstrip("```").strip()
                return json.loads(text)
        except Exception as e:
            log(f"AI insights failed ({e}) — using rule-based fallback")

    # Rule-based fallback insights
    insights = []
    if d["rev_delta"] > 5:
        insights.append(f"Revenue grew {pct(d['rev_delta'])} to {kr(d['revenue'])} — strong performance above prior period.")
    elif d["rev_delta"] < -5:
        insights.append(f"Revenue declined {pct(abs(d['rev_delta']))} to {kr(d['revenue'])} — monitor guest covers and average spend.")
    else:
        insights.append(f"Revenue stable at {kr(d['revenue'])}, {pct(abs(d['rev_delta']))} from prior period.")

    if d["food_pct"] > 32:
        insights.append(f"Food & Bev costs at {pct(d['food_pct'])} — above 31% target. Review Menigo and Sysco invoices for price changes.")
    else:
        insights.append(f"Food & Bev costs at {pct(d['food_pct'])} — within the 31% target. Supplier pricing stable.")

    if d["staff_pct"] > 42:
        insights.append(f"Staff at {pct(d['staff_pct'])} of revenue — significantly above 40% target. Overtime or sick leave may be elevated.")
    elif d["staff_pct"] > 40:
        insights.append(f"Staff costs at {pct(d['staff_pct'])} — slightly above target. Review scheduling efficiency.")
    else:
        insights.append(f"Staff costs {pct(d['staff_pct'])} — within target range.")

    if d["margin"] < 10:
        insights.append(f"Profit margin at {pct(d['margin'])} — below 12% benchmark. Combined cost pressures are compressing profitability.")
    else:
        insights.append(f"Profit margin {pct(d['margin'])} ({kr(d['profit'])}) — meeting performance targets.")

    if report_type in ("monthly", "quarterly"):
        insights.append("Recommended action: renegotiate Menigo contract and review staffing schedule to improve Q2 margin.")

    return insights[:5]


# ══════════════════════════════════════════════════════════════════
# REPORT GENERATORS
# ══════════════════════════════════════════════════════════════════

class ReportGenerator:

    def __init__(self):
        self.cfg    = load_config()
        self.d      = get_data(self.cfg)
        self.styles = build_styles()
        self.company= self.cfg["company"]["name"]
        self.api_key= self.cfg.get("anthropic_api_key", "")

    def _doc(self, path, title, period):
        """Create a SimpleDocTemplate with shared page callbacks."""
        doc = SimpleDocTemplate(
            str(path),
            pagesize=A4,
            topMargin=1.4*cm, bottomMargin=1.2*cm,
            leftMargin=2.0*cm, rightMargin=2.0*cm,
            title=title, author=self.company,
        )
        report_type = title.split("—")[0].strip()
        doc._header_cb = lambda c,d: page_header(c, d, self.company, report_type, period)
        return doc

    def _build(self, doc, story):
        doc.build(story, onFirstPage=doc._header_cb,
                         onLaterPages=doc._header_cb)

    # ── DAILY REPORT ───────────────────────────────────────────────
    def daily(self, output_path=None):
        """1-page daily summary: numbers-focused, fast to read."""
        d = self.d
        date_str = datetime.now().strftime("%A %d %B %Y")
        period   = d["current_period"]
        path     = output_path or OUTPUT / f"daily_{datetime.now().strftime('%Y%m%d')}.pdf"

        doc   = self._doc(path, f"Daglig Sammanfattning — {date_str}", period)
        story = []

        # Title block
        story.append(Spacer(1, 0.4*cm))
        story.append(Paragraph(f"Daglig Sammanfattning", self.styles["ReportTitle"]))
        story.append(Paragraph(f"{date_str}  ·  {self.company}", self.styles["ReportSubtitle"]))
        story.append(HRFlowable(width="100%", thickness=1.5, color=NAVY, spaceAfter=10))

        # KPI row
        story.append(kpi_row(self.styles, [
            ("Revenue",       kr(d["revenue"]),    period, d["rev_delta"],   True),
            ("Total Costs",   kr(d["total_costs"]), f"{pct(round(d['total_costs']/d['revenue']*100,1))} of rev", None, False),
            ("Net Profit",    kr(d["profit"]),      pct(d["margin"])+" margin", None, True),
            ("Food & Bev",    pct(d["food_pct"]),   kr(d["food"]), d["food_delta"], False),
        ]))
        story.append(Spacer(1, 0.5*cm))

        # Today's top expenses table
        story.append(section_divider("Top Expenses — Period to Date", self.styles))
        suppliers = d.get("top_suppliers", [])
        if suppliers:
            rows = [["Leverantör", "Kategori", "Belopp"]]
            for s in suppliers[:6]:
                rows.append([s["name"], s["category"].title(), kr(s["amount"])])
            t = Table(rows, colWidths=[8*cm, 3.5*cm, 3.5*cm])
            t.setStyle(TableStyle([
                ("BACKGROUND", (0,0),(-1,0), BLUE),
                ("TEXTCOLOR",  (0,0),(-1,0), colors.white),
                ("FONTNAME",   (0,0),(-1,0), "Helvetica-Bold"),
                ("FONTSIZE",   (0,0),(-1,-1), 9),
                ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, CREAM]),
                ("GRID",       (0,0),(-1,-1), 0.3, STONE),
                ("TOPPADDING", (0,0),(-1,-1), 5),
                ("BOTTOMPADDING",(0,0),(-1,-1), 5),
                ("LEFTPADDING",(0,0),(-1,-1), 6),
                ("ALIGN",      (2,0),(-1,-1), "RIGHT"),
            ]))
            story.append(t)

        # Quick alerts
        story.append(Spacer(1, 0.4*cm))
        alerts = []
        t = self.cfg["thresholds"]
        if d["food_pct"] > t["food_pct_warn"]:
            alerts.append(f"Food & Bev at {pct(d['food_pct'])} — above {pct(t['food_pct_warn'])} warning threshold")
        if d["staff_pct"] > t["staff_pct_warn"]:
            alerts.append(f"Staff costs at {pct(d['staff_pct'])} — above {pct(t['staff_pct_warn'])} warning threshold")
        if d["margin"] < t["profit_margin_warn"]:
            alerts.append(f"Profit margin {pct(d['margin'])} — below {pct(t['profit_margin_warn'])} target")

        if alerts:
            story.append(section_divider("Alerts", self.styles, RED))
            for a in alerts:
                story.append(Paragraph(f"⚠  {a}", ParagraphStyle(
                    "AlertText", fontSize=9, textColor=RED,
                    fontName="Helvetica", spaceAfter=3, leftIndent=8)))
        else:
            story.append(Paragraph("✓  All metrics within target ranges.",
                                   ParagraphStyle("OKText", fontSize=9,
                                   textColor=GREEN, fontName="Helvetica-Bold")))

        # AI insights (2 for daily)
        insights = generate_insights(d, "daily", self.api_key)[:2]
        story.append(insight_box(insights, self.styles, "Key Observations"))

        self._build(doc, story)
        log(f"Daily report: {path}")
        return path

    # ── WEEKLY REPORT ──────────────────────────────────────────────
    def weekly(self, output_path=None):
        """2-3 page weekly management report with trends."""
        d = self.d
        week = datetime.now().isocalendar()[1]
        path = output_path or OUTPUT / f"weekly_w{week}_{datetime.now().year}.pdf"

        doc   = self._doc(path, f"Veckorapport — Vecka {week}", d["current_period"])
        story = []

        # Cover
        story.append(Spacer(1, 0.4*cm))
        story.append(Paragraph("Veckorapport", self.styles["ReportTitle"]))
        story.append(Paragraph(
            f"Vecka {week}, {datetime.now().year}  ·  {self.company}",
            self.styles["ReportSubtitle"]))
        story.append(HRFlowable(width="100%", thickness=1.5, color=NAVY, spaceAfter=10))

        # KPI row with deltas
        story.append(kpi_row(self.styles, [
            ("Revenue",    kr(d["revenue"]),    d["current_period"], d["rev_delta"],   True),
            ("Food & Bev", pct(d["food_pct"]),  kr(d["food"]),       d["food_delta"],  False),
            ("Staff",      pct(d["staff_pct"]), kr(d["staff"]),      d["staff_delta"], False),
            ("Net Profit", kr(d["profit"]),     pct(d["margin"]),    None,             True),
        ]))
        story.append(Spacer(1, 0.5*cm))

        # Revenue trend chart
        story.append(section_divider("Revenue Trend", self.styles))
        rev_chart = make_bar_chart(
            d["monthly_labels"],
            [d["monthly_revenue"],
             [d.get("budget_revenue",0)] * len(d["monthly_labels"])],
            width=16*cm, height=5.5*cm,
            title="Monthly Revenue vs Budget (kr)",
            colors_list=[BLUE, STONE]
        )
        story.append(rev_chart)
        story.append(Paragraph(
            "Blue = Actual revenue  ·  Grey = Budget target",
            self.styles["BJCaption"]))
        story.append(Spacer(1, 0.4*cm))

        # Cost breakdown
        story.append(section_divider("Cost Analysis", self.styles))
        story.append(cost_table(d, self.styles))
        story.append(Spacer(1, 0.4*cm))

        # Insights
        insights = generate_insights(d, "weekly", self.api_key)[:3]
        story.append(insight_box(insights, self.styles, "Weekly Insights"))

        # Supplier summary
        story.append(PageBreak())
        story.append(section_divider("Top Suppliers This Period", self.styles))
        suppliers = d.get("top_suppliers", [])
        if suppliers:
            rows = [["Leverantör", "Kategori", "Belopp", "% av kostnader"]]
            total_costs = d["total_costs"]
            for s in suppliers[:8]:
                rows.append([
                    s["name"], s["category"].title(), kr(s["amount"]),
                    pct(round(s["amount"]/total_costs*100, 1))
                ])
            t = Table(rows, colWidths=[7.5*cm, 2.8*cm, 3.2*cm, 2.8*cm])
            t.setStyle(TableStyle([
                ("BACKGROUND", (0,0),(-1,0), BLUE),
                ("TEXTCOLOR",  (0,0),(-1,0), colors.white),
                ("FONTNAME",   (0,0),(-1,0), "Helvetica-Bold"),
                ("FONTSIZE",   (0,0),(-1,-1), 9),
                ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, CREAM]),
                ("GRID",       (0,0),(-1,-1), 0.3, STONE),
                ("TOPPADDING", (0,0),(-1,-1), 5),
                ("BOTTOMPADDING",(0,0),(-1,-1),5),
                ("LEFTPADDING",(0,0),(-1,-1), 6),
                ("ALIGN",      (2,0),(-1,-1), "RIGHT"),
            ]))
            story.append(t)

        self._build(doc, story)
        log(f"Weekly report: {path}")
        return path

    # ── MONTHLY REPORT ─────────────────────────────────────────────
    def monthly(self, output_path=None):
        """5-7 page comprehensive monthly report with full charts."""
        d = self.d
        month_name = d["current_period"]
        path = output_path or OUTPUT / f"monthly_{datetime.now().strftime('%Y%m')}.pdf"

        doc   = self._doc(path, f"Månadsrapport — {month_name}", month_name)
        story = []

        # ── Page 1: Executive summary ─────────────────────────────
        story.append(Spacer(1, 0.3*cm))
        story.append(Paragraph("Månadsrapport", self.styles["ReportTitle"]))
        story.append(Paragraph(
            f"{month_name}  ·  {self.company}  ·  Konfidentiellt",
            self.styles["ReportSubtitle"]))
        story.append(HRFlowable(width="100%", thickness=2, color=NAVY, spaceAfter=10))

        # 4 KPI cards
        story.append(kpi_row(self.styles, [
            ("Omsättning",     kr(d["revenue"]),    d["current_period"], d["rev_delta"],   True),
            ("Rörelsekostnad", kr(d["total_costs"]), pct(round(d["total_costs"]/d["revenue"]*100,1))+" av oms", None, False),
            ("Rörelseresultat",kr(d["profit"]),      pct(d["margin"])+" marginal", None,   True),
            ("Mat & Dryck",    pct(d["food_pct"]),   kr(d["food"]),      d["food_delta"],  False),
        ]))
        story.append(Spacer(1, 0.4*cm))

        # Executive summary text
        story.append(section_divider("Verkställande Sammanfattning", self.styles))
        summary_text = (
            f"Restaurang Björken redovisar en omsättning om <b>{kr(d['revenue'])}</b> för {month_name}, "
            f"en förändring om {pct(d['rev_delta'], True)} jämfört med föregående period. "
            f"Rörelsemarginalen uppgick till <b>{pct(d['margin'])}</b> ({kr(d['profit'])}) och är "
            f"{'under' if d['margin'] < 12 else 'i linje med'} branschriktvärdet om 12–18%. "
            f"Personalkostnader på {pct(d['staff_pct'])} och råvarukostnader på {pct(d['food_pct'])} "
            f"är de{'  viktigaste kostnadsdrivarna' if d['staff_pct']>40 or d['food_pct']>31 else ' inom budgetramarna'}."
        )
        story.append(Paragraph(summary_text, self.styles["BJBodyText"]))

        # AI Insights
        insights = generate_insights(d, "monthly", self.api_key)
        story.append(insight_box(insights, self.styles, "Analys & Rekommendationer"))

        # ── Page 2: Revenue analysis ──────────────────────────────
        story.append(PageBreak())
        story.append(section_divider("2. Intäktsanalys", self.styles))

        # Revenue bar chart
        rev_chart = make_bar_chart(
            d["monthly_labels"],
            [d["monthly_revenue"],
             [d.get("budget_revenue",490000)] * len(d["monthly_labels"])],
            width=16*cm, height=6*cm,
            title="Månadsvis omsättning vs budget",
            colors_list=[BLUE, STONE]
        )
        story.append(rev_chart)
        story.append(Paragraph(
            "Staplar: Faktisk omsättning (blå) vs budget (grå)", self.styles["BJCaption"]))
        story.append(Spacer(1, 0.5*cm))

        # Revenue breakdown table
        rev_rows = [
            ["Intäktskälla", "Belopp", "% av totalt"],
            ["Matintäkter",       kr(312500), "61.8%"],
            ["Dryckesintäkter",   kr(175000), "34.6%"],
            ["Cateringintäkter",  kr(18400),  "3.6%"],
            ["TOTALT",            kr(d["revenue"]), "100%"],
        ]
        rt = Table(rev_rows, colWidths=[7*cm, 4*cm, 4*cm])
        rt.setStyle(TableStyle([
            ("BACKGROUND",    (0,0),(-1,0),  BLUE),
            ("TEXTCOLOR",     (0,0),(-1,0),  colors.white),
            ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
            ("BACKGROUND",    (0,-1),(-1,-1),GREEN_L),
            ("FONTNAME",      (0,-1),(-1,-1),"Helvetica-Bold"),
            ("FONTSIZE",      (0,0),(-1,-1), 9),
            ("ROWBACKGROUNDS",(0,1),(-1,-2), [colors.white, CREAM]),
            ("GRID",          (0,0),(-1,-1), 0.3, STONE),
            ("TOPPADDING",    (0,0),(-1,-1), 5),
            ("BOTTOMPADDING", (0,0),(-1,-1), 5),
            ("LEFTPADDING",   (0,0),(-1,-1), 6),
            ("ALIGN",         (1,0),(-1,-1), "RIGHT"),
        ]))
        story.append(rt)

        # ── Page 3: Cost analysis ──────────────────────────────────
        story.append(PageBreak())
        story.append(section_divider("3. Kostnadsanalys", self.styles))

        # Side by side: cost table + donut
        donut = make_donut_chart(
            ["Personal", "Råvaror", "Lokal", "Övrigt"],
            [d["staff"], d["food"], d["rent"], d["other"]],
            width=6.5*cm, height=6.5*cm,
            colors_list=[BLUE, GREEN, AMBER, colors.HexColor("#888780")]
        )
        cost_t = cost_table(d, self.styles, show_budget=True)
        combined = Table([[cost_t, donut]], colWidths=[10*cm, 7*cm])
        combined.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP")]))
        story.append(combined)
        story.append(Paragraph(
            "Donut: kostnadsproportioner exkl. intäkter", self.styles["BJCaption"]))

        # ── Page 4: P&L + profit trend ────────────────────────────
        story.append(PageBreak())
        story.append(section_divider("4. Resultaträkning & Marginaltrender", self.styles))

        # P&L table
        pl_rows = [
            ["Post", month_name, "% av oms."],
            ["Nettoomsättning",      kr(d["revenue"]),      "100%"],
            ["  (-) Personalkostnad",kr(-d["staff"]),        pct(-d["staff_pct"])],
            ["  (-) Råvaror & dryck",kr(-d["food"]),         pct(-d["food_pct"])],
            ["  (-) Lokal",          kr(-d["rent"]),          pct(-d["rent_pct"])],
            ["  (-) Övrigt",         kr(-d["other"]),         pct(-d["other_pct"])],
            ["Rörelseresultat (EBIT)",kr(d["profit"]),        pct(d["margin"])],
        ]
        pl_t = Table(pl_rows, colWidths=[8*cm, 4*cm, 4*cm])
        pl_t.setStyle(TableStyle([
            ("BACKGROUND",    (0,0),(-1,0),  BLUE),
            ("TEXTCOLOR",     (0,0),(-1,0),  colors.white),
            ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
            ("BACKGROUND",    (0,-1),(-1,-1),GREEN_L),
            ("FONTNAME",      (0,-1),(-1,-1),"Helvetica-Bold"),
            ("TEXTCOLOR",     (0,-1),(-1,-1),GREEN),
            ("FONTSIZE",      (0,0),(-1,-1), 9),
            ("ROWBACKGROUNDS",(0,1),(-1,-2), [colors.white, CREAM]),
            ("GRID",          (0,0),(-1,-1), 0.3, STONE),
            ("TOPPADDING",    (0,0),(-1,-1), 5),
            ("BOTTOMPADDING", (0,0),(-1,-1), 5),
            ("LEFTPADDING",   (0,0),(-1,-1), 6),
            ("ALIGN",         (1,0),(-1,-1), "RIGHT"),
        ]))
        story.append(pl_t)
        story.append(Spacer(1, 0.5*cm))

        # Profit trend line chart
        profit_chart = make_line_chart(
            d["monthly_labels"],
            [d["monthly_profit"], d["monthly_revenue"]],
            ["Rörelseresultat", "Omsättning"],
            width=16*cm, height=5*cm,
            title="Rörelseresultat och omsättning per månad",
            colors_list=[GREEN, BLUE],
            y_label_fmt=lambda v: f"{int(v/1000)}k"
        )
        story.append(profit_chart)

        # ── Page 5: Recommendations ────────────────────────────────
        story.append(PageBreak())
        story.append(section_divider("5. Rekommendationer", self.styles))

        recs = [
            ("Hög prioritet",
             f"Förhandla om Menigo-avtalet: Råvarukostnader {pct(d['food_pct'])} kräver åtgärd. "
             f"Begär prisfrysning Q2 eller prova Martin & Servera för 30% av volymen."),
            ("Hög prioritet",
             f"Personalschema: Personalkostnader {pct(d['staff_pct'])} överstiger 40%-målet. "
             f"Se över övertidsuttag och sjukfrånvaro."),
            ("Medel prioritet",
             "Q2-budgetrevision rekommenderas baserat på faktiska kostnadsnivåer i mars."),
            ("Medel prioritet",
             "Säkerställ minst 150 000 kr i rörelsekapitalbuffert inför löneutbetalning."),
        ]
        colors_p = [RED, RED, AMBER, AMBER]
        for (priority, text), col in zip(recs, colors_p):
            row_table = Table(
                [[Paragraph(f"<b>{priority}</b>", ParagraphStyle(
                    "PTag", fontSize=8, fontName="Helvetica-Bold",
                    textColor=col, alignment=TA_CENTER)),
                  Paragraph(text, self.styles["BJBodyText"])]],
                colWidths=[2.5*cm, 14.5*cm]
            )
            row_table.setStyle(TableStyle([
                ("BACKGROUND",    (0,0),(0,0), colors.Color(col.red, col.green, col.blue, 0.12)),
                ("TOPPADDING",    (0,0),(-1,-1), 6),
                ("BOTTOMPADDING", (0,0),(-1,-1), 6),
                ("LEFTPADDING",   (0,0),(-1,-1), 6),
                ("VALIGN",        (0,0),(-1,-1), "TOP"),
                ("BOX",           (0,0),(-1,-1), 0.5, STONE),
            ]))
            story.append(row_table)
            story.append(Spacer(1, 0.2*cm))

        self._build(doc, story)
        log(f"Monthly report: {path}")
        return path

    # ── QUARTERLY REPORT ───────────────────────────────────────────
    def quarterly(self, output_path=None):
        """Strategic quarterly review with forecasts."""
        d = self.d
        month     = datetime.now().month
        quarter   = (month - 1) // 3 + 1
        path = output_path or OUTPUT / f"quarterly_Q{quarter}_{datetime.now().year}.pdf"

        doc   = self._doc(path, f"Kvartalsöversikt — Q{quarter} {datetime.now().year}", d["current_period"])
        story = []

        story.append(Spacer(1, 0.3*cm))
        story.append(Paragraph(f"Kvartalsöversikt — Q{quarter} {datetime.now().year}",
                                self.styles["ReportTitle"]))
        story.append(Paragraph(
            f"{self.company}  ·  Strategisk genomgång  ·  Konfidentiellt",
            self.styles["ReportSubtitle"]))
        story.append(HRFlowable(width="100%", thickness=2, color=NAVY, spaceAfter=10))

        # Q1 aggregate KPIs
        q1_rev    = sum(d["monthly_revenue"])
        q1_profit = sum(d["monthly_profit"])
        q1_margin = round(q1_profit / q1_rev * 100, 2) if q1_rev else 0

        story.append(kpi_row(self.styles, [
            ("Q1 Omsättning",   kr(q1_rev),     "Jan–Mars 2026",  None, True),
            ("Q1 Resultat",     kr(q1_profit),  pct(q1_margin),   None, True),
            ("Mars Marginal",   pct(d["margin"]),"vs target 12%",  None, True),
            ("Budgetavvikelse", pct(d["rev_vs_budget"], True),
             "vs budget",      d["rev_vs_budget"], True),
        ]))
        story.append(Spacer(1, 0.5*cm))

        # Quarter summary
        story.append(section_divider("Q1 Sammanfattning", self.styles))
        q_text = (
            f"Q1 2026 total omsättning uppgick till <b>{kr(q1_rev)}</b> med ett rörelseresultat "
            f"om <b>{kr(q1_profit)}</b> ({pct(q1_margin)} marginal). "
            f"Omsättningsutvecklingen är positiv med en trend från {kr(d['monthly_revenue'][0])} i januari "
            f"till {kr(d['monthly_revenue'][-1])} i mars. "
            f"Kostnadsökningar från leverantörer och övertidskostnader har pressat marginalen under kvartalet."
        )
        story.append(Paragraph(q_text, self.styles["BJBodyText"]))

        # Quarterly revenue trend
        story.append(section_divider("Omsättningsutveckling Q1", self.styles))
        rev_chart = make_line_chart(
            d["monthly_labels"],
            [d["monthly_revenue"], d["monthly_profit"]],
            ["Omsättning", "Rörelseresultat"],
            width=16*cm, height=5.5*cm,
            title="Q1 2026 — Omsättning & Rörelseresultat per månad",
            colors_list=[BLUE, GREEN]
        )
        story.append(rev_chart)
        story.append(Spacer(1, 0.5*cm))

        # Q2 forecast
        story.append(PageBreak())
        story.append(section_divider("Q2 Prognos & Budgetrevision", self.styles))

        q2_rev_low  = int(q1_rev * 1.05)
        q2_rev_high = int(q1_rev * 1.12)
        q2_forecast = [
            ["Scenario",        "Q2 Omsättning",        "Antagen marginal", "Q2 Resultat"],
            ["Konservativt (+5%)",kr(q2_rev_low),  "7.0%", kr(int(q2_rev_low  * 0.070))],
            ["Bas (+8%)",        kr(int(q1_rev*1.08)),"8.5%", kr(int(q1_rev*1.08*0.085))],
            ["Optimistiskt (+12%)",kr(q2_rev_high),"10.0%",kr(int(q2_rev_high * 0.100))],
        ]
        ft = Table(q2_forecast, colWidths=[5*cm, 4*cm, 4*cm, 4*cm])
        ft.setStyle(TableStyle([
            ("BACKGROUND",    (0,0),(-1,0),  NAVY),
            ("TEXTCOLOR",     (0,0),(-1,0),  colors.white),
            ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
            ("BACKGROUND",    (0,2),(-1,2),  BLUE_L),
            ("FONTNAME",      (0,2),(-1,2),  "Helvetica-Bold"),
            ("FONTSIZE",      (0,0),(-1,-1), 9),
            ("ROWBACKGROUNDS",(0,1),(-1,-1), [colors.white, CREAM, BLUE_L]),
            ("GRID",          (0,0),(-1,-1), 0.3, STONE),
            ("TOPPADDING",    (0,0),(-1,-1), 6),
            ("BOTTOMPADDING", (0,0),(-1,-1), 6),
            ("LEFTPADDING",   (0,0),(-1,-1), 6),
            ("ALIGN",         (1,0),(-1,-1), "RIGHT"),
        ]))
        story.append(ft)
        story.append(Paragraph(
            "Basscenario (+8%) antar: Menigo-förhandling genomförd, "
            "personalschema optimerat, inga extraordinary händelser.",
            self.styles["BJCaption"]))
        story.append(Spacer(1, 0.5*cm))

        # Strategic initiatives
        story.append(section_divider("Strategiska Prioriteringar Q2", self.styles))
        initiatives = [
            ("Kostnadsreduktion",
             "Förhandla om leverantörsavtal (mål: -5% råvarukostnad). "
             "Implementera nytt schemaläggningsverktyg. "
             "Target: personal under 40% av omsättning."),
            ("Intäktstillväxt",
             "Lansera ny lunchmeny (mål: +15% lunchcovers). "
             "Öka cateringbokningar (nuv. 3.6% av oms., mål 8%). "
             "Aktivera säsongsmeny för sommarsäsong."),
            ("Operationell effektivitet",
             "Fullständig Fortnox-integration klar Q2. "
             "Automatisera bokföringsflöden (spara 5h/vecka). "
             "Implementera kostnadsvarningar i realtid."),
        ]
        for title_i, text in initiatives:
            story.append(Paragraph(f"<b>{title_i}</b>", self.styles["SubHeader"]))
            story.append(Paragraph(text, self.styles["BJBodyText"]))

        # AI Insights
        insights = generate_insights(d, "quarterly", self.api_key)
        story.append(PageBreak())
        story.append(insight_box(insights, self.styles, "Strategisk Analys"))

        self._build(doc, story)
        log(f"Quarterly report: {path}")
        return path


# ══════════════════════════════════════════════════════════════════
# EMAIL DISTRIBUTION
# ══════════════════════════════════════════════════════════════════

def send_email(pdf_path: Path, subject: str, recipients: list, cfg: dict):
    """Send report as email attachment via SMTP."""
    email_cfg = cfg.get("email", {})
    if not email_cfg.get("enabled"):
        log(f"Email disabled — would send '{subject}' to {recipients}")
        return False

    try:
        msg = MIMEMultipart()
        msg["From"]    = f"{email_cfg['from_name']} <{email_cfg['username']}>"
        msg["To"]      = ", ".join(recipients)
        msg["Subject"] = subject

        body = (f"Please find attached the latest report from {cfg['company']['name']}.\n\n"
                f"Generated: {now_str()}\n\nThis is an automated report from the Björken Reporting System.")
        msg.attach(MIMEText(body, "plain", "utf-8"))

        with open(pdf_path, "rb") as f:
            part = MIMEBase("application", "pdf")
            part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f"attachment; filename={pdf_path.name}")
        msg.attach(part)

        with smtplib.SMTP(email_cfg["smtp_host"], email_cfg["smtp_port"]) as server:
            server.ehlo()
            server.starttls()
            server.login(email_cfg["username"], email_cfg["password"])
            server.sendmail(email_cfg["username"], recipients, msg.as_string())

        log(f"Email sent: '{subject}' → {recipients}")
        return True

    except Exception as e:
        log(f"Email failed: {e}")
        return False


# ══════════════════════════════════════════════════════════════════
# SCHEDULER
# ══════════════════════════════════════════════════════════════════

class ReportScheduler:

    def __init__(self):
        self.cfg       = load_config()
        self.generator = ReportGenerator()
        self.running   = False
        self._init_db()

    def _init_db(self):
        """Track what reports have been generated."""
        DB_FILE.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(DB_FILE) as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS report_log (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                report_type  TEXT, generated_at TEXT, path TEXT,
                emailed      INTEGER DEFAULT 0, status TEXT)""")
            conn.commit()

    def _log_report(self, report_type, path, emailed=False):
        with sqlite3.connect(DB_FILE) as conn:
            conn.execute("INSERT INTO report_log(report_type,generated_at,path,emailed,status) VALUES(?,?,?,?,?)",
                         (report_type, now_str(), str(path), int(emailed), "ok"))
            conn.commit()

    def run_now(self, report_type: str):
        """Generate a report immediately."""
        log(f"Generating {report_type} report NOW")
        gen    = ReportGenerator()
        method = getattr(gen, report_type, None)
        if not method:
            log(f"Unknown report type: {report_type}")
            return None

        path = method()
        if not path:
            return None

        cfg_r = self.cfg["schedules"].get(report_type, {})
        recipients = cfg_r.get("recipients", [])
        subject    = cfg_r.get("subject", f"{report_type.title()} Report")
        # Format subject placeholders
        now = datetime.now()
        subject = subject.format(
            date    = now.strftime("%Y-%m-%d"),
            week    = now.isocalendar()[1],
            year    = now.year,
            month   = now.strftime("%B"),
            quarter = (now.month-1)//3 + 1
        )

        emailed = False
        if recipients:
            emailed = send_email(path, subject, recipients, self.cfg)

        self._log_report(report_type, path, emailed)
        log(f"Report complete: {path}")
        return path

    def _should_run(self, report_type: str) -> bool:
        """Check if a scheduled report should run right now."""
        cfg_r = self.cfg["schedules"].get(report_type, {})
        if not cfg_r.get("enabled", False):
            return False

        now  = datetime.now()
        hour = int(cfg_r.get("time", "07:00").split(":")[0])
        mins = int(cfg_r.get("time", "07:00").split(":")[1])

        if now.hour != hour or now.minute != mins:
            return False

        if report_type == "daily":
            day_abbr = now.strftime("%a").lower()
            return day_abbr in [d[:3] for d in cfg_r.get("days", [])]

        if report_type == "weekly":
            return now.strftime("%A").lower() == cfg_r.get("day","monday").lower()

        if report_type == "monthly":
            return now.day == cfg_r.get("day_of_month", 3)

        if report_type == "quarterly":
            return (now.month in cfg_r.get("months", []) and
                    now.day   == cfg_r.get("day_of_month", 5))

        return False

    def watch(self):
        """Blocking loop — checks every minute if any report is due."""
        self.running = True
        log("Scheduler started — checking every minute")
        while self.running:
            try:
                self.cfg = load_config()  # reload config each tick
                for rt in ("daily","weekly","monthly","quarterly"):
                    if self._should_run(rt):
                        log(f"Scheduled trigger: {rt}")
                        self.run_now(rt)
            except Exception as e:
                log(f"Scheduler error: {e}")
            time.sleep(60)

    def status(self):
        """Print next scheduled run times."""
        now = datetime.now()
        print(f"\nReport Scheduler Status — {now_str()}\n{'─'*50}")
        for rt in ("daily","weekly","monthly","quarterly"):
            cfg_r = self.cfg["schedules"].get(rt, {})
            enabled = cfg_r.get("enabled", False)
            time_str = cfg_r.get("time", "—")
            recipients = cfg_r.get("recipients", [])
            print(f"  {rt.upper():12} {'ON ' if enabled else 'OFF'} "
                  f"  time: {time_str:6}  "
                  f"  recipients: {', '.join(recipients) or '—'}")

        with sqlite3.connect(DB_FILE) as conn:
            rows = conn.execute(
                "SELECT report_type,generated_at,path FROM report_log ORDER BY id DESC LIMIT 10"
            ).fetchall()
        if rows:
            print(f"\nRecent reports:")
            for rt, ts, p in rows:
                print(f"  {rt:12} {ts}  →  {Path(p).name}")


# ══════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════

def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    parser = argparse.ArgumentParser(description="Björken Report Scheduler")
    parser.add_argument("--now",    metavar="TYPE",
                        help="Generate report now: daily|weekly|monthly|quarterly|all")
    parser.add_argument("--watch",  action="store_true", help="Start scheduler loop")
    parser.add_argument("--status", action="store_true", help="Show schedule status")
    args = parser.parse_args()

    scheduler = ReportScheduler()

    if args.status:
        scheduler.status()
        return

    if args.now:
        types = ["daily","weekly","monthly","quarterly"] if args.now=="all" else [args.now]
        for rt in types:
            path = scheduler.run_now(rt)
            if path:
                print(f"Generated: {path}")
        return

    if args.watch:
        scheduler.watch()
        return

    # Default: generate all and print status
    scheduler.status()
    print(f"\nUsage: python3 report_scheduler.py --now daily|weekly|monthly|quarterly|all")


if __name__ == "__main__":
    main()
