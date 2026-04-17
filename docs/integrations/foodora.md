# Foodora

## Identity
- **Name (local)**: Foodora (part of Delivery Hero group)
- **Category**: Delivery platform (not in Paul's 54-list category — classified as "other/delivery")
- **Status**: in-progress — adapter stub at `lib/pos/foodora.ts`
- **Adapter path**: `lib/pos/foodora.ts`
- **Slug**: `foodora`
- **Logo URL**: https://www.foodora.com

## API technical
- **Docs URL**: https://developer.foodora.com/
- **Developer portal / sandbox URL**: https://developer.foodora.com/en/documentation/introduction
- **Base URL (prod)**: Per docs — Partner API base
- **Auth type**: `oauth2` — client_id + client_secret → short-lived JWT access_token
- **Credentials shape**: `{ client_id: string, client_secret: string }` — generated in Partner Portal
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: Standard
- **Data format**: JSON
- **Webhooks supported**: Yes — real-time order updates
- **Timezone handling**: UTC / ISO-8601
- **VAT handling**: `both_fields` — order totals include VAT breakdown

## Data model — what they expose
Per docs:
| API | Purpose |
|---|---|
| Catalog API | Sync product status + pricing between vendor system and Foodora |
| Orders API | Full order lifecycle — real-time sync, modify, cancel |
| Promotions | Create/manage promotions |
| Order history & analytics | Insights into past orders |

## Business / market
- **Sweden market share**: Large — Foodora is a top-3 food delivery platform in Sweden (vs Wolt, Uber Eats)
- **Target segment**: Any restaurant offering delivery
- **Pricing**: Commission per order (typically 25-30%) + monthly fee. Delivery Hero's standard model.
- **Support email**: via Partner Portal
- **Partnership status**: `official_partner` — formal Partner API
- **Coverage**: Finland, Sweden, Norway

## Implementation notes
- **Known gotchas**:
  - **Short-lived JWT** — cache access_token until expiration; refresh when needed
  - **Catalog API is write-heavy** — if we only read orders, we don't need full Catalog integration
  - **Multi-brand dilution** — Delivery Hero owns both Foodora and Hungry.dk (Denmark). Same dev platform, different branding.
- **How the customer obtains the key**: Customer must apply for Partner Portal access (may be gated to integrated partners)
- **Skatteverket certified cash register**: N/A
- **Supports multi-site / chain**: Yes — restaurant groups supported
- **API response language**: English
- **Build estimate**: 4-6h (stub exists, well-documented)

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: Partner Portal contact

## Sample API interaction
```bash
# Get access token
curl -X POST .../auth/oauth/token \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"

# List orders (pattern)
curl -H "Authorization: Bearer $JWT" \
  "https://developer.foodora.com/partner-api/orders?from=2026-04-01"
```

## Notes for future integration
- **Revenue attribution** — Foodora orders appear AFTER commission; customers want gross vs net breakdown
- **Delivery platform trio** — most delivery-heavy restaurants are on Foodora + Wolt + Uber Eats. Integrating just one is partial.
- **Prefer Qopla pass-through** if customer uses Qopla — avoids three separate integrations

## Sources
- [Foodora Developer Portal](https://developer.foodora.com/)
- [Foodora API Introduction](https://developer.foodora.com/en/documentation/introduction)
- [Catalog API overview](https://developer.foodora.com/en/documentation/catalog-api-overview)
- [Delivery Hero POS integration](https://developers.deliveryhero.com/documentation/pos.html)
