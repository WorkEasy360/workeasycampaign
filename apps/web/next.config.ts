import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@workeasy/shared'],
  async rewrites() {
    // Same-origin API calls keep session cookies first-party and avoid CORS.
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/:path*` }];
  },
};

export default config;
