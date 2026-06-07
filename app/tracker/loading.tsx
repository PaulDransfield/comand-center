// app/tracker/loading.tsx
//
// Tracker = monthly P&L grid. Header + month-selector + line table.

import { Skeleton, SkeletonTable } from '@/components/ui/Skeleton'

export default function TrackerLoading() {
  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <Skeleton width={180} height={20} radius={4} style={{ marginBottom: 6 }} />
          <Skeleton width={260} height={11} radius={3} />
        </div>
        <Skeleton width={160} height={32} radius={6} />
      </div>
      <SkeletonTable rows={10} columns={5} />
    </div>
  )
}
