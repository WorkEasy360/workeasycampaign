import { describe, expect, it } from 'vitest';
import { loadConfig } from './env.js';
import { parseTrustProxy } from './trust-proxy.js';

const base = { DATABASE_URL: 'postgresql://x', IDENTITY_DATABASE_URL: 'postgresql://y' };
const prod = {
  ...base,
  NODE_ENV: 'production',
  APP_URL: 'https://app.example.com',
  SESSION_SECRET: 'a'.repeat(48),
  DATA_FINGERPRINT_SECRET: 'b'.repeat(48),
  FILE_STORE_DIR: '/var/lib/workeasy/files',
  TRUST_PROXY: '1',
  REDIS_URL: 'redis://r',
  MAIL_TRANSPORT: 'smtp',
  MAIL_FROM: 'x@example.com',
};

describe('configuration fails closed', () => {
  it('treats a missing NODE_ENV as production and refuses to start without secrets', () => {
    expect(() => loadConfig({ ...base })).toThrow(/SESSION_SECRET is required in production/);
  });

  it.each(['APP_URL', 'SESSION_SECRET', 'DATA_FINGERPRINT_SECRET', 'FILE_STORE_DIR', 'TRUST_PROXY', 'REDIS_URL', 'MAIL_FROM'])(
    'production refuses to start without %s',
    (key) => {
      const env: Record<string, string> = { ...prod };
      delete env[key];
      expect(() => loadConfig(env)).toThrow(new RegExp(`${key} is required in production`));
    },
  );

  it('rejects the development secret, file mail and plain http in production', () => {
    expect(() => loadConfig({ ...prod, SESSION_SECRET: 'development-only-session-secret-do-not-use-in-production-0000' })).toThrow(
      /development secret/,
    );
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: 'file' })).toThrow(/smtp/);
    expect(() => loadConfig({ ...prod, APP_URL: 'http://app.example.com' })).toThrow(/https/);
  });

  it('uses __Host- secure cookies in production and explicit dev defaults only in development', () => {
    expect(loadConfig(prod).cookies).toEqual({ secure: true, sessionName: '__Host-wk_session', csrfName: '__Host-wk_csrf' });
    const dev = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(dev.cookies.secure).toBe(false);
    expect(dev.trustProxy).toEqual(['loopback']);
    expect(dev.mail.transport).toBe('file');
  });

  it('rejects short secrets in every environment', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', SESSION_SECRET: 'short' })).toThrow(/at least 32/);
  });
});

describe('TRUST_PROXY parsing', () => {
  it('never accepts "true"', () => {
    expect(() => parseTrustProxy('true')).toThrow(/trust X-Forwarded-For from anyone/);
  });
  it('accepts false, hop counts, addresses, CIDRs and keywords', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8, loopback,2001:db8::1')).toEqual(['10.0.0.0/8', 'loopback', '2001:db8::1']);
  });
  it('rejects garbage, zero hops and over-broad CIDRs', () => {
    expect(() => parseTrustProxy('0')).toThrow();
    expect(() => parseTrustProxy('everyone')).toThrow();
    expect(() => parseTrustProxy('0.0.0.0/0')).toThrow();
  });
});
