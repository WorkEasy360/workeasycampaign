import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, emailOf, inviteAndAccept, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Row 23 — the recipient list of an execution (contract §15), implemented with the Audience Profiles port: display
 * names only (never an address), contacts.read required, tenancy, filters, keyset pagination, erasure.
 */
describe('campaign execution recipients (row 23)', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let campaignsOnly: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let campaignId: string;
  let executionId: string;
  const ids: Record<string, string> = {};
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const R = (query = '', ws = W) => url(`/${campaignId}/executions/${executionId}/recipients${query}`, ws);

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Recipients Co'));
    const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'All' })).body.id;
    const people = [
      { key: 'ann', email: 'ann@example.test', firstName: 'Ann', lastName: 'Lee', consent: true },
      { key: 'bob', email: 'bob@example.test', firstName: 'Bob', consent: true },
      { key: 'cat', email: 'cat@example.test', company: 'Cat Co', consent: false },
    ];
    for (const p of people) {
      const c = await owner.post(`/v1/workspaces/${W}/contacts`, { email: p.email, ...(p.firstName ? { firstName: p.firstName } : {}), ...(p.lastName ? { lastName: p.lastName } : {}), ...(p.company ? { company: p.company } : {}) });
      expect(c.status).toBe(201);
      ids[p.key] = c.body.id;
      if (p.consent) {
        expect((await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' })).status).toBeLessThan(300);
      }
    }
    expect((await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds: Object.values(ids) })).status).toBe(200);
    const c = await owner.post(url(), { name: 'Recipients', channel: 'email', topicId });
    campaignId = c.body.id;
    const p = await owner.patch(url(`/${campaignId}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text: 'Hi' } } }],
    });
    const s = await owner.post(url(`/${campaignId}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    executionId = s.body.currentExecution.id;
    const end = Date.now() + 30_000;
    while ((await owner.get(url(`/${campaignId}/executions/${executionId}`))).body.status !== 'completed') {
      if (Date.now() > end) throw new Error('execution did not complete');
      await new Promise((r) => setTimeout(r, 100));
    }

    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    campaignsOnly = await signUp(t, undefined, 'Campaigns only');
    const custom = await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Campaign readers', scope: 'workspace', permissions: ['campaigns.read'] });
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(campaignsOnly), organizationRoleId: await roleId(owner, orgId, 'member'), workspaces: [{ workspaceId: W, roleId: custom.body.id }] });
    expect(inv.status).toBe(201);
    expect((await campaignsOnly.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(campaignsOnly), 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('lists every recipient with status, reasons and a display name — never an address', async () => {
    const r = await viewer.get(R());
    expect(r.status).toBe(200);
    const byContact = Object.fromEntries(r.body.data.map((x: { contact: { id: string } }) => [x.contact.id, x]));
    expect(byContact[ids.ann!]).toMatchObject({ contact: { displayName: 'Ann Lee' }, status: 'sent', reasonCodes: [] });
    expect(byContact[ids.bob!]).toMatchObject({ contact: { displayName: 'Bob' }, status: 'sent' });
    expect(byContact[ids.cat!]).toMatchObject({ contact: { displayName: 'Cat Co' }, status: 'skipped' });
    expect(byContact[ids.cat!].reasonCodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/@example\.test/);
    expect(r.body.nextCursor).toBeNull();
  });

  it('filters by status and reason; pages by keyset', async () => {
    expect((await viewer.get(R('?status=sent'))).body.data.map((x: { status: string }) => x.status)).toEqual(['sent', 'sent']);
    const reason = (await viewer.get(R('?status=skipped'))).body.data[0].reasonCodes[0];
    expect((await viewer.get(R(`?reason=${reason}`))).body.data.map((x: { contact: { id: string } }) => x.contact.id)).toEqual([ids.cat]);
    const first = await viewer.get(R('?limit=2'));
    expect(first.body.data).toHaveLength(2);
    const second = await viewer.get(R(`?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`));
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.data, ...second.body.data].map((x: { id: string }) => x.id)).size).toBe(3);
    expect((await viewer.get(R('?reason=lower_case'))).status).toBe(400);
    // A reason this (finished) execution never had: empty, answered from its authoritative counts.
    expect((await viewer.get(R('?reason=NO_SUCH_REASON'))).body).toEqual({ data: [], nextCursor: null });
    // A reason only skipped rows carry, combined with a status that never has one: empty.
    expect((await viewer.get(R(`?reason=${reason}&status=sent`))).body.data).toEqual([]);
    expect((await viewer.get(R(`?reason=${reason}&status=skipped`))).body.data.map((x: { contact: { id: string } }) => x.contact.id)).toEqual([ids.cat]);
    expect((await viewer.get(R('?limit=101'))).status).toBe(400);
    const forged = (id: string) => encodeURIComponent(Buffer.from(JSON.stringify({ t: '2026-10-08T00:00:00.000Z', id })).toString('base64url'));
    for (const bad of ["x' OR 1=1 --", 'not-a-uuid']) expect((await viewer.get(R(`?cursor=${forged(bad)}`))).status).toBe(400);
    expect((await viewer.get(R('?cursor=%%%garbage'))).status).toBe(400);
  });

  it('needs contacts.read (audited denial); other workspaces and other campaigns get 404', async () => {
    const denied = await campaignsOnly.get(R());
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('Ann');
    const audit = await withOwnerConnection(async (c) => (await c.query(`SELECT metadata FROM audit_logs WHERE org_id = $1 AND action = 'access.denied' ORDER BY occurred_at DESC LIMIT 1`, [orgId])).rows[0]);
    expect(audit.metadata).toMatchObject({ permission: 'contacts.read', operation: 'campaign.recipients' });
    expect((await outsider.get(R('', WB))).status).toBe(404);
    expect((await outsider.get(R())).status).toBe(404);
    const other = await owner.post(url(), { name: 'Other', channel: 'email' });
    expect((await owner.get(url(`/${other.body.id}/executions/${executionId}/recipients`))).status).toBe(404);
  });

  it('an erased contact stays listed (pseudonymous row) as "Erased contact"', async () => {
    expect((await owner.post(`/v1/workspaces/${W}/contacts/${ids.bob}/erase`, { confirm: 'ERASE' })).status).toBe(204);
    const r = await viewer.get(R());
    expect(r.body.data.find((x: { contact: { id: string } }) => x.contact.id === ids.bob).contact.displayName).toBe('Erased contact');
    expect(JSON.stringify(r.body)).not.toContain('Bob');
  });
});
