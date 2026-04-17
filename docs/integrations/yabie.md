# Yabie

## Identity
- **Name (local)**: Yabie
- **Category**: POS (Kassasystem) — also does payment processing
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `yabie`
- **Logo URL**: https://yabie.com

## API technical
- **Docs URL**: NEEDS RESEARCH — no public API docs surfaced in searches
- **Developer portal / sandbox URL**: NEEDS RESEARCH
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (assumed for modern cloud POS)
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they likely expose
Inferred from public positioning:
- Transactions / sales
- Z-reports (documented integration with Björn Lundén syncs at Z-report time)
- Products
- Payments (Swish, Klarna, card via Swedbank Pay)

## Business / market
- **Sweden market share (rough)**: Medium — multiple product lines (Express for small, full POS, Go for mobile)
- **Target segment**: Broad — small businesses (Express), restaurants, retail (textile vertical explicitly marketed). Cloud-based.
- **Pricing**: NEEDS RESEARCH — marketed "low transaction rates" but no public tiers
- **Support email**: NEEDS RESEARCH
- **Partnership status**: `official_partner` — documented integration with Björn Lundén
- **Existing partners**: Björn Lundén (accounting), Swedbank Pay, Klarna, Swish

## Implementation notes
- **Known gotchas**:
  - **Z-report batch** — Yabie syncs to BL at Z-report time; their integration model is end-of-day batch
  - Multiple Yabie products (Express, Go, full) may have different APIs
- **How the customer obtains the key**: NEEDS RESEARCH
- **Skatteverket certified cash register**: Yes
- **Supports multi-site / chain**: Yes
- **API response language**: NEEDS RESEARCH
- **Build estimate**: 5-7h once docs obtained

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: — (CTO Anders Gunnarsson listed)

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- **Björn Lundén pull** — once we support BL, Yabie data may arrive there; consider whether Yabie-direct is needed
- End-of-day batch model → daily aggregate jobs, not live data
- Verify which Yabie product the customer uses before integrating

## Sources
- [Yabie main](https://yabie.com/en/)
- [Yabie Express](https://yabie.com/kassasystem/yabie-express/)
- [Yabie — Björn Lundén integration](https://bjornlunden.com/se/integrationer/yabie-kassasystem/)
- [Yabie Go](https://yabie.com/en/products/yabie-go/)
