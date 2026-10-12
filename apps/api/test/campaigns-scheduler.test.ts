import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InlineJobDispatcher } from '../src/common/jobs.js';
import { JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import { seedAudience } from './execution-support.js';
import { Agent, createOrg, emailOf, PASSWORD, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * The scheduler (Phase 7.5): due discovery + the guarded start. Time passing is simulated by moving `send_at` into the
 * past in the database — the only state the scheduler reads — so these tests prove durability (no timers, no process
 * state), catch-up after downtime, duplicate-scheduler safety and the races with unschedule / reschedule / cancel.
 */
describe('campaign scheduler', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  let secret: string;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const execOf = async (id: string) => (await q(`SELECT * FROM campaign_executions WHERE id = $1`, [id]))[0]!;
  const idle = async (app: TestApp) => {
    const d = app.app.get(JOB_DISPATCHER, { strict: false }) as InlineJobDispatcher;
    for (let i = 0; i < 400; i++) {
      await d.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(d as unknown as { running: Set<unknown> }).running.size) return;
    }
  };
  const content = { schema: 'email.content.v1', subject: 'Later', preheader: '', body: { format: 'text', text: 'Scheduled send' } };

  /** A campaign scheduled for one hour from now (mode 'at'); returns ids. */
  async function scheduled(name = 'Later', ws = W, agent = owner, n = 5): Promise<{ id: string; executionId: string; version: number }> {
    const listId = (await agent.post(`/v1/workspaces/${ws}/lists`, { name: `${name}-${randomUUID().slice(0, 6)}` })).body.id as string;
    const org = ws === W ? orgId : (await q(`SELECT org_id FROM workspaces WHERE id = $1`, [ws]))[0]!.org_id;
    await seedAudience({ orgId: org, workspaceId: ws, listId, n, eligible: n, secret });
    const topic = (await agent.get(`/v1/workspaces/${ws}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const c = await agent.post(url('', ws), { name, channel: 'email', topicId: topic });
    const p = await agent.patch(url(`/${c.body.id}`, ws), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content }],
    });
    expect(p.status, JSON.stringify(p.body).slice(0, 300)).toBe(200);
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const s = await agent.post(url(`/${c.body.id}/schedule`, ws), { mode: 'at', sendAt, timezone: 'Europe/Berlin', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    return { id: c.body.id, executionId: s.body.currentExecution.id, version: s.body.version };
  }
  /** Simulates the passing of time: the execution became due `ago` ms ago. */
  const makeDue = (executionId: string, ago = 1_000) => q(`UPDATE campaign_executions SET send_at = now() - make_interval(secs => $2::float8 / 1000) WHERE id = $1`, [executionId, ago]);
  const startedEvents = async (campaignId: string) => (await q(`SELECT count(*)::int AS n FROM domain_events WHERE aggregate_id = $1 AND type = 'campaign.started'`, [campaignId]))[0]!.n as number;

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    secret = (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret;
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Scheduler Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    expect(topicId).toBeTruthy();
  });
  afterAll(async () => t?.close());

  it('a scheduled execution is not started before its time; once due, the scheduler starts it and it completes', async () => {
    const svc = t.app.get(ExecutionService, { strict: false });
    const c = await scheduled('Not yet');
    const before = await svc.startDue();
    await idle(t);
    expect(before.due).toBe(0);
    expect((await execOf(c.executionId)).status).toBe('pending');

    await makeDue(c.executionId);
    const r = await svc.startDue();
    expect(r.due).toBe(1);
    await idle(t);
    const e = await execOf(c.executionId);
    expect(e).toMatchObject({ status: 'completed', planned: 5, sent: 5 });
    expect(await startedEvents(c.id)).toBe(1);
    expect((await owner.get(url(`/${c.id}`))).body.status).toBe('completed');
  });

  it('durable: after a restart and an hour of downtime, the next tick starts everything overdue (lag reported)', async () => {
    const a = await scheduled('Overdue A');
    const b = await scheduled('Overdue B');
    await makeDue(a.executionId, 3_600_000);
    await makeDue(b.executionId, 1_800_000);
    await t.close(); // the process "crashes"; nothing about the schedule lived in it
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    const email = emailOf(owner);
    owner = new Agent(t);
    expect((await owner.post('/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
    (owner as Agent & { email: string }).email = email;
    const r = await t.app.get(ExecutionService, { strict: false }).startDue();
    expect(r.due).toBe(2);
    expect(r.maxLagMs).toBeGreaterThanOrEqual(3_600_000);
    await idle(t);
    for (const x of [a, b]) expect((await execOf(x.executionId)).status).toBe('completed');
  });

  it('two schedulers at once (two instances): each due execution starts exactly once, no duplicate recipient', async () => {
    const other = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    try {
      const cs = [await scheduled('Dup 1'), await scheduled('Dup 2'), await scheduled('Dup 3')];
      for (const c of cs) await makeDue(c.executionId);
      const [x, y] = await Promise.all([t.app.get(ExecutionService, { strict: false }).startDue(), other.app.get(ExecutionService, { strict: false }).startDue()]);
      expect(x.due + y.due).toBeGreaterThanOrEqual(3); // every one was seen (often by both)
      await Promise.all([idle(t), idle(other)]);
      for (const c of cs) {
        expect(await startedEvents(c.id)).toBe(1); // …but each started once
        const e = await execOf(c.executionId);
        expect(e).toMatchObject({ status: 'completed', planned: 5, sent: 5 });
        const dups = (await q(`SELECT count(*) - count(DISTINCT contact_id) AS n FROM campaign_recipients WHERE execution_id = $1`, [c.executionId]))[0]!.n;
        expect(Number(dups)).toBe(0);
      }
    } finally {
      await other.close();
    }
  });

  it('the same due execution started by two instances at the same moment: one start, one no-op', async () => {
    const other = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    try {
      const c = await scheduled('Same moment');
      await makeDue(c.executionId);
      const env = () => ({ tenant: { orgId, workspaceId: W }, actor: { type: 'system' as const, id: null }, correlationId: randomUUID(), payload: { executionId: c.executionId, attempt: 0 } });
      const outcomes = await Promise.all([t.app.get(ExecutionService, { strict: false }).start(env()), other.app.get(ExecutionService, { strict: false }).start(env())]);
      expect(outcomes.sort()).toEqual(['noop', 'started']);
      await Promise.all([idle(t), idle(other)]);
      expect(await startedEvents(c.id)).toBe(1);
      expect(await execOf(c.executionId)).toMatchObject({ status: 'completed', sent: 5 });
    } finally {
      await other.close();
    }
  });

  it('unschedule, reschedule and cancel before the start are respected', async () => {
    const svc = t.app.get(ExecutionService, { strict: false });
    const u = await scheduled('Unscheduled');
    const r = await scheduled('Rescheduled');
    const k = await scheduled('Cancelled');
    for (const c of [u, r, k]) await makeDue(c.executionId);
    expect((await owner.post(url(`/${u.id}/unschedule`), { expectedVersion: u.version })).status).toBe(200);
    const later = new Date(Date.now() + 7_200_000).toISOString();
    expect((await owner.post(url(`/${r.id}/reschedule`), { sendAt: later, timezone: 'Europe/Berlin', expectedVersion: r.version })).status).toBe(200);
    expect((await owner.post(url(`/${k.id}/cancel`), { expectedVersion: k.version })).status).toBe(200);
    const res = await svc.startDue();
    await idle(t);
    expect(res.due).toBe(0); // none is pending AND due any more
    expect((await owner.get(url(`/${u.id}`))).body.status).toBe('draft');
    expect((await execOf(r.executionId)).status).toBe('pending');
    expect(new Date((await execOf(r.executionId)).send_at).toISOString()).toBe(later);
    expect((await owner.get(url(`/${k.id}`))).body.status).toBe('cancelled');
    for (const c of [u, r, k]) expect(await startedEvents(c.id)).toBe(0);
  });

  it('a racing unschedule and scheduler tick: exactly one wins — never both started and unscheduled', async () => {
    const svc = t.app.get(ExecutionService, { strict: false });
    const c = await scheduled('Race');
    await makeDue(c.executionId);
    const [un] = await Promise.all([owner.post(url(`/${c.id}/unschedule`), { expectedVersion: c.version }), svc.startDue()]);
    await idle(t);
    const status = (await owner.get(url(`/${c.id}`))).body.status;
    if (un.status === 200) {
      expect(status).toBe('draft');
      expect(await startedEvents(c.id)).toBe(0);
    } else {
      expect(un.status).toBe(409);
      expect(await startedEvents(c.id)).toBe(1);
      expect(['sending', 'completed']).toContain(status);
    }
  });

  it('each due execution starts inside its own tenant', async () => {
    const outsider = await signUp(t, undefined, 'Outsider');
    const { workspaceId: WB } = await createOrg(outsider, 'Other Co');
    const mine = await scheduled('Mine');
    const theirs = await scheduled('Theirs', WB, outsider);
    await makeDue(mine.executionId);
    await makeDue(theirs.executionId);
    expect((await t.app.get(ExecutionService, { strict: false }).startDue()).due).toBe(2);
    await idle(t);
    const ev = await q(`SELECT aggregate_id, workspace_id FROM domain_events WHERE type = 'campaign.started' AND aggregate_id = ANY($1::uuid[])`, [[mine.id, theirs.id]]);
    expect(Object.fromEntries(ev.map((e) => [e.aggregate_id, e.workspace_id]))).toEqual({ [mine.id]: W, [theirs.id]: WB });
  });
});

describe('workspace time zone (Phase 7.5)', () => {
  let t: TestApp;
  afterAll(async () => t?.close());
  it('a new draft schedules in the workspace’s time zone by default', async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    const owner = await signUp(t, undefined, 'Owner');
    const { workspaceId: W } = await createOrg(owner, 'Zone Co');
    const ws = await owner.get(`/v1/workspaces/${W}`);
    expect((await owner.patch(`/v1/workspaces/${W}`, { timezone: 'Asia/Kolkata', version: ws.body.workspace.version })).status).toBe(200);
    const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const c = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: 'Zoned', channel: 'email', topicId });
    expect(c.body.draft.schedule).toEqual({ mode: 'now', sendAt: null, timezone: 'Asia/Kolkata' });
  });
});
