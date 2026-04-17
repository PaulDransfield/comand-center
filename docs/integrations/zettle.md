# Zettle (by PayPal)

## Identity
- **Name (local)**: Zettle by PayPal (formerly iZettle)
- **Category**: POS (Kassasystem) + payment processing
- **Status**: in-progress — adapter stub at `lib/pos/zettle.ts`, unverified
- **Adapter path**: `lib/pos/zettle.ts`
- **Slug**: `zettle`
- **Logo URL**: https://www.zettle.com

## API technical
- **Docs URL**: https://developer.zettle.com/docs/api
- **Developer portal / sandbox URL**: https://developer.zettle.com — sign up for dev account, create self-hosted or partner-hosted app
- **Base URL (prod)**:
  - Finance: `https://finance.izettle.com`
  - Products: `https://products.izettle.com`
  - Purchases/sales: `https://purchase.izettle.com`
  - OAuth token: `https://oauth.zettle.com/token`
- **Auth type**: `oauth2` — PayPal's standard OAuth 2.0. Client ID + client secret → access token.
- **Credentials shape**: `{ client_id: string, client_secret: string, access_token?: string, refresh_token?: string }`
- **Rate limits**: Standard PayPal rate limits (not precisely documented publicly)
- **Pagination**: `cursor` / offset — varies per API
- **Data format**: JSON
- **Webhooks supported**: Yes — Zettle supports event webhooks for transactions, products, etc.
- **Timezone handling**: UTC ISO-8601
- **VAT handling**: `both_fields` — exposes net, VAT, gross per line

## Data model — what they expose
| API | Endpoint | Purpose |
|---|---|---|
| Finance | `/v2/accounts/liquid/balance/` | Account balance |
| Finance | `/v2/accounts/liquid/transactions/` | All transactions (sales + payouts) |
| Purchase | `/purchases/v2` | Sales list with items, amounts, VAT |
| Products | `/organizations/self/products/v2` | Product catalogue |

## Business / market
- **Sweden market share (rough)**: Massive — Zettle is the #1 mobile POS for small Swedish businesses (bars, cafés, market traders, pop-ups). Tens of thousands of Swedish merchants.
- **Target segment**: Small businesses, mobile merchants, cafés, small restaurants, food trucks. Less common for fine dining / large chains (who prefer Trivec/Caspeco).
- **Pricing**: Free software + card reader from ~289 kr. 1.75% card fee. No monthly fees.
- **Support email**: Via PayPal developer support
- **Partnership status**: `official_partner` (open dev program) — anyone can sign up

## Implementation notes
- **Known gotchas**:
  - **OAuth refresh** — access tokens expire; need refresh_token logic
  - **iZettle legacy naming** — domain names still use `izettle.com`, API paths sometimes too. Zettle is the current brand.
  - **Multi-location** — Zettle scopes to merchant account; if customer has multiple Zettle accounts, treat as separate integrations
- **How the customer obtains the key**: We register our app in the Zettle Developer Portal, get client_id + secret; customer authenticates via OAuth redirect
- **OAuth redirect URI**: `https://comandcenter.se/api/integrations/zettle/callback` (register this at dev portal)
- **Skatteverket certified cash register**: Yes — Zettle is certified
- **Supports multi-site / chain**: Limited — primary design is single merchant
- **API response language**: English
- **Build estimate**: 3-5h to verify + complete adapter (stub exists)

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17 (web research; stub exists)
- **Primary contact at provider**: PayPal / Zettle developer support

## Sample API interaction
```bash
# Get access token
curl -X POST https://oauth.zettle.com/token \
  -d "grant_type=assertion&assertion=$JWT" \
  -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"

# List purchases
curl -H "Authorization: Bearer $TOKEN" \
  "https://purchase.izettle.com/purchases/v2?startDate=2026-04-01&endDate=2026-04-30"
```

## Notes for future integration
- **Developer-friendly** — Zettle has a real public developer portal, one of the better Swedish POS options
- **GitHub deprecated docs** at github.com/iZettle/api-documentation — do not use; go to developer.zettle.com
- **PayPal rate limits** apply at the OAuth/token layer
- Good candidate after Onslip for second "smooth" integration

## Sources
- [Zettle APIs overview](https://developer.zettle.com/docs/api)
- [Developer Portal](https://developer.zettle.com/)
- [Finance API](https://developer.zettle.com/docs/api/finance/overview)
- [Zettle APIs & SDKs](https://developer.zettle.com/docs/get-started/concepts/zettle-apis-sdks)
