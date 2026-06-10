# Enterprise-readiness checklist

> Practical, prioritised list of what to have in place before chasing bigger / chain / enterprise customers — the ones who run a formal vendor-security review before signing.
> **Not legal advice.** Retain a Swedish data-protection lawyer (Delphi, Mannheimer Swartling, Setterwalls) for the contractual items. See `LEGAL-OBLIGATIONS.md` for the underlying detail.
> Last updated: 2026-06-10.

The rule of thumb: **P0 before any paying customer · P1 before your first chain/enterprise deal · P2 when you're genuinely upmarket.** Don't spend on P2 (e.g. the Supabase Team plan or a SOC 2 audit) until a specific deal needs it.

---

## Already in place (don't redo)

- [x] **EU-only hosting** — Supabase (DB) + Vercel (app) both in Frankfurt.
- [x] **Encryption** — TLS in transit, AES-256 at rest; integration tokens encrypted at the app layer.
- [x] **Tenant isolation** — `org_id`/`business_id` + row-level security on customer tables; service role not exposed to the browser. (RLS hardened + every Supabase security-advisor finding cleared, 2026-06-10.)
- [x] **Backups** — daily + point-in-time recovery on the production project.
- [x] **Public privacy policy, terms, and security page** + a customer security FAQ (`/security`).
- [x] **GDPR self-service** — data export (JSON) + deletion request + AI-question-text opt-out in Settings → Data & Privacy.

---

## P0 — Foundational (before any paying customer; blockers for everything contractual)

- [ ] **Register the legal entity (ComandCenter AB).** This is the gating item — you cannot sign a DPA, countersign sub-processor DPAs, or join the Fortnox developer program as a non-entity. Everything below with a signature depends on it. *(Was pending as of 2026-06.)*
- [ ] **Customer DPA template** — a signable Data Processing Agreement that names you as processor, lists sub-processors, and covers SCCs for the Anthropic transfer. Lawyer-reviewed. Sign one with every customer *before* their data enters the system.
- [ ] **Countersign sub-processor DPAs** — Supabase, Vercel, Anthropic, Stripe, Resend. All are publicly available; file the signed copies.
- [ ] **Records of Processing (GDPR Art. 30)** — a maintained register of what personal data you process, why, legal basis, retention, and recipients. A spreadsheet is fine to start.
- [ ] **Verify the public posture claims are TRUE before anyone leans on them in a review** — specifically: application-layer token encryption, the "tamper-evident audit log retained ≥2 years", and admin TOTP 2FA. If any isn't fully real yet, either make it real or soften the page. Don't get caught overclaiming.

## P1 — Expected by chain/enterprise procurement (before your first such deal)

- [ ] **Security questionnaire pack** — a pre-filled standard questionnaire (SIG Lite or CAIQ) or a tight 2-page "Security & data" one-pager built from the FAQ, so you can answer due-diligence in hours, not weeks.
- [ ] **Data-breach runbook** — documented steps to assess + notify affected customers without undue delay and report to IMY within the GDPR 72-hour window. Do one tabletop run-through.
- [ ] **Sub-processor change process** — the 30-day advance-notice commitment (already stated on the page) backed by an actual notification mechanism (email list / changelog).
- [ ] **Access control hygiene, documented** — admin MFA enforced, secret rotation schedule, least-privilege, and a short written record of who has production/database access and why.
- [ ] **Tested backup restore** — actually perform a PITR restore to a scratch project and write down the RTO/RPO you observed. "Backups exist" ≠ "restore works."
- [ ] **AI transparency / EU AI Act note** — a one-page assessment classifying your use as limited-risk, what data goes to the model, and the opt-out. The Act's transparency duties apply to you.
- [ ] **Vulnerability management** — dependency scanning (Dependabot/`npm audit` in CI) + a written patch SLA for critical CVEs.

## P2 — Genuinely upmarket (only when a deal or scale justifies the spend)

- [ ] **Supabase Team plan ($599/mo)** — buy it when a customer's procurement asks for the SOC 2 report, or when you need dashboard SSO/RBAC for a team. Not before.
- [ ] **External penetration test** — before scaling past ~50 customers, or when a deal requires a recent pentest report.
- [ ] **Formal ISMS → ISO 27001 / SOC 2** — the real certification path (months + meaningful cost). Only pursue when enterprise pipeline justifies it; until then, ride your providers' certs.
- [ ] **Incident response plan + on-call**, and a **business continuity / disaster recovery** document.
- [ ] **Cyber-insurance** review, and a NIS2 applicability check (only once you near the "important entity" threshold — not yet).

## Provider-specific gates (independent of the tiers above)

- [ ] **Fortnox developer-program certification** — required before production use of their API. Needs the registered entity.
- [ ] **Personalkollen / Caspeco** commercial agreements current and signed.

---

### How to use this

Work top-down. The single highest-leverage move right now is **registering the AB** — it unblocks every DPA and the Fortnox program in one go, and it does more for "are you a serious, secure vendor?" than any platform upgrade. The Supabase Team plan and a SOC 2 audit are real but late — they answer questions that only your *largest* prospects will ask, and only once you're in front of them.
