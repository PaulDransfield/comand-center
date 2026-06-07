// app/dashboard/loading.tsx
//
// Shown during navigation to /dashboard before the client-rendered page
// hydrates. The dashboard has a KPI strip + main chart + side rails; we
// approximate the shape so when real data arrives the layout doesn't jump.

import { Skeleton, SkeletonCard } from '@/components/ui/Skeleton'
import { UXP } from '@/lib/constants/tokens'

export default function DashboardLoading() {
  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      {/* Header line — biz name + period pills */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <Skeleton width={180} height={20} radius={4} />
        <Skeleton width={240} height={26} radius={6} />
      </div>

      {/* KPI strip (Revenue / Labour / Food / Net) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 10,
        marginBottom: 14,
      }}>
        {[0, 1, 2, 3].map(i => (
          <SkeletonCard key={i} style={{ height: 96, padding: 14 }} showTitle={false}>
            <Skeleton width={60} height={9} radius={2} style={{ marginBottom: 10 }} />
            <Skeleton width={120} height={24} radius={4} style={{ marginBottom: 6 }} />
            <Skeleton width={80} height={10} radius={3} />
          </SkeletonCard>
        ))}
      </div>

      {/* Main chart card */}
      <SkeletonCard style={{ height: 340, padding: 18, marginBottom: 14 }} showTitle={false}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Skeleton width={140} height={14} radius={3} />
          <Skeleton width={200} height={14} radius={3} />
        </div>
        <Skeleton width="100%" height={260} radius={6} />
      </SkeletonCard>

      {/* Two-up: dept breakdown + attention panel */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        <SkeletonCard style={{ height: 240, padding: 16 }} lines={5} />
        <SkeletonCard style={{ height: 240, padding: 16 }} lines={4} />
      </div>
    </div>
  )
}
