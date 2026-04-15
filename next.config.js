// next.config.js
const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },

  async headers() {
    // Content-Security-Policy prevents XSS attacks.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://eu.i.posthog.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co",
      "font-src 'self'",
      // Added *.ingest.de.sentry.io for EU Sentry error reporting
      "connect-src 'self' https://*.supabase.co https://api.anthropic.com https://api.stripe.com https://eu.i.posthog.com wss://*.supabase.co https://*.ingest.de.sentry.io",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join('; ')

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy',   value: csp },
          { key: 'X-Frame-Options',           value: 'DENY' },
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
          { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',        value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ]
  },
}

// Sentry wraps the config to auto-instrument API routes and server components.
// tunnelRoute proxies Sentry traffic through our own domain so ad-blockers
// don't block error reports.
module.exports = withSentryConfig(nextConfig, {
  org:     'paul-7076s-projects',
  project: 'javascript-nextjs',

  // Suppress Sentry's noisy build output
  silent: true,

  // Upload source maps to Sentry so stack traces show real line numbers
  // rather than minified gibberish. Only runs during production builds.
  widenClientFileUpload: true,

  // Proxy Sentry calls through /monitoring so adblockers don't block them
  tunnelRoute: '/monitoring',

})
