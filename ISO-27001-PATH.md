# ISO 27001 certification — practical path for CommandCenter

> Drafted 2026-05-11 · honest founder's guide, not a sales pitch from a consultancy

ISO 27001 is the international standard for Information Security Management Systems (ISMS). Certification proves to customers (and to bigger restaurant groups doing procurement reviews) that you have an externally-audited security program — not just claims on a website.

This document covers what it actually means, what it costs in money and time, who to hire, and when to start. Numbers are 2026 Swedish/EU market rates for an early-stage SaaS.

---

## What ISO 27001 actually is

It's not a checklist of technical controls. It's a **management system** — a framework that says "you must have a documented process for identifying risks, treating them, monitoring them, and improving over time."

The standard has two parts:

1. **ISO 27001:2022 (main standard)** — the management-system requirements. ~12 clauses covering scope, leadership, risk assessment, controls, monitoring, internal audit, management review, continuous improvement.

2. **ISO 27002:2022 (Annex A controls)** — 93 specific controls organised into four themes (organisational, people, physical, technological). You don't have to implement all 93 — you implement the ones your risk assessment says are relevant, and document why you skipped the others.

The certificate itself is awarded after a **two-stage external audit**:
- **Stage 1**: documentation review (the auditor reads your ISMS docs)
- **Stage 2**: on-site or remote evidence audit (the auditor checks you actually do what your docs say)

The certificate is valid for **3 years**, with **annual surveillance audits** during years 2 and 3, then a **recertification audit** in year 4.

---

## What it does NOT mean

Common misconceptions worth being honest about:

- **It doesn't mean "we've never had a security incident."** It means you have a documented, audited process for handling incidents when they happen.
- **It doesn't replace a penetration test.** Auditors check process; pentesters check exploitability. You generally need both — pentest evidence feeds the ISMS as risk-treatment input.
- **It doesn't audit code.** No one reads your `lib/*.ts` files. They audit policies, evidence trails, training records, access logs, supplier reviews.
- **It doesn't make you SOC 2 compliant.** SOC 2 is the US-flavoured equivalent. Some controls overlap (~70%) but the certification frameworks are different. EU buyers ask for ISO 27001; US buyers ask for SOC 2.

---

## When CommandCenter should pursue it

**Don't do it now.** Honest assessment:

- Single-founder operation
- ~4 businesses on the platform (mostly beta)
- No employees yet → "people controls" are trivial
- Company entity not yet registered → can't sign the certificate's required contracts

**Trigger to start the project:**
- A paying customer asks for it in writing (large restaurant group with procurement)
- You hire your second employee (people controls become real)
- You cross ~25 paying customers OR ~500k SEK MRR
- You start selling into corporate / enterprise restaurant groups (Scandic, Nordic Choice, large franchises)

**Realistic timeline once you start: 9–14 months end-to-end** before you hold a certificate. That breaks down as:
- 2–3 months: gap assessment + initial scoping
- 4–6 months: implementing the ISMS, writing policies, building evidence
- 1 month: internal audit + management review
- 1 month: Stage 1 external audit + remediation
- 1 month: Stage 2 external audit + certification issuance

The ISMS must be **operating** for at least 2–3 months before Stage 2 — so even with perfect execution, you can't compress below ~8 months.

---

## Cost — realistic 2026 EU figures

| Line item | Range (SEK) | Notes |
|---|---|---|
| Gap analysis (external consultancy) | 40,000 – 80,000 | 1-week engagement, optional but standard |
| ISMS toolkit / GRC platform | 0 – 50,000 / year | Vanta, Drata, Sprinto, Secureframe, or homegrown spreadsheets. For solo founder, Vanta-style automation is worth the cost |
| Consultant (fractional CISO / ISO 27001 lead) | 150,000 – 400,000 | 3–6 months part-time engagement at SEK 1,500–2,500/hour. Optional but cuts the timeline in half if you're solo. |
| External penetration test | 60,000 – 150,000 | Required as risk-treatment evidence under control A.8.8 / A.8.29. Choose a firm with public reputation (Hacker One, Truesec, Defentry). |
| Stage 1 + Stage 2 audit fees | 80,000 – 150,000 | Pay the certification body (BSI, DNV, Bureau Veritas, KIWA, Intertek) |
| Annual surveillance audit (years 2 + 3) | 40,000 – 70,000 / year | Cheaper than the initial certification audit |
| Recertification audit (year 4) | 70,000 – 120,000 | Full audit again |
| Internal time | n/a | Founder time: ~30% for 6 months. With a consultant, drops to ~15%. |

**Total realistic spend, year 1**: 350,000 – 650,000 SEK (EUR 30,000 – 60,000)
**Total realistic spend, years 2–4**: ~150,000 SEK / year (audit fees + GRC platform)

If you cheap out (no consultant, homegrown docs, basic pentest): probably ~250,000 SEK year 1. The risk is failing Stage 1 and having to pay for re-audit, plus delays of 6+ months.

---

## What you'd need to do — concrete tasks

The ISMS scope for CommandCenter would cover: **the cloud-hosted SaaS service and its supporting development, operations, and customer-success processes.** Everything else (your laptop, your home office, your dog) is out of scope.

**Phase 1 — Foundation (months 1–3)**

1. **Register the company** (you can't sign the certification contract as a sole trader without complications)
2. **Information Security Policy** — top-level document, ~3 pages. The policy your CEO (you) signs and reviews annually.
3. **Risk Assessment Methodology** — how you'll identify and rate risks. Standard: ISO 31000 inspired, likelihood × impact on confidentiality, integrity, availability.
4. **Statement of Applicability (SoA)** — which of the 93 Annex A controls apply to you, and why. The auditor reads this carefully.
5. **Asset register** — every system, service, data store you depend on. Supabase, Vercel, Anthropic, GitHub, Stripe, Resend, Fortnox API, Personalkollen API, your laptop, etc.

**Phase 2 — Controls (months 3–8)**

Implement and document the controls that came out of Phase 1 risk assessment. For an EU SaaS like CommandCenter, the most relevant Annex A controls are:

- **A.5 Information security policies**: top-level + sub-policies (access control, acceptable use, supplier management, incident management, backup)
- **A.6 People controls**: confidentiality agreements with contractors, background screening if you hire, training records
- **A.7 Physical controls**: minimal — laptop policy, clean-desk, equipment disposal
- **A.8 Technological controls**: this is where ~50% of your evidence sits. Access control, cryptography (you already have this), system architecture, vulnerability management, monitoring, secure development lifecycle, supplier security (the OAuth confirmation modal you just shipped is supplier-security evidence)
- Plus operational records: change management (PRs and deployment logs), incident management (incident playbook + a log of incidents and post-mortems), supplier reviews (annual review of Supabase / Vercel / Anthropic), backup tests (quarterly restore drill)

**Phase 3 — Operation (months 6–9)**

The ISMS must be **operating** — meaning logs and records exist — for at least 2–3 months before Stage 2.

- Run an **internal audit** (yourself, or a third party — auditor must be independent of the process being audited)
- Hold a **management review** meeting (yes, even if "management" is one person — minutes required)
- Treat any non-conformities raised
- Collect evidence: training records, incident logs, supplier review notes, backup test results, access-review records

**Phase 4 — Certification (months 9–12)**

- Engage a **certification body** (not just any consultancy — UKAS or SWEDAC-accredited; BSI, DNV, Bureau Veritas are the big names in Sweden)
- **Stage 1**: 1-2 day documentation review. Auditor flags anything in your docs that's missing or contradictory. You fix.
- **Stage 2**: 3-5 day evidence audit. Auditor interviews you, asks for evidence. Outcome: certificate issued, OR a Non-Conformity Report (NCR) which you have ~3 months to close.
- Certificate is valid 3 years.

---

## Cheaper alternatives that get you 80% of the customer trust

**SOC 2 Type II** isn't cheaper but is more common in US sales conversations.

**Cyber Essentials Plus (UK)** — much cheaper (~30,000 SEK), gets you 50% of the credibility. Recognised in UK and some EU contexts.

**Vanta-style continuous compliance** — automated platform that monitors your stack and produces evidence in real time. NOT a certification, but produces SOC 2 / ISO 27001 evidence packs ready for an external auditor. Most Y Combinator-stage SaaS uses this. Cost: ~30k SEK / year.

**A signed Customer DPA + an explicit security page + sub-processor list** — what we already have, plus the DPA template I just drafted. For SMB restaurant customers, this is usually enough. The big restaurant groups (50+ locations) will start asking for ISO 27001 / SOC 2 — that's the trigger to start the project.

**Public bug bounty (HackerOne / Intigriti)** — adds external scrutiny visibility for ~50k SEK / year + bounty payouts. Often more impressive to security-aware customers than ISO 27001 because it produces named CVE-class findings.

---

## My recommendation for CommandCenter today

**Today (early beta, 4 businesses):** keep the existing `/security` page accurate, ship the customer DPA template (after counsel review), have a documented incident-response process even if it's a one-pager. Don't start ISO 27001.

**At ~10 paying customers:** sign up for a Vanta-style platform (Vanta itself, or the EU-headquartered alternative Sprinto). It costs ~25-30k SEK/year and gives you the underlying evidence pipeline you'd need for a certification later, plus a security-trust portal customers can self-serve.

**At ~25 paying customers OR a customer requests it in writing:** start the gap analysis. Engage a fractional CISO / ISO 27001 consultant (Truesec, Defentry, Secureframe ISO 27001 services, or a freelancer from the Konsultpoolen network). Plan 9-12 month timeline.

**Don't:** pay a "ISO 27001 in 90 days" consultancy. They exist; the audit either fails Stage 1 or you end up with a certificate covering a paper ISMS that doesn't reflect what your team actually does. The auditor catches it on the year-2 surveillance audit.

---

## Documents this would add to the codebase

If you commit to ISO 27001, you'd end up with these new files in the repo (or a separate `compliance/` private repo):

- `compliance/01-information-security-policy.md`
- `compliance/02-risk-assessment-methodology.md`
- `compliance/03-statement-of-applicability.md`
- `compliance/04-asset-register.md`
- `compliance/05-access-control-policy.md`
- `compliance/06-incident-response-playbook.md`
- `compliance/07-supplier-security-review.md`
- `compliance/08-backup-and-recovery-policy.md`
- `compliance/09-secure-development-lifecycle.md`
- `compliance/10-business-continuity-plan.md`
- `compliance/evidence/` — operational logs, training records, incident notes, audit findings

For a solo founder, this is significant — and a real reason not to start until the company growth justifies the effort.

---

## Useful resources

- **ISO 27001:2022 standard** — buy from `iso.org` or `sis.se` (Swedish national standards body). About 1,500 SEK.
- **Free ISO 27001 toolkit templates** — `iso27001security.com`, `advisera.com` (commercial — about €500 for a usable template pack).
- **GRC platforms** — Vanta, Drata, Sprinto, Secureframe, Tugboat Logic. Free demos. Sprinto and Secureframe have stronger EU presence.
- **Swedish certification bodies** — BSI Sverige, DNV, Bureau Veritas Sverige, KIWA Inspecta. Get quotes from at least two.
- **Lawyer for the entity + DPA work** — Delphi, Mannheimer Swartling, Setterwalls (all named in `LEGAL-OBLIGATIONS.md`).
- **Konsultpoolen / consultant network** — search "ISO 27001 lead implementer Sverige" on LinkedIn for freelancers at ~1,500-2,200 SEK/hour.

---

## TL;DR for a customer conversation

If a customer asks today:

> "We're not ISO 27001 certified yet — we're an early-stage product and the cost is hard to justify until we have more enterprise customers. What we do have: all data in the EU, AES-256 encryption everywhere including third-party tokens, multi-tenant database isolation enforced at the Postgres layer, daily backups with point-in-time recovery, and we run on Supabase / Vercel / AWS / Anthropic — all of which are SOC 2 Type II or higher certified. Our security posture and full sub-processor list is published at comandcenter.se/security, and we'll provide a signed DPA naming us as your processor."

If they push for a timeline:

> "We're committing to start the ISO 27001 project once we hit [25 paying customers / a specific revenue line]. That's roughly a 12-month effort to certification once we start. If your procurement requires it sooner than that, we can discuss a specific commitment as part of the engagement."

Honesty earns more enterprise trust than false claims.
