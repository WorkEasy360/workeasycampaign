import { type NextRequest, NextResponse } from 'next/server';

/**
 * UX only: visitors without a session cookie go straight to /login instead of seeing a spinner.
 * This is NOT authorization â€” the cookie is not validated here; the API validates it on every request.
 */
const APP_PREFIXES = ['/dashboard', '/organizations', '/workspaces', '/settings', '/onboarding', '/contacts', '/audience', '/imports'];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has('__Host-wk_session') || request.cookies.has('wk_session');
  if (!hasSession && APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/organizations/:path*', '/workspaces/:path*', '/settings/:path*', '/onboarding/:path*', '/contacts/:path*', '/audience/:path*', '/imports/:path*'],
};
