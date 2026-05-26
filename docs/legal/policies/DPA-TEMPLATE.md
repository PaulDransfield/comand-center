# Data Processing Agreement (DPA) — CommandCenter

> **STATUS: DRAFT for legal review — NOT yet legal advice or a binding template.**
> Prepared 2026-05-26 as a working first draft so a Swedish data-protection lawyer
> (Delphi / Mannheimer Swartling / Setterwalls) can refine rather than write from
> scratch. Do **not** present this to a customer for signature until counsel has
> reviewed it and the bracketed `[...]` fields are completed. Grounded in the
> actual CommandCenter architecture as documented in `LEGAL-OBLIGATIONS.md`.

---

## Data Processing Agreement

This Data Processing Agreement ("**DPA**") forms part of, and is subject to, the
CommandCenter Terms of Service ("**Agreement**") between:

- **ComandCenter AB**, org. nr [ORG NUMBER — pending registration], a company
  registered in Sweden with its registered office at [REGISTERED ADDRESS]
  ("**Processor**", "**we**", "**us**", "**CommandCenter**"); and
- the customer organisation identified in the Agreement ("**Controller**",
  "**you**", "**Customer**").

Each a "**Party**" and together the "**Parties**".

This DPA reflects the Parties' agreement on the processing of Personal Data in
connection with the Service, in accordance with Article 28 of Regulation (EU)
2016/679 (the "**GDPR**") and the Swedish Data Protection Act
(*Dataskyddslag (2018:218)*).

If there is any conflict between this DPA and the Agreement on the subject of
data protection, this DPA prevails.

---

### 1. Definitions

Terms not defined here have the meaning given in the GDPR.

- **Personal Data**, **Processing**, **Data Subject**, **Controller**,
  **Processor**, **Sub-processor**, **Supervisory Authority**, and
  **Personal Data Breach** have the meanings given in Article 4 GDPR.
- **Applicable Data Protection Law** means the GDPR, the Swedish Data Protection
  Act (2018:218), and any other data-protection or privacy law applicable to the
  Processing under this DPA.
- **Customer Personal Data** means Personal Data that we Process on your behalf
  under the Agreement, as described in **Annex 1**.
- **Standard Contractual Clauses (SCCs)** means the clauses approved by the
  European Commission in Implementing Decision (EU) 2021/914 for the transfer of
  Personal Data to third countries.

---

### 2. Roles of the Parties

2.1 In respect of the Customer Personal Data described in **Annex 1**, you act as
the **Controller** and we act as the **Processor**. This includes staff /
employment data, point-of-sale and revenue data, accounting records, and any
other operational data you connect or upload to the Service.

2.2 For a limited set of data we determine the purposes and means of Processing
and therefore act as an independent **Controller** — specifically: your account
administrators' contact details, authentication data, billing contact, product
usage telemetry, and our own marketing lists. That Processing is governed by our
Privacy Policy (comandcenter.se/privacy), not by this DPA.

2.3 You confirm that you have a lawful basis under the GDPR to Process the
Customer Personal Data and to instruct us to Process it, including, where
applicable, the employer's basis for staff data (GDPR Art. 88) and the
controller's basis for POS and accounting data. You are responsible for the
accuracy, quality, and legality of the Customer Personal Data and the means by
which you acquired it.

---

### 3. Scope and instructions

3.1 We will Process Customer Personal Data only on your **documented
instructions**, including with regard to transfers to a third country, unless
required to do otherwise by EU or Member State law to which we are subject
(in which case we will inform you of that legal requirement before Processing,
unless that law prohibits such information on important grounds of public
interest).

3.2 The Agreement, this DPA (including **Annex 1**), your configuration of the
Service, and your use of the Service's features constitute your complete and
final documented instructions. Additional instructions outside the scope of the
Service require prior written agreement and may incur additional charges.

3.3 We will inform you if, in our opinion, an instruction infringes Applicable
Data Protection Law. We are not obliged to perform a legal review of the
lawfulness of your instructions.

---

### 4. Confidentiality

4.1 We ensure that persons authorised to Process the Customer Personal Data
(employees, contractors) are bound by an appropriate duty of confidentiality
(whether contractual or statutory).

4.2 We limit access to Customer Personal Data to personnel who need it to provide,
support, secure, or improve the Service.

---

### 5. Security (Article 32)

5.1 We implement and maintain appropriate technical and organisational measures
to ensure a level of security appropriate to the risk, as described in
**Annex 3**. We may update those measures over time provided the level of
security is not materially reduced.

5.2 The current measures include, without limitation: encryption of data in
transit (TLS 1.3) and at rest (AES-256); application-layer encryption of
third-party integration credentials; tenant isolation (per-organisation
row-level security); access controls and administrative audit logging;
EU-only primary data storage; and error-monitoring with personal-data scrubbing.

---

### 6. Sub-processors

6.1 You provide **general written authorisation** for us to engage Sub-processors
to Process Customer Personal Data. The Sub-processors engaged as at the date of
this DPA are listed in **Annex 2**.

6.2 We impose data-protection obligations on each Sub-processor that are no less
protective than those in this DPA, by way of a written contract, in particular
the obligations in Article 28(3) GDPR. We remain fully liable to you for a
Sub-processor's performance of its data-protection obligations.

6.3 We will give you at least **30 days' prior notice** (by email and/or in-app
notice, and via the Sub-processor list published in our Privacy Policy) of any
intended addition or replacement of a Sub-processor. If you have a reasonable,
data-protection-based objection, you may notify us within that period; the
Parties will work in good faith to resolve it, and if it cannot be resolved you
may terminate the affected part of the Service as your sole remedy.

---

### 7. International transfers

7.1 We store the primary copy of Customer Personal Data in the **European Union**
(Frankfurt region).

7.2 Where a Sub-processor Processes Customer Personal Data outside the
EU/EEA (currently the AI-processing and transactional-email providers in
**Annex 2**), such transfer is covered by an appropriate Chapter V transfer
mechanism — primarily the **Standard Contractual Clauses** (Module Two:
Controller-to-Processor / Module Three: Processor-to-Processor as applicable),
together with supplementary measures where required. Details are in **Annex 4**.

7.3 For AI Processing (Anthropic), **Zero Data Retention** is enabled so that
inputs and outputs are not retained beyond the processing window and are not used
to train models.

---

### 8. Assistance to the Controller

8.1 **Data subject requests.** Taking into account the nature of the Processing,
we will assist you by appropriate technical and organisational measures, insofar
as possible, to respond to requests from Data Subjects exercising their rights
under Chapter III GDPR (access, rectification, erasure, restriction, portability,
objection). The Service provides self-service data export (JSON) and deletion
functionality for this purpose. If we receive such a request directly, we will,
unless legally prohibited, promptly forward it to you and not respond ourselves
except on your instruction.

8.2 **Security, breach, DPIA.** We will assist you, taking into account the nature
of Processing and the information available to us, in ensuring compliance with
your obligations under Articles 32 to 36 GDPR (security, breach notification,
data-protection impact assessments, and prior consultation).

---

### 9. Personal Data Breach

9.1 We will notify you **without undue delay**, and in any event within **48
hours**, after becoming aware of a Personal Data Breach affecting Customer
Personal Data.

9.2 The notification will describe, to the extent known: the nature of the breach;
the categories and approximate number of Data Subjects and records concerned;
the likely consequences; and the measures taken or proposed to address it. Where
information is not available at once, it may be provided in phases without undue
further delay.

9.3 We will not make statements on your behalf to a Supervisory Authority or
Data Subjects without your prior consent, unless required by law. You are
responsible for any notification to the Supervisory Authority
(Integritetsskyddsmyndigheten / IMY) and to affected Data Subjects where you
are the Controller.

---

### 10. Audits

10.1 We will make available to you all information reasonably necessary to
demonstrate compliance with Article 28 GDPR and this DPA, and will allow for and
contribute to audits, including inspections, conducted by you or an auditor you
mandate.

10.2 To minimise disruption, we may satisfy an audit request by providing
existing third-party certifications, audit reports, or completed security
questionnaires. Where those are insufficient, an on-site or remote audit may be
conducted no more than once per year (save where required by a Supervisory
Authority or following a Personal Data Breach), on reasonable prior notice,
during business hours, subject to confidentiality, and at your cost.

---

### 11. Return and deletion

11.1 On termination of the Agreement, we will, at your choice, delete or return
all Customer Personal Data, and delete existing copies, unless EU or Member State
law requires storage.

11.2 In practice: Customer Personal Data is retained for a **30-day** grace period
after termination (to allow reactivation and a final export), after which it is
permanently deleted from active systems and removed from backups within the
backup rotation cycle. **Billing and accounting records** are retained for **7
years** where required by the Swedish Bookkeeping Act
(*Bokföringslagen (1999:1078)*).

11.3 **Bookkeeping note.** The Service holds a convenience mirror of your
accounting data for analysis only. It is not your system of record and does not
discharge your archival obligations under the Bokföringslag, which remain with
your accounting system (Fortnox, Björn Lundén, Visma or equivalent).

---

### 12. Liability

Each Party's liability under this DPA is subject to the limitations and
exclusions of liability set out in the Agreement.

---

### 13. Term

This DPA takes effect on the date you accept the Agreement (or the date you
accept this DPA, if later) and continues until all Customer Personal Data has
been deleted or returned in accordance with Section 11.

---

### 14. Governing law and jurisdiction

This DPA is governed by Swedish law. Disputes are subject to the exclusive
jurisdiction of the Swedish courts, with Stockholm District Court
(*Stockholms tingsrätt*) as the court of first instance, consistent with the
Agreement.

---

## Annex 1 — Description of the Processing

| Item | Detail |
|------|--------|
| **Subject matter** | Provision of the CommandCenter restaurant business-intelligence service. |
| **Duration** | For the term of the Agreement, plus the retention periods in Section 11. |
| **Nature and purpose** | Ingesting, storing, aggregating, analysing, and presenting the Customer's operational data; generating reports, forecasts, budgets, alerts, and AI-assisted insight for the Customer's internal management use. |
| **Type of Personal Data** | Staff / employment data (employee name or identifier, shift times, hourly cost, OB supplement, lateness — **no** social-security numbers or home addresses); supplier data on accounting records (which may include sole-trader names); account-user data (name, email); incidental Personal Data contained in POS / reservation feeds where the Customer enables such features. |
| **Special categories (Art. 9)** | None intended or required. The Customer must not connect data sources containing special-category data without prior written agreement. |
| **Categories of Data Subjects** | The Customer's employees; the Customer's suppliers (where sole traders); the Customer's account users; and, only where the Customer enables relevant features, the Customer's guests. |
| **Frequency** | Continuous / scheduled synchronisation for the duration of the Agreement. |

---

## Annex 2 — Authorised Sub-processors

> Keep this Annex in sync with Privacy Policy §5 and `LEGAL-OBLIGATIONS.md §7`.
> Update the date and re-notify customers when this list changes.

*As at 2026-05-26:*

| Sub-processor | Purpose | Location | Transfer mechanism |
|---------------|---------|----------|--------------------|
| Supabase Inc. | Primary database and authentication | EU (Frankfurt) | N/A — EU |
| Vercel Inc. | Application hosting, compute, scheduled jobs | EU | SCCs for any incidental non-EU processing |
| Anthropic PBC | AI analysis (Claude) — Zero Data Retention enabled | USA | SCCs + ZDR; no model training |
| Stripe Inc. | Subscription billing and payments | EU processing addendum | SCCs |
| Resend, Inc. | Transactional email delivery | USA | SCCs |
| Functional Software, Inc. (Sentry) | Error / crash monitoring (PII-scrubbed) | EU (ingest.de.sentry.io) | SCCs for incidental US transfer |
| PostHog (EU Cloud) | Product-usage analytics (consent-gated, UUID-only) | EU (Frankfurt) | N/A — EU |

Integration partners (Personalkollen, Fortnox, and similar) connect on the
Customer's own instruction under the Customer's agreement with that provider and
are not CommandCenter Sub-processors, but are disclosed for transparency.

---

## Annex 3 — Technical and Organisational Measures (Art. 32)

**Encryption**
- TLS 1.3 in transit on all public endpoints; HSTS enabled.
- AES-256 encryption at rest (database and underlying storage).
- Application-layer AES-256-GCM encryption of third-party integration
  credentials and OAuth tokens, with keys held separately from the database.

**Access control and tenant isolation**
- Per-organisation row-level security on tenanted tables (`org_id` /
  `business_id`).
- Authentication enforced at the edge; cryptographic session validation server-side.
- Cross-tenant access checks (`requireBusinessAccess`) on routes accepting a
  business identifier.
- Administrative access restricted, protected by a separate secret and, where
  configured, a TOTP second factor (RFC 6238).
- Administrative actions on customer data written to a tamper-evident audit log
  retained for at least two years.

**Resilience and recovery**
- EU-region hosting and database (Frankfurt).
- Daily backups with point-in-time recovery on the production database.

**Application security**
- Content-Security-Policy, X-Frame-Options DENY, X-Content-Type-Options nosniff,
  Referrer-Policy, and Permissions-Policy security headers.
- Error-monitoring payloads scrubbed of secrets and Personal Data before leaving
  our boundary; authentication cookies dropped.
- AI cost / abuse controls: per-organisation quota gating and a global
  kill-switch; idempotency on payment and email side-effects.

**Data minimisation and AI**
- Only fields needed for analysis are ingested from staff data sources (no
  social-security numbers, no home addresses).
- AI output is advisory and visibly labelled; it does not constitute an automated
  decision producing legal or similarly significant effects (GDPR Art. 22).
- Zero Data Retention enabled at the AI provider for production data.

---

## Annex 4 — International transfer mechanism

For Sub-processors Processing Customer Personal Data outside the EU/EEA (currently
Anthropic and Resend, and incidental processing by Vercel/Sentry), the transfer
relies on the **Standard Contractual Clauses** (Commission Implementing Decision
(EU) 2021/914), incorporated by reference through each Sub-processor's data
processing agreement, with:

- **Module Two** (Controller-to-Processor) and/or **Module Three**
  (Processor-to-Processor) as applicable;
- the **docking clause** (Clause 7) where offered;
- **Option 2** (general written authorisation) for sub-processing under Clause 9;
- the supervisory authority of the Controller's EU establishment, or
  Integritetsskyddsmyndigheten (IMY) where the Controller is established in
  Sweden, as the competent supervisory authority under Clause 13.

Where a transfer impact assessment identifies a need for supplementary measures,
those measures (e.g. encryption, Zero Data Retention, minimisation) apply as set
out in Annex 3.

---

### Signatures

| | Controller (Customer) | Processor (ComandCenter AB) |
|---|---|---|
| Name | [ ] | [ ] |
| Title | [ ] | [ ] |
| Date | [ ] | [ ] |
| Signature | [ ] | [ ] |

---

*Reviewer checklist before first use (for counsel):*
- [ ] Confirm Processor entity name, org. nr, and registered address once the AB is registered.
- [ ] Confirm 48-hour breach-notification window is acceptable (some controllers ask for 24h).
- [ ] Confirm audit terms (frequency, cost allocation) are commercially acceptable.
- [ ] Confirm whether to attach the full SCC text as an exhibit vs incorporate by reference.
- [ ] Confirm liability interaction with the Agreement's cap.
- [ ] Decide acceptance mechanism: click-through at signup vs counter-signed PDF per customer (`docs/legal/customer-dpas/`).
