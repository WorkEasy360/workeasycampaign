import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRateLimitOverrides } from '../src/config/env.js';
import { Agent, PASSWORD, resetTestDatabase, startTestApp, type TestApp, uniqueEmail } from './support.js';

/**
 * RATE_LIMIT_OVERRIDES: per-deployment limits for named policies (e.g. an office behind one NAT; an E2E suite that
 * registers many users from 127.0.0.1). The code defaults stay; only listed policies change; invalid values fail boot.
 */
describe('rate-limit overrides', () => {
  it('parses strictly: known shape, bounded values; anything else is rejected', () => {
    expect(parseRateLimitOverrides(undefined)).toEqual({});
    expect(parseRateLimitOverrides(' auth.register=40 , campaigns.preview=1200 ')).toEqual({ 'auth.register': 40, 'campaigns.preview': 1200 });
    for (const bad of ['auth.register', 'auth.register=0', 'auth.register=1000001', 'register=5', 'auth.register=-1', 'AUTH.register=5', 'auth.register=5;drop']) {
      expect(() => parseRateLimitOverrides(bad), bad).toThrow(/RATE_LIMIT_OVERRIDES/);
    }
  });

  describe('applied by the guard', () => {
    let t: TestApp;
    beforeAll(async () => {
      await resetTestDatabase();
      t = await startTestApp({ RATE_LIMIT_OVERRIDES: 'auth.register=12' });
    });
    afterAll(async () => t?.close());

    it('the overridden policy allows its new limit, then answers 429 with Retry-After', async () => {
      const client = new Agent(t);
      const statuses: number[] = [];
      let retryAfter: string | undefined;
      for (let i = 0; i < 13; i++) {
        const r = await client.post('/v1/auth/register', { email: uniqueEmail('ov'), password: PASSWORD, displayName: 'R' });
        statuses.push(r.status);
        retryAfter = r.headers['retry-after'] as string | undefined;
      }
      expect(statuses.slice(0, 12).every((s) => s === 202)).toBe(true);
      expect(statuses[12]).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    it('other policies keep their code defaults (login: 20/min per IP)', async () => {
      const client = new Agent(t);
      let last = 0;
      for (let i = 0; i < 21; i++) last = (await client.post('/v1/auth/login', { email: uniqueEmail('nobody'), password: 'wrong-password-x' })).status;
      expect(last).toBe(429);
    });
  });

  it('an invalid override fails boot', async () => {
    await expect(startTestApp({ RATE_LIMIT_OVERRIDES: 'auth.register=zero' })).rejects.toThrow(/RATE_LIMIT_OVERRIDES/);
  });
});
