'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px', fontFamily: 'Georgia, serif', color: '#1a1f2e' }}>
      <div style={{ marginBottom: 40 }}>
        <a href="/dashboard" style={{ fontSize: 13, color: '#6366f1', textDecoration: 'none', fontFamily: 'system-ui' }}>← Back to app</a>
      </div>

      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 40, fontFamily: 'system-ui' }}>
        Version 1.2 · Last updated 19 April 2026 · CommandCenter (Dransfield Invest AB)
      </p>

      {[
        {
          title: '1. Who we are',
          body: `CommandCenter is operated by Dransfield Invest AB, a Swedish company. We provide restaurant management software that helps restaurant groups track financial performance, staff costs and revenue. Our registered address and contact details are available at comandcenter.se.

If you have any questions about this policy or your data, contact us at paul@laweka.com.`
        },
        {
          title: '2. What data we collect',
          body: `We collect the following categories of data:

Account data: Your name, email address, and organisation name when you register.

Business data: Financial information you enter or sync — including revenue, staff costs, food costs and P&L data for your restaurants.

Staff data: Employee names, working hours, shift costs and department information synced from Personalkollen, Caspeco or other connected HR systems. This data originates from your own HR systems and is processed on your behalf.

Integration credentials: API keys and OAuth tokens for third-party services you connect (Personalkollen, Fortnox, Ancon, Swess). These are encrypted at rest.

Usage data: Pages visited, features used, and error logs to help us improve the product.

Technical data: IP address, browser type and device information collected automatically when you use the service.`
        },
        {
          title: '3. Legal basis for processing',
          body: `We process your data under the following legal bases (GDPR Article 6):

Contract performance: To provide the service you have subscribed to, including syncing integrations, generating reports and forecasts.

Legitimate interests: To improve our product, prevent fraud, and ensure security of the platform.

Legal obligation: To comply with Swedish and EU law, including accounting regulations and tax requirements.

Consent: For optional features such as marketing emails. You may withdraw consent at any time.`
        },
        {
          title: '4. How we use your data',
          body: `We use your data to:
— Provide and improve the CommandCenter service
— Sync data from connected integrations (Personalkollen, Fortnox, etc.)
— Generate financial reports, forecasts and alerts
— Send service notifications (new features, billing, security alerts)
— Comply with legal obligations
— Prevent fraud and ensure platform security

AI-generated insight: parts of the product — anomaly explanations, weekly briefings, scheduling recommendations, budget analysis and the AI assistant — are produced by a third-party large language model (Anthropic Claude). In line with EU Regulation 2024/1689 (AI Act) Article 52, every AI-generated output in the app is visibly labelled. AI output is advisory; it is not an automated decision with legal effect for you or your staff (GDPR Article 22).

We do not sell your data. We do not use your data for advertising.`
        },
        {
          title: '5. Data sharing and sub-processors',
          body: `We share data with the following sub-processors. All are bound by GDPR-compliant Data Processing Agreements and process data only on our instruction.

DATABASE — Supabase Inc.
Role: Database infrastructure and authentication
Data: All customer and business data stored in our platform
Location: EU (Frankfurt, Germany) — AWS eu-central-1
Compliance: SOC 2 Type II certified, GDPR compliant, DPA signed
Privacy: supabase.com/privacy

HOSTING — Vercel Inc.
Role: Application hosting and edge network
Data: Request logs, application code execution
Location: EU regions with EU data processing addendum
Compliance: SOC 2 Type II, GDPR compliant
Privacy: vercel.com/legal/privacy-policy

AI PROCESSING — Anthropic PBC
Role: AI assistant features, anomaly explanations, weekly briefings, budget suggestions, scheduling recommendations.
Data: Aggregated business data — revenue totals, staff-hour totals, cost breakdowns — is sent to Anthropic to generate insight and written commentary. Individual staff personal data (names, employee IDs) is not routinely included; business/financial figures are. We request Zero Data Retention so Anthropic does not retain inputs or outputs beyond the processing window.
Location: USA. Standard Contractual Clauses are in place as the Chapter V transfer mechanism.
Privacy: anthropic.com/privacy · anthropic.com/legal/commercial-terms

PAYMENT PROCESSING — Stripe Inc.
Role: Subscription billing and payment processing
Data: Billing information only — payment card details never stored by us
Location: EU with EU data processing addendum
Privacy: stripe.com/privacy

ERROR MONITORING — Sentry (Functional Software, Inc.)
Role: Production error and crash reporting — stack traces, breadcrumbs, session replay on error only.
Data: Stack traces, URL of the failing page, user id and organisation id (used for error-by-customer filtering). Sensitive strings (auth cookies, bearer tokens, API keys) are scrubbed by a beforeSend hook before transmission. Customer business data and AI question text never leave our server via Sentry.
Location: EU region (ingest.de.sentry.io). Standard Contractual Clauses are in place for any incidental US transfer.
Privacy: sentry.io/privacy

TRANSACTIONAL EMAIL — Resend (Resend, Inc.)
Role: Delivery of transactional emails — account verification, password reset, weekly business digest, alert notifications, onboarding welcome.
Data: Recipient email address, subject line, HTML body (may include business name, revenue figures, staff-cost metrics, alert text). No raw staff personal data is transmitted in email bodies.
Location: USA. Standard Contractual Clauses are in place as the Chapter V transfer mechanism.
Privacy: resend.com/legal/privacy-policy

INTEGRATION PARTNERS — data synced on your explicit instruction only
Personalkollen (Sweden): Staff scheduling and hours data
Fortnox (Sweden): Accounting and invoice data
Ancon / Swess / Caspeco: POS and revenue data

LEGAL DISCLOSURE — We may disclose data if required by Swedish law, court order or regulatory authority. We will notify you unless legally prohibited from doing so.

A full and current list of sub-processors is available on request at paul@laweka.com.`
        },
        {
          title: '6. Data retention',
          body: `We retain your data for the following periods:

Account and business data: For the duration of your subscription plus 12 months after cancellation, to allow reactivation and comply with accounting law.

Staff data synced from integrations: Up to 3 years of historical data to support year-on-year comparisons and forecasting.

Billing records: 7 years as required by Swedish accounting law (Bokföringslagen).

Usage logs: 90 days.

After the retention period, data is permanently deleted from all systems including backups.`
        },
        {
          title: '7. Your rights under GDPR',
          body: `As a data subject you have the following rights:

Right of access: Request a copy of all personal data we hold about you.

Right to rectification: Request correction of inaccurate data.

Right to erasure: Request deletion of your data (subject to legal retention obligations).

Right to data portability: Receive your data in a machine-readable format (JSON).

Right to restrict processing: Request that we limit how we use your data.

Right to object: Object to processing based on legitimate interests.

Right to withdraw consent: Where processing is based on consent, withdraw it at any time.

To exercise any of these rights, use the Data & Privacy section in your account settings, or contact paul@laweka.com. We will respond within 30 days.`
        },
        {
          title: '8. Security',
          body: `We protect your data with:
— Encryption at rest and in transit (TLS 1.3)
— Row-level security on all database tables
— Encrypted storage of API keys and credentials
— Access controls limiting staff access to production data
— Regular security reviews

Despite these measures, no system is completely secure. If you discover a security issue, please report it to paul@laweka.com.`
        },
        {
          title: '9. Cookies',
          body: `We use the following cookies:

Authentication: A session cookie to keep you logged in. This is strictly necessary and cannot be disabled.

Preferences: We store your selected restaurant and UI preferences in localStorage. No tracking or advertising cookies are used.

We do not use Google Analytics, Facebook Pixel or any third-party tracking cookies.`
        },
        {
          title: '10. International transfers',
          body: `Your data is stored in EU data centres (Supabase Frankfurt region). Where data is processed outside the EU (e.g. Anthropic AI in the USA), we ensure appropriate safeguards are in place including Standard Contractual Clauses as required by GDPR Chapter V.`
        },
        {
          title: '11. Children',
          body: `CommandCenter is a business software product intended for use by adults. We do not knowingly collect data from anyone under 18. If you believe a minor has created an account, contact us immediately.`
        },
        {
          title: '12. Changes to this policy',
          body: `We may update this policy from time to time. We will notify you of significant changes by email and in-app notification at least 30 days before they take effect. The current version is always available at comandcenter.se/privacy.`
        },
        {
          title: '13. Complaints',
          body: `If you are unhappy with how we handle your data, you have the right to lodge a complaint with the Swedish Authority for Privacy Protection (Integritetsskyddsmyndigheten, IMY) at imy.se.

We would always prefer to resolve concerns directly — please contact paul@laweka.com first.`
        },
      ].map(section => (
        <div key={section.title} style={{ marginBottom: 36 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, color: '#1a1f2e' }}>{section.title}</h2>
          <div style={{ fontSize: 15, lineHeight: 1.8, color: '#374151', whiteSpace: 'pre-line', fontFamily: 'system-ui' }}>
            {section.body}
          </div>
        </div>
      ))}

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #e5e7eb', fontSize: 13, color: '#9ca3af', fontFamily: 'system-ui' }}>
        Dransfield Invest AB · CommandCenter · paul@laweka.com · comandcenter.se
      </div>
    </div>
  )
}
