// @ts-nocheck
// app/changelog/page.tsx
//
// Public changelog â€” shows what's been built and when.
// Builds trust with beta users and gives them visibility into progress.

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Changelog' }

const ENTRIES = [
  {
    version: '0.8.0',
    date:    '2026-03-26',
    tag:     'Beta',
    items: [
      { type: 'new',    text: 'Full NotebookLM-equivalent with source grounding, citations, and confidence scores' },
      { type: 'new',    text: 'Audio overview â€” generate Deep Dive, Brief, Debate, and Critique formats' },
      { type: 'new',    text: 'Multi-source synthesis â€” compare, find contradictions, synthesise across documents' },
      { type: 'new',    text: 'Global search (âŒ˜K) across all notebooks and sources' },
      { type: 'new',    text: 'Stripe billing â€” Starter and Pro plans with customer portal' },
      { type: 'new',    text: 'Admin dashboard with 2FA, impersonation consent, and immutable audit log' },
      { type: 'new',    text: 'Support widget â€” ticket submission, live chat, knowledge base, self-service diagnostics' },
      { type: 'new',    text: 'Integration health monitoring with Slack/SMS alerts' },
    ],
  },
  {
    version: '0.7.0',
    date:    '2026-03-18',
    tag:     'Alpha',
    items: [
      { type: 'new',    text: 'Multi-business dashboard with aggregate group P&L view' },
      { type: 'new',    text: 'âŒ˜K business switcher with search' },
      { type: 'new',    text: 'Export center â€” PDF, Word, Excel, CSV with scheduled delivery' },
      { type: 'new',    text: 'Invoice automation workflow â€” 8-step processing pipeline' },
      { type: 'new',    text: 'Fortnox OAuth integration with encrypted credential storage' },
      { type: 'new',    text: 'Caspeco and Ancon integrations' },
      { type: 'improve','text': 'Semantic chunking for better citation accuracy' },
    ],
  },
  {
    version: '0.6.0',
    date:    '2026-03-16',
    tag:     'Alpha',
    items: [
      { type: 'new',    text: 'Live cost tracker with real-time KPI updates' },
      { type: 'new',    text: 'AI chat with source citations and Swedish restaurant context' },
      { type: 'new',    text: 'Document upload â€” PDF, DOCX, XLSX, CSV, images' },
      { type: 'new',    text: 'Supabase multi-tenant architecture with RLS' },
      { type: 'new',    text: 'BankID authentication (Signicat integration)' },
      { type: 'new',    text: 'GDPR privacy policy and consent framework' },
    ],
  },
]

const TYPE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  new:     { bg: 'var(--green-lt)',  color: 'var(--green)',  label: 'New'     },
  improve: { bg: 'var(--blue-lt)',   color: 'var(--blue)',   label: 'Improved'},
  fix:     { bg: 'var(--amber-lt)', color: 'var(--amber)', label: 'Fixed'   },
}

export default function ChangelogPage() {
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 24px 80px' }}>

      <div style={{ marginBottom: 36 }}>
        <h1 style={{ fontFamily: 'var(--display)', fontSize: 32, fontWeight: 300, fontStyle: 'italic', color: 'var(--navy)', marginBottom: 6 }}>
          Changelog
        </h1>
        <p style={{ fontSize: 14, color: 'var(--ink-3)', lineHeight: 1.6 }}>
          A record of what's been built. Updated after every significant release.
        </p>
      </div>

      {ENTRIES.map((entry, i) => (
        <div key={entry.version} style={{ marginBottom: 40, display: 'flex', gap: 24 }}>

          {/* Timeline line */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: i === 0 ? 'var(--navy)' : 'var(--border-d)', flexShrink: 0, marginTop: 5 }} />
            {i < ENTRIES.length - 1 && (
              <div style={{ width: 2, flex: 1, background: 'var(--border)', marginTop: 6 }} />
            )}
          </div>

          {/* Content */}
          <div style={{ flex: 1, paddingBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>
                v{entry.version}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: i === 0 ? 'var(--amber-lt)' : 'var(--parchment)', color: i === 0 ? 'var(--amber)' : 'var(--ink-4)', border: `1px solid ${i === 0 ? 'rgba(122,72,0,.2)' : 'var(--border)'}` }}>
                {entry.tag}
              </span>
              <span style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)', marginLeft: 'auto' }}>
                {entry.date}
              </span>
            </div>

            <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {entry.items.map((item, j) => {
                const style = TYPE_STYLES[item.type] ?? TYPE_STYLES.new
                return (
                  <li key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 5, background: style.bg, color: style.color, textTransform: 'uppercase', letterSpacing: '.06em', flexShrink: 0, marginTop: 2 }}>
                      {style.label}
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>{item.text}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      ))}

    </div>
  )
}
