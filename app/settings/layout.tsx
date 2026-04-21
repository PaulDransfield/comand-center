// Pass-through layout — the duplicate blue CommandCenter bar + extra
// main padding have been removed (global G1 / PNL-FIX § 1). AppShell
// provides the sidebar and page chrome uniformly across all pages.
export const dynamic = 'force-dynamic'
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
