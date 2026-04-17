# Skatteverket

## Identity
- **Name (local)**: Skatteverket — Swedish Tax Agency
- **Category**: Other (government / tax reporting)
- **Status**: planned — some APIs live, some still in development
- **Adapter path**: not yet
- **Slug**: `skatteverket`
- **Logo URL**: https://www.skatteverket.se

## API technical
- **Docs URL**: https://www.skatteverket.se/omoss/digitalasamarbeten.4.3684199413c956649b56298.html
- **Developer portal / sandbox URL**: https://www7.skatteverket.se/portal/apier-och-oppna-data/utvecklarportalen (Utvecklarportalen)
- **Base URL (prod)**: Via Skatteverket API-konsol
- **Auth type**: Secure — typically BankID or corporate certificate (specific per API)
- **Credentials shape**: Varies per API — for restaurant-relevant ones: company org-nr + BankID / cert
- **Rate limits**: NEEDS RESEARCH (government APIs tend to be modest)
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (some legacy XML)
- **Webhooks supported**: Unlikely
- **Timezone handling**: Europe/Stockholm
- **VAT handling**: N/A (this IS the VAT authority)

## Live APIs (restaurant-relevant)
| API | Status | Purpose |
|---|---|---|
| Momsdeklaration (VAT return submission) | **Live (driftsatt 5 Dec 2025)** | File VAT returns programmatically |
| Företagsuppgifter (company info) | In development | Look up company details by org-nr |
| Personalliggare (staff presence log) | Planned | Staff-log API for Kassaregisterlagen compliance |
| ROT/RUT ansökningar | Planned | Home-service deduction applications |
| Kassaregister | Planned | POS register certification / reporting |

## Business / market
- **Sweden market share**: 100% (government) — every Swedish business must interact with Skatteverket
- **Target segment**: Every Swedish business, including all restaurants
- **Pricing**: Free (public API)
- **Support email**: via utvecklarportalen contact page
- **Partnership status**: `official_partner` (register on Utvecklarportalen)
- **Already integrated by**: Fortnox and other accounting vendors

## Implementation notes
- **Known gotchas**:
  - **BankID required** for most write operations — we'd need to redirect customer to their BankID for each filing
  - **Certificates** — for server-to-server, Skatteverket issues org-specific certs; setup is formal
  - **APIs launched progressively** — target APIs for restaurants (personalliggare, kassaregister) are planned but not live yet
  - **Regulatory**: filing VAT on behalf of customer has legal implications. Clear consent + audit log required.
- **How the customer obtains the key**: Via their Skatteverket credentials (BankID) — not a key we ever see
- **Skatteverket certified cash register**: N/A (this IS Skatteverket)
- **Supports multi-site / chain**: Per org-nr — one "customer" in Skatteverket's view is one legal entity
- **API response language**: Swedish
- **Build estimate**: 8-16h per API (government APIs are careful work)

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17

## Sample API interaction
NEEDS RESEARCH — via API-konsolen after Utvecklarportalen signup

## Notes for future integration
- **Low priority short-term** — most restaurants delegate Skatteverket interactions to their accountant. Fortnox / BL / Visma integrations give us the needed data without going direct to Skatteverket.
- **Long-term**: momsdeklaration direct filing could be a valuable Pro-tier feature ("CommandCenter files your VAT in one click")
- **Watch the roadmap** — personalliggare and kassaregister APIs are high-value when they land; saves us from scraping PK / POS for compliance data

## Sources
- [Skatteverket API-er och öppna data](https://www.skatteverket.se/omoss/digitalasamarbeten.4.3684199413c956649b56298.html)
- [Utvecklarportalen](https://www7.skatteverket.se/portal/apier-och-oppna-data/utvecklarportalen)
- [Skatteverket lanserar öppna API:er (Talenom article)](https://talenom.com/sv-se/blog/skattefragor/skatteverket-lanserar-oppna-apier/)
- [Företagsuppgifter API development](https://skatteverket.se/omoss/digitalasamarbeten/utvecklingsomraden/foretagsuppgifter.4.339cd9fe17d1714c0773a24.html)
