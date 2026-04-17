# Björn Lundén

## Identity
- **Name (local)**: Björn Lundén (BL Administration / BL Bokföring)
- **Category**: Accounting (Bokföring)
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `bjorn-lunden`
- **Logo URL**: https://www.bjornlunden.se

## API technical
- **Docs URL**: https://developer.bjornlunden.se/
- **Developer portal / sandbox URL**: https://developer.bjornlunden.se/technical-leap/
- **Base URL (prod)**: NEEDS RESEARCH (new cloud API stack since Q3 2017)
- **Auth type**: NEEDS RESEARCH — likely OAuth2 or API key via developer portal
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (assumed — modern REST)
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: `both_fields` expected (accounting)

## Data model — what they expose
Based on integrations with partners (Blikk, Qvalia, Otisco, Abicart, Timelog) — likely exposes:
- Invoices (incoming / outgoing)
- Suppliers / customers
- Vouchers / bookkeeping entries
- Accounts (chart of accounts)
- Bank transactions (3 of 4 major Swedish banks integrated since Q2 2020)

## Business / market
- **Sweden market share (rough)**: Large — strong for accounting firms (redovisningsbyråer) serving Swedish SMBs. ~30+ years in market.
- **Target segment**: Accountants servicing SMB clients, and direct SMB customers (restaurants included). Especially common in firms using BL Administration (desktop historically, now cloud).
- **Pricing**: Various SKUs — BL Administration, BL Bokföring, BL Byråstöd. Contact sales. (Fortnox's main competitor in accountant-led segment.)
- **Support email**: NEEDS RESEARCH (support@bjornlunden.se likely)
- **Partnership status**: `official_partner` — formal developer program at developer.bjornlunden.se

## Implementation notes
- **Known gotchas**:
  - **Desktop legacy** — BL Administration was desktop for decades; cloud + API is newer (since 2017). Some customers still on desktop may not have API access.
  - **Accountant-driven relationships** — many SMBs don't touch their BL directly; their accountant does. Integration may need accountant-facing flow.
  - **Multi-company** — BL Byråstöd lets one accountant manage many clients; credentials scope matters
- **How the customer obtains the key**: Via developer portal + customer consent flow
- **Skatteverket certified cash register**: N/A (accounting, not POS)
- **Supports multi-site / chain**: Yes (multi-company)
- **API response language**: NEEDS RESEARCH — likely Swedish field values, English/Swedish field names mixed
- **Build estimate**: 4-6h once docs obtained

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: — (applied via developer portal)

## Sample API interaction
NEEDS RESEARCH — get from developer.bjornlunden.se after signing up

## Notes for future integration
- **Second-tier accounting priority after Fortnox** — between them they cover most Swedish SMBs in restaurant industry
- **Yabie integration already exists** on their side — pulling Yabie data via BL might be a backdoor for Yabie customers
- Accountants are power users; integration should respect that (bookkeeping entries matter more than invoice UI)

## Sources
- [BL Developer portal](https://developer.bjornlunden.se/technical-leap/)
- [BL Integrations overview](https://www.bjornlunden.se/program/integrationer)
- [BL — Yabie integration](https://bjornlunden.com/se/integrationer/yabie-kassasystem/)
- [BL — Blikk integration](https://www.blikk.se/integrationer/bjorn-lunden/)
