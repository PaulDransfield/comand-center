# [PROVIDER NAME]

> Canonical template. Copy this to a new `<slug>.md` when adding a provider.
> Keep this synced with `lib/integrations/providers.ts` — if you change a field here that affects code, update the registry too.

## Identity
- **Name (local)**: Provider name in Swedish if different
- **Name (English)**:
- **Category**: `pos` | `accounting` | `reservations` | `hr` | `hotel` | `other`
- **Status**: `built` | `in-progress` | `planned` | `blocked`
- **Status reason** (if blocked/in-progress): e.g. "Waiting on OAuth approval"
- **Adapter path**: `lib/pos/slug.ts` | `lib/accounting/slug.ts` | etc. — leave blank if not built
- **Slug**: matches the key in `lib/integrations/providers.ts`
- **Logo URL**:

## API technical
- **Docs URL**:
- **Developer portal / sandbox URL**:
- **Base URL (prod)**:
- **Base URL (sandbox)**:
- **Auth type**: `api_key` | `oauth2` | `oauth1` | `basic` | `webhook_only` | `scraping` | `none`
- **Credentials shape**: e.g. `{ api_key: string }` or `{ client_id, client_secret, refresh_token }`
- **Rate limits**:
- **Pagination**: `cursor` | `page+size` | `offset` | `none`
- **Data format**: `json` | `xml` | `csv`
- **Webhooks supported**: Yes/No — event list if yes
- **Timezone handling**: e.g. "UTC" | "Europe/Stockholm, no TZ offset in response" | "unknown"
- **VAT handling**: `inkl_moms` | `exkl_moms` | `both_fields` | `unknown` — critical for revenue correctness

## Data model — what they expose
| Endpoint | Purpose | Key fields we need |
|---|---|---|
| `/example` | Sales data | `id`, `date`, `amount`, `vat` |
| | | |

## Business / market
- **Sweden market share (rough)**:
- **Target segment**: fine dining / casual / QSR / bar / hotel / chain / etc.
- **Pricing**: Their published plans (helps gauge customer affordability stack)
- **Support email**:
- **Support phone**:
- **Partnership status**: `official_partner` | `open_api_unofficial` | `scraping_only` | `closed_api` | `unknown`

## Implementation notes
- **Known gotchas**:
- **How the customer obtains the key**: self-serve in dashboard / call their support / partnership-required / etc.
- **OAuth redirect URI** (if OAuth): registered callback URL we use
- **Sandbox / test account**: available? ours?
- **Skatteverket certified cash register**: Yes/No/N/A (Kassaregisterlagen)
- **Supports multi-site / chain**: Yes/No — matters for restaurant groups
- **API response language**: English / Swedish / both
- **Build estimate**: hours

## Ops tracking
- **Customer demand count**: 0 (incremented as customers request)
- **Last verified date**: YYYY-MM-DD (when we last tested API schema)
- **Primary contact at provider**:
- **Related issues**:

## Sample API interaction
```
# (fill in when we have a working request pattern)
curl -H "Authorization: Bearer KEY" https://api.provider.se/v1/sales
```

## Notes for future integration
Free-form notes — gotchas discovered during research, migration tips, etc.
