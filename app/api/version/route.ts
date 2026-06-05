// app/api/version/route.ts
//
// Returns the current production build's git SHA. The client polls this
// every 60s and compares against the SHA baked into its own JS bundle
// (NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA). When they differ, <VersionWatcher />
// shows a "new version available" pill so the owner can refresh — they
// shouldn't have to know to hard-refresh after a deploy.
//
// Cache-Control: no-store so every poll hits the freshest serverless
// function, not an edge cache.

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    { sha: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev' },
    { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } },
  )
}
