import { randomUUID } from 'node:crypto';
import type { Database } from '@workeasy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUNNER_OPTIONS, JOB_DISPATCHER, PermanentJobError, PgJobDispatcher, PgJobRunner } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG, DATABASE } from '../src/infrastructure/providers.js';
import { seedAudience } from './execution-support.js';
import { Agent, createOrg, emailOf, PASSWORD, resetTestDatabase, signUp, startTestApp, type TestApp, uploadCsv, waitForImport, withOwnerConnection } from './support.js';

/**
 * The durable PostgreSQL queue in the running application (Phase 7.6; docs/architecture/durable-job-queue.md §4.5–4.6):
 * campaigns and imports run on it end to end; a runner that dies mid-job is taken over after its lease; jobs survive a
 * restart; retries back off and permanent failures become dead letters; job rows carry no personal data.
 */
describe('durable job queue in the application', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  let secret: string;
  const url = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  /** A runner for the given job names (default: every registered job). */
  const runnerFor = (app: TestApp, opts = {}, names?: string[]) => {
    const all = (app.app.get(JOB_DISPATCHER) as PgJobDispatcher).handlers;
    const handlers = names ? new Map(names.map((n) => [n, all.get(n)!])) : all;
    return { names: [...handlers.keys()], runner: new PgJobRunner(app.app.get(DATABASE) as Database, handlers, { ...DEFAULT_RUNNER_OPTIONS, leaseSeconds: 10, ...opts }) };
  };
  /** Runs the queue until no job THIS runner handles is due now. */
  async function drain(app: TestApp, r = runnerFor(app), maxRounds = 500) {
    const dispatcher = app.app.get(JOB_DISPATCHER) as PgJobDispatcher;
    for (let i = 0; i < maxRounds; i++) {
      await dispatcher.flushed();
      const claimed = await r.runner.tick();
      await r.runner.idle();
      await dispatcher.flushed();
      if (!claimed) {
        const due = (await q(`SELECT count(*)::int AS n FROM job_queue WHERE status = 'queued' AND run_after <= now() AND name = ANY($1)`, [r.names]))[0]!.n;
        if (!due) return;
      }
    }
    throw new Error('queue did not drain');
  }
  async function sendNowCampaign(n = 20) {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `q-${randomUUID().slice(0, 6)}` })).body.id;
    await seedAudience({ orgId, workspaceId: W, listId, n, eligible: n, secret });
    const c = await owner.post(url(), { name: 'Queued', channel: 'email', topicId });
    const p = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Q', preheader: '', body: { format: 'text', text: 'Queued send' } } }],
    });
    const s = await owner.post(url(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    return { id: c.body.id as string, executionId: s.body.currentExecution.id as string };
  }
  const exec = async (id: string) => (await q(`SELECT status, planned, sent FROM campaign_executions WHERE id = $1`, [id]))[0]!;

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', JOB_QUEUE: 'postgres' });
    secret = (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret;
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Queue Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  afterAll(async () => t?.close());

  it('the application uses the durable queue: a send-now campaign completes through PostgreSQL jobs', async () => {
    expect(t.app.get(JOB_DISPATCHER)).toBeInstanceOf(PgJobDispatcher);
    const c = await sendNowCampaign();
    await (t.app.get(JOB_DISPATCHER) as PgJobDispatcher).flushed();
    expect((await q(`SELECT name, status FROM job_queue WHERE payload #>> '{payload,executionId}' = $1`, [c.executionId])).map((r) => r.name)).toContain('campaign.execution.start');
    await drain(t);
    expect(await exec(c.executionId)).toMatchObject({ status: 'completed', planned: 20, sent: 20 });
    const jobs = await q(`SELECT name, status, attempts FROM job_queue WHERE payload #>> '{payload,executionId}' = $1`, [c.executionId]);
    expect(jobs.every((j) => j.status === 'done')).toBe(true);
    expect(jobs.map((j) => j.name)).toEqual(expect.arrayContaining(['campaign.execution.start', 'campaign.execution.run']));
  });

  it('a runner that dies holding a job: after its lease expires another runner takes over and the campaign completes once', async () => {
    const c = await sendNowCampaign();
    await drain(t, runnerFor(t, {}, ['campaign.execution.start'])); // only the start runs; the run job is enqueued
    // A "ghost" runner claims the run job and dies without a heartbeat.
    const db = t.app.get(DATABASE) as Database;
    const claimed = await db.system.claimJobs('ghost', ['campaign.execution.run'], 10, 5);
    expect(claimed.some((j) => (j.payload as { payload: { executionId: string } }).payload.executionId === c.executionId)).toBe(true);
    await drain(t); // nothing runnable: the lease is live
    expect((await exec(c.executionId)).status).not.toBe('completed');
    await q(`UPDATE job_queue SET lease_until = now() - interval '1 second' WHERE lease_owner = 'ghost'`);
    await drain(t);
    expect(await exec(c.executionId)).toMatchObject({ status: 'completed', planned: 20, sent: 20 });
    const dups = (await q(`SELECT count(*) - count(DISTINCT contact_id) AS n FROM campaign_recipients WHERE execution_id = $1`, [c.executionId]))[0]!.n;
    expect(Number(dups)).toBe(0);
    expect(await db.system.completeJob(claimed[0]!.id, 'ghost')).toBe(false); // the dead runner cannot record an outcome
  });

  it('jobs survive a restart: queued work is run by the next process', async () => {
    const c = await sendNowCampaign();
    await (t.app.get(JOB_DISPATCHER) as PgJobDispatcher).flushed();
    await t.close(); // nothing ran in this process
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', JOB_QUEUE: 'postgres' });
    await drain(t);
    expect(await exec(c.executionId)).toMatchObject({ status: 'completed', sent: 20 });
    const email = emailOf(owner);
    owner = new Agent(t);
    expect((await owner.post('/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
    (owner as Agent & { email: string }).email = email;
  });

  it('a failing job is retried after its back-off; a permanent failure goes to the dead letters at once', async () => {
    const dispatcher = t.app.get(JOB_DISPATCHER) as PgJobDispatcher;
    let calls = 0;
    dispatcher.register('test.flaky', async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
    });
    dispatcher.register('test.permanent', async () => {
      throw new PermanentJobError('NEVER');
    });
    const env = { tenant: { orgId, workspaceId: W }, actor: { type: 'system', id: null }, correlationId: randomUUID(), payload: {} };
    dispatcher.dispatch('test.flaky', env);
    dispatcher.dispatch('test.permanent', env);
    const runner = runnerFor(t, { backoffBaseSeconds: 1, backoffMaxSeconds: 1 }, ['test.flaky', 'test.permanent']);
    await drain(t, runner);
    expect(calls).toBe(1); // the retry waits for its back-off
    for (let i = 0; i < 2; i++) {
      await q(`UPDATE job_queue SET run_after = now() WHERE name = 'test.flaky' AND status = 'queued'`);
      await drain(t, runner);
    }
    expect(calls).toBe(3);
    expect((await q(`SELECT status, attempts FROM job_queue WHERE name = 'test.flaky'`))[0]).toMatchObject({ status: 'done', attempts: 3 });
    expect((await q(`SELECT status, attempts, last_error FROM job_queue WHERE name = 'test.permanent'`))[0]).toMatchObject({ status: 'dead', attempts: 1, last_error: 'NEVER' });
  });

  it('imports run on the durable queue; job rows carry ids only (no email, no name)', async () => {
    const lists = await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Imported' });
    const up = await uploadCsv(owner, W, ['email', 'a@queue.test', 'b@queue.test'].join('\n'));
    await owner.put(`/v1/workspaces/${W}/imports/${up.body.id}/mapping`, { mapping: { 0: 'email' }, options: { mode: 'create_or_update', listIds: [lists.body.id] }, version: up.body.version });
    await owner.post(`/v1/workspaces/${W}/imports/${up.body.id}/dry-run`);
    await drain(t);
    expect((await owner.post(`/v1/workspaces/${W}/imports/${up.body.id}/start`)).status).toBe(202);
    await (t.app.get(JOB_DISPATCHER) as PgJobDispatcher).flushed();
    const [job] = await q(`SELECT payload FROM job_queue WHERE name = 'contacts.import' ORDER BY created_at DESC LIMIT 1`);
    expect(job!.payload.actor).toEqual({ type: 'user', id: expect.any(String) });
    await drain(t);
    expect((await waitForImport(owner, W, up.body.id)).status).toBe('completed');
    const all = JSON.stringify(await q(`SELECT payload FROM job_queue`));
    expect(all).not.toMatch(/@/); // no address anywhere in any job row
  });
});
