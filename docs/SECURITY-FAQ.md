# Security & data — customer FAQ (paste-ready)

> Mirrors the public page at comandcenter.se/security. Copy any block straight into a sales email or a customer's security questionnaire. Keep this in sync with `app/security/page.tsx`.

## Short blurb (drop into an email)

> Your data stays in the EU (database and app both hosted in Frankfurt), encrypted in transit and at rest, and isolated per-restaurant with database-level row-level security. We act as your GDPR data processor and sign a DPA; you can export or delete everything self-service at any time. Our infrastructure providers (Supabase, Vercel, AWS, Stripe, Anthropic) are SOC 2 Type II / ISO 27001 certified. Full detail: https://comandcenter.se/security

## Q&A

**Where is my data stored?**
In the EU. Your database (Supabase) and the application (Vercel) both run in Frankfurt, Germany. The only data that leaves the EU is the specific text we send to our AI provider (Anthropic) to answer a request — covered by Standard Contractual Clauses, and you can switch off storing AI question text entirely in Settings → Data & Privacy.

**Can other restaurants see my data?**
No. Every record is tagged to your organisation and protected by row-level security enforced in the database itself, not just the app — so one restaurant cannot read another's data even in the event of an application bug.

**Is my data encrypted?**
Yes — in transit (TLS) and at rest (AES-256). The API keys/tokens for your connected systems (Fortnox, POS, scheduling) are encrypted again at the application layer before storage.

**Are you GDPR-compliant? Do you sign a DPA?**
Yes. You stay the controller; we are your processor and sign a Data Processing Agreement. Export or delete everything self-service from Settings → Data & Privacy.

**Who are your sub-processors?**
Supabase (database, EU), Vercel (hosting, EU), Anthropic (AI), Stripe (billing), Resend (email). Each is GDPR-covered and runs on SOC 2 Type II / ISO 27001-certified infrastructure. Full list in the Privacy Policy; we notify before adding or replacing any.

**Does the AI train on my data?**
No. We send only what's needed to answer a request, and our AI provider does not use it to train models. You can turn off storing your question text in Settings.

**Are you SOC 2 / ISO 27001 certified?**
Not yet as a company — a formal ISMS and external audit are on the roadmap as we scale. The platforms we build on (Supabase, Vercel, AWS, Stripe, Anthropic) are SOC 2 Type II / ISO 27001 certified, so your data sits on certified infrastructure.

**What happens to my accounting data?**
We read a copy for analysis only — we never write back to or replace your accounting system. Your originals and your Bokföringslagen archival obligations stay in Fortnox / your bookkeeping system.

**Do you back up my data?**
Daily backups with point-in-time recovery on the production database.

**What if CommandCenter goes away?**
No lock-in. Export all your data as a file at any time; your source systems (Fortnox, POS, scheduling) remain your systems of record. CommandCenter is an analysis layer, not a replacement.

**How do I report a security issue?**
security@comandcenter.se — see comandcenter.se/security for our disclosure policy.

---

## Accuracy notes (internal — keep honest)

- Do NOT claim CommandCenter holds SOC 2 / ISO 27001 — we don't. Only the sub-processors do. The page is deliberately honest about this.
- Company entity: confirm "ComandCenter AB" is registered before relying on the AB name in a signed DPA (company formation was pending as of 2026-06 — see `project_company_formation_pending`). A DPA needs a real legal entity.
- "Application-layer token encryption" and "tamper-evident audit log" claims live on the public page already — verify they're fully true before a formal security review leans on them.
