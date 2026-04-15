// lib/supabase/client.ts
//
// The BROWSER-SIDE Supabase client.
// Use this in React components that run in the browser.
// It uses the public "anon" key which is safe to expose — RLS handles security.
//
// Usage in a component:
//   import { createClient } from '@/lib/supabase/client'
//   const supabase = createClient()
//   const { data } = await supabase.from('businesses').select('*')

import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  // These env vars are prefixed NEXT_PUBLIC_ so they're available in the browser
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
