// @ts-nocheck
// app/api/stripe/portal/route.ts
//
// Creates a Stripe Customer Portal session.
// The portal lets users self-serve: update card, download invoices,
// change plan, cancel subscription — without any custom UI needed.
//
// POST /api/stripe/portal  { returnUrl?: string }
// Returns { url: 'https://billing.stripe.com/...' }

import { NextRequest, NextResponse } from 'next/server'
import Stripe                        from 'stripe'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { rateLimit }                 from '@/lib/middleware/rate-limit'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' })

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // max 20 portal requests per user per hour
  const limit = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 20 })
  if (!limit.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const { returnUrl } = await req.json().catch(() => ({}))
  const supabase      = createAdminClient()

  // Get the Stripe customer ID for this org
  const { data: org } = await supabase
    .from('organisations')
    .select('stripe_customer_id')
    .eq('id', auth.orgId)
    .single()

  if (!org?.stripe_customer_id) {
    return NextResponse.json({
      error: 'No billing account found. Please upgrade to a paid plan first.',
    }, { status: 404 })
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   org.stripe_customer_id,
      return_url: returnUrl ?? `${process.env.NEXT_PUBLIC_APP_URL}/upgrade`,
    })
    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
