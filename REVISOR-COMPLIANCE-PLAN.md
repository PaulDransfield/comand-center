# Revisor Compliance Plan — Swedish Bookkeeping Law Edition

> **Owner:** Paul Dransfield
> **Drafted:** 2026-05-22
> **Status:** Planning — implementation queued behind Path B completion
> **Builds on:** existing `/revisor/[bizId]/[year]/[month]` page (commits `5108429`, `b6e1396`), `lib/auth/permissions.ts` REVISOR_ALLOW_PATHS gating, M074 review-intelligence
> **Legal references:** Bokföringslagen (BFL) 1999:1078, Mervärdesskattelagen (ML) 1994:200, Aktiebolagslagen (ABL) 2005:551 §6 (årsredovisning), SIE 4-formatet (Föreningen SIE-gruppen)

---

## 0. The prime directive

> **A Swedish revisor must be able to (a) read everything they need for monthly close inside our `/revisor/*` UI without bouncing back to Fortnox, and (b) print or export a document that satisfies Bokföringslagen's archiving requirements when filed away for the mandatory 7 years.**

If a revisor's first question is *"can you give me a SIE-fil?"* and the answer is "no", we've lost them. If their first impression of the print-out is *"this isn't legally compliant"*, we've lost them. Both must be **yes** out of the box.

---

## 1. What the law actually requires

### 1.1 Bokföringslagen 5 kap. — Verifikationer

> *"För varje affärshändelse skall det finnas en verifikation."*

A verifikation is the primary record of a transaction. By law it must contain:

| Field | Swedish term | Required |
|---|---|---|
| Date when the event occurred | datum | ✓ |
| Description of the event | beskrivning | ✓ |
| Counter-party (if applicable) | motpart | ✓ |
| Amount + currency | belopp + valuta | ✓ |
| Reference to underlying document | hänvisning till verifikat | ✓ |
| Unique, sequential verifikation number | verifikationsnummer | ✓ |

When CommandCenter prints a month-close PDF, every line must trace back to a verifikat. Today our `BasTable` shows aggregates by BAS account — that's a summary, not a verifikationslista. The Bokföringsnämnden's general advice (BFNAR 2013:2 §3.2) is unambiguous that printed reports must allow tracing each amount to its source verifikat.

### 1.2 Bokföringslagen 7 kap. — Arkivering

- **7-year retention** in the original format (or a clearly-labeled copy).
- For software-generated documents: the document MUST identify the source system, the user/operator, and the generation timestamp.
- Currency must be declared explicitly ("Alla belopp i SEK om inget annat anges").
- Page numbering required for multi-page documents.

### 1.3 Mervärdesskattelagen — VAT obligations

For VAT-registered businesses (which all our restaurant customers are):

- **Periodic momsrapport** with utgående moms (output VAT) and ingående moms (input VAT) per VAT rate (0/6/12/25 in Sweden).
- Annual EU sales list if applicable (not for typical restaurants).

Today we show VAT-split revenue on the revisor page, but not the formal momsrapport per Skatteverket's SKV 4700 format.

### 1.4 Aktiebolagslagen 6 kap. — Årsredovisning

For AB companies (Aktiebolag — which Chicce and Vero both are):

- Annual report including: Resultaträkning (P&L), Balansräkning (balance sheet), Förvaltningsberättelse (management report), Tilläggsupplysningar (notes).
- Must be signed by the board within 6 months of fiscal year end.

We provide the resultaträkning (via tracker_data); we don't provide a balansräkning at all.

### 1.5 SIE 4-formatet

The de-facto standard the entire Swedish accounting industry uses for data interchange. Revisors expect to import a SIE file into their tool of choice (Visma, Capego, Wolters Kluwer Skatt, Hogia, Fortnox, Björn Lundén) and run their analysis there. No SIE = friction = they ask the owner for one. Owner doesn't know what a SIE file is. Customer churn risk.

---

## 2. What's already in place

`app/revisor/[bizId]/[year]/[month]/page.tsx` (rebuild commit `5108429`):

- Business header (name, org-nr formatted, city)
- P&L summary card — `Metric` blocks for revenue / food / staff / other / depreciation / financial / net_profit / margin_pct
- VAT-coded revenue split (6 % takeaway, 12 % dine-in, 25 % alcohol)
- `BasTable` showing BAS line items grouped by class (3xxx revenue, 4–7xxx costs, 8xxx financial)
- `TrendTable` — 12-month rolling history
- `FlagsTable` — overhead flags with click-through to source invoice PDFs
- "Avstämd" chip when `tracker_data.source IN ('fortnox_pdf', 'fortnox_apply')`
- `window.print()` button + minimal `@media print` stylesheet
- Access gating via `lib/auth/permissions.ts::REVISOR_ALLOW_PATHS` (read-only enforced; no mutations)

Auth surface (audit pending — see §9):
- `/api/revisor/data` is the data layer
- Revisor invitation flow exists for at least Vero (per `lib/auth/permissions.ts`) but I haven't verified the owner-side invite UI is complete

---

## 3. Gap matrix

### 3.1 Legal must-haves (block "yes, you can use this")

| # | Requirement | Current state | Gap |
|---|---|---|---|
| 1 | Org.nr running header on every printed page | shown in body once | needs `@page` rule with running header |
| 2 | Generation timestamp + system source footer | absent | needs persistent footer "Skapad 2026-05-22 09:14 av CommandCenter (commandcenter.se) för räkenskapsperiod 2026-03" |
| 3 | Page numbering "Sida X av Y" | absent | needs `@page` counters |
| 4 | Period explicitly stated as date range | "mars 2026" only | needs "Period: 2026-03-01 — 2026-03-31" |
| 5 | Currency declaration | absent | needs "Alla belopp i svenska kronor (SEK)" footer line |
| 6 | Verifikation number on every transaction | absent (only BAS account) | needs per-line verifikat ID from Fortnox vouchers |
| 7 | Debet/Kredit columns in BAS table | only net amount shown | needs per-row Debet + Kredit (Swedish convention) |
| 8 | Verifikationslista (journal-by-date) | absent | needs a separate table sorted by date with verifikat number |
| 9 | SIE 4 export endpoint | absent | new endpoint + file format implementation |

### 3.2 Revisor workflow must-haves (block "this saves me time")

| # | Requirement | Current state |
|---|---|---|
| 10 | SIE 4 download button | ❌ |
| 11 | Balansräkning (balance sheet) | ❌ |
| 12 | Momsrapport (VAT report) | ❌ (revenue VAT-split exists but not Skatteverket format) |
| 13 | YTD / full-year resultaträkning | ❌ (monthly only) |
| 14 | Bankavstämning report | ❌ (M069 added cash position but no recon report) |
| 15 | Period-locked indicator + signature | ❌ (no concept) |

### 3.3 Process gaps

| # | Item | State |
|---|---|---|
| 16 | Owner invites revisor by email | ❓ verify the UI exists |
| 17 | Revisor accepts invitation, sees only granted businesses | ✓ partial via REVISOR_ALLOW_PATHS |
| 18 | Audit log of revisor access (which business, which period, what export) | ❓ admin_audit_log captures some but not surfaced |
| 19 | Revisor logout / session expiry | ✓ standard Supabase auth |
| 20 | "Export everything for fiscal year 2025" — bulk download | ❌ |

---

## 4. SIE 4 export — the killer feature

### 4.1 Why SIE 4 specifically

| SIE format | Content | Revisor demand |
|---|---|---|
| SIE 1 | Year-end balances | Low — used for annual summary import |
| SIE 2 | Period-end balances | Medium |
| SIE 3 | Object balances (cost centres) | Niche |
| **SIE 4** | **Full verifikation log + accounts** | **High — what every revisor actually wants** |

SIE 4 is the **transactional** export. Imports cleanly into every Swedish accounting tool. A revisor who gets a SIE 4 file from us treats the printable PDF as a courtesy — the SIE is the working file.

### 4.2 SIE 4 file structure

```
#FLAGGA 0
#PROGRAM "CommandCenter" "1.0"
#FORMAT PC8
#GEN 20260522 "Paul Dransfield"
#SIETYP 4
#FNAMN "Chicce Slotsgatan AB"
#ORGNR 556xxx-xxxx
#ADRESS "Slotsgatan 12" "" "Örebro" ""
#RAR 0 20260101 20261231
#TAXAR 2026
#KPTYP "EUBAS97"
#KONTO 3001 "Försäljning av varor 25%"
#KONTO 4010 "Inköp av råvaror"
#KONTO 5410 "Förbrukningsinventarier"
...
#OBJEKT ...
#IB 0 1930 0.00
#UB 0 1930 124500.00
#RES 0 3001 -485200.00
...
#VER A 1 20260301 "Försäljning mars 1"
{
   #TRANS 1930 {} 12350.00
   #TRANS 3001 {} -9880.00
   #TRANS 2611 {} -2470.00
}
#VER A 2 20260301 "Inköp Martin Servera"
{
   #TRANS 4010 {} 8240.00
   #TRANS 2641 {} 2060.00
   #TRANS 2440 {} -10300.00
}
...
```

### 4.3 Critical SIE 4 implementation rules

- **Encoding: ISO-8859-1 (Latin-1, codepage PC8)** — NOT UTF-8. Swedish characters å/ä/ö must be Latin-1 bytes. Non-conforming files break import in older tools.
- **Line endings: CRLF** (Windows-style).
- **Tags MUST appear in this order:** `#FLAGGA → #PROGRAM → #FORMAT → #GEN → #SIETYP → #FNAMN → #ORGNR → [#ADRESS] → #RAR → #TAXAR → #KPTYP → #KONTO × N → #OBJEKT × N → #IB → #UB → #RES → #VER (with nested #TRANS)`.
- **Verifikations grouped in series** (`#VER A 1`, `#VER A 2`, …). Series identifier `A` is conventional for autogenerated.
- **Balanced trans** — each `#VER` block's `#TRANS` lines must sum to zero.
- **Amounts in SEK, with decimal point** (not comma), 2 decimal places.
- **Dates in YYYYMMDD format** (no dashes).

### 4.4 Data source path

We don't currently store per-verifikat data — `tracker_data` is aggregated. The SIE export must walk **Fortnox vouchers** for the period (the existing drilldown endpoint already does voucher fetches). New endpoint:

```
GET /api/revisor/sie?business_id=X&year=2026&month=3
  → application/x-sie; charset=ISO-8859-1
  → Content-Disposition: attachment; filename="chicce-2026-03.se"
```

Internally:
1. Auth check (revisor role for this business)
2. Fetch business header (name, org-nr, address) from `businesses`
3. Fetch Fortnox vouchers for the period via existing helper
4. Fetch account chart (we can default to BAS 2024; or pull from `/3/accounts` Fortnox endpoint)
5. Generate SIE 4 file in memory (small — typically <500 KB per month)
6. Stream to client with correct encoding

---

## 5. Print-compliance fix — the half-day win

### 5.1 Updated print stylesheet

```css
@page {
  size: A4 portrait;
  margin: 22mm 18mm 25mm 18mm;

  @top-left {
    content: "Chicce Slotsgatan AB · Org.nr 556xxx-xxxx";
    font-family: 'Spline Sans', system-ui;
    font-size: 9pt;
    color: #6b7280;
  }
  @top-right {
    content: "Räkenskapsperiod 2026-03";
    font-family: 'Spline Sans', system-ui;
    font-size: 9pt;
    color: #6b7280;
  }
  @bottom-center {
    content: "Sida " counter(page) " av " counter(pages);
    font-family: 'Spline Sans', system-ui;
    font-size: 9pt;
    color: #6b7280;
  }
  @bottom-left {
    content: "Skapad 2026-05-22 09:14 av CommandCenter · commandcenter.se";
    font-family: 'Spline Sans', system-ui;
    font-size: 8pt;
    color: #9ca3af;
  }
  @bottom-right {
    content: "Alla belopp i SEK om inget annat anges";
    font-family: 'Spline Sans', system-ui;
    font-size: 8pt;
    color: #9ca3af;
  }
}

@media print {
  .cc-no-print { display: none !important; }
  body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .cc-revisor-content { max-width: 100% !important; }
  /* Force page break before each major section */
  .cc-revisor-section { break-inside: avoid; }
  table { page-break-inside: auto; }
  tr    { page-break-inside: avoid; page-break-after: auto; }
  thead { display: table-header-group; }  /* Repeat headers on each printed page */
}
```

CSS `@page` runners + counter substitution have universal browser support in print contexts. The `@top-left` etc. variables are static strings in CSS — but they can be set dynamically per page via the React component using a `<style>{`@page { @top-left { content: "${businessName} · Org.nr ${orgNr}" } }`}</style>` injection.

### 5.2 Compliance footer block (always visible, not just print)

A new bottom block on the page:

```
─────────────────────────────────────────────────────────────────
Genererad av CommandCenter (commandcenter.se) · 2026-05-22 09:14
Räkenskapsperiod: 2026-03-01 till 2026-03-31
Företag: Chicce Slotsgatan AB · Org.nr 556xxx-xxxx
Datakälla: Fortnox (manuellt avstämd) · Alla belopp i SEK
Sidan utgör inte ersättning för formell verifikationslista per BFL 5 kap.
─────────────────────────────────────────────────────────────────
```

The last line is the legal disclaimer — explicit acknowledgment that this UI summary doesn't itself replace the formal verifikationslista (which lives in the SIE export or in Fortnox).

---

## 6. Schema changes needed

### 6.1 New table: `period_locks`

For Phase R6 (period lock + signature):

```sql
CREATE TABLE period_locks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  business_id     UUID NOT NULL,
  period_year     INTEGER NOT NULL,
  period_month    INTEGER NOT NULL,
  locked_at       TIMESTAMPTZ NOT NULL,
  locked_by       UUID NOT NULL,    -- user_id of the revisor who signed off
  locked_by_role  TEXT NOT NULL,    -- 'revisor' | 'owner' (owners can lock pre-close)
  signature_note  TEXT,             -- free-text "noted no issues / found X" etc.
  UNIQUE (business_id, period_year, period_month)
);
```

After lock, the period is read-only for everyone except admin. The UI shows a "🔒 Låst 2026-04-15 av Anna Andersson (revisor)" banner instead of edit affordances.

### 6.2 Extend `tracker_data` with balance-sheet fields

For Phase R4 (Balansräkning):

```sql
ALTER TABLE tracker_data
  ADD COLUMN IF NOT EXISTS total_assets        NUMERIC,
  ADD COLUMN IF NOT EXISTS current_assets      NUMERIC,
  ADD COLUMN IF NOT EXISTS fixed_assets        NUMERIC,
  ADD COLUMN IF NOT EXISTS total_liabilities   NUMERIC,
  ADD COLUMN IF NOT EXISTS current_liabilities NUMERIC,
  ADD COLUMN IF NOT EXISTS long_term_liab      NUMERIC,
  ADD COLUMN IF NOT EXISTS total_equity        NUMERIC,
  ADD COLUMN IF NOT EXISTS retained_earnings   NUMERIC;
```

Source: Fortnox `/3/accountbalances/year` (annual balances) or `/3/accountbalances/{year}/{month}` (monthly trial balance). Mapped to standard BAS 2024 account ranges (1xxx assets, 2xxx liabilities + equity, etc.).

### 6.3 No extension needed for SIE export

SIE 4 generation reads directly from Fortnox vouchers (already accessible via our token). No new columns, no new tables. The endpoint is pure compute on existing data — that's why it's the highest-value lowest-cost item on this list.

---

## 7. Phasing

### Phase R1 — Print compliance (~½ day)
- Inject dynamic `@page` rules with business name + org-nr + period
- Add compliance footer block (visible always, not just print)
- Test on Chrome print + Safari print + Firefox print
- Test "Save as PDF" → reopen → verify all headers/footers render

**Exit:** any of Chicce's monthly close prints meet BFL 7 kap. archival requirements.

### Phase R2 — SIE 4 export (~2 days)
- `lib/revisor/sie-export.ts` — pure SIE 4 file generator (input: vouchers + accounts + period; output: ISO-8859-1 byte buffer)
- `/api/revisor/sie?business_id=X&year=Y&month=M` — auth check + voucher fetch + generate + stream
- "Ladda ner SIE-fil" button in the revisor month-detail page header
- Unit-test against a known-good SIE file (Fortnox export of same period for comparison)

**Exit:** revisor downloads file, imports into Visma/Capego, sees same numbers as our UI.

### Phase R3 — Verifikationslista + Debet/Kredit (~1 day)
- Pull voucher rows via existing drilldown helpers
- New `<VerifikationsList>` component sorted by date with columns: Datum · Ver.nr · Konto · Beskrivning · Debet · Kredit · Saldo
- `BasTable` gets Debet + Kredit columns (currently only net)
- Click verifikat number → drilldown panel with the source invoice/voucher

**Exit:** the print-out contains a verifikationslista that meets BFL 5 kap.

### Phase R4 — Balansräkning (~2 days)
- M-migration extending `tracker_data` with balance-sheet columns
- Sync engine pulls Fortnox `/accountbalances/{year}/{month}` and writes the new columns
- New `<BalanceSheet>` component on revisor month-detail
- Print stylesheet adapts (balance sheet is its own page)

**Exit:** annual review can be done from our UI alone for any AB.

### Phase R5 — Momsrapport (~1-2 days)
- Pull moms data from Fortnox or compute from `tracker_data` (we have alcohol/dine-in/takeaway split)
- New `<MomsRapport>` component formatted per Skatteverket SKV 4700
- Print + SIE 4 both include the moms summary

**Exit:** owner can hand revisor a single PDF that covers moms + P&L + balansräkning + SIE.

### Phase R6 — Period lock + revisor invite audit (~1 day)
- M-migration for `period_locks` table
- Lock button (revisor-only) on revisor month-detail
- Banner + read-only enforcement when locked
- Audit the existing owner-side revisor invite UI (verify it works end-to-end)
- `/admin/v2` audit page entry: "Revisor access this month"

**Exit:** complete revisor workflow from invite → access → close → lock → archive.

**Total estimate: ~7-8 days of focused work to "Swedish revisor compliant".** Phase R1 + R2 (the half-day + 2 days) account for ~80 % of the practical value.

---

## 8. Open questions (decide before R2)

### Q1 — Account chart source

Two options for SIE 4's `#KONTO` entries:

- **(a)** Hard-code BAS 2024 standard chart (~300 lines, well-known, never changes during a year)
- **(b)** Pull Fortnox's `/3/accounts` for the live chart per customer (allows custom accounts the customer added; ~one extra API call per export)

Recommend **(b)** — small extra cost, supports customers with custom accounts (some restaurants split out e.g. "4011 Vin import" vs "4012 Vin distributör").

### Q2 — Verifikat series naming

SIE 4 groups vouchers by series (`#VER A 1`, `#VER B 1`, …). Two paths:

- **(a)** Single series `A` for all auto-generated → revisor sees one long sequence
- **(b)** Match Fortnox's own series naming (`A` = General, `B` = Sales, `C` = Purchases, etc.)

Recommend **(b)** — matches the revisor's mental model from the Fortnox UI they're used to.

### Q3 — Print PDF filename convention

For "Skriv ut / PDF":

- **(a)** `chicce-mars-2026.pdf` (readable)
- **(b)** `Chicce_Slotsgatan_AB_556xxxxxxx_2026-03_manadsavslut.pdf` (formal — orgs sometimes archive by org-nr first)
- **(c)** Both — user picks via dropdown

Recommend **(b)** — matches archival convention; revisors batch-import these into their tools.

### Q4 — Locale of the surface

Revisor surface is Swedish-only today. Should it be?

- **(a)** Lock Swedish — revisors are Swedish; English would feel wrong
- **(b)** Add English for non-Swedish accountants of Swedish entities (rare but exists)

Recommend **(a)** for now — single locale, fewer translation surfaces. Revisit if a customer asks.

### Q5 — Revisor signature requirement

Phase R6 "lock period" — does the lock require a digital signature (BankID etc.) or is "logged-in revisor clicks Lock" sufficient?

- **(a)** BankID-required — legally rock-solid, ~2-3 weeks extra build
- **(b)** Authenticated session + audit log — most accounting software treats this as sufficient
- **(c)** No lock at all in v1 — defer

Recommend **(b)** — matches what Visma / Fortnox / etc. do for the "monthly close" feature. BankID is for the formal årsredovisning signature, not the monthly lock.

### Q6 — Multi-business revisor view

Some revisors handle 50+ small clients. Should `/revisor` (the landing page) prioritise:

- **(a)** Most-recently-closed period per business
- **(b)** "Needs attention" (unclosed periods, overhead flags, missing data)
- **(c)** Both — toggle between views

Recommend **(b)** as default with **(a)** accessible — gets the revisor straight to the work.

---

## 9. Process verification needed (before R6)

The plan above assumes the owner-side revisor invitation flow works. Verify by reading:

- `lib/auth/permissions.ts::REVISOR_ALLOW_PATHS`
- Whatever UI sends the invite email (search for "revisor" + "invitation")
- Whatever endpoint accepts the invitation

If gaps exist:
- Owner page: `/settings/team` should have a "Bjud in revisor" action with email input + business multi-select
- Email template: "Du har blivit inbjuden som revisor på Chicce Slotsgatan AB. Klicka här för att aktivera ditt konto."
- Acceptance flow: clicking the link verifies token, sets the user's role to `revisor`, scopes them to the listed business IDs.

---

## 10. Out of scope (explicit)

- **BankID integration** for any signature. Stays out until a customer asks.
- **K-regelverket (K2/K3) compliance** — annual report formats. Revisors handle these in their tools after importing our SIE.
- **Inkomstdeklaration 2 / 4** — tax filings. Out of scope.
- **Multi-currency** — restaurant ops are SEK. Other currencies might appear on individual invoice PDFs (European wine imports) but they get converted to SEK in Fortnox before booking.
- **Cost-centre / object tracking** (SIE 3 object balances) — only useful if customer uses Fortnox's `Project` / `CostCenter` fields, which restaurants generally don't.
- **Revisor-side annotation / comments on transactions** — nice but doesn't unblock close.

---

## 11. Memory hooks (to save when shipped)

- `feedback_sie4_encoding_invariant` — SIE 4 files MUST be ISO-8859-1 with CRLF line endings. Latin-1 bytes for å/ä/ö, not UTF-8. Strict tag order: FLAGGA → PROGRAM → FORMAT → GEN → SIETYP → FNAMN → ORGNR → ADRESS → RAR → TAXAR → KPTYP → KONTO → OBJEKT → IB → UB → RES → VER. Each VER's TRANS lines sum to zero.
- `feedback_revisor_print_legal_invariant` — every printed revisor document MUST carry: business + org-nr running header, period + system source + timestamp + currency footer, page X of Y, and the BFL 5 kap. disclaimer. The `@page` rules in app/revisor/[bizId]/[year]/[month]/page.tsx are the load-bearing implementation; never remove without replacing.
- `reference_skv_4700_momsrapport` — Skatteverket's VAT report format SKV 4700; our momsrapport renders to this layout.
- `feedback_bas_account_chart_2024` — Hard-coded fallback BAS chart in lib/revisor/bas-chart.ts. Customers using custom accounts (verified via Fortnox /accounts endpoint) override entries; everything else defaults to standard BAS 2024.

---

## 12. Definition of "done" per phase

- **R1 done:** Take a fresh PDF print of any of Chicce's months. Open it. Every page has the four-corner running header/footer. Period is stated as `2026-03-01 — 2026-03-31`. Currency line present. Generated-by line present. Sida X av Y present.
- **R2 done:** Download SIE file. Open in Notepad — confirm ISO-8859-1 (å/ä/ö show as `\xE5\xE4\xF6` bytes). Import into Visma Eget Aktiebolag (or Fortnox itself) — confirm balances match our UI to the öre.
- **R3 done:** The printed month-close PDF includes a verifikationslista on its own page, sorted by date, with verifikat numbers. Debet + Kredit columns visible across the BAS section.
- **R4 done:** Annual review of Chicce 2026 produces both a resultaträkning AND a balansräkning entirely from our UI.
- **R5 done:** Momsrapport reproduces the same totals an owner would see in Skatteverket's e-tjänst momsrapport.
- **R6 done:** Revisor invitation flow tested end-to-end with a fresh user; lock button respected by all read paths.

Each phase ships independently. R1 + R2 alone unlock a real "use this with my revisor" product. The rest scale the product to "this IS the revisor's primary tool" — which is the longer-game product position worth building toward.
