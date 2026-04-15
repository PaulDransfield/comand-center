// generate_report.js
// Generates a full monthly financial report as .docx
// Usage: node generate_report.js

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, PageNumber, NumberFormat, PageBreak,
  HeadingLevel, BorderStyle, WidthType, ShadingType, VerticalAlign,
  LevelFormat, TableOfContents
} = require('docx');
const fs = require('fs');

// ─── DEMO DATA ────────────────────────────────────────────────
const REPORT_DATA = {
  business:  { name: 'Restaurang Björken AB', org: '559059-3025', address: 'Hornsgatan 14, 118 20 Stockholm' },
  period:    { month: 'March', year: 2026, start: '2026-03-01', end: '2026-03-31' },
  generated: new Date().toLocaleDateString('sv-SE'),
  financials: {
    revenue:     505900,
    staffCost:   224978, staffPct:   44.5,
    foodCost:    149300, foodPct:    29.5,
    rentCost:     64500, rentPct:    12.7,
    otherCost:    28422, otherPct:    5.6,
    netProfit:    38700, margin:      7.65,
    prevRevenue:  461800,
    prevProfit:   29300,
    revenueGrowth: 9.6,
    profitGrowth:  32.1,
  },
  targets: { staff: 40, food: 31, rent: 13, margin: 12 },
  topExpenses: [
    { supplier: 'Menigo Foodservice',     amount: 35064, category: 'Food & Beverage' },
    { supplier: 'Sysco Sverige',          amount: 43624, category: 'Food & Beverage' },
    { supplier: 'Lokalhyra',              amount: 64500, category: 'Rent' },
    { supplier: 'Personalkostnader',      amount: 224978, category: 'Staff' },
    { supplier: 'Städ & Renhållning',     amount: 18200, category: 'Operations' },
  ],
  recommendations: [
    'Audit overtime usage — quantify avoidable premium-time hours in March',
    'Review Caspeco schedule data against actual payroll to find scheduling gaps',
    'Renegotiate Sysco contract before renewal in June — benchmark against Menigo pricing',
    'Consider a 5% price increase on premium menu items to support margin recovery',
    'Target 10% revenue growth in April by promoting the lunch menu via social media',
  ],
  aiInsights: [
    'Revenue grew 9.6% vs February driven by increased weekend covers.',
    'Staff costs remain the primary concern at 44.5% vs the 40% target — 4.5 pp above plan, representing approx 22,700 kr excess spend.',
    'Food costs well-managed at 29.5% vs 31% target. Menigo renegotiation delivering expected savings.',
    'Key risk: If staff costs stay elevated through Q2, full-year margin will settle at 7-8% vs 12% target.',
    'Opportunity: Revenue momentum (+9.6%) is strong. Consider extending Thursday evening hours.',
  ],
};

// ─── HELPERS ──────────────────────────────────────────────────
const KR = (n) => Math.round(n).toLocaleString('sv-SE') + ' kr';
const PCT = (n) => n.toFixed(1) + '%';

// Colours
const C = {
  navy:    '1E2761',
  blue:    '185FA5',
  green:   '2D6A35',
  red:     'A32D2D',
  amber:   '854F0B',
  white:   'FFFFFF',
  light:   'F2F4F8',
  mid:     'D8DDE8',
  border:  'C8C3BB',
  text:    '1A1917',
  muted:   '6B6860',
};

const border = (color = C.border) => ({ style: BorderStyle.SINGLE, size: 4, color });
const borders = (color = C.border) => ({ top: border(color), bottom: border(color), left: border(color), right: border(color) });
const noBorders = () => ({ top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } });

function cell(text, opts = {}) {
  const { bold = false, color = C.text, bgColor, align = AlignmentType.LEFT, width = 2340, size = 20 } = opts;
  return new TableCell({
    borders: opts.noBorder ? noBorders() : borders(C.border),
    width:   { size: width, type: WidthType.DXA },
    shading: bgColor ? { fill: bgColor, type: ShadingType.CLEAR } : undefined,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [new Paragraph({
      alignment: align,
      children:  [new TextRun({ text: String(text), bold, color, size, font: 'Arial' })],
    })],
  });
}

function spacer(lines = 1) {
  return Array.from({ length: lines }, () => new Paragraph({ children: [new TextRun('')] }));
}

function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, font: 'Arial' })],
  });
}

function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, font: 'Arial' })],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    alignment: opts.align || AlignmentType.LEFT,
    spacing:   { after: opts.after ?? 120 },
    children:  [new TextRun({ text, font: 'Arial', size: 22, color: C.text, ...opts })],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    children:  [new TextRun({ text, font: 'Arial', size: 22, color: C.text })],
  });
}

function kpiRow(label, actual, target, status) {
  const statusColor = status === 'ok' ? C.green : status === 'warn' ? C.amber : C.red;
  const statusText  = status === 'ok' ? 'On target' : status === 'warn' ? 'Slightly over' : 'Over target';
  // Total column width = 9360 DXA, split: 3200 + 2160 + 2000 + 2000
  return new TableRow({ children: [
    cell(label,       { width: 3200, size: 22 }),
    cell(actual,      { width: 2160, align: AlignmentType.RIGHT, size: 22 }),
    cell(target,      { width: 2000, align: AlignmentType.RIGHT, size: 22 }),
    cell(statusText,  { width: 2000, align: AlignmentType.CENTER, size: 20, bold: true, color: statusColor }),
  ]});
}

// ─── DOCUMENT SECTIONS ────────────────────────────────────────

function buildCoverPage(data) {
  const { business, period } = data;
  return [
    // Giant spacer to push content to middle of page
    new Paragraph({ spacing: { before: 2880 }, children: [new TextRun('')] }),

    // Report type label
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: 'MONTHLY FINANCIAL REPORT', font: 'Arial', size: 22, color: C.muted, bold: true })],
    }),

    // Business name
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: business.name, font: 'Arial', size: 52, bold: true, color: C.navy })],
    }),

    // Period
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: `${period.month} ${period.year}`, font: 'Arial', size: 40, color: C.blue })],
    }),

    // Org number
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: business.org, font: 'Arial', size: 22, color: C.muted })],
    }),

    // Address
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 2000 },
      children: [new TextRun({ text: business.address, font: 'Arial', size: 22, color: C.muted })],
    }),

    // Horizontal rule — narrow table used as a divider
    new Table({
      width: { size: 4680, type: WidthType.DXA },
      columnWidths: [4680],
      rows: [new TableRow({ children: [
        new TableCell({
          borders: { top: border(C.navy), bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new TextRun('')] })],
        }),
      ]})],
    }),

    new Paragraph({ spacing: { after: 120 }, children: [new TextRun('')] }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Generated ${data.generated} · Command Center`, font: 'Arial', size: 18, color: C.muted })],
    }),

    // Page break to start content
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function buildExecutiveSummary(data) {
  const f = data.financials;
  return [
    heading1('Executive Summary'),
    ...spacer(1),

    body(`This report covers the financial performance of ${data.business.name} for the period ${data.period.start} to ${data.period.end}.`),
    ...spacer(1),

    // KPI summary box — 4-cell table
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2340, 2340, 2340, 2340],
      rows: [
        // Header row
        new TableRow({ children: [
          cell('Revenue',    { width: 2340, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.CENTER }),
          cell('Net Profit', { width: 2340, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.CENTER }),
          cell('Margin',     { width: 2340, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.CENTER }),
          cell('vs Feb',     { width: 2340, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.CENTER }),
        ]}),
        // Values row
        new TableRow({ children: [
          cell(KR(f.revenue),    { width: 2340, bold: true, size: 28, align: AlignmentType.CENTER, bgColor: C.light }),
          cell(KR(f.netProfit),  { width: 2340, bold: true, size: 28, align: AlignmentType.CENTER, bgColor: C.light, color: C.green }),
          cell(PCT(f.margin),    { width: 2340, bold: true, size: 28, align: AlignmentType.CENTER, bgColor: C.light }),
          cell('+' + PCT(f.revenueGrowth), { width: 2340, bold: true, size: 28, align: AlignmentType.CENTER, bgColor: C.light, color: C.green }),
        ]}),
      ],
    }),

    ...spacer(1),
    heading2('AI Analysis'),
    ...data.aiInsights.map(line => body(line)),

    ...spacer(1),
    heading2('Key Recommendations'),
    ...data.recommendations.map(r => bullet(r)),

    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function buildFinancialTables(data) {
  const f = data.financials;

  const rowBg = (i) => i % 2 === 0 ? C.light : C.white;

  return [
    heading1('Financial Tables'),
    ...spacer(1),
    heading2('Income Statement — ' + data.period.month + ' ' + data.period.year),
    ...spacer(1),

    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [3960, 2000, 1700, 1700],
      rows: [
        // Header
        new TableRow({ children: [
          cell('Category',         { width: 3960, bold: true, bgColor: C.navy, color: C.white }),
          cell('Amount (kr)',      { width: 2000, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.RIGHT }),
          cell('% of Revenue',     { width: 1700, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.RIGHT }),
          cell('Target %',         { width: 1700, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.RIGHT }),
        ]}),

        // Revenue
        new TableRow({ children: [
          cell('Revenue',              { width: 3960, bold: true, bgColor: rowBg(0) }),
          cell(KR(f.revenue),          { width: 2000, bold: true, align: AlignmentType.RIGHT, bgColor: rowBg(0) }),
          cell('100.0%',               { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(0) }),
          cell('—',                    { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(0), color: C.muted }),
        ]}),

        // Staff
        new TableRow({ children: [
          cell('Staff costs',          { width: 3960, bgColor: rowBg(1) }),
          cell(KR(f.staffCost),        { width: 2000, align: AlignmentType.RIGHT, bgColor: rowBg(1), color: f.staffPct > data.targets.staff ? C.red : C.text }),
          cell(PCT(f.staffPct),        { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(1), color: f.staffPct > data.targets.staff ? C.red : C.text }),
          cell(PCT(data.targets.staff),{ width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(1), color: C.muted }),
        ]}),

        // Food
        new TableRow({ children: [
          cell('Food & beverage',      { width: 3960, bgColor: rowBg(2) }),
          cell(KR(f.foodCost),         { width: 2000, align: AlignmentType.RIGHT, bgColor: rowBg(2), color: f.foodPct > data.targets.food ? C.red : C.green }),
          cell(PCT(f.foodPct),         { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(2), color: f.foodPct > data.targets.food ? C.red : C.green }),
          cell(PCT(data.targets.food), { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(2), color: C.muted }),
        ]}),

        // Rent
        new TableRow({ children: [
          cell('Rent',                 { width: 3960, bgColor: rowBg(3) }),
          cell(KR(f.rentCost),         { width: 2000, align: AlignmentType.RIGHT, bgColor: rowBg(3) }),
          cell(PCT(f.rentPct),         { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(3) }),
          cell(PCT(data.targets.rent), { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(3), color: C.muted }),
        ]}),

        // Other
        new TableRow({ children: [
          cell('Other costs',          { width: 3960, bgColor: rowBg(4) }),
          cell(KR(f.otherCost),        { width: 2000, align: AlignmentType.RIGHT, bgColor: rowBg(4) }),
          cell(PCT(f.otherPct),        { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(4) }),
          cell('—',                    { width: 1700, align: AlignmentType.RIGHT, bgColor: rowBg(4), color: C.muted }),
        ]}),

        // Profit (highlighted)
        new TableRow({ children: [
          cell('Net Profit',           { width: 3960, bold: true, bgColor: C.navy, color: C.white }),
          cell(KR(f.netProfit),        { width: 2000, bold: true, align: AlignmentType.RIGHT, bgColor: C.navy, color: C.white }),
          cell(PCT(f.margin),          { width: 1700, bold: true, align: AlignmentType.RIGHT, bgColor: C.navy, color: C.white }),
          cell(PCT(data.targets.margin),{width: 1700, bold: true, align: AlignmentType.RIGHT, bgColor: C.navy, color: C.white }),
        ]}),
      ],
    }),

    ...spacer(2),
    heading2('Top Expenses'),
    ...spacer(1),

    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [3960, 2700, 2700],
      rows: [
        new TableRow({ children: [
          cell('Supplier',  { width: 3960, bold: true, bgColor: C.navy, color: C.white }),
          cell('Category',  { width: 2700, bold: true, bgColor: C.navy, color: C.white }),
          cell('Amount',    { width: 2700, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.RIGHT }),
        ]}),
        ...data.topExpenses.map((e, i) => new TableRow({ children: [
          cell(e.supplier,  { width: 3960, bgColor: rowBg(i) }),
          cell(e.category,  { width: 2700, bgColor: rowBg(i), color: C.muted }),
          cell(KR(e.amount),{ width: 2700, bgColor: rowBg(i), align: AlignmentType.RIGHT }),
        ]})),
      ],
    }),

    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function buildKPIPage(data) {
  const f = data.financials;
  const t = data.targets;

  return [
    heading1('KPI Dashboard'),
    ...spacer(1),
    body('Performance against targets for ' + data.period.month + ' ' + data.period.year + '.'),
    ...spacer(1),

    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [3200, 2160, 2000, 2000],
      rows: [
        new TableRow({ children: [
          cell('Metric',        { width: 3200, bold: true, bgColor: C.navy, color: C.white }),
          cell('Actual',        { width: 2160, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.RIGHT }),
          cell('Target',        { width: 2000, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.RIGHT }),
          cell('Status',        { width: 2000, bold: true, bgColor: C.navy, color: C.white, align: AlignmentType.CENTER }),
        ]}),
        kpiRow('Revenue growth',      '+' + PCT(f.revenueGrowth), '+8.0%',          'ok'),
        kpiRow('Staff cost %',        PCT(f.staffPct),             PCT(t.staff),     'err'),
        kpiRow('Food cost %',         PCT(f.foodPct),              PCT(t.food),      'ok'),
        kpiRow('Rent %',              PCT(f.rentPct),              PCT(t.rent),      'ok'),
        kpiRow('Net margin',          PCT(f.margin),               PCT(t.margin),    'err'),
        kpiRow('Profit growth',       '+' + PCT(f.profitGrowth),  '+20.0%',          'ok'),
      ],
    }),

    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ─── MAIN GENERATOR ───────────────────────────────────────────
async function generateReport(data, outputPath) {
  const doc = new Document({
    creator:  'Command Center',
    title:    `${data.business.name} — ${data.period.month} ${data.period.year} Report`,
    subject:  'Monthly Financial Report',
    keywords: 'restaurant finance monthly report',

    styles: {
      default: { document: { run: { font: 'Arial', size: 22 } } },
      paragraphStyles: [
        {
          id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 36, bold: true, font: 'Arial', color: C.navy },
          paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0,
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.mid } } },
        },
        {
          id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 28, bold: true, font: 'Arial', color: C.blue },
          paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 },
        },
      ],
    },

    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      }],
    },

    sections: [{
      properties: {
        page: {
          size:   { width: 11906, height: 16838 },  // A4
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.mid } },
            children: [new TextRun({
              text: `${data.business.name}  ·  ${data.period.month} ${data.period.year}  ·  Command Center`,
              font: 'Arial', size: 18, color: C.muted,
            })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.mid } },
            children: [
              new TextRun({ text: 'Page ', font: 'Arial', size: 18, color: C.muted }),
              new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 18, color: C.muted }),
              new TextRun({ text: ' of ', font: 'Arial', size: 18, color: C.muted }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Arial', size: 18, color: C.muted }),
              new TextRun({ text: `  ·  Confidential  ·  Generated ${data.generated}`, font: 'Arial', size: 18, color: C.muted }),
            ],
          })],
        }),
      },
      children: [
        ...buildCoverPage(data),
        ...buildExecutiveSummary(data),
        ...buildFinancialTables(data),
        ...buildKPIPage(data),
        // Final notes page
        heading1('Notes & Disclaimers'),
        ...spacer(1),
        body('This report was generated automatically by Command Center using data from Fortnox and uploaded documents.'),
        body('All figures are in Swedish kronor (SEK) unless otherwise noted.'),
        body('AI analysis sections were generated using Anthropic Claude and should be reviewed by a qualified accountant before being relied upon for major decisions.'),
        ...spacer(1),
        body(`Report period: ${data.period.start} to ${data.period.end}`, { color: C.muted }),
        body(`Generated: ${data.generated}`, { color: C.muted }),
        body(`Organisation: ${data.business.org}`, { color: C.muted }),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`Report saved: ${outputPath} (${Math.round(buffer.length/1024)}KB)`);
  return buffer;
}

// Run
generateReport(REPORT_DATA, '/home/claude/exports/monthly_report_march_2026.docx');
