'use client'
// app/financials/error.tsx
//
// Segment-level error boundary for every /financials/* route.

import { RouteErrorFallback } from '@/components/RouteErrorFallback'

export default function FinancialsError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <RouteErrorFallback {...props} surface="your financials" />
}
