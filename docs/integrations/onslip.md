# Onslip

## Identity
- **Name (local)**: Onslip
- **Category**: POS (Kassasystem)
- **Status**: planned — **highest priority** for next build given public open-API positioning
- **Adapter path**: not yet
- **Slug**: `onslip`
- **Logo URL**: https://www.onslip.com

## API technical
- **Docs URL**: Not public-public, but Onslip markets itself as "first POS with open API." Enter via https://www.onslip.com/partnersida/
- **Developer portal / sandbox URL**: NEEDS RESEARCH — contact partnersida@onslip.com
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: Likely `api_key` (marketed as open API)
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (assumed)
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they expose
Inferred from pre-built integrations list on their site:
- Sales / transactions (paired with Fortnox, Visma SPCS accounting)
- Products / menu (paired with ordering/delivery)
- Employees / shifts
- Z-reports for daily closeout

## Business / market
- **Sweden market share (rough)**: Medium — 10+ years in market, strong presence in small-medium restaurants, bars, cafés
- **Target segment**: Småföretagare (small-medium operators). Marketed at operators who want no long binding time.
- **Pricing**: Flexible contracts, publicly marketed. Specific tiers NEEDS RESEARCH.
- **Support email**: NEEDS RESEARCH (likely support@onslip.com)
- **Partnership status**: `official_partner` — formal partner program ("Appstore för restauranger")
- **Existing integration partners**: Fortnox, Spiris/Visma SPCS, Swish, others

## Implementation notes
- **Known gotchas**: The only Swedish POS that publicly positions itself as "open API first" → likely the smoothest Swedish POS to integrate
- **How the customer obtains the key**: Via Onslip customer dashboard (assumed given open-API positioning)
- **Skatteverket certified cash register**: Yes
- **Supports multi-site / chain**: Yes
- **API response language**: NEEDS RESEARCH — likely mixed Swedish/English
- **Build estimate**: 4-6h once docs obtained

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: partnersida via website

## Sample API interaction
NEEDS RESEARCH — request credentials at onslip.com/partnersida/

## Notes for future integration
- **Prioritise this one** — open-API-first positioning, existing integrations with Fortnox/Visma SPCS suggest clean data exchange conventions
- Good candidate for showcase integration after PK/Fortnox
- Their existing partner list gives confidence in API maturity

## Sources
- [Onslip main site](https://www.onslip.com/)
- [Onslip Partnersida](https://www.onslip.com/partnersida/)
- [Onslip Appstore](https://www.onslip.com/appstore-for-restauranger/)
