// app/admin/v2/customers/[orgId]/loading.tsx
// Skeleton state for the customer-detail page. Matches the post-load
// layout (header card + subtab nav + main column / right rail) so
// nothing jumps when data arrives.

export default function Loading() {
  const skel = { background: '#f3f4f6', borderRadius: 4 }
  return (
    <div>
      {/* Header */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 14, height: 90 }}>
        <div style={{ ...skel, width: 240, height: 22, marginBottom: 10 }} />
        <div style={{ ...skel, width: 320, height: 12 }} />
      </div>
      {/* Body */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 18 }}>
        <main>
          {/* Subtab nav */}
          <div style={{ display: 'flex', gap: 14, padding: '8px 0', borderBottom: '1px solid #e5e7eb', marginBottom: 16 }}>
            {[80, 100, 60, 70, 60, 100, 60, 90].map((w, i) => (
              <div key={i} style={{ ...skel, width: w, height: 14 }} />
            ))}
          </div>
          {/* KPI strip skeleton */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px', height: 80 }}>
                <div style={{ ...skel, width: 80, height: 10, marginBottom: 8 }} />
                <div style={{ ...skel, width: 120, height: 22 }} />
              </div>
            ))}
          </div>
          {/* Card skeleton */}
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, height: 240 }} />
        </main>
        <aside>
          <div style={{ ...skel, width: 80, height: 10, marginBottom: 8, background: '#e5e7eb' }} />
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, height: 36, marginBottom: 6 }} />
          ))}
        </aside>
      </div>
    </div>
  )
}
