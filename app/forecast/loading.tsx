// app/forecast/loading.tsx
//
// Forecast = predicted vs actual chart + per-period table.

import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/Skeleton'

export default function ForecastLoading() {
  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <Skeleton width={180} height={20} radius={4} />
        <Skeleton width={200} height={32} radius={6} />
      </div>
      <SkeletonCard style={{ height: 300, padding: 18, marginBottom: 14 }} showTitle={false}>
        <Skeleton width={140} height={14} radius={3} style={{ marginBottom: 16 }} />
        <Skeleton width="100%" height={220} radius={6} />
      </SkeletonCard>
      <SkeletonTable rows={6} columns={5} />
    </div>
  )
}
