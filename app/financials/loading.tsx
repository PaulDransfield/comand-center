// app/financials/loading.tsx
//
// Skeleton for /financials/performance and any sibling. Mirrors the
// "period picker + KPI strip + waterfall + donut + trend rows" shape.

import { Skeleton, SkeletonCard } from '@/components/ui/Skeleton'

export default function FinancialsLoading() {
  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      {/* Title + period pills */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <Skeleton width={180} height={20} radius={4} />
        <div style={{ display: 'flex', gap: 6 }}>
          {[60, 70, 80, 60].map((w, i) => (
            <Skeleton key={i} width={w} height={28} radius={14} />
          ))}
        </div>
      </div>

      {/* KPI strip (Rev / Food / Labour / Other / Net) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 10,
        marginBottom: 14,
      }}>
        {[0, 1, 2, 3, 4].map(i => (
          <SkeletonCard key={i} style={{ height: 90, padding: 14 }} showTitle={false}>
            <Skeleton width={60} height={9} radius={2} style={{ marginBottom: 10 }} />
            <Skeleton width={100} height={22} radius={4} style={{ marginBottom: 6 }} />
            <Skeleton width={70} height={10} radius={3} />
          </SkeletonCard>
        ))}
      </div>

      {/* Waterfall card */}
      <SkeletonCard style={{ height: 280, padding: 18, marginBottom: 14 }} showTitle={false}>
        <Skeleton width={160} height={14} radius={3} style={{ marginBottom: 16 }} />
        <Skeleton width="100%" height={200} radius={6} />
      </SkeletonCard>

      {/* Two-up: donut + attention */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <SkeletonCard style={{ height: 220, padding: 16 }} lines={4} />
        <SkeletonCard style={{ height: 220, padding: 16 }} lines={4} />
      </div>
    </div>
  )
}
