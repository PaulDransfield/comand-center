# LEGAL-OBLIGATIONS.md — data handling, accounting, and sub-processors

> Last updated: 2026-04-17
> Owner: Paul Dransfield (founder)
> Review cadence: quarterly, and whenever a new sub-processor or data source is added
> **Status: internal working document — NOT legal advice. Before production go-live with paying customers, retain a Swedish data-protection/fintech lawyer (suggested firms: Delphi, Mannheimer Swartling, Setterwalls). This file is the founder's practical reference for what we have to do and what we have to prove we did.**

CommandCenter is a Swedish SaaS. It ingests operational data from restaurants (staff shifts, revenue, accounting records, POS transactions) and runs AI analysis on it. That puts us squarely inside three overlapping regimes: **GDPR**, **Swedish bookkeeping/tax law**, and **contractual obligations to each upstream provider**. This file captures what each one requires us to do.

---

## 1. Quick-read — the ten things that must be true before we take a paying customer

1. **Signed Data Processing Agreement (DPA) with every customer** before any of their data enters our system. We are their *processor* for almost everything.
2. **Signed DPA with every sub-processor** we use (Supabase, Vercel, Anthropic, Stripe, Resend — see §7). All are already publicly available — we just need to countersign and file them.
3. **Data stays in the EU.** Supabase project is in Frankfurt (eu-central-1). Vercel deployment region is EU. Confirmed.
4. **Encryption at rest and in transit** on every data store (Supabase handles at-rest, all our endpoints are HTTPS).
5. **API keys and OAuth tokens from integrations are encrypted at application layer** — not just stored in Postgres. (**Gap: see §10.**)
6. **A public privacy policy** at comandcenter.se/privacy listing every sub-processor, every data category, every retention period, and every legal basis. (**Gap: see §10.**)
7. **A data-breach runbook** that can notify the Integritetsskyddsmyndigheten (IMY) within 72 hours of discovering a reportable breach.
8. **Data subject rights flow** — access, rectification, erasure, portability — documented and executable within 30 days.
9. **Accounting-data handling terms** that respect the customer's obligations under Bokföringslagen: they still own the original records; we are a read-only copy for analysis. We do not replace their archival obligation.
10. **Terms of Service** that disclaim us as a source of tax/legal/bookkeeping advice — we produce insight, not regulated financial output.

---

## 2. Legal frameworks that apply to us

| Framework | Applies because | What it forces us to do |
|-----------|-----------------|--------------------------|
| **GDPR** (EU 2016/679) | We process personal data (staff, customer users, restaurant guests in some POS feeds) | Legal basis, DPAs, sub-processor transparency, data subject rights, breach notification, records of processing (Art. 30) |
| **Dataskyddslag (2018:218)** — Swedish GDPR implementation | Our primary market is Sweden | Complements GDPR — certain sector rules, IMY is the supervisory authority |
| **Bokföringslagen (1999:1078)** — Swedish Bookkeeping Act | We ingest and display accounting data from Fortnox/Björn Lundén/Visma | We do **not** take over the customer's archival duty; originals stay in their accounting system. We must not mutate their books. |
| **Skatteförfarandelagen (2011:1244)** — Tax Procedure Act | Secondary, via Fortnox/Skatteverket integrations | Customer's tax records must stay auditable; we cannot be the system-of-record |
| **Arbetsrätt / GDPR Art. 88** — employment data | Staff-hours data from Personalkollen/Quinyx includes individual employee identifiers, shifts, and pay | Higher bar for legal basis. Employer is controller; we are processor only. |
| **ePrivacy Directive / Lag (2003:389)** | Cookies on comandcenter.se | Consent banner for non-essential cookies |
| **EU AI Act** (Regulation 2024/1689, full enforcement 2026–2027) | We run Claude on customer data | Transparency obligations, no prohibited-use cases, logs, risk classification — likely "limited risk" for us (not "high risk") but must document this assessment |
| **NIS2 Directive** | Potentially, once we scale into the "important entity" threshold (50 staff or €10M revenue) — not yet | Cyber incident reporting, governance requirements |
| **Contractual (per-provider)** | Each API we consume has terms — Fortnox dev program, PK commercial agreement, Anthropic usage policies, etc. | Often stricter than GDPR on some points (e.g. Fortnox requires certification before production) |

---

## 3. Our role under GDPR — controller vs processor

This is the single most important distinction. We sit in **two roles**, sometimes simultaneously, and the documentation has to be clean about which is which.

### 3a. We are a **CONTROLLER** for:
- **Customer account data** — the org admin's email, name, password hash, org name, billing contact. We decide the purpose (they signed up to use the app).
- **Usage telemetry** — which user clicked which button, AI query counts, feature adoption. We decide this is collected for product improvement.
- **Our own marketing contact list** — email sign-ups on the landing page.
- **Legal basis**: Contract (Art. 6(1)(b)) for the first two; legitimate interest (Art. 6(1)(f)) for telemetry with a balancing test documented; consent (Art. 6(1)(a)) for marketing.

### 3b. We are a **PROCESSOR** for:
- **Staff-hours data** from Personalkollen / Quinyx / etc. — the restaurant is the employer and the controller; we just analyse it.
- **Revenue and POS transaction data** from Inzii / Swess / Onslip / etc. — the restaurant is the controller of that business data (and any guest data it contains, e.g. reservation names).
- **Accounting records** from Fortnox / Björn Lundén / Visma — the restaurant is the controller and keeps their regulatory obligations.
- **Guest / reservation data** from TheFork / Bokad — the restaurant is the controller.

**Consequence:** Every customer needs a DPA that names us as processor and lists our sub-processors. Every new sub-processor triggers a notification obligation to customers.

### 3c. Grey areas to resolve with counsel
- **AI queries over customer data**: are we *processor* (executing instructions) or *controller* (deciding the purpose of AI analysis)? Current thinking: processor — the customer asks, we execute. Must be explicit in DPA.
- **Aggregated anonymous insights**: if we ever build benchmarking across customers ("you're 12% below average"), that's either aggregated/anonymous (fine) or a new controller relationship (needs legal basis). Do not ship this until decided.

---

## 4. Data flows and obligations — per source

### 4a. Personalkollen (staff / hours / pay)
**What we pull:** Shift start/end, employee identifier, hourly cost, OB supplement, lateness.
**Personal data category:** Employment data — identifiable to a named employee.
**Risk level:** Medium-high. Pay data is not "special category" (Art. 9) but employment data is scrutinised under GDPR Art. 88.
**Our role:** Processor for the restaurant (who is the employer-controller).
**Obligations:**
- Customer must inform their employees this data is being processed by us.
- We must minimise — we only take fields needed for labour-cost analysis. No social security numbers, no home addresses.
- PK integration terms must permit third-party analytics use (**TODO: confirm in writing with Personalkollen before charging customers for this**).
- Retention: as long as the integration is active + 90 days grace after disconnect, then deleted.

### 4b. Fortnox (accounting) — THE MOST SENSITIVE SOURCE
**What we pull:** Supplier invoices, payment records, cost categories, P&L lines.
**Personal data category:** Contains supplier personal data (sole traders) and employee names on payroll entries. Also commercially sensitive.
**Our role:** Processor for the customer. **We are not replacing their bookkeeping system.**
**Regulatory obligations:**
- **Bokföringslagen §7** — the customer must retain original accounting records in a durable form for 7 years. Our copy is a convenience mirror, not an archive. **This must be explicit in our ToS.**
- **Fortnox developer agreement** — we must be a registered/certified developer. Production OAuth requires Fortnox approval. (**Status: pending — integration skeleton exists, OAuth app not registered.**)
- Read-only access only. We do not write back to Fortnox.
- We will cache accounting data for performance but not for archival — if the customer disconnects Fortnox, we purge the cache within 30 days (except summary aggregates that are irreversibly anonymised per §3c grey area).
- **We must not produce output that the customer could mistake for a regulated financial statement.** All P&L / tracker views must be labelled "management view — not an audited financial statement."
- Cross-check with auditor requirements: if a customer uses us as part of their audit trail, they need their accountant's approval. Out of scope for us to assess.

### 4c. Björn Lundén / Visma eAccounting / Skatteverket (accounting & tax)
**Same obligations as Fortnox.** Visma's developer terms are stricter on data residency — confirm EU-only at integration time.
**Skatteverket**: read-only, only if customer grants access via their e-legitimation. We cannot act on their behalf for filings.

### 4d. Inzii / Swess / Onslip / other POS
**What we pull:** Sales lines, department totals, payment methods, sometimes itemised orders.
**Personal data category:** Usually none. Occasionally loyalty-programme IDs or named table reservations.
**Our role:** Processor for the restaurant.
**Obligations:**
- Aggregate to daily / department totals where possible — do not retain per-transaction customer identifiers unless the customer explicitly enables that feature.
- **VAT (moms) compliance**: our revenue figures must match what the restaurant declares. We display ex-moms for PK parity. If a customer relies on our numbers for tax declarations (they shouldn't — see Bokföringslagen split above), we are not liable, but we must flag reconciliation differences visibly.

### 4e. Reservation providers (TheFork / Bokad / etc.)
**What we pull:** Booking counts, covers per day. We do not need guest names or emails.
**Obligations:** Take only counts and aggregates. If we ever need individual reservation records, that's guest personal data and requires a new DPA flow.

### 4f. Delivery platforms (Foodora / Wolt)
**What we pull:** Sales totals, commission splits, order counts.
**Obligations:** Similar to POS — aggregates only, no individual customer data unless explicitly required for a feature.

### 4g. Payment processors (Zettle / Loomis Pay)
**What we pull:** Transaction totals, card vs. Swish splits, settlements.
**Obligations:** **Never store full card PAN, never store CVV.** We rely on the processor's PCI DSS compliance — we only ingest tokenised / aggregated data. If we ever touch raw card data, we need our own PCI scope assessment (avoid this).

### 4h. Anthropic Claude (AI processing layer)
**What we send:** Business context — shift data, revenue, P&L — to produce anomaly explanations, briefings, recommendations.
**Our role:** We are controller of what we send; Anthropic is processor.
**Obligations:**
- Anthropic API DPA on file (**TODO: download signed copy from Anthropic Console and store in `docs/legal/`**).
- **Zero Data Retention (ZDR)** must be enabled on our Anthropic org for production customer data. Verify at https://console.anthropic.com — see `docs/legal/anthropic-zdr-screenshot.png` (to capture).
- EU data residency for Anthropic: Anthropic processes in the US. **This is a cross-border transfer — requires Standard Contractual Clauses (SCCs)**, which Anthropic provides in their DPA. Must be disclosed to customers in our DPA and privacy policy.
- We must not send data that the customer hasn't consented to AI analysis of. The "AI Booster" opt-in flow is the consent mechanism — without it, agents run only on the customer's own aggregated data, never shared externally.
- **EU AI Act transparency** (Art. 52): users must be informed when they are interacting with AI output. Every AI-generated insight in the app must be visibly labelled (currently done via "AI" badges — good).

---

## 5. Security obligations — technical and organisational measures (Art. 32)

GDPR Art. 32 requires "appropriate technical and organisational measures" proportionate to risk. Here's what we have and what we're missing.

### Have
- TLS on every endpoint (Vercel default, HSTS on).
- Encryption at rest (Supabase Postgres — AES-256).
- Multi-tenant isolation via RLS policies on every tenanted table (`org_id`, `business_id`).
- Admin access gated behind a separate `ADMIN_SECRET` out-of-band from customer auth.
- Stripe handles all card data — we never see PANs.
- Supabase project in Frankfurt (eu-central-1).
- Vercel deployment region EU.
- Git history scrubbed of leaked secrets (incident 2026-04 — ANTHROPIC_API_KEY rotated).

### Gaps / action items
- [ ] **Application-layer encryption for integration API keys/tokens.** Currently stored as plain text in `integrations.api_key`. Should use libsodium / AEAD with a KMS-backed key. Priority: HIGH before first paid customer.
- [ ] **Audit log**: who accessed which customer, when. Currently only sync_log exists. Need an admin-action audit log for impersonation, key changes, deletions. Priority: HIGH.
- [ ] **Backups**: Supabase daily backups are on. Confirm restore tested at least once.
- [ ] **Access review cadence**: quarterly review of who has admin access. Right now only Paul.
- [ ] **Secrets rotation policy**: document it. Right now ad-hoc.
- [ ] **SSO / 2FA on admin panel**: currently password-only. Upgrade to TOTP at minimum before paid customers.
- [ ] **Dependency scanning**: enable Dependabot or Renovate. Currently manual.
- [ ] **Penetration test**: commission one before year-end, minimum.

---

## 6. Data subject rights (Art. 15–22)

Customers and their employees have the right to:

| Right | What we must deliver | Our current flow |
|-------|----------------------|-------------------|
| **Access (Art. 15)** | Copy of all their personal data | **Gap** — no self-service export yet. Manual via admin panel. Build this. |
| **Rectification (Art. 16)** | Correction of inaccurate data | User can edit their profile; correction of upstream data (e.g. PK shifts) must go back to the source system. Document this in privacy policy. |
| **Erasure (Art. 17)** | Delete all their data | **Partial** — org deactivate exists but doesn't fully purge. Need a "delete org + cascade all rows + purge sub-processor data" flow. Priority: HIGH before GA. |
| **Restriction (Art. 18)** | Pause processing | Covered by deactivate. |
| **Portability (Art. 20)** | Machine-readable export of data they provided | **Gap** — build JSON/CSV export. Priority: MEDIUM. |
| **Object (Art. 21)** | Object to specific processing | N/A for contract-basis processing; applies to marketing — unsubscribe links on emails. |
| **Automated decisions (Art. 22)** | No solely-automated decisions with legal effect | None in our product — AI produces insights for human review, never takes automated action. Document this in ToS. |

**All requests must be fulfilled within 30 days** (extendable once by 60 days for complex requests, with notification).

---

## 7. Sub-processors — full list

Every name on this list must be in our public privacy policy. Every one needs a signed DPA on file in `docs/legal/sub-processors/`.

| Sub-processor | Purpose | Location | DPA status | Transfer mechanism | Notes |
|---------------|---------|----------|------------|---------------------|-------|
| **Supabase** | Primary database, auth | Frankfurt (EU) | **TODO — download from dashboard and file** | N/A (EU) | Project region locked |
| **Vercel** | Hosting, compute, cron | EU (iad1 fallback — **verify region lock**) | TODO | SCCs if any US fallback | Confirm in project settings |
| **Anthropic (Claude API)** | AI analysis | US | TODO — signed DPA with SCCs | SCCs + ZDR enabled | Verify ZDR toggle in Console |
| **Stripe** | Billing, payments | US (EU presence) | Standard Stripe DPA — countersign | SCCs | Minimal PII — just billing email + card token |
| **Resend** | Transactional email | US (EU delivery) | TODO | SCCs | Sends to customer addresses — minimal |
| **GitHub** | Source code only (no customer data) | US | N/A for customer data | — | Codebase only; excluded from data flow |
| **Sentry or similar** (future) | Error monitoring | — | — | — | Not yet in use; if added must scrub PII |
| **Personalkollen** | Data source (customer's integration — not our sub-processor technically, but must be disclosed) | Sweden | Handled by customer's agreement with PK | — | — |
| **Fortnox / Björn Lundén / Visma** | Same as above | Sweden | Same as above | — | — |

**Rule:** no sub-processor goes live with production data before their DPA is filed.

---

## 8. Breach notification (Art. 33–34)

A personal data breach triggers:
- **72-hour clock** to notify the Integritetsskyddsmyndigheten (IMY) — `anmalan@imy.se` or https://www.imy.se
- **Notification to affected data subjects** if the breach is likely to result in a high risk to their rights (delayable if mitigated).
- **Notification to affected customers** per our DPAs — typically "without undue delay", often 24h contractual.

**Runbook (TODO to formalise in `docs/breach-runbook.md`):**
1. Detect — via alerts, sync_log anomalies, manual report.
2. Contain — revoke affected keys, deactivate affected integrations, snapshot the DB.
3. Assess — what data, how many subjects, what risk.
4. Notify — IMY, affected customers, affected subjects (if high risk).
5. Document — even if not reportable, log internally.

---

## 9. Retention periods (summary)

| Data type | Retention | Justification |
|-----------|-----------|---------------|
| Active customer data (revenue, staff, accounting) | Duration of subscription + 30 days grace | Contract |
| After cancellation | 30 days grace, then hard-delete unless legal hold | GDPR minimisation |
| Billing records (Stripe) | 7 years | Bokföringslagen + Swedish tax law |
| Audit log / admin actions | 2 years | Our own security evidence |
| Sync logs (with no personal data) | 90 days | Operational debugging |
| AI query logs (with PII redacted) | 90 days | Debugging — must be PII-free |
| Email marketing list | Until unsubscribe | Consent |
| Anomaly / alert records | While org active | Feature data |

---

## 10. Gaps we know about (priority order)

**Before first paying customer:**
1. Application-layer encryption of integration API keys (§5).
2. Signed privacy policy + ToS published on comandcenter.se (§1).
3. Customer-facing DPA template (§3).
4. Signed DPAs with Anthropic, Supabase, Vercel, Stripe, Resend filed (§7).
5. Fortnox developer program approval + certified integration status (§4b).
6. Anthropic ZDR verified enabled (§4h).
7. Hard-delete cascade flow for org deletion (§6).
8. 2FA on admin panel (§5).

**Before scaling past 10 customers:**
9. Self-service data export (§6).
10. Quarterly access review + secrets rotation schedule (§5).
11. Audit log for all admin actions (§5).
12. Penetration test (§5).
13. EU AI Act risk assessment documented (§2).

**Before 50 customers / NIS2 threshold approach:**
14. Formal ISMS (information security management system).
15. Vendor security questionnaires.
16. DPO (Data Protection Officer) — may be required by org size.
17. Cybersecurity incident response plan tested.

---

## 11. Terms of Service — non-negotiable clauses

Whatever the final ToS says, these points must appear:

- **"Management view, not a regulated financial output."** Our reports are informational and not a substitute for regulated bookkeeping, financial statements, or tax filings.
- **"Customer remains responsible for their own accounting records under Bokföringslagen."** We mirror their data for analysis; the archival obligation is theirs.
- **"No automated decisions with legal effect."** AI output is advisory; the customer acts on it.
- **"We do not provide tax, legal, or accounting advice."** Disclaimer from regulated advisory.
- **Customer warrants they have the right to ingest the data they connect.** They confirm they have the lawful basis for giving us access (employer status for staff data, controller status for POS/accounting).

---

## 12. Document ownership

- **Owner**: Paul Dransfield (founder).
- **Review**: quarterly (next: 2026-07-17) and whenever a sub-processor, data source, or feature that touches new data categories is added.
- **Storage**: this file in the repo. Signed DPAs and certificates in `docs/legal/` (to create). PDFs of policies live in Supabase Storage bucket `legal-documents/` (to create).
- **Legal counsel to engage**: pick one of Delphi / Mannheimer Swartling / Setterwalls before go-live for a formal review pass. Budget: ~50–100k SEK for initial review + templates.

---

*This is a working document. When the regime changes, when a new integration is added, when a sub-processor is swapped, update this file. Every change here is a change to our compliance posture.*
