// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json()
    const adminPassword = process.env.ADMIN_SECRET
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
