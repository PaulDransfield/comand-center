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

      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Security</h1>
      <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 40 }}>
        How we protect customer data and how to report a security issue.
      </p>

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
    body: `Data in transit: TLS 1.3 on every public endpoint, HSTS preload.

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

We rely on our sub-processors' certifications for the layers they provide:

— Supabase: SOC 2 Type II, HIPAA, GDPR (DPA on file).
— Vercel: SOC 2 Type II, GDPR (DPA on file).
— AWS (underlying Supabase): SOC 1/2/3, ISO 27001, PCI DSS, GDPR.
— Stripe: PCI DSS Level 1, SOC 1/2, GDPR.
— Anthropic: SOC 2 Type II, GDPR (SCCs on file).`
  },
]
