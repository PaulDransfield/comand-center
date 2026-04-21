import { BizProvider } from '@/context/BizContext'

export const dynamic = 'force-dynamic'

// Wrapper kept only for the BizProvider — the old blue CommandCenter bar
// + extra main padding were redundant on top of AppShell and have been
// removed (PNL-FIX § 1 / global G1).
export default function TrackerLayout({ children }: { children: React.ReactNode }) {
  return <BizProvider>{children}</BizProvider>
}
