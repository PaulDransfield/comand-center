'use client'
// app/inventory/error.tsx
//
// Segment-level error boundary for every /inventory/* route. Catches
// errors before they bubble up to app/error.tsx so the surface label
// is specific ("your inventory" instead of "the app").

import { RouteErrorFallback } from '@/components/RouteErrorFallback'

export default function InventoryError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <RouteErrorFallback {...props} surface="your inventory" />
}
