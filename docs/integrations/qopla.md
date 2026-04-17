# Qopla

## Identity
- **Name (local)**: Qopla
- **Category**: POS (Kassasystem) + online ordering + delivery aggregation
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `qopla`
- **Logo URL**: https://qopla.se

## API technical
- **Docs URL**: Not public. Third-party Wolt integration at developer.wolt.com/integration-partners/qopla confirms Qopla exposes integration channels; direct API is partner-gated.
- **Developer portal / sandbox URL**: NEEDS RESEARCH — contact Qopla partners team
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH — likely `api_key` or OAuth2
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (assumed)
- **Webhooks supported**: Likely — Qopla pushes menu changes live to delivery integrations (Uber Eats / Wolt / Foodora); strong bidirectional integration pattern
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they expose
Based on public positioning:
- **Menu / products** — central. Qopla is the source of truth; menu changes push to Uber Eats, Wolt, Foodora, website, QR menus, kiosks.
- **Orders** — all channels (dine-in POS, online, delivery)
- **Sales / revenue** — aggregated across channels
- **Delivery channel attribution** — each order tagged with its source platform

## Business / market
- **Sweden market share (rough)**: ~1,300–2,000 restaurant partners per their own claims. Growing fast.
- **Target segment**: Multi-channel operators (dine-in + online + delivery). Strong in QSR and casual dining.
- **Pricing**: Not public — bundles POS + online ordering + delivery integration
- **Support email**: NEEDS RESEARCH (likely support@qopla.se)
- **Partnership status**: `official_partner` — formal integrations with Wolt, Foodora, Uber Eats confirmed
- **Partner documentation**: https://developer.wolt.com/integration-partners/qopla

## Implementation notes
- **Known gotchas**:
  - **Multi-channel by design** — integrating Qopla gives us dine-in + online + delivery in one stream
  - **Delivery attribution** needs care — treat Qopla as source of truth for multi-channel customers rather than hitting individual delivery APIs
  - **Menu syncing** is bidirectional; if we write back, be careful
- **How the customer obtains the key**: Via Qopla customer portal or partner activation
- **Skatteverket certified cash register**: Yes
- **Supports multi-site / chain**: Yes
- **API response language**: NEEDS RESEARCH
- **Build estimate**: 5-8h — multi-channel data needs thoughtful modelling

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: partners@qopla.se (assumed)

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- **High ROI integration** — one Qopla connection replaces POS + online + delivery aggregation
- **Wolt has already documented Qopla** as partner — suggests mature API program
- For customers on Qopla Delivery Integration, prefer Qopla over direct Wolt/Foodora/Uber Eats integrations

## Sources
- [Qopla main](https://qopla.se/en/kassasystem)
- [Qopla integrations](https://qopla.se/en/integrationer)
- [Qopla delivery integrations](https://qopla.se/en/leveransintegrationer)
- [Wolt — Qopla integration](https://developer.wolt.com/integration-partners/qopla)
