// Pass-through layout — AppShell provides all chrome.
export const dynamic = 'force-dynamic'
export default function OverheadsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
