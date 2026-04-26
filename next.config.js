// next.config.js
const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Tell Next.js NOT to bundle pdfjs-dist into our serverless functions —
  // use the installed package directly at runtime. pdfjs-dist has a worker
  // file (pdf.worker.mjs) that webpack tends to drop during bundling, which
  // makes the deterministic Resultatrapport parser silently fall back to
  // Claude in production. Listing here keeps the package whole.
  //
  // NOTE: this config key is `experimental.serverComponentsExternalPackages`
  // on Next.js 14 (we're on 14.2.0). Next 15 renamed it to top-level
  // `serverExternalPackages` — using the wrong name silently no-ops and
  // pdfjs ends up half-bundled with the @napi-rs/canvas warning we saw
  // in production logs (Vercel build emits "Invalid next.config.js options
  // detected" but the function still runs without externalisation).
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist', '@napi-rs/canvas'],
    // pdfjs-dist's legacy entry (pdf.mjs) dynamic-imports the worker file
    // (pdf.worker.mjs) at runtime — even when we set disableWorker:true the
    // "fake worker" path still loads the worker code via import. Next.js's
    // serverless tracing only copies statically-imported files, so the
    // worker .mjs gets dropped from /var/task/node_modules. Force-include
    // it so the import resolves at runtime in production.
    outputFileTracingIncludes: {
      '/api/fortnox/extract-worker': [
        './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      ],
    },
  },

  // Webpack: ignore the optional canvas import so pdfjs's bundler probes
  // don't try to resolve a binary we don't have. Belt-and-braces with the
  // external-packages list above.
  webpack(config) {
    config.resolve = config.resolve ?? {}
    config.resolve.alias = { ...(config.resolve.alias ?? {}), canvas: false, '@napi-rs/canvas': false }
    return config
  },

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
      // object-src permits the <object> PDF preview on /overheads/upload
      // to load signed Supabase storage URLs. Falls back to default-src
      // otherwise, which blocks the preview.
      "object-src 'self' https://*.supabase.co",
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
  // NOTE: this is the SENTRY org slug (from sentry.io/settings/). It is
  // intentionally different from our Vercel org slug (`paul-7076s-projects`).
  // Getting this wrong makes the release-upload step 404 silently — symptom
  // is "Unreferenced" images in Sentry issue view and minified stack traces.
  org:     'comandcenter',
  project: 'javascript-nextjs',

  silent: true,

  // Pin release name to the full Vercel git SHA. Matches what the runtime
  // Sentry SDK is configured to read below (sentry.server.config.ts etc.),
  // so events and source-map uploads align.
  release: {
    name: process.env.VERCEL_GIT_COMMIT_SHA,
  },

  // Upload source maps to Sentry so stack traces show real line numbers
  // rather than minified gibberish. Only runs during production builds.
  widenClientFileUpload: true,

  // Proxy Sentry calls through /monitoring so adblockers don't block them
  tunnelRoute: '/monitoring',

})
