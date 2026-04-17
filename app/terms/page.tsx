'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

export default function TermsPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px', fontFamily: 'system-ui, sans-serif', color: '#1a1f2e' }}>
      <div style={{ marginBottom: 40 }}>
        <a href="/dashboard" style={{ fontSize: 13, color: '#6366f1', textDecoration: 'none' }}>← Back to app</a>
      </div>

      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Terms of Service</h1>
      <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 40 }}>
        Version 1.1 · Effective 17 April 2026 · Dransfield Invest AB
      </p>

      {[
        {
          title: '1. Agreement',
          body: `By signing up for and using CommandCenter ("the Service"), you agree to these Terms of Service. If you do not agree, do not use the Service.\n\nThe Service is provided by Dransfield Invest AB, a Swedish company. These terms form a binding agreement between you (or the company you represent) and Dransfield Invest AB.`
        },
        {
          title: '2. The Service',
          body: `CommandCenter is a software-as-a-service (SaaS) platform that helps restaurant groups track financial performance, staff costs, and operational data by connecting to third-party systems including Personalkollen, Fortnox, and POS systems.\n\nWe reserve the right to modify, suspend, or discontinue features of the Service at any time with reasonable notice.`
        },
        {
          title: '3. Account registration',
          body: `You must provide accurate, complete information when registering. You are responsible for maintaining the security of your account credentials. You must notify us immediately at paul@laweka.com if you suspect unauthorised access to your account.\n\nOne account may represent one organisation. You may add multiple restaurant locations (businesses) within one account.`
        },
        {
          title: '4. Acceptable use',
          body: `You may use the Service only for lawful business purposes. You must not:\n\n— Use the Service to store or transmit illegal content\n— Attempt to reverse-engineer, scrape, or copy the Service\n— Share your account credentials with third parties outside your organisation\n— Use the Service in a way that damages, disables, or impairs our infrastructure\n— Attempt to access data belonging to other organisations\n\nWe may suspend or terminate accounts that violate these terms without refund.`
        },
        {
          title: '5. Your data',
          body: `You retain ownership of all data you upload or sync to the Service. By using the Service you grant us a limited licence to process your data solely for the purpose of providing the Service to you.\n\nWe do not sell your data. We do not use your data for advertising. See our Privacy Policy at comandcenter.se/privacy for full details of how we handle your data.`
        },
        {
          title: '6. Third-party integrations',
          body: `The Service connects to third-party systems (Personalkollen, Fortnox, Ancon, Swess, and others) on your behalf using credentials you provide. You are responsible for ensuring you have the right to connect these systems and share their data with the Service.\n\nWe are not responsible for the availability, accuracy, or changes to third-party APIs. If a third-party system changes their API and this affects the Service, we will work to restore functionality as soon as reasonably possible.`
        },
        {
          title: '6a. Nature of the Service — management view, not regulated output',
          body: `CommandCenter is a management-information tool. The reports, dashboards, P&L views, forecasts, budgets, alerts and AI-generated insights produced by the Service are informational and not a substitute for a regulated financial statement, an audit, or a tax filing.\n\nYou remain responsible for your own accounting records under the Swedish Bokföringslag (1999:1078). Your accounting system (Fortnox, Björn Lundén, Visma or equivalent) is the system of record for bookkeeping purposes; CommandCenter holds a convenience mirror of that data for analytical purposes only.\n\nCommandCenter does not provide tax, legal, accounting, audit or investment advice. Insight produced by AI is advisory and should be reviewed by a qualified person before being acted on. No output of the Service constitutes an automated decision with legal effect for you or any third party (GDPR Article 22).`
        },
        {
          title: '7. Subscription and payment',
          body: `The Service is offered on a subscription basis. Current pricing is available at comandcenter.se/upgrade.\n\nMonthly subscriptions are billed on the same date each month. Annual subscriptions are billed once per year upfront.\n\nAll prices are in Swedish kronor (SEK) and include Swedish VAT (25%) where applicable.\n\nPayments are processed by Stripe. We do not store payment card details.\n\nSubscriptions auto-renew unless cancelled before the renewal date. You can cancel at any time from your account settings or by contacting paul@laweka.com.`
        },
        {
          title: '8. Refunds',
          body: `Monthly subscriptions: we do not offer refunds for partial months. If you cancel, your access continues until the end of the current billing period.\n\nAnnual subscriptions: if you cancel within 14 days of your annual payment and have not actively used the Service during that period, you may request a full refund by contacting paul@laweka.com.\n\nWe reserve the right to issue refunds at our discretion in exceptional circumstances.`
        },
        {
          title: '9. Service availability',
          body: `We aim to keep the Service available 24 hours a day, 7 days a week, but we do not guarantee uptime. Scheduled maintenance, third-party outages, and events outside our control may cause downtime.\n\nWe are not liable for losses resulting from Service unavailability. We will communicate planned maintenance in advance where possible.`
        },
        {
          title: '10. Limitation of liability',
          body: `To the fullest extent permitted by Swedish law, Dransfield Invest AB is not liable for:\n\n— Indirect, incidental, or consequential losses\n— Loss of profit, revenue, or data\n— Business interruption\n— Decisions made based on data or insights from the Service\n\nOur total liability to you for any claim arising from use of the Service is limited to the amount you paid us in the three months prior to the claim.`
        },
        {
          title: '11. Indemnification',
          body: `You agree to indemnify and hold harmless Dransfield Invest AB from any claims, losses, or damages arising from your use of the Service, your violation of these terms, or your violation of any third party's rights.`
        },
        {
          title: '12. Termination',
          body: `Either party may terminate the subscription at any time. We may terminate or suspend your account immediately if you breach these terms, fail to pay, or if we are required to do so by law.\n\nOn termination, your access to the Service ends. We will retain your data for 30 days after termination, during which you may request an export. After 30 days your data will be permanently deleted.`
        },
        {
          title: '13. Changes to terms',
          body: `We may update these terms from time to time. We will notify you of material changes by email and in-app notification at least 30 days before they take effect. Continued use of the Service after changes take effect constitutes acceptance of the new terms.`
        },
        {
          title: '14. Governing law',
          body: `These terms are governed by Swedish law. Any disputes will be resolved in Swedish courts, with Stockholm as the agreed venue.`
        },
        {
          title: '15. Contact',
          body: `Questions about these terms:\n\nDransfield Invest AB\npaul@laweka.com\ncomandcenter.se`
        },
      ].map(s => (
        <div key={s.title} style={{ marginBottom: 36 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 12, color: '#1a1f2e' }}>{s.title}</h2>
          <div style={{ fontSize: 15, lineHeight: 1.8, color: '#374151', whiteSpace: 'pre-line' }}>
            {s.body}
          </div>
        </div>
      ))}

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #e5e7eb', fontSize: 13, color: '#9ca3af' }}>
        Dransfield Invest AB · CommandCenter · paul@laweka.com · comandcenter.se
      </div>
    </div>
  )
}
