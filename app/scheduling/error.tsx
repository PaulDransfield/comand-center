'use client'
// app/scheduling/error.tsx
//
// Segment-level error boundary for every /scheduling/* route.

import { RouteErrorFallback } from '@/components/RouteErrorFallback'

export default function SchedulingError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <RouteErrorFallback {...props} surface="scheduling" />
}
