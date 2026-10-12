import { type NextRequest, NextResponse } from 'next/server';

/**
 * UX only: visitors without a session cookie go straight to /login instead of seeing a spinner.
 * This is NOT authorization — the cookie is not validated here; the API validates it on every request.
 */
const APP_PREFIXES = ['/dashboard', '/organizations', '/workspaces', '/settings', '/onboarding', '/contacts', '/audience', '/imports', '/campaigns', '/templates'];

/**
 * Same-origin API: /api/* is forwarded to API_URL (the internal API address), read when the server RUNS. A
 * next.config rewrite is frozen into the build (routes-manifest.json) and ignores API_URL at runtime, so one image could
 * not be deployed against different API addresses — and an image built without API_URL proxied to itself.
 */
export function apiTarget(pathname: string, search: string, apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4000'): URL {
  return new URL(`${apiUrl.replace(/\/+$/, '')}${pathname.slice('/api'.length) || '/'}${search}`);
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === '/api' || pathname.startsWith('/api/')) return NextResponse.rewrite(apiTarget(pathname, search));
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
  matcher: [
    '/api/:path*',
    '/dashboard/:path*',
    '/organizations/:path*',
    '/workspaces/:path*',
    '/settings/:path*',
    '/onboarding/:path*',
    '/contacts/:path*',
    '/audience/:path*',
    '/imports/:path*',
    '/campaigns/:path*',
    '/templates/:path*',
  ],
};
