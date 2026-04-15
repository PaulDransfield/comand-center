// @ts-nocheck
// lib/analytics/posthog.ts
//
// PostHog event tracking â€” records user behavior for analytics.
// PostHog is open-source, GDPR-compliant, and has a generous free tier.
//
// Setup:
//   1. Create account at posthog.com (free for up to 1M events/month)
//   2. Add NEXT_PUBLIC_POSTHOG_KEY to .env.local
//   3. Import { track } and call it on key user actions
//
// Events we track (privacy-safe â€” no personal data in event properties):
//   - page_view
//   - signup, login, logout
//   - business_added, business_switched
//   - document_uploaded, document_removed
//   - chat_sent, chat_citation_clicked
//   - export_generated, export_downloaded
//   - upgrade_clicked, upgrade_completed, upgrade_cancelled
//   - integration_connected, integration_failed
//   - trial_expired_banner_shown

'use client'

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type EventName =
  | 'page_view'
  | 'signup'
  | 'login'
  | 'logout'
  | 'business_added'
  | 'business_switched'
  | 'aggregate_view_toggled'
  | 'document_uploaded'
  | 'document_removed'
  | 'chat_sent'
  | 'chat_citation_clicked'
  | 'audio_overview_generated'
  | 'export_generated'
  | 'export_downloaded'
  | 'upgrade_clicked'
  | 'upgrade_completed'
  | 'upgrade_cancelled'
  | 'integration_connected'
  | 'integration_failed'
  | 'trial_banner_shown'
  | 'support_ticket_submitted'
  | 'diagnostic_run'

interface EventProperties {
  // Common â€” sent with every event
  plan?:    string
  // Event-specific
  plan_target?:    string
  doc_type?:       string
  export_format?:  string
  provider?:       string
  source_count?:   number
  [key: string]:   string | number | boolean | undefined
}

// â”€â”€ PostHog loader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _posthog: any = null

function getPostHog() {
  if (typeof window === 'undefined') return null  // server-side â€” skip
  if (_posthog) return _posthog

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!key) return null  // not configured â€” skip silently

  // Lazy-load PostHog only when needed
  import('posthog-js').then(({ default: posthog }) => {
    posthog.init(key, {
      api_host:            process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com',
      capture_pageview:    false,   // we'll track page views manually
      capture_pageleave:   true,
      persistence:         'localStorage',

      // GDPR: don't capture personal data
      property_denylist:   ['$email', '$name', '$phone'],
      sanitize_properties: (props: Record<string, any>) => {
        // Remove any property that looks like an email
        const safe: Record<string, any> = {}
        for (const [k, v] of Object.entries(props)) {
          if (typeof v === 'string' && v.includes('@')) continue
          safe[k] = v
        }
        return safe
      },

      // Cookie settings
      cross_subdomain_cookie: false,
      secure_cookie:          true,
    })
    _posthog = posthog
  }).catch(() => {
    // PostHog not installed â€” npm install posthog-js
    console.warn('PostHog not installed. Run: npm install posthog-js')
  })

  return _posthog
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * track(event, properties?)
 * Call this on key user actions.
 *
 * Examples:
 *   track('document_uploaded', { doc_type: 'invoice' })
 *   track('upgrade_clicked',   { plan_target: 'pro' })
 *   track('chat_sent',         { source_count: 3 })
 */
export function track(event: EventName, properties?: EventProperties) {
  const ph = getPostHog()
  if (!ph) return  // analytics not configured â€” fail silently

  try {
    ph.capture(event, properties)
  } catch {
    // Never let analytics errors break the app
  }
}

/**
 * identify(userId, plan)
 * Links the current user to their PostHog profile.
 * Call this after login. Never pass email â€” use the UUID only.
 */
export function identify(userId: string, plan: string) {
  const ph = getPostHog()
  if (!ph) return

  try {
    ph.identify(userId, {
      plan,
      // No email, no name â€” UUID only for GDPR compliance
    })
  } catch {}
}

/**
 * page(pageName)
 * Track a page view. Call in each page component on mount.
 */
export function page(pageName: string) {
  track('page_view', { page: pageName } as any)
}

/**
 * reset()
 * Clear the PostHog identity on logout.
 */
export function reset() {
  const ph = getPostHog()
  if (!ph) return
  try { ph.reset() } catch {}
}
