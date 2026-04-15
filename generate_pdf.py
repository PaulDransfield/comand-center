"""
generate_pdf.py
Generates a print-ready monthly report as PDF using ReportLab.
A4 format, proper typography, tables, page headers/footers.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether
)
from reportlab.platypus.flowables import HRFlowable
from reportlab.lib import colors
from datetime import date
import os

# ── COLOURS ─────────────────────────────────────────────────────
NAVY      = HexColor('#1E2761')
BLUE      = HexColor('#185FA5')
GREEN     = HexColor('#2D6A35')
RED       = HexColor('#A32D2D')
AMBER     = HexColor('#854F0B')
LIGHT_BG  = HexColor('#F2F4F8')
MID_BG    = HexColor('#D8DDE8')
BORDER_C  = HexColor('#C8C3BB')
MUTED_C   = HexColor('#9B9690')
WHITE     = white
BLACK     = black

# ── REPORT DATA ──────────────────────────────────────────────────
DATA = {
    'business': {'name': 'Restaurang Björken AB', 'org': '559059-3025',
                 'address': 'Hornsgatan 14, 118 20 Stockholm'},
    'period':   {'month': 'March', 'year': 2026, 'label': 'Mars 2026'},
    'generated': date.today().isoformat(),
    'financials': {
        'revenue': 505900, 'prev_revenue': 461800, 'revenue_growth': 9.6,
        'staff_cost': 224978, 'staff_pct': 44.5,
        'food_cost':  149300, 'food_pct':  29.5,
        'rent_cost':   64500, 'rent_pct':  12.7,
        'other_cost':  28422, 'other_pct':  5.6,
        'net_profit':  38700, 'margin':     7.65,
        'prev_profit': 29300, 'profit_growth': 32.1,
    },
    'targets': {'staff': 40.0, 'food': 31.0, 'rent': 13.0, 'margin': 12.0},
    'ai_insights': [
        'Revenue grew 9.6% vs February driven by increased weekend covers and improved table turnover.',
        'Staff costs remain the primary concern at 44.5% vs the 40% target — 4.5 percentage points above plan, representing approximately 22,700 kr in excess monthly spend.',
        'Food costs are well-managed at 29.5% against a 31% target. The Menigo contract renegotiation in Q4 2025 appears to be delivering the expected savings.',
        'Key risk: If staff costs remain elevated through Q2, full-year margin will likely settle at 7–8% rather than the 12% target.',
        'Opportunity: Revenue growth momentum is strong. Consider extending Thursday evening opening hours where capacity allows.',
    ],
    'recommendations': [
        'Audit overtime usage — quantify avoidable premium-time hours in March',
        'Review scheduling data against actual payroll to find optimisation gaps',
        'Renegotiate Sysco contract before June renewal — benchmark against Menigo',
        'Consider a 5% price increase on premium menu items to support margin recovery',
        'Target 10% revenue growth in April through targeted social media promotions',
    ],
    'expenses': [
        ('Personalkostnader', 'Staff',       224978),
        ('Lokalhyra',         'Rent',          64500),
        ('Sysco Sverige',     'Food & Bev',    43624),
        ('Menigo Foodservice','Food & Bev',    35064),
        ('Städ & Renhållning','Operations',    18200),
        ('Caspeco AB',        'Software',       2490),
    ],
}

def kr(n): return f"{int(round(n)):,}".replace(',', ' ') + ' kr'
def pct(n): return f"{n:.1f}%"


# ── PAGE TEMPLATE ────────────────────────────────────────────────

class NumberedCanvas:
    """Adds page numbers and headers/footers to each page."""
    def __init__(self, filename, data):
        from reportlab.pdfgen import canvas as pdfcanvas
        self._doc_filename = filename
        self._data         = data
        self._saved_page_states = []

    @staticmethod
    def _make_page_fn(data):
        def on_page(canvas, doc):
            canvas.saveState()
            w, h = A4

            # Header bar
            canvas.setFillColor(NAVY)
            canvas.rect(0, h - 28*mm, w, 10*mm, fill=1, stroke=0)
            canvas.setFillColor(WHITE)
            canvas.setFont('Helvetica', 8)
            canvas.drawString(15*mm, h - 22*mm, data['business']['name'])
            canvas.drawRightString(w - 15*mm, h - 22*mm,
                f"{data['period']['month']} {data['period']['year']}  ·  Command Center")

            # Footer
            canvas.setFillColor(MUTED_C)
            canvas.setFont('Helvetica', 7)
            canvas.drawString(15*mm, 10*mm, f"Confidential  ·  {data['business']['org']}  ·  Generated {data['generated']}")
            canvas.drawRightString(w - 15*mm, 10*mm, f"Page {doc.page}")

            # Footer line
            canvas.setStrokeColor(BORDER_C)
            canvas.setLineWidth(0.3)
            canvas.line(15*mm, 14*mm, w - 15*mm, 14*mm)

            canvas.restoreState()
        return on_page

    def build(self):
        pass  # handled by on_page


# ── STYLE REGISTRY ───────────────────────────────────────────────

def make_styles():
    base = getSampleStyleSheet()
    return {
        'h1': ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=18,
                              textColor=NAVY, spaceBefore=18, spaceAfter=6,
                              borderPadding=(0,0,4,0)),
        'h2': ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=13,
                              textColor=BLUE, spaceBefore=14, spaceAfter=4),
        'h3': ParagraphStyle('h3', fontName='Helvetica-Bold', fontSize=11,
                              textColor=NAVY, spaceBefore=10, spaceAfter=3),
        'body': ParagraphStyle('body', fontName='Helvetica', fontSize=10,
                               textColor=colors.HexColor('#1A1917'), leading=15,
                               spaceBefore=2, spaceAfter=4),
        'body_muted': ParagraphStyle('body_muted', fontName='Helvetica', fontSize=9,
                                      textColor=MUTED_C, leading=13),
        'bullet': ParagraphStyle('bullet', fontName='Helvetica', fontSize=10,
                                  textColor=colors.HexColor('#1A1917'), leading=15,
                                  leftIndent=14, firstLineIndent=-10, spaceBefore=2),
        'label': ParagraphStyle('label', fontName='Helvetica-Bold', fontSize=8,
                                 textColor=MUTED_C, spaceBefore=0, spaceAfter=0),
        'kpi_val': ParagraphStyle('kpi_val', fontName='Helvetica-Bold', fontSize=22,
                                   textColor=NAVY, leading=26, alignment=TA_CENTER),
        'kpi_lbl': ParagraphStyle('kpi_lbl', fontName='Helvetica', fontSize=8,
                                   textColor=MUTED_C, leading=11, alignment=TA_CENTER),
        'cover_title': ParagraphStyle('cover_title', fontName='Helvetica-Bold', fontSize=32,
                                       textColor=NAVY, leading=38, alignment=TA_CENTER),
        'cover_sub': ParagraphStyle('cover_sub', fontName='Helvetica', fontSize=14,
                                     textColor=BLUE, leading=18, alignment=TA_CENTER),
        'cover_muted': ParagraphStyle('cover_muted', fontName='Helvetica', fontSize=9,
                                       textColor=MUTED_C, leading=13, alignment=TA_CENTER),
        'tbl_hdr': ParagraphStyle('tbl_hdr', fontName='Helvetica-Bold', fontSize=9,
                                   textColor=WHITE),
        'tbl_cell': ParagraphStyle('tbl_cell', fontName='Helvetica', fontSize=9,
                                    textColor=colors.HexColor('#1A1917')),
        'tbl_bold': ParagraphStyle('tbl_bold', fontName='Helvetica-Bold', fontSize=9,
                                    textColor=colors.HexColor('#1A1917')),
    }


# ── TABLE HELPERS ────────────────────────────────────────────────

def tbl_style_base(header_rows=1, stripe=True, col_widths=None):
    """Base table style with navy header, stripes, borders."""
    style = [
        # Header
        ('BACKGROUND', (0, 0), (-1, header_rows-1), NAVY),
        ('TEXTCOLOR',  (0, 0), (-1, header_rows-1), WHITE),
        ('FONTNAME',   (0, 0), (-1, header_rows-1), 'Helvetica-Bold'),
        ('FONTSIZE',   (0, 0), (-1, header_rows-1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING',   (0, 0), (-1, -1), 7),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 7),
        ('GRID',      (0, 0), (-1, -1), 0.3, BORDER_C),
        ('ROWBACKGROUNDS', (0, header_rows), (-1, -1),
         [LIGHT_BG, WHITE] if stripe else [WHITE]),
    ]
    return style


# ── SECTIONS ────────────────────────────────────────────────────

def build_cover(S, data):
    story = []
    story.append(Spacer(1, 6*cm))

    story.append(Paragraph('MONTHLY FINANCIAL REPORT', S['label']))
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(data['business']['name'], S['cover_title']))
    story.append(Spacer(1, 0.5*cm))
    story.append(Paragraph(f"{data['period']['month']} {data['period']['year']}", S['cover_sub']))
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(data['business']['org'], S['cover_muted']))
    story.append(Paragraph(data['business']['address'], S['cover_muted']))
    story.append(Spacer(1, 2*cm))
    story.append(HRFlowable(width='60%', thickness=1, color=NAVY, spaceAfter=6))
    story.append(Paragraph(f"Generated {data['generated']}  ·  Command Center", S['cover_muted']))
    story.append(PageBreak())
    return story


def build_kpi_summary(S, f):
    """Four KPI boxes side by side using a Table."""
    story = []
    story.append(Paragraph('Key Performance Indicators', S['h2']))

    margin_color = GREEN if f['margin'] >= 10 else (AMBER if f['margin'] >= 7 else RED)
    staff_color  = RED   if f['staff_pct'] > 40 else GREEN

    kpi_data = [
        [Paragraph(kr(f['revenue']),        S['kpi_val']),
         Paragraph(kr(f['net_profit']),      S['kpi_val']),
         Paragraph(pct(f['margin']),         S['kpi_val']),
         Paragraph(f"+{pct(f['revenue_growth'])}", S['kpi_val'])],
        [Paragraph('Revenue',   S['kpi_lbl']),
         Paragraph('Net Profit',S['kpi_lbl']),
         Paragraph('Net Margin',S['kpi_lbl']),
         Paragraph('vs Feb',    S['kpi_lbl'])],
    ]

    kpi_tbl = Table(kpi_data, colWidths=[4.5*cm, 4.5*cm, 4.5*cm, 4.5*cm])
    kpi_tbl.setStyle(TableStyle([
        ('BACKGROUND',    (0,0), (-1,-1), LIGHT_BG),
        ('BACKGROUND',    (0,0), (0,-1), NAVY),
        ('BACKGROUND',    (1,0), (1,-1), GREEN),
        ('BACKGROUND',    (2,0), (2,-1), BLUE),
        ('BACKGROUND',    (3,0), (3,-1), colors.HexColor('#2D5A27')),
        ('TEXTCOLOR',     (0,0), (-1,-1), WHITE),
        ('ALIGN',         (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',        (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',    (0,0), (-1,-1), 10),
        ('BOTTOMPADDING', (0,0), (-1,-1), 10),
        ('LINEAFTER',     (0,0), (2,-1), 0.5, WHITE),
        ('ROUNDEDCORNERS', (0,0), (-1,-1), 4),
    ]))
    story.append(kpi_tbl)
    story.append(Spacer(1, 0.4*cm))
    return story


def build_executive_summary(S, data):
    story = []
    story.append(Paragraph('Executive Summary', S['h1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_BG, spaceAfter=8))

    f = data['financials']
    story.extend(build_kpi_summary(S, f))

    story.append(Paragraph('AI Analysis', S['h2']))
    for line in data['ai_insights']:
        story.append(Paragraph(line, S['body']))

    story.append(Spacer(1, 0.4*cm))
    story.append(Paragraph('Key Recommendations', S['h2']))
    for rec in data['recommendations']:
        story.append(Paragraph(f'• {rec}', S['bullet']))

    story.append(PageBreak())
    return story


def build_financial_tables(S, data):
    story = []
    story.append(Paragraph('Financial Tables', S['h1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_BG, spaceAfter=8))

    f = data['financials']
    t = data['targets']

    story.append(Paragraph(f"Income Statement — {data['period']['month']} {data['period']['year']}", S['h2']))

    def status_cell(actual_pct, target_pct):
        over = actual_pct > target_pct
        color = RED if over else GREEN
        text = f"{'▲ ' if over else '▼ '}{abs(actual_pct - target_pct):.1f}pp {'over' if over else 'under'}"
        return Paragraph(f'<font color="{"#A32D2D" if over else "#2D6A35"}">{text}</font>', S['tbl_cell'])

    pl_data = [
        # Header
        [Paragraph('Category', S['tbl_hdr']),
         Paragraph('Amount', S['tbl_hdr']),
         Paragraph('% of Revenue', S['tbl_hdr']),
         Paragraph('Target', S['tbl_hdr']),
         Paragraph('Variance', S['tbl_hdr'])],
        # Revenue
        [Paragraph('<b>Revenue</b>', S['tbl_bold']),
         Paragraph(f'<b>{kr(f["revenue"])}</b>', S['tbl_bold']),
         Paragraph('<b>100.0%</b>', S['tbl_bold']),
         Paragraph('—', S['tbl_cell']),
         Paragraph('', S['tbl_cell'])],
        # Staff
        [Paragraph('Staff costs', S['tbl_cell']),
         Paragraph(kr(f['staff_cost']), S['tbl_cell']),
         Paragraph(f'<font color="#A32D2D">{pct(f["staff_pct"])}</font>', S['tbl_cell']),
         Paragraph(pct(t['staff']), S['tbl_cell']),
         status_cell(f['staff_pct'], t['staff'])],
        # Food
        [Paragraph('Food & beverage', S['tbl_cell']),
         Paragraph(kr(f['food_cost']), S['tbl_cell']),
         Paragraph(f'<font color="#2D6A35">{pct(f["food_pct"])}</font>', S['tbl_cell']),
         Paragraph(pct(t['food']), S['tbl_cell']),
         status_cell(f['food_pct'], t['food'])],
        # Rent
        [Paragraph('Rent', S['tbl_cell']),
         Paragraph(kr(f['rent_cost']), S['tbl_cell']),
         Paragraph(pct(f['rent_pct']), S['tbl_cell']),
         Paragraph(pct(t['rent']), S['tbl_cell']),
         status_cell(f['rent_pct'], t['rent'])],
        # Other
        [Paragraph('Other costs', S['tbl_cell']),
         Paragraph(kr(f['other_cost']), S['tbl_cell']),
         Paragraph(pct(f['other_pct']), S['tbl_cell']),
         Paragraph('—', S['tbl_cell']),
         Paragraph('', S['tbl_cell'])],
        # Profit
        [Paragraph('<b>Net Profit</b>', S['tbl_bold']),
         Paragraph(f'<b>{kr(f["net_profit"])}</b>', S['tbl_bold']),
         Paragraph(f'<b>{pct(f["margin"])}</b>', S['tbl_bold']),
         Paragraph(f'<b>{pct(t["margin"])}</b>', S['tbl_bold']),
         status_cell(f['margin'], t['margin'])],
    ]

    pl_tbl = Table(pl_data, colWidths=[4.8*cm, 3.5*cm, 3.0*cm, 2.5*cm, 3.2*cm])
    pl_style = tbl_style_base()
    pl_style.extend([
        # Profit row highlight
        ('BACKGROUND', (0, 6), (-1, 6), NAVY),
        ('TEXTCOLOR',  (0, 6), (-1, 6), WHITE),
        ('FONTNAME',   (0, 6), (-1, 6), 'Helvetica-Bold'),
        # Revenue row bold
        ('FONTNAME',   (0, 1), (-1, 1), 'Helvetica-Bold'),
        ('BACKGROUND', (0, 1), (-1, 1), LIGHT_BG),
    ])
    pl_tbl.setStyle(TableStyle(pl_style))
    story.append(pl_tbl)
    story.append(Spacer(1, 0.5*cm))

    # Top expenses table
    story.append(Paragraph('Top Expenses', S['h2']))
    exp_data = [
        [Paragraph('Supplier', S['tbl_hdr']),
         Paragraph('Category', S['tbl_hdr']),
         Paragraph('Amount', S['tbl_hdr']),
         Paragraph('% of Revenue', S['tbl_hdr'])],
    ]
    total_exp = sum(e[2] for e in data['expenses'])
    for supplier, category, amount in data['expenses']:
        exp_data.append([
            Paragraph(supplier, S['tbl_cell']),
            Paragraph(category, S['tbl_cell']),
            Paragraph(kr(amount), S['tbl_cell']),
            Paragraph(pct(amount / f['revenue'] * 100), S['tbl_cell']),
        ])
    exp_data.append([
        Paragraph('<b>Total shown</b>', S['tbl_bold']),
        Paragraph('', S['tbl_cell']),
        Paragraph(f'<b>{kr(total_exp)}</b>', S['tbl_bold']),
        Paragraph(f'<b>{pct(total_exp/f["revenue"]*100)}</b>', S['tbl_bold']),
    ])

    exp_tbl = Table(exp_data, colWidths=[5.5*cm, 3.5*cm, 3.5*cm, 3.5*cm])
    exp_style = tbl_style_base()
    exp_style.append(('BACKGROUND', (0, len(exp_data)-1), (-1, -1), LIGHT_BG))
    exp_style.append(('FONTNAME',   (0, len(exp_data)-1), (-1, -1), 'Helvetica-Bold'))
    exp_tbl.setStyle(TableStyle(exp_style))
    story.append(exp_tbl)
    story.append(PageBreak())
    return story


def build_kpi_detail_page(S, data):
    f = data['financials']
    t = data['targets']
    story = []
    story.append(Paragraph('KPI Detail', S['h1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_BG, spaceAfter=8))
    story.append(Paragraph('Performance vs targets for this period.', S['body']))
    story.append(Spacer(1, 0.3*cm))

    kpi_rows = [
        [Paragraph('Metric', S['tbl_hdr']),
         Paragraph('Actual', S['tbl_hdr']),
         Paragraph('Target', S['tbl_hdr']),
         Paragraph('Status', S['tbl_hdr']),
         Paragraph('Notes', S['tbl_hdr'])],
        ['Revenue growth', f'+{pct(f["revenue_growth"])}', '+8.0%',
         '✓ On target', 'Strong weekend performance'],
        ['Staff cost %', pct(f['staff_pct']), pct(t['staff']),
         '✗ Over target', 'Review overtime hours'],
        ['Food cost %', pct(f['food_pct']), pct(t['food']),
         '✓ Under target', 'Menigo deal effective'],
        ['Rent %', pct(f['rent_pct']), pct(t['rent']),
         '✓ On target', 'Fixed cost'],
        ['Net margin', pct(f['margin']), pct(t['margin']),
         '✗ Under target', 'Staff cost drag'],
        ['Profit growth', f'+{pct(f["profit_growth"])}', '+20.0%',
         '✓ On target', 'Solid improvement'],
    ]

    # Convert string rows to Paragraphs with colour coding
    formatted_rows = [kpi_rows[0]]
    for row in kpi_rows[1:]:
        status = row[3]
        ok = '✓' in status
        status_para = Paragraph(
            f'<font color="{"#2D6A35" if ok else "#A32D2D"}">{status}</font>',
            S['tbl_cell']
        )
        formatted_rows.append([
            Paragraph(row[0], S['tbl_cell']),
            Paragraph(row[1], S['tbl_bold' if not ok else 'tbl_cell']),
            Paragraph(row[2], S['tbl_cell']),
            status_para,
            Paragraph(row[4], S['tbl_cell']),
        ])

    kpi_tbl = Table(formatted_rows, colWidths=[4.0*cm, 2.5*cm, 2.5*cm, 3.5*cm, 5.0*cm])
    kpi_tbl.setStyle(TableStyle(tbl_style_base()))
    story.append(kpi_tbl)
    story.append(Spacer(1, 0.8*cm))
    story.append(Paragraph('Disclaimer', S['h3']))
    story.append(Paragraph(
        'This report was generated automatically by Command Center. '
        'AI analysis sections use Anthropic Claude and should be reviewed by a qualified '
        'accountant before major financial decisions. All figures are in Swedish kronor (SEK).',
        S['body_muted']
    ))
    return story


# ── MAIN ────────────────────────────────────────────────────────

def generate_pdf(output_path, data=None):
    if data is None:
        data = DATA

    S = make_styles()

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        topMargin=3.2*cm,    # Room for header bar
        bottomMargin=2.2*cm, # Room for footer
        leftMargin=1.8*cm,
        rightMargin=1.8*cm,
        title=f"{data['business']['name']} — {data['period']['month']} {data['period']['year']}",
        author='Command Center',
        subject='Monthly Financial Report',
    )

    on_page = NumberedCanvas._make_page_fn(data)

    story = []
    story.extend(build_cover(S, data))
    story.extend(build_executive_summary(S, data))
    story.extend(build_financial_tables(S, data))
    story.extend(build_kpi_detail_page(S, data))

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    size = os.path.getsize(output_path)
    print(f"PDF saved: {output_path} ({size // 1024}KB)")


if __name__ == '__main__':
    generate_pdf('/home/claude/exports/monthly_report_march_2026.pdf')
