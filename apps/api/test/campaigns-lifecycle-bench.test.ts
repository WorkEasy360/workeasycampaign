/**
 * Lifecycle commands at scale (6.13): pause, resume and cancel against a REAL execution of N recipients while it is
 * delivering. Opt-in:
 *   LIFECYCLE_BENCH=1 [LIFECYCLE_BENCH_SIZES=1000000] [LIFECYCLE_BENCH_OUT=file.jsonl] pnpm --filter @workeasy/api exec vitest run test/campaigns-lifecycle-bench.test.ts
 * Measures: command latency (HTTP), time until sending actually stops after pause (no `sent` increase), time until
 * progress resumes, time for cancel to finalize every remaining recipient, and the final consistency (no recipient left
 * non-final, no duplicates, counts = rows).
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AudienceResolutionRecovery } from '@workeasy/audience-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import { AUDIENCE_RECOVERY } from '../src/infrastructure/providers.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

const ENABLED = !!process.env.LIFECYCLE_BENCH;
const SIZES = (process.env.LIFECYCLE_BENCH_SIZES ?? '100000').split(',').filter(Boolean).map(Number);
const report = (data: Record<string, unknown>) => {
  const line = `BENCH ${JSON.stringify({ name: 'lifecycle.at_scale', at: new Date().toISOString(), ...data })}`;
  if (process.env.LIFECYCLE_BENCH_OUT) appendFileSync(process.env.LIFECYCLE_BENCH_OUT, `${line}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ENABLED)('lifecycle commands at scale', () => {
  let t: TestApp;
  let owner: Agent;
  let dispatcher: InlineJobDispatcher;
  const secret = 'bench-fingerprint-secret-bench-fingerprint';

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', DATA_FINGERPRINT_SECRET: secret });
    dispatcher = t.app.get(JOB_DISPATCHER);
    owner = await signUp(t, undefined, 'Bench');
  });
  afterAll(async () => t?.close());

  for (const n of SIZES) {
    it(`${n.toLocaleString('en')} recipients: pause, resume, cancel while delivering`, async () => {
      const { orgId, workspaceId: W } = await createOrg(owner, `Lifecycle bench ${n}`);
      const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
      const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `lb-${randomUUID().slice(0, 6)}` })).body.id as string;
      await seedAudience({ orgId, workspaceId: W, listId, n, eligible: Math.round(n * 0.8), secret, tag: `lb${n}` });
      const C = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
      const c = await owner.post(C(), { name: 'Lifecycle bench', channel: 'email', topicId });
      const p = await owner.patch(C(`/${c.body.id}`), {
        expectedVersion: 1,
        audience: { include: [{ type: 'list', listId }], exclude: [] },
        sender: { senderIdentityId: null, fromName: 'Bench', replyTo: null },
        messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Bench', preheader: '', body: { format: 'text', text: 'Bench' } } }],
      });
      // Bulk seeding leaves the bitmap invalid; repair it as the worker would (Audience port), before measuring.
      await (t.app.get(AUDIENCE_RECOVERY, { strict: false }) as AudienceResolutionRecovery).requestRecovery({ orgId, workspaceId: W });
      for (;;) {
        const state = (await withOwnerConnection((cl) => cl.query(`SELECT state FROM audience_count_state WHERE workspace_id = $1`, [W]))).rows[0]?.state;
        if (state === 'valid') break;
        await sleep(2_000);
      }
      const s = await owner.post(C(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
      expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
      const ex = s.body.currentExecution.id as string;
      const execRow = async () => (await withOwnerConnection((cl) => cl.query(`SELECT status, sent, cancelled, planned FROM campaign_executions WHERE id = $1`, [ex]))).rows[0];
      const version = async () => (await owner.get(C(`/${c.body.id}`))).body.version as number;

      // Wait until delivery is under way (≥ 10 % sent).
      for (;;) {
        const e = await execRow();
        if (e.status === 'delivering' && e.sent >= Math.round(n * 0.8 * 0.1)) break;
        await sleep(250);
      }

      // PAUSE: command latency, then time until no further sends are recorded.
      let t0 = performance.now();
      const paused = await owner.post(C(`/${c.body.id}/pause`), {});
      const pauseHttpMs = Math.round(performance.now() - t0);
      expect(paused.status, JSON.stringify(paused.body).slice(0, 300)).toBe(200);
      const pausedAt = performance.now();
      let last = (await execRow()).sent;
      let stableSince = performance.now();
      while (performance.now() - stableSince < 3_000) {
        await sleep(200);
        const now = (await execRow()).sent;
        if (now !== last) {
          last = now;
          stableSince = performance.now();
        }
      }
      const pauseQuiesceMs = Math.round(stableSince - pausedAt);
      const sentWhilePaused = last;
      await sleep(2_000);
      expect((await execRow()).sent).toBe(sentWhilePaused); // nothing is sent while paused

      // RESUME: command latency, then time until progress is recorded again.
      t0 = performance.now();
      const resumed = await owner.post(C(`/${c.body.id}/resume`), {});
      const resumeHttpMs = Math.round(performance.now() - t0);
      expect(resumed.status, JSON.stringify(resumed.body).slice(0, 300)).toBe(200);
      for (;;) {
        if ((await execRow()).sent > sentWhilePaused) break;
        await sleep(100);
      }
      const resumeToProgressMs = Math.round(performance.now() - t0);
      await sleep(1_000); // a little delivery after resuming, then cancel mid-delivery

      // CANCEL: command latency, then time until finalize leaves no recipient non-final.
      t0 = performance.now();
      const cancelled = await owner.post(C(`/${c.body.id}/cancel`), { expectedVersion: await version() });
      const cancelHttpMs = Math.round(performance.now() - t0);
      expect(cancelled.status, JSON.stringify(cancelled.body).slice(0, 300)).toBe(200);
      for (;;) {
        await dispatcher.idle();
        const open = Number((await withOwnerConnection((cl) => cl.query(`SELECT count(*) AS n FROM campaign_recipients WHERE execution_id = $1 AND status IN ('pending', 'queued', 'sending')`, [ex]))).rows[0].n);
        if (open === 0) break;
        if (performance.now() - t0 > 600_000) throw new Error(`cancel did not finalize within 10 min: ${open} recipients still open`);
        await sleep(500);
      }
      const cancelFinalizeMs = Math.round(performance.now() - t0);

      const e = await execRow();
      const rows = (await withOwnerConnection((cl) => cl.query(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [ex]))).rows as { status: string; n: number }[];
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      const dups = Number((await withOwnerConnection((cl) => cl.query(`SELECT count(*) - count(DISTINCT contact_id) AS n FROM campaign_recipients WHERE execution_id = $1`, [ex]))).rows[0].n);
      expect(e.status).toBe('cancelled');
      expect(dups).toBe(0);
      expect(by.sent ?? 0).toBe(e.sent);
      expect(by.cancelled ?? 0).toBe(e.cancelled);
      report({ size: n, pauseHttpMs, pauseQuiesceMs, sentWhilePaused, resumeHttpMs, resumeToProgressMs, cancelHttpMs, cancelFinalizeMs, final: { status: e.status, sent: e.sent, cancelled: e.cancelled, rows: by, duplicates: dups } });
    }, 4 * 3_600_000);
  }
});
