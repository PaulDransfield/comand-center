// app/api/inventory/menus/[id]/image/route.ts
//
// POST   — upload a menu hero photo. multipart/form-data with field `file`.
//          Stored at menus/{business_id}/{menu_id}-{rand}.{ext} in the
//          public `recipe-images` bucket (shared with recipes).
// DELETE — clear the image (best-effort storage cleanup).
//
// Mirrors /api/inventory/recipes/[id]/image — same bucket, parallel path
// namespace. Writes menus.image_url.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 10 * 1024 * 1024
const OK_TYPES  = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: m } = await db.from('menus').select('id, business_id, image_url').eq('id', params.id).maybeSingle()
  if (!m) return NextResponse.json({ error: 'menu not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, m.business_id)
  if (forbidden) return forbidden

  const form = await req.formData()
  const file = form.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `image too large (max ${MAX_BYTES / 1024 / 1024} MB)` }, { status: 400 })
  if (!OK_TYPES.has(file.type)) return NextResponse.json({ error: `unsupported type ${file.type} — use JPG/PNG/WebP/GIF` }, { status: 400 })

  const ext  = EXT_BY_TYPE[file.type]
  const rand = Math.random().toString(36).slice(2, 10)
  const path = `menus/${m.business_id}/${params.id}-${rand}.${ext}`
  const buf  = Buffer.from(await file.arrayBuffer())

  const { error: upErr } = await db.storage.from('recipe-images').upload(path, buf, {
    contentType: file.type,
    upsert: false,
  })
  if (upErr) return NextResponse.json({ error: `upload: ${upErr.message}` }, { status: 500 })

  const { data: pub } = db.storage.from('recipe-images').getPublicUrl(path)
  const newUrl = pub.publicUrl

  if (m.image_url) {
    const prevPath = extractStoragePath(m.image_url)
    if (prevPath) await db.storage.from('recipe-images').remove([prevPath]).catch(() => {})
  }

  const { error: upMenuErr } = await db.from('menus').update({ image_url: newUrl }).eq('id', params.id)
  if (upMenuErr) return NextResponse.json({ error: `set url: ${upMenuErr.message}` }, { status: 500 })

  return NextResponse.json({ ok: true, image_url: newUrl }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: m } = await db.from('menus').select('id, business_id, image_url').eq('id', params.id).maybeSingle()
  if (!m) return NextResponse.json({ error: 'menu not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, m.business_id)
  if (forbidden) return forbidden

  if (m.image_url) {
    const prevPath = extractStoragePath(m.image_url)
    if (prevPath) await db.storage.from('recipe-images').remove([prevPath]).catch(() => {})
  }
  await db.from('menus').update({ image_url: null }).eq('id', params.id)
  return NextResponse.json({ ok: true })
}

function extractStoragePath(publicUrl: string): string | null {
  const m = publicUrl.match(/\/recipe-images\/(.+)$/)
  return m ? m[1] : null
}
