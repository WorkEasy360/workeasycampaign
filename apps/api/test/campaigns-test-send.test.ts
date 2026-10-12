import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAMPAIGN_DELIVERY_PORT } from '../src/modules/campaigns/application/delivery.js';
import type { NullDeliveryPort } from '../src/modules/campaigns/infrastructure/null-delivery-port.js';
import { type Agent, createOrg, emailOf, inviteAndAccept, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Test send (Phase 7.3) through the real HTTP stack: the draft rendered like the preview and handed to the delivery
 * port's sendTest, addressed ONLY to the requesting user's own verified email; refusals (delivery unavailable,
 * incomplete content, unverified address, foreign contact, permissions); audit without address or content; rate limit.
 */
describe('campaign test send', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  let contactId: string;
  let port: NullDeliveryPort;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const content = (subject = 'Hello {{ contact.first_name | "there" }}') => ({
    schema: 'email.content.v3',
    subject,
    preheader: '',
    body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hi {{ contact.first_name | "friend" }} at {{ workspace.name }}' }] }] },
  });
  async function draft(c: unknown = content()) {
    const k = await owner.post(url(), { name: 'Test send', channel: 'email', topicId });
    const r = await owner.patch(url(`/${k.body.id}`), { expectedVersion: 1, messages: [{ variantKey: 'default', content: c }] });
    expect(r.status).toBe(200);
    return k.body.id as string;
  }

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    port = t.app.get(CAMPAIGN_DELIVERY_PORT);
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Send Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    contactId = (await owner.post(`/v1/workspaces/${W}/contacts`, { email: 'sam@example.test', firstName: 'Sam' })).body.id;
    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('sends the rendered draft to the requester’s own address only; "[Test]" subject; audited without address or content', async () => {
    port.reset();
    const id = await draft();
    const r = await owner.post(url(`/${id}/test-send`), {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ sentTo: emailOf(owner), subject: '[Test] Hello Alex', sample: 'example' });
    expect(port.testSends).toHaveLength(1);
    const sent = port.testSends[0]!;
    expect(sent).toMatchObject({ to: emailOf(owner), campaignId: id, orgId, workspaceId: W, subject: '[Test] Hello Alex' });
    expect(sent.text).toContain('Hi Alex at Main');
    expect(sent.html).toContain('this is a test send');
    const a = await withOwnerConnection(async (c) => (await c.query(`SELECT outcome, metadata FROM audit_logs WHERE action = 'campaign.test_sent' AND target_id = $1`, [id])).rows);
    expect(a).toHaveLength(1);
    expect(a[0].outcome).toBe('success');
    // Every audit entry carries the actor (audit design); the test-send metadata itself has no address or content.
    const { actorName: _n, actorEmail: _e, ...own } = a[0].metadata;
    expect(own).toEqual({ sample: 'example' });
  });

  it('the request cannot choose an address (strict body); a contact personalizes it (needs contacts.read)', async () => {
    port.reset();
    const id = await draft();
    expect((await owner.post(url(`/${id}/test-send`), { to: 'victim@example.com' })).status).toBe(400);
    expect((await owner.post(url(`/${id}/test-send`), { contactId, to: 'victim@example.com' })).status).toBe(400);
    const r = await owner.post(url(`/${id}/test-send`), { contactId });
    expect(r.status).toBe(200);
    expect(r.body.sample).toBe('contact');
    expect(port.testSends.at(-1)!.text).toContain('Hi Sam');
    expect(port.testSends.every((s) => s.to === emailOf(owner))).toBe(true);
  });

  it('refuses: content errors (422 with pointers), unverified address, foreign contact, viewers, other organizations', async () => {
    port.reset();
    const incomplete = await draft(content(''));
    const e = await owner.post(url(`/${incomplete}/test-send`), {});
    expect(e.status).toBe(422);
    expect(Object.keys(e.body.error.fields)).toContain('/messages/0/content/subject');

    const id = await draft();
    const foreign = (await outsider.post(`/v1/workspaces/${WB}/contacts`, { email: 'x@other.test', firstName: 'X' })).body.id;
    expect((await owner.post(url(`/${id}/test-send`), { contactId: foreign })).status).toBe(404);
    expect((await viewer.post(url(`/${id}/test-send`), {})).status).toBe(403);
    expect((await outsider.post(url(`/${id}/test-send`, WB), {})).status).toBe(404);

    await withOwnerConnection((c) => c.query(`UPDATE users SET email_verified_at = NULL WHERE email_normalized = lower($1)`, [emailOf(owner)]));
    try {
      // The platform refuses unverified users before any campaign code runs (403); the service re-checks (defence in depth).
      const u = await owner.post(url(`/${id}/test-send`), {});
      expect(u.status).toBe(403);
      expect(u.body.error.code).toBe('email_not_verified');
    } finally {
      await withOwnerConnection((c) => c.query(`UPDATE users SET email_verified_at = now() WHERE email_normalized = lower($1)`, [emailOf(owner)]));
    }
    expect(port.testSends).toHaveLength(0);
  });

  it('a provider failure is a retryable 503 (audited as a failure); nothing about the campaign changes', async () => {
    const id = await draft();
    const before = (await owner.get(url(`/${id}`))).body.version;
    port.failNextTest = true;
    const r = await owner.post(url(`/${id}/test-send`), {});
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('TEST_SEND_FAILED');
    expect(r.headers['retry-after']).toBe('30');
    expect((await owner.get(url(`/${id}`))).body.version).toBe(before);
    const a = await withOwnerConnection(async (c) => (await c.query(`SELECT outcome FROM audit_logs WHERE action = 'campaign.test_sent' AND target_id = $1`, [id])).rows);
    expect(a.map((x) => x.outcome)).toEqual(['failure']);
  });

  it('is rate limited per user (20 per hour)', async () => {
    const id = await draft();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await owner.post(url(`/${id}/test-send`), {})).status;
    expect(last).toBe(429);
  });
});

describe('campaign test send while delivery is disabled', () => {
  let t: TestApp;
  afterAll(async () => t?.close());
  it('is refused with DELIVERY_NOT_AVAILABLE', async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'disabled' });
    const owner = await signUp(t, undefined, 'Owner');
    const { workspaceId: W } = await createOrg(owner, 'Off Co');
    const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const k = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: 'Off', channel: 'email', topicId });
    const r = await owner.post(`/v1/workspaces/${W}/campaigns/${k.body.id}/test-send`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('DELIVERY_NOT_AVAILABLE');
  });
});
