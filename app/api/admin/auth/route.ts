// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

// Temporary debug endpoint — remove after diagnosing auth issue
// Visit /api/admin/auth in browser to see env var status
export async function GET() {
  const pw = process.env.ADMIN_PASSWORD
  return NextResponse.json({
    set:    !!pw,
    length: pw?.length ?? 0,
    first:  pw?.[0] ?? null,   // first character only — safe to expose
    last:   pw?.[pw.length - 1] ?? null,  // last character only
  })
}

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json()
    const adminPassword = process.env.ADMIN_PASSWORD
    if (!adminPassword) {
      return NextResponse.json({ ok: false, error: 'Server misconfiguration' }, { status: 500 })
    }
    if (password !== adminPassword) {
      return NextResponse.json({ ok: false, error: 'Wrong password' }, { status: 401 })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 })
  }
}
