import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, emailOf, resetTestDatabase, roleId, signUp, startTestApp, type TestApp } from './support.js';

/**
 * Sample recipients (Phase 7.4) through the real HTTP stack: a uniform sample of the draft's LIVE audience with current
 * eligibility, display names and reason codes only (no address anywhere in the response), contacts.read required,
 * tenancy.
 */
describe('campaign audience sample', () => {
  let t: TestApp;
  let owner: Agent;
  let campaignsOnly: Agent;
  let outsider: Agent;
  let W: string;
  let WB: string;
  let topicId: string;
  let listId: string;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    let orgId: string;
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Sample Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Customers' })).body.id;
    const add = async (email: string, firstName: string, consent: boolean) => {
      const c = await owner.post(`/v1/workspaces/${W}/contacts`, { email, firstName, lastName: 'Lee' });
      expect((await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds: [c.body.id] })).status).toBe(200);
      if (consent) expect((await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' })).status).toBeLessThan(300);
    };
    await add('ann@example.test', 'Ann', true);
    await add('bob@example.test', 'Bob', false);
    campaignsOnly = await signUp(t, undefined, 'Campaigns only');
    const role = await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Campaign readers', scope: 'workspace', permissions: ['campaigns.read'] });
    await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(campaignsOnly), organizationRoleId: await roleId(owner, orgId, 'member'), workspaces: [{ workspaceId: W, roleId: role.body.id }] });
    expect((await campaignsOnly.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(campaignsOnly), 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  async function draft(withAudience = true) {
    const c = await owner.post(url(), { name: 'Sample', channel: 'email', topicId });
    if (withAudience) await owner.patch(url(`/${c.body.id}`), { expectedVersion: 1, audience: { include: [{ type: 'list', listId }], exclude: [] } });
    return c.body.id as string;
  }

  it('returns sampled contacts by display name with eligibility and reason codes; never an address', async () => {
    const id = await draft();
    const r = await owner.get(url(`/${id}/audience-sample`));
    expect(r.status).toBe(200);
    expect(r.body.unavailable).toBe(false);
    const byName = Object.fromEntries(r.body.sample.map((s: { displayName: string }) => [s.displayName, s]));
    expect(Object.keys(byName).sort()).toEqual(['Ann Lee', 'Bob Lee']);
    expect(byName['Ann Lee']).toMatchObject({ eligible: true, reasons: [] });
    expect(byName['Bob Lee'].eligible).toBe(false);
    expect(byName['Bob Lee'].reasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/@/);
  });

  it('an empty or invalid audience gives an empty sample (not an error)', async () => {
    const id = await draft(false);
    expect((await owner.get(url(`/${id}/audience-sample`))).body).toEqual({ unavailable: false, sample: [] });
  });

  it('needs contacts.read; another organization gets 404', async () => {
    const id = await draft();
    expect((await campaignsOnly.get(url(`/${id}/audience-sample`))).status).toBe(403);
    expect((await outsider.get(url(`/${id}/audience-sample`, WB))).status).toBe(404);
    expect((await outsider.get(url(`/${id}/audience-sample`))).status).toBe(404);
  });
});
