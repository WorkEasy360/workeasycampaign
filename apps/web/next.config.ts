import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4000';

/** Security headers for every page. The API sets its own (stricter) headers. */
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next.js injects inline bootstrap scripts; dev mode also needs eval for fast refresh.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Next buffers proxied request bodies (for proxy.ts) and silently TRUNCATES them at this size (default 10 MB).
    // A truncated CSV upload made the API wait for missing bytes until the proxy timed out (hardening H-3).
    // Invariant: keep this ABOVE the API's IMPORT_MAX_BYTES (default 20 MB). Then any body cut at this limit is still
    // larger than the API allows and is rejected with 413 — never imported partially.
    proxyClientMaxBodySize: '32mb',
  },
  transpilePackages: ['@workeasy/shared'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    // Same-origin API: session cookies stay first-party, no CORS surface. The Next server forwards the client IP
    // in X-Forwarded-For; the API trusts it only from configured proxies (TRUST_PROXY).
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default config;
