import { NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/registrations/register', '/register'];

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // Proxy routes — must not require login (rewritten to Render backend)
  if (pathname.startsWith('/api/') || pathname.startsWith('/uploads/')) {
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  if (request.nextUrl.searchParams.has('token') && pathname !== '/login') {
    const loginUrl = new URL(`/login${request.nextUrl.search}`, request.url);
    return NextResponse.redirect(loginUrl);
  }

  const token = request.cookies.get('smas_token')?.value;
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.png|sw.js|manifest.webmanifest|icons/|api|uploads).*)'],
};
