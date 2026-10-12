import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { apiTarget, proxy } from './proxy';

describe('API proxy (runtime API_URL)', () => {
  const saved = process.env.API_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.API_URL;
    else process.env.API_URL = saved;
  });

  it('maps /api/* to the API address, keeping the path and query', () => {
    expect(apiTarget('/api/v1/me', '?a=1', 'http://api.internal:4000').href).toBe('http://api.internal:4000/v1/me?a=1');
    expect(apiTarget('/api', '', 'http://api.internal:4000/').href).toBe('http://api.internal:4000/');
    expect(apiTarget('/api/health', '', 'https://api.example.com/base/').href).toBe('https://api.example.com/base/health');
  });

  it('reads API_URL when the request is handled, not when the app was built', () => {
    process.env.API_URL = 'http://first:4000';
    expect(proxy(new NextRequest('https://app.example.com/api/v1/me')).headers.get('x-middleware-rewrite')).toBe('http://first:4000/v1/me');
    process.env.API_URL = 'http://second:4000';
    expect(proxy(new NextRequest('https://app.example.com/api/v1/me')).headers.get('x-middleware-rewrite')).toBe('http://second:4000/v1/me');
  });

  it('only /api is proxied: /apis and app pages are not', () => {
    process.env.API_URL = 'http://api:4000';
    expect(proxy(new NextRequest('https://app.example.com/apis')).headers.get('x-middleware-rewrite')).toBeNull();
    const page = proxy(new NextRequest('https://app.example.com/campaigns'));
    expect(page.headers.get('location')).toBe('https://app.example.com/login?next=%2Fcampaigns');
  });
});
