'use client'
// app/admin/error.tsx
//
// Segment-level error boundary for every /admin/* route. Admins see
// the same fallback UI as customers — same RouteErrorFallback. The
// only difference is the surface label.

import { RouteErrorFallback } from '@/components/RouteErrorFallback'

export default function AdminError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <RouteErrorFallback {...props} surface="the admin console" />
}
