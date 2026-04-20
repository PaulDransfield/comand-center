// app/scheduling/ai/page.tsx
//
// The AI-suggested schedule is now part of /scheduling. This page exists
// only to redirect old bookmarks and the link in the weekly memo email.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function LegacyScheduleAi() {
  redirect('/scheduling')
}
