'use client'
// app/error.tsx
//
// Next.js App Router root error boundary. Catches errors thrown by any
// client component inside app/ that isn't caught by a more specific
// segment boundary (e.g. app/inventory/error.tsx). Renders the shared
// RouteErrorFallback so the failure UI matches the rest of the app.
//
// global-error.tsx is one layer above this — that one catches errors
// in the root layout itself (rare, catastrophic).

import { RouteErrorFallback } from '@/components/RouteErrorFallback'

export default function Error(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <RouteErrorFallback {...props} />
}
