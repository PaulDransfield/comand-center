# Visma

## Identity
- **Name (local)**: Visma — product we'd connect to is **Visma eAccounting** (marketed in Sweden as **Spiris Bokföring & Fakturering**)
- **Category**: Accounting (Bokföring)
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `visma`
- **Logo URL**: https://www.visma.se

## API technical
- **Docs URL**: https://developer.visma.com/api/eaccounting — main developer docs
- **Developer portal / sandbox URL**: https://developer.vismaonline.com/ (portal) + https://identity.vismaonline.com/ (OAuth)
- **Base URL (prod)**: `https://eaccountingapi.vismaonline.com/` (inferred from third-party SDKs and community)
- **Auth type**: `oauth2` — standard authorization code flow
- **Credentials shape**: `{ client_id: string, client_secret: string, access_token: string, refresh_token: string }`
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH (`$skip` / `$top` OData-style likely)
- **Data format**: JSON
- **Webhooks supported**: Yes (confirmed — Visma eAccounting supports webhook events)
- **Timezone handling**: UTC / ISO-8601
- **VAT handling**: `both_fields` — invoice lines expose net/VAT/gross
- **Auth quirk**: access_token expires after 60 minutes; refresh_token is invalidated if user changes Visma password — must handle re-auth flow

## Data model — what they expose
Based on dev docs + community SDKs:
- Invoices (customer invoices — outgoing)
- Supplier invoices (costs)
- Vouchers (bookkeeping entries)
- Customers + Suppliers
- Chart of accounts
- VAT reports
- Payroll (separate Visma Lön API)

## Business / market
- **Sweden market share (rough)**: Large — Visma is a Nordic giant. In Sweden, eAccounting / Spiris Bokföring competes with Fortnox and Björn Lundén for SMB segment.
- **Target segment**: SMB, including restaurants. Also dominant among larger companies via Visma Business (different product, different API).
- **Pricing**: From ~129 kr/mo (Spiris Bokföring) up to enterprise Visma Business
- **Support email**: partners via developer portal
- **Partnership status**: `official_partner` — must sign up for Partner Programme to get client_id/secret
- **Multi-product note**: Visma Business is a separate product with SOAP/.NET integration — not via eAccounting API

## Implementation notes
- **Known gotchas**:
  - **Product confusion** — "Visma" could mean eAccounting (SMB cloud), Business (mid-market), or Administration (legacy). We target eAccounting / Spiris.
  - **Scope model** — each resource has its own OAuth scope; must request the right set during auth
  - **Refresh token fragility** — if user changes their Visma password, refresh tokens invalidate. Plan for graceful re-auth prompt.
  - **Nordic coverage** — Visma eAccounting works in Norway and Netherlands too; the Swedish flavour is Spiris-branded
- **How the customer obtains the key**: OAuth flow — customer authenticates at identity.vismaonline.com, grants scopes, we get tokens
- **OAuth redirect URI**: `https://comandcenter.se/api/integrations/visma/callback`
- **Required scopes**: NEEDS RESEARCH — at minimum invoice, supplier, voucher, customer, chartofaccounts
- **Skatteverket certified cash register**: N/A (accounting)
- **Supports multi-site / chain**: One Visma account per legal entity (same as Fortnox)
- **API response language**: English field names
- **Build estimate**: 5-7h

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17 (web research)
- **Primary contact at provider**: Visma Partner Programme via developer portal

## Sample API interaction
```bash
# Exchange code for token (after OAuth redirect)
curl -X POST https://identity.vismaonline.com/connect/token \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$REDIRECT_URI&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"

# Fetch invoices
curl -H "Authorization: Bearer $TOKEN" \
     "https://eaccountingapi.vismaonline.com/v2/customerinvoices?$filter=InvoiceDate%20ge%202026-04-01"
```

## Notes for future integration
- **Second-tier accounting priority** — build after Fortnox. Together they cover 80%+ of Swedish SMB accounting.
- **Spiris vs eAccounting** — same API, different branding. Swedish customers may know it as either name.
- **Community SDKs exist** (Python, Ruby, Node, Rust) — worth studying before building our own adapter

## Sources
- [Visma Developer eAccounting docs](https://developer.visma.com/api/eaccounting)
- [Visma Online Authentication](https://developer.vismaonline.com/docs/authentication)
- [Visma OAuth 2.0 Flow](https://community.visma.com/t5/Knowledge-base-in-Developers/OAuth-2-0-Authorization-Flow/ta-p/270859)
- [Visma eAccounting API community](https://community.visma.com/t5/Visma-eAccounting-API/ct-p/IN_MA_eAccountingAPI)
