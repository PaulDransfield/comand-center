# Data Processing Agreement — CommandCenter

**Version 1.0 · 2026-05-11 · TEMPLATE — counsel-review required before first signing.**

This Data Processing Agreement ("**DPA**") is entered into between:

- **Customer**: _____________________________________ ("Controller"), registered office at _____________________________________, organisationsnummer _____________________________________; and
- **CommandCenter**: ComandCenter AB (in formation) ("Processor"), registered office at _____________________________________, with subscription email `legal@comandcenter.se`.

Together the "**Parties**". This DPA forms part of and is subject to the CommandCenter Terms of Service available at `https://comandcenter.se/terms` (the "**Agreement**"). Where this DPA conflicts with the Agreement on data-processing matters, this DPA prevails.

---

## 1. Background and applicability

1.1 The Controller has engaged the Processor to provide the CommandCenter business-intelligence service (the "**Service**"). In delivering the Service, the Processor processes Personal Data on behalf of the Controller.

1.2 This DPA implements Article 28 of Regulation (EU) 2016/679 ("**GDPR**") and complementary obligations under the Swedish Dataskyddslag (2018:218).

1.3 Where the Service involves transfers of Personal Data outside the EU/EEA, the Standard Contractual Clauses adopted by Commission Decision (EU) 2021/914 of 4 June 2021 (Module Two: Controller-to-Processor) apply and are incorporated by reference.

---

## 2. Definitions

Terms used here have the meanings given in Articles 4 of the GDPR. In addition:

- "**Customer Data**" means all data the Controller (or its authorised users) submits to or generates within the Service, including data ingested from third-party integrations (Fortnox, Personalkollen, POS systems, etc.).
- "**Personal Data**" means the subset of Customer Data that identifies a natural person.
- "**Sub-processor**" means any third party engaged by the Processor to process Personal Data on the Controller's behalf.
- "**Security Incident**" means a breach of security leading to accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to Personal Data.

---

## 3. Scope and roles

3.1 The Processor processes Personal Data **only** on documented instructions from the Controller. The Agreement, this DPA, and the Controller's normal use of the Service constitute the Controller's documented instructions.

3.2 For Personal Data processed under this DPA:
- The Controller is the **Controller** within the meaning of GDPR Art. 4(7)
- The Processor is the **Processor** within the meaning of GDPR Art. 4(8)

3.3 Each Party complies with its respective obligations under applicable data protection law.

---

## 4. Categories of data processed

| Data category | Source | Used for | Personal data? |
|---|---|---|---|
| User account data (email, name) | Controller's authorised users | Authentication, in-product communication | Yes — controller's staff |
| Restaurant master data (name, address, organisationsnummer, opening hours) | Controller | Service configuration | Limited — business data |
| Accounting records (Fortnox / Visma / Björn Lundén) | Integration to Controller's accounting system | Cost, revenue, margin analysis | Limited — pseudonymised supplier names possible |
| Staff scheduling and payroll data (Personalkollen / Quinyx) | Integration to Controller's HR system | Labour-cost analysis, scheduling recommendations | **Yes — Controller's employees** |
| POS / sales data (Inzii, Swess, Onslip, Personalkollen sale-centres) | Integration to Controller's POS | Revenue analysis, demand forecasting | Limited — guest names possible in reservation feeds only |
| AI prompts and responses | Controller's authorised users | In-product AI assistant features | Yes — to the extent the prompts include personal data |
| Usage telemetry (page views, feature interactions) | Service | Product improvement | Yes — pseudonymised |

The Processor minimises Personal Data ingestion. Staff personal identifiers are limited to those required for labour-cost analysis (employee name, shift dates, hours, cost). The Processor does **not** ingest social security numbers, home addresses, banking details, or other categories of personal data not required for the contracted service.

---

## 5. Categories of data subjects

- The Controller's authorised users (managers, admins) of the Service
- The Controller's employees referenced in payroll / scheduling data
- Where applicable, guests / customers of the Controller whose data appears in POS or reservation data

---

## 6. Duration

This DPA is effective from the date both Parties accept the Agreement and remains in force for as long as the Processor processes Personal Data on behalf of the Controller, plus any period during which the Processor retains data under Section 11.

---

## 7. Processor obligations

7.1 **Confidentiality.** The Processor ensures all personnel authorised to process Personal Data are bound by appropriate confidentiality obligations.

7.2 **Security measures.** The Processor implements appropriate technical and organisational measures as described in Schedule A, including (but not limited to):
- Encryption in transit (TLS 1.3) and at rest (AES-256)
- Application-layer encryption of third-party integration credentials (AES-256-GCM with a key held separately from the database)
- Row-Level Security on every tenanted database table
- Multi-factor authentication on administrative access
- Audit logging of administrative actions, retained ≥ 2 years
- Production data resides in the EU (Frankfurt) at all times except for AI inference covered by Section 9 transfers

7.3 **Assistance with data subject rights.** The Processor provides Controller with reasonable assistance to comply with data subject requests under GDPR Articles 15–22. The Service provides a self-service export (Art. 15 + 20) and deletion request (Art. 17) flow via the in-product Settings → Data & Privacy section.

7.4 **Assistance with DPIA.** Upon Controller's reasonable request, the Processor provides information necessary to support a Data Protection Impact Assessment under GDPR Art. 35.

7.5 **Audits.** Upon Controller's reasonable written request (and no more than once per twelve-month period unless required by a supervisory authority), the Processor makes available information necessary to demonstrate compliance with this DPA. Audit information includes: the most recent sub-processor SOC 2 / ISO 27001 / equivalent reports, this DPA, the Processor's Security page (`https://comandcenter.se/security`), and confirmation of any unresolved Security Incident in the prior 12 months. On-site physical audits are not part of this DPA.

7.6 **Breach notification.** The Processor notifies the Controller without undue delay — and in any event within 72 hours of becoming aware — of any Security Incident affecting the Controller's Personal Data. Notification will go to the billing email and any additional DPO/security contact listed at Schedule B.

---

## 8. Sub-processors

8.1 The Controller authorises the Processor to engage the Sub-processors listed in Schedule C.

8.2 The Processor maintains a written contract with each Sub-processor imposing data-protection obligations no less protective than those in this DPA.

8.3 The Processor will notify the Controller at least 30 days in advance of adding or replacing any Sub-processor handling Personal Data. The Controller may object on reasonable data-protection grounds; if the Parties cannot agree on an alternative, the Controller may terminate the affected portion of the Service for convenience and the Processor will refund any prepaid fees for the unused period.

---

## 9. International transfers

9.1 The Processor's primary data storage and processing infrastructure is located in the European Union (Frankfurt, Germany).

9.2 The Processor uses Anthropic PBC (United States) for AI inference. Personal Data transferred to Anthropic for inference is covered by the Standard Contractual Clauses (Module 2: Controller-to-Processor) included in Anthropic's commercial DPA. Anthropic commits in their commercial terms not to train models on this data.

9.3 No other transfers of Personal Data outside the EU/EEA occur under this DPA unless documented in Schedule C and covered by appropriate transfer mechanisms.

---

## 10. Controller obligations

10.1 The Controller is responsible for the lawfulness of the Personal Data it provides to the Processor (including a valid legal basis for processing employee data under GDPR Art. 88 and the Swedish working environment regulations).

10.2 The Controller informs its employees that their employment data is processed by the Service for labour-cost analysis.

10.3 The Controller does not submit special categories of Personal Data (GDPR Art. 9) to the Service.

---

## 11. Return and deletion

11.1 Upon termination of the Agreement, or upon Controller's written request, the Processor deletes or returns all Personal Data within 30 days. The export format is JSON (the same format produced by the in-product export flow). Default operation is deletion.

11.2 The Processor may retain Personal Data only to the extent and for the period required by applicable law (e.g. Swedish Bokföringslagen archival obligations affecting invoice records the Processor has stored on the Controller's behalf). Any retained data continues to be subject to this DPA's confidentiality and security obligations.

---

## 12. Liability

Liability under this DPA is subject to the liability provisions of the Agreement, except that nothing in this DPA limits either Party's liability for breach of data-protection law where law prohibits such limitation.

---

## 13. Governing law and disputes

13.1 This DPA is governed by the laws of Sweden, excluding its conflict-of-laws rules.

13.2 Disputes are subject to the exclusive jurisdiction of the Stockholm District Court.

---

## Signatures

For the **Controller** (Customer): _____________________________________ Date: __________
Name: _____________________________________
Title: _____________________________________

For the **Processor** (ComandCenter AB): _____________________________________ Date: __________
Name: Paul Dransfield, Founder

---

## Schedule A — Technical and Organisational Measures

| Measure | Implementation |
|---|---|
| Encryption in transit | TLS 1.3 on all public endpoints; HSTS preload |
| Encryption at rest | AES-256 at the storage layer (Supabase / AWS) |
| Application-layer encryption | AES-256-GCM on third-party API credentials (Fortnox tokens, POS keys) using a key stored separately from the database |
| Tenant isolation | Row-Level Security policies on all customer-data tables, enforced at the database layer |
| Access control | Supabase Auth with HttpOnly session cookies; email-verified accounts; administrative access requires a separate secret + TOTP 2FA |
| Audit logging | Administrative actions logged to an audit table retained ≥ 24 months |
| Backups | Daily backups + point-in-time recovery on production database |
| Hosting | Vercel (EU region) for the application, Supabase (eu-central-1) for the database |
| Vulnerability management | Dependency monitoring via GitHub Dependabot; critical CVE patching within 7 days |
| Personnel | Founder-only access today; all personnel subject to confidentiality obligations under their employment / contractor agreement |
| Network | No public database endpoint; all DB access via Vercel server-side service-role credentials |
| Penetration testing | External penetration test scheduled before reaching 50 paying customers |

The Processor publishes its current security posture at `https://comandcenter.se/security` and will update this page as measures evolve.

---

## Schedule B — Notification contacts

| Type | Contact |
|---|---|
| Day-to-day data protection contact (Processor) | `privacy@comandcenter.se` |
| Security incidents (Processor) | `security@comandcenter.se` |
| Controller's DPO / privacy contact | _____________________________________ |
| Controller's billing contact (used as breach-notification fallback) | _____________________________________ |

---

## Schedule C — Authorised Sub-processors

The following Sub-processors are authorised by the Controller as of the effective date of this DPA. A current list is maintained at `https://comandcenter.se/security#sub-processors`.

| Sub-processor | Service | Location of processing | Certifications |
|---|---|---|---|
| **Supabase, Inc.** | Postgres database, authentication, file storage | EU (Frankfurt, eu-central-1) | SOC 2 Type II, HIPAA, GDPR (DPA on file) |
| **Vercel, Inc.** | Application hosting and CDN | EU (Frankfurt) | SOC 2 Type II, GDPR (DPA on file) |
| **Amazon Web Services, Inc.** | Underlying infrastructure for Supabase | EU (Frankfurt) | SOC 1/2/3, ISO 27001, PCI DSS |
| **Anthropic PBC** | AI inference (Claude API) | United States (covered by SCCs) | SOC 2 Type II, GDPR (SCCs on file) |
| **Stripe Payments Europe Ltd.** | Subscription billing and payments | EU (Ireland) | PCI DSS Level 1, SOC 1/2 |
| **Resend Inc.** | Transactional email (signups, alerts, exports) | EU + US (SCCs) | SOC 2 Type II in progress |
| **GitHub, Inc.** | Source code repository (no customer data) | US | SOC 1/2/3, ISO 27001 |

---

## How to use this template

1. **Get counsel review before first signing.** This is a working draft. A Swedish data-protection lawyer (Delphi / Mannheimer Swartling / Setterwalls) should review before it's signed by a paying customer.
2. **Fill the blanks** in the parties block and Schedule B before sending.
3. **One DPA per customer org** — not per business. The DPA covers all restaurants under that customer's CommandCenter org.
4. **Storage**: signed DPAs go in a single private folder (suggested: `dpas/<org-slug>/<YYYY-MM-DD>.pdf`) plus countersigned copy delivered to the customer.
5. **Update Schedule C** when adding a new sub-processor — same DPA stays valid, you just notify customers per Section 8.3 (30-day advance notice).
