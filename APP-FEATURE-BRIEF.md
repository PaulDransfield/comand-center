# CommandCenter — Feature Brief for the Landing Page

> **Purpose:** a single, accurate source of truth for everything CommandCenter
> does, written for an AI (or copywriter) building/updating the marketing site.
> Every feature below is **live in production** unless explicitly marked
> *(Coming)*. Do not invent features, and do not soften or strengthen the
> claims past what's written here — the wording has been checked against the
> actual product. Last updated 2026-05-27.

---

## 1. What CommandCenter is

CommandCenter is a **business-intelligence platform for restaurant groups**,
built for the Swedish market. It plugs into the systems a restaurant already
uses — accounting (Fortnox), staff scheduling (Personalkollen), the POS, and
Google reviews — and turns that scattered data into one live picture of how
each location is actually performing: revenue, food cost, labour, overheads,
margin, cash, and reputation. An AI layer explains what changed, flags what
needs attention, and answers plain-language questions with the real numbers
behind them.

**Who it's for:** owners and operators of independent restaurants and small-to-
mid restaurant groups (one site up to a chain) who want a CFO-grade view without
hiring one.

**The core promise:** every number traced to its source, every cost flagged
before payroll or month-end, and an assistant that can explain — or write up —
any of it on demand.

**One-line positioning options (pick/adapt):**
- "The financial cockpit for restaurant groups."
- "Every location's numbers, live — and an AI that explains them."
- "From the books to the rota to the reviews, in one place."

---

## 2. What it connects to (data in)

| Source | What we pull | Notes |
|--------|--------------|-------|
| **Fortnox** (accounting) | Supplier invoices, P&L (Resultatrapport), vouchers, BAS-account costs, bank/cash balances, invoice PDFs | The deepest integration. Read-only — we never write to the books. |
| **Personalkollen** (staff) | Shifts, hours, hourly cost, OB supplement, lateness, scheduled vs logged | Drives all labour + scheduling features. |
| **POS** (Onslip, Ancon, Swess, Caspeco) | Daily/department revenue, channels, covers | Per-department revenue tagging. |
| **Google reviews** | Latest reviews, ratings | Powers the reviews + reputation features. |
| **Weather** | Local weather history/forecast | For the sales-vs-weather correlation. |
| **Stripe** | Billing only | No card data ever touches our systems. |

Integrations connect via secure OAuth or API key; credentials are encrypted.
Once connected, data syncs automatically every day (plus on demand).

---

## 3. Feature areas (all live unless marked)

### A. Financial performance & live P&L
- **Dashboard** — KPI cards (revenue, labour %, food %, margin), revenue chart, department breakdown, and an "attention panel" that surfaces what needs looking at today.
- **Flash P&L** — live profit per location by end of day: see which site made money and which one leaked it, without waiting for month-end.
- **Performance view** — unified Revenue / Food / Labour / Overheads / Net-margin, sliceable by Week / Month / Quarter / YTD, with a profit waterfall, cost donut, trend sparklines, and a "what's tunable" panel.
- **Monthly P&L tracker** — month-by-month profit & loss, populated from Fortnox and editable by hand where needed.
- **Departments** — cost and margin per department/section, colour-coded.

### B. Cash & forecasting
- **Cash projection** — where your cash will be in ~30 days, projected straight from your Fortnox transactions.
- **Revenue forecast** — a forecast that **grades itself against reality** and explains every swing. It weights recent weeks more heavily, adjusts for the current week's pace, and is refined by an AI layer (kept advisory, never blindly trusted).
- **Budgets** — AI-generated cost-target budgets anchored on last year's actuals (not wishful extrapolation), plus an AI "coach" that analyses how you're tracking against them.

### C. Labour & scheduling
- **Staff** — hours, cost of labour (read first, kroner second), OB supplement, and late arrivals — flagged when you're heading over target *before* payroll.
- **AI scheduling** — rotas built against forecast demand, with AI suggestions to **trim over-staffed shifts**. It shows your projected labour % now vs. what it would be if you applied the suggestions. You review and apply the changes in Personalkollen. *(The AI only ever suggests cutting over-staffed hours, never adding them — applied with owner judgement.)*

### D. Bookkeeping, costs & suppliers (the "revisor"-grade layer)
- **Fortnox-deep cost analysis** — every supplier invoice classified to the correct **BAS account**; overruns and price rises flagged automatically.
- **Overheads review** — cost categories tracked month-over-month, with **supplier price-creep detection** (per-supplier, per-product), drill-down from any flag straight to the underlying invoices, and an AI explanation of *why* a cost moved.
- **Suppliers** — the full Fortnox supplier master, auto-categorised (food / drink / takeaway / cleaning / services / utilities), with a side drawer to view each supplier's recent invoice **PDFs inline** — no bouncing out to Fortnox.
- **Invoices** — your Fortnox documents in one searchable place.
- **VAT-aware revenue** — revenue auto-classified by Swedish VAT rate: 25% = alcohol, 12% = dine-in food, 6% = takeaway (Wolt / Foodora / Uber Eats).
- **Revisor (accountant) portal** — a **read-only access level for your external accountant**: you grant them access and they see the last 12 closed months' P&L per location, nothing else. Built so the people who do your *revisor*/bookkeeping work can self-serve.

### E. Inventory & recipes
- **Item master / catalogue** — every product you buy, built **automatically from your supplier invoice PDFs** (read by AI vision), with pack sizes and units parsed out.
- **Recipe costing to the gram** — cost any dish from its ingredients, with proper unit conversion (kg↔g, l↔ml) and multi-currency support (EUR/USD invoices converted to SEK at daily ECB rates).
- **Sub-recipes** — recipes can include other recipes (a sauce inside a dish), costed recursively.
- **Stock counts** — run a stocktake; add any article on the fly if it's not in the catalogue yet.
- **Variance & waste** — track theoretical vs actual usage and flag waste.
- **True food-cost reconciliation** — tie purchases, recipes, and sales together for a real food-cost number, not a guess.

### F. Reviews & reputation
- **Google reviews in-app**, with **AI-drafted replies in your own voice**, cross-referenced against the shift that may have caused a complaint.
- **What to improve / what customers love** — two AI cards that read across your reviews and surface the recurring complaints to fix and the strengths to protect.
- **Rating trend** over time.

### G. Ask CC — the AI assistant & document generation
- **Ask CC** — ask anything about your data in plain English (or Swedish) and get an answer **with the numbers behind it**, grounded in your real figures. Available as a quick side-panel from anywhere, or a full-page chat.
- **Document generation** — ask Ask CC to "make me a PDF / Word doc / PowerPoint on our margins and how to improve them" and it produces a **downloadable, properly formatted report** — currently margin, cost-breakdown, and supplier-spend reports, each in **PDF, Word, and PowerPoint**. Every figure is locked to your real data; the AI only writes the narrative and recommendations around it.

### H. Multi-location / group
- **Group roll-up** — one view across every location, with an AI narrative on how the group is performing and one-click drill into any single site.

### I. Extras
- **Weather correlation** — your sales bucketed by weather type and weekday, so you can see how the weather actually moves covers.
- **Swedish holidays built in** — 17 restaurant-relevant Swedish holidays auto-flagged across the forecast, scheduling, and dashboard so you plan staffing around them.
- *(Coming)* **AI Studio** — scheduled reports, custom alerts, and digests in one place.

---

## 4. The AI layer (what makes it more than a dashboard)

CommandCenter runs AI in two modes:

**On-demand (you ask):** Ask CC, budget generation/analysis/coaching, P&L narrative, scheduling recommendations, inventory matching, review replies + insights, cost explanations, and the downloadable reports.

**Automatic (it watches for you), running on a schedule:**
- **Anomaly detection** — nightly scan that flags unusual cost/revenue swings.
- **Weekly manager memo** — a Monday brief on what happened and what to watch.
- **Supplier price-creep digest** — monthly, catches suppliers quietly raising prices.
- **Forecast calibration** — monthly self-grading that keeps forecasts honest.
- **Scheduling optimisation** — weekly labour-saving suggestions.
- **Cost intelligence & industry benchmarks** — context on how your costs compare.

All AI output is **clearly labelled as AI**, is **advisory** (never an automated decision), and is grounded in your own numbers.

---

## 5. PDF & document capabilities (called out because they're a highlight)

CommandCenter both **reads** and **writes** documents:
- **Reads supplier invoice PDFs** with AI vision to build your product catalogue and prices automatically.
- **Reads Fortnox P&L (Resultatrapport) PDFs** to extract your numbers.
- **Streams Fortnox invoice PDFs inline** so you never leave the app to check paperwork.
- **Generates polished reports** — margin, cost, and supplier — as **PDF, Word, or PowerPoint** on request, with real numbers and AI-written analysis.

---

## 6. Trust, security & compliance (for a trust section)

- **EU data residency** — primary data stored in Frankfurt; the app runs in the EU.
- **Built for Sweden** — BAS accounts, moms/VAT logic, Bokföringslagen-aware, Swedish holidays, and a Swedish accountant (revisor) portal.
- **Encryption** in transit (TLS 1.3) and at rest (AES-256); integration credentials encrypted at the application layer.
- **Strict tenant isolation** — every location's data is walled off per organisation.
- **GDPR built in** — self-service data export, deletion, cookie consent, and a published privacy policy listing every sub-processor.
- **AI privacy** — financial data sent for AI analysis runs under Zero Data Retention; it is **not used to train models**.
- **Your accountant stays the system of record** — CommandCenter is a management view for analysis, **not a replacement for your bookkeeping or a regulated financial statement.**

---

## 7. Guardrails the copy MUST respect (do not break these)

These are non-negotiable — they keep us legally and factually clean:

1. **"Management view, not regulated output."** Never imply CommandCenter replaces bookkeeping, an audit, a financial statement, or a tax filing. It's an analysis/insight layer; the accounting system stays the record of truth.
2. **Scheduling is suggest-and-apply, not auto-write.** Say the AI *suggests trimming over-staffed shifts* and the owner *applies them in Personalkollen*. **Do NOT** claim CommandCenter writes schedules back to Personalkollen automatically — that isn't built.
3. **AI is advisory and labelled.** Never claim AI makes decisions for the business.
4. **No false certifications.** We do **not** hold SOC 2 or ISO 27001 ourselves (our infrastructure providers do). Don't claim we're "SOC 2 certified."
5. **No "signed DPA / fully compliant" absolutes** beyond what section 6 says — describe the posture, don't over-promise.
6. **Brand voice: plain, confident, no fluff, no emojis.** The owner's stated preference is **no emojis** anywhere — use clean text and short uppercase labels instead. (The current live landing page still uses emoji icons; treat removing them as desirable, not as the established style.)
7. **Default language English**, but keep Swedish domain terms where they're correct: *Revisor, Moms/Momsrapport, Resultatrapport, Bokföringslagen, OB-tillägg, BAS-konto.*
8. Don't promote *(Coming)* items as available today (currently: AI Studio).

---

## 8. Pricing (current)

- **Solo** — 1,995 SEK/mo
- **Group** — 4,995 SEK/mo
- **Chain** — 9,995 SEK/mo

All prices ex-context exclude/state VAT per the billing page. There is **no founding tier and no free trial** — do not reference either.

---

## 9. Quick feature checklist (for nav / feature-grid copy)

Live: Sales & forecast · Flash P&L · Cash projection · Performance (Revenue/Food/Labour/Overheads/Margin) · Monthly P&L tracker · Departments · Labour · AI scheduling · Bookkeeping & cost classification (BAS) · Overheads & price-creep · Suppliers (with invoice PDFs) · Invoices · VAT-aware revenue · Revisor portal · Inventory & recipes (costing to the gram, sub-recipes, counts, variance, waste, food-cost reconciliation) · Reviews (AI replies + improve/love insights) · Ask CC (chat + PDF/Word/PowerPoint reports) · Group roll-up · Weather correlation · Swedish holidays · GDPR/export/delete.

Coming: AI Studio (scheduled reports, custom alerts, digests).
