// @ts-nocheck
// TEMPORARY — delete after source-map verification.
// GET /api/admin/sentry-test?secret=ADMIN_SECRET → deliberate throw.

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams.get('secret')
  if (s !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }
  throw new Error('sentry source-map verification ' + Date.now())
}
