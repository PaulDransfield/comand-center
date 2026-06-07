// app/overheads/loading.tsx
//
// Overheads = BAS-bucketed cost surface. Same waterfall + bucket list.

import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/Skeleton'

export default function OverheadsLoading() {
  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <Skeleton width={180} height={20} radius={4} />
        <Skeleton width={200} height={32} radius={6} />
      </div>
      <SkeletonCard style={{ height: 220, padding: 18, marginBottom: 14 }} showTitle={false}>
        <Skeleton width={160} height={14} radius={3} style={{ marginBottom: 16 }} />
        <Skeleton width="100%" height={140} radius={6} />
      </SkeletonCard>
      <SkeletonTable rows={8} columns={4} />
    </div>
  )
}
