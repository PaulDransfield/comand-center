// @ts-nocheck
import type { Metadata } from 'next'
import './globals.css'
import './mobile.css'

export const metadata: Metadata = {
  title: {
    default:  'CommandCenter',
    template: '%s â€” CommandCenter',
  },
  description: 'AI-powered business intelligence for Swedish restaurants',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  )
}
