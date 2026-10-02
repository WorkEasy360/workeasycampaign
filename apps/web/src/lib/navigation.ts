/**
 * Only same-origin, absolute paths are accepted as post-login destinations ("/settings/members"), never
 * "//evil.com", "https://evil.com" or "/\evil.com" — prevents open redirects through ?next=.
 */
export function safeNext(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  try {
    const u = new URL(next, 'http://same.origin');
    return u.origin === 'http://same.origin' ? `${u.pathname}${u.search}${u.hash}` : fallback;
  } catch {
    return fallback;
  }
}
