// middleware.ts - reads all cookies and logs them for debugging

import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  
  // Log all cookies for debugging
  const allCookies = request.cookies.getAll()
  console.log('MIDDLEWARE PATH:', pathname)
  console.log('COOKIES:', allCookies.map(c => c.name))
  
  // Check for any Supabase session cookie
  const hasSession = allCookies.some(c =>
    c.name.includes('auth') ||
    c.name.includes('session') ||
    c.name.includes('sb-') ||
    c.name.includes('supabase')
  )

  console.log('HAS SESSION COOKIE:', hasSession)

  // Logged-in users visiting the landing page → send to dashboard
  if (pathname === '/' && hasSession) {
    const dashUrl = request.nextUrl.clone()
    dashUrl.pathname = '/dashboard'
    return NextResponse.redirect(dashUrl)
  }

  // Protect dashboard (and other app pages) from logged-out users
  if (pathname.startsWith('/dashboard')) {
    if (!hasSession) {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/login'
      loginUrl.searchParams.set('redirectTo', pathname)
      return NextResponse.redirect(loginUrl)
    }
  }
  
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)',
  ],
}
