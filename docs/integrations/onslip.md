# Onslip 360

## Identity
- **Name (local)**: Onslip 360
- **Category**: POS (Kassasystem)
- **Status**: supported (adapter `lib/pos/onslip.ts`, wired into sync engine 2026-04-17)
- **Adapter path**: `lib/pos/onslip.ts`
- **Slug**: `onslip`
- **Logo URL**: https://www.onslip.com

## API technical
- **Docs URL**: https://developer.onslip360.com/docs/
- **Developer portal / sandbox URL**: https://test.onslip360.com/v1/ — partner account signup via developer portal
- **Base URL (prod)**: `https://api.onslip360.com/v1/`
- **Base URL (sandbox)**: `https://test.onslip360.com/v1/`
- **Auth type**: **Hawk** (HMAC-SHA-256 request signing; not a bearer token or API key)
- **Credentials shape** (stored encrypted in `integrations.credentials_enc` as JSON):
  ```json
  {
    "key_id": "user+token@realm",
    "key":    "base64-encoded-raw-key",
    "realm":  "example.com",
    "env":    "prod"
  }
  ```
  - `key_id` format is the "short" form per Onslip docs: `{user}+{token}@{realm}`
  - `key` is Base64-encoded raw bytes — our Hawk helper decodes before HMAC
  - `env` is `prod` or `sandbox`
- **Realm in URL**: `~{realm}` prefix, e.g. `/v1/~example.com/orders/`
- **Rate limits**: Not publicly documented. Back off on 429.
- **Pagination**: `?o=<offset>&c=<count>&s=<sortField>` — we default to `c=500`, hard cap 50k rows
- **Data format**: JSON
- **Webhooks supported**: Not for MVP integration — we poll on the daily master-sync cron
- **Timezone handling**: Orders have ISO `created` timestamps, appear to be UTC. We filter by date prefix.
- **VAT handling**: `total` is gross (includes VAT); `total_net` is ex-moms. We store gross to match Inzii / PK convention.

## Data model — what they expose
- **Orders** — `~{realm}/orders/` — sales, with `created`, `total`, `status`, `payments[]`
- **Products** — `~{realm}/products/`
- **Product groups** — `~{realm}/product-groups/`
- **Users** (employees) — `~{realm}/users/`
- **Payment methods** — `~{realm}/payment-methods/`
- **Customers, locations, tabs, tills, triggers, integrations** — various

## Business / market
- **Sweden market share (rough)**: Medium — 10+ years, small-medium restaurants/bars/cafés
- **Target segment**: Småföretagare (small-medium operators), flexible contracts
- **Pricing**: Flexible contracts, publicly marketed
- **Support email**: api@onslip.com (dev support, Teams channel)
- **Partnership status**: `official_partner` — formal partner program
- **Existing integration partners**: Fortnox, Visma SPCS, Swish, and many others

## Implementation notes
- **Known gotchas**:
  - Hawk auth is strict on clock skew — keep server time within a minute of UTC
  - Realm prefix `~` must be URL-safe; our adapter embeds it unescaped (valid per RFC 3986)
  - `since` / `until` date filters are passed optimistically; adapter also filters client-side as a safety net
  - Orders with `status != complete|completed|paid` are skipped to avoid counting open tabs / refunds
- **How the customer obtains the key**: Onslip 360 Backoffice → API access tokens → generate. Hands back `key_id` and Base64 `key`.
- **Skatteverket certified cash register**: Yes
- **Supports multi-site / chain**: Yes — one realm per account, multi-location within the realm
- **API response language**: English field names
- **Build estimate**: Completed in ~3h (Hawk helper + adapter + engine integration)

## Ops tracking
- **Customer demand count**: 0 (all customers on trial still)
- **Last verified date**: 2026-04-17 (adapter built against public docs; needs live sandbox test once partner account is approved)
- **Primary contact at provider**: api@onslip.com

## Sample API interaction
```bash
# Pseudo-code — real requests use Hawk signed Authorization header
# (our adapter does this automatically; shown here for reference)

GET https://api.onslip360.com/v1/~example.com/orders/?o=0&c=100&s=created&since=2026-04-01T00:00:00Z&until=2026-04-30T23:59:59Z

Authorization: Hawk id="user+token@example.com", ts="1713360000", nonce="abc123", mac="base64sig..."
Accept: application/json
```

## Admin connection flow
Onslip uses a single API key (not OAuth), so the admin can paste the JSON credential directly into the `+ {business}` integration modal. Flow:

1. Customer generates an API access token in Onslip 360 Backoffice
2. Customer sends us the key_id and key
3. Admin opens `/admin/customers/<orgId>` → `+ {business}` → Provider: **Onslip 360**
4. Paste the JSON: `{"key_id":"user+token@realm","key":"base64...","realm":"…","env":"prod"}`
5. Click **Test** — adapter calls `/users/?c=1` to verify auth works
6. Click **Save integration**

From there the daily master-sync cron pulls orders and writes to `revenue_logs` with `provider='onslip'`.

## Sources
- [Onslip Developer API](https://developer.onslip360.com/docs/)
- [Onslip REST details](https://developer.onslip360.com/docs/api-users-guide/general-api-features/rest/)
- [Onslip authentication](https://developer.onslip360.com/docs/api-users-guide/general-api-features/authentication-and-authorization/)
- [Onslip npm package](https://www.npmjs.com/package/@onslip/onslip-360-node-api) (not used — we implemented Hawk directly to avoid the dep)
- [Hawk HTTP auth (Mozilla)](https://github.com/mozilla/hawk)
