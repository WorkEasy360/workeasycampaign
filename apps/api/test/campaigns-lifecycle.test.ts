import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, createOrg, inviteAndAccept, RecordingJobDispatcher, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Milestone 6.8 — lifecycle commands (contract §2.2, §15 rows 11–17, 20) through the real HTTP stack: authorization →
 * optimistic concurrency → pre-flight → immutable version → persisted execution; database-backed idempotency;
 * concurrency; tenant isolation.
 *
 * COMMAND LAYER in isolation: the app's JobDispatcher RECORDS the follow-up jobs the commands dispatch after commit
 * (start, run, finalize — asserted here) instead of running them, so the states pause/resume/cancel apply to are seeded
 * by the owner connection exactly as before. The execution engine those jobs drive (6.9) is tested end to end with the
 * real dispatcher in campaigns-execution.test.ts.
 */
describe('campaign lifecycle API (6.8)', () => {
  let t: TestApp; // CAMPAIGN_DELIVERY_MODE=test (allowed only with NODE_ENV=test): sending "available", no provider
  const jobs = new RecordingJobDispatcher();
  let owner: Agent;
  let manager: Agent; // campaigns.send
  let editor: Agent; // no campaigns.send
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  let listId: string;
  let contactIds: string[] = [];
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const content = { schema: 'email.content.v1', subject: 'Winter sale', preheader: '', body: { format: 'text', text: 'Hello there' } };
  const tomorrow = (h = 24) => new Date(Date.now() + h * 3600_000).toISOString();
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const events = async (id: string) => (await q<{ type: string; payload: Record<string, unknown> }>(`SELECT type, payload FROM domain_events WHERE aggregate_id = $1 ORDER BY occurred_at, id`, [id]));
  const types = async (id: string) => (await events(id)).map((e) => e.type);
  const audits = async (id: string) => (await q<{ action: string }>(`SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at`, [id])).map((r) => r.action);
  const executions = (id: string) => q<{ id: string; status: string; send_at: Date; version_id: string; paused_phase: string | null; started_at: Date | null; audience_snapshot_id: string | null; failure_code: string | null }>(`SELECT * FROM campaign_executions WHERE campaign_id = $1 ORDER BY run_number`, [id]);
  const versions = (id: string) => q<{ id: string; number: number; reason: string; snapshot: Record<string, unknown>; content_hash: string }>(`SELECT * FROM campaign_versions WHERE campaign_id = $1 ORDER BY number`, [id]);

  async function ready(name = 'Winter sale'): Promise<{ id: string; version: number }> {
    const c = await owner.post(url(), { name, channel: 'email', topicId });
    expect(c.status).toBe(201);
    const p = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content }],
    });
    expect(p.status).toBe(200);
    return { id: c.body.id, version: p.body.version };
  }
  async function scheduled(sendAt = tomorrow()): Promise<{ id: string; version: number; executionId: string }> {
    const c = await ready();
    const r = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt, expectedVersion: c.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id: c.id, version: r.body.version, executionId: r.body.currentExecution.id };
  }
  /** What the 6.9 runner will do (start → materialized): seeded, since 6.8 must not execute anything. */
  async function sending(phase: 'materializing' | 'delivering' = 'delivering') {
    const s = await scheduled();
    await q(`UPDATE campaign_executions SET status = $2, started_at = now(), materialized_at = CASE WHEN $2 = 'delivering' THEN now() END, planned = 10, sent = 3 WHERE id = $1`, [s.executionId, phase]);
    await q(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [s.id]);
    return s;
  }
  const view = async (id: string) => (await owner.get(url(`/${id}`))).body;

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' }, { jobDispatcher: jobs });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Lifecycle Co'));
    manager = await signUp(t, undefined, 'Manager');
    editor = await signUp(t, undefined, 'Editor');
    await inviteAndAccept(t, owner, manager, orgId, 'member', [{ workspaceId: W, roleKey: 'manager' }]);
    await inviteAndAccept(t, owner, editor, orgId, 'member', [{ workspaceId: W, roleKey: 'editor' }]);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Customers' })).body.id;
    for (let i = 0; i < 3; i++) {
      const c = await owner.post(`/v1/workspaces/${W}/contacts`, { email: `lc-${i}-${randomUUID().slice(0, 6)}@example.test` });
      await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' });
      contactIds.push(c.body.id);
    }
    expect((await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds })).status).toBe(200);
  });
  afterAll(async () => t?.close());

  describe('schedule / send-now', () => {
    it('schedule (at): pre-flight → immutable version → pending execution; campaign scheduled; events + audit; nothing executed', async () => {
      const c = await ready();
      const sendAt = tomorrow(48);
      const snapshotsBefore = (await q<{ n: string }>(`SELECT count(*) AS n FROM audience_snapshots`))[0]!.n;
      const r = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt, timezone: 'Europe/London', expectedVersion: c.version });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'scheduled', version: c.version + 1, currentVersion: { number: 1 } });
      expect(r.body.currentExecution).toMatchObject({ status: 'pending' });
      expect(r.body.draft.schedule).toEqual({ mode: 'at', sendAt, timezone: 'Europe/London' });
      const [v] = await versions(c.id);
      expect(v).toMatchObject({ number: 1, reason: 'scheduled' });
      // Content amendment C3: new versions are campaign.version.v2; a v1 text draft keeps its v1 content and mode 'none'.
      expect(v!.snapshot).toMatchObject({
        schema: 'campaign.version.v2',
        personalization: { mode: 'none' },
        messages: [{ variantKey: 'default', content: { schema: 'email.content.v1' } }],
        schedule: { mode: 'at', sendAt, timezone: 'Europe/London' },
        audience: { include: [{ type: 'list', listId }] },
      });
      const [e] = await executions(c.id);
      expect(e).toMatchObject({ status: 'pending', version_id: v!.id, started_at: null, audience_snapshot_id: null });
      expect(e!.send_at.toISOString()).toBe(sendAt);
      expect(await types(c.id)).toEqual(['campaign.created', 'campaign.updated', 'campaign.version_created', 'campaign.scheduled']);
      expect(await audits(c.id)).toContain('campaign.scheduled');
      // Not executed: no recipients, no capture snapshot.
      expect((await q<{ n: string }>(`SELECT count(*) AS n FROM campaign_recipients WHERE execution_id = $1`, [e!.id]))[0]!.n).toBe('0');
      expect((await q<{ n: string }>(`SELECT count(*) AS n FROM audience_snapshots`))[0]!.n).toBe(snapshotsBefore);
    });

    it('send-now (mode now): version reason sent_now; pending execution at ~now; ONE start job dispatched after commit with the server-built tenant envelope; the command itself executes nothing', async () => {
      const c = await ready();
      const r = await manager.post(url(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('scheduled');
      expect((await versions(c.id))[0]!.reason).toBe('sent_now');
      const [e] = await executions(c.id);
      expect(Math.abs(e!.send_at.getTime() - Date.now())).toBeLessThan(60_000);
      const started = jobs.for('campaign.execution.start', e!.id);
      expect(started).toHaveLength(1);
      expect(started[0]!.data).toMatchObject({ tenant: { orgId, workspaceId: W }, actor: { type: 'user' }, payload: { executionId: e!.id, attempt: 0 } });
      // the command layer only dispatches: nothing started, no recipient (the engine is covered by the 6.9 suite)
      expect((await executions(c.id))[0]).toMatchObject({ status: 'pending', started_at: null });
      expect((await q<{ n: string }>(`SELECT count(*) AS n FROM campaign_recipients`))[0]!.n).toBe('0');
      // a later send time dispatches no start job (due discovery is the Phase 8 scheduler)
      const later = await scheduled();
      expect(jobs.for('campaign.execution.start', later.executionId)).toHaveLength(0);
    });

    it('pre-flight errors: 422 PREFLIGHT_FAILED with the error findings; nothing written', async () => {
      const c = await owner.post(url(), { name: 'Incomplete', channel: 'email', topicId });
      const r = await manager.post(url(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: 1 });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('PREFLIGHT_FAILED');
      expect(r.body.error.findings.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(['AUDIENCE_EMPTY_DEFINITION', 'SUBJECT_MISSING']));
      expect(r.body.error.findings.every((f: { severity: string }) => f.severity === 'error')).toBe(true);
      expect(await versions(c.body.id)).toEqual([]);
      expect(await executions(c.body.id)).toEqual([]);
      expect((await view(c.body.id)).version).toBe(1);
    });

    it('audience facts are checked too: an archived topic fails schedule; the past is refused', async () => {
      const topic = (await owner.post(`/v1/workspaces/${W}/topics`, { name: 'Gone soon', key: 'gone_soon' })).body.id as string;
      const c = await ready();
      const v = (await owner.patch(url(`/${c.id}`), { expectedVersion: c.version, topicId: topic })).body.version;
      await owner.post(`/v1/workspaces/${W}/topics/${topic}/archive`);
      const r = await manager.post(url(`/${c.id}/schedule`), { mode: 'now', expectedVersion: v });
      expect(r.status).toBe(422);
      expect(r.body.error.findings.map((f: { code: string }) => f.code)).toContain('TOPIC_UNAVAILABLE');
      const past = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() - 3600_000).toISOString(), expectedVersion: v });
      expect(past.status).toBe(422);
      expect(past.body.error.findings.map((f: { code: string }) => f.code)).toContain('SCHEDULE_IN_PAST');
    });

    it('delivery disabled (production default): 422 DELIVERY_NOT_AVAILABLE before any pre-flight or write', async () => {
      const prod = await startTestApp();
      try {
        const a = new Agent(prod);
        const login = await a.post('/v1/auth/login', { email: (owner as Agent & { email: string }).email, password: 'maple-river-lantern-42' });
        expect(login.status).toBe(200);
        const c = await ready();
        const r = await a.post(url(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('DELIVERY_NOT_AVAILABLE');
        expect(await versions(c.id)).toEqual([]);
      } finally {
        await prod.close();
      }
    });

    it('authorization: editor 403 (no campaigns.send); unauthenticated 401; outsider / IDOR 404', async () => {
      const c = await ready();
      const body = { mode: 'now', expectedVersion: c.version };
      const denied = await editor.post(url(`/${c.id}/schedule`), body);
      expect(denied.status).toBe(403);
      expect((await new Agent(t).post(url(`/${c.id}/schedule`), body)).status).toBe(401);
      expect((await outsider.post(url(`/${c.id}/schedule`), body)).status).toBe(404);
      expect((await outsider.post(url(`/${c.id}/schedule`, WB), body)).status).toBe(404);
      expect((await owner.post(url(`/${randomUUID()}/schedule`), body)).status).toBe(404);
      expect((await owner.post(url(`/${c.id}/schedule`), { ...body, workspaceId: WB })).status).toBe(400);
      expect(await versions(c.id)).toEqual([]);
      // The route guard records the denial (permission + route; the campaign is never resolved for a denied caller).
      const guardDenials = await q<{ metadata: { permission: string; route: string } }>(`SELECT metadata FROM audit_logs WHERE action = 'access.denied' AND metadata->>'permission' = 'campaigns.send'`);
      expect(guardDenials.map((d) => d.metadata.route)).toContain('/v1/workspaces/:workspaceId/campaigns/:campaignId/schedule');
    });

    it('optimistic concurrency: stale expectedVersion is 409 version_conflict — also when the command would be a no-op', async () => {
      const c = await ready();
      expect((await manager.post(url(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version - 1 })).body.error.code).toBe('version_conflict');
      const s = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: tomorrow(), expectedVersion: c.version });
      expect(s.status).toBe(200);
      // Unschedule a draft is a no-op; stale → conflict, current → 200 unchanged.
      const u = await manager.post(url(`/${c.id}/unschedule`), { expectedVersion: s.body.version });
      expect(u.status).toBe(200);
      const stale = await manager.post(url(`/${c.id}/unschedule`), { expectedVersion: s.body.version });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('version_conflict');
      const noop = await manager.post(url(`/${c.id}/unschedule`), { expectedVersion: u.body.version });
      expect([noop.status, noop.body.version]).toEqual([200, u.body.version]);
    });

    it('concurrent schedules with the same expectedVersion: exactly one wins; one version, one execution', async () => {
      const c = await ready();
      const rs = await Promise.all([0, 1, 2].map(() => manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: tomorrow(), expectedVersion: c.version })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await versions(c.id)).toHaveLength(1);
      expect(await executions(c.id)).toHaveLength(1);
    });

    it('edit racing schedule: the version freezes exactly the locked draft or the schedule is refused — never a mix', async () => {
      const c = await ready();
      const [patch, sched] = await Promise.all([
        owner.patch(url(`/${c.id}`), { expectedVersion: c.version, messages: [{ variantKey: 'default', content: { ...content, subject: 'Edited subject' } }] }),
        manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: tomorrow(), expectedVersion: c.version }),
      ]);
      expect([patch.status, sched.status].filter((s) => s === 200)).toHaveLength(1);
      const vs = await versions(c.id);
      if (sched.status === 200) {
        expect(patch.status).not.toBe(200);
        expect((vs[0]!.snapshot as { messages: { content: { subject: string } }[] }).messages[0]!.content.subject).toBe('Winter sale');
      } else {
        expect(sched.body.error.code).toBe('version_conflict');
        expect(vs).toEqual([]);
      }
    });
  });

  describe('reschedule / unschedule', () => {
    it('reschedule moves the pending send time; same time is a no-op; the version keeps the original intent', async () => {
      const s = await scheduled();
      const to = tomorrow(72);
      const r = await manager.post(url(`/${s.id}/reschedule`), { sendAt: to, expectedVersion: s.version });
      expect(r.status).toBe(200);
      expect(r.body.version).toBe(s.version + 1);
      expect((await executions(s.id))[0]!.send_at.toISOString()).toBe(to);
      const ev = (await events(s.id)).find((e) => e.type === 'campaign.rescheduled')!;
      expect(ev.payload).toMatchObject({ executionId: s.executionId, to });
      expect(await audits(s.id)).toContain('campaign.rescheduled');
      const same = await manager.post(url(`/${s.id}/reschedule`), { sendAt: to, expectedVersion: r.body.version });
      expect([same.status, same.body.version]).toEqual([200, r.body.version]);
      expect((await versions(s.id))).toHaveLength(1);
      const past = await manager.post(url(`/${s.id}/reschedule`), { sendAt: new Date(Date.now() - 7200_000).toISOString(), expectedVersion: r.body.version });
      expect(past.status).toBe(422);
      expect(past.body.error.code).toBe('PREFLIGHT_FAILED');
      expect((await manager.post(url(`/${s.id}/reschedule`), { sendAt: tomorrow(5), expectedVersion: s.version })).body.error.code).toBe('version_conflict');
    });

    it('reschedule of a draft: 409 INVALID_TRANSITION', async () => {
      const c = await ready();
      const r = await manager.post(url(`/${c.id}/reschedule`), { sendAt: tomorrow(), expectedVersion: c.version });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('INVALID_TRANSITION');
    });

    it('unschedule: execution cancelled, campaign back to draft, version kept and immutable after later edits', async () => {
      const s = await scheduled();
      const [vBefore] = await versions(s.id);
      const r = await manager.post(url(`/${s.id}/unschedule`), { expectedVersion: s.version });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'draft', currentExecution: null });
      expect((await executions(s.id))[0]!.status).toBe('cancelled');
      expect(await types(s.id)).toContain('campaign.unscheduled');
      const p = await owner.patch(url(`/${s.id}`), { expectedVersion: r.body.version, messages: [{ variantKey: 'default', content: { ...content, subject: 'Changed later' } }] });
      expect(p.status).toBe(200);
      const [vAfter] = await versions(s.id);
      expect(vAfter).toEqual(vBefore);
      const detail = await owner.get(url(`/${s.id}/versions/${vBefore!.id}`));
      expect(detail.body.snapshot.messages[0].content.subject).toBe('Winter sale');
      // Re-scheduling creates version 2 / run 2; history keeps both.
      const again = await manager.post(url(`/${s.id}/schedule`), { mode: 'at', sendAt: tomorrow(), expectedVersion: p.body.version });
      expect(again.status).toBe(200);
      expect((await versions(s.id)).map((v) => v.number)).toEqual([1, 2]);
      expect((await executions(s.id)).map((e) => e.status)).toEqual(['cancelled', 'pending']);
    });

    it('concurrent reschedules: one applies, the other is a version_conflict', async () => {
      const s = await scheduled();
      const rs = await Promise.all([tomorrow(30), tomorrow(31)].map((sendAt) => manager.post(url(`/${s.id}/reschedule`), { sendAt, expectedVersion: s.version })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  describe('pause / resume / cancel / return to draft', () => {
    it('pause: sending → paused (phase remembered); pause again is a no-op; editor 403', async () => {
      const s = await sending('delivering');
      expect((await editor.post(url(`/${s.id}/pause`))).status).toBe(403);
      const r = await manager.post(url(`/${s.id}/pause`));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('paused');
      expect((await executions(s.id))[0]).toMatchObject({ status: 'paused', paused_phase: 'delivering' });
      expect((await events(s.id)).find((e) => e.type === 'campaign.paused')!.payload).toEqual({ executionId: s.executionId, phase: 'delivering' });
      const again = await manager.post(url(`/${s.id}/pause`));
      expect([again.status, again.body.version]).toEqual([200, r.body.version]);
    });

    it('pause of a scheduled (not started) campaign: 409 INVALID_TRANSITION', async () => {
      const s = await scheduled();
      const r = await manager.post(url(`/${s.id}/pause`));
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('INVALID_TRANSITION');
    });

    it('resume: paused → sending (back to the paused phase); resume again is a no-op', async () => {
      const s = await sending('materializing');
      await manager.post(url(`/${s.id}/pause`));
      const r = await manager.post(url(`/${s.id}/resume`));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('sending');
      expect((await executions(s.id))[0]).toMatchObject({ status: 'materializing', paused_phase: null });
      expect(await audits(s.id)).toEqual(expect.arrayContaining(['campaign.paused', 'campaign.resumed']));
      expect((await manager.post(url(`/${s.id}/resume`))).body.version).toBe(r.body.version);
    });

    it('resume re-check: a topic archived while paused fails the execution (configuration) instead of resuming; return to draft', async () => {
      const topic = (await owner.post(`/v1/workspaces/${W}/topics`, { name: 'Paused topic', key: 'paused_topic' })).body.id as string;
      const c = await ready();
      const v = (await owner.patch(url(`/${c.id}`), { expectedVersion: c.version, topicId: topic })).body.version;
      const sch = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: tomorrow(), expectedVersion: v });
      expect(sch.status).toBe(200);
      const ex = sch.body.currentExecution.id as string;
      await q(`UPDATE campaign_executions SET status = 'delivering', started_at = now(), materialized_at = now() WHERE id = $1`, [ex]);
      await q(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [c.id]);
      expect((await manager.post(url(`/${c.id}/pause`))).status).toBe(200);
      await owner.post(`/v1/workspaces/${W}/topics/${topic}/archive`);
      const r = await manager.post(url(`/${c.id}/resume`));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('failed');
      expect((await executions(c.id))[0]).toMatchObject({ status: 'failed', failure_code: 'TOPIC_UNAVAILABLE' });
      expect((await events(c.id)).find((e) => e.type === 'campaign.failed')!.payload).toEqual({ executionId: ex, failureClass: 'configuration', failureCode: 'TOPIC_UNAVAILABLE' });
      // return to draft (campaigns.update: the editor may)
      const back = await editor.post(url(`/${c.id}/return-to-draft`));
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ status: 'draft', currentExecution: null });
      expect(await types(c.id)).toContain('campaign.returned_to_draft');
      expect((await editor.post(url(`/${c.id}/return-to-draft`))).body.version).toBe(back.body.version); // no-op
    });

    it('cancel: from scheduled, sending and paused; terminal; cancel again is a no-op; counts carried in the event', async () => {
      const a = await scheduled();
      const ca = await manager.post(url(`/${a.id}/cancel`), { expectedVersion: a.version });
      expect(ca.status).toBe(200);
      expect(ca.body.status).toBe('cancelled');
      expect((await events(a.id)).find((e) => e.type === 'campaign.cancelled')!.payload).toMatchObject({ executionId: a.executionId, stage: 'scheduled' });
      expect((await manager.post(url(`/${a.id}/cancel`), { expectedVersion: ca.body.version })).body.version).toBe(ca.body.version);
      expect((await manager.post(url(`/${a.id}/cancel`), { expectedVersion: a.version })).body.error.code).toBe('version_conflict');

      const b = await sending('delivering');
      const vb = (await view(b.id)).version;
      const cb = await manager.post(url(`/${b.id}/cancel`), { expectedVersion: vb });
      expect(cb.status).toBe(200);
      expect((await events(b.id)).find((e) => e.type === 'campaign.cancelled')!.payload).toEqual({
        executionId: b.executionId,
        stage: 'delivering',
        counts: { planned: 10, skipped: 0, sent: 3, failed: 0, cancelled: 0, unknown: 0 },
      });

      const c = await sending('delivering');
      const paused = await manager.post(url(`/${c.id}/pause`));
      const cc = await manager.post(url(`/${c.id}/cancel`), { expectedVersion: paused.body.version });
      expect(cc.status).toBe(200);
      expect((await executions(c.id))[0]).toMatchObject({ status: 'cancelled', paused_phase: null });
      expect(await audits(c.id)).toContain('campaign.cancelled');
      // terminal: nothing but clone remains
      expect((await manager.post(url(`/${c.id}/schedule`), { mode: 'now', expectedVersion: cc.body.version })).status).toBe(409);
    });

    it('concurrent pause × resume and cancel × unschedule: serialized by the row lock; state stays consistent', async () => {
      const s = await sending('delivering');
      await Promise.all([manager.post(url(`/${s.id}/pause`)), manager.post(url(`/${s.id}/resume`))]);
      const [e] = await executions(s.id);
      const v = await view(s.id);
      expect(['sending', 'paused']).toContain(v.status);
      expect(e!.status).toBe(v.status === 'paused' ? 'paused' : 'delivering');

      const u = await scheduled();
      const [cancel, unschedule] = await Promise.all([
        manager.post(url(`/${u.id}/cancel`), { expectedVersion: u.version }),
        manager.post(url(`/${u.id}/unschedule`), { expectedVersion: u.version }),
      ]);
      expect([cancel.status, unschedule.status].sort()).toEqual([200, 409]);
      expect((await executions(u.id))[0]!.status).toBe('cancelled');
    });
  });

  it('6.9 follow-ups are dispatched only after commit: cancel/unschedule → finalize; resume → run; failed resume → finalize; pause → none', async () => {
    const a = await scheduled();
    const un = await manager.post(url(`/${a.id}/unschedule`), { expectedVersion: a.version });
    expect(un.status).toBe(200);
    expect(jobs.for('campaign.execution.finalize', a.executionId)).toHaveLength(1);

    const b = await sending('delivering');
    const before = jobs.jobs.length;
    expect((await manager.post(url(`/${b.id}/pause`))).status).toBe(200);
    expect(jobs.jobs.length).toBe(before); // pause: the runner stops at its next page/batch lock
    expect((await manager.post(url(`/${b.id}/resume`))).status).toBe(200);
    expect(jobs.for('campaign.execution.run', b.executionId)).toHaveLength(1);
    const cv = (await view(b.id)).version;
    expect((await manager.post(url(`/${b.id}/cancel`), { expectedVersion: cv })).status).toBe(200);
    expect(jobs.for('campaign.execution.finalize', b.executionId)).toHaveLength(1);

    // rejected or no-op commands dispatch nothing
    const n = jobs.jobs.length;
    expect((await manager.post(url(`/${b.id}/cancel`), { expectedVersion: cv })).status).toBe(409);
    expect(jobs.jobs.length).toBe(n);
  });

  describe('restore version (row 20)', () => {
    it('copies the snapshot into the draft as an edit (campaign.updated + restoredFromVersion); editable states only', async () => {
      const s = await scheduled();
      const [v1] = await versions(s.id);
      const blocked = await owner.post(url(`/${s.id}/versions/${v1!.id}/restore`), { expectedVersion: s.version });
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('CAMPAIGN_NOT_EDITABLE');
      const u = await manager.post(url(`/${s.id}/unschedule`), { expectedVersion: s.version });
      const p = await owner.patch(url(`/${s.id}`), { expectedVersion: u.body.version, messages: [{ variantKey: 'default', content: { ...content, subject: 'Other' } }] });
      const r = await editor.post(url(`/${s.id}/versions/${v1!.id}/restore`), { expectedVersion: p.body.version });
      expect(r.status).toBe(200);
      expect(r.body.draft.messages[0].content.subject).toBe('Winter sale');
      expect((await events(s.id)).at(-1)).toMatchObject({ type: 'campaign.updated', payload: { changes: ['messages', 'restoredFromVersion'] } });
      expect((await owner.post(url(`/${s.id}/versions/${v1!.id}/restore`), { expectedVersion: p.body.version })).body.error.code).toBe('version_conflict');
      expect((await owner.post(url(`/${s.id}/versions/${randomUUID()}/restore`), { expectedVersion: r.body.version })).status).toBe(404);
      expect((await outsider.post(url(`/${s.id}/versions/${v1!.id}/restore`, WB), { expectedVersion: r.body.version })).status).toBe(404);
    });
  });

  describe('idempotency (database-backed, per user, claim-first)', () => {
    const key = () => ({ headers: { 'idempotency-key': `lc-${randomUUID()}` } });

    it('schedule / send-now: a retry with the same key replays the stored response; one version, one execution', async () => {
      for (const mode of ['at', 'now'] as const) {
        const c = await ready();
        const k = key();
        const body = mode === 'at' ? { mode, sendAt: tomorrow(), expectedVersion: c.version } : { mode, expectedVersion: c.version };
        const first = await manager.post(url(`/${c.id}/schedule`), body, k);
        const retry = await manager.post(url(`/${c.id}/schedule`), body, k);
        expect([first.status, retry.status]).toEqual([200, 200]);
        expect(retry.body).toEqual(first.body);
        expect(await versions(c.id)).toHaveLength(1);
        expect(await executions(c.id)).toHaveLength(1);
        expect((await types(c.id)).filter((x) => x === 'campaign.scheduled')).toHaveLength(1);
        const other = await manager.post(url(`/${c.id}/schedule`), { ...body, expectedVersion: c.version + 5 }, k);
        expect(other.body.error.code).toBe('idempotency_conflict');
      }
    });

    it('concurrent retries with the same key run the command once', async () => {
      const c = await ready();
      const k = key();
      // Retries are byte-identical (one sendAt): a different body under the same key is idempotency_conflict, by design.
      const body = { mode: 'at', sendAt: tomorrow(), expectedVersion: c.version };
      const rs = await Promise.all([0, 1, 2].map(() => manager.post(url(`/${c.id}/schedule`), body, k)));
      expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
      for (const r of rs) if (r.status !== 200) expect(r.body.error.code).toBe('conflict'); // still being processed
      expect(await versions(c.id)).toHaveLength(1);
    });

    it('reschedule, unschedule, pause, resume, cancel: replayed, applied once', async () => {
      const s = await scheduled();
      const steps: [string, Record<string, unknown>, string][] = [];
      const once = async (path: string, body: Record<string, unknown>, event: string) => {
        const k = key();
        const a = await manager.post(url(`/${s.id}/${path}`), body, k);
        const b = await manager.post(url(`/${s.id}/${path}`), body, k);
        expect([a.status, b.status], `${path}: ${JSON.stringify(a.body)}`).toEqual([200, 200]);
        expect(b.body).toEqual(a.body);
        expect((await types(s.id)).filter((x) => x === event), path).toHaveLength(1);
        steps.push([path, body, event]);
        return a.body.version as number;
      };
      let v = await once('reschedule', { sendAt: tomorrow(60), expectedVersion: s.version }, 'campaign.rescheduled');
      v = await once('unschedule', { expectedVersion: v }, 'campaign.unscheduled');

      const p = await sending('delivering');
      const ops = async (path: string, body: Record<string, unknown>, event: string) => {
        const k = key();
        const a = await manager.post(url(`/${p.id}/${path}`), body, k);
        const b = await manager.post(url(`/${p.id}/${path}`), body, k);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(b.body).toEqual(a.body);
        expect((await types(p.id)).filter((x) => x === event)).toHaveLength(1);
        return a.body.version as number;
      };
      await ops('pause', {}, 'campaign.paused');
      const rv = await ops('resume', {}, 'campaign.resumed');
      await ops('cancel', { expectedVersion: rv }, 'campaign.cancelled');
      expect(steps).toHaveLength(2);
    });

    it('a key is scoped to the user and the command: another user or command never replays it', async () => {
      const c = await ready();
      const k = key();
      const first = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: tomorrow(), expectedVersion: c.version }, k);
      expect(first.status).toBe(200);
      const otherUser = await owner.post(url(`/${c.id}/unschedule`), { expectedVersion: first.body.version }, k);
      expect(otherUser.status).toBe(200); // owner's own key space: executes
      const otherCommand = await manager.post(url(`/${c.id}/unschedule`), { expectedVersion: first.body.version }, k);
      expect(otherCommand.body.error.code).toBe('idempotency_conflict');
    });
  });

  it('error bodies never leak database text', async () => {
    const c = await ready();
    const bad = [
      await manager.post(url(`/${c.id}/schedule`), { mode: 'at', expectedVersion: c.version }),
      await manager.post(url(`/${c.id}/schedule`), { mode: 'now', sendAt: tomorrow(), expectedVersion: c.version }),
      await manager.post(url(`/${c.id}/reschedule`), { sendAt: 'tomorrow', expectedVersion: c.version }),
      await manager.post(url(`/${c.id}/cancel`), { expectedVersion: -1 }),
      await manager.post(url(`/${c.id}/pause`), { orgId }),
    ];
    for (const r of bad) {
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toMatch(/prisma|postgres|sql|constraint|violat|relation|column/i);
    }
  });
});
