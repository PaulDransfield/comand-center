$content = @'
import { BizProvider } from '@/context/BizContext'

export const dynamic = 'force-dynamic'

export default function TrackerLayout({ children }: { children: React.ReactNode }) {
  return (
    <BizProvider>
      <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
        <div style={{ background: '#1E2761', height: 52, display: 'flex', alignItems: 'center', padding: '0 20px', justifyContent: 'space-between' }}>
          <span style={{ color: 'white', fontWeight: 'bold', fontFamily: 'Georgia,serif' }}>CommandCenter</span>
          <a href="/dashboard" style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, textDecoration: 'none' }}>← Dashboard</a>
        </div>
        <main style={{ padding: 20 }}>{children}</main>
      </div>
    </BizProvider>
  )
}

'@
New-Item -ItemType Directory -Force -Path "app\tracker" | Out-Null
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) "app\tracker\layout.tsx"),
  $content,
  [System.Text.Encoding]::UTF8
)
Write-Host "Done"
