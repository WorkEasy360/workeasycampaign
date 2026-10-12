import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, emailOf, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Campaign analytics v1 (docs/architecture/analytics-tracking.md): numbers equal the database truth of completed runs
 * in the period; engagement is "not tracked", never zero; permissions, tenancy, period validation; aggregates only.
 */
describe('campaign analytics v1', () => {
  let t: TestApp;
  let owner: Agent;
  let noReports: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;

  async function sendTo(name: string, people: { email: string; consent: boolean }[]) {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `${name} list` })).body.id;
    const ids: string[] = [];
    for (const p of people) {
      const c = await owner.post(`/v1/workspaces/${W}/contacts`, { email: p.email, firstName: 'Secret-Name' });
      if (p.consent) await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' });
      ids.push(c.body.id);
    }
    await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds: ids });
    const c = await owner.post(url(), { name, channel: 'email', topicId });
    const p = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } } }],
    });
    const s = await owner.post(url(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const execId = s.body.currentExecution.id;
    const end = Date.now() + 30_000;
    while ((await owner.get(url(`/${c.body.id}/executions/${execId}`))).body.status !== 'completed') {
      if (Date.now() > end) throw new Error('execution did not complete');
      await new Promise((r) => setTimeout(r, 100));
    }
    return c.body.id as string;
  }

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Analytics Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    await sendTo('Big', [
      { email: 'a1@example.test', consent: true },
      { email: 'a2@example.test', consent: true },
      { email: 'a3@example.test', consent: true },
      { email: 'a4@example.test', consent: false },
    ]);
    await sendTo('Small', [
      { email: 'b1@example.test', consent: true },
      { email: 'b2@example.test', consent: false },
    ]);
    noReports = await signUp(t, undefined, 'No reports');
    const custom = await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Campaigns only', scope: 'workspace', permissions: ['campaigns.read'] });
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(noReports), organizationRoleId: await roleId(owner, orgId, 'member'), workspaces: [{ workspaceId: W, roleId: custom.body.id }] });
    expect(inv.status).toBe(201);
    expect((await noReports.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(noReports), 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('pipeline numbers equal the database truth; engagement is not tracked (never zero); test mode is stated', async () => {
    const r = await owner.get(url('/analytics'));
    expect(r.status).toBe(200);
    const truth = await withOwnerConnection(async (c) =>
      (await c.query(`SELECT count(*)::int AS runs, sum(planned)::int AS planned, sum(skipped)::int AS skipped, sum(sent)::int AS sent, sum(failed)::int AS failed FROM campaign_executions WHERE workspace_id = $1 AND status = 'completed'`, [W])).rows[0],
    );
    expect(truth).toEqual({ runs: 2, planned: 4, skipped: 2, sent: 4, failed: 0 });
    expect(r.body.pipeline).toMatchObject(truth);
    expect(r.body.pipeline.reachRate).toBeCloseTo(4 / 6);
    expect(Object.values(r.body.pipeline.skippedByReason).reduce((a: number, b) => a + (b as number), 0)).toBe(2);
    expect(r.body.deliveryMode).toBe('test');
    for (const m of Object.values(r.body.engagement)) expect(m).toEqual({ available: false, reason: 'tracking_not_enabled' });
    expect(r.body.perCampaign.map((c: { name: string; pipeline: { sent: number } }) => [c.name, c.pipeline.sent])).toEqual([['Big', 3], ['Small', 1]]);
    expect(JSON.stringify(r.body)).not.toMatch(/example\.test|Secret-Name/);
  });

  it('the period filters by completion time; an empty period has no rate (null), not zero', async () => {
    const r = await owner.get(url(`/analytics?from=${encodeURIComponent('2020-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2020-02-01T00:00:00.000Z')}`));
    expect(r.status).toBe(200);
    expect(r.body.pipeline).toEqual({ runs: 0, planned: 0, skipped: 0, sent: 0, failed: 0, skippedByReason: {}, reachRate: null });
    expect(r.body.perCampaign).toEqual([]);
    expect((await owner.get(url(`/analytics?from=${encodeURIComponent('2026-02-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`))).status).toBe(400);
    expect((await owner.get(url(`/analytics?from=${encodeURIComponent('2024-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`))).status).toBe(400);
    expect((await owner.get(url('/analytics?workspaceId=x'))).status).toBe(400);
    // The span applies after defaults: a lone, old `from` must not widen the period to the whole history (review L1).
    expect((await owner.get(url(`/analytics?from=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`))).status).toBe(400);
    expect((await owner.get(url(`/analytics?to=${encodeURIComponent('2020-01-01T00:00:00.000Z')}`))).status).toBe(200);
  });

  it('needs reports.read; another workspace sees only its own (nothing)', async () => {
    expect((await noReports.get(url('/analytics'))).status).toBe(403);
    expect((await outsider.get(url('/analytics'))).status).toBe(404);
    // One campaign's results: same permission; another tenant's campaign id is not found, not forbidden.
    const big = (await owner.get(url('/analytics'))).body.perCampaign[0].campaignId;
    expect((await owner.get(url(`/${big}/results`))).status).toBe(200);
    expect((await noReports.get(url(`/${big}/results`))).status).toBe(403);
    expect((await outsider.get(url(`/${big}/results`, WB))).status).toBe(404);
    expect((await owner.get(url('/not-a-uuid/results'))).status).toBe(404);
    const other = await outsider.get(url('/analytics', WB));
    expect(other.status).toBe(200);
    expect(other.body.pipeline.runs).toBe(0);
  });

  it('one campaign: pipeline of its completed runs and each recent run; engagement not tracked without a provider', async () => {
    const list = (await owner.get(url('/analytics'))).body.perCampaign;
    const big = list.find((c: { name: string }) => c.name === 'Big');
    const r = await owner.get(url(`/${big.campaignId}/results`));
    expect(r.status).toBe(200);
    expect(r.body.pipeline).toMatchObject({ runs: 1, planned: 3, skipped: 1, sent: 3, failed: 0 });
    expect(r.body.runs).toHaveLength(1);
    expect(r.body.runs[0]).toMatchObject({ status: 'completed', pipeline: { runs: 1, sent: 3, skipped: 1 } });
    expect(r.body.engagementBasis).toBeNull();
    expect(r.body.lastEventAt).toBeNull();
    for (const m of Object.values(r.body.engagement)) expect(m).toEqual({ available: false, reason: 'tracking_not_enabled' });
    expect(JSON.stringify(r.body)).not.toMatch(/example.test|Secret-Name/);
  });

  it('is read-only (no events, no audit entries)', async () => {
    const count = () => withOwnerConnection(async (c) => Number((await c.query(`SELECT (SELECT count(*) FROM domain_events WHERE workspace_id = $1) + (SELECT count(*) FROM audit_logs WHERE org_id = $2) AS n`, [W, orgId])).rows[0].n));
    const before = await count();
    await owner.get(url('/analytics'));
    await owner.get(url(`/${(await owner.get(url('/analytics'))).body.perCampaign[0].campaignId}/results`));
    expect(await count()).toBe(before);
  });

  it('is rate limited per user (300/h): 429 with Retry-After', async () => {
    const heavy = await signUp(t, undefined, 'Heavy');
    const { workspaceId } = await createOrg(heavy, 'Heavy Co');
    let last = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 301; i++) {
      const r = await heavy.get(`/v1/workspaces/${workspaceId}/campaigns/analytics`);
      last = r.status;
      retryAfter = r.headers['retry-after'] as string | undefined;
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  }, 120_000);
});
