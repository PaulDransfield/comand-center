'use client'
// @ts-nocheck
// app/security/page.tsx — public vulnerability-disclosure and security posture page.
// Required by good security practice and referenced from the landing footer.

export const dynamic = 'force-dynamic'

export default function SecurityPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px', fontFamily: 'system-ui, sans-serif', color: '#1a1f2e' }}>
      <div style={{ marginBottom: 40 }}>
        <a href="/" style={{ fontSize: 13, color: '#6366f1', textDecoration: 'none' }}>← Back to CommandCenter</a>
      </div>

      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Security &amp; trust</h1>
      <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 40 }}>
        How we protect your data, where it lives, and how to report a security issue.
      </p>

      {/* Customer-facing FAQ — the questions prospects and customers actually ask. */}
      <div style={{ marginBottom: 44 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, color: '#1a1f2e' }}>Frequently asked</h2>
        {FAQ.map(f => (
          <div key={f.q} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid #eef0f4' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1f2e', marginBottom: 6 }}>{f.q}</div>
            <div style={{ fontSize: 14, lineHeight: 1.7, color: '#374151', whiteSpace: 'pre-line' as const }}>{f.a}</div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20, color: '#1a1f2e', paddingTop: 8 }}>The detail</h2>

      {SECTIONS.map(s => (
        <div key={s.title} style={{ marginBottom: 36 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, color: '#1a1f2e' }}>{s.title}</h2>
          <div style={{ fontSize: 15, lineHeight: 1.8, color: '#374151', whiteSpace: 'pre-line' as const }}>
            {s.body}
          </div>
        </div>
      ))}

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #e5e7eb', fontSize: 13, color: '#9ca3af' }}>
        ComandCenter AB · CommandCenter · security@comandcenter.se · comandcenter.se
      </div>
    </div>
  )
}

const FAQ = [
  {
    q: 'Where is my data stored?',
    a: `In the EU. Your database (Supabase) and the application (Vercel) both run in Frankfurt, Germany. The only data that ever leaves the EU is the specific text we send to our AI provider (Anthropic) to answer a request — that transfer is covered by Standard Contractual Clauses, and you can switch off storing your AI question text entirely in Settings → Data & Privacy.`,
  },
  {
    q: 'Can other restaurants see my data?',
    a: `No. Every record is tagged to your organisation and protected by row-level security (RLS) enforced in the database itself — not just in the app. One restaurant's account cannot read another's data, even in the event of an application bug.`,
  },
  {
    q: 'Is my data encrypted?',
    a: `Yes — in transit (TLS on every connection) and at rest (AES-256). On top of that, the API keys and access tokens for your connected systems (Fortnox, your POS, your scheduling tool) are encrypted again at the application layer before they're stored.`,
  },
  {
    q: 'Are you GDPR-compliant? Do you sign a DPA?',
    a: `Yes. You remain the controller of your data; we act as your processor and sign a Data Processing Agreement. You can export everything you hold with us as a file, or request deletion, self-service from Settings → Data & Privacy at any time.`,
  },
  {
    q: 'Who are your sub-processors?',
    a: `Supabase (database, EU), Vercel (hosting, EU), Anthropic (AI), Stripe (billing), and Resend (transactional email). Each is GDPR-covered and runs on SOC 2 Type II / ISO 27001-certified infrastructure. The full list with details is in our Privacy Policy, and we notify customers before adding or replacing any of them.`,
  },
  {
    q: 'Does the AI train on my data?',
    a: `No. We send only the data needed to answer a given request, and our AI provider does not use it to train models. If you'd rather we didn't even store the text of your questions, there's a one-click toggle for that in Settings → Data & Privacy.`,
  },
  {
    q: 'Are you SOC 2 / ISO 27001 certified?',
    a: `Not yet as a company — we're a focused team, and a formal information-security management system and external audit are on our roadmap as we scale. What we can point to today is that the platforms we build on — Supabase, Vercel, AWS, Stripe and Anthropic — are themselves SOC 2 Type II / ISO 27001 certified, so your data sits on certified infrastructure.`,
  },
  {
    q: 'What happens to my accounting data?',
    a: `We read a copy of it to produce insight — we never write back to, or replace, your accounting system. Your originals and your archival obligations under Bokföringslagen stay where they belong, in Fortnox or your bookkeeping system of record.`,
  },
  {
    q: 'Do you back up my data?',
    a: `Yes — daily backups with point-in-time recovery on the production database, so we can restore to a specific moment if needed.`,
  },
  {
    q: 'What if CommandCenter goes away?',
    a: `You're never locked in. You can export all of your data as a file at any time, and your source systems (Fortnox, your POS, your scheduling tool) remain your systems of record — CommandCenter is an analysis layer on top of them, not a replacement for them.`,
  },
]

const SECTIONS = [
  {
    title: 'Reporting a vulnerability',
    body: `If you discover a security issue in CommandCenter, please email security@comandcenter.se with as much detail as you can share. PGP is not currently available — for highly sensitive findings, email us first and we will arrange a secure channel.

We ask that you:

— Give us reasonable time to investigate and remediate before public disclosure (we aim for 90 days or sooner).
— Do not access, modify or destroy data that does not belong to you.
— Do not run denial-of-service, spam or social-engineering tests.
— Do not test against production customer data — use your own trial account.

We will:

— Acknowledge receipt within 2 business days.
— Provide a triage decision within 10 business days.
— Credit the reporter (with their consent) once the issue is resolved.

Good-faith researchers following these guidelines will not be subject to legal action from us.`
  },
  {
    title: 'Our security posture',
    body: `Data in transit: TLS 1.3 on every public endpoint, HTTP Strict Transport Security (HSTS) enabled with a one-year max-age across all subdomains.

Data at rest: AES-256 encryption provided by Supabase (Postgres) and AWS (underlying storage).

Application-layer encryption: third-party API keys and OAuth tokens are encrypted with AES-256-GCM before being written to the database, using keys held separately in our environment configuration.

Multi-tenant isolation: every customer-facing table has org_id / business_id columns and row-level security (RLS) policies. Admin access uses a separate service role not exposed to the browser.

Admin access: protected by a rotating secret and (where configured) a TOTP second factor (RFC 6238, compatible with all standard authenticator apps).

Audit logging: every administrative action against customer data is written to a tamper-evident audit log retained for at least two years.

Backups: Supabase point-in-time recovery enabled on the production project. Restore procedure tested periodically.

Hosting: Vercel EU region (Frankfurt) for the application layer, Supabase EU region (Frankfurt) for the database. No customer data leaves the EU except for AI processing through Anthropic, which is covered by Standard Contractual Clauses in our DPA.

Dependency hygiene: we ship only actively-maintained libraries and apply patches for critical CVEs in the dependency chain.`
  },
  {
    title: 'Sub-processors',
    body: `A full list of sub-processors is published in our Privacy Policy (section 5). We will notify customers at least 30 days before adding or replacing any sub-processor handling customer data.`
  },
  {
    title: 'Data subject rights',
    body: `For access, rectification, erasure or portability requests under GDPR Article 15–22, log into CommandCenter and use the Data & Privacy section of your account settings. This is self-service — you can export all your data as JSON and trigger a deletion request from there.

For questions that cannot be handled through the app, email security@comandcenter.se. We respond within 30 days.`
  },
  {
    title: 'Breach notification',
    body: `If we experience a personal-data breach that affects your organisation, we will notify you without undue delay — typically within 24 hours of discovery, and always within the 72-hour window set by GDPR Article 33.

Notifications will go to the billing email on file plus any additional contacts listed in your DPA.

Breaches that meet the reporting threshold will also be reported to Integritetsskyddsmyndigheten (IMY).`
  },
  {
    title: 'What we are not',
    body: `CommandCenter is not a replacement for your accounting system. Our reports are management information, not regulated financial statements. Your archival obligations under Bokföringslagen remain with your bookkeeping system of record (Fortnox, Björn Lundén, Visma etc).

CommandCenter does not provide tax, legal, or accounting advice. Insights generated by AI are advisory and should be reviewed before being acted on.`
  },
  {
    title: 'Compliance and certifications',
    body: `We do not yet hold ISO 27001 or SOC 2 certification. Our roadmap includes a formal ISMS and external penetration test before we scale past 50 customers.

We put a GDPR-compliant Data Processing Agreement in place with each sub-processor before any production customer data is processed, and rely on their certifications for the layers they provide:

— Supabase: SOC 2 Type II, HIPAA, GDPR.
— Vercel: SOC 2 Type II, GDPR.
— AWS (underlying Supabase): SOC 1/2/3, ISO 27001, PCI DSS, GDPR.
— Stripe: PCI DSS Level 1, SOC 1/2, GDPR.
— Anthropic: SOC 2 Type II, GDPR (US transfer covered by Standard Contractual Clauses).`
  },
]
