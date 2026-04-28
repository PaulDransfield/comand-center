'use client'
// app/admin/v2/page.tsx
// Root of the new admin — bounce to /overview.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminV2Root() {
  const router = useRouter()
  useEffect(() => { router.replace('/admin/v2/overview') }, [router])
  return null
}
