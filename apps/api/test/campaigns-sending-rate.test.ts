import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, emailOf, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Sending-rate controls (Phase 7.11; campaign amendment §R): a run's own limit (set through the API, before or during
 * the run) and the workspace's fair share (config) are enforced by the engine through shared token buckets; the
 * endpoint is permission-checked, tenant-scoped, validated and audited.
 */
describe('sending rate', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const C = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const idle = async (app: TestApp) => {
    const d = app.app.get(JOB_DISPATCHER, { strict: false }) as InlineJobDispatcher;
    for (let i = 0; i < 2000; i++) {
      await d.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(d as unknown as { running: Set<unknown> }).running.size) return;
    }
  };

  async function scheduled(app: TestApp, agent: Agent, ws: string, n: number, mode: 'now' | 'at') {
    const listId = (await agent.post(`/v1/workspaces/${ws}/lists`, { name: `r-${randomUUID().slice(0, 6)}` })).body.id;
    await seedAudience({ orgId, workspaceId: ws, listId, n, eligible: n, secret: (app.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret });
    const c = await agent.post(C('', ws), { name: 'Rate', channel: 'email', topicId });
    const p = await agent.patch(C(`/${c.body.id}`, ws), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } } }],
    });
    const s = await agent.post(C(`/${c.body.id}/schedule`, ws), mode === 'at' ? { mode: 'at', sendAt: new Date(Date.now() + 3_600_000).toISOString(), timezone: 'UTC', expectedVersion: p.body.version } : { mode: 'now', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    return { campaignId: c.body.id as string, executionId: s.body.currentExecution.id as string };
  }
  const spreadMs = async (executionId: string) => {
    const [r] = await q<{ n: number; first: Date; last: Date }>(`SELECT count(*)::int AS n, min(final_at) AS first, max(final_at) AS last FROM campaign_recipients WHERE execution_id = $1 AND status = 'sent'`, [executionId]);
    return { sent: r!.n, ms: new Date(r!.last).getTime() - new Date(r!.first).getTime() };
  };

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Rate Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    viewer = await signUp(t, undefined, 'Viewer');
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(viewer), organizationRoleId: await roleId(owner, orgId, 'member'), workspaces: [{ workspaceId: W, roleId: await roleId(owner, orgId, 'viewer') }] });
    expect(inv.status).toBe(201);
    expect((await viewer.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(viewer), 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('a run limit is set before the run, enforced at the next batches, and audited', async () => {
    const { campaignId, executionId } = await scheduled(t, owner, W, 14, 'at');
    const url = C(`/${campaignId}/executions/${executionId}/sending-rate`);
    const r = await owner.put(url, { maxPerHour: 3600 }); // 1 per second, a burst of 10
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: executionId, maxPerHour: 3600 });
    expect((await owner.get(C(`/${campaignId}`))).body.currentExecution.maxPerHour).toBe(3600);
    const [audit] = await q(`SELECT action, metadata FROM audit_logs WHERE action = 'campaign.sending_rate_changed' AND target_id = $1`, [campaignId]);
    expect(audit!.metadata).toMatchObject({ executionId, from: null, to: 3600 });

    // Make it due (the start re-checks send_at against the database clock), then let the scheduler start it.
    await q(`UPDATE campaign_executions SET send_at = now() - interval '1 second' WHERE id = $1`, [executionId]);
    expect((await t.app.get(ExecutionService, { strict: false }).startDue()).due).toBe(1);
    await idle(t);
    const { sent, ms } = await spreadMs(executionId);
    expect(sent).toBe(14);
    // 10 at once (the burst), then one per second: the last four take at least ~3 s more.
    expect(ms).toBeGreaterThanOrEqual(2_900);
    expect((await q(`SELECT status, health FROM campaign_executions WHERE id = $1`, [executionId]))[0]).toEqual({ status: 'completed', health: 'ok' });
  }, 60_000);

  it('validation, permission and tenant scope; a finished run cannot change', async () => {
    const { campaignId, executionId } = await scheduled(t, owner, W, 1, 'at');
    const url = C(`/${campaignId}/executions/${executionId}/sending-rate`);
    for (const body of [{ maxPerHour: 0 }, { maxPerHour: 1.5 }, { maxPerHour: 1_000_001 }, { maxPerHour: '10' }, {}, { maxPerHour: 10, workspaceId: WB }]) {
      expect((await owner.put(url, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await viewer.put(url, { maxPerHour: 10 })).status).toBe(403);
    expect((await outsider.put(C(`/${campaignId}/executions/${executionId}/sending-rate`, WB), { maxPerHour: 10 })).status).toBe(404);
    expect((await owner.put(C(`/${campaignId}/executions/${randomUUID()}/sending-rate`), { maxPerHour: 10 })).status).toBe(404);
    expect((await owner.put(url, { maxPerHour: null })).body.maxPerHour).toBeNull();
    const done = (await q(`SELECT e.id, e.campaign_id FROM campaign_executions e WHERE e.workspace_id = $1 AND e.status = 'completed' LIMIT 1`, [W]))[0]!;
    const finished = await owner.put(C(`/${done.campaign_id}/executions/${done.id}/sending-rate`), { maxPerHour: 10 });
    expect(finished.status).toBe(422);
  });

  it('the workspace share (config) paces a run with no limit of its own', async () => {
    const paced = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', WORKSPACE_SEND_RATE_PER_SECOND: '4' });
    try {
      const agent = await signUp(paced, undefined, 'Paced');
      const { orgId: o, workspaceId: ws } = await createOrg(agent, 'Paced Co');
      const tid = (await agent.get(`/v1/workspaces/${ws}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
      const listId = (await agent.post(`/v1/workspaces/${ws}/lists`, { name: 'paced' })).body.id;
      await seedAudience({ orgId: o, workspaceId: ws, listId, n: 16, eligible: 16, secret: (paced.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret });
      const c = await agent.post(`/v1/workspaces/${ws}/campaigns`, { name: 'Paced', channel: 'email', topicId: tid });
      const p = await agent.patch(`/v1/workspaces/${ws}/campaigns/${c.body.id}`, {
        expectedVersion: 1,
        audience: { include: [{ type: 'list', listId }], exclude: [] },
        sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
        messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } } }],
      });
      const s = await agent.post(`/v1/workspaces/${ws}/campaigns/${c.body.id}/schedule`, { mode: 'now', expectedVersion: p.body.version });
      expect(s.status).toBe(200);
      await idle(paced);
      const { sent, ms } = await spreadMs(s.body.currentExecution.id);
      expect(sent).toBe(16);
      // 4 at once, then 4 per second: 12 more take at least ~3 s.
      expect(ms).toBeGreaterThanOrEqual(2_700);
    } finally {
      await paced.close();
    }
  }, 60_000);
});
