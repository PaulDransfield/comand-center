// @ts-nocheck
// lib/supabase/server.ts
// Server-side Supabase clients for API routes and Server Components.

import { createServerClient } from '@supabase/ssr'
import { cookies }            from 'next/headers'

export function createClient() {
  const cookieStore = cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {}
        },
      },
    }
  )
}

export function createAdminClient() {
  // DEVELOPMENT MODE: Return mock client for local development
  if (process.env.NODE_ENV === 'development' || 
      process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('mock-supabase-url-for-development')) {
    console.log('DEVELOPMENT MODE: Creating mock Supabase admin client')
    
    // Create a mock Supabase client that doesn't throw errors
    const mockClient = {
      auth: {
        getUser: async () => ({ 
          data: { user: null }, 
          error: null 
        }),
        getSession: async () => ({ 
          data: { session: null }, 
          error: null 
        }),
      },
      from: (table: string) => ({
        select: (columns: string, options?: any) => {
          // Handle the health endpoint query
          if (table === 'organisations' && options?.count === 'exact' && options?.head === true) {
            return {
              then: async (callback: any) => callback({ data: null, error: null, count: 0 })
            }
          }
          
          // Default select handler
          return {
            eq: (column: string, value: any) => ({
              single: async () => ({ 
                data: null, 
                error: null 
              }),
              then: async (callback: any) => callback({ data: null, error: null })
            }),
            then: async (callback: any) => callback({ data: null, error: null, count: 0 })
          }
        },
        then: async (callback: any) => callback({ data: null, error: null })
      }),
      then: async (callback: any) => callback({ data: null, error: null })
    }
    
    return mockClient as any
  }

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() {},
      },
    }
  )
}
