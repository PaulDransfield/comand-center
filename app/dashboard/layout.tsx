// app/dashboard/layout.tsx - simple test layout
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <div style={{ background: '#1E2761', height: 52, display: 'flex', alignItems: 'center', padding: '0 20px' }}>
        <span style={{ color: 'white', fontWeight: 'bold' }}>CommandCenter</span>
      </div>
      <main style={{ padding: 20 }}>
        {children}
      </main>
    </div>
  )
}
