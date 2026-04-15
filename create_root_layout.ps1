$content = @'
import type { Metadata } from 'next'
import './globals.css'
import './mobile.css'

export const metadata: Metadata = {
  title: {
    default:  'CommandCenter',
    template: '%s — CommandCenter',
  },
  description: 'AI-powered business intelligence for Swedish restaurants',
  charset: 'utf-8',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  )
}

'@
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) "app\layout.tsx"),
  $content,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Done"
