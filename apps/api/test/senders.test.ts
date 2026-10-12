import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAppConnection } from '@workeasy/db/testing';
import type { DnsResolver } from '../src/modules/campaigns/domain/deliverability.js';
import { type Agent, createOrg, inviteAndAccept, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Sending domains and sender identities (Phase 7.8b; campaign amendment §S) through the real HTTP stack, with a
 * deterministic DNS double: verified only from DNS records, an outage never downgrades, identities usable only on a
 * verified domain, readiness, permissions, tenancy and audit.
 */
describe('sending domains and sender identities', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  const records = new Map<string, string[] | 'servfail'>();
  const dns: DnsResolver = {
    async txt(name) {
      const r = records.get(name);
      if (r === 'servfail') throw new Error('SERVFAIL');
      return r ?? null;
    },
    async cname() {
      return null;
    },
  };
  const D = (p = '', ws = W) => `/v1/workspaces/${ws}/sending-domains${p}`;
  const I = (p = '', ws = W) => `/v1/workspaces/${ws}/sender-identities${p}`;
  const publish = (domain: string, token: string) => {
    records.set(`_workeasy.${domain}`, [`workeasy-verification=${token}`]);
    records.set(domain, ['v=spf1 include:mailgun.org ~all']);
    records.set(`mx._domainkey.${domain}`, ['k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ']);
    records.set(`_dmarc.${domain}`, ['v=DMARC1; p=none']);
  };
  const tokenOf = (view: { records: { purpose: string; value: string }[] }) => view.records.find((r) => r.purpose === 'ownership')!.value.split('=')[1]!;

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', DELIVERY_SPF_INCLUDE: 'include:mailgun.org', DELIVERY_DKIM_SELECTOR: 'mx' }, { dnsResolver: dns });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Sender Co'));
    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('a new domain is pending with DNS guidance; verification passes only when every record is published', async () => {
    const c = await owner.post(D(), { domain: ' Mail.Acme.COM ' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ domain: 'mail.acme.com', status: 'pending', checks: null, identityCount: 0 });
    expect(c.body.records.map((r: { purpose: string; host: string }) => [r.purpose, r.host])).toEqual([
      ['ownership', '_workeasy.mail.acme.com'],
      ['spf', 'mail.acme.com'],
      ['dkim', 'mx._domainkey.mail.acme.com'],
      ['dmarc', '_dmarc.mail.acme.com'],
    ]);
    const first = await owner.post(D(`/${c.body.id}/verify`), {});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'failed', checks: { ownership: 'missing', spf: 'missing', dkim: 'missing', dmarc: 'missing' } });
    publish('mail.acme.com', tokenOf(c.body));
    const ok = await owner.post(D(`/${c.body.id}/verify`), {});
    expect(ok.body).toMatchObject({ status: 'verified', checks: { ownership: 'pass', spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
    expect(ok.body.verifiedAt).toBeTruthy();
    // A DNS outage does not downgrade it; a real record change does.
    records.set('_dmarc.mail.acme.com', 'servfail');
    expect((await owner.post(D(`/${c.body.id}/verify`), {})).body).toMatchObject({ status: 'verified', checks: { dmarc: 'error' } });
    records.set('_dmarc.mail.acme.com', []);
    expect((await owner.post(D(`/${c.body.id}/verify`), {})).body).toMatchObject({ status: 'failed', verifiedAt: null });
    const audits = await withOwnerConnection(async (cl) => (await cl.query(`SELECT action, metadata FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at`, [c.body.id])).rows);
    expect(audits.map((a) => a.action)).toEqual(['sending_domain.created', 'sending_domain.status_changed', 'sending_domain.status_changed', 'sending_domain.status_changed']);
  });

  it('domain input is validated; duplicates are a conflict', async () => {
    for (const bad of ['localhost', '10.0.0.1', 'acme', 'x.internal', 'evil.com/x']) expect((await owner.post(D(), { domain: bad })).status, bad).toBe(400);
    await owner.post(D(), { domain: 'news.acme.com' });
    expect((await owner.post(D(), { domain: 'NEWS.acme.com' })).status).toBe(409);
  });

  it('identities: verified only through their domain; the readiness of a campaign follows it', async () => {
    const d = await owner.post(D(), { domain: 'send.acme.com' });
    const id = await owner.post(I(), { domainId: d.body.id, localPart: 'news', displayName: 'Acme News', replyTo: 'hello@acme.com' });
    expect(id.status, JSON.stringify(id.body)).toBe(201);
    expect(id.body).toMatchObject({ email: 'news@send.acme.com', displayName: 'Acme News', replyTo: 'hello@acme.com', verified: false });
    expect((await owner.post(I(), { domainId: d.body.id, localPart: 'NEWS', displayName: 'Dup' })).status).toBe(409);
    for (const bad of [{ localPart: 'a@b' }, { localPart: 'x', displayName: 'Bad\r\nBcc: v@x.com' }, { localPart: '.x' }]) {
      const base = { domainId: d.body.id, localPart: 'ok', displayName: 'Ok' };
      expect((await owner.post(I(), { ...base, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }

    const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const c = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: 'Sender check', channel: 'email', topicId });
    await owner.patch(`/v1/workspaces/${W}/campaigns/${c.body.id}`, { expectedVersion: 1, sender: { senderIdentityId: id.body.id, fromName: null, replyTo: null } });
    const before = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/preflight`, {});
    expect(before.body.readinessFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SENDER_NOT_VERIFIED', severity: 'warning', message: 'The sender address is on a domain that is not verified yet' })]));
    publish('send.acme.com', tokenOf(d.body));
    await owner.post(D(`/${d.body.id}/verify`), {});
    expect((await owner.get(I())).body.data.find((x: { id: string }) => x.id === id.body.id).verified).toBe(true);
    const after = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/preflight`, {});
    expect(after.body.readinessFindings.map((f: { code: string }) => f.code)).not.toContain('SENDER_NOT_VERIFIED');
    expect(after.body.readinessFindings.map((f: { code: string }) => f.code)).not.toContain('SENDER_NOT_CONFIGURED');

    expect((await owner.delete(D(`/${d.body.id}`))).status).toBe(422); // identities still use it
    expect((await owner.delete(I(`/${id.body.id}`))).status).toBe(204);
    const gone = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/preflight`, {});
    expect(gone.body.readinessFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SENDER_NOT_VERIFIED', message: 'The chosen sender address no longer exists' })]));
    expect((await owner.delete(D(`/${d.body.id}`))).status).toBe(204);
  });

  it('viewers read but cannot change; other organizations get 404; the database hides and protects the rows', async () => {
    const d = await owner.post(D(), { domain: 'guard.acme.com' });
    expect((await viewer.get(D())).status).toBe(200);
    expect((await viewer.post(D(), { domain: 'v.acme.com' })).status).toBe(403);
    expect((await viewer.post(D(`/${d.body.id}/verify`), {})).status).toBe(403);
    expect((await outsider.post(D(`/${d.body.id}/verify`, WB), {})).status).toBe(404);
    expect((await outsider.get(D('', W))).status).toBe(404);
    const outsiderOrg = await withOwnerConnection(async (c) => (await c.query(`SELECT org_id FROM workspaces WHERE id = $1`, [WB])).rows[0].org_id as string);
    expect(await withAppConnection({ orgId: outsiderOrg, workspaceId: WB }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM sending_domains WHERE id = $1`, [d.body.id])).rows[0].n)).toBe(0);
    await expect(withAppConnection({ orgId, workspaceId: W }, (c) => c.query(`DELETE FROM sending_domains WHERE id = $1`, [d.body.id]))).rejects.toThrow(/permission denied/);
    // The runtime role cannot mark a domain verified by changing its token or domain (column grants).
    await expect(withAppConnection({ orgId, workspaceId: W }, (c) => c.query(`UPDATE sending_domains SET domain = 'other.com' WHERE id = $1`, [d.body.id]))).rejects.toThrow(/permission denied/);
  });
});
