'use client'
// app/inventory/recipes/new/page.tsx
//
// Full-page recipe editor — create mode. Mounts <RecipeEditor> with
// recipeId={null}; the editor renders its header-only "New recipe"
// form, then redirects to /inventory/recipes/[id] after save.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { RecipeEditor } from '@/components/RecipeEditor'
import { UXP } from '@/lib/constants/tokens'

export default function RecipeNewPage() {
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
            Select a business in the sidebar before creating a recipe.
          </div>
        </div>
      ) : (
        <RecipeEditor recipeId={null} bizId={bizId} />
      )}
    </AppShell>
  )
}
