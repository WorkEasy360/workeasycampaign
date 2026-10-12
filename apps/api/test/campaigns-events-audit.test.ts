import { randomUUID } from 'node:crypto';
import { CAMPAIGN_EVENT_PAYLOAD_SCHEMAS, CAMPAIGN_EVENT_TYPES } from '@workeasy/shared';
import { withAppConnection } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { DOMAIN_EVENTS } from '../src/modules/events/catalogue.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, inviteAndAccept, resetTestDatabase, signUp, startTestApp, type TestApp, userIdOf, withOwnerConnection } from './support.js';

/**
 * Milestone 6.10 — events + audit (event contract v1, docs/events.md; audit actions, docs/contracts/phase-6-campaign.md
 * §15 + 6.10 additions). One full lifecycle through HTTP with the real execution engine (test delivery mode), then:
 * catalogue integrity, attribution of every event and audit row (tenant, actor, source, correlation), completeness,
 * a PII scan, RLS on events and audit, and audit-read authorization.
 */
describe('campaign events + audit (6.10)', () => {
  let t: TestApp;
  let owner: Agent;
  let manager: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let orgB: string;
  let WB: string;
  let managerId: string;
  let ownerId: string;
  let topicId: string;
  let dispatcher: InlineJobDispatcher;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const content = { schema: 'email.content.v1', subject: 'Quarterly secret offer', preheader: 'Hidden preheader', body: { format: 'text', text: 'Confidential body copy' } };
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      await dispatcher.idle();
      await new Promise((r) => setTimeout(r, 40));
      if (!(dispatcher as unknown as { running: Set<unknown> }).running.size) return;
    }
  };
  const ids: { campaigns: string[]; requests: Record<string, string>; contacts: string[]; emails: string[] } = { campaigns: [], requests: {}, contacts: [], emails: [] };

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    dispatcher = t.app.get(JOB_DISPATCHER, { strict: false });
    owner = await signUp(t, undefined, 'Owner Person');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Audit Co'));
    manager = await signUp(t, undefined, 'Manager Person');
    viewer = await signUp(t, undefined, 'Viewer Person');
    await inviteAndAccept(t, owner, manager, orgId, 'member', [{ workspaceId: W, roleKey: 'manager' }]);
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ orgId: orgB, workspaceId: WB } = await createOrg(outsider, 'Other Co'));
    managerId = await userIdOf(manager);
    ownerId = await userIdOf(owner);
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;

    // ── the scenario: every command and every system transition, through HTTP ──────────────────────────────
    const secret = (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret;
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Audit list' })).body.id as string;
    const seeded = await seedAudience({ orgId, workspaceId: W, listId, n: 8, eligible: 6, secret });
    ids.contacts = seeded.ids;
    ids.emails = seeded.emails;
    const req = async (name: string, p: Promise<{ status: number; body: any; headers: Record<string, unknown> }>, expected = 200) => {
      const r = await p;
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(expected);
      ids.requests[name] = String(r.headers['x-request-id']);
      return r.body;
    };
    const create = await req('create', owner.post(url(), { name: 'Audit campaign', channel: 'email', topicId }), 201);
    const A = create.id as string;
    ids.campaigns.push(A);
    let v = (await req('update', owner.patch(url(`/${A}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Secret Sender Name', replyTo: 'secret.reply@example.test' },
      messages: [{ variantKey: 'default', content }],
    }))).version;
    const clone = await req('clone', owner.post(url(`/${A}/clone`), {}), 201);
    ids.campaigns.push(clone.id);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    v = (await req('schedule', manager.post(url(`/${A}/schedule`), { mode: 'at', sendAt: later, expectedVersion: v }))).version;
    v = (await req('reschedule', manager.post(url(`/${A}/reschedule`), { sendAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), expectedVersion: v }))).version;
    v = (await req('unschedule', manager.post(url(`/${A}/unschedule`), { expectedVersion: v }))).version;
    const versionId = (await owner.get(url(`/${A}/versions`))).body.data[0].id as string;
    v = (await req('restoreVersion', owner.post(url(`/${A}/versions/${versionId}/restore`), { expectedVersion: v }))).version;
    // send now → the engine runs to completion (system events)
    await req('sendNow', manager.post(url(`/${A}/schedule`), { mode: 'now', expectedVersion: v }));
    await idle();
    expect((await owner.get(url(`/${A}`))).body.status).toBe('completed');
    // delete + restore on the clone
    await req('delete', owner.delete(url(`/${clone.id}`), { expectedVersion: clone.version }));
    await req('restore', owner.post(url(`/${clone.id}/restore`), {}));
    // pause / resume / cancel and a configuration failure → return to draft on another campaign
    const topicB = (await owner.post(`/v1/workspaces/${W}/topics`, { name: 'Topic B', key: 'audit_topic_b' })).body.id as string;
    const B = (await req('createB', owner.post(url(), { name: 'Audit B', channel: 'email', topicId: topicB }), 201)).id as string;
    ids.campaigns.push(B);
    const vb = (await owner.patch(url(`/${B}`), { expectedVersion: 1, audience: { include: [{ type: 'list', listId }], exclude: [] }, sender: { senderIdentityId: null, fromName: 'Secret Sender Name', replyTo: null }, messages: [{ variantKey: 'default', content }] })).body.version;
    const sb = await req('scheduleB', manager.post(url(`/${B}/schedule`), { mode: 'at', sendAt: later, expectedVersion: vb }));
    await q(`UPDATE campaign_executions SET status = 'delivering', started_at = now(), materialized_at = now() WHERE id = $1`, [sb.currentExecution.id]);
    await q(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [B]);
    // keep the engine away from this seeded state: pause first, then a configuration failure on resume
    await req('pause', manager.post(url(`/${B}/pause`)));
    expect((await owner.post(`/v1/workspaces/${W}/topics/${topicB}/archive`)).status).toBe(200);
    await req('resumeFails', manager.post(url(`/${B}/resume`)));
    await idle();
    await req('returnToDraft', owner.post(url(`/${B}/return-to-draft`)));
    const C = (await req('createC', owner.post(url(), { name: 'Audit C', channel: 'email', topicId }), 201)).id as string;
    ids.campaigns.push(C);
    const vc = (await owner.patch(url(`/${C}`), { expectedVersion: 1, audience: { include: [{ type: 'list', listId }], exclude: [] }, sender: { senderIdentityId: null, fromName: 'Secret Sender Name', replyTo: null }, messages: [{ variantKey: 'default', content }] })).body.version;
    const sc = await req('scheduleC', manager.post(url(`/${C}/schedule`), { mode: 'at', sendAt: later, expectedVersion: vc }));
    await req('cancel', manager.post(url(`/${C}/cancel`), { expectedVersion: sc.version }));
    await idle();
  }, 180_000);
  afterAll(async () => {
    await idle();
    await t?.close();
  });

  const events = () => q(`SELECT * FROM domain_events WHERE aggregate_type = 'campaign' AND org_id = $1 ORDER BY recorded_at, id`, [orgId]);
  const audits = () => q(`SELECT * FROM audit_logs WHERE org_id = $1 AND (action LIKE 'campaign.%' OR action = 'access.denied') ORDER BY occurred_at, id`, [orgId]);

  describe('catalogue', () => {
    it('every campaign event type of the contract is registered once, v1, aggregate campaign, with the shared payload schema', () => {
      expect(CAMPAIGN_EVENT_TYPES).toHaveLength(16);
      for (const type of CAMPAIGN_EVENT_TYPES) {
        const def = (DOMAIN_EVENTS as Record<string, { version: number; aggregate: string; payload: unknown }>)[type];
        expect(def, type).toBeDefined();
        expect([def!.version, def!.aggregate]).toEqual([1, 'campaign']);
        expect(def!.payload).toBe(CAMPAIGN_EVENT_PAYLOAD_SCHEMAS[type]);
      }
      const campaignTypes = Object.keys(DOMAIN_EVENTS).filter((k) => k.startsWith('campaign.'));
      expect(campaignTypes.sort()).toEqual([...CAMPAIGN_EVENT_TYPES].sort());
    });

    it('payload schemas are strict: an extra field (e.g. an email) or a malformed id is rejected', () => {
      expect(() => CAMPAIGN_EVENT_PAYLOAD_SCHEMAS['campaign.started'].parse({ executionId: randomUUID(), email: 'x@example.test' })).toThrow();
      expect(() => CAMPAIGN_EVENT_PAYLOAD_SCHEMAS['campaign.scheduled'].parse({ versionId: 'nope', executionId: randomUUID(), sendAt: new Date().toISOString(), mode: 'now' })).toThrow();
      expect(() => CAMPAIGN_EVENT_PAYLOAD_SCHEMAS['campaign.completed'].parse({ executionId: randomUUID(), counts: { planned: -1, skipped: 0, sent: 0, failed: 0, cancelled: 0, unknown: 0 } })).toThrow();
      expect(() => CAMPAIGN_EVENT_PAYLOAD_SCHEMAS['campaign.updated'].parse({ changes: ['messages'], subject: 'leak' })).toThrow();
    });
  });

  describe('attribution and completeness', () => {
    it('every stored campaign event conforms to its schema and is tenant-, workspace- and actor-attributed', async () => {
      const rows = await events();
      expect(rows.length).toBeGreaterThan(20);
      for (const e of rows) {
        expect(() => (DOMAIN_EVENTS as Record<string, { payload: { parse(x: unknown): unknown } }>)[e.type]!.payload.parse(e.payload), e.type).not.toThrow();
        expect(e.org_id).toBe(orgId);
        expect(e.workspace_id).toBe(W);
        expect(e.version).toBe(1);
        expect(ids.campaigns).toContain(e.aggregate_id);
        expect(e.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
        if (e.actor_type === 'user') expect([ownerId, managerId]).toContain(e.actor_id);
        else expect([e.actor_type, e.actor_id, e.source]).toEqual(['system', null, 'campaign_runner']);
      }
    });

    it('commands: the event carries the acting user and the request id; system transitions carry the scheduling request id', async () => {
      const rows = await events();
      const byReq = (name: string) => rows.filter((e) => e.correlation_id === ids.requests[name]).map((e) => e.type);
      expect(byReq('create')).toEqual(['campaign.created']);
      expect(byReq('update')).toEqual(['campaign.updated']);
      expect(byReq('clone')).toEqual(['campaign.created']);
      expect(byReq('schedule')).toEqual(['campaign.version_created', 'campaign.scheduled']);
      expect(byReq('reschedule')).toEqual(['campaign.rescheduled']);
      expect(byReq('unschedule')).toEqual(['campaign.unscheduled']);
      expect(byReq('restoreVersion')).toEqual(['campaign.updated']);
      expect(byReq('delete')).toEqual(['campaign.deleted']);
      expect(byReq('restore')).toEqual(['campaign.restored']);
      expect(byReq('pause')).toEqual(['campaign.paused']);
      expect(byReq('resumeFails')).toEqual(['campaign.failed']);
      expect(byReq('returnToDraft')).toEqual(['campaign.returned_to_draft']);
      expect(byReq('cancel')).toEqual(['campaign.cancelled']);
      // send-now: the user's events and then the runner's, all under the same correlation id
      const sendNow = rows.filter((e) => e.correlation_id === ids.requests.sendNow);
      expect(sendNow.map((e) => e.type)).toEqual(['campaign.version_created', 'campaign.scheduled', 'campaign.started', 'campaign.audience_materialized', 'campaign.completed']);
      expect(sendNow.map((e) => e.actor_type)).toEqual(['user', 'user', 'system', 'system', 'system']);
      expect(sendNow.filter((e) => e.actor_type === 'user').every((e) => e.actor_id === managerId)).toBe(true);
      // exactly once per fact
      for (const type of ['campaign.started', 'campaign.audience_materialized', 'campaign.completed']) expect(rows.filter((e) => e.type === type)).toHaveLength(1);
    });

    it('audit: every business action recorded once with actor, workspace, target and correlation; system outcomes as actor system', async () => {
      const rows = await audits();
      const of = (name: string) => rows.filter((a) => a.correlation_id === ids.requests[name]).map((a) => a.action);
      expect(of('create')).toEqual(['campaign.created']);
      expect(of('update')).toEqual([]); // draft edits: events only (contract §15)
      expect(of('clone')).toEqual(['campaign.created']);
      expect(of('schedule')).toEqual(['campaign.scheduled']);
      expect(of('reschedule')).toEqual(['campaign.rescheduled']);
      expect(of('unschedule')).toEqual(['campaign.unscheduled']);
      expect(of('restoreVersion')).toEqual(['campaign.version_restored']);
      expect(of('delete')).toEqual(['campaign.deleted']);
      expect(of('restore')).toEqual(['campaign.restored']);
      expect(of('pause')).toEqual(['campaign.paused']);
      expect(of('resumeFails')).toEqual([]); // the failure is recorded by the event + the runner-side audit below only when the runner fails it
      expect(of('returnToDraft')).toEqual(['campaign.returned_to_draft']);
      expect(of('cancel')).toEqual(['campaign.cancelled']);
      expect(of('sendNow')).toEqual(['campaign.scheduled', 'campaign.execution_started', 'campaign.execution_completed']);
      const cloneAudit = rows.find((a) => a.correlation_id === ids.requests.clone)!;
      expect(cloneAudit.metadata.clonedFrom).toMatchObject({ campaignId: ids.campaigns[0] });
      for (const a of rows.filter((x) => x.action.startsWith('campaign.'))) {
        expect(a.workspace_id).toBe(W);
        expect(a.target_type).toBe('campaign');
        expect(ids.campaigns).toContain(a.target_id);
        if (a.actor_type === 'user') expect([ownerId, managerId]).toContain(a.actor_id);
        else expect([a.actor_type, a.actor_id, a.ip_address]).toEqual(['system', null, null]);
      }
      const done = rows.find((a) => a.action === 'campaign.execution_completed')!;
      expect(done.metadata.counts).toMatchObject({ planned: 6, sent: 6, skipped: 2 });
    });

    it('a configuration failure detected by the runner is audited as a system failure', async () => {
      const C = ids.campaigns[0]!;
      void C;
      const secret = (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret;
      const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Failure list' })).body.id as string;
      await seedAudience({ orgId, workspaceId: W, listId, n: 2, eligible: 2, secret });
      const c = await owner.post(url(), { name: 'Fails at start', channel: 'email', topicId });
      const p = await owner.patch(url(`/${c.body.id}`), { expectedVersion: 1, audience: { include: [{ type: 'list', listId }], exclude: [] }, sender: { senderIdentityId: null, fromName: 'X', replyTo: null }, messages: [{ variantKey: 'default', content }] });
      const s = await manager.post(url(`/${c.body.id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: p.body.version });
      await owner.delete(`/v1/workspaces/${W}/lists/${listId}`); // source gone before T0
      await q(`UPDATE campaign_executions SET send_at = now() - interval '1 minute' WHERE id = $1`, [s.body.currentExecution.id]);
      const { ExecutionService } = await import('../src/modules/campaigns/application/execution.service.js');
      const svc = t.app.get(ExecutionService, { strict: false });
      expect(await svc.start({ tenant: { orgId, workspaceId: W }, actor: { type: 'system', id: null }, correlationId: s.headers['x-request-id'] as string, payload: { executionId: s.body.currentExecution.id, attempt: 0 } })).toBe('started');
      await idle();
      const a = (await audits()).filter((x) => x.target_id === c.body.id && x.action === 'campaign.execution_failed');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ actor_type: 'system', outcome: 'failure', correlation_id: s.headers['x-request-id'] });
      expect(a[0]!.metadata).toEqual({ executionId: s.body.currentExecution.id, failureClass: 'configuration', failureCode: 'AUDIENCE_SOURCE_NOT_FOUND' });
    });
  });

  describe('privacy, isolation, authorization', () => {
    it('PII scan: no contact address, contact id, subject, preheader, body, sender name or reply-to in any campaign event or audit row', async () => {
      const ev = JSON.stringify(await events());
      // actor email/name snapshots are the staff identity of the actor (Phase 4 audit design), not campaign data
      const au = JSON.stringify((await audits()).map(({ metadata, ...rest }) => ({ ...rest, metadata: { ...metadata, actorEmail: undefined, actorName: undefined } })));
      const secrets = ['Quarterly secret offer', 'Hidden preheader', 'Confidential body copy', 'Secret Sender Name', 'secret.reply@example.test', ...ids.emails, ...ids.contacts];
      for (const s of secrets) {
        expect(ev, s).not.toContain(s);
        expect(au, s).not.toContain(s);
      }
      expect(ev).not.toMatch(/@/);
    });

    it('RLS: another organization sees no events or audit rows; another workspace of the same org sees no events', async () => {
      const count = (ctx: { orgId: string; workspaceId: string | null }) =>
        withAppConnection(ctx, async (c) => ({
          events: Number((await c.query(`SELECT count(*) AS n FROM domain_events WHERE aggregate_id = ANY($1::uuid[])`, [ids.campaigns])).rows[0].n),
          audits: Number((await c.query(`SELECT count(*) AS n FROM audit_logs WHERE target_id = ANY($1::text[])`, [ids.campaigns])).rows[0].n),
        }));
      expect(await count({ orgId: orgB, workspaceId: WB })).toEqual({ events: 0, audits: 0 });
      expect(await count({ orgId: orgB, workspaceId: null })).toEqual({ events: 0, audits: 0 });
      // domain_events: a workspace context sees only its own workspace (Phase 5 policy). audit_logs: organization-scoped
      // by design (Phase 4) — workspace separation is the API's (org-level audit API behind `audit.read`); asserted so a
      // change of either design is noticed.
      const sameOrg = await count({ orgId, workspaceId: randomUUID() });
      expect(sameOrg.events).toBe(0);
      expect(sameOrg.audits).toBeGreaterThan(0);
      expect((await count({ orgId, workspaceId: W })).events).toBeGreaterThan(0);
    });

    it('audit read: the owner sees the campaign actions; workspace roles without audit.read and other organizations do not', async () => {
      const own = await owner.get(`/v1/organizations/${orgId}/audit-logs?action=campaign.scheduled&limit=100`);
      expect(own.status).toBe(200);
      expect(own.body.data.length).toBeGreaterThanOrEqual(3);
      expect(own.body.data.every((a: { action: string }) => a.action === 'campaign.scheduled')).toBe(true);
      expect([403, 404]).toContain((await manager.get(`/v1/organizations/${orgId}/audit-logs`)).status);
      expect([403, 404]).toContain((await viewer.get(`/v1/organizations/${orgId}/audit-logs`)).status);
      expect((await outsider.get(`/v1/organizations/${orgId}/audit-logs`)).status).toBe(404);
      const theirs = await outsider.get(`/v1/organizations/${orgB}/audit-logs?limit=100`);
      expect(theirs.status).toBe(200);
      expect(JSON.stringify(theirs.body)).not.toContain(ids.campaigns[0]);
    });
  });
});
