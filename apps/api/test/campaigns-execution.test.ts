import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import type { AudienceResolutionV1_2 } from '@workeasy/audience-core';
import type { Database, Tx } from '@workeasy/db';
import { APP_CONFIG, AUDIENCE_RESOLUTION, DATABASE } from '../src/infrastructure/providers.js';
import { CAMPAIGN_DELIVERY_PORT } from '../src/modules/campaigns/application/delivery.js';
import { EXECUTION_JOBS, type ExecutionJobEnvelope } from '../src/modules/campaigns/application/execution-jobs.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import { resolveDeliveryMode } from '../src/modules/campaigns/domain/delivery-mode.js';
import { NullDeliveryPort } from '../src/modules/campaigns/infrastructure/null-delivery-port.js';
import { seedAudience } from './execution-support.js';
import { Agent, createOrg, inviteAndAccept, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Milestone 6.9 — execution engine (Gate G3, TEST MODE ONLY; contract §5–§7, §10, §11; architecture §22), end to end
 * with the real in-process JobDispatcher: send-now → start (S1) → capture (S2/S3) → pages with Checkpoint A →
 * recipients → delivering → snapshot release → claim → Checkpoint B → NullDeliveryPort → completion derived from rows.
 * Crashes are injected at named points (ExecutionService.testHooks) or by leaving an expired lease behind; recovery is
 * the job retry or the recovery sweep. The database is the source of truth for every assertion.
 */
describe('campaign execution (6.9)', () => {
  let t: TestApp;
  let owner: Agent;
  let manager: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  let secret: string;
  let svc: ExecutionService;
  let port: NullDeliveryPort;
  let dispatcher: InlineJobDispatcher;
  const dispatched: { name: string; data: unknown }[] = [];
  /** Simulates a lost job (process died between commit and dispatch): the next job of this name is recorded, not run. */
  let dropNext: string | null = null;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const content = { schema: 'email.content.v1', subject: 'Secret subject line', preheader: '', body: { format: 'text', text: 'Private body text' } };
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const execOf = async (id: string) => {
    const e = (await q<Record<string, any>>(`SELECT * FROM campaign_executions WHERE id = $1`, [id]))[0]!;
    lastState = e && { status: e.status, health: e.health, lease: e.lease_owner, snap: e.audience_snapshot_id, cursor: e.materialization_cursor };
    return e;
  };
  const recipientsBy = async (executionId: string) =>
    Object.fromEntries((await q<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [executionId])).map((r) => [r.status, Number(r.n)])) as Record<string, number>;
  const duplicates = async (executionId: string) =>
    Number((await q<{ n: string }>(`SELECT count(*) - count(DISTINCT contact_id) AS n FROM campaign_recipients WHERE execution_id = $1`, [executionId]))[0]!.n);
  const snapshotOf = async (executionId: string) =>
    q<{ id: string; owner_kind: string; owner_id: string; released_at: Date | null; release_reason: string | null; purged_at: Date | null; size: number }>(
      `SELECT id, owner_kind, owner_id::text, released_at, release_reason, purged_at, size FROM audience_snapshots WHERE capture_key = $1`,
      [executionId],
    );
  const eventTypes = async (campaignId: string) => (await q<{ type: string }>(`SELECT type FROM domain_events WHERE aggregate_id = $1 ORDER BY occurred_at, id`, [campaignId])).map((r) => r.type);
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      await dispatcher.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(dispatcher as unknown as { running: Set<unknown> }).running.size) {
        await new Promise((r) => setTimeout(r, 50));
        if (!(dispatcher as unknown as { running: Set<unknown> }).running.size) return;
      }
    }
  };
  let lastState: unknown = null;
  const waitFor = async (pred: () => Promise<boolean>, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('condition not reached: ' + JSON.stringify(lastState));
  };
  const once = (fn: () => Promise<void> | void) => {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      await fn();
    };
  };
  const crashOnce = () => once(() => { throw new Error('simulated crash'); });

  async function campaignWith(n: number, eligible: number, name = 'Run') {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `${name}-${randomUUID().slice(0, 6)}` })).body.id as string;
    const seeded = await seedAudience({ orgId, workspaceId: W, listId, n, eligible, secret });
    const c = await owner.post(url(), { name, channel: 'email', topicId });
    const p = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme Secret Sender', replyTo: null },
      messages: [{ variantKey: 'default', content }],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return { id: c.body.id as string, version: p.body.version as number, listId, ...seeded };
  }
  async function sendNow(c: { id: string; version: number }) {
    const r = await manager.post(url(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.currentExecution.id as string;
  }
  const envFor = (executionId: string, ws = W): ExecutionJobEnvelope => ({ tenant: { orgId, workspaceId: ws }, actor: { type: 'system', id: null }, correlationId: randomUUID(), payload: { executionId, attempt: 0 } });

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    svc = t.app.get(ExecutionService, { strict: false });
    port = t.app.get(CAMPAIGN_DELIVERY_PORT, { strict: false });
    dispatcher = t.app.get(JOB_DISPATCHER, { strict: false });
    const original = dispatcher.dispatch.bind(dispatcher);
    dispatcher.dispatch = (name: string, data: unknown) => {
      dispatched.push({ name, data: structuredClone(data) });
      if (dropNext === name) {
        dropNext = null;
        return;
      }
      original(name, data);
    };
    secret = (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret;
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Exec Co'));
    manager = await signUp(t, undefined, 'Manager');
    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, manager, orgId, 'member', [{ workspaceId: W, roleKey: 'manager' }]);
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  afterAll(async () => {
    await idle();
    await t?.close();
  });
  beforeEach(async () => {
    await idle();
    svc.testHooks = {};
    port.reset();
    svc.configure({ pageSize: 7, deliveryBatch: 5, pageRetryDelaysMs: [10, 20], jobRetryDelaysMs: [30, 30, 30], recipientLeaseMs: 300_000, leaseMs: 60_000 });
  });

  describe('happy path and invariants', () => {
    it('send-now: start → capture → pages + Checkpoint A → delivering → release → Checkpoint B → NullDeliveryPort → completed; counts derived from rows', async () => {
      const c = await campaignWith(30, 22);
      const ex = await sendNow(c);
      await idle();
      const e = await execOf(ex);
      expect(e).toMatchObject({ status: 'completed', health: 'ok', audience_size: 30, planned: 22, skipped: 8, sent: 22, failed: 0, cancelled: 0, unknown: 0, lease_owner: null });
      expect(e.started_at).not.toBeNull();
      expect(e.materialized_at).not.toBeNull();
      expect(e.completed_at).not.toBeNull();
      expect(e.captured_at.getTime()).toBeGreaterThanOrEqual(e.started_at.getTime());
      expect(e.skipped_by_reason).toEqual({ CONSENT_MISSING: 8 });
      expect(await recipientsBy(ex)).toEqual({ sent: 22, skipped: 8 });
      expect(await duplicates(ex)).toBe(0);
      expect(port.acknowledged).toBe(22);
      // every acknowledged key is a sent recipient's id; one acknowledgement per recipient
      const sentIds = (await q<{ id: string }>(`SELECT id FROM campaign_recipients WHERE execution_id = $1 AND status = 'sent'`, [ex])).map((r) => r.id);
      for (const id of sentIds) expect(port.callsFor(id)).toBe(1);
      // skipped rows carry approved reason codes only, no address
      const skipped = await q<{ reason_codes: string[]; address_identity_id: string | null }>(`SELECT reason_codes, address_identity_id FROM campaign_recipients WHERE execution_id = $1 AND status = 'skipped'`, [ex]);
      for (const s of skipped) expect([s.reason_codes, s.address_identity_id]).toEqual([['CONSENT_MISSING'], null]);
      // snapshot: owned by the execution, keyed by its id, released after materialization and purged
      const [snap] = await snapshotOf(ex);
      expect(snap).toMatchObject({ owner_kind: 'campaign_execution', owner_id: ex, release_reason: 'materialized', size: 30 });
      expect(snap!.released_at).not.toBeNull();
      expect(snap!.purged_at).not.toBeNull();
      expect(e.snapshot_released_at).not.toBeNull();
      expect(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM audience_snapshot_chunks WHERE snapshot_id = $1`, [snap!.id]))[0]!.n)).toBe(0);
      // campaign + events
      expect((await owner.get(url(`/${c.id}`))).body.status).toBe('completed');
      expect(await eventTypes(c.id)).toEqual(expect.arrayContaining(['campaign.scheduled', 'campaign.started', 'campaign.audience_materialized', 'campaign.completed']));
      // the version is the immutable source: a later draft edit cannot reach this execution
      expect((await q<{ n: string }>(`SELECT count(*) AS n FROM campaign_versions WHERE campaign_id = $1`, [c.id]))[0]!.n).toBe('1');
    });

    it('schedule refuses an audience with no eligible contact (pre-flight); if it becomes empty or ineligible only at T0, the execution completes with zero hand-offs', async () => {
      const z = await campaignWith(4, 0);
      const refused = await manager.post(url(`/${z.id}/schedule`), { mode: 'now', expectedVersion: z.version });
      expect([refused.status, refused.body.error.code]).toEqual([422, 'PREFLIGHT_FAILED']);

      const a = await campaignWith(4, 4);
      svc.testHooks.beforeCapture = once(async () => {
        await q(`UPDATE consent_states SET state = 'withdrawn' WHERE contact_id = ANY($1::uuid[])`, [a.ids]); // all ineligible at A
      });
      const exA = await sendNow(a);
      await idle();
      expect(await execOf(exA)).toMatchObject({ status: 'completed', audience_size: 4, planned: 0, skipped: 4, sent: 0 });
      expect(await recipientsBy(exA)).toEqual({ skipped: 4 });

      const b = await campaignWith(3, 3);
      svc.testHooks.beforeCapture = once(async () => {
        await q(`DELETE FROM list_memberships WHERE list_id = $1`, [b.listId]); // empty at T0
      });
      const exB = await sendNow(b);
      await idle();
      expect(await execOf(exB)).toMatchObject({ status: 'completed', audience_size: 0, planned: 0, skipped: 0, sent: 0 });
      expect(port.acknowledged).toBe(0);
    });

    it('execution reads (rows 21–22): viewer reads; foreign workspace / other campaign / unauthenticated are 404 / 401', async () => {
      const c = await campaignWith(3, 3);
      const ex = await sendNow(c);
      await idle();
      const list = await viewer.get(url(`/${c.id}/executions`));
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ id: ex, runNumber: 1, status: 'completed', counts: { planned: 3, sent: 3 } });
      // Exact key set (no recipient data). maxPerHour: the run's own sending limit (Phase 7.11), null when unset.
      expect(Object.keys(list.body.data[0]).sort()).toEqual(['completedAt', 'counts', 'failure', 'health', 'id', 'lastProgressAt', 'materializedAt', 'maxPerHour', 'runNumber', 'sendAt', 'skippedByReason', 'startedAt', 'status']);
      expect(list.body.data[0].maxPerHour).toBeNull();
      expect((await viewer.get(url(`/${c.id}/executions/${ex}`))).body.id).toBe(ex);
      const other = await campaignWith(1, 1);
      expect((await owner.get(url(`/${other.id}/executions/${ex}`))).status).toBe(404);
      expect((await outsider.get(url(`/${c.id}/executions/${ex}`))).status).toBe(404);
      expect((await outsider.get(url(`/${c.id}/executions/${ex}`, WB))).status).toBe(404);
      expect((await new Agent(t).get(url(`/${c.id}/executions`))).status).toBe(401);
      expect((await owner.get(url(`/${c.id}/executions/not-a-uuid`))).status).toBe(404);
    });
  });

  describe('Checkpoint B (fresh, immediately before hand-off)', () => {
    it('changes after Checkpoint A — consent withdrawn, suppression, contact deleted, topic unsubscribe — are skipped_at_send and never handed off', async () => {
      const c = await campaignWith(20, 20);
      const victims = c.eligibleIds.slice(-4);
      let hookError: unknown;
      svc.testHooks.beforeCheckpointB = once(async () => {
        try {
        // after materialization (all 20 pending), before the first hand-off
        await q(`UPDATE consent_states SET state = 'withdrawn' WHERE contact_id = $1`, [victims[0]]);
        await q(
          `INSERT INTO suppressions (id, org_id, workspace_id, channel, contact_id, reason, source, active_key) VALUES (gen_random_uuid(), $1, $2, 'all', $3::uuid, 'manual', 'admin', 'contact:' || $3::text || ':all')`,
          [orgId, W, victims[1]],
        );
        await q(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [victims[2]]);
        await q(
          `INSERT INTO contact_topic_preferences (org_id, workspace_id, contact_id, topic_id, status, changed_by, last_event_id, changed_at)
           SELECT $1, $2, $3, $4, 'unsubscribed', 'user', last_event_id, now() FROM consent_states WHERE contact_id = $3`,
          [orgId, W, victims[3], topicId],
        );
        } catch (err) {
          hookError = err;
        }
      });
      const ex = await sendNow(c);
      await idle();
      expect(hookError).toBeUndefined();
      const e = await execOf(ex);
      expect(e).toMatchObject({ status: 'completed', planned: 20, sent: 16, skipped: 4 });
      expect(await recipientsBy(ex)).toEqual({ sent: 16, skipped_at_send: 4 });
      const rows = await q<{ contact_id: string; reason_codes: string[] }>(`SELECT contact_id, reason_codes FROM campaign_recipients WHERE execution_id = $1 AND status = 'skipped_at_send'`, [ex]);
      const byContact = Object.fromEntries(rows.map((r) => [r.contact_id, r.reason_codes]));
      expect(byContact[victims[0]!]).toContain('CONSENT_WITHDRAWN');
      expect(byContact[victims[1]!]).toContain('SUPPRESSED');
      expect(byContact[victims[2]!]).toContain('CONTACT_DELETED');
      expect(byContact[victims[3]!]).toContain('TOPIC_UNSUBSCRIBED');
      const victimRecipients = await q<{ id: string }>(`SELECT id FROM campaign_recipients WHERE execution_id = $1 AND contact_id = ANY($2::uuid[])`, [ex, victims]);
      for (const r of victimRecipients) expect(port.callsFor(r.id)).toBe(0);
      expect(port.acknowledged).toBe(16);
    });
  });

  describe('crash / resume (contract §6.4 trigger 4; §10.2)', () => {
    for (const point of ['beforeCapture', 'afterCapture', 'afterPage', 'beforeRelease', 'beforeCheckpointB', 'beforeComplete'] as const) {
      it(`crash at ${point}: the job retry resumes from the checkpoint — one snapshot, no duplicate recipient, one acknowledgement each`, async () => {
        const c = await campaignWith(23, 17);
        svc.testHooks[point] = crashOnce();
        const ex = await sendNow(c);
        await waitFor(async () => (await execOf(ex)).status === 'completed');
        await idle();
        const e = await execOf(ex);
        expect(e).toMatchObject({ status: 'completed', planned: 17, skipped: 6, sent: 17, health: 'ok' });
        expect(await duplicates(ex)).toBe(0);
        expect(await snapshotOf(ex)).toHaveLength(1);
        expect(port.acknowledged).toBe(17);
        expect((await snapshotOf(ex))[0]!.purged_at).not.toBeNull();
      });
    }

    it('crash mid-delivery (hand-off interrupted after Checkpoint B): the claim expires, the same key is retried, the receiver deduplicates — sent once', async () => {
      svc.configure({ recipientLeaseMs: 300 });
      const c = await campaignWith(12, 12);
      let crashed = '';
      port.beforeAck = async (item) => {
        if (!crashed) {
          crashed = item.recipientId;
          // simulate: the provider accepted, then the process died before the outcome was written
          await port.deliver({ ...item });
          port.beforeAck = null;
          throw new Error('simulated crash after hand-off');
        }
      };
      const ex = await sendNow(c);
      await waitFor(async () => (await execOf(ex)).status === 'completed');
      await idle();
      expect(await recipientsBy(ex)).toEqual({ sent: 12 });
      expect(port.acknowledged).toBe(12);
      expect(port.callsFor(crashed)).toBeGreaterThanOrEqual(2); // re-handed off with the SAME key, deduplicated
      expect(await execOf(ex)).toMatchObject({ sent: 12 });
    });

    it('hard crash (lease left behind, no retry): stalled work is found by the recovery sweep only after the lease expires', async () => {
      svc.configure({ jobRetryDelaysMs: [] }); // no job retry: the first infrastructure failure marks it stalled
      const c = await campaignWith(15, 15);
      svc.testHooks.afterPage = crashOnce();
      const ex = await sendNow(c);
      await waitFor(async () => (await execOf(ex)).health === 'stalled');
      await idle();
      expect((await execOf(ex)).status).toBe('materializing'); // an infrastructure failure never fails the execution
      // a crashed process leaves its lease: the sweep must not take over before it expires
      await q(`UPDATE campaign_executions SET lease_owner = 'dead-worker', lease_until = now() + interval '1 hour' WHERE id = $1`, [ex]);
      const runsFor = () => dispatched.filter((d) => d.name === EXECUTION_JOBS.run && (d.data as ExecutionJobEnvelope).payload.executionId === ex).length;
      const r0 = runsFor();
      await svc.sweep();
      expect(runsFor()).toBe(r0); // live (dead worker's) lease: not taken over
      await q(`UPDATE campaign_executions SET lease_until = now() - interval '1 second' WHERE id = $1`, [ex]);
      await svc.sweep();
      expect(runsFor()).toBe(r0 + 1);
      await waitFor(async () => (await execOf(ex)).status === 'completed');
      await idle();
      expect(await execOf(ex)).toMatchObject({ status: 'completed', sent: 15, health: 'ok' });
      expect(await duplicates(ex)).toBe(0);
    });

    it('retries: page retries absorb a transient failure; job retries with backoff; recipient transient delivery failures are retried, then failed after 5 attempts without failing the execution', async () => {
      const c = await campaignWith(6, 6);
      port.failNext = 2; // two transient provider failures
      const ex = await sendNow(c);
      await waitFor(async () => (await execOf(ex)).status === 'completed');
      await idle();
      expect(await recipientsBy(ex)).toEqual({ sent: 6 });
      const attempts = await q<{ attempts: number }>(`SELECT attempts FROM campaign_recipients WHERE execution_id = $1 ORDER BY attempts DESC LIMIT 1`, [ex]);
      expect(attempts[0]!.attempts).toBeGreaterThanOrEqual(2);

      const d = await campaignWith(3, 3);
      port.failNext = 1_000; // provider keeps failing
      const exD = await sendNow(d);
      await waitFor(async () => (await execOf(exD)).status === 'completed', 60_000);
      await idle();
      port.failNext = 0;
      expect(await recipientsBy(exD)).toEqual({ failed: 3 });
      const fr = await q<{ attempts: number; failure_code: string }>(`SELECT attempts, failure_code FROM campaign_recipients WHERE execution_id = $1`, [exD]);
      for (const r of fr) expect(r).toEqual({ attempts: 5, failure_code: 'NULL_TRANSIENT' });
      expect(await execOf(exD)).toMatchObject({ status: 'completed', failed: 3, sent: 0 });
    });

    it('configuration failure at capture (source deleted before T0): execution failed, never retried, snapshot nothing to release', async () => {
      const c = await campaignWith(5, 5);
      svc.testHooks.beforeCapture = once(async () => {
        expect((await owner.delete(`/v1/workspaces/${W}/lists/${c.listId}`)).status).toBe(204);
      });
      const ex = await sendNow(c);
      await idle();
      expect(await execOf(ex)).toMatchObject({ status: 'failed', failure_class: 'configuration', failure_code: 'AUDIENCE_SOURCE_NOT_FOUND' });
      expect((await owner.get(url(`/${c.id}`))).body.status).toBe('failed');
      expect(await snapshotOf(ex)).toHaveLength(0);
      expect((await execOf(ex)).snapshot_released_at).not.toBeNull();
      expect(await recipientsBy(ex)).toEqual({});
    });

    it('start-time check (topic archived after scheduling): start fails the execution as configuration; nothing captured', async () => {
      const topic = (await owner.post(`/v1/workspaces/${W}/topics`, { name: 'Start check', key: `start_${randomUUID().slice(0, 6)}` })).body.id as string;
      const c = await campaignWith(3, 3);
      const v = (await owner.patch(url(`/${c.id}`), { expectedVersion: c.version, topicId: topic })).body.version;
      const s = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: v });
      const ex = s.body.currentExecution.id as string;
      await q(`UPDATE campaign_executions SET send_at = now() - interval '1 minute' WHERE id = $1`, [ex]); // due
      await owner.post(`/v1/workspaces/${W}/topics/${topic}/archive`);
      expect(await svc.start(envFor(ex))).toBe('failed');
      await idle();
      expect(await execOf(ex)).toMatchObject({ status: 'failed', failure_code: 'TOPIC_UNAVAILABLE' });
      expect(await snapshotOf(ex)).toHaveLength(0);
    });
  });

  describe('retry of the same page, lease renewal, recovery sweep', () => {
    it('a failure INSIDE a page transaction (after its inserts, before commit) rolls the page back; the page is retried; no duplicate; cursor advances once', async () => {
      const c = await campaignWith(20, 14);
      let fails = 2;
      svc.testHooks.inPage = () => {
        if (fails-- > 0) throw new Error('simulated commit failure');
      };
      const ex = await sendNow(c);
      await idle();
      expect(await execOf(ex)).toMatchObject({ status: 'completed', planned: 14, skipped: 6, sent: 14 });
      expect(await duplicates(ex)).toBe(0);
      expect(await recipientsBy(ex)).toEqual({ sent: 14, skipped: 6 });
    });

    it('the execution lease is renewed with every page (bounded ownership) and given back at the end', async () => {
      const c = await campaignWith(30, 30);
      const seen: number[] = [];
      let exId = '';
      svc.testHooks.afterPage = async ({ executionId }) => {
        exId = executionId;
        const e = await execOf(executionId);
        if (e.lease_until) seen.push(new Date(e.lease_until).getTime());
        await new Promise((r) => setTimeout(r, 15));
      };
      await sendNow(c);
      await idle();
      expect(seen.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
      expect(await execOf(exId)).toMatchObject({ status: 'completed', lease_owner: null, lease_until: null });
    });

    it('recovery sweep: lost start, interrupted cancel follow-up, unreleased materialized snapshot, orphan snapshot, incomplete purge — each recovered, nothing live touched', async () => {
      const db = t.app.get<Database>(DATABASE, { strict: false });
      const resolution = t.app.get<AudienceResolutionV1_2<Tx>>(AUDIENCE_RESOLUTION, { strict: false });
      // (b) lost start: send-now committed, start job lost
      const a = await campaignWith(5, 5);
      dropNext = EXECUTION_JOBS.start;
      const exA = await sendNow(a);
      await idle();
      expect((await execOf(exA)).status).toBe('pending');
      await q(`UPDATE campaign_executions SET send_at = now() - interval '5 minutes' WHERE id = $1`, [exA]);
      // (c) interrupted cancel follow-up: cancelled with pending recipients left behind
      const b = await campaignWith(12, 12);
      svc.testHooks.beforeCheckpointB = once(async () => {
        dropNext = EXECUTION_JOBS.finalize;
        const v = (await owner.get(url(`/${b.id}`))).body.version;
        expect((await manager.post(url(`/${b.id}/cancel`), { expectedVersion: v })).status).toBe(200);
      });
      const exB = await sendNow(b);
      await idle();
      expect((await recipientsBy(exB)).cancelled ?? 0).toBe(0);
      // (its snapshot was already released at materialization — trigger 1 — since the cancel came while delivering)
      // (d) materialized but its release crashed (no retry): stalled, snapshot unreleased
      svc.configure({ jobRetryDelaysMs: [] });
      const d = await campaignWith(6, 6);
      svc.testHooks.beforeRelease = crashOnce();
      const exD = await sendNow(d);
      await waitFor(async () => (await execOf(exD)).health === 'stalled');
      await idle();
      expect((await snapshotOf(exD))[0]!.released_at).toBeNull();
      svc.configure({ jobRetryDelaysMs: [30, 30, 30] });
      // Audience side: an orphan (capture whose execution never committed) and a released-but-unpurged snapshot
      const orphanKey = randomUUID();
      const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `orphan-${orphanKey.slice(0, 6)}` })).body.id as string;
      await seedAudience({ orgId, workspaceId: W, listId, n: 25, eligible: 0, secret });
      await db.withTenant({ orgId, workspaceId: W, userId: null }, (tx) =>
        resolution.capture({ tx, orgId, workspaceId: W }, { include: [{ type: 'list', listId }], exclude: [] }, orphanKey, { kind: 'campaign_execution', id: orphanKey }), { timeout: 60_000 });
      const halfKey = randomUUID();
      await db.withTenant({ orgId, workspaceId: W, userId: null }, (tx) =>
        resolution.capture({ tx, orgId, workspaceId: W }, { include: [{ type: 'list', listId }], exclude: [] }, halfKey, { kind: 'campaign_execution', id: halfKey }), { timeout: 60_000 });
      await q(`UPDATE audience_snapshots SET released_at = now(), release_reason = 'cancelled' WHERE capture_key = $1`, [halfKey]); // purge never ran
      // a LIVE execution (paused while materializing) must not be touched
      const live = await campaignWith(30, 30);
      svc.testHooks.afterPage = once(async () => {
        expect((await manager.post(url(`/${live.id}/pause`))).status).toBe(200);
      });
      const exLive = await sendNow(live);
      await idle();
      expect((await execOf(exLive)).status).toBe('paused');

      // snapshots are immutable (Audience guard): age them by running the sweep with a clock 2 h ahead instead
      const report = await svc.sweep(new Date(Date.now() + 2 * 3_600_000));
      await idle();
      expect(report.orphansReleased).toBeGreaterThanOrEqual(1);
      expect(report.purged).toBeGreaterThanOrEqual(1);
      expect(await execOf(exA)).toMatchObject({ status: 'completed', sent: 5 });
      expect(await recipientsBy(exB)).toEqual(expect.objectContaining({ cancelled: expect.any(Number) }));
      expect(((await recipientsBy(exB)).pending ?? 0) + ((await recipientsBy(exB)).queued ?? 0)).toBe(0);
      expect((await snapshotOf(exB))[0]).toMatchObject({ release_reason: 'materialized' });
      expect((await snapshotOf(exB))[0]!.purged_at).not.toBeNull();
      expect(await execOf(exD)).toMatchObject({ status: 'completed', sent: 6 });
      expect((await snapshotOf(exD))[0]!.purged_at).not.toBeNull();
      expect((await snapshotOf(orphanKey))[0]).toMatchObject({ release_reason: 'orphan_sweep' });
      expect((await snapshotOf(orphanKey))[0]!.purged_at).not.toBeNull();
      expect((await snapshotOf(halfKey))[0]!.purged_at).not.toBeNull();
      // live execution untouched: still paused, snapshot held
      expect(await execOf(exLive)).toMatchObject({ status: 'paused' });
      expect((await snapshotOf(exLive))[0]!.released_at).toBeNull();
      // idempotent: a second sweep changes nothing
      await svc.sweep();
      await idle();
      expect(await execOf(exLive)).toMatchObject({ status: 'paused' });
      expect((await manager.post(url(`/${live.id}/resume`))).status).toBe(200);
      await idle();
      expect(await execOf(exLive)).toMatchObject({ status: 'completed', sent: 30 });
    });
  });

  describe('concurrency (the database is the final guard)', () => {
    it('two starts, two workers, duplicate run jobs: one start, one lease holder, no duplicates', async () => {
      const c = await campaignWith(18, 18);
      svc.testHooks.afterPage = crashOnce(); // leaves it materializing with no live lease once the retry is disabled
      svc.configure({ jobRetryDelaysMs: [] });
      const ex = await sendNow(c);
      await waitFor(async () => (await execOf(ex)).health === 'stalled');
      await idle();
      expect(await Promise.all([svc.start(envFor(ex)), svc.start(envFor(ex))])).toEqual(['noop', 'noop']); // already started
      const results = await Promise.all([svc.run(envFor(ex)), svc.run(envFor(ex)), svc.run(envFor(ex))]);
      expect(results.filter((r) => r === 'busy')).toHaveLength(2);
      await idle();
      expect(await execOf(ex)).toMatchObject({ status: 'completed', sent: 18 });
      expect(await duplicates(ex)).toBe(0);
      expect((await eventTypes(c.id)).filter((x) => x === 'campaign.started')).toHaveLength(1);
      expect(port.acknowledged).toBe(18);
    });

    it('racing start jobs on a pending execution: exactly one transition, one campaign.started', async () => {
      const c = await campaignWith(2, 2);
      const s = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: c.version });
      const ex = s.body.currentExecution.id as string;
      await q(`UPDATE campaign_executions SET send_at = now() - interval '1 minute' WHERE id = $1`, [ex]);
      const r = await Promise.all(Array.from({ length: 4 }, () => svc.start(envFor(ex))));
      expect(r.filter((x) => x === 'started')).toHaveLength(1);
      await idle();
      expect((await eventTypes(c.id)).filter((x) => x === 'campaign.started')).toHaveLength(1);
      expect((await execOf(ex)).status).toBe('completed');
    });

    it('a not-yet-due execution is never started by a start job', async () => {
      const c = await campaignWith(2, 2);
      const s = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: c.version });
      expect(await svc.start(envFor(s.body.currentExecution.id))).toBe('noop');
      expect((await execOf(s.body.currentExecution.id)).status).toBe('pending');
    });
  });

  describe('pause / resume / cancel against a running execution', () => {
    // Regression (6.13 lifecycle-at-scale benchmark): the runner bumps the execution version every batch, and the commands
    // compared against a version read WITHOUT locking the execution — so pause/cancel on an actively delivering campaign
    // failed intermittently with "changed in the meantime". Commands now lock the execution (lock order campaign → execution).
    it('pause, resume and cancel succeed while the runner is actively delivering (no spurious conflicts)', async () => {
      for (let i = 0; i < 3; i++) {
        const c = await campaignWith(600, 600, `active-${i}`); // this file uses pages of 7 and batches of 5: many short batches
        const ex = await sendNow(c);
        await waitFor(async () => {
          const e = await execOf(ex);
          return e.status === 'delivering' && e.sent >= 50;
        });
        const p = await manager.post(url(`/${c.id}/pause`), {});
        expect(p.status, JSON.stringify(p.body)).toBe(200);
        const r = await manager.post(url(`/${c.id}/resume`), {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const atResume = (await execOf(ex)).sent;
        await waitFor(async () => (await execOf(ex)).sent > atResume + 20);
        const x = await manager.post(url(`/${c.id}/cancel`), { expectedVersion: (await manager.get(url(`/${c.id}`))).body.version });
        expect(x.status, JSON.stringify(x.body)).toBe(200);
        await idle();
        const e = await execOf(ex);
        expect(e.status).toBe('cancelled');
        const by = await recipientsBy(ex);
        expect((by.pending ?? 0) + (by.queued ?? 0) + (by.sending ?? 0)).toBe(0);
        expect(await duplicates(ex)).toBe(0);
      }
    }, 300_000);

    const current = async (id: string) => (await owner.get(url(`/${id}`))).body as { version: number; status: string };

    it('pause during materialization stops at the page boundary (snapshot + cursor kept, not released); resume continues from the cursor; no duplicates', async () => {
      const c = await campaignWith(30, 25);
      svc.testHooks.afterPage = once(async () => {
        expect((await manager.post(url(`/${c.id}/pause`))).status).toBe(200);
      });
      const ex = await sendNow(c);
      await idle();
      const p = await execOf(ex);
      expect(p).toMatchObject({ status: 'paused', paused_phase: 'materializing', lease_owner: null });
      expect(p.materialization_cursor).not.toBeNull();
      expect(p.snapshot_released_at).toBeNull();
      expect((await snapshotOf(ex))[0]!.released_at).toBeNull();
      expect((await recipientsBy(ex)).pending).toBeLessThan(25);
      expect((await manager.post(url(`/${c.id}/resume`))).status).toBe(200);
      await idle();
      expect(await execOf(ex)).toMatchObject({ status: 'completed', planned: 25, sent: 25, skipped: 5 });
      expect(await duplicates(ex)).toBe(0);
      expect(port.acknowledged).toBe(25);
    });

    it('pause before delivery (claimed batch) hands nothing off; resume re-claims at once and sends each recipient exactly once', async () => {
      const c = await campaignWith(12, 12);
      svc.testHooks.beforeCheckpointB = once(async () => {
        expect((await manager.post(url(`/${c.id}/pause`))).status).toBe(200);
      });
      const ex = await sendNow(c);
      await idle();
      expect(await execOf(ex)).toMatchObject({ status: 'paused', paused_phase: 'delivering', sent: 0 });
      expect(port.acknowledged).toBe(0);
      const claims = await q<{ n: string }>(`SELECT count(*) AS n FROM campaign_recipients WHERE execution_id = $1 AND lease_owner IS NOT NULL`, [ex]);
      expect(claims[0]!.n).toBe('0'); // claims given back
      expect((await manager.post(url(`/${c.id}/resume`))).status).toBe(200);
      await idle();
      expect(await recipientsBy(ex)).toEqual({ sent: 12 });
      expect(port.acknowledged).toBe(12);
    });

    it('cancel during materialization: stops at the next page; pending recipients cancelled in chunks; snapshot released (cancelled)', async () => {
      const c = await campaignWith(30, 30);
      svc.testHooks.afterPage = once(async () => {
        const v = (await current(c.id)).version;
        expect((await manager.post(url(`/${c.id}/cancel`), { expectedVersion: v })).status).toBe(200);
      });
      const ex = await sendNow(c);
      await idle();
      const e = await execOf(ex);
      expect(e.status).toBe('cancelled');
      const by = await recipientsBy(ex);
      expect(by.pending ?? 0).toBe(0);
      expect(by.cancelled).toBeGreaterThan(0);
      expect(by.sent ?? 0).toBe(0);
      expect(e.cancelled).toBe(by.cancelled);
      const [snap] = await snapshotOf(ex);
      expect(snap).toMatchObject({ release_reason: 'cancelled' });
      expect(snap!.purged_at).not.toBeNull();
      expect(port.acknowledged).toBe(0);
    });

    it('cancel before Checkpoint B: the claimed batch is never handed off; everything not sent is cancelled', async () => {
      const c = await campaignWith(10, 10);
      svc.testHooks.beforeCheckpointB = once(async () => {
        const v = (await current(c.id)).version;
        expect((await manager.post(url(`/${c.id}/cancel`), { expectedVersion: v })).status).toBe(200);
      });
      const ex = await sendNow(c);
      await idle();
      expect(await recipientsBy(ex)).toEqual({ cancelled: 10 });
      expect(port.acknowledged).toBe(0);
      expect(await execOf(ex)).toMatchObject({ status: 'cancelled', cancelled: 10, sent: 0 });
    });

    it('cancel racing completion: exactly one wins; the state is consistent and no recipient is left non-final', async () => {
      for (let i = 0; i < 3; i++) {
        const c = await campaignWith(4, 4);
        const ex = await sendNow(c);
        const v = (await current(c.id)).version;
        const r = await manager.post(url(`/${c.id}/cancel`), { expectedVersion: v });
        await idle();
        const e = await execOf(ex);
        if (r.status === 200) expect(e.status).toBe('cancelled');
        else expect([409]).toContain(r.status);
        expect(['completed', 'cancelled']).toContain(e.status);
        const by = await recipientsBy(ex);
        expect((by.pending ?? 0) + (by.queued ?? 0) + (by.sending ?? 0)).toBe(0);
        expect(await duplicates(ex)).toBe(0);
        expect((await snapshotOf(ex))[0]?.released_at ?? 'none').not.toBeNull();
      }
    });
  });

  describe('security, production guard and privacy', () => {
    it('forged or invalid job envelopes never touch another tenant (RLS + re-resolution); nothing leaks', async () => {
      const c = await campaignWith(3, 3);
      const s = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: c.version });
      const ex = s.body.currentExecution.id as string;
      await q(`UPDATE campaign_executions SET send_at = now() - interval '1 minute' WHERE id = $1`, [ex]);
      const before = await execOf(ex);
      // envelope claiming the outsider's workspace (and org) with our execution id
      const forged: ExecutionJobEnvelope = { tenant: { orgId: (await q<{ org_id: string }>(`SELECT org_id FROM workspaces WHERE id = $1`, [WB]))[0]!.org_id, workspaceId: WB }, actor: { type: 'system', id: null }, correlationId: randomUUID(), payload: { executionId: ex, attempt: 0 } };
      expect(await svc.start(forged)).toBe('noop');
      expect(await svc.run(forged)).toBe('busy');
      await svc.finalize(forged);
      expect(await svc.release(forged, 'cancelled')).toBe(false);
      // same org, wrong workspace id → also nothing
      expect(await svc.start({ ...forged, tenant: { orgId, workspaceId: WB } })).toBe('noop');
      // malformed envelopes are refused before any database access
      dispatcher.dispatch(EXECUTION_JOBS.run, { payload: { executionId: ex } });
      dispatcher.dispatch(EXECUTION_JOBS.start, { tenant: { orgId, workspaceId: W }, actor: { type: 'system', id: null }, correlationId: 'nope', payload: { executionId: ex } });
      await idle();
      const after = await execOf(ex);
      expect(after.status).toBe('pending');
      expect(after.version).toBe(before.version);
      // and the legitimate envelope works
      expect(await svc.start(envFor(ex))).toBe('started');
      await idle();
      expect((await execOf(ex)).status).toBe('completed');
    });

    it('production guard: config refuses test mode outside NODE_ENV=test and live mode without its provider settings; NullDeliveryPort refuses construction outside tests', () => {
      expect(() => resolveDeliveryMode('test', 'production')).toThrow(/only allowed when NODE_ENV=test/);
      expect(() => resolveDeliveryMode('test', 'development')).toThrow();
      expect(() => loadConfig({ ...process.env, NODE_ENV: 'test', CAMPAIGN_DELIVERY_MODE: 'live', DELIVERY_PROVIDER: undefined, MAILGUN_API_KEY: undefined })).toThrow(/DELIVERY_PROVIDER is required for CAMPAIGN_DELIVERY_MODE=live/);
      expect(() => resolveDeliveryMode('smtp', 'test')).toThrow(/Unknown/);
      expect(resolveDeliveryMode(undefined, 'production')).toBe('disabled');
      expect(() => new NullDeliveryPort({ NODE_ENV: 'production' })).toThrow(/test-only/);
      expect(() => new NullDeliveryPort({ NODE_ENV: 'development' })).toThrow(/test-only/);
      expect(() => new NullDeliveryPort({})).toThrow(/test-only/);
    });

    it('delivery disabled (default mode): no port is wired; start fails DELIVERY_NOT_AVAILABLE; a delivering execution is never handed off', async () => {
      const prod = await startTestApp();
      try {
        expect(prod.app.get(CAMPAIGN_DELIVERY_PORT, { strict: false })).toBeNull();
        const p = prod.app.get(ExecutionService, { strict: false });
        // an execution made runnable by test mode, then the process runs with delivery disabled
        const c = await campaignWith(3, 3);
        const s = await manager.post(url(`/${c.id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: c.version });
        const ex = s.body.currentExecution.id as string;
        await q(`UPDATE campaign_executions SET send_at = now() - interval '1 minute' WHERE id = $1`, [ex]);
        expect(await p.start(envFor(ex))).toBe('failed');
        expect(await execOf(ex)).toMatchObject({ status: 'failed', failure_code: 'DELIVERY_NOT_AVAILABLE' });
        // a delivering execution with pending recipients (from a test-mode run) is left untouched
        const d = await campaignWith(3, 3);
        svc.testHooks.beforeCheckpointB = once(async () => {
          const v = (await owner.get(url(`/${d.id}`))).body.version;
          await manager.post(url(`/${d.id}/pause`));
          void v;
        });
        const exD = await sendNow(d);
        await idle();
        await q(`UPDATE campaign_executions SET status = 'delivering', paused_phase = NULL, lease_owner = NULL, lease_until = NULL WHERE id = $1`, [exD]);
        expect(await p.run(envFor(exD))).toBe('stopped');
        expect((await recipientsBy(exD)).sent ?? 0).toBe(0);
        expect(port.acknowledged).toBe(0);
        // clean up: let the test-mode engine finish it
        expect(await svc.run(envFor(exD))).toBe('done');
      } finally {
        await prod.close();
      }
    });

    it('privacy: events, audit rows, job envelopes and logs carry ids/codes/counts only — no address, name, subject, body or sender text', async () => {
      const named = await owner.post(`/v1/workspaces/${W}/contacts`, { email: 'zelda.private@example.test', firstName: 'Zelda', lastName: 'Privatename' });
      const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `privacy-${randomUUID().slice(0, 6)}` })).body.id as string;
      await owner.post(`/v1/workspaces/${W}/contacts/${named.body.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' });
      await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds: [named.body.id] });
      const seeded = await seedAudience({ orgId, workspaceId: W, listId, n: 6, eligible: 4, secret });
      const c = await owner.post(url(), { name: 'Privacy run', channel: 'email', topicId });
      const p = await owner.patch(url(`/${c.body.id}`), {
        expectedVersion: 1,
        audience: { include: [{ type: 'list', listId }], exclude: [] },
        sender: { senderIdentityId: null, fromName: 'Acme Secret Sender', replyTo: 'reply.secret@example.test' },
        messages: [{ variantKey: 'default', content }],
      });
      const logged: string[] = [];
      const out = process.stdout.write.bind(process.stdout);
      const err = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => (logged.push(String(chunk)), out(chunk, ...rest))) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => (logged.push(String(chunk)), err(chunk, ...rest))) as typeof process.stderr.write;
      const before = dispatched.length;
      try {
        const ex = await sendNow({ id: c.body.id, version: p.body.version });
        await idle();
        expect((await execOf(ex)).status).toBe('completed');
      } finally {
        process.stdout.write = out;
        process.stderr.write = err;
      }
      const secrets = ['zelda.private@example.test', 'Zelda', 'Privatename', 'Secret subject line', 'Private body text', 'Acme Secret Sender', 'reply.secret@example.test', ...seeded.emails];
      const events = JSON.stringify(await q(`SELECT payload FROM domain_events WHERE aggregate_id = $1`, [c.body.id]));
      const audits = JSON.stringify(await q(`SELECT metadata FROM audit_logs WHERE target_id = $1`, [c.body.id]));
      const jobs = JSON.stringify(dispatched.slice(before));
      const execRow = JSON.stringify(await q(`SELECT e.*, (SELECT json_agg(r) FROM campaign_recipients r WHERE r.execution_id = e.id) AS recipients FROM campaign_executions e WHERE campaign_id = $1`, [c.body.id]));
      for (const s of secrets) {
        expect(events, s).not.toContain(s);
        expect(audits, s).not.toContain(s);
        expect(jobs, s).not.toContain(s);
        expect(logged.join(''), s).not.toContain(s);
        expect(execRow, s).not.toContain(s);
      }
      expect(jobs).not.toMatch(/contactId|contact_id|@/);
    });
  });
});
