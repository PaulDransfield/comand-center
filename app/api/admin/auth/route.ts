// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json()
    const adminPassword = process.env.ADMIN_PASSWORD
    if (!adminPassword) {
      console.error('ADMIN_PASSWORD env var is not set')
      return NextResponse.json({ ok: false, error: 'Server misconfiguration' }, { status: 500 })
    }
    if (password !== adminPassword) {
      // Temporary debug — logs lengths only, never the actual values
      console.log(`Auth fail: input length=${password?.length}, env length=${adminPassword?.length}, match=${password === adminPassword}`)
      return NextResponse.json({ ok: false, error: 'Wrong password' }, { status: 401 })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 })
  }
}
