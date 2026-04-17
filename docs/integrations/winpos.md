# Winpos

## Identity
- **Name (local)**: Winpos
- **Category**: POS (Kassasystem) — hospitality + retail
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `winpos`
- **Logo URL**: https://winpos.com

## API technical
- **Docs URL**: Not public. **Key insight from their own docs: "contact your support contact at Winpos and activate API connection and ask Winpos to send all information to the integration partner."**
- **Developer portal / sandbox URL**: None public — entirely relationship-based
- **Base URL (prod)**: NEEDS RESEARCH (per-customer or shared?)
- **Auth type**: NEEDS RESEARCH
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: NEEDS RESEARCH (possibly file-based export — Adaptive Shop sells a "Winpos Orderexport" product)
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they likely expose
Inferred from their own integrations page (hotel bookings, ticketing, accounting, webshops):
- Orders / transactions
- Product catalogue
- Potentially file-based daily export (.xml or .csv) given the Adaptive Shop export add-on exists

## Business / market
- **Sweden market share (rough)**: Medium — long-established POS, "just one or 1000 locations" marketing suggests they handle chains
- **Target segment**: Restaurants, cafés, retail. Broad horizontal positioning.
- **Pricing**: NEEDS RESEARCH (contact sales)
- **Support email**: NEEDS RESEARCH (contact via winpos.com/partners/samarbetspartners/)
- **Partnership status**: `closed_api` — API access is activation-gated via support
- **Payment partners**: Nets, Verifone, Klarna

## Implementation notes
- **Known gotchas**:
  - **Activation-based model** — customer must request Winpos activate API access for our integration. Every new customer is a new activation request.
  - Winpos may provide file export rather than real-time REST (the third-party "Winpos Orderexport" product suggests exports are a primary integration pattern)
  - Long relationship cycle expected before we can build
- **How the customer obtains the key**: Through Winpos support team — both customer AND CommandCenter need to be in the loop
- **Skatteverket certified cash register**: Yes
- **Supports multi-site / chain**: Yes, explicitly ("just one or 1000 locations")
- **API response language**: NEEDS RESEARCH
- **Build estimate**: 6-10h including partnership setup

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: — contact Winpos partners team

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- Activation per-customer; batch requests once multiple customers are waiting
- If file-based, build a pickup-and-parse pattern rather than live API
- Good candidate to defer until customer demand justifies the partnership overhead

## Sources
- [Winpos POS](https://winpos.com/en/pos-system/)
- [Winpos partners](https://www.winpos.se/partners/samarbetspartners/)
- [Winpos businesswith.se](https://businesswith.se/system/winpos/)
- [Winpos order export (Adaptive Shop)](https://www.adaptiveshop.se/produkt/winpos-exportering-av-ordrar)
