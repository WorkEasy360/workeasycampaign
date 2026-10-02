import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  createOrg,
  emailOf,
  PASSWORD,
  resetTestDatabase,
  signUp,
  startTestApp,
  type TestApp,
  uniqueEmail,
  withOwnerConnection,
} from './support.js';

let t: TestApp;
beforeAll(async () => {
  await resetTestDatabase();
  t = await startTestApp();
});
afterAll(async () => t?.close());

describe('registration and email verification', () => {
  it('answers identically for new and existing emails (no account enumeration)', async () => {
    const email = uniqueEmail('enum');
    const a = await new Agent(t).post('/v1/auth/register', { email, password: PASSWORD, displayName: 'A' });
    const b = await new Agent(t).post('/v1/auth/register', { email, password: PASSWORD, displayName: 'B' });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body).toEqual(b.body);
    expect(t.mailer.last(email, 'account_exists')).toBeDefined();
  });

  it('enforces the password policy server-side', async () => {
    const r = await new Agent(t).post('/v1/auth/register', { email: uniqueEmail('weak'), password: 'Password123', displayName: 'W' });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.password).toContain('This password is too common');
  });

  it('lets an unverified user sign in but not create an organization', async () => {
    const email = uniqueEmail('unverified');
    const agent = new Agent(t);
    await agent.post('/v1/auth/register', { email, password: PASSWORD, displayName: 'U' });
    const login = await agent.post('/v1/auth/login', { email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(false);
    const org = await agent.post('/v1/organizations', { name: 'X', workspace: { name: 'W' } });
    expect(org.status).toBe(403);
    expect(org.body.error.code).toBe('email_not_verified');
  });

  it('verification tokens are single-use', async () => {
    const email = uniqueEmail('once');
    const agent = new Agent(t);
    await agent.post('/v1/auth/register', { email, password: PASSWORD, displayName: 'O' });
    const token = t.mailer.tokenFrom(email, 'verify_email');
    expect((await agent.post('/v1/auth/verify-email', { token })).status).toBe(200);
    const again = await agent.post('/v1/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('token_invalid');
  });
});

describe('login', () => {
  it('returns the same error for a wrong password and an unknown email', async () => {
    const user = await signUp(t);
    const wrong = await new Agent(t).post('/v1/auth/login', { email: emailOf(user), password: 'not-the-password-1' });
    const unknown = await new Agent(t).post('/v1/auth/login', { email: uniqueEmail('nobody'), password: 'not-the-password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after 5 failures, even for the correct password', async () => {
    const user = await signUp(t);
    const email = emailOf(user);
    for (let i = 0; i < 5; i++) await new Agent(t).post('/v1/auth/login', { email, password: `wrong-password-${i}` });
    const locked = await new Agent(t).post('/v1/auth/login', { email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('account_locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('sets an HttpOnly, SameSite=Lax session cookie and never returns the token in the body', async () => {
    const email = uniqueEmail('cookie');
    const a = new Agent(t);
    await a.post('/v1/auth/register', { email, password: PASSWORD, displayName: 'C' });
    await a.post('/v1/auth/verify-email', { token: t.mailer.tokenFrom(email, 'verify_email') });
    const r = await a.post('/v1/auth/login', { email, password: PASSWORD });
    const session = r.setCookies.find((c) => c.startsWith('wk_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(r.body)).not.toContain(a.cookie('wk_session'));
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without a token', async () => {
    const user = await signUp(t);
    const r = await user.post('/v1/organizations', { name: 'X', workspace: { name: 'W' } }, { csrf: false });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf_failed');
  });

  it('rejects a token bound to a different session', async () => {
    const a = await signUp(t);
    const b = await signUp(t);
    b.setCookie('wk_csrf', a.cookie('wk_csrf')!);
    const r = await b.post('/v1/organizations', { name: 'X', workspace: { name: 'W' } });
    expect(r.body.error?.code).toBe('csrf_failed');
  });

  it('rejects cross-origin requests even with a valid token', async () => {
    const a = await signUp(t);
    const r = await a.post('/v1/organizations', { name: 'X', workspace: { name: 'W' } }, { headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf_failed');
  });
});

describe('sessions', () => {
  it('logout revokes the session server-side (replaying the old cookie fails)', async () => {
    const a = await signUp(t);
    const stolen = a.cookie('wk_session')!;
    expect((await a.post('/v1/auth/logout')).status).toBe(200);
    const replay = new Agent(t);
    replay.setCookie('wk_session', stolen);
    expect((await replay.get('/v1/me')).status).toBe(401);
  });

  it('a session revoked from another device cannot authenticate', async () => {
    const a = await signUp(t);
    const second = new Agent(t);
    await second.post('/v1/auth/login', { email: emailOf(a), password: PASSWORD });
    const sessions = (await a.get('/v1/me/sessions')).body.data as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current)!;
    expect((await a.delete(`/v1/me/sessions/${other.id}`)).status).toBe(204);
    expect((await second.get('/v1/me')).status).toBe(401);
    expect((await a.get('/v1/me')).status).toBe(200);
  });

  it('cannot revoke a session belonging to someone else', async () => {
    const a = await signUp(t);
    const b = await signUp(t);
    const bSession = (await b.get('/v1/me/sessions')).body.data[0].id;
    expect((await a.delete(`/v1/me/sessions/${bSession}`)).status).toBe(404);
    expect((await b.get('/v1/me')).status).toBe(200);
  });

  it('a deactivated user loses access on the next request', async () => {
    const a = await signUp(t);
    const id = (await a.get('/v1/me')).body.user.id;
    await withOwnerConnection((c) => c.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [id]));
    expect((await a.get('/v1/me')).status).toBe(401);
    const relogin = await new Agent(t).post('/v1/auth/login', { email: emailOf(a), password: PASSWORD });
    expect(relogin.status).toBe(401);
    expect(relogin.body.error.code).toBe('invalid_credentials');
    const sessions = await withOwnerConnection((c) => c.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [id]));
    expect(sessions.rows[0].n).toBe(1); // only the original session; none created for the deactivated user
  });

  it('changing the password signs out other sessions but keeps this one', async () => {
    const a = await signUp(t);
    const other = new Agent(t);
    await other.post('/v1/auth/login', { email: emailOf(a), password: PASSWORD });
    const r = await a.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'orchard-copper-violin-7' });
    expect(r.status).toBe(200);
    expect(r.body.otherSessionsSignedOut).toBe(1);
    expect((await other.get('/v1/me')).status).toBe(401);
    expect((await a.get('/v1/me')).status).toBe(200);
    expect((await new Agent(t).post('/v1/auth/login', { email: emailOf(a), password: PASSWORD })).status).toBe(401);
  });

  it('password reset is single-use and signs out every session', async () => {
    const a = await signUp(t);
    await new Agent(t).post('/v1/auth/forgot-password', { email: emailOf(a) });
    const token = t.mailer.tokenFrom(emailOf(a), 'reset_password');
    const reset = await new Agent(t).post('/v1/auth/reset-password', { token, password: 'harbor-sunrise-meadow-9' });
    expect(reset.status).toBe(200);
    expect((await a.get('/v1/me')).status).toBe(401);
    expect((await new Agent(t).post('/v1/auth/reset-password', { token, password: 'another-good-pass-1' })).status).toBe(400);
    expect((await new Agent(t).post('/v1/auth/login', { email: emailOf(a), password: 'harbor-sunrise-meadow-9' })).status).toBe(200);
  });

  it('forgot-password answers identically for unknown emails', async () => {
    const r = await new Agent(t).post('/v1/auth/forgot-password', { email: uniqueEmail('ghost') });
    expect(r.status).toBe(202);
  });
});

describe('client IP and proxies', () => {
  it('ignores X-Forwarded-For when no proxy is trusted (cannot spoof audit/rate-limit IP)', async () => {
    const a = await signUp(t);
    const { orgId } = await createOrg(a);
    await a.request('PATCH', `/v1/organizations/${orgId}`, { name: 'Renamed', version: 1 }, { headers: { 'x-forwarded-for': '203.0.113.66' } });
    const log = await a.get(`/v1/organizations/${orgId}/audit-logs?action=organization.updated`);
    expect(log.body.data[0].ipAddress).toBe(a.ip);
  });

  it('honours X-Forwarded-For only from a configured trusted proxy', async () => {
    const proxied = await startTestApp({ TRUST_PROXY: '198.51.100.0/24' });
    try {
      const a = await signUp(proxied);
      const { orgId } = await createOrg(a);
      await a.request('PATCH', `/v1/organizations/${orgId}`, { name: 'Renamed', version: 1 }, { headers: { 'x-forwarded-for': '203.0.113.66' } });
      const log = await a.get(`/v1/organizations/${orgId}/audit-logs?action=organization.updated`);
      expect(log.body.data[0].ipAddress).toBe('203.0.113.66');
    } finally {
      await proxied.close();
    }
  });
});

describe('rate limiting', () => {
  it('limits registrations per client IP', async () => {
    const sameClient = new Agent(t);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await sameClient.post('/v1/auth/register', { email: uniqueEmail('rl'), password: PASSWORD, displayName: 'R' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('error format', () => {
  it('uses one documented shape with a request id', async () => {
    const r = await new Agent(t).get('/v1/me');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: 'unauthenticated', message: expect.any(String), requestId: expect.any(String) } });
    expect(r.headers['x-request-id']).toBe(r.body.error.requestId);
  });
});
