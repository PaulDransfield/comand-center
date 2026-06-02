'use client'
// app/inventory/recipes/[id]/page.tsx
//
// Full-page recipe editor — edit mode. Mounts <RecipeEditor> with
// recipeId from the URL. Reuses every endpoint and helper from the
// prior drawer; only the shell changed (drawer → page).

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { RecipeEditor } from '@/components/RecipeEditor'
import { UXP } from '@/lib/constants/tokens'

export default function RecipeEditPage() {
  const params = useParams<{ id: string }>()
  const recipeId = params.id

  // bizId comes from the sidebar selector via localStorage; mirror the
  // list page's pattern so the editor + list stay in sync.
  const [bizId, setBizId] = useState<string | null>(null)
  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() {
      const next = localStorage.getItem('cc_selected_biz')
      if (next) setBizId(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return (
    <AppShell>
      {!bizId ? (
        <div style={{ maxWidth: 1100, padding: '20px 24px', margin: '0 auto' }}>
          <div style={{
            padding: 24, textAlign: 'center' as const, background: UXP.subtleBg,
            border: `0.5px dashed ${UXP.border}`, borderRadius: 8,
            color: UXP.ink3, fontSize: 13,
          }}>
            Select a business in the sidebar to edit this recipe.
          </div>
        </div>
      ) : (
        <RecipeEditor recipeId={recipeId} bizId={bizId} />
      )}
    </AppShell>
  )
}
