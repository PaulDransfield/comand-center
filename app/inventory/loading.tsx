// app/inventory/loading.tsx
//
// Generic skeleton for any /inventory/* route. Most inventory pages
// (items, recipes, suppliers, orders) are list-shaped — header + filters
// + table — so we approximate that.

import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/Skeleton'

export default function InventoryLoading() {
  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      {/* Title + total count chip */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <Skeleton width={160} height={20} radius={4} style={{ marginBottom: 6 }} />
          <Skeleton width={240} height={11} radius={3} />
        </div>
        <Skeleton width={120} height={32} radius={6} />
      </div>

      {/* Filter pills + search */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[80, 100, 90, 110, 70].map((w, i) => (
          <Skeleton key={i} width={w} height={28} radius={14} />
        ))}
        <div style={{ flex: 1, minWidth: 200 }}>
          <Skeleton width="100%" height={28} radius={6} />
        </div>
      </div>

      {/* KPI strip (count, value, gaps) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
        {[0, 1, 2].map(i => (
          <SkeletonCard key={i} style={{ height: 76, padding: 14 }} showTitle={false}>
            <Skeleton width={70} height={9} radius={2} style={{ marginBottom: 10 }} />
            <Skeleton width={100} height={20} radius={4} />
          </SkeletonCard>
        ))}
      </div>

      {/* Main table */}
      <SkeletonTable rows={8} columns={5} />
    </div>
  )
}
