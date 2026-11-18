/**
 * Sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md), end to end against a fake provider whose keys are
 * generated when it starts (test/workeasy360-fake-provider.ts): the real API, the real guards, the real database,
 * and real HTTP between the API and the provider (discovery, key set, token, entitlement).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkOrganization, linkUser, moveIssuer, OperatorError, unlinkOrganization } from '@workeasy/db/operator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeWorkeasy360, type FakePerson } from './workeasy360-fake-provider.js';
import { Agent, APP_ORIGIN, createOrg, emailOf, PASSWORD, resetTestDatabase, signUp, startTestApp, type TestApp, userIdOf, withOwnerConnection } from './support.js';

const CLIENT_ID = 'campaign-test-client';
const REDIRECT_URI = `${APP_ORIGIN}/api/v1/auth/workeasy360/callback`;

let fake: FakeWorkeasy360;
let env: Record<string, string>;
/** The entitlement cache's clock in both app instances (tokens are always checked against the real clock). */
let clock = Date.now();
let a: TestApp;
let b: TestApp;

beforeAll(async () => {
  await resetTestDatabase();
  fake = await FakeWorkeasy360.start();
  const keys = await fake.registerClient(CLIENT_ID, [REDIRECT_URI]);
  const dir = mkdtempSync(join(tmpdir(), 'w360-campaign-'));
  const keyFile = join(dir, 'client.pem');
  writeFileSync(keyFile, keys.privateKeyPem, { mode: 0o600 });
  env = {
    WORKEASY360_ISSUER: fake.issuer,
    WORKEASY360_CLIENT_ID: CLIENT_ID,
    WORKEASY360_KEY_ID: keys.keyId,
    WORKEASY360_PRIVATE_KEY_FILE: keyFile,
  };
  // Two API instances sharing one database, as in production behind a load balancer.
  a = await startTestApp(env, { workeasy360: { cacheNow: () => clock } });
  b = await startTestApp(env, { workeasy360: { cacheNow: () => clock } });
});
afterAll(async () => {
  await a?.close();
  await b?.close();
  await fake?.stop();
});
beforeEach(() => {
  fake.tampering = {};
  fake.authorizeError = undefined;
  fake.entitlement = (organizationId) => ({
    status: 200,
    body: { decision: 'allow', reason: 'entitled', product_code: fake.productCode, organization_id: organizationId, write_allowed: true, revalidate_after: 900 },
  });
});

function person(overrides: Partial<FakePerson> = {}): FakePerson {
  const sub = randomUUID();
  return { sub, email: `p-${sub.slice(0, 8)}@example.test`, emailVerified: true, name: 'Pat Example', organizationId: randomUUID(), organizationName: 'Acme Marketing', sid: randomUUID(), ...overrides };
}

interface SignInResult {
  status: number;
  location: string;
  ssoError: string | null;
  reason: string | null;
  /** The provider authorization request as the browser was sent to it. */
  authorize: URL | null;
}

/** start → (browser follows to the provider) → callback, on instance `t`, as one browser (`agent`). */
async function signIn(t: TestApp, agent: Agent, opts: { organization?: string; next?: string; beforeCallback?: (callback: URL) => Promise<void> | void } = {}): Promise<SignInResult> {
  const q = new URLSearchParams();
  if (opts.organization) q.set('organization', opts.organization);
  if (opts.next) q.set('next', opts.next);
  const start = await agent.get(`/v1/auth/workeasy360/start${q.size ? `?${q}` : ''}`);
  const startLocation = String(start.headers.location ?? '');
  if (start.status !== 302 || !startLocation.startsWith(fake.issuer)) return outcome(start.status, startLocation, null);
  const authorize = new URL(startLocation);
  const provider = await fetch(authorize, { redirect: 'manual' });
  const back = new URL(provider.headers.get('location') ?? '');
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  await opts.beforeCallback?.(back);
  const callback = await agent.get(`/v1/auth/workeasy360/callback${back.search}`);
  return outcome(callback.status, String(callback.headers.location ?? ''), authorize);
}

function outcome(status: number, location: string, authorize: URL | null): SignInResult {
  const u = location ? new URL(location, APP_ORIGIN) : null;
  return { status, location, ssoError: u?.searchParams.get('sso_error') ?? null, reason: u?.searchParams.get('reason') ?? null, authorize };
}

async function signedIn(t: TestApp, p: FakePerson, opts: { organization?: string } = {}) {
  fake.person = p;
  const agent = new Agent(t);
  const r = await signIn(t, agent, opts);
  expect(r.ssoError, r.location).toBeNull();
  expect(r.status).toBe(303);
  return agent;
}

/** The same browser (cookies) against another instance. */
function sameBrowser(agent: Agent, t: TestApp): Agent {
  const other = new Agent(t, agent.ip);
  const session = agent.cookie('wk_session');
  if (session) other.setCookie('wk_session', session);
  return other;
}

const orgIdOf = async (agent: Agent) => (await agent.get('/v1/organizations')).body.data[0].id as string;

function postLogoutToken(t: TestApp, token: string) {
  return new Agent(t).request('POST', '/v1/auth/workeasy360/backchannel-logout', undefined, {
    csrf: false,
    raw: { body: new URLSearchParams({ logout_token: token }).toString(), contentType: 'application/x-www-form-urlencoded' },
  });
}

describe('sign-in: the happy path', () => {
  it('signs in with code + PKCE S256 + private_key_jwt, creates the organization, and opens a bound session', async () => {
    const p = person();
    fake.person = p;
    const agent = new Agent(a);
    const r = await signIn(a, agent, { organization: p.organizationId!, next: '/campaigns' });
    expect([r.status, r.location]).toEqual([303, `${APP_ORIGIN}/campaigns`]);

    // The authorization request: code flow, PKCE S256, state, nonce, the launcher's organization.
    const q = r.authorize!.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toBeTruthy();
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('organization')).toBe(p.organizationId);
    expect(q.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['openid', 'email']));

    // The code exchange: private_key_jwt with aud = the token endpoint (not the issuer), iss = sub = client id, 60 s.
    const exchange = fake.seen.token.at(-1)!;
    expect(exchange.form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(exchange.form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(exchange.assertion.aud).toBe(fake.tokenEndpoint);
    expect([exchange.assertion.iss, exchange.assertion.sub]).toEqual([CLIENT_ID, CLIENT_ID]);
    expect(exchange.assertion.exp! - exchange.assertion.iat!).toBeLessThanOrEqual(60);
    expect(exchange.assertion.jti).toBeTruthy();
    // Entitlement asked for the organization and the person, with its own client assertion.
    const asked = fake.seen.entitlement.at(-1)!;
    expect([asked.form.get('organization_id'), asked.form.get('subject')]).toEqual([p.organizationId, p.sub]);
    expect(asked.assertion.aud).toBe(fake.tokenEndpoint);

    const me = await agent.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: p.email, displayName: 'Pat Example', emailVerified: true, signInMethod: 'workeasy360' });
    const orgs = await agent.get('/v1/organizations');
    expect(orgs.body.data).toHaveLength(1);
    expect(orgs.body.data[0]).toMatchObject({ name: 'Acme Marketing', role: { name: 'Owner' } });
    const ctx = await agent.get('/v1/me/context');
    expect(ctx.body.organization.id).toBe(orgs.body.data[0].id);
    expect(ctx.body.workspace.name).toBe('Main');

    const row = await withOwnerConnection(async (c) => (await c.query(
      `SELECT s.provider, s.workeasy360_issuer, s.workeasy360_subject, s.workeasy360_sid, s.workeasy360_organization_id, s.bound_org_id,
              o.workeasy360_organization_id AS link, i.issuer AS identity_issuer
         FROM sessions s JOIN organizations o ON o.id = s.bound_org_id
         JOIN user_identities i ON i.user_id = s.user_id AND i.provider = 'workeasy360'
        WHERE s.workeasy360_subject = $1`, [p.sub])).rows[0]);
    expect(row).toEqual({
      provider: 'workeasy360', workeasy360_issuer: fake.issuer, workeasy360_subject: p.sub, workeasy360_sid: p.sid,
      workeasy360_organization_id: p.organizationId, bound_org_id: orgs.body.data[0].id, link: p.organizationId, identity_issuer: fake.issuer,
    });
  });

  it('a second person of the same WorkEasy360 organization joins that organization with the default role', async () => {
    const owner = person();
    const first = await signedIn(a, owner);
    const orgId = await orgIdOf(first);
    const colleague = await signedIn(a, person({ organizationId: owner.organizationId, organizationName: 'Ignored Name' }));
    const orgs = await colleague.get('/v1/organizations');
    expect(orgs.body.data).toEqual([expect.objectContaining({ id: orgId, name: 'Acme Marketing', role: expect.objectContaining({ name: 'Member' }) })]);
    // ...and a viewer of the first workspace.
    const ctx = await colleague.get('/v1/me/context');
    expect(ctx.body.workspace.name).toBe('Main');
    expect(ctx.body.permissions).toContain('workspace.read');
    expect(ctx.body.permissions).not.toContain('campaigns.create');
  });

  it('the same person signing in again keeps the same account and role', async () => {
    const p = person();
    const first = await signedIn(a, p);
    const again = await signedIn(b, p);
    expect(await userIdOf(again)).toBe(await userIdOf(first));
    expect((await again.get('/v1/organizations')).body.data[0].role.name).toBe('Owner');
  });

  it('a sign-in in a browser that already has a session ends that session first', async () => {
    const agent = await signedIn(a, person());
    const before = agent.cookie('wk_session')!;
    fake.person = person();
    const r = await signIn(a, agent);
    expect(r.ssoError).toBeNull();
    const stale = new Agent(a);
    stale.setCookie('wk_session', before);
    expect((await stale.get('/v1/me')).status).toBe(401);
  });

  it('never sends anyone back to another site after signing in', async () => {
    fake.person = person();
    const r = await signIn(a, new Agent(a), { next: '//evil.example/x' });
    expect(r.location).toBe(`${APP_ORIGIN}/dashboard`);
  });
});

describe('sign-in: the ID token and the flow are checked strictly', () => {
  const refused = async (tampering: typeof fake.tampering) => {
    fake.person = person();
    fake.tampering = tampering;
    const agent = new Agent(a);
    const r = await signIn(a, agent);
    expect(agent.cookie('wk_session')).toBeUndefined();
    expect((await agent.get('/v1/me')).status).toBe(401);
    return r;
  };

  it('refuses a token from another issuer', async () => {
    expect((await refused({ issuer: 'https://evil.example' })).ssoError).toBe('invalid_token');
  });
  it('refuses a token for another audience', async () => {
    expect((await refused({ audience: 'another-product' })).ssoError).toBe('invalid_token');
  });
  it('refuses a token signed with a key that is not in the key set (same kid)', async () => {
    expect((await refused({ foreignKey: true })).ssoError).toBe('invalid_token');
  });
  it('refuses a token answering another request (nonce)', async () => {
    expect((await refused({ nonce: 'someone-elses-nonce' })).ssoError).toBe('invalid_token');
  });
  it('refuses an access token presented as an ID token (typ)', async () => {
    expect((await refused({ typ: 'at+jwt' })).ssoError).toBe('invalid_token');
  });
  it('refuses a token for another product', async () => {
    expect((await refused({ productCode: 'easy_crm' })).ssoError).toBe('wrong_product');
  });
  it('refuses a token without an organization', async () => {
    fake.person = person({ organizationId: undefined });
    const r = await signIn(a, new Agent(a));
    expect(r.ssoError).toBe('no_organization');
  });
  it('refuses an unverified email', async () => {
    expect((await refused({ claims: { email_verified: false } })).ssoError).toBe('email_unverified');
  });
  it('refuses a token for another organization than the launcher asked for', async () => {
    const p = person();
    fake.person = p;
    fake.tampering = { claims: { organization_id: randomUUID() } };
    const agent = new Agent(a);
    const r = await signIn(a, agent, { organization: p.organizationId! });
    expect(r.ssoError).toBe('wrong_organization');
    expect(agent.cookie('wk_session')).toBeUndefined();
  });

  it('PKCE: the challenge is S256 of the verifier, and a code exchanged without that verifier is refused', async () => {
    fake.person = person();
    const agent = new Agent(a);
    const r = await signIn(a, agent, {
      beforeCallback: async () => {
        // Prove the stored verifier is what the challenge was computed from, then break it.
        await withOwnerConnection(async (c) => {
          const flow = (await c.query(`SELECT code_verifier FROM workeasy360_login_flows ORDER BY created_at DESC LIMIT 1`)).rows[0];
          const challenge = createHash('sha256').update(flow.code_verifier).digest('base64url');
          expect(fake.seen.authorize.at(-1)!.get('code_challenge')).toBe(challenge);
          await c.query(`UPDATE workeasy360_login_flows SET code_verifier = $1`, ['x'.repeat(43)]);
        });
      },
    });
    expect(r.ssoError).toBe('expired'); // invalid_grant from the token endpoint
    expect(agent.cookie('wk_session')).toBeUndefined();
  });

  it('the provider refuses an authorization request without PKCE', async () => {
    const res = await fetch(`${fake.issuer}/api/v1/integrations/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: 'openid', state: 's' })}`, { redirect: 'manual' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('a flow is used once: replaying the callback, or a callback without this browser\'s flow, is refused', async () => {
    fake.person = person();
    const agent = new Agent(a);
    let callback: URL | undefined;
    const first = await signIn(a, agent, { beforeCallback: (u) => void (callback = u) });
    expect(first.ssoError).toBeNull();
    const replay = await agent.get(`/v1/auth/workeasy360/callback${callback!.search}`);
    expect(new URL(String(replay.headers.location)).searchParams.get('sso_error')).toBe('expired');
    const stranger = await new Agent(a).get(`/v1/auth/workeasy360/callback${callback!.search}`);
    expect(new URL(String(stranger.headers.location)).searchParams.get('sso_error')).toBe('expired');
  });

  it('a callback with another state is refused (login CSRF)', async () => {
    fake.person = person();
    const agent = new Agent(a);
    const r = await signIn(a, agent, {
      beforeCallback: (u) => {
        u.searchParams.set('state', 'not-this-browsers-state');
      },
    });
    // The URL object passed is the one used: state was replaced.
    expect(r.ssoError).toBe('expired');
    expect(agent.cookie('wk_session')).toBeUndefined();
  });

  it('shows the provider\'s refusal (the person cancelled)', async () => {
    fake.person = person();
    fake.authorizeError = 'access_denied';
    const r = await signIn(a, new Agent(a));
    expect(r.ssoError).toBe('cancelled');
  });
});

describe('entitlement', () => {
  it('a sign-in for an organization that is not entitled is refused, with the reason', async () => {
    fake.person = person();
    fake.entitlement = () => ({ status: 200, body: { decision: 'deny', reason: 'not_entitled', write_allowed: false, revalidate_after: 900 } });
    const agent = new Agent(a);
    const r = await signIn(a, agent);
    expect([r.ssoError, r.reason]).toEqual(['not_entitled', 'not_entitled']);
    expect(agent.cookie('wk_session')).toBeUndefined();
  });

  it('a refusal of this product\'s client fails closed at sign-in', async () => {
    fake.person = person();
    fake.entitlement = () => ({ status: 401, body: { error: 'invalid_client' } });
    const r = await signIn(a, new Agent(a));
    expect(r.ssoError).toBe('access_unverified');
    clock += 61_000; // past the 60 s refusal window, so later tests ask again
  });

  it('is re-checked on the platform\'s cadence (revalidate_after), with read-only and denial honoured, and outages tolerated', async () => {
    const p = person();
    const agent = await signedIn(a, p);
    const orgId = await orgIdOf(agent);
    const ws = (await agent.get('/v1/me/context')).body.workspace.id as string;

    // Denied now, but the cached allow stands until revalidate_after (900 s).
    fake.entitlement = () => ({ status: 200, body: { decision: 'deny', reason: 'expired', write_allowed: false, revalidate_after: 900 } });
    expect((await agent.get(`/v1/organizations/${orgId}`)).status).toBe(200);
    clock += 901_000;
    const ended = await agent.get(`/v1/organizations/${orgId}`);
    expect([ended.status, ended.body.error.code, ended.body.error.reason]).toEqual([403, 'workeasy360_access_ended', 'expired']);
    // The session itself stays valid: the person sees why, and can sign out.
    expect((await agent.get('/v1/me')).status).toBe(200);
    // The other instance agrees (the answer is shared in PostgreSQL).
    expect((await sameBrowser(agent, b).get(`/v1/workspaces/${ws}`)).status).toBe(403);

    // A denial is asked again after 60 s: renewed, read-only.
    fake.entitlement = () => ({ status: 200, body: { decision: 'allow', reason: 'entitled', write_allowed: false, revalidate_after: 900 } });
    clock += 61_000;
    expect((await agent.get(`/v1/workspaces/${ws}`)).status).toBe(200);
    const write = await agent.patch(`/v1/organizations/${orgId}`, { name: 'Renamed', version: 1 });
    expect([write.status, write.body.error.code]).toEqual([403, 'workeasy360_read_only']);

    // An outage is never a denial: the last answer stands.
    fake.entitlement = () => ({ status: 503, body: { error: 'temporarily_unavailable' } });
    clock += 901_000;
    expect((await agent.get(`/v1/workspaces/${ws}`)).status).toBe(200);

    // A refusal of the client fails closed for everyone, at once.
    fake.entitlement = () => ({ status: 401, body: { error: 'invalid_client' } });
    clock += 61_000;
    const unverified = await agent.get(`/v1/workspaces/${ws}`);
    expect([unverified.status, unverified.body.error.code]).toEqual([403, 'workeasy360_access_unverified']);
    fake.entitlement = (organizationId) => ({ status: 200, body: { decision: 'allow', reason: 'entitled', organization_id: organizationId, write_allowed: true, revalidate_after: 900 } });
    clock += 61_000;
    expect((await agent.get(`/v1/workspaces/${ws}`)).status).toBe(200);
  });

  it('a person removed in WorkEasy360 loses access on the next check (subject sent)', async () => {
    const p = person();
    const agent = await signedIn(a, p);
    const orgId = await orgIdOf(agent);
    fake.entitlement = (_org, subject) =>
      subject === p.sub
        ? { status: 200, body: { decision: 'deny', reason: 'membership_inactive', write_allowed: false, revalidate_after: 900 } }
        : { status: 200, body: { decision: 'allow', reason: 'entitled', write_allowed: true, revalidate_after: 900 } };
    clock += 901_000;
    const r = await agent.get(`/v1/organizations/${orgId}`);
    expect([r.status, r.body.error.reason]).toEqual([403, 'membership_inactive']);
  });
});

describe('organizations: a WorkEasy360 session never crosses organizations', () => {
  it('reaches only the organization its token named', async () => {
    const p = person();
    const inA = await signedIn(a, p);
    const orgA = await orgIdOf(inA);
    // The same person, signed in for another WorkEasy360 organization in another browser.
    const inB = await signedIn(a, { ...p, organizationId: randomUUID(), organizationName: 'Other Co', sid: randomUUID() });
    const orgB = await orgIdOf(inB);
    const wsB = (await inB.get('/v1/me/context')).body.workspace.id as string;
    expect(orgB).not.toBe(orgA);

    // From the session for A, B does not exist, although the person is B's owner.
    expect((await inA.get(`/v1/organizations/${orgB}`)).status).toBe(404);
    expect((await inA.get(`/v1/workspaces/${wsB}`)).status).toBe(404);
    expect((await inA.get('/v1/organizations')).body.data.map((o: { id: string }) => o.id)).toEqual([orgA]);
    expect((await inA.put('/v1/me/context', { organizationId: orgB, workspaceId: null })).status).toBe(404);
    expect((await inA.get(`/v1/me/context?organizationId=${orgB}`)).body.organization.id).toBe(orgA);
    // Organizations come from WorkEasy360.
    const create = await inA.post('/v1/organizations', { name: 'Side project', workspace: { name: 'Main' } });
    expect([create.status, create.body.error.code]).toEqual([403, 'workeasy360_organization_managed']);
  });

  it('an organization suspended here is not signed in to; a removed member rejoins, a suspended one does not', async () => {
    const owner = person();
    const ownerAgent = await signedIn(a, owner);
    const orgId = await orgIdOf(ownerAgent);
    const colleague = person({ organizationId: owner.organizationId });
    const colleagueAgent = await signedIn(a, colleague);
    const colleagueId = await userIdOf(colleagueAgent);
    const member = (await ownerAgent.get(`/v1/organizations/${orgId}/members`)).body.data.find((m: { userId: string }) => m.userId === colleagueId);

    const suspend = await ownerAgent.patch(`/v1/organizations/${orgId}/members/${colleagueId}`, { status: 'suspended', version: member.version });
    expect(suspend.status).toBe(204);
    expect((await colleagueAgent.get(`/v1/organizations/${orgId}`)).status).toBe(404);
    fake.person = colleague;
    expect((await signIn(a, new Agent(a))).ssoError).toBe('membership_suspended');

    await withOwnerConnection((c) => c.query(`UPDATE organization_memberships SET status = 'removed', removed_at = now() WHERE org_id = $1 AND user_id = $2`, [orgId, colleagueId]));
    const back = await signedIn(a, colleague);
    expect((await back.get(`/v1/organizations/${orgId}`)).body.role.name).toBe('Member');

    await withOwnerConnection((c) => c.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [orgId]));
    fake.person = colleague;
    expect((await signIn(a, new Agent(a))).ssoError).toBe('organization_unavailable');
    await withOwnerConnection((c) => c.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [orgId]));
  });
});

describe('back-channel logout', () => {
  it('a valid logout token (sid) ends that session on every instance at once; 200', async () => {
    const p = person();
    const agent = await signedIn(a, p);
    const onB = sameBrowser(agent, b);
    expect((await onB.get('/v1/me')).status).toBe(200);
    // Delivered to instance B; refused at once on A and B.
    const r = await postLogoutToken(b, await fake.logoutToken(CLIENT_ID, { sub: p.sub, sid: p.sid }));
    expect(r.status).toBe(200);
    expect((await agent.get('/v1/me')).status).toBe(401);
    expect((await onB.get('/v1/me')).status).toBe(401);
  });

  it('a token naming only the person (sub) ends all of that person\'s sessions; another person is untouched', async () => {
    const p = person();
    const one = await signedIn(a, p);
    const two = await signedIn(b, { ...p, sid: randomUUID() });
    const bystander = await signedIn(a, person());
    expect((await postLogoutToken(a, await fake.logoutToken(CLIENT_ID, { sub: p.sub }))).status).toBe(200);
    expect((await one.get('/v1/me')).status).toBe(401);
    expect((await two.get('/v1/me')).status).toBe(401);
    expect((await bystander.get('/v1/me')).status).toBe(200);
  });

  it('a duplicate delivery answers 200 and a replayed jti changes nothing', async () => {
    const p = person();
    await signedIn(a, p);
    const token = await fake.logoutToken(CLIENT_ID, { sub: p.sub, jti: randomUUID() });
    expect((await postLogoutToken(a, token)).status).toBe(200);
    // The person signs in again; the same token delivered again (a replay) must not end the new session.
    const again = await signedIn(a, { ...p, sid: randomUUID() });
    expect((await postLogoutToken(b, token)).status).toBe(200);
    expect((await again.get('/v1/me')).status).toBe(200);
  });

  const forgeries: [string, Parameters<FakeWorkeasy360['logoutToken']>[1]][] = [
    ['signed with another key', { foreignKey: true }],
    ['from another issuer', { issuer: 'https://evil.example' }],
    ['for another audience', { audience: 'another-product' }],
    ['with the wrong typ', { typ: 'JWT' }],
    ['without the back-channel logout event', { withoutEvent: true }],
    ['carrying a nonce', { nonce: 'n-1' }],
    ['issued too long ago', { issuedAt: Math.floor(Date.now() / 1000) - 3600 }],
  ];
  for (const [name, options] of forgeries) {
    it(`a token ${name} is refused with 400 and ends nothing`, async () => {
      const p = person();
      const agent = await signedIn(a, p);
      const r = await postLogoutToken(a, await fake.logoutToken(CLIENT_ID, { sub: p.sub, sid: p.sid, ...options }));
      expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
      expect((await agent.get('/v1/me')).status).toBe(200);
    });
  }

  it('a token naming neither sub nor sid, a missing token, an ID token, or JSON is refused with 400', async () => {
    expect((await postLogoutToken(a, await fake.logoutToken(CLIENT_ID, {}))).status).toBe(400);
    expect((await postLogoutToken(a, '')).status).toBe(400);
    expect((await postLogoutToken(a, await fake.signIdToken(CLIENT_ID, { sub: 'x', typ: 'id_token', nonce: 'n' }))).status).toBe(400);
    const json = await new Agent(a).request('POST', '/v1/auth/workeasy360/backchannel-logout', { logout_token: 'x' }, { csrf: false });
    expect(json.status).toBe(400);
  });
});

describe('signing out', () => {
  it('product sign-out ends the Campaign session only', async () => {
    const agent = await signedIn(a, person());
    const before = fake.seen.endSession.length;
    const r = await agent.post('/v1/auth/logout');
    expect([r.status, r.body.redirectUrl]).toEqual([200, null]);
    expect((await agent.get('/v1/me')).status).toBe(401);
    expect(fake.seen.endSession.length).toBe(before);
  });

  it('"sign out of WorkEasy360 too" ends the session, then hands the browser to end_session_endpoint with id_token_hint', async () => {
    const p = person();
    const agent = await signedIn(a, p);
    const r = await agent.post('/v1/auth/logout?workeasy360=true');
    expect(r.status).toBe(200);
    const url = new URL(r.body.redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.issuer}/api/v1/integrations/oauth/logout`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${APP_ORIGIN}/login`);
    const hint = url.searchParams.get('id_token_hint')!;
    expect(JSON.parse(Buffer.from(hint.split('.')[1]!, 'base64url').toString()).sub).toBe(p.sub);
    expect((await agent.get('/v1/me')).status).toBe(401);
  });

  it('a password session asking for WorkEasy360 sign-out gets no provider URL', async () => {
    const agent = await signUp(a);
    const r = await agent.post('/v1/auth/logout?workeasy360=true');
    expect([r.status, r.body.redirectUrl]).toEqual([200, null]);
  });
});

describe('existing accounts: never merged by email', () => {
  it('a WorkEasy360 sign-in whose email belongs to a password account is refused until an operator links them', async () => {
    const local = await signUp(a);
    const localId = await userIdOf(local);
    const { orgId } = await createOrg(local, 'Legacy Co');
    const p = person({ email: emailOf(local) });
    fake.person = p;
    const r = await signIn(a, new Agent(a));
    expect(r.ssoError).toBe('account_exists');
    const users = await withOwnerConnection(async (c) => (await c.query(`SELECT count(*)::int AS n FROM users WHERE email_normalized = lower($1)`, [p.email])).rows[0].n);
    expect(users).toBe(1);

    // The operator vouches for the person and links the organization: the password account carries over.
    await withOwnerConnection(async (c) => {
      await linkUser(c, localId, p.sub, fake.issuer);
      await linkOrganization(c, orgId, p.organizationId!);
    });
    const agent = await signedIn(a, p);
    expect(await userIdOf(agent)).toBe(localId);
    expect((await agent.get('/v1/organizations')).body.data).toEqual([expect.objectContaining({ id: orgId, role: expect.objectContaining({ name: 'Owner' }) })]);
    // Password sign-in still works for the linked account (SSO-only is off).
    expect((await new Agent(a).post('/v1/auth/login', { email: emailOf(local), password: PASSWORD })).status).toBe(200);
  });

  it('operator commands refuse to re-point or merge', async () => {
    const one = await signedIn(a, person());
    const two = await signedIn(a, person());
    const [orgOne, orgTwo] = [await orgIdOf(one), await orgIdOf(two)];
    const linkOfTwo = await withOwnerConnection(async (c) => (await c.query(`SELECT workeasy360_organization_id AS w FROM organizations WHERE id = $1`, [orgTwo])).rows[0].w);
    const [userOne, userTwo] = [await userIdOf(one), await userIdOf(two)];
    await withOwnerConnection(async (c) => {
      const subjectOfTwo = (await c.query(`SELECT subject FROM user_identities WHERE user_id = $1`, [userTwo])).rows[0].subject as string;
      // An organization is never re-pointed, and a WorkEasy360 organization never gets a second organization here.
      await expect(linkOrganization(c, orgOne, randomUUID())).rejects.toThrow(OperatorError);
      await expect(linkOrganization(c, orgOne, linkOfTwo)).rejects.toThrow(/already linked/);
      // Two accounts are never merged: a WorkEasy360 person with an account here cannot be linked to another one.
      await expect(linkUser(c, userOne, subjectOfTwo, fake.issuer)).rejects.toThrow(/already belongs/);
    });
    // Unlinking ends that organization's WorkEasy360 sessions.
    const r = await withOwnerConnection((c) => unlinkOrganization(c, orgTwo));
    expect(r).toMatchObject({ changed: true, sessionsEnded: 1 });
    expect((await two.get('/v1/me')).status).toBe(401);
  });

  it('a subject known under another issuer is refused until the issuer move runs', async () => {
    const p = person();
    await signedIn(a, p);
    const oldIssuer = 'https://old-accounts.example';
    await withOwnerConnection((c) => c.query(`UPDATE user_identities SET issuer = $1 WHERE provider = 'workeasy360' AND subject = $2`, [oldIssuer, p.sub]));
    fake.person = p;
    expect((await signIn(a, new Agent(a))).ssoError).toBe('identity_conflict');
    const dry = await withOwnerConnection((c) => moveIssuer(c, oldIssuer, fake.issuer, false));
    expect(dry).toMatchObject({ identities: 1, applied: false });
    await withOwnerConnection((c) => moveIssuer(c, oldIssuer, fake.issuer, true));
    expect((await signIn(a, new Agent(a))).ssoError).toBeNull();
  });
});

describe('password sign-in alongside, and WORKEASY360_SSO_ONLY', () => {
  it('password sign-in keeps working by default; a password member of a linked organization is subject to its entitlement', async () => {
    const owner = await signUp(a);
    const { orgId } = await createOrg(owner, 'Linked Later');
    const w360Org = randomUUID();
    await withOwnerConnection((c) => linkOrganization(c, orgId, w360Org));
    fake.entitlement = (organizationId) =>
      organizationId === w360Org
        ? { status: 200, body: { decision: 'deny', reason: 'suspended', write_allowed: false, revalidate_after: 900 } }
        : { status: 200, body: { decision: 'allow', reason: 'entitled', write_allowed: true, revalidate_after: 900 } };
    const r = await owner.get(`/v1/organizations/${orgId}`);
    expect([r.status, r.body.error.code, r.body.error.reason]).toEqual([403, 'workeasy360_access_ended', 'suspended']);
    expect(fake.seen.entitlement.at(-1)!.form.get('subject')).toBeNull();
  });

  it('with WORKEASY360_SSO_ONLY=true, passwords are off and only WorkEasy360 sessions are accepted', async () => {
    const passwordAgent = await signUp(a);
    const ssoOnly = await startTestApp({ ...env, WORKEASY360_SSO_ONLY: 'true' }, { workeasy360: { cacheNow: () => clock } });
    try {
      const login = await new Agent(ssoOnly).post('/v1/auth/login', { email: emailOf(passwordAgent), password: PASSWORD });
      expect([login.status, login.body.error.code]).toEqual([403, 'password_sign_in_disabled']);
      const register = await new Agent(ssoOnly).post('/v1/auth/register', { email: `n-${randomUUID().slice(0, 8)}@example.test`, password: PASSWORD, displayName: 'N' });
      expect([register.status, register.body.error.code]).toEqual([403, 'password_sign_in_disabled']);
      const forgot = await new Agent(ssoOnly).post('/v1/auth/forgot-password', { email: emailOf(passwordAgent) });
      expect(forgot.status).toBe(403);
      // A password session opened before is refused at once.
      const old = sameBrowser(passwordAgent, ssoOnly);
      const me = await old.get('/v1/me');
      expect([me.status, me.body.error.code]).toEqual([401, 'workeasy360_sign_in_required']);
      // WorkEasy360 sessions work.
      const agent = await signedIn(ssoOnly, person());
      expect((await agent.get('/v1/me')).status).toBe(200);
    } finally {
      await ssoOnly.close();
    }
  });
});

describe('not configured', () => {
  it('without WORKEASY360_ISSUER the routes exist but sign-in is refused politely, and nothing else changes', async () => {
    const plain = await startTestApp();
    try {
      const start = await new Agent(plain).get('/v1/auth/workeasy360/start');
      expect([start.status, start.headers.location]).toEqual([302, `${APP_ORIGIN}/login?sso_error=not_configured`]);
      const bcl = await new Agent(plain).request('POST', '/v1/auth/workeasy360/backchannel-logout', undefined, { csrf: false, raw: { body: 'logout_token=x', contentType: 'application/x-www-form-urlencoded' } });
      expect(bcl.status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
